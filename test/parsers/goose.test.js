import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GooseParser } from '../../lib/parsers/goose.js';

async function makeDb(root, { withAccumulated = true } = {}) {
  const sessionsDir = join(root, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  // schema 对齐参考 ccusage (goose/loader.rs)：表 sessions，model 从 model_config_json 解析
  db.run(`CREATE TABLE sessions(id TEXT, model_config_json TEXT, provider_name TEXT, created_at TEXT, total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER, accumulated_total_tokens INTEGER, accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER)`);
  if (withAccumulated) {
    // accumulated_* 列有值 → 优先使用
    db.run(`INSERT INTO sessions(id, model_config_json, provider_name, created_at, accumulated_total_tokens, accumulated_input_tokens, accumulated_output_tokens) VALUES('20260704_1','{"modelName":"claude-sonnet-4-20250514"}','anthropic','2026-07-04 10:00:00',1400,1000,400)`);
  } else {
    // 无 accumulated → 回退到 input_tokens/output_tokens/total_tokens
    db.run(`INSERT INTO sessions(id, model_config_json, provider_name, created_at, total_tokens, input_tokens, output_tokens) VALUES('20260704_2','{"modelName":"gpt-5"}','openai','2026-07-04 11:00:00',300,200,100)`);
  }
  writeFileSync(join(sessionsDir, 'sessions.db'), Buffer.from(db.export()));
  db.close();
}

test('GooseParser - 解析 sessions.db（accumulated 列优先 + model_config_json 解析）', async () => {
  const root = join(tmpdir(), `lumencode-goose-${process.pid}-${Date.now()}-${Math.random()}`);
  await makeDb(root, { withAccumulated: true });
  try {
    const p = new GooseParser();
    assert.equal(await p.detect({ gooseDir: root }), true);
    const records = await p.parse({ gooseDir: root });
    assert.equal(records.length, 1);
    assert.equal(records[0].tool, 'goose');
    assert.equal(records[0].sessionId, '20260704_1');
    assert.equal(records[0].model, 'claude-sonnet-4-20250514', 'model 从 model_config_json.modelName 解析');
    assert.equal(records[0].inputTokens, 1000, 'accumulated_input_tokens 优先');
    assert.equal(records[0].outputTokens, 400, 'accumulated_output_tokens 优先');
    assert.equal(records[0].metadata.totalTokens, 1400);
    assert.equal(records[0].metadata.provider, 'anthropic');
    assert.equal(records[0].timestamp, '2026-07-04T10:00:00.000Z', '"YYYY-MM-DD HH:MM:SS" → ISO');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GooseParser - 无 accumulated 列时回退普通 token 列 + reasoning 计算', async () => {
  const root = join(tmpdir(), `lumencode-goose2-${process.pid}-${Date.now()}-${Math.random()}`);
  await makeDb(root, { withAccumulated: false });
  try {
    const records = await new GooseParser().parse({ gooseDir: root });
    assert.equal(records.length, 1);
    assert.equal(records[0].sessionId, '20260704_2');
    assert.equal(records[0].model, 'gpt-5');
    assert.equal(records[0].inputTokens, 200, '回退 input_tokens');
    assert.equal(records[0].outputTokens, 100, '回退 output_tokens');
    assert.equal(records[0].metadata.totalTokens, 300);
    assert.equal(records[0].metadata.reasoningTokens, 0, '300-200-100=0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
