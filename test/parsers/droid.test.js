// test/parsers/droid.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DroidParser } from '../../lib/parsers/droid.js';

const uniq = s => join(tmpdir(), `lumencode-droid-${s}-${process.pid}-${Date.now()}-${Math.random()}`);

test('DroidParser - 解析 *.settings.json（model 归一化 + 全 token 字段）', async () => {
  const root = uniq('settings');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'session-a.settings.json'), JSON.stringify({
    model: 'Claude-Sonnet-4-[Anthropic]',
    providerLock: 'anthropic',
    providerLockTimestamp: '2026-05-01T01:02:03.000Z',
    tokenUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 20, cacheReadTokens: 10, thinkingTokens: 5 },
  }));
  try {
    const p = new DroidParser();
    assert.equal(await p.detect({ droidDir: root }), true);
    const records = await p.parse({ droidDir: root });
    assert.equal(records.length, 1);
    assert.equal(records[0].sessionId, 'session-a');
    assert.equal(records[0].model, 'claude-sonnet-4', 'model 归一化（去 [Anthropic] + 小写）');
    assert.equal(records[0].inputTokens, 100);
    assert.equal(records[0].outputTokens, 50);
    assert.equal(records[0].cacheWriteTokens, 20);
    assert.equal(records[0].cacheReadTokens, 10);
    assert.equal(records[0].metadata.reasoningTokens, 5);
    assert.equal(records[0].timestamp, '2026-05-01T01:02:03.000Z');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('DroidParser - totalTokens fallback（input/output 全 0 → output）', async () => {
  const root = uniq('total');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'session-b.settings.json'), JSON.stringify({
    model: 'gpt-5', providerLock: 'openai',
    providerLockTimestamp: '2026-05-02T00:00:00.000Z',
    tokenUsage: { totalTokens: 456 },
  }));
  try {
    const records = await new DroidParser().parse({ droidDir: root });
    assert.equal(records.length, 1);
    assert.equal(records[0].outputTokens, 456);
    assert.equal(records[0].metadata.reasoningTokens, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('DroidParser - sidecar <sessionId>.jsonl 提取 model', async () => {
  const root = uniq('sidecar');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'session-c.settings.json'), JSON.stringify({
    providerLock: 'anthropic',
    providerLockTimestamp: '2026-05-02T01:02:03.000Z',
    tokenUsage: { inputTokens: 10, outputTokens: 20 },
  }));
  writeFileSync(join(root, 'session-c.jsonl'), JSON.stringify({ content: 'Model: Claude Opus 4.5 Thinking [Anthropic]' }));
  try {
    const records = await new DroidParser().parse({ droidDir: root });
    assert.equal(records.length, 1);
    assert.equal(records[0].model, 'claude-opus-4-5-thinking', 'sidecar Model: 行提取 + 归一化');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('DroidParser - 同 session 多快照取最新 timestamp', async () => {
  const root = uniq('dedup');
  const archiveDir = join(root, 'archive');
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(join(archiveDir, 'session-d.settings.json'), JSON.stringify({
    model: 'gpt-5', providerLock: 'openai',
    providerLockTimestamp: '2026-05-01T01:02:03.000Z',
    tokenUsage: { inputTokens: 10, outputTokens: 20 },
  }));
  writeFileSync(join(root, 'session-d.settings.json'), JSON.stringify({
    model: 'gpt-5', providerLock: 'openai',
    providerLockTimestamp: '2026-05-02T01:02:03.000Z',
    tokenUsage: { inputTokens: 100, outputTokens: 200 },
  }));
  try {
    const records = await new DroidParser().parse({ droidDir: root });
    assert.equal(records.length, 1, '同 session_id 去重');
    assert.equal(records[0].inputTokens, 100, '取最新快照');
    assert.equal(records[0].outputTokens, 200);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
