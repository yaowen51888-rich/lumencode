// test/parsers/pi.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PiParser } from '../../lib/parsers/pi.js';

const uniq = s => join(tmpdir(), `lumencode-pi-${s}-${process.pid}-${Date.now()}-${Math.random()}`);

test('PiParser - assistant message usage 全字段 + model 加 [pi] 前缀', async () => {
  const root = uniq('full');
  const dir = join(root, 'sessions', 'project-a');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent_session-a.jsonl'), JSON.stringify({
    type: 'message', timestamp: '2026-01-02T00:00:00.000Z',
    message: { role: 'assistant', model: 'gpt-5', usage: { input: 100, output: 200, cacheRead: 5, cacheWrite: 10, cost: { total: 0.05 } } },
  }));
  try {
    const p = new PiParser();
    assert.equal(await p.detect({ piDir: join(root, 'sessions') }), true);
    const records = await p.parse({ piDir: join(root, 'sessions') });
    assert.equal(records.length, 1);
    assert.equal(records[0].model, '[pi] gpt-5', 'model 加 [pi] 前缀');
    assert.equal(records[0].inputTokens, 100);
    assert.equal(records[0].outputTokens, 200);
    assert.equal(records[0].cacheReadTokens, 5);
    assert.equal(records[0].cacheWriteTokens, 10);
    assert.equal(records[0].costUSD, 0.05);
    assert.equal(records[0].sessionId, 'session-a', '文件名 split _ 后部分');
    assert.equal(records[0].project, 'project-a');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('PiParser - totalTokens fallback（input/output 全 0 → output）', async () => {
  const root = uniq('total');
  const dir = join(root, 'sessions', 'project-a');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent_session-b.jsonl'), JSON.stringify({
    type: 'message', timestamp: '2026-01-02T00:00:00.000Z',
    message: { role: 'assistant', model: 'gpt-5', usage: { totalTokens: 333 } },
  }));
  try {
    const records = await new PiParser().parse({ piDir: join(root, 'sessions') });
    assert.equal(records.length, 1);
    assert.equal(records[0].outputTokens, 333);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('PiParser - 非 message 类型 / 非 assistant role 跳过', async () => {
  const root = uniq('skip');
  const dir = join(root, 'sessions', 'project-a');
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'event', timestamp: '2026-01-02T00:00:00.000Z', message: { role: 'assistant', model: 'x', usage: { input: 999 } } }), // type≠message 跳过
    JSON.stringify({ type: 'message', timestamp: '2026-01-02T00:00:00.000Z', message: { role: 'user', model: 'x', usage: { input: 999 } } }), // role≠assistant 跳过
    JSON.stringify({ type: 'message', timestamp: '2026-01-02T00:00:00.000Z', message: { role: 'assistant', model: 'gpt-5', usage: { input: 10, output: 5 } } }),
  ];
  writeFileSync(join(dir, 'agent_session-c.jsonl'), lines.join('\n'));
  try {
    const records = await new PiParser().parse({ piDir: join(root, 'sessions') });
    assert.equal(records.length, 1, '仅 1 条有效 assistant message');
    assert.equal(records[0].inputTokens, 10);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
