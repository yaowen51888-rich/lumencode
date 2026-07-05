import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { OpenclawParser } from '../../lib/parsers/openclaw.js';

test('OpenclawParser - 解析 sessions.json 索引', async () => {
  const root = join(tmpdir(), `lumencode-openclaw-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const sessions = [{
    sessionId: 'uuid-1', model: 'anthropic/claude-opus-4-6',
    inputTokens: 600, outputTokens: 250, totalTokens: 850,
    updatedAt: 1783120800000, costUsd: 0.05,
  }];
  writeFileSync(join(root, 'sessions.json'), JSON.stringify(sessions));
  try {
    const p = new OpenclawParser();
    assert.equal(await p.detect({ openclawDir: root }), true);
    const records = await p.parse({ openclawDir: root });
    assert.equal(records.length, 1);
    assert.equal(records[0].tool, 'openclaw');
    assert.equal(records[0].sessionId, 'uuid-1');
    assert.equal(records[0].model, 'anthropic/claude-opus-4-6');
    assert.equal(records[0].inputTokens, 600);
    assert.equal(records[0].outputTokens, 250);
    assert.equal(records[0].costUSD, 0.05);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OpenclawParser - 索引缺失时回退 transcripts JSONL', async () => {
  const root = join(tmpdir(), `lumencode-openclaw2-${process.pid}-${Date.now()}`);
  const tDir = join(root, 'transcripts', '2026-07-04', 'sess-x');
  mkdirSync(tDir, { recursive: true });
  writeFileSync(join(tDir, 'transcript.jsonl'), JSON.stringify({
    sessionId: 'sess-x', timestamp: '2026-07-04T10:00:00Z',
    message: { model: 'claude-sonnet-4-6', usage: { input: 100, output: 40, cacheRead: 5 } },
  }));
  try {
    const records = await new OpenclawParser().parse({ openclawDir: root });
    assert.equal(records.length, 1);
    assert.equal(records[0].inputTokens, 100);
    assert.equal(records[0].outputTokens, 40);
    assert.equal(records[0].cacheReadTokens, 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OpenclawParser - 多目录候选 + 归档 .jsonl.deleted.* 识别', async () => {
  const root1 = join(tmpdir(), `lumencode-oc1-${process.pid}-${Date.now()}-${Math.random()}`);
  const root2 = join(tmpdir(), `lumencode-oc2-${process.pid}-${Date.now()}-${Math.random()}`);
  // root1: sessions.json 索引
  mkdirSync(root1, { recursive: true });
  writeFileSync(join(root1, 'sessions.json'), JSON.stringify(
    [{ sessionId: 'idx-1', model: 'claude', inputTokens: 10, outputTokens: 5 }]));
  // root2: 归档会话 .jsonl.deleted.<ts>
  const tDir = join(root2, 'transcripts', 'archived');
  mkdirSync(tDir, { recursive: true });
  writeFileSync(join(tDir, 'sess-old.jsonl.deleted.1700000000000'), JSON.stringify({
    sessionId: 'sess-old', timestamp: '2026-06-01T00:00:00Z',
    message: { model: 'claude', usage: { input: 50, output: 20 } },
  }));
  try {
    const records = await new OpenclawParser().parse({ openclawDir: `${root1},${root2}` });
    assert.equal(records.length, 2, 'root1 索引 1 条 + root2 归档 1 条');
    const sids = records.map(r => r.sessionId).sort();
    assert.deepEqual(sids, ['idx-1', 'sess-old']);
  } finally { rmSync(root1, { recursive: true, force: true }); rmSync(root2, { recursive: true, force: true }); }
});
