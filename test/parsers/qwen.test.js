import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { QwenParser } from '../../lib/parsers/qwen.js';

test('QwenParser - 解析 projects/<proj>/chats/*.jsonl，tool=qwen', async () => {
  const root = join(tmpdir(), `lumencode-qwen-${process.pid}-${Date.now()}`);
  const chatsDir = join(root, 'projects', 'myapp', 'chats');
  mkdirSync(chatsDir, { recursive: true });
  writeFileSync(join(chatsDir, 'qs1.jsonl'), JSON.stringify({
    sessionId: 'qs1', timestamp: '2026-07-04T09:00:00Z', record: { model: 'qwen-max' },
    usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 120, cachedContentTokenCount: 30 },
  }));
  try {
    const p = new QwenParser();
    assert.equal(await p.detect({ qwenDir: root }), true);
    const records = await p.parse({ qwenDir: root });
    assert.equal(records.length, 1);
    assert.equal(records[0].tool, 'qwen');
    assert.equal(records[0].model, 'qwen-max');
    assert.equal(records[0].inputTokens, 300);
    assert.equal(records[0].outputTokens, 120);
    assert.equal(records[0].cacheReadTokens, 30);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
