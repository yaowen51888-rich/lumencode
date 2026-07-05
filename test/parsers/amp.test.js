import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AmpParser } from '../../lib/parsers/amp.js';

const uniq = s => join(tmpdir(), `lumencode-amp-${s}-${process.pid}-${Date.now()}-${Math.random()}`);

test('AmpParser - assistant message usage 解析（含 cache）', async () => {
  const root = uniq('msg');
  const threadsDir = join(root, 'threads');
  mkdirSync(threadsDir, { recursive: true });
  const thread = {
    id: 'T-abc123', repoUrl: 'git@github.com:u/myapp.git',
    messages: [
      { role: 'assistant', model: 'claude-sonnet-4-6', usage: { inputTokens: 500, outputTokens: 200, cacheReadInputTokens: 50, cacheCreationInputTokens: 30, timestamp: '2026-07-04T08:00:00Z' } },
      { role: 'assistant', usage: { inputTokens: 0, outputTokens: 0 } }, // 全 0 跳过
      { role: 'user', usage: { inputTokens: 999, outputTokens: 999, timestamp: '2026-07-04T08:01:00Z', model: 'x' } }, // 非 assistant 不计
    ],
  };
  writeFileSync(join(threadsDir, 'T-abc123.json'), JSON.stringify(thread));
  try {
    const p = new AmpParser();
    assert.equal(await p.detect({ ampDir: root }), true);
    const records = await p.parse({ ampDir: root });
    assert.equal(records.length, 1, '仅 1 条 assistant 非零记录');
    assert.equal(records[0].sessionId, 'T-abc123');
    assert.equal(records[0].model, 'claude-sonnet-4-6');
    assert.equal(records[0].inputTokens, 500);
    assert.equal(records[0].outputTokens, 200);
    assert.equal(records[0].cacheReadTokens, 50);
    assert.equal(records[0].cacheWriteTokens, 30);
    assert.equal(records[0].project, 'myapp');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AmpParser - usageLedger.events 优先于 messages，cache 经 toMessageId 关联', async () => {
  const root = uniq('ledger');
  const threadsDir = join(root, 'threads');
  mkdirSync(threadsDir, { recursive: true });
  const thread = {
    id: 'T-ledger',
    usageLedger: { events: [
      { id: 'e1', timestamp: '2026-07-04T09:00:00Z', model: 'gpt-5', tokens: { input: 10, output: 20 }, toMessageId: 7 },
    ] },
    messages: [
      { role: 'assistant', messageId: 7, usage: { cacheCreationInputTokens: 100, cacheReadInputTokens: 200, timestamp: '2026-07-04T09:00:00Z', model: 'claude' } },
      { role: 'assistant', usage: { inputTokens: 999, outputTokens: 999, timestamp: '2026-07-04T09:01:00Z', model: 'should-not-appear' } },
    ],
  };
  writeFileSync(join(threadsDir, 'T-ledger.json'), JSON.stringify(thread));
  try {
    const records = await new AmpParser().parse({ ampDir: root });
    assert.equal(records.length, 1, 'ledger 优先，messages 被忽略');
    assert.equal(records[0].model, 'gpt-5');
    assert.equal(records[0].inputTokens, 10);
    assert.equal(records[0].outputTokens, 20);
    assert.equal(records[0].cacheWriteTokens, 100, 'toMessageId=7 关联 message cache');
    assert.equal(records[0].cacheReadTokens, 200);
    assert.equal(records[0].metadata.source, 'ledger');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AmpParser - total fallback（input/output 全 0 时 total 计 output）', async () => {
  const root = uniq('total');
  const threadsDir = join(root, 'threads');
  mkdirSync(threadsDir, { recursive: true });
  // ledger 与 message 各一个 total-only 记录
  const thread = {
    id: 'T-total',
    usageLedger: { events: [
      { timestamp: '2026-07-04T10:00:00Z', model: 'gpt-5', tokens: { total: 345 } },
    ] },
    messages: [],
  };
  writeFileSync(join(threadsDir, 'T-total.json'), JSON.stringify(thread));
  // 第二个文件用 message path 的 totalTokens
  const thread2 = {
    id: 'T-total2',
    messages: [
      { role: 'assistant', usage: { totalTokens: 100, timestamp: '2026-07-04T11:00:00Z', model: 'claude' } },
    ],
  };
  writeFileSync(join(threadsDir, 'T-total2.json'), JSON.stringify(thread2));
  try {
    const records = await new AmpParser().parse({ ampDir: root });
    assert.equal(records.length, 2);
    const byModel = Object.fromEntries(records.map(r => [r.model, r.outputTokens]));
    assert.equal(byModel['gpt-5'], 345, 'ledger tokens.total → output');
    assert.equal(byModel['claude'], 100, 'message totalTokens → output');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AmpParser - 空 usageLedger（无 events）回退 messages', async () => {
  const root = uniq('empty-ledger');
  const threadsDir = join(root, 'threads');
  mkdirSync(threadsDir, { recursive: true });
  const thread = {
    id: 'T-empty',
    usageLedger: {}, // 无 events 数组
    messages: [
      { role: 'assistant', usage: { inputTokens: 10, outputTokens: 178, timestamp: '2026-07-04T12:00:00Z', model: 'claude' } },
    ],
  };
  writeFileSync(join(threadsDir, 'T-empty.json'), JSON.stringify(thread));
  try {
    const records = await new AmpParser().parse({ ampDir: root });
    assert.equal(records.length, 1, '空 ledger 回退 message');
    assert.equal(records[0].inputTokens, 10);
    assert.equal(records[0].metadata.source, 'message');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
