// test/parsers/codebuff.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CodebuffParser } from '../../lib/parsers/codebuff.js';

test('CodebuffParser - credits 转 costUSD，无 token（降级）', async () => {
  const root = join(tmpdir(), `lumencode-codebuff-${process.pid}-${Date.now()}`);
  const chatDir = join(root, 'projects', 'myapp', 'chats', '2026-07-04T12-34-56Z');
  mkdirSync(chatDir, { recursive: true });
  writeFileSync(join(chatDir, 'run-state.json'), JSON.stringify({ cwd: '/home/u/myapp' }));
  writeFileSync(join(chatDir, 'chat-messages.json'), JSON.stringify([
    { role: 'assistant', message: { credits: 5 } },
    { role: 'assistant', message: { credits: 0 } }, // 跳过
  ]));
  try {
    const p = new CodebuffParser();
    assert.equal(await p.detect({ codebuffDir: root }), true);
    const records = await p.parse({ codebuffDir: root });
    assert.equal(records.length, 1);
    assert.equal(records[0].tool, 'codebuff');
    assert.equal(records[0].costUSD, 0.05, '5 credits × $0.01');
    assert.equal(records[0].inputTokens, 0);
    assert.equal(records[0].outputTokens, 0);
    assert.equal(records[0].project, '/home/u/myapp');
    assert.equal(records[0].metadata.degraded, 'codebuff-credits-only');
    assert.equal(records[0].metadata.credits, 5);
    assert.equal(records[0].timestamp, '2026-07-04T12:34:56Z', 'chatId 时间分隔符还原为 ISO');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CodebuffParser - config 多目录（逗号分隔，模拟 manicode + manicode-dev 通道）', async () => {
  const root1 = join(tmpdir(), `lumencode-cb1-${process.pid}-${Date.now()}-${Math.random()}`);
  const root2 = join(tmpdir(), `lumencode-cb2-${process.pid}-${Date.now()}-${Math.random()}`);
  const chat1 = join(root1, 'projects', 'p1', 'chats', '2026-07-04T10-00-00Z');
  const chat2 = join(root2, 'projects', 'p2', 'chats', '2026-07-04T11-00-00Z');
  mkdirSync(chat1, { recursive: true });
  mkdirSync(chat2, { recursive: true });
  writeFileSync(join(chat1, 'chat-messages.json'), JSON.stringify([{ credits: 3 }]));
  writeFileSync(join(chat2, 'chat-messages.json'), JSON.stringify([{ credits: 7 }]));
  try {
    const records = await new CodebuffParser().parse({ codebuffDir: `${root1},${root2}` });
    assert.equal(records.length, 2, '两目录各收 1 条');
    const credits = records.map(r => r.metadata.credits).sort();
    assert.deepEqual(credits, [3, 7]);
  } finally { rmSync(root1, { recursive: true, force: true }); rmSync(root2, { recursive: true, force: true }); }
});
