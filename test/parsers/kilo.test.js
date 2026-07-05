// test/parsers/kilo.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KiloParser } from '../../lib/parsers/kilo.js';

const uniq = s => join(tmpdir(), `lumencode-kilo-${s}-${process.pid}-${Date.now()}-${Math.random()}`);

async function makeKiloDb(root, rows) {
  mkdirSync(root, { recursive: true });
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)');
  for (const r of rows) {
    db.run('INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)', [r.id, r.sessionId, r.data]);
  }
  writeFileSync(join(root, 'kilo.db'), Buffer.from(db.export()));
  db.close();
}

test('KiloParser - 解析 kilo.db message 表（全 token 字段 + cache + cost）', async () => {
  const root = uniq('full');
  await makeKiloDb(root, [{
    id: 'row-1', sessionId: 'session-a',
    data: JSON.stringify({
      id: 'msg-1', role: 'assistant', providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514',
      time: { created: 1767312000000 },
      tokens: { input: 100, output: 50, reasoning: 5, cache: { read: 10, write: 20 } },
      cost: 0.02,
    }),
  }]);
  try {
    const p = new KiloParser();
    assert.equal(await p.detect({ kiloDir: root }), true);
    const records = await p.parse({ kiloDir: root });
    assert.equal(records.length, 1);
    assert.equal(records[0].model, 'claude-sonnet-4-20250514');
    assert.equal(records[0].inputTokens, 100);
    assert.equal(records[0].outputTokens, 50);
    assert.equal(records[0].cacheReadTokens, 10);
    assert.equal(records[0].cacheWriteTokens, 20);
    assert.equal(records[0].metadata.reasoningTokens, 5);
    assert.equal(records[0].metadata.provider, 'anthropic');
    assert.equal(records[0].costUSD, 0.02);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('KiloParser - totalTokens fallback（input/output 全 0 → output）', async () => {
  const root = uniq('total');
  await makeKiloDb(root, [{
    id: 'row-2', sessionId: 'session-b',
    data: JSON.stringify({ role: 'assistant', modelID: 'gpt-5', time: { created: 1767312000000 }, tokens: { total: 234 } }),
  }]);
  try {
    const records = await new KiloParser().parse({ kiloDir: root });
    assert.equal(records.length, 1);
    assert.equal(records[0].outputTokens, 234);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('KiloParser - cache 非 object 不崩（cache:0）', async () => {
  const root = uniq('cache-num');
  await makeKiloDb(root, [{
    id: 'row-3', sessionId: 'session-c',
    data: JSON.stringify({ role: 'assistant', modelID: 'gpt-5', time: { created: 1767312000000 }, tokens: { input: 100, output: 10, cache: 0 } }),
  }]);
  try {
    const records = await new KiloParser().parse({ kiloDir: root });
    assert.equal(records.length, 1);
    assert.equal(records[0].inputTokens, 100);
    assert.equal(records[0].cacheReadTokens, 0, 'cache 非 object → 0');
    assert.equal(records[0].cacheWriteTokens, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
