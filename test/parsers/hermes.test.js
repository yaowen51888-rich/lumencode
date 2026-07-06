// test/parsers/hermes.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { HermesParser } from '../../lib/parsers/hermes.js';

const uniq = s => join(tmpdir(), `lumencode-hermes-${s}-${process.pid}-${Date.now()}-${Math.random()}`);

async function writeDb(root, createSql, insertSql) {
  mkdirSync(root, { recursive: true });
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(createSql);
  if (insertSql) db.run(insertSql);
  writeFileSync(join(root, 'state.db'), Buffer.from(db.export()));
  db.close();
}

test('HermesParser - 解析 state.db sessions 表（基础 token 列）', async () => {
  const root = uniq('base');
  await writeDb(root,
    `CREATE TABLE sessions(id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, started_at REAL, ended_at REAL)`,
    `INSERT INTO sessions VALUES('20260704_091523_a1b2','anthropic/claude-sonnet-4.6',800,300,100,40,20,1783159200,1783159800)`,
  );
  try {
    const p = new HermesParser();
    assert.equal(await p.detect({ hermesDir: root }), true);
    const records = await p.parse({ hermesDir: root });
    assert.equal(records.length, 1);
    assert.equal(records[0].sessionId, '20260704_091523_a1b2');
    assert.equal(records[0].model, 'anthropic/claude-sonnet-4.6');
    assert.equal(records[0].inputTokens, 800);
    assert.equal(records[0].outputTokens, 300);
    assert.equal(records[0].cacheReadTokens, 100);
    assert.equal(records[0].cacheWriteTokens, 40);
    assert.equal(records[0].metadata.reasoningTokens, 20);
    assert.equal(records[0].timestamp, '2026-07-04T10:00:00.000Z', 'started_at 秒 → ISO');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('HermesParser - 参考完整 schema（cost/provider/message_count，actual 优先）', async () => {
  const root = uniq('full');
  await writeDb(root,
    `CREATE TABLE sessions(id TEXT, source TEXT, model TEXT, started_at REAL, message_count INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, billing_provider TEXT, estimated_cost_usd REAL, actual_cost_usd REAL)`,
    `INSERT INTO sessions(id, source, model, started_at, message_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, billing_provider, estimated_cost_usd, actual_cost_usd) VALUES('s2','cli','claude-sonnet-4.6',1783159200,42,800,300,100,40,20,'anthropic',0.12,0.34)`,
  );
  try {
    const records = await new HermesParser().parse({ hermesDir: root });
    assert.equal(records.length, 1);
    assert.equal(records[0].costUSD, 0.34, 'actual_cost_usd 优先于 estimated');
    assert.equal(records[0].metadata.provider, 'anthropic');
    assert.equal(records[0].metadata.messageCount, 42);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('HermesParser - actual_cost 为 NULL 时回退 estimated_cost', async () => {
  const root = uniq('cost-fallback');
  await writeDb(root,
    `CREATE TABLE sessions(id TEXT, model TEXT, started_at REAL, input_tokens INTEGER, output_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL)`,
    `INSERT INTO sessions(id, model, started_at, input_tokens, output_tokens, estimated_cost_usd, actual_cost_usd) VALUES('s3','gpt-5',1783159200,100,50,0.5,NULL)`,
  );
  try {
    const records = await new HermesParser().parse({ hermesDir: root });
    assert.equal(records.length, 1);
    assert.equal(records[0].costUSD, 0.5, 'actual NULL → estimated');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
