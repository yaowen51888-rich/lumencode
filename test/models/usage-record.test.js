import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageRecord, validateUsageRecord } from '../../lib/models/usage-record.js';

test('validateUsageRecord - 接受任意已注册工具名', () => {
  for (const tool of ['claude', 'gemini', 'qwen', 'kimi', 'droid', 'custom-xyz']) {
    const r = createUsageRecord({ timestamp: '2026-07-04T00:00:00Z', tool, sessionId: 's1' });
    assert.equal(validateUsageRecord(r), true);
  }
});

test('validateUsageRecord - 缺必填字段抛错', () => {
  assert.throws(() => validateUsageRecord(createUsageRecord({ tool: '', sessionId: 's1' })));
  assert.throws(() => validateUsageRecord(createUsageRecord({ tool: 'gemini', sessionId: '' })));
});
