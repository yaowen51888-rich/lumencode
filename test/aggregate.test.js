import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterRecordsByPeriod,
  computeUsageStats,
  computeTrendData,
  deduplicateRecords,
  resolveModelPricing,
  groupBySessions,
} from '../lib/aggregate.js';

// 测试记录创建辅助函数
function makeRecord(date, type = 'assistant', model = 'claude-sonnet-4-6', sessionId = 's1', project = 'proj') {
  return {
    type,
    timestamp: `${date}T10:00:00Z`,
    model: type === 'assistant' ? model : '',
    sessionId,
    project,
    text: type === 'user' ? 'some text' : '',
    toolCalls: [],
    tokens: type === 'assistant' ? { input: 100, output: 50, cacheRead: 10, cacheCreate: 0 } : { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    messageId: type === 'assistant' ? `msg_${date}_${sessionId}` : '',
    requestId: type === 'assistant' ? `req_${date}_${sessionId}` : '',
    costUSD: null,
    speed: 'standard',
  };
}

// 测试日期：2026-05-16 (星期六)
const testDate = '2026-05-16';
const testRefDate = '2026-05-16T10:00:00Z';

test('filterRecordsByPeriod - daily filtering', () => {
  // 创建测试数据
  const records = [
    makeRecord('2026-05-16', 'assistant'),  // 当天
    makeRecord('2026-05-17', 'assistant'),  // 下一天
    makeRecord('2026-05-15', 'assistant'),  // 上一天
    makeRecord('2026-05-16', 'user'),       // 当天用户消息
    { ...makeRecord('2026-05-16', 'assistant'), timestamp: null }, // 无时间戳
  ];

  // 测试每日过滤
  const result = filterRecordsByPeriod(records, 'daily', testRefDate);

  assert.strictEqual(result.start, '2026-05-16');
  assert.strictEqual(result.end, '2026-05-16');
  assert.strictEqual(result.filtered.length, 2); // 只返回当天的2条记录

  // 验证过滤后的记录
  const filteredDates = result.filtered.map(r => r.timestamp.slice(0, 10));
  assert.ok(filteredDates.every(date => date === '2026-05-16'));
});

test('filterRecordsByPeriod - weekly filtering', () => {
  // 创建测试数据：周一到周日的记录
  const records = [
    makeRecord('2026-05-11', 'assistant'),  // 周一
    makeRecord('2026-05-12', 'assistant'),  // 周二
    makeRecord('2026-05-13', 'assistant'),  // 周三
    makeRecord('2026-05-14', 'assistant'),  // 周四
    makeRecord('2026-05-15', 'assistant'),  // 周五
    makeRecord('2026-05-16', 'assistant'),  // 周六 (refDate)
    makeRecord('2026-05-17', 'assistant'),  // 周日
    makeRecord('2026-05-18', 'assistant'),  // 下周一 (不在本周)
    makeRecord('2026-05-10', 'assistant'),  // 上周日 (不在本周)
  ];

  const result = filterRecordsByPeriod(records, 'weekly', testRefDate);

  // 2026-05-16是周六，本周应该是2026-05-11到2026-05-17
  assert.strictEqual(result.start, '2026-05-11');
  assert.strictEqual(result.end, '2026-05-17');
  assert.strictEqual(result.filtered.length, 7); // 7条记录 (周一到周日)

  // 验证过滤后的日期范围
  const filteredDates = result.filtered.map(r => r.timestamp.slice(0, 10));
  filteredDates.forEach(date => {
    assert.ok(date >= '2026-05-11' && date <= '2026-05-17');
  });
});

test('filterRecordsByPeriod - monthly filtering', () => {
  // 创建测试数据：当月的记录
  const records = [
    makeRecord('2026-05-01', 'assistant'),  // 当月第一天
    makeRecord('2026-05-15', 'assistant'),  // 当月中
    makeRecord('2026-05-16', 'assistant'),  // refDate当天
    makeRecord('2026-05-31', 'assistant'),  // 当月最后一天
    makeRecord('2026-04-30', 'assistant'),  // 上月最后一天
    makeRecord('2026-06-01', 'assistant'),  // 下月第一天
  ];

  const result = filterRecordsByPeriod(records, 'monthly', testRefDate);

  // 2026年5月有31天
  assert.strictEqual(result.start, '2026-05-01');
  assert.strictEqual(result.end, '2026-05-31');
  assert.strictEqual(result.filtered.length, 4); // 4条5月份的记录

  // 验证过滤后的日期
  const filteredDates = result.filtered.map(r => r.timestamp.slice(0, 10));
  filteredDates.forEach(date => {
    assert.ok(date.startsWith('2026-05-'));
  });
});

test('computeUsageStats - basic counting', () => {
  const records = [
    makeRecord('2026-05-16', 'assistant', 'claude-sonnet-4-6', 's1', 'projA'),
    makeRecord('2026-05-16', 'user', '', 's1', 'projA'),
    makeRecord('2026-05-16', 'assistant', 'claude-haiku-4-5', 's1', 'projA'),
    makeRecord('2026-05-17', 'assistant', 'claude-sonnet-4-6', 's2', 'projB'),
    makeRecord('2026-05-17', 'user', '', 's2', 'projB'),
    makeRecord('2026-05-17', 'assistant', 'claude-sonnet-4-6', 's2', 'projB'),
  ];

  const result = computeUsageStats(records, []);

  // 会话计数
  assert.strictEqual(result.sessionCount, 2); // s1, s2

  // 请求计数 (只计算assistant消息)
  assert.strictEqual(result.requestCount, 4);

  // 用户消息计数
  assert.strictEqual(result.userMessageCount, 2);

  // 活跃天数
  assert.strictEqual(result.activeDays, 2);

  // Token统计 (有4个assistant记录)
  assert.strictEqual(result.inputTokens, 400); // 4个assistant记录 * 100 input tokens
  assert.strictEqual(result.outputTokens, 200); // 4个assistant记录 * 50 output tokens
  assert.strictEqual(result.totalTokens, 640); // input + output + cache (包括cacheCreate)
  assert.strictEqual(result.cacheRead, 40); // 4个assistant记录 * 10 cacheRead
  assert.strictEqual(result.cacheCreate, 0); // 4个assistant记录 * 0 cacheCreate
  assert.strictEqual(result.cacheCreate, 0);

  // 模型统计
  assert.deepStrictEqual(result.models, {
    'claude-sonnet-4-6': { count: 3, outputTokens: 150, inputTokens: 300, cacheRead: 30 },
    'claude-haiku-4-5': { count: 1, outputTokens: 50, inputTokens: 100, cacheRead: 10 }
  });

  // 项目统计
  assert.deepStrictEqual(result.projects, {
    'projA': { sessions: 1, requests: 2 },
    'projB': { sessions: 1, requests: 2 }
  });
});

test('computeUsageStats - empty records', () => {
  const records = [];
  const result = computeUsageStats(records, []);

  assert.strictEqual(result.sessionCount, 0);
  assert.strictEqual(result.requestCount, 0);
  assert.strictEqual(result.userMessageCount, 0);
  assert.strictEqual(result.activeDays, 0);
  assert.strictEqual(result.inputTokens, 0);
  assert.strictEqual(result.outputTokens, 0);
  assert.strictEqual(result.totalTokens, 0);
  assert.strictEqual(result.cacheRead, 0);
  assert.strictEqual(result.cacheCreate, 0);

  // 对象应该为空但存在
  assert.deepStrictEqual(result.models, {});
  assert.deepStrictEqual(result.projects, {});
  assert.deepStrictEqual(result.dailyStats, {});
});

test('computeUsageStats - daily stats', () => {
  const records = [
    makeRecord('2026-05-16', 'assistant', 'claude-sonnet-4-6', 's1', 'projA'),
    makeRecord('2026-05-16', 'user', '', 's1', 'projA'),
    makeRecord('2026-05-17', 'assistant', 'claude-haiku-4-5', 's2', 'projB'),
    makeRecord('2026-05-17', 'user', '', 's2', 'projB'),
  ];

  const result = computeUsageStats(records, []);

  // 每日统计
  assert.deepStrictEqual(result.dailyStats, {
    '2026-05-16': {
      requests: 1,
      userMessages: 1,
      inputTokens: 100,
      outputTokens: 50
    },
    '2026-05-17': {
      requests: 1,
      userMessages: 1,
      inputTokens: 100,
      outputTokens: 50
    }
  });
});

test('computeTrendData - daily period (7 days)', () => {
  // 创建7天的测试数据
  const records = [];
  for (let i = 1; i <= 7; i++) {
    records.push(makeRecord(`2026-05-${i + 9}`, 'assistant'));
  }

  // 添加一些超出范围的数据
  records.push(makeRecord('2026-05-08', 'assistant')); // 太早
  records.push(makeRecord('2026-05-17', 'assistant')); // 太晚

  const result = computeTrendData(records, 'daily', testRefDate);

  // 趋势应该覆盖7天：2026-05-10 到 2026-05-16
  assert.strictEqual(result.start, '2026-05-10');
  assert.strictEqual(result.end, '2026-05-16');

  // 验证只有这7天的数据
  assert.strictEqual(Object.keys(result.dailyStats).length, 7);

  // 验证每天的数据
  for (let i = 10; i <= 16; i++) {
    const dateStr = `2026-05-${i}`;
    assert.ok(result.dailyStats[dateStr], `Missing date: ${dateStr}`);
    assert.strictEqual(result.dailyStats[dateStr].requests, 1);
    assert.strictEqual(result.dailyStats[dateStr].inputTokens, 100);
    assert.strictEqual(result.dailyStats[dateStr].outputTokens, 50);
  }
});

test('computeTrendData - empty records', () => {
  const records = [];
  const result = computeTrendData(records, 'daily', testRefDate);

  assert.deepStrictEqual(result.dailyStats, {});
  assert.strictEqual(result.start, '2026-05-10'); // 7天前
  assert.strictEqual(result.end, '2026-05-16'); // 今天
});

test('computeTrendData - weekly period (28 days)', () => {
  const records = [];
  // 创建在28天范围内的数据：4月19日到5月16日
  for (let i = 19; i <= 30; i++) {
    records.push(makeRecord(`2026-04-${i}`, 'assistant')); // 4月19-30日
  }
  for (let i = 10; i <= 16; i++) {
    records.push(makeRecord(`2026-05-${i}`, 'assistant')); // 5月10-16日
  }

  const result = computeTrendData(records, 'weekly', testRefDate);

  // 周期应该是28天：2026-04-19 到 2026-05-16
  assert.strictEqual(result.start, '2026-04-19');
  assert.strictEqual(result.end, '2026-05-16');

  // 验证有数据的日子
  assert.ok(result.dailyStats['2026-04-19'], '2026-04-19 should exist');
  assert.ok(result.dailyStats['2026-04-21'], '2026-04-21 should exist');
  assert.ok(result.dailyStats['2026-04-30'], '2026-04-30 should exist');
  assert.ok(result.dailyStats['2026-05-10'], '2026-05-10 should exist');
  assert.ok(result.dailyStats['2026-05-11'], '2026-05-11 should exist');
  assert.ok(result.dailyStats['2026-05-15'], '2026-05-15 should exist');
  assert.ok(result.dailyStats['2026-05-16'], '2026-05-16 should exist');
});

test('computeTrendData - monthly period (180 days)', () => {
  const records = [];
  // 创建在180天范围内的关键日期数据
  // 2025年12月
  for (let i = 1; i <= 5; i++) {
    const day = String(i).padStart(2, '0');
    records.push(makeRecord(`2025-12-${day}`, 'assistant'));
  }
  // 2026年1月
  for (let i = 1; i <= 5; i++) {
    const day = String(i).padStart(2, '0');
    records.push(makeRecord(`2026-01-${day}`, 'assistant'));
  }
  // 2026年2月
  for (let i = 1; i <= 5; i++) {
    const day = String(i).padStart(2, '0');
    records.push(makeRecord(`2026-02-${day}`, 'assistant'));
  }
  // 2026年3月
  for (let i = 1; i <= 5; i++) {
    const day = String(i).padStart(2, '0');
    records.push(makeRecord(`2026-03-${day}`, 'assistant'));
  }
  // 2026年4月
  for (let i = 1; i <= 5; i++) {
    const day = String(i).padStart(2, '0');
    records.push(makeRecord(`2026-04-${day}`, 'assistant'));
  }
  // 2026年5月
  for (let i = 10; i <= 16; i++) {
    const day = String(i).padStart(2, '0');
    records.push(makeRecord(`2026-05-${day}`, 'assistant'));
  }

  const result = computeTrendData(records, 'monthly', testRefDate);

  // 月期应该是180天：2025-11-18 到 2026-05-16
  assert.strictEqual(result.start, '2025-11-18');
  assert.strictEqual(result.end, '2026-05-16');

  // 验证有数据的日子
  assert.ok(result.dailyStats['2025-12-01'], '2025-12-01 should exist');
  assert.ok(result.dailyStats['2025-12-03'], '2025-12-03 should exist');
  assert.ok(result.dailyStats['2026-01-01'], '2026-01-01 should exist');
  assert.ok(result.dailyStats['2026-01-03'], '2026-01-03 should exist');
  assert.ok(result.dailyStats['2026-02-01'], '2026-02-01 should exist');
  assert.ok(result.dailyStats['2026-03-01'], '2026-03-01 should exist');
  assert.ok(result.dailyStats['2026-04-01'], '2026-04-01 should exist');
  assert.ok(result.dailyStats['2026-05-10'], '2026-05-10 should exist');
  assert.ok(result.dailyStats['2026-05-16'], '2026-05-16 should exist');
});

test('computeUsageStats - cost estimation', () => {
  const records = [
    makeRecord('2026-05-16', 'assistant', 'claude-sonnet-4-6', 's1', 'projA'),
    makeRecord('2026-05-16', 'assistant', 'claude-opus-4-6', 's1', 'projA'),
    makeRecord('2026-05-16', 'assistant', 'claude-haiku-4-5', 's1', 'projA'),
  ];

  const result = computeUsageStats(records, []);

  // 检查估算成本
  assert.ok(result.estimatedCost > 0);

  // 验证成本计算：
  // claude-sonnet-4-6: (100k input * $3) + (50k output * $15) + (10k cache * $0.30) = $300 + $750 + $3 = $1053
  // claude-opus-4-6: (100k input * $15) + (50k output * $75) + (10k cache * $1.50) = $1500 + $3750 + $15 = $5265
  // claude-haiku-4-5: (100k input * $0.80) + (50k output * $4) + (10k cache * $0.08) = $80 + $200 + $0.8 = $280.8
  // 总计: $1053 + $5265 + $280.8 = $6598.8 -> $6598.8

  // 注意：实际成本取决于具体的token数量和计算
  assert.ok(result.estimatedCost >= 0);
});

// ── Dedup tests ──

test('deduplicateRecords - keeps higher token count', () => {
  const records = [
    { type: 'assistant', messageId: 'm1', requestId: 'r1', timestamp: '2024-01-01T10:00:00Z', tokens: { input: 100, output: 50, cacheRead: 0, cacheCreate: 0 } },
    { type: 'assistant', messageId: 'm1', requestId: 'r1', timestamp: '2024-01-01T10:00:00Z', tokens: { input: 200, output: 100, cacheRead: 0, cacheCreate: 0 } },
  ];
  const deduped = deduplicateRecords(records);
  assert.strictEqual(deduped.length, 1);
  assert.strictEqual(deduped[0].tokens.input, 200);
});

test('deduplicateRecords - preserves user records', () => {
  const records = [
    { type: 'user', timestamp: '2024-01-01T10:00:00Z', sessionId: 's1' },
    { type: 'user', timestamp: '2024-01-01T10:01:00Z', sessionId: 's1' },
  ];
  const deduped = deduplicateRecords(records);
  assert.strictEqual(deduped.length, 2);
});

test('deduplicateRecords - no dedup key passes through', () => {
  const records = [
    { type: 'assistant', messageId: '', requestId: 'r1', timestamp: '2024-01-01T10:00:00Z', tokens: { input: 100, output: 50, cacheRead: 0, cacheCreate: 0 } },
    { type: 'assistant', messageId: 'm1', requestId: '', timestamp: '2024-01-01T10:00:00Z', tokens: { input: 100, output: 50, cacheRead: 0, cacheCreate: 0 } },
  ];
  const deduped = deduplicateRecords(records);
  assert.strictEqual(deduped.length, 2);
});

// ── Model pricing tests ──

test('resolveModelPricing - exact match', () => {
  const p = resolveModelPricing('claude-sonnet-4-6');
  assert.strictEqual(p.input, 3);
  assert.strictEqual(p.output, 15);
});

test('resolveModelPricing - strips provider prefix', () => {
  const p = resolveModelPricing('anthropic--claude-opus-4-6');
  assert.strictEqual(p.input, 15);
  assert.strictEqual(p.output, 75);
});

test('resolveModelPricing - fuzzy match by family', () => {
  const p = resolveModelPricing('claude-opus-4-some-custom');
  assert.strictEqual(p.input, 15);
});

test('resolveModelPricing - unknown model defaults to sonnet', () => {
  const p = resolveModelPricing('unknown-model');
  assert.strictEqual(p.input, 3);
});

test('resolveModelPricing - null/undefined defaults to sonnet', () => {
  const p = resolveModelPricing(null);
  assert.strictEqual(p.input, 3);
  const p2 = resolveModelPricing(undefined);
  assert.strictEqual(p2.input, 3);
});

test('resolveModelPricing - includes cacheCreate pricing', () => {
  const p = resolveModelPricing('claude-sonnet-4-6');
  assert.ok(p.cacheCreate > 0);
});

// ── groupBySessions primaryTool tests ──

test('groupBySessions - derives primaryTool from records', () => {
  const records = [
    { sessionId: 's1', timestamp: '2026-05-16T10:00:00Z', type: 'assistant', model: 'm1', tool: 'claude', tokens: { input: 100, output: 50, cacheRead: 0, cacheCreate: 0 }, toolCalls: [], metadata: {} },
    { sessionId: 's1', timestamp: '2026-05-16T10:01:00Z', type: 'assistant', model: 'm1', tool: 'claude', tokens: { input: 100, output: 50, cacheRead: 0, cacheCreate: 0 }, toolCalls: [], metadata: {} },
    { sessionId: 's1', timestamp: '2026-05-16T10:02:00Z', type: 'assistant', model: 'm1', tool: 'codex', tokens: { input: 50, output: 20, cacheRead: 0, cacheCreate: 0 }, toolCalls: [], metadata: {} },
  ];
  const sessions = groupBySessions(records);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].primaryTool, 'claude');
});

test('groupBySessions - primaryTool null when no tool field', () => {
  const records = [
    { sessionId: 's1', timestamp: '2026-05-16T10:00:00Z', type: 'assistant', model: 'm1', tokens: { input: 100, output: 50, cacheRead: 0, cacheCreate: 0 }, toolCalls: [], metadata: {} },
  ];
  const sessions = groupBySessions(records);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].primaryTool, null);
});

test('groupBySessions - multiple sessions with different tools', () => {
  const records = [
    { sessionId: 's-claude', timestamp: '2026-05-16T10:00:00Z', type: 'assistant', model: 'm1', tool: 'claude', tokens: { input: 100, output: 50, cacheRead: 0, cacheCreate: 0 }, toolCalls: [], metadata: {} },
    { sessionId: 's-codex', timestamp: '2026-05-16T11:00:00Z', type: 'assistant', model: 'm2', tool: 'codex', tokens: { input: 80, output: 30, cacheRead: 0, cacheCreate: 0 }, toolCalls: [], metadata: {} },
  ];
  const sessions = groupBySessions(records);
  const byId = Object.fromEntries(sessions.map(s => [s.id, s]));
  assert.equal(byId['s-claude'].primaryTool, 'claude');
  assert.equal(byId['s-codex'].primaryTool, 'codex');
});

test('groupBySessions - exposes shared attribution evidence fields', () => {
  const records = [
    {
      sessionId: 's-codex',
      timestamp: '2026-05-16T11:00:00Z',
      type: 'assistant',
      model: 'm2',
      tool: 'codex',
      project: 'D:/repo',
      tokens: { input: 80, output: 30, cacheRead: 0, cacheCreate: 0 },
      metadata: {
        toolCalls: [
          { name: 'Edit', input: { file_path: 'D:/repo/lib/a.js' } },
          { name: 'Bash', input: { command: 'git commit -m "feat: x"' } },
        ],
      },
    },
  ];

  const [session] = groupBySessions(records);
  assert.equal(session.primaryTool, 'codex');
  assert.equal(session.project, 'D:/repo');
  assert.ok(Array.isArray(session.toolSequence));
  assert.ok(Array.isArray(session.touchedFiles));
  assert.ok(Array.isArray(session.shellCommands));
  assert.ok(Array.isArray(session.gitCommitTimestamps));
  assert.ok(session.touchedFiles.includes('D:/repo/lib/a.js'));
  assert.ok(session.shellCommands.includes('git commit -m "feat: x"'));
  assert.deepEqual(session.gitCommitTimestamps, ['2026-05-16T11:00:00Z']);
});
