// test/parsers/copilot.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CopilotParser } from '../../lib/parsers/copilot.js';

const uniq = s => join(tmpdir(), `lumencode-copilot-${s}-${process.pid}-${Date.now()}-${Math.random()}`);

test('CopilotParser - OTel attributes gen_ai.usage.* 提取 + cached 重叠修正', async () => {
  const root = uniq('basic');
  const otelDir = join(root, 'otel');
  mkdirSync(otelDir, { recursive: true });
  writeFileSync(join(otelDir, 'trace.jsonl'), JSON.stringify({
    traceId: 't1', spanId: 's1', endTime: [1767312000, 0],
    attributes: {
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 50,
      'gen_ai.usage.cache_read.input_tokens': 10,
      'gen_ai.response.model': 'gpt-5',
      'gen_ai.conversation.id': 'conv-1',
    },
  }));
  try {
    const p = new CopilotParser();
    assert.equal(await p.detect({ copilotDir: otelDir }), true);
    const records = await p.parse({ copilotDir: otelDir });
    assert.equal(records.length, 1);
    assert.equal(records[0].inputTokens, 90, 'input 100 - cacheRead 10 重叠 = 90');
    assert.equal(records[0].outputTokens, 50);
    assert.equal(records[0].cacheReadTokens, 10);
    assert.equal(records[0].model, 'gpt-5');
    assert.equal(records[0].sessionId, 'conv-1', 'gen_ai.conversation.id 优先');
    assert.equal(records[0].timestamp, new Date(1767312000 * 1000).toISOString(), 'endTime [sec,nanos]');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CopilotParser - 同 traceId:spanId 去重', async () => {
  const root = uniq('dedup');
  const otelDir = join(root, 'otel');
  mkdirSync(otelDir, { recursive: true });
  const lines = [
    JSON.stringify({ traceId: 't2', spanId: 's2', endTime: [1767312000, 0], attributes: { 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 50, 'gen_ai.response.model': 'gpt-5' } }),
    JSON.stringify({ traceId: 't2', spanId: 's2', endTime: [1767312001, 0], attributes: { 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 50, 'gen_ai.response.model': 'gpt-5' } }), // 同 trace:span 去重
    JSON.stringify({ traceId: 't3', spanId: 's3', endTime: [1767312002, 0], attributes: { 'gen_ai.usage.input_tokens': 30, 'gen_ai.usage.output_tokens': 20, 'gen_ai.response.model': 'gpt-5' } }),
  ];
  writeFileSync(join(otelDir, 'trace.jsonl'), lines.join('\n'));
  try {
    const records = await new CopilotParser().parse({ copilotDir: otelDir });
    assert.equal(records.length, 2, '同 traceId:spanId 去重，剩 2 条');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
