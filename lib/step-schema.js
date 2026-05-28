import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

let SQL = null;

async function getSql() {
  if (SQL) return SQL;
  const initSqlJs = (await import('sql.js')).default;
  SQL = await initSqlJs();
  return SQL;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS steps (
    id          TEXT PRIMARY KEY,
    parent_id   TEXT,
    session_id  TEXT NOT NULL,
    origin      TEXT NOT NULL DEFAULT 'claude_code',
    ts          INTEGER NOT NULL,
    tool_name   TEXT NOT NULL,
    tool_use_id TEXT NOT NULL,
    tree_hash   TEXT
);
CREATE INDEX IF NOT EXISTS idx_steps_session ON steps(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_steps_parent ON steps(parent_id);

CREATE TABLE IF NOT EXISTS step_files (
    step_id     TEXT NOT NULL,
    path        TEXT NOT NULL,
    blob_hash   TEXT,
    blame_map   TEXT,
    content_blob TEXT,
    PRIMARY KEY (step_id, path)
);
CREATE INDEX IF NOT EXISTS idx_step_files_path ON step_files(path);

CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    origin        TEXT NOT NULL DEFAULT 'claude_code',
    started_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL,
    head_step_id  TEXT
);
`;

export class StepDatabase {
  constructor() {
    this.db = null;
    this.dbPath = null;
  }

  async open(dbPath) {
    this.dbPath = dbPath;
    const Sql = await getSql();

    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (existsSync(dbPath)) {
      const buf = readFileSync(dbPath);
      this.db = new Sql.Database(buf);
    } else {
      this.db = new Sql.Database();
    }

    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
    // Migration: add content_blob column if missing (existing DBs)
    try { this.db.run('ALTER TABLE step_files ADD COLUMN content_blob TEXT'); } catch { /* already exists */ }
    return this;
  }

  close() {
    if (!this.db) return;
    try {
      const data = this.db.export();
      writeFileSync(this.dbPath, Buffer.from(data));
    } catch { /* best effort */ }
    this.db.close();
    this.db = null;
  }

  save() {
    if (!this.db || !this.dbPath) return;
    try {
      const data = this.db.export();
      writeFileSync(this.dbPath, Buffer.from(data));
    } catch { /* best effort */ }
  }

  // ── Step CRUD ──

  insertStep(step) {
    this.db.run(
      `INSERT OR REPLACE INTO steps (id, parent_id, session_id, origin, ts, tool_name, tool_use_id, tree_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [step.id, step.parentId || null, step.sessionId, step.origin || 'claude_code',
       step.ts, step.toolName, step.toolUseId, step.treeHash || null]
    );
  }

  getStepsBySession(sessionId, limit = 100) {
    const stmt = this.db.prepare(
      `SELECT id, parent_id, session_id, origin, ts, tool_name, tool_use_id, tree_hash
       FROM steps WHERE session_id = ? ORDER BY ts DESC LIMIT ?`
    );
    stmt.bind([sessionId, limit]);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  getSessionHead(sessionId) {
    const stmt = this.db.prepare('SELECT head_step_id FROM sessions WHERE id = ?');
    stmt.bind([sessionId]);
    let head = null;
    if (stmt.step()) head = stmt.getAsObject().head_step_id;
    stmt.free();
    return head;
  }

  getStepById(stepId) {
    const stmt = this.db.prepare(
      `SELECT id, parent_id, session_id, origin, ts, tool_name, tool_use_id, tree_hash
       FROM steps WHERE id = ?`
    );
    stmt.bind([stepId]);
    let row = null;
    if (stmt.step()) row = stmt.getAsObject();
    stmt.free();
    return row;
  }

  // ── Step files ──

  upsertStepFile(stepId, path, blameMap, content) {
    const blameJson = blameMap ? JSON.stringify(blameMap) : null;
    this.db.run(
      `INSERT OR REPLACE INTO step_files (step_id, path, blame_map, content_blob) VALUES (?, ?, ?, ?)`,
      [stepId, path, blameJson, content || null]
    );
  }

  getBlameMap(stepId, path) {
    const stmt = this.db.prepare('SELECT blame_map FROM step_files WHERE step_id = ? AND path = ?');
    stmt.bind([stepId, path]);
    let result = null;
    if (stmt.step()) {
      const row = stmt.getAsObject();
      if (row.blame_map) {
        try { result = JSON.parse(row.blame_map); } catch { /* ignore */ }
      }
    }
    stmt.free();
    return result;
  }

  getFileBlob(stepId, path) {
    const stmt = this.db.prepare('SELECT content_blob FROM step_files WHERE step_id = ? AND path = ?');
    stmt.bind([stepId, path]);
    let result = null;
    if (stmt.step()) {
      const row = stmt.getAsObject();
      result = row.content_blob || null;
    }
    stmt.free();
    return result;
  }

  getStepFilesForPath(path, limit = 20) {
    const stmt = this.db.prepare(
      `SELECT sf.step_id, sf.path, sf.blame_map, s.session_id, s.ts, s.tool_name
       FROM step_files sf JOIN steps s ON sf.step_id = s.id
       WHERE sf.path = ? ORDER BY s.ts DESC LIMIT ?`
    );
    stmt.bind([path, limit]);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  // ── Session management ──

  upsertSession(session) {
    const now = Date.now();
    this.db.run(
      `INSERT INTO sessions (id, origin, started_at, last_seen_at, head_step_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_seen_at = ?,
         head_step_id = COALESCE(?, head_step_id)`,
      [session.id, session.origin || 'claude_code', now, now, session.headStepId || null,
       now, session.headStepId || null]
    );
  }

  getSessionCount() {
    const stmt = this.db.prepare('SELECT COUNT(*) as cnt FROM sessions');
    stmt.bind([]);
    let count = 0;
    if (stmt.step()) count = stmt.getAsObject().cnt;
    stmt.free();
    return count;
  }

  getStepCount() {
    const stmt = this.db.prepare('SELECT COUNT(*) as cnt FROM steps');
    stmt.bind([]);
    let count = 0;
    if (stmt.step()) count = stmt.getAsObject().cnt;
    stmt.free();
    return count;
  }
}
