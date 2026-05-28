import test from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { StepDatabase } from '../lib/step-schema.js';
import { StepTracker } from '../lib/step-tracker.js';

let tempDir;
let dbPath;

test.before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'step-test-'));
  dbPath = join(tempDir, 'test-steps.db');
});

test.after(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// ── StepDatabase tests ──

test('StepDatabase - open creates new DB', async () => {
  const db = new StepDatabase();
  await db.open(dbPath);
  db.save();
  db.close();
  assert.ok(existsSync(dbPath));
});

test('StepDatabase - insertStep and getStepsBySession', async () => {
  const db = new StepDatabase();
  await db.open(dbPath);
  db.insertStep({
    id: 'step1', parentId: null, sessionId: 'sess1',
    ts: Date.now(), toolName: 'Write', toolUseId: 'tu1',
  });
  db.save();
  const steps = db.getStepsBySession('sess1');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].id, 'step1');
  db.close();
});

test('StepDatabase - upsertSession and getSessionHead', async () => {
  const db = new StepDatabase();
  await db.open(dbPath);
  db.upsertSession({ id: 'sess1', headStepId: 'step1' });
  assert.equal(db.getSessionHead('sess1'), 'step1');
  db.upsertSession({ id: 'sess1', headStepId: 'step2' });
  assert.equal(db.getSessionHead('sess1'), 'step2');
  db.close();
});

test('StepDatabase - upsertStepFile and getBlameMap', async () => {
  const db = new StepDatabase();
  await db.open(dbPath);
  const blameMap = { lines: ['step1', 'step1', 'step2'] };
  db.upsertStepFile('step1', 'src/app.js', blameMap);
  const result = db.getBlameMap('step1', 'src/app.js');
  assert.deepEqual(result.lines, ['step1', 'step1', 'step2']);
  db.close();
});

test('StepDatabase - getStepCount / getSessionCount', async () => {
  const db = new StepDatabase();
  const countPath = join(tempDir, 'count-test.db');
  await db.open(countPath);
  db.insertStep({
    id: 's1', parentId: null, sessionId: 'sess1',
    ts: Date.now(), toolName: 'Write', toolUseId: 'tu1',
  });
  db.upsertSession({ id: 'sess1', headStepId: 's1' });
  assert.equal(db.getStepCount(), 1);
  assert.equal(db.getSessionCount(), 1);
  db.close();
});

// ── StepTracker tests ──

test('StepTracker - isAvailable returns false for empty DB', async () => {
  const trackerDbPath = join(tempDir, 'empty-tracker.db');
  const tracker = new StepTracker(tempDir, { dbPath: trackerDbPath });
  await tracker.open();
  assert.equal(tracker.isAvailable(), false);
  tracker.close();
});

test('StepTracker - recordStep with Write tool', async () => {
  const trackerDbPath = join(tempDir, 'write-tracker.db');
  const tracker = new StepTracker(tempDir, { dbPath: trackerDbPath });
  await tracker.open();

  // Create a test file
  const testFile = join(tempDir, 'src', 'hello.js');
  mkdirSync(join(tempDir, 'src'), { recursive: true });
  writeFileSync(testFile, 'console.log("hello");\n');

  const hash = await tracker.recordStep({
    sessionId: 'sess-test',
    toolName: 'Write',
    toolInput: { file_path: testFile },
    toolUseId: 'tu-write-1',
  });

  assert.ok(hash, 'recordStep should return a step hash');
  assert.equal(tracker.isAvailable(), true);
  tracker.close();
});

test('StepTracker - getStats returns counts', async () => {
  const trackerDbPath = join(tempDir, 'stats-tracker.db');
  const tracker = new StepTracker(tempDir, { dbPath: trackerDbPath });
  await tracker.open();

  const testFile = join(tempDir, 'stats.js');
  writeFileSync(testFile, 'const x = 1;\n');

  await tracker.recordStep({
    sessionId: 'sess-stats',
    toolName: 'Write',
    toolInput: { file_path: testFile },
    toolUseId: 'tu-stats-1',
  });

  const stats = tracker.getStats();
  assert.ok(stats.stepCount >= 1);
  tracker.close();
});

test('StepTracker - recordStep ignores non-file tools', async () => {
  const trackerDbPath = join(tempDir, 'ignore-tracker.db');
  const tracker = new StepTracker(tempDir, { dbPath: trackerDbPath });
  await tracker.open();

  const hash = await tracker.recordStep({
    sessionId: 'sess-ignore',
    toolName: 'Read',
    toolInput: { file_path: '/tmp/nope' },
  });

  assert.equal(hash, null);
  tracker.close();
});

test('StepTracker - isAvailableAsync detects existing DB', async () => {
  const trackerDbPath = join(tempDir, 'async-tracker.db');
  const tracker = new StepTracker(tempDir, { dbPath: trackerDbPath });
  await tracker.open();

  const testFile = join(tempDir, 'async-test.js');
  writeFileSync(testFile, 'export default {};\n');

  await tracker.recordStep({
    sessionId: 'sess-async',
    toolName: 'Write',
    toolInput: { file_path: testFile },
    toolUseId: 'tu-async-1',
  });
  tracker.close();

  const available = await StepTracker.prototype.isAvailableAsync.call(
    { dbPath: trackerDbPath },
  );
  // isAvailableAsync is an instance method, test via new instance
  const checker = new StepTracker(tempDir, { dbPath: trackerDbPath });
  assert.equal(await checker.isAvailableAsync(), true);
});

test('StepTracker - getLineAttributionForCommit with no sessionId returns null', async () => {
  const trackerDbPath = join(tempDir, 'commit-tracker.db');
  const tracker = new StepTracker(tempDir, { dbPath: trackerDbPath });
  await tracker.open();
  const result = tracker.getLineAttributionForCommit({ sessionId: null });
  assert.equal(result, null);
  tracker.close();
});
