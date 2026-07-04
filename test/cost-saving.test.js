import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCostBreakdownFromRecords,
  computeCostFromRecords,
  computeUsageStats,
} from '../lib/aggregate.js';
import { resolveModelPricing } from '../lib/pricing-loader.js';

const MODEL = 'claude-sonnet-4-6';

// 构造一条 assistant record（tokens 单位：个）
function rec(tokens, extra = {}) {
  return {
    timestamp: extra.timestamp || '2026-07-04T10:00:00Z',
    type: 'assistant',
    model: MODEL,
    tool: 'claude',
    tokens,
    toolCalls: [],
    metadata: { type: 'assistant' },
    ...extra,
  };
}

// ── computeCostBreakdownFromRecords：精确 cacheSaving ──

test('computeCostBreakdownFromRecords - cacheSaving = cacheRead×(inputRate−cacheReadRate)/1e6', () => {
  const pricing = resolveModelPricing(MODEL);
  assert.ok(!pricing.unknown, `${MODEL} 应有定价`);
  const cacheRead = 500_000;
  const { cost, cacheSaving } = computeCostBreakdownFromRecords(
    [rec({ input: 100, output: 50, cacheRead, cacheCreate: 0 })],
    'calculate'
  );
  assert.ok(cost > 0, 'cost 应大于 0');
  const expected = (cacheRead / 1e6) * (pricing.input - pricing.cacheRead);
  assert.ok(
    Math.abs(cacheSaving - expected) < 0.001,
    `cacheSaving ${cacheSaving} 应 ≈ ${expected}`
  );
});

test('computeCostBreakdownFromRecords - 无 cacheRead 时 cacheSaving=0', () => {
  const { cost, cacheSaving } = computeCostBreakdownFromRecords(
    [rec({ input: 1000, output: 500, cacheRead: 0, cacheCreate: 0 })],
    'calculate'
  );
  assert.ok(cost > 0);
  assert.equal(cacheSaving, 0);
});

test('computeCostBreakdownFromRecords - 多 record 累加 cacheSaving', () => {
  const pricing = resolveModelPricing(MODEL);
  const r1 = rec({ input: 100, output: 50, cacheRead: 300_000, cacheCreate: 0 }, { timestamp: '2026-07-04T10:00:00Z' });
  const r2 = rec({ input: 100, output: 50, cacheRead: 200_000, cacheCreate: 0 }, { timestamp: '2026-07-04T11:00:00Z' });
  const { cacheSaving } = computeCostBreakdownFromRecords([r1, r2], 'calculate');
  const expected = ((300_000 + 200_000) / 1e6) * (pricing.input - pricing.cacheRead);
  assert.ok(Math.abs(cacheSaving - expected) < 0.001);
});

// ── computeCostFromRecords：回归不破坏（仍返回 number）──

test('computeCostFromRecords - 返回 number（签名回归）', () => {
  const v = computeCostFromRecords(
    [rec({ input: 1000, output: 500, cacheRead: 100_000, cacheCreate: 0 })],
    'calculate'
  );
  assert.equal(typeof v, 'number');
  assert.ok(v > 0);
  // 与 breakdown.cost 一致
  const { cost } = computeCostBreakdownFromRecords(
    [rec({ input: 1000, output: 500, cacheRead: 100_000, cacheCreate: 0 })],
    'calculate'
  );
  assert.equal(v, cost);
});

// ── computeUsageStats：stats.cacheSaving 产出 ──

test('computeUsageStats - stats.cacheSaving 产出且非负', () => {
  const records = [
    rec({ input: 100, output: 50, cacheRead: 400_000, cacheCreate: 0 }),
  ];
  const stats = computeUsageStats(records, [], 'calculate');
  assert.equal(typeof stats.cacheSaving, 'number');
  assert.ok(stats.cacheSaving > 0, '有 cacheRead 时 cacheSaving 应 > 0');
  assert.equal(typeof stats.estimatedCost, 'number');
});
