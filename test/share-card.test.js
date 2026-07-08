import test from 'node:test';
import { strict as assert } from 'node:assert';
import { extractCardData } from '../public/share-card.js';

function mkData(over = {}) {
  return {
    usageStats: {
      sessionCount: 12, requestCount: 80, totalTokens: 500000,
      inputTokens: 300000, outputTokens: 200000,
      estimatedCost: 18.5, projects: { 'D:/myapp': { requests: 50 }, 'D:/idea': { requests: 30 } },
      ...over.usageStats,
    },
    gitStats: over.gitStats,
    start: '2026-07-01', end: '2026-07-07',
  };
}

test('extractCardData - 有 git 归因，头部为 AI 贡献率', () => {
  const data = mkData({
    gitStats: { commits: 10, linesAdded: 4200, linesDeleted: 1020, aiContribution: {
      aiLinesChanged: 3180, totalLinesChanged: 5220, aiLineRatio: 0.61,
    } },
  });
  const card = extractCardData(data, 'weekly');
  assert.equal(card.headline.label, 'AI 贡献率');
  assert.equal(card.headline.value, '61%');   // round(3180/5220*100)=61
  assert.equal(card.hasGit, true);
  assert.equal(card.periodLabel, '周报 2026-07-01 ~ 2026-07-07');
});

test('extractCardData - aiLinesChanged 缺失时回退 aiLineRatio', () => {
  const data = mkData({
    gitStats: { commits: 5, linesAdded: 100, linesDeleted: 0, aiContribution: {
      aiLinesChanged: 0, totalLinesChanged: 0, aiLineRatio: 0.4,
    } },
  });
  const card = extractCardData(data, 'weekly');
  assert.equal(card.headline.value, '40%');
});

test('extractCardData - 无 git，头部回退交互次数', () => {
  const data = mkData({ gitStats: null });
  const card = extractCardData(data, 'daily');
  assert.equal(card.headline.label, 'AI 交互次数');
  assert.equal(card.headline.value, '80');
  assert.equal(card.hasGit, false);
  assert.equal(card.periodLabel, '日报 2026-07-01');
});

test('extractCardData - stats 不超过 4 项且按序', () => {
  const data = mkData({
    gitStats: { commits: 10, linesAdded: 4200, linesDeleted: 1020, aiContribution: {
      aiLinesChanged: 3180, totalLinesChanged: 5220, aiLineRatio: 0.61,
    } },
  });
  const card = extractCardData(data, 'monthly');
  assert.ok(card.stats.length <= 4);
  assert.equal(card.periodLabel, '月报 2026-07');
  // top project 取 basename
  assert.equal(card.stats.find(s => s.label === '主力项目').value, 'myapp');
});

test('extractCardData - period=custom 走区间', () => {
  const data = mkData({});
  const card = extractCardData(data, 'custom');
  assert.equal(card.periodLabel, '2026-07-01 ~ 2026-07-07');
});
