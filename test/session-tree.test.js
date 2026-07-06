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

const PARENT_TOK = { input: 300_000, output: 100_000, cacheRead: 0, cacheCreate: 0 }; // 400K
const CHILD_TOK = { input: 500_000, output: 200_000, cacheRead: 0, cacheCreate: 0 };   // 700K

// ── groupBySessions：建会话树 ──

test('groupBySessions - 子 session 挂到父 children，父 totalTokens = 树总', () => {
  const sessions = groupBySessions([
    rec('parent', PARENT_TOK),
    rec('child', CHILD_TOK, { parentSessionId: 'parent', isSubagent: true }),
  ]);
  assert.equal(sessions.length, 1, '顶层只返回根');
  assert.equal(sessions[0].id, 'parent');
  assert.equal(sessions[0].parentSessionId, '');
  // 父 totalTokens = 400K + 700K = 1.1M（树总，超阈值 → heavy）
  assert.equal(sessions[0].totalTokens, 1_100_000);
  assert.equal(sessions[0].isHeavy, true);
  // children 含子摘要
  assert.equal(sessions[0].children.length, 1);
  assert.equal(sessions[0].children[0].id, 'child');
  assert.equal(sessions[0].children[0].totalTokens, 700_000);
});

test('groupBySessions - 子单独 heavy 时 children 带 isHeavy', () => {
  const sessions = groupBySessions([
    rec('parent', { input: 100, output: 50, cacheRead: 0, cacheCreate: 0 }),
    rec('child', { input: 600_000, output: 500_000, cacheRead: 0, cacheCreate: 0 }, { parentSessionId: 'parent', isSubagent: true }),
  ]);
  assert.equal(sessions.length, 1);
  const child = sessions[0].children[0];
  assert.equal(child.totalTokens, 1_100_000);
  assert.equal(child.isHeavy, true);
});

test('groupBySessions - 孤儿子（父不在集）保留顶层当根', () => {
  const sessions = groupBySessions([
    rec('orphan', CHILD_TOK, { parentSessionId: 'missing-parent', isSubagent: true }),
  ]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'orphan');
  assert.equal(sessions[0].parentSessionId, 'missing-parent');
  assert.equal(sessions[0].children.length, 0);
});

test('groupBySessions - 无 parentSessionId 的 record 行为不变', () => {
  const sessions = groupBySessions([
    rec('s1', { input: 100, output: 50, cacheRead: 0, cacheCreate: 0 }),
    rec('s2', { input: 100, output: 50, cacheRead: 0, cacheCreate: 0 }),
  ]);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].children.length, 0);
  assert.equal(sessions[0].totalTokens, 150);
});

// ── computeUsageStats：heavySessionCount 按树总 ──

test('computeUsageStats - 子 token 累到父，heavySessionCount 按树总', () => {
  const records = [
    rec('parent', PARENT_TOK),
    rec('child', CHILD_TOK, { parentSessionId: 'parent', isSubagent: true }),
  ];
  const stats = computeUsageStats(records, []);
  // 父树总 1.1M > 1M → heavySessionCount = 1
  assert.equal(stats.heavySessionCount, 1);
});

test('computeUsageStats - 无 parentSessionId 时行为不变', () => {
  const stats = computeUsageStats([
    rec('s1', { input: 100, output: 50, cacheRead: 0, cacheCreate: 0 }),
    rec('s2', { input: 100, output: 50, cacheRead: 0, cacheCreate: 0 }),
  ], []);
  assert.equal(stats.heavySessionCount, 0);
});

test('groupBySessions - 循环引用 A→B→A 不返回空、不互相污染 token', () => {
  const sessions = groupBySessions([
    rec('A', { input: 100, output: 50, cacheRead: 0, cacheCreate: 0 }, { parentSessionId: 'B' }),
    rec('B', { input: 100, output: 50, cacheRead: 0, cacheCreate: 0 }, { parentSessionId: 'A' }),
  ]);
  // 两节点 parent 均非根 → 都不挂，都保留顶层，各自 totalTokens 不被对方累加
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].totalTokens, 150);
  assert.equal(sessions[0].children.length, 0);
});
