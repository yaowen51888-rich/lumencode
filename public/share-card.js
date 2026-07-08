import { fmt, fmtShort } from './utils.js';

// 纯数据派生：从报告数据提取卡片所需字段。无 DOM/Canvas 依赖，可单测。
export function extractCardData(data, period) {
  const u = data?.usageStats || {};
  const g = data?.gitStats;
  const ai = g?.aiContribution;

  const periodLabel = formatPeriodLabel(period, data.start, data.end);

  let headline;
  const hasGit = !!(g && g.commits > 0 && ai);
  if (hasGit) {
    const totalLines = ai.totalLinesChanged || (ai.aiFileLinesAdded + ai.aiFileLinesDeleted + (ai.humanLinesChanged || 0)) || 1;
    const pct = Math.round((ai.aiLinesChanged / totalLines) * 100) || Math.round((ai.aiLineRatio || 0) * 100);
    headline = { label: 'AI 贡献率', value: `${pct}%` };
  } else {
    headline = { label: 'AI 交互次数', value: String(u.requestCount || 0) };
  }

  const stats = [];
  if (u.estimatedCost) stats.push({ label: '等效费用', value: `$${u.estimatedCost.toFixed(2)}` });
  if (hasGit) {
    // ponytail: 卡片 stat 列宽 260px，省略 -deleted 避免截断省略号；完整 +/- 在详报
    stats.push({ label: 'Git 产出', value: `${g.commits} commits · +${fmtShort(g.linesAdded)}` });
  } else if (u.totalTokens) {
    stats.push({ label: 'Token 消耗', value: fmtShort(u.totalTokens) });
  }
  if (u.sessionCount) stats.push({ label: '会话数', value: fmt(u.sessionCount) });
  const projects = Object.entries(u.projects || {})
    .filter(([, d]) => d.requests > 0)
    .sort((a, b) => b[1].requests - a[1].requests);
  if (projects.length) {
    const top = projects[0][0].replace(/\\/g, '/').replace(/\/$/, '').split('/').pop();
    stats.push({ label: '主力项目', value: top });
  }

  return { headline, periodLabel, stats: stats.slice(0, 4), hasGit };
}

function formatPeriodLabel(period, start, end) {
  switch (period) {
    case 'daily': return `日报 ${start}`;
    case 'weekly': return `周报 ${start} ~ ${end}`;
    case 'monthly': return `月报 ${start.slice(0, 7)}`;
    default: return `${start} ~ ${end}`;
  }
}
