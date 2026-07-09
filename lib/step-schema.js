import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, join } from 'path';
import { gzipSync, gunzipSync } from 'zlib';
import { writeStepDatabaseStatus } from './step-db-status.js';

let SQL = null;

async function getSql() {
  if (SQL) return SQL;
  const initSqlJs = (await import('sql.js')).default;
  SQL = await initSqlJs();
  return SQL;
}

const GZIP_TEXT_PREFIX = 'gzip:base64:';

function encodeContentBlob(content) {
  if (content == null) return null;
  const gzipped = gzipSync(Buffer.from(String(content), 'utf8')).toString('base64');
  return `${GZIP_TEXT_PREFIX}${gzipped}`;
}

function decodeContentBlob(blob) {
  if (blob == null) return null;
  const text = String(blob);
  if (!text.startsWith(GZIP_TEXT_PREFIX)) return text;

  try {
    const payload = text.slice(GZIP_TEXT_PREFIX.length);
    return gunzipSync(Buffer.from(payload, 'base64')).toString('utf8');
  } catch {
    return null;
  }
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
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
async function acquireDbLock(dbPath, timeoutMs) {
  const lockPath = `${dbPath}.lock`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      return { lockPath, fd: openSync(lockPath, 'wx') };
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) {
          unlinkSync(lockPath);
        }
      } catch {}
      await sleep(25);
    }
  }
  const err = new Error(`lock_timeout: ${dbPath}`);
  err.code = 'lock_timeout';
  throw err;
}
function releaseDbLock(lock) {
  if (!lock) return;
  try { closeSync(lock.fd); } catch {}
  try { unlinkSync(lock.lockPath); } catch {}
}

function atomicReplaceFile(targetPath, data) {
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const tmpPath = `${targetPath}.tmp.${nonce}`;
  const bakPath = `${targetPath}.bak.${nonce}`;
  let hasBackup = false;

  try {
    writeFileSync(tmpPath, data);
    if (existsSync(targetPath)) {
      renameSync(targetPath, bakPath);
      hasBackup = true;
    }
    renameSync(tmpPath, targetPath);
    if (hasBackup) {
      try { unlinkSync(bakPath); } catch {}
    }
  } catch (err) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
    if (hasBackup && !existsSync(targetPath) && existsSync(bakPath)) {
      try { renameSync(bakPath, targetPath); } catch {}
    }
    throw err;
  }
}

function backupCorruptDatabase(dbPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.corrupt.${stamp}`;
  renameSync(dbPath, backupPath);
  return backupPath;
}
function recoverMissingTargetFromBackup(dbPath) {
  if (existsSync(dbPath)) return false;
  const dir = dirname(dbPath);
  if (!existsSync(dir)) return false;

  const prefix = `${basename(dbPath)}.bak.`;
  const candidates = readdirSync(dir)
    .filter(name => name.startsWith(prefix))
    .map(name => ({ name, path: join(dir, name), mtimeMs: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  const latest = candidates[candidates.length - 1];
  if (!latest) return false;

  renameSync(latest.path, dbPath);
  return true;
}
export class StepDatabase {
  constructor() {
    this.db = null;
    this.dbPath = null;
    this.projectRoot = null;
    this.lock = null;
  }
  async open(dbPath, options = {}) {
    this.dbPath = dbPath;
    this.projectRoot = options.projectRoot || dirname(dirname(dbPath));
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.lock = await acquireDbLock(dbPath, options.lockTimeoutMs ?? 2_000);
    try {
      const Sql = await getSql();
      recoverMissingTargetFromBackup(dbPath);
      const hadExistingDb = existsSync(dbPath);

      try {
        this.db = hadExistingDb
          ? new Sql.Database(readFileSync(dbPath))
          : new Sql.Database();
        this.db.run('PRAGMA journal_mode = WAL');
        this.db.run('PRAGMA synchronous = NORMAL');
        this.db.exec(SCHEMA);
        // Migration: add content_blob column if missing (existing DBs)
        try { this.db.run('ALTER TABLE step_files ADD COLUMN content_blob TEXT'); } catch { /* already exists */ }
      } catch (err) {
        if (!hadExistingDb) throw err;
        try { this.db?.close(); } catch {}
        this.db = null;
        const corruptBackupPath = backupCorruptDatabase(dbPath);
        writeStepDatabaseStatus(this.projectRoot, {
          type: 'corrupt_recovered',
          sourcePath: dbPath,
          corruptBackupPath,
          message: 'Detected a corrupt Step Database; backed it up and recreated an empty database.',
        });
        this.db = new Sql.Database();
        this.db.run('PRAGMA journal_mode = WAL');
        this.db.run('PRAGMA synchronous = NORMAL');
        this.db.exec(SCHEMA);
      }
      return this;
    } catch (err) {
      releaseDbLock(this.lock);
      this.lock = null;
      throw err;
    }
  }
  close() {
    try {
      if (!this.db) return;
      try {
        const data = this.db.export();
        atomicReplaceFile(this.dbPath, Buffer.from(data));
      } catch { /* best effort */ }
      this.db.close();
      this.db = null;
    } finally {
      releaseDbLock(this.lock);
      this.lock = null;
    }
  }

  save() {
    if (!this.db || !this.dbPath) return;
    try {
      const data = this.db.export();
      atomicReplaceFile(this.dbPath, Buffer.from(data));
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
      [stepId, path, blameJson, encodeContentBlob(content)]
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
      result = decodeContentBlob(row.content_blob);
    }
    stmt.free();
    return result;
  }

  getStepFilesForPath(path, limit = 20, beforeTs = null) {
    // beforeTs: 只返回 ts <= beforeTs 的 step（行级归因时间对齐用，杜绝未来 step 污染历史 commit）
    const hasTs = Number.isFinite(beforeTs);
    const stmt = this.db.prepare(
      `SELECT sf.step_id, sf.path, sf.blame_map, s.session_id, s.ts, s.tool_name
       FROM step_files sf JOIN steps s ON sf.step_id = s.id
       WHERE sf.path = ? ${hasTs ? 'AND s.ts <= ? ' : ''}ORDER BY s.ts DESC LIMIT ?`
    );
    stmt.bind(hasTs ? [path, beforeTs, limit] : [path, limit]);
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

  // 最近一次 step 入库时间（ms epoch），无数据返回 null。用于 hook 失效健康检查。
  getLastStepTs() {
    const stmt = this.db.prepare('SELECT MAX(ts) as max_ts FROM steps');
    stmt.bind([]);
    let ts = null;
    if (stmt.step()) {
      const row = stmt.getAsObject();
      ts = row.max_ts ?? null;
    }
    stmt.free();
    return ts;
  }
}
