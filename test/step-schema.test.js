import test from 'node:test';
import { spawn } from 'child_process';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { StepDatabase } from '../lib/step-schema.js';
import { readStepDatabaseStatus } from '../lib/step-db-status.js';

function runNodeScript(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `exit ${code}`));
    });
  });
}

test('StepDatabase.open throws lock_timeout when lock cannot be acquired', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumencode-step-lock-'));
  const dbPath = join(root, 'steps.db');
  const lockPath = `${dbPath}.lock`;
  const fd = openSync(lockPath, 'wx');

  try {
    const db = new StepDatabase();
    await assert.rejects(
      () => db.open(dbPath, { lockTimeoutMs: 20 }),
      err => err?.code === 'lock_timeout' && /lock_timeout/.test(err.message)
    );
  } finally {
    closeSync(fd);
    unlinkSync(lockPath);
  }
});

test('StepDatabase releases lock on close', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumencode-step-lock-release-'));
  const dbPath = join(root, 'steps.db');
  const db = new StepDatabase();

  await db.open(dbPath, { lockTimeoutMs: 2000 });
  assert.equal(existsSync(`${dbPath}.lock`), true);

  db.close();
  assert.equal(existsSync(`${dbPath}.lock`), false);
});
test('StepDatabase recovers latest bak when target is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumencode-step-bak-'));
  const dbPath = join(root, 'steps.db');

  const db = new StepDatabase();
  await db.open(dbPath, { lockTimeoutMs: 2000 });
  db.insertStep({
    id: 'before-bak',
    sessionId: 'session',
    origin: 'claude_code',
    ts: 1,
    toolName: 'Write',
    toolUseId: 'tool',
  });
  db.save();
  db.close();

  renameSync(dbPath, `${dbPath}.bak.test`);
  const reopened = new StepDatabase();
  await reopened.open(dbPath, { lockTimeoutMs: 2000 });
  assert.equal(reopened.getStepCount(), 1);
  reopened.close();
});
test('StepDatabase backs up corrupt database and recreates empty database', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumencode-step-corrupt-'));
  const dbPath = join(root, '.lumencode', 'steps.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, 'not a sqlite database');

  const db = new StepDatabase();
  await db.open(dbPath, { projectRoot: root, lockTimeoutMs: 2000 });
  assert.equal(db.getStepCount(), 0);
  db.close();

  const status = readStepDatabaseStatus(root);
  assert.equal(status.type, 'corrupt_recovered');
  assert.equal(status.sourcePath, dbPath);
  assert.match(status.corruptBackupPath, /steps\.db\.corrupt\./);
  assert.equal(existsSync(status.corruptBackupPath), true);
});
test('StepDatabase stores new content_blob as gzip base64 and reads it back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumencode-step-gzip-'));
  const dbPath = join(root, 'steps.db');
  const content = 'line one\nline two\n';

  const db = new StepDatabase();
  await db.open(dbPath, { lockTimeoutMs: 2000 });
  db.upsertStepFile('step1', 'src/app.js', { lines: ['step1', 'step1'] }, content);
  assert.equal(db.getFileBlob('step1', 'src/app.js'), content);

  const stmt = db.db.prepare('SELECT content_blob FROM step_files WHERE step_id = ? AND path = ?');
  stmt.bind(['step1', 'src/app.js']);
  assert.equal(stmt.step(), true);
  const row = stmt.getAsObject();
  stmt.free();
  assert.match(row.content_blob, /^gzip:base64:/);
  db.close();
});

test('StepDatabase reads legacy plain text content_blob', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumencode-step-plain-'));
  const dbPath = join(root, 'steps.db');
  const db = new StepDatabase();
  await db.open(dbPath, { lockTimeoutMs: 2000 });
  db.db.run(
    'INSERT OR REPLACE INTO step_files (step_id, path, blame_map, content_blob) VALUES (?, ?, ?, ?)',
    ['step-plain', 'plain.js', '{"lines":["step-plain"]}', 'plain text\n']
  );
  assert.equal(db.getFileBlob('step-plain', 'plain.js'), 'plain text\n');
  db.close();
});
test('StepDatabase preserves writes from concurrent hook-like processes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumencode-step-concurrent-'));
  const script = fileURLToPath(new URL('./fixtures/step-writer-fixture', import.meta.url));

  await Promise.all([
    runNodeScript(script, [root, 'a', '40']),
    runNodeScript(script, [root, 'b', '40']),
  ]);

  const db = new StepDatabase();
  await db.open(join(root, '.lumencode', 'steps.db'), { lockTimeoutMs: 2000 });
  assert.equal(db.getStepCount(), 80);
  db.close();
});
test('StepDatabase reads legacy empty plain text content_blob', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumencode-step-empty-plain-'));
  const dbPath = join(root, 'steps.db');
  const db = new StepDatabase();
  await db.open(dbPath, { lockTimeoutMs: 2000 });
  db.db.run(
    'INSERT OR REPLACE INTO step_files (step_id, path, blame_map, content_blob) VALUES (?, ?, ?, ?)',
    ['step-empty', 'empty.js', '{"lines":[]}', '']
  );
  assert.equal(db.getFileBlob('step-empty', 'empty.js'), '');
  db.close();
});
