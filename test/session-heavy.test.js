import test from 'node:test';
import assert from 'node:assert/strict';
import { groupBySessions, computeUsageStats } from '../lib/aggregate.js';

// 构造一条 assistant record（tokens 单位：个）
function rec(sessionId, tokens, extra = {}) {
  return {
    sessionId,
    timestamp: extra.timestamp || '2026-07-04T10:00:00Z',
    type: 'assistant',
    model: 'claude-sonnet-4-6',
    tool: 'claude',
    tokens,
    toolCalls: [],
    metadata: { type: 'assistant' },
    ...extra,
  };
}

const HEAVY = { input: 600_000, output: 500_000, cacheRead: 0, cacheCreate: 0 }; // 1.1M
const WARN = { input: 400_000, output: 200_000, cacheRead: 0, cacheCreate: 0 };  // 600K
const NORMAL = { input: 100, output: 50, cacheRead: 0, cacheCreate: 0 };          // 150

// ── groupBySessions：totalTokens / isHeavy / isWarn ──

test('groupBySessions - 标记 isHeavy 当 totalTokens > 1M', () => {
  const sessions = groupBySessions([
    rec('s-heavy', HEAVY),
    rec('s-warn', WARN),
    rec('s-normal', NORMAL),
  ]);
  const byId = Object.fromEntries(sessions.map(s => [s.id, s]));

  assert.equal(byId['s-heavy'].totalTokens, 1_100_000);
  assert.equal(byId['s-heavy'].isHeavy, true);
  assert.equal(byId['s-heavy'].isWarn, false);

  assert.equal(byId['s-warn'].totalTokens, 600_000);
  assert.equal(byId['s-warn'].isHeavy, false);
  assert.equal(byId['s-warn'].isWarn, true);

  assert.equal(byId['s-normal'].totalTokens, 150);
  assert.equal(byId['s-normal'].isHeavy, false);
  assert.equal(byId['s-normal'].isWarn, false);
});

test('groupBySessions - cacheRead/cacheCreate 累入 totalTokens', () => {
  const sessions = groupBySessions([
    rec('s-cache', { input: 100, output: 50, cacheRead: 700_000, cacheCreate: 400_000 }),
  ]);
  // 100 + 50 + 700000 + 400000 = 1,100,150 > 1M
  assert.equal(sessions[0].totalTokens, 1_100_150);
  assert.equal(sessions[0].isHeavy, true);
  assert.equal(sessions[0].cacheRead, 700_000);
  assert.equal(sessions[0].cacheCreate, 400_000);
});

test('groupBySessions - 同会话多 record 累加触发 heavy', () => {
  const sessions = groupBySessions([
    rec('s-multi', { input: 400_000, output: 100_000, cacheRead: 0, cacheCreate: 0 }, { timestamp: '2026-07-04T10:00:00Z' }),
    rec('s-multi', { input: 400_000, output: 200_000, cacheRead: 0, cacheCreate: 0 }, { timestamp: '2026-07-04T11:00:00Z' }),
  ]);
  // 两次合计 1,100,000
  assert.equal(sessions[0].totalTokens, 1_100_000);
  assert.equal(sessions[0].isHeavy, true);
});

// ── computeUsageStats：heavySessionCount / warnSessionCount ──

test('computeUsageStats - 统计 heavy/warn 会话数', () => {
  const records = [
    rec('s-heavy', HEAVY),
    rec('s-warn', WARN),
    rec('s-normal', NORMAL),
  ];
  const stats = computeUsageStats(records, []);
  assert.equal(stats.heavySessionCount, 1);
  assert.equal(stats.warnSessionCount, 1);
});

test('computeUsageStats - 无超阈值会话时计数为 0', () => {
  const stats = computeUsageStats([
    rec('s1', NORMAL),
    rec('s2', NORMAL),
  ], []);
  assert.equal(stats.heavySessionCount, 0);
  assert.equal(stats.warnSessionCount, 0);
});
