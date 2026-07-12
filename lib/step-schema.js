import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { gzipSync, gunzipSync } from 'zlib';
import { writeStepDatabaseStatus } from './step-db-status.js';

const SCHEMA_VERSION = 2;
const GZIP_TEXT_PREFIX = 'gzip:base64:';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  session_id TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'claude_code',
  ts INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  tree_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_steps_session ON steps(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_steps_parent ON steps(parent_id);
CREATE TABLE IF NOT EXISTS step_files (
  step_id TEXT NOT NULL,
  path TEXT NOT NULL,
  blob_hash TEXT,
  blame_map TEXT,
  content_blob BLOB,
  PRIMARY KEY (step_id, path)
);
CREATE INDEX IF NOT EXISTS idx_step_files_path ON step_files(path);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL DEFAULT 'claude_code',
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  head_step_id TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function encodeContentBlob(content) {
  return content == null ? null : gzipSync(Buffer.from(String(content), 'utf8'));
}

function decodeContentBlob(blob) {
  if (blob == null) return null;
  if (Buffer.isBuffer(blob)) {
    try { return gunzipSync(blob).toString('utf8'); } catch { return null; }
  }
  const text = String(blob);
  if (!text.startsWith(GZIP_TEXT_PREFIX)) return text;
  try {
    return gunzipSync(Buffer.from(text.slice(GZIP_TEXT_PREFIX.length), 'base64')).toString('utf8');
  } catch {
    return null;
  }
}

export class StepDatabase {
  constructor() {
    this.db = null;
    this.dbPath = null;
    this.projectRoot = null;
    this.statements = null;
  }

  async open(dbPath, options = {}) {
    this.dbPath = dbPath;
    this.projectRoot = options.projectRoot || dirname(dirname(dbPath));
    mkdirSync(dirname(dbPath), { recursive: true });
    try {
      this.db = new Database(dbPath, { timeout: options.busyTimeoutMs ?? 2000 });
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 2000}`);
      this.db.pragma('foreign_keys = ON');
      this.db.exec(SCHEMA);
      this.migrateSchema();
      this.prepareStatements();
      writeStepDatabaseStatus(this.projectRoot, {
        type: 'ready',
        sourcePath: dbPath,
        engine: 'better-sqlite3',
        schemaVersion: SCHEMA_VERSION,
      });
      return this;
    } catch (err) {
      try { this.db?.close(); } catch {}
      this.db = null;
      writeStepDatabaseStatus(this.projectRoot, {
        type: 'open_failed',
        sourcePath: dbPath,
        message: err.message,
      });
      throw err;
    }
  }

  migrateSchema() {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    const version = row ? Number(row.value) : 1;
    if (!Number.isInteger(version) || version < 1 || version > SCHEMA_VERSION) {
      const err = new Error(`Unsupported steps.db schema version: ${version}`);
      err.code = 'unsupported_schema_version';
      throw err;
    }
    const migrate = this.db.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(step_files)').all();
      if (!columns.some(column => column.name === 'content_blob')) {
        this.db.exec('ALTER TABLE step_files ADD COLUMN content_blob BLOB');
      }
      this.db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(SCHEMA_VERSION));
    });
    migrate.immediate();
  }

  prepareStatements() {
    this.statements = {
      insertStep: this.db.prepare(`INSERT OR REPLACE INTO steps
        (id, parent_id, session_id, origin, ts, tool_name, tool_use_id, tree_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      stepsBySession: this.db.prepare(`SELECT id, parent_id, session_id, origin, ts, tool_name, tool_use_id, tree_hash
        FROM steps WHERE session_id = ? ORDER BY ts DESC LIMIT ?`),
      sessionHead: this.db.prepare('SELECT head_step_id FROM sessions WHERE id = ?'),
      stepById: this.db.prepare(`SELECT id, parent_id, session_id, origin, ts, tool_name, tool_use_id, tree_hash
        FROM steps WHERE id = ?`),
      upsertFile: this.db.prepare(`INSERT OR REPLACE INTO step_files
        (step_id, path, blame_map, content_blob) VALUES (?, ?, ?, ?)`),
      blameMap: this.db.prepare('SELECT blame_map FROM step_files WHERE step_id = ? AND path = ?'),
      fileBlob: this.db.prepare('SELECT content_blob FROM step_files WHERE step_id = ? AND path = ?'),
      migrateBlob: this.db.prepare('UPDATE step_files SET content_blob = ? WHERE step_id = ? AND path = ?'),
      filesForPath: this.db.prepare(`SELECT sf.step_id, sf.path, sf.blame_map, s.session_id, s.ts, s.tool_name
        FROM step_files sf JOIN steps s ON sf.step_id = s.id
        WHERE sf.path = ? ORDER BY s.ts DESC LIMIT ?`),
      filesForPathBefore: this.db.prepare(`SELECT sf.step_id, sf.path, sf.blame_map, s.session_id, s.ts, s.tool_name
        FROM step_files sf JOIN steps s ON sf.step_id = s.id
        WHERE sf.path = ? AND s.ts <= ? ORDER BY s.ts DESC LIMIT ?`),
      upsertSession: this.db.prepare(`INSERT INTO sessions (id, origin, started_at, last_seen_at, head_step_id)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET last_seen_at = ?, head_step_id = COALESCE(?, head_step_id)`),
      sessionCount: this.db.prepare('SELECT COUNT(*) AS cnt FROM sessions'),
      stepCount: this.db.prepare('SELECT COUNT(*) AS cnt FROM steps'),
      lastStepTs: this.db.prepare('SELECT MAX(ts) AS max_ts FROM steps'),
    };
  }

  transaction(fn) { return this.db.transaction(fn)(); }
  close() { if (this.db) this.db.close(); this.db = null; this.statements = null; }

  insertStep(step) {
    this.statements.insertStep.run(step.id, step.parentId || null, step.sessionId,
      step.origin || 'claude_code', step.ts, step.toolName, step.toolUseId, step.treeHash || null);
  }
  getStepsBySession(sessionId, limit = 100) { return this.statements.stepsBySession.all(sessionId, limit); }
  getSessionHead(sessionId) { return this.statements.sessionHead.get(sessionId)?.head_step_id ?? null; }
  getStepById(stepId) { return this.statements.stepById.get(stepId) || null; }
  upsertStepFile(stepId, path, blameMap, content) {
    this.statements.upsertFile.run(stepId, path, blameMap ? JSON.stringify(blameMap) : null, encodeContentBlob(content));
  }
  getBlameMap(stepId, path) {
    const value = this.statements.blameMap.get(stepId, path)?.blame_map;
    if (!value) return null;
    try { return JSON.parse(value); } catch { return null; }
  }
  getFileBlob(stepId, path) {
    const blob = this.statements.fileBlob.get(stepId, path)?.content_blob;
    const content = decodeContentBlob(blob);
    if (content != null && typeof blob === 'string' && blob.startsWith(GZIP_TEXT_PREFIX)) {
      this.statements.migrateBlob.run(encodeContentBlob(content), stepId, path);
    }
    return content;
  }
  getStepFilesForPath(path, limit = 20, beforeTs = null) {
    return Number.isFinite(beforeTs)
      ? this.statements.filesForPathBefore.all(path, beforeTs, limit)
      : this.statements.filesForPath.all(path, limit);
  }
  upsertSession(session) {
    const now = Date.now();
    this.statements.upsertSession.run(session.id, session.origin || 'claude_code', now, now,
      session.headStepId || null, now, session.headStepId || null);
  }
  getSessionCount() { return this.statements.sessionCount.get().cnt; }
  getStepCount() { return this.statements.stepCount.get().cnt; }
  getLastStepTs() { return this.statements.lastStepTs.get().max_ts ?? null; }
}
