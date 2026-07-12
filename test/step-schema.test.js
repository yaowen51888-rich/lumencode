import test from 'node:test';
import { spawn } from 'child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { gzipSync } from 'zlib';
import Database from 'better-sqlite3';
import initSqlJs from 'sql.js';
import { StepDatabase } from '../lib/step-schema.js';
import { readStepDatabaseStatus } from '../lib/step-db-status.js';

function runNodeScript(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`)));
  });
}

test('StepDatabase stores new content_blob as gzip BLOB', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'lumencode-step-blob-')), 'steps.db');
  const db = new StepDatabase();
  await db.open(dbPath);
  db.upsertStepFile('step1', 'src/app.js', { lines: ['step1'] }, 'hello\n');
  assert.equal(db.getFileBlob('step1', 'src/app.js'), 'hello\n');
  assert.equal(Buffer.isBuffer(db.db.prepare('SELECT content_blob FROM step_files').get().content_blob), true);
  db.close();
});

test('StepDatabase reads and gradually migrates gzip base64 TEXT', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'lumencode-step-legacy-')), 'steps.db');
  const db = new StepDatabase();
  await db.open(dbPath);
  const legacy = `gzip:base64:${gzipSync(Buffer.from('legacy\n')).toString('base64')}`;
  db.db.prepare('INSERT INTO step_files (step_id, path, content_blob) VALUES (?, ?, ?)').run('s1', 'a.js', legacy);
  assert.equal(db.getFileBlob('s1', 'a.js'), 'legacy\n');
  assert.equal(Buffer.isBuffer(db.db.prepare('SELECT content_blob FROM step_files').get().content_blob), true);
  db.close();
});

test('StepDatabase reads legacy plain and empty TEXT', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'lumencode-step-plain-')), 'steps.db');
  const db = new StepDatabase();
  await db.open(dbPath);
  const insert = db.db.prepare('INSERT INTO step_files (step_id, path, content_blob) VALUES (?, ?, ?)');
  insert.run('s1', 'plain.js', 'plain\n');
  insert.run('s2', 'empty.js', '');
  assert.equal(db.getFileBlob('s1', 'plain.js'), 'plain\n');
  assert.equal(db.getFileBlob('s2', 'empty.js'), '');
  db.close();
});

test('StepDatabase rejects future schema versions', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'lumencode-step-future-')), 'steps.db');
  const db = new StepDatabase();
  await db.open(dbPath);
  db.db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
  db.close();
  await assert.rejects(() => new StepDatabase().open(dbPath), err => err.code === 'unsupported_schema_version');
});

test('StepDatabase preserves corrupt database and reports open_failed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumencode-step-corrupt-'));
  const dbPath = join(root, '.lumencode', 'steps.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, 'not a sqlite database');
  await assert.rejects(() => new StepDatabase().open(dbPath, { projectRoot: root }));
  const status = readStepDatabaseStatus(root);
  assert.equal(status.type, 'open_failed');
  assert.equal(status.sourcePath, dbPath);
});

test('StepDatabase preserves concurrent hook-like writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumencode-step-concurrent-'));
  const script = fileURLToPath(new URL('./fixtures/step-writer-fixture', import.meta.url));
  await Promise.all([runNodeScript(script, [root, 'a', '200']), runNodeScript(script, [root, 'b', '200'])]);
  const db = new StepDatabase();
  await db.open(join(root, '.lumencode', 'steps.db'));
  assert.equal(db.getStepCount(), 400);
  assert.equal(db.db.pragma('quick_check', { simple: true }), 'ok');
  db.close();
});

test('StepDatabase opens an existing standard SQLite database', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'lumencode-step-existing-')), 'steps.db');
  const raw = new Database(dbPath);
  raw.exec(`CREATE TABLE steps (id TEXT PRIMARY KEY, parent_id TEXT, session_id TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'claude_code', ts INTEGER NOT NULL, tool_name TEXT NOT NULL, tool_use_id TEXT NOT NULL, tree_hash TEXT);
    CREATE TABLE step_files (step_id TEXT NOT NULL, path TEXT NOT NULL, blob_hash TEXT, blame_map TEXT, content_blob TEXT, PRIMARY KEY(step_id,path));
    CREATE TABLE sessions (id TEXT PRIMARY KEY, origin TEXT NOT NULL DEFAULT 'claude_code', started_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, head_step_id TEXT);`);
  raw.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('s1', null, 'session', 'claude_code', 1, 'Write', 'u1', null);
  raw.close();
  const db = new StepDatabase();
  await db.open(dbPath);
  assert.equal(db.getStepCount(), 1);
  db.close();
});
test('StepDatabase rejects invalid schema versions', async () => {
  for (const value of ['abc', '-1', '1.5', '0']) {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'lumencode-step-invalid-version-')), 'steps.db');
    const db = new StepDatabase();
    await db.open(dbPath);
    db.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(value, 'schema_version');
    db.close();
    await assert.rejects(() => new StepDatabase().open(dbPath), err => err.code === 'unsupported_schema_version');
  }
});

test('StepDatabase status reports the actual custom database path and schema', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumencode-step-status-'));
  const dbPath = join(root, 'custom', 'steps.db');
  const db = new StepDatabase();
  await db.open(dbPath, { projectRoot: root });
  db.close();
  const status = readStepDatabaseStatus(root);
  assert.equal(status.sourcePath, dbPath);
  assert.equal(status.engine, 'better-sqlite3');
  assert.equal(status.schemaVersion, 2);
  assert.ok(status.dbSizeBytes > 0);
});

test('StepDatabase opens a real sql.js version-1 database', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'lumencode-step-sqljs-')), 'steps.db');
  const SQL = await initSqlJs();
  const legacy = new SQL.Database();
  legacy.exec(`CREATE TABLE steps (id TEXT PRIMARY KEY, parent_id TEXT, session_id TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'claude_code', ts INTEGER NOT NULL, tool_name TEXT NOT NULL, tool_use_id TEXT NOT NULL, tree_hash TEXT);
    CREATE TABLE step_files (step_id TEXT NOT NULL, path TEXT NOT NULL, blob_hash TEXT, blame_map TEXT, content_blob TEXT, PRIMARY KEY(step_id,path));
    CREATE TABLE sessions (id TEXT PRIMARY KEY, origin TEXT NOT NULL DEFAULT 'claude_code', started_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, head_step_id TEXT);`);
  const compressed = `gzip:base64:${gzipSync(Buffer.from('compressed\n')).toString('base64')}`;
  legacy.run('INSERT INTO steps VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['s1', null, 'session', 'claude_code', 1, 'Write', 'u1', null]);
  legacy.run('INSERT INTO step_files VALUES (?, ?, ?, ?, ?)', ['s1', 'plain.js', null, null, 'plain\n']);
  legacy.run('INSERT INTO step_files VALUES (?, ?, ?, ?, ?)', ['s1', 'compressed.js', null, null, compressed]);
  writeFileSync(dbPath, Buffer.from(legacy.export()));
  legacy.close();

  const db = new StepDatabase();
  await db.open(dbPath);
  assert.equal(db.getStepCount(), 1);
  assert.equal(db.getFileBlob('s1', 'plain.js'), 'plain\n');
  assert.equal(db.getFileBlob('s1', 'compressed.js'), 'compressed\n');
  db.close();
});

test('StepDatabase remains valid after a writer is killed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumencode-step-kill-'));
  const script = fileURLToPath(new URL('./fixtures/step-kill-writer', import.meta.url));
  const child = spawn(process.execPath, [script, root], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  const db = new StepDatabase();
  await db.open(join(root, 'steps.db'));
  assert.equal(db.db.pragma('quick_check', { simple: true }), 'ok');
  db.close();
});

test('StepDatabase appends to a 100MB database without rewriting the main file', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'lumencode-step-large-')), 'steps.db');
  const raw = new Database(dbPath);
  raw.exec('CREATE TABLE padding (data BLOB)');
  raw.prepare('INSERT INTO padding VALUES (zeroblob(?))').run(100 * 1024 * 1024);
  raw.close();
  const before = statSync(dbPath).size;
  const db = new StepDatabase();
  await db.open(dbPath);
  db.insertStep({ id: 'large-step', sessionId: 'session', ts: 1, toolName: 'Write', toolUseId: 'u1' });
  assert.equal(statSync(dbPath).size, before);
  assert.ok(statSync(`${dbPath}-wal`).size > 0);
  db.close();
});
test('StepDatabase write contention fails with SQLITE_BUSY after timeout', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'lumencode-step-busy-')), 'steps.db');
  const first = new StepDatabase();
  const second = new StepDatabase();
  await first.open(dbPath, { busyTimeoutMs: 20 });
  await second.open(dbPath, { busyTimeoutMs: 20 });
  first.db.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(() => second.insertStep({
      id: 'busy-step', sessionId: 'session', ts: 1, toolName: 'Write', toolUseId: 'u1',
    }), err => err.code === 'SQLITE_BUSY');
  } finally {
    first.db.exec('ROLLBACK');
    first.close();
    second.close();
  }
});
