import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KimiParser } from '../../lib/parsers/kimi.js';

// 构造 wire.jsonl 的 StatusUpdate 行（token_usage 单次调用值，非累积）
function status(ts, usage, messageId) {
  return JSON.stringify({
    timestamp: ts,
    message: { type: 'StatusUpdate', payload: { token_usage: usage, message_id: messageId } },
  });
}

test('KimiParser - wire.jsonl 的 token_usage 完整拆分 input/output/cache', async () => {
  const root = join(tmpdir(), `lumencode-kimi-${process.pid}-${Date.now()}`);
  const sidDir = join(root, 'sessions', 'workhash1', 'ksess1');
  mkdirSync(sidDir, { recursive: true });
  const lines = [
    status(1777594407.38, { input_other: 312, output: 197, input_cache_read: 7424, input_cache_creation: 0 }, 'm1'),
    status(1777594418.43, { input_other: 20836, output: 233, input_cache_read: 7680, input_cache_creation: 5 }, 'm2'),
    status(1777594461.18, { input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0 }, 'm3'), // 全 0 跳过
  ].join('\n');
  writeFileSync(join(sidDir, 'wire.jsonl'), lines);
  try {
    const p = new KimiParser();
    assert.equal(await p.detect({ kimiDir: root }), true);
    const records = await p.parse({ kimiDir: root });
    assert.equal(records.length, 2, '全 0 行跳过，剩 2 条');
    assert.equal(records[0].tool, 'kimi');
    assert.equal(records[0].sessionId, 'ksess1');
    assert.equal(records[0].model, 'kimi-for-coding');
    assert.equal(records[0].inputTokens, 312, 'input_other → input');
    assert.equal(records[0].outputTokens, 197);
    assert.equal(records[0].cacheReadTokens, 7424);
    assert.equal(records[0].cacheWriteTokens, 0);
    assert.equal(records[1].cacheWriteTokens, 5, 'cache_creation → cacheWrite');
    assert.equal(records[0].timestamp, new Date(1777594407.38 * 1000).toISOString(), 'epoch 秒 → ISO');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('KimiParser - 按 message_id 去重', async () => {
  const root = join(tmpdir(), `lumencode-kimi-dedup-${process.pid}-${Date.now()}`);
  const sidDir = join(root, 'sessions', 'h', 's1');
  mkdirSync(sidDir, { recursive: true });
  const dup = status(1777594407.0, { input_other: 100, output: 10 }, 'same-id');
  writeFileSync(join(sidDir, 'wire.jsonl'), [dup, dup, dup].join('\n'));
  try {
    const records = await new KimiParser().parse({ kimiDir: root });
    assert.equal(records.length, 1, '同 message_id 去重');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('KimiParser - 递归 subagents 子目录', async () => {
  const root = join(tmpdir(), `lumencode-kimi-sub-${process.pid}-${Date.now()}`);
  const subDir = join(root, 'sessions', 'h', 's1', 'subagents', 'a1');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, 'wire.jsonl'), status(1777594407.0, { input_other: 50, output: 5 }, 'sub-m1'));
  try {
    const records = await new KimiParser().parse({ kimiDir: root });
    assert.equal(records.length, 1, 'subagents/wire.jsonl 也被收集');
    assert.equal(records[0].sessionId, 's1', 'sessionId 取 sessions/<hash>/<sid> 段');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('KimiParser - 非 StatusUpdate 行忽略', async () => {
  const root = join(tmpdir(), `lumencode-kimi-skip-${process.pid}-${Date.now()}`);
  const sidDir = join(root, 'sessions', 'h', 's1');
  mkdirSync(sidDir, { recursive: true });
  writeFileSync(join(sidDir, 'wire.jsonl'), [
    JSON.stringify({ type: 'metadata', protocol_version: '1.1' }),
    JSON.stringify({ timestamp: 1, message: { type: 'TurnBegin' } }),
    JSON.stringify({ timestamp: 2, message: { type: 'ContentPart' } }),
    status(3.0, { input_other: 8, output: 2 }, 'only-valid'),
  ].join('\n'));
  try {
    const records = await new KimiParser().parse({ kimiDir: root });
    assert.equal(records.length, 1, '仅 StatusUpdate+token_usage 计');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
