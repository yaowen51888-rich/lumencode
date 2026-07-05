import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GeminiParser } from '../../lib/parsers/gemini.js';

function setupGeminiDir() {
  const root = join(tmpdir(), `lumencode-gemini-${process.pid}-${Date.now()}`);
  const chatsDir = join(root, 'tmp', 'projhash1', 'chats');
  mkdirSync(chatsDir, { recursive: true });
  const jsonl = [
    JSON.stringify({ sessionId: 'sess-a', timestamp: '2026-07-04T10:00:00Z', model: 'gemini-2.5-pro', tokens: { input: 100, output: 50, cached: 20 } }),
    JSON.stringify({ sessionId: 'sess-a', timestamp: '2026-07-04T10:01:00Z', model: 'gemini-2.5-pro', tokens: { input: 0, output: 0 } }), // 无 token，跳过
  ].join('\n');
  writeFileSync(join(chatsDir, 'sess-a.jsonl'), jsonl);
  return root;
}

test('GeminiParser - 解析 tmp/<hash>/chats/*.jsonl 的 token', async () => {
  const root = setupGeminiDir();
  try {
    const p = new GeminiParser();
    const config = { geminiDir: root };
    assert.equal(await p.detect(config), true);
    const records = await p.parse(config);
    assert.equal(records.length, 1, '只 1 条有 token 的记录');
    assert.equal(records[0].tool, 'gemini');
    assert.equal(records[0].sessionId, 'sess-a');
    assert.equal(records[0].model, 'gemini-2.5-pro');
    assert.equal(records[0].inputTokens, 100);
    assert.equal(records[0].outputTokens, 50);
    assert.equal(records[0].cacheReadTokens, 20);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GeminiParser - 兼容 usageMetadata 字段名', async () => {
  const root = join(tmpdir(), `lumencode-gemini2-${process.pid}-${Date.now()}`);
  const chatsDir = join(root, 'tmp', 'h2', 'chats');
  mkdirSync(chatsDir, { recursive: true });
  writeFileSync(join(chatsDir, 's2.jsonl'), JSON.stringify({
    sessionId: 's2', timestamp: '2026-07-04T11:00:00Z', model: 'gemini-2.5-flash',
    usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 80, cachedContentTokenCount: 10 },
  }));
  try {
    const records = await new GeminiParser().parse({ geminiDir: root });
    assert.equal(records.length, 1);
    assert.equal(records[0].inputTokens, 200);
    assert.equal(records[0].outputTokens, 80);
    assert.equal(records[0].cacheReadTokens, 10);
    assert.equal(records[0].metadata.degraded, 'gemini-usageMetadata');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GeminiParser - messages[type:gemini] 形态（.json 单文档）', async () => {
  const root = join(tmpdir(), `lumencode-gemini3-${process.pid}-${Date.now()}-${Math.random()}`);
  const chatsDir = join(root, 'tmp', 'h3', 'chats');
  mkdirSync(chatsDir, { recursive: true });
  writeFileSync(join(chatsDir, 's3.json'), JSON.stringify({
    sessionId: 's3',
    messages: [
      { type: 'gemini', model: 'gemini-3', tokens: { input: 300, output: 60, thoughts: 40, total: 400 } },
      { type: 'other', tokens: { input: 999 } }, // 非 gemini 类型跳过
    ],
  }));
  try {
    const records = await new GeminiParser().parse({ geminiDir: root });
    assert.equal(records.length, 1, '仅 type:gemini 的 message');
    assert.equal(records[0].inputTokens, 300);
    assert.equal(records[0].outputTokens, 60);
    assert.equal(records[0].metadata.reasoningTokens, 40, 'thoughts → reasoningTokens');
    assert.equal(records[0].metadata.totalTokens, 400);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GeminiParser - token 别名兼容（input_tokens/output_tokens snake）', async () => {
  const root = join(tmpdir(), `lumencode-gemini4-${process.pid}-${Date.now()}-${Math.random()}`);
  const chatsDir = join(root, 'tmp', 'h4', 'chats');
  mkdirSync(chatsDir, { recursive: true });
  writeFileSync(join(chatsDir, 's4.jsonl'), JSON.stringify({
    sessionId: 's4', timestamp: '2026-07-04T12:00:00Z', model: 'gemini-2.5-pro',
    input_tokens: 150, output_tokens: 30, cached_tokens: 15,
  }));
  try {
    const records = await new GeminiParser().parse({ geminiDir: root });
    assert.equal(records.length, 1);
    assert.equal(records[0].inputTokens, 150, 'input_tokens 别名');
    assert.equal(records[0].outputTokens, 30, 'output_tokens 别名');
    assert.equal(records[0].cacheReadTokens, 15, 'cached_tokens 别名');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
