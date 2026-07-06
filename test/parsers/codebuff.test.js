// test/parsers/codebuff.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CodebuffParser } from '../../lib/parsers/codebuff.js';

test('CodebuffParser - metadata.usage 完整拆分 + credits 计费', async () => {
  const root = join(tmpdir(), `lumencode-codebuff-${process.pid}-${Date.now()}`);
  const chatDir = join(root, 'projects', 'myapp', 'chats', '2026-07-04T12-34-56Z');
  mkdirSync(chatDir, { recursive: true });
  writeFileSync(join(chatDir, 'run-state.json'), JSON.stringify({ cwd: '/home/u/myapp' }));
  writeFileSync(join(chatDir, 'chat-messages.json'), JSON.stringify([
    {
      id: 'm1', role: 'assistant', timestamp: '2026-07-04T12:34:57.000Z',
      metadata: {
        model: 'claude-sonnet-4-20250514',
        usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 20, cacheReadInputTokens: 10 },
      },
      credits: 1.25,
    },
    { role: 'assistant', credits: 0, metadata: { usage: { inputTokens: 0, outputTokens: 0 } } }, // 全 0 + 无 credits 跳过
  ]));
  try {
    const p = new CodebuffParser();
    assert.equal(await p.detect({ codebuffDir: root }), true);
    const records = await p.parse({ codebuffDir: root });
    assert.equal(records.length, 1);
    assert.equal(records[0].tool, 'codebuff');
    assert.equal(records[0].model, 'claude-sonnet-4-20250514');
    assert.equal(records[0].inputTokens, 100);
    assert.equal(records[0].outputTokens, 50);
    assert.equal(records[0].cacheReadTokens, 10);
    assert.equal(records[0].cacheWriteTokens, 20);
    assert.equal(records[0].costUSD, 0.013, '1.25 × $0.01 × 1000 = 12.5 → round 13 → 0.013');
    assert.equal(records[0].project, '/home/u/myapp');
    assert.equal(records[0].metadata.credits, 1.25);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CodebuffParser - 无 credits 时 cost=null，token 仍记录', async () => {
  const root = join(tmpdir(), `lumencode-cb-nocost-${process.pid}-${Date.now()}`);
  const chatDir = join(root, 'projects', 'p', 'chats', '2026-07-04T12-34-56Z');
  mkdirSync(chatDir, { recursive: true });
  writeFileSync(join(chatDir, 'chat-messages.json'), JSON.stringify([
    { role: 'assistant', metadata: { model: 'gpt-5', usage: { inputTokens: 7, outputTokens: 3 } } },
  ]));
  try {
    const records = await new CodebuffParser().parse({ codebuffDir: root });
    assert.equal(records.length, 1);
    assert.equal(records[0].costUSD, null, '无 credits → null（交由 pricing 按 model+token 算）');
    assert.equal(records[0].inputTokens, 7);
    assert.equal(records[0].model, 'gpt-5');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CodebuffParser - 仅 totalTokens 兜底全计 output', async () => {
  const root = join(tmpdir(), `lumencode-cb-total-${process.pid}-${Date.now()}`);
  const chatDir = join(root, 'projects', 'p', 'chats', '2026-07-04T12-34-56Z');
  mkdirSync(chatDir, { recursive: true });
  writeFileSync(join(chatDir, 'chat-messages.json'), JSON.stringify([
    { role: 'assistant', credits: 2, metadata: { usage: { totalTokens: 789 } } },
  ]));
  try {
    const records = await new CodebuffParser().parse({ codebuffDir: root });
    assert.equal(records.length, 1);
    assert.equal(records[0].outputTokens, 789, 'totalTokens 兜底');
    assert.equal(records[0].costUSD, 0.02, '2 credits × $0.01');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CodebuffParser - config 多目录（逗号分隔，模拟 manicode + manicode-dev 通道）', async () => {
  const root1 = join(tmpdir(), `lumencode-cb1-${process.pid}-${Date.now()}-${Math.random()}`);
  const root2 = join(tmpdir(), `lumencode-cb2-${process.pid}-${Date.now()}-${Math.random()}`);
  const chat1 = join(root1, 'projects', 'p1', 'chats', '2026-07-04T10-00-00Z');
  const chat2 = join(root2, 'projects', 'p2', 'chats', '2026-07-04T11-00-00Z');
  mkdirSync(chat1, { recursive: true });
  mkdirSync(chat2, { recursive: true });
  writeFileSync(join(chat1, 'chat-messages.json'), JSON.stringify([{ credits: 3, metadata: { usage: { inputTokens: 1 } } }]));
  writeFileSync(join(chat2, 'chat-messages.json'), JSON.stringify([{ credits: 7, metadata: { usage: { inputTokens: 2 } } }]));
  try {
    const records = await new CodebuffParser().parse({ codebuffDir: `${root1},${root2}` });
    assert.equal(records.length, 2, '两目录各收 1 条');
    const credits = records.map(r => r.metadata.credits).sort();
    assert.deepEqual(credits, [3, 7]);
  } finally { rmSync(root1, { recursive: true, force: true }); rmSync(root2, { recursive: true, force: true }); }
});
