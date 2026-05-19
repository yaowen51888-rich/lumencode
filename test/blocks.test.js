import { test } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { identifyBillingBlocks } from '../lib/blocks.js';

function makeRecord(timestamp, overrides = {}) {
  return {
    type: 'assistant',
    timestamp,
    model: 'claude-sonnet-4-6',
    tokens: { input: 100, output: 50, cacheRead: 0, cacheCreate: 0 },
    sessionId: 's1',
    costUSD: null,
    speed: 'standard',
    ...overrides,
  };
}

test('identifyBillingBlocks - empty records', () => {
  const blocks = identifyBillingBlocks([]);
  deepStrictEqual(blocks, []);
});

test('identifyBillingBlocks - single block', () => {
  const records = [
    makeRecord('2024-01-01T10:00:00Z'),
    makeRecord('2024-01-01T10:30:00Z'),
    makeRecord('2024-01-01T11:00:00Z'),
  ];
  const blocks = identifyBillingBlocks(records);
  strictEqual(blocks.length, 1);
  strictEqual(blocks[0].requests, 3);
  strictEqual(blocks[0].startTime, new Date(Math.floor(new Date('2024-01-01T10:00:00Z').getTime() / 3600000) * 3600000).toISOString());
});

test('identifyBillingBlocks - gap creates new block', () => {
  const records = [
    makeRecord('2024-01-01T10:00:00Z'),
    makeRecord('2024-01-01T16:00:00Z'),  // 6 hours later, exceeds 5h window
  ];
  const blocks = identifyBillingBlocks(records);
  strictEqual(blocks.length, 2);
  strictEqual(blocks[0].requests, 1);
  strictEqual(blocks[1].requests, 1);
});

test('identifyBillingBlocks - hour flooring', () => {
  const records = [
    makeRecord('2024-01-01T10:45:00Z'),  // Should floor to 10:00
  ];
  const blocks = identifyBillingBlocks(records);
  strictEqual(blocks.length, 1);
  const start = blocks[0].startTime;
  // Verify hour is 10:00
  strictEqual(new Date(start).getUTCHours(), 10);
  strictEqual(new Date(start).getUTCMinutes(), 0);
});

test('identifyBillingBlocks - token aggregation', () => {
  const records = [
    makeRecord('2024-01-01T10:00:00Z', { tokens: { input: 100, output: 50, cacheRead: 10, cacheCreate: 5 } }),
    makeRecord('2024-01-01T10:30:00Z', { tokens: { input: 200, output: 100, cacheRead: 20, cacheCreate: 10 } }),
  ];
  const blocks = identifyBillingBlocks(records);
  strictEqual(blocks.length, 1);
  deepStrictEqual(blocks[0].tokenCounts, { inputTokens: 300, outputTokens: 150, cacheRead: 30, cacheCreate: 15 });
  strictEqual(blocks[0].totalTokens, 495);
});

test('identifyBillingBlocks - user records are filtered out', () => {
  const records = [
    makeRecord('2024-01-01T10:00:00Z'),
    { ...makeRecord('2024-01-01T10:15:00Z'), type: 'user' },
    makeRecord('2024-01-01T10:30:00Z'),
  ];
  const blocks = identifyBillingBlocks(records);
  strictEqual(blocks.length, 1);
  strictEqual(blocks[0].requests, 2);  // only assistant records
});

test('identifyBillingBlocks - isActive flag', () => {
  const records = [
    makeRecord(new Date().toISOString()),  // current time
  ];
  const blocks = identifyBillingBlocks(records);
  strictEqual(blocks.length, 1);
  strictEqual(blocks[0].isActive, true);
});
