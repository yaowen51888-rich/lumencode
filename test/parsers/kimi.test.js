import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KimiParser } from '../../lib/parsers/kimi.js';

test('KimiParser - 从 context.jsonl 的 _usage 记录算 delta（降级，全计 input）', async () => {
  const root = join(tmpdir(), `lumencode-kimi-${process.pid}-${Date.now()}`);
  const ctxDir = join(root, 'sessions', 'workhash1', 'ksess1');
  mkdirSync(ctxDir, { recursive: true });
  const lines = [
    JSON.stringify({ role: '_usage', token_count: 500 }),
    JSON.stringify({ role: '_usage', token_count: 800 }), // delta 300
    JSON.stringify({ role: '_usage', token_count: 800 }), // delta 0，跳过
  ].join('\n');
  writeFileSync(join(ctxDir, 'context.jsonl'), lines);
  try {
    const p = new KimiParser();
    assert.equal(await p.detect({ kimiDir: root }), true);
    const records = await p.parse({ kimiDir: root });
    assert.equal(records.length, 2, '2 条 delta>0 记录（500 + 300）');
    assert.equal(records[0].tool, 'kimi');
    assert.equal(records[0].sessionId, 'ksess1');
    assert.equal(records[0].inputTokens, 500, '首条 delta（0→500）');
    assert.equal(records[1].inputTokens, 300, '次条 delta（500→800）');
    assert.equal(records[0].outputTokens, 0, '无拆分');
    assert.equal(records[0].metadata.degraded, 'kimi-cumulative-only');
    assert.equal(records.reduce((s, r) => s + r.inputTokens, 0), 800, '总 token 正确');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('KimiParser - 读取 context_N.jsonl 分片（每分片独立 delta 基线）', async () => {
  const root = join(tmpdir(), `lumencode-kimi-shard-${process.pid}-${Date.now()}`);
  const ctxDir = join(root, 'sessions', 'workhash1', 'ksess1');
  mkdirSync(ctxDir, { recursive: true });
  // 当前分片
  writeFileSync(join(ctxDir, 'context.jsonl'), JSON.stringify({ role: '_usage', token_count: 500 }));
  // 旧分片（compaction 产生），token_count 独立计数：delta 200 + 100
  writeFileSync(join(ctxDir, 'context_1.jsonl'), [
    JSON.stringify({ role: '_usage', token_count: 200 }),
    JSON.stringify({ role: '_usage', token_count: 300 }),
  ].join('\n'));
  // wire.jsonl 无 token，应被忽略
  writeFileSync(join(ctxDir, 'wire.jsonl'), JSON.stringify({ type: 'metadata', protocol_version: '1.9' }));
  try {
    const p = new KimiParser();
    const records = await p.parse({ kimiDir: root });
    assert.equal(records.length, 3, 'context.jsonl 1 条 + context_1.jsonl 2 条');
    const sum = records.reduce((s, r) => s + r.inputTokens, 0);
    assert.equal(sum, 800, '500 + 200 + 100 = 800（跨分片累计）');
    assert.ok(records.every(r => r.metadata.shard), '每条记录标注 shard 来源');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
