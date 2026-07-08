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

test('StepTracker - Bash without file targets does not advance session head', async () => {
  const trackerDbPath = join(tempDir, 'bash-empty-tracker.db');
  const tracker = new StepTracker(tempDir, { dbPath: trackerDbPath });
  await tracker.open();

  const testFile = join(tempDir, 'bash-head.js');
  writeFileSync(testFile, 'const first = 1;\n');

  const firstHash = await tracker.recordStep({
    sessionId: 'sess-bash-empty',
    toolName: 'Write',
    toolInput: { file_path: testFile },
    toolUseId: 'tu-first',
  });

  const bashHash = await tracker.recordStep({
    sessionId: 'sess-bash-empty',
    toolName: 'Bash',
    toolInput: { command: 'git status --short' },
    toolUseId: 'tu-bash-empty',
  });

  assert.equal(bashHash, null);
  assert.equal(tracker.db.getSessionHead('sess-bash-empty'), firstHash);
  tracker.close();
});

// ── P0 行级归因：时间对齐 + 逐行投影 ──

test('StepDatabase - getStepFilesForPath 时间过滤 beforeTs', async () => {
  const db = new StepDatabase();
  const p = join(tempDir, 'ts-filter.db');
  await db.open(p);
  db.insertStep({ id: 'early', parentId: null, sessionId: 's', ts: 100, toolName: 'Write', toolUseId: 't1' });
  db.insertStep({ id: 'late', parentId: null, sessionId: 's', ts: 300, toolName: 'Write', toolUseId: 't2' });
  db.upsertStepFile('early', 'tsf.js', { lines: ['early'] });
  db.upsertStepFile('late', 'tsf.js', { lines: ['late'] });

  const r = db.getStepFilesForPath('tsf.js', 5, 200); // beforeTs=200 → 仅 early
  assert.equal(r.length, 1);
  assert.equal(r[0].step_id, 'early');

  const all = db.getStepFilesForPath('tsf.js', 5); // 无 beforeTs → 两个，DESC
  assert.equal(all.length, 2);
  assert.equal(all[0].step_id, 'late');
  db.close();
});

test('StepTracker - 时间对齐：commitMs 排除未来 step', async () => {
  const trackerDbPath = join(tempDir, 'ts-align.db');
  const tracker = new StepTracker(tempDir, { dbPath: trackerDbPath });
  await tracker.open();
  const f = join(tempDir, 'tsalign.js');
  writeFileSync(f, 'old\n');
  await tracker.recordStep({ sessionId: 'sA', toolName: 'Write', toolInput: { file_path: f }, toolUseId: 'tA1', timestamp: 100 });
  writeFileSync(f, 'old\nnew\n');
  await tracker.recordStep({ sessionId: 'sB', toolName: 'Edit', toolInput: { file_path: f }, toolUseId: 'tB1', timestamp: 300 });

  // commit 发生在 t=200，只能看到 t≤200 的 step（session A），不该被 session B（t=300）污染
  const res = tracker.getLineAttributionForCommit({
    sessionId: 'sA', commitMs: 200,
    files: [{ path: 'tsalign.js', added: 1, deleted: 0, binary: false }],
  });
  assert.ok(res, '应返回结果');
  assert.equal(res.aiLines, 1); // t=200 时仅 session A 的 step（'old\n' 1 行全 AI）
  tracker.close();
});

test('StepTracker - 逐行投影：commit 内容对齐时精确归属 added', async () => {
  const trackerDbPath = join(tempDir, 'proj-align.db');
  const tracker = new StepTracker(tempDir, { dbPath: trackerDbPath });
  await tracker.open();
  const f = join(tempDir, 'align.js');
  writeFileSync(f, 'a\nb\nc\n'); // 3 行
  await tracker.recordStep({ sessionId: 's-align', toolName: 'Write', toolInput: { file_path: f }, toolUseId: 't-align' });

  // commit 紧跟 step、文件未变 → 逐行投影，3 个 added 行全属 AI
  const res = tracker.getLineAttributionForCommit({
    sessionId: 's-align', commitMs: Date.now(),
    files: [{ path: 'align.js', added: 3, deleted: 0, binary: false, commitContent: 'a\nb\nc\n', addedLines: [1, 2, 3] }],
  });
  assert.equal(res.aiLines, 3);
  assert.equal(res.humanLines, 0);
  tracker.close();
});

test('StepTracker - commit 内容错配时降级比例法', async () => {
  const trackerDbPath = join(tempDir, 'proj-degrade.db');
  const tracker = new StepTracker(tempDir, { dbPath: trackerDbPath });
  await tracker.open();
  const f = join(tempDir, 'degrade.js');
  writeFileSync(f, 'a\nb\nc\n'); // 3 行
  await tracker.recordStep({ sessionId: 's-deg', toolName: 'Write', toolInput: { file_path: f }, toolUseId: 't-deg' });

  // commitContent ≠ step 内容 → 降级；文件全 AI（aiRatio=1），added=2 → aiLines=2
  const res = tracker.getLineAttributionForCommit({
    sessionId: 's-deg', commitMs: Date.now(),
    files: [{ path: 'degrade.js', added: 2, deleted: 0, binary: false, commitContent: 'totally\ndifferent\n', addedLines: [1] }],
  });
  assert.equal(res.aiLines, 2);
  tracker.close();
});

// ── P0 fuzzy 内容对齐：drift 时行映射投影 ──

test('StepTracker - fuzzy: 高相似 drift 命中行映射投影', async () => {
  const trackerDbPath = join(tempDir, 'fz-hi.db');
  const tracker = new StepTracker(tempDir, { dbPath: trackerDbPath });
  await tracker.open();
  const f = join(tempDir, 'fzhi.js');
  writeFileSync(f, 'a\nb\nc\nd\ne\n');
  await tracker.recordStep({ sessionId: 's-fz', toolName: 'Write', toolInput: { file_path: f }, toolUseId: 't-fz' });

  // commit 改第3行 c→X：行 1,2,4,5 映射到 step（AI），行 3 replace 未映射（human），coverage 4/5=0.8
  const res = tracker.getLineAttributionForCommit({
    sessionId: 's-fz', commitMs: Date.now(),
    files: [{ path: 'fzhi.js', added: 5, deleted: 0, binary: false, commitContent: 'a\nb\nX\nd\ne\n', addedLines: [1, 2, 3, 4, 5] }],
  });
  assert.equal(res.fuzzyFiles, 1);
  assert.equal(res.aiLines, 4);
  assert.equal(res.humanLines, 1);
  tracker.close();
});

test('StepTracker - fuzzy: 低相似 drift 回比例法', async () => {
  const trackerDbPath = join(tempDir, 'fz-lo.db');
  const tracker = new StepTracker(tempDir, { dbPath: trackerDbPath });
  await tracker.open();
  const f = join(tempDir, 'fzlo.js');
  writeFileSync(f, 'a\nb\nc\n');
  await tracker.recordStep({ sessionId: 's-fz2', toolName: 'Write', toolInput: { file_path: f }, toolUseId: 't-fz2' });

  // commit 完全重写：无 equal，coverage 0 → 回比例（aiRatio=1，added=3 → aiLines=3）
  const res = tracker.getLineAttributionForCommit({
    sessionId: 's-fz2', commitMs: Date.now(),
    files: [{ path: 'fzlo.js', added: 3, deleted: 0, binary: false, commitContent: 'x\ny\nz\n', addedLines: [1, 2, 3] }],
  });
  assert.equal(res.fuzzyFiles, 0);
  assert.equal(res.degradedDrift, 1);
  assert.equal(res.aiLines, 3);
  tracker.close();
});

test('StepTracker - fuzzy: 覆盖率恰达阈值 0.6 仍命中', async () => {
  const trackerDbPath = join(tempDir, 'fz-edge.db');
  const tracker = new StepTracker(tempDir, { dbPath: trackerDbPath });
  await tracker.open();
  const f = join(tempDir, 'fzedge.js');
  writeFileSync(f, 'a\nb\nc\nd\ne\n');
  await tracker.recordStep({ sessionId: 's-fz3', toolName: 'Write', toolInput: { file_path: f }, toolUseId: 't-fz3' });

  // commit 改第 4,5 行：行 1,2,3 映射（AI），4,5 replace（human），coverage 3/5=0.6 命中阈值
  const res = tracker.getLineAttributionForCommit({
    sessionId: 's-fz3', commitMs: Date.now(),
    files: [{ path: 'fzedge.js', added: 5, deleted: 0, binary: false, commitContent: 'a\nb\nc\nX\nY\n', addedLines: [1, 2, 3, 4, 5] }],
  });
  assert.equal(res.fuzzyFiles, 1);
  assert.equal(res.aiLines, 3);
  assert.equal(res.humanLines, 2);
  tracker.close();
});

test('StepTracker - fuzzy: 未映射 insert 行计 human', async () => {
  const trackerDbPath = join(tempDir, 'fz-ins.db');
  const tracker = new StepTracker(tempDir, { dbPath: trackerDbPath });
  await tracker.open();
  const f = join(tempDir, 'fzins.js');
  writeFileSync(f, 'a\nb\nc\nd\ne\n');
  await tracker.recordStep({ sessionId: 's-fz4', toolName: 'Write', toolInput: { file_path: f }, toolUseId: 't-fz4' });

  // commit 末尾 insert new：行 1-5 映射（AI），行 6 insert 未映射（human），coverage 5/6
  const res = tracker.getLineAttributionForCommit({
    sessionId: 's-fz4', commitMs: Date.now(),
    files: [{ path: 'fzins.js', added: 6, deleted: 0, binary: false, commitContent: 'a\nb\nc\nd\ne\nnew\n', addedLines: [1, 2, 3, 4, 5, 6] }],
  });
  assert.equal(res.fuzzyFiles, 1);
  assert.equal(res.aiLines, 5);
  assert.equal(res.humanLines, 1);
  tracker.close();
});

test('StepTracker - fuzzy: addedLines 缺失回比例法', async () => {
  const trackerDbPath = join(tempDir, 'fz-noadded.db');
  const tracker = new StepTracker(tempDir, { dbPath: trackerDbPath });
  await tracker.open();
  const f = join(tempDir, 'fzna.js');
  writeFileSync(f, 'a\nb\nc\n');
  await tracker.recordStep({ sessionId: 's-fz5', toolName: 'Write', toolInput: { file_path: f }, toolUseId: 't-fz5' });

  // drift 但 addedLines 缺：coverage 0 → 回比例（aiRatio=1，added=3 → aiLines=3），不走 fuzzy
  const res = tracker.getLineAttributionForCommit({
    sessionId: 's-fz5', commitMs: Date.now(),
    files: [{ path: 'fzna.js', added: 3, deleted: 0, binary: false, commitContent: 'a\nb\nX\n', addedLines: [] }],
  });
  assert.equal(res.fuzzyFiles, 0);
  assert.equal(res.degradedDrift, 1);
  assert.equal(res.aiLines, 3);
  tracker.close();
});

test('StepTracker - CRLF step vs LF commit 归一后仍 aligned', async () => {
  const trackerDbPath = join(tempDir, 'crlf.db');
  const tracker = new StepTracker(tempDir, { dbPath: trackerDbPath });
  await tracker.open();
  const f = join(tempDir, 'crlf.js');
  writeFileSync(f, 'a\r\nb\r\nc\r\n'); // 文件 CRLF，recordStep 存 CRLF 快照
  await tracker.recordStep({ sessionId: 's-crlf', toolName: 'Write', toolInput: { file_path: f }, toolUseId: 't-crlf' });

  // git show 出 LF；换行符归一后内容相等 → aligned 命中（非 drift）
  const res = tracker.getLineAttributionForCommit({
    sessionId: 's-crlf', commitMs: Date.now(),
    files: [{ path: 'crlf.js', added: 3, deleted: 0, binary: false, commitContent: 'a\nb\nc\n', addedLines: [1, 2, 3] }],
  });
  assert.equal(res.alignedFiles, 1);
  assert.equal(res.degradedFiles, 0);
  assert.equal(res.aiLines, 3);
  tracker.close();
});
