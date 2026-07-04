/**
 * LumenCode MCP Tools 定义
 *
 * 7 个 tool handlers，复用 lib/ 下核心逻辑。
 * 每个 tool 接收已缓存的数据上下文，返回 MCP content。
 */

import {
  computeUsageStats,
  filterRecordsByPeriod,
  computeTrendData,
  computePrevPeriodRange,
  groupBySessions,
  normalizeProjectPath,
} from '../../lib/aggregate.js';
import {
  getGitStatsForMultipleReposAsync,
  finalizeGitStats,
  computeCommitTypes,
  computeFileHotspots,
} from '../../lib/git.js';
import {
  generateReport,
  generateWorkReport,
  generateBossReport,
} from '../../lib/report.js';
import * as z from 'zod/v4-mini';

// ── helpers ──

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function errorResult(msg) {
  return { content: [{ type: 'text', text: msg }], isError: true };
}

function jsonResult(data) {
  return textResult(JSON.stringify(data, null, 2));
}

/**
 * 按项目过滤 records（basename 匹配）
 */
function filterByProject(records, project) {
  if (!project) return records;
  const base = project.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop();
  return records.filter(r => {
    const p = (r.project || '').replace(/\\/g, '/').replace(/\/$/, '').split('/').pop();
    return p === base;
  });
}

/**
 * 按自定义日期范围过滤 records（统一入口，复用 filterRecordsByPeriod 的 custom 分支
 * 与本地时间解析，避免各 handler 重复手写 slice(0,10) 过滤）
 */
function filterByDateRange(records, startDate, endDate) {
  return filterRecordsByPeriod(records, 'custom', startDate, { customStart: startDate, customEnd: endDate });
}

// ── Tool schemas (Zod) ──

export const toolSchemas = {
  usage_summary: {
    description: '查询 AI 编码助手用量概览：token 消耗、成本、会话数、模型分布',
    inputSchema: z.object({
      startDate: z.optional(z.string()),
      endDate: z.optional(z.string()),
      period: z.optional(z.enum(['daily', 'weekly', 'monthly'])),
      project: z.optional(z.string()),
    }),
  },
  daily_report: {
    description: '生成指定日期的 AI 编码助手使用报告（Markdown 格式）',
    inputSchema: z.object({
      date: z.optional(z.string()),
      project: z.optional(z.string()),
    }),
  },
  work_report: {
    description: '生成工作汇报（周报/月报），支持普通、简报、Boss 三种风格',
    inputSchema: z.object({
      startDate: z.optional(z.string()),
      endDate: z.optional(z.string()),
      style: z.optional(z.enum(['normal', 'brief', 'boss'])),
      period: z.optional(z.enum(['daily', 'weekly', 'monthly'])),
      refDate: z.optional(z.string()),
      project: z.optional(z.string()),
    }),
  },
  session_list: {
    description: '列出指定时间范围内的 AI 编码会话',
    inputSchema: z.object({
      startDate: z.optional(z.string()),
      endDate: z.optional(z.string()),
      period: z.optional(z.enum(['daily', 'weekly', 'monthly'])),
      project: z.optional(z.string()),
    }),
  },
  trend_analysis: {
    description: '分析 AI 编码用量趋势：日级 token、成本、请求量变化',
    inputSchema: z.object({
      period: z.optional(z.enum(['daily', 'weekly', 'monthly'])),
      refDate: z.optional(z.string()),
      project: z.optional(z.string()),
    }),
  },
  ai_contribution: {
    description: '分析指定仓库的 AI 代码贡献度：AI 贡献率、commit 归因、热点文件',
    inputSchema: z.object({
      repoPath: z.string(),
      startDate: z.optional(z.string()),
      endDate: z.optional(z.string()),
      period: z.optional(z.enum(['daily', 'weekly', 'monthly'])),
      refDate: z.optional(z.string()),
    }),
  },
  cost_breakdown: {
    description: '成本分解：按模型、按项目统计 AI 编码费用和缓存命中率',
    inputSchema: z.object({
      startDate: z.optional(z.string()),
      endDate: z.optional(z.string()),
      period: z.optional(z.enum(['daily', 'weekly', 'monthly'])),
      project: z.optional(z.string()),
    }),
  },
};

// ── Tool handlers ──

/**
 * 用量概览
 */
export async function handleUsageSummary(args, ctx) {
  const { records, config } = ctx;
  const refDate = args.startDate || today();
  const period = args.period || 'daily';
  const filtered = filterByProject(records, args.project);

  const hasCustomRange = args.startDate && args.endDate && args.endDate !== args.startDate;
  const { filtered: periodRecords, start, end } = hasCustomRange
    ? filterByDateRange(filtered, args.startDate, args.endDate)
    : filterRecordsByPeriod(filtered, period, refDate);

  if (periodRecords.length === 0) {
    return errorResult(`未找到 ${start} ~ ${end} 范围内的记录`);
  }

  const stats = computeUsageStats(periodRecords, config.scenarioKeywords, config.costMode);

  return jsonResult({
    period,
    dateRange: { start, end },
    sessions: stats.sessionCount,
    requests: stats.requestCount,
    userMessages: stats.userMessageCount,
    tokens: {
      input: stats.inputTokens,
      output: stats.outputTokens,
      cacheRead: stats.cacheRead,
      cacheCreate: stats.cacheCreate,
      total: stats.totalTokens,
    },
    estimatedCost: stats.estimatedCost,
    costMode: stats.costMode,
    models: stats.models,
    projects: Object.entries(stats.projects || {}).map(([name, p]) => ({
      name,
      requests: p.requests,
      tokens: p.totalTokens,
    })),
  });
}

/**
 * 日报
 */
export async function handleDailyReport(args, ctx) {
  const { records, config } = ctx;
  const date = args.date || today();
  const filtered = filterByProject(records, args.project);

  const { filtered: periodRecords, start, end } = filterRecordsByPeriod(filtered, 'daily', date);
  if (periodRecords.length === 0) {
    return errorResult(`未找到 ${date} 的记录`);
  }

  const usageStats = computeUsageStats(periodRecords, config.scenarioKeywords, config.costMode);

  // 尝试加载 git 数据
  let gitStats = null;
  try {
    if (config.repos && config.repos.length > 0) {
      const sessions = groupBySessions(periodRecords);
      gitStats = await getGitStatsForMultipleReposAsync(config.repos, start, end + 'T23:59:59');
      gitStats = await finalizeGitStats(gitStats, sessions, {
        attribution: config.aiAttribution,
        stepTracking: config.stepTracking,
      });
    }
  } catch { /* git 不可用时降级 */ }

  const report = generateReport(usageStats, gitStats, 'daily', start, end);
  return textResult(report);
}

/**
 * 工作报告
 */
export async function handleWorkReport(args, ctx) {
  const { records, config } = ctx;
  const style = args.style || 'normal';
  const period = args.period || 'weekly';
  const refDate = args.refDate || today();
  const filtered = filterByProject(records, args.project);

  const { filtered: periodRecords, start, end } = args.startDate && args.endDate
    ? filterByDateRange(filtered, args.startDate, args.endDate)
    : filterRecordsByPeriod(filtered, period, refDate);

  if (periodRecords.length === 0) {
    return errorResult(`未找到 ${start} ~ ${end} 范围内的记录`);
  }

  const usageStats = computeUsageStats(periodRecords, config.scenarioKeywords, config.costMode);

  let gitStats = null;
  try {
    if (config.repos && config.repos.length > 0) {
      const sessions = groupBySessions(periodRecords);
      gitStats = await getGitStatsForMultipleReposAsync(config.repos, start, end + 'T23:59:59');
      gitStats = await finalizeGitStats(gitStats, sessions, {
        attribution: config.aiAttribution,
        stepTracking: config.stepTracking,
      });
    }
  } catch { /* git 不可用时降级 */ }

  // 上一周期对比
  const prevRange = computePrevPeriodRange(period, refDate);
  const { filtered: prevFiltered } = filterByDateRange(filtered, prevRange.start, prevRange.end);
  const prevStats = prevFiltered.length > 0
    ? computeUsageStats(prevFiltered, config.scenarioKeywords, config.costMode)
    : null;

  if (style === 'boss') {
    return textResult(generateBossReport(usageStats, gitStats, period, start, end, prevStats));
  }
  return textResult(generateWorkReport(usageStats, gitStats, period, start, end, prevStats, {
    level: style === 'brief' ? 'brief' : 'detailed',
  }));
}

/**
 * 会话列表
 */
export async function handleSessionList(args, ctx) {
  const { records, config } = ctx;
  const refDate = args.startDate || today();
  const period = args.period || 'daily';
  const filtered = filterByProject(records, args.project);

  const hasCustomRange = args.startDate && args.endDate && args.endDate !== args.startDate;
  const { filtered: periodRecords } = hasCustomRange
    ? filterByDateRange(filtered, args.startDate, args.endDate)
    : filterRecordsByPeriod(filtered, period, refDate);

  const sessions = groupBySessions(periodRecords);

  return jsonResult(sessions.map(s => ({
    id: s.id,
    project: s.project,
    startTime: s.startTime,
    endTime: s.endTime,
    requests: s.requests,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    totalTokens: s.totalTokens || 0,
    isHeavy: !!s.isHeavy,
    isWarn: !!s.isWarn,
    models: s.models,
    primaryTool: s.primaryTool,
    touchedFiles: (s.touchedFiles || []).slice(0, 10),
  })));
}

/**
 * 趋势分析
 */
export async function handleTrendAnalysis(args, ctx) {
  const { records, config } = ctx;
  const period = args.period || 'daily';
  const refDate = args.refDate || today();
  const filtered = filterByProject(records, args.project);

  const trendData = computeTrendData(filtered, period, refDate);

  // 上一周期对比
  const prevRange = computePrevPeriodRange(period, refDate);
  const { filtered: prevFiltered } = filterByDateRange(filtered, prevRange.start, prevRange.end);
  const prevStats = prevFiltered.length > 0
    ? computeUsageStats(prevFiltered, config.scenarioKeywords, config.costMode)
    : null;

  return jsonResult({
    period,
    refDate,
    trend: trendData,
    previousPeriod: prevRange,
    previousStats: prevStats ? {
      requests: prevStats.requestCount,
      inputTokens: prevStats.inputTokens,
      outputTokens: prevStats.outputTokens,
      estimatedCost: prevStats.estimatedCost,
    } : null,
  });
}

/**
 * AI 贡献归因
 */
export async function handleAiContribution(args, ctx) {
  const { records, config } = ctx;
  const repoPath = args.repoPath;
  const period = args.period || 'weekly';
  const refDate = args.refDate || today();

  if (!repoPath) {
    return errorResult('必须提供 repoPath 参数');
  }

  const { start, end } = args.startDate && args.endDate
    ? { start: args.startDate, end: args.endDate }
    : (() => {
      const result = filterRecordsByPeriod(records, period, refDate);
      return { start: result.start, end: result.end };
    })();

  try {
    const { filtered: inRangeRecords } = filterByDateRange(records, start, end);
    const sessions = groupBySessions(inRangeRecords);

    let gitStats = await getGitStatsForMultipleReposAsync([repoPath], start, end + 'T23:59:59');
    gitStats = await finalizeGitStats(gitStats, sessions, {
      attribution: config.aiAttribution,
      stepTracking: config.stepTracking,
    });

    // 窗口过滤
    const windowEnd = end + 'T23:59:59';
    const inWindow = (gitStats.commitList || []).filter(c =>
      (c.date || '') >= start && (c.date || '') <= windowEnd
    );

    const commitTypes = computeCommitTypes(inWindow);
    const fileHotspots = computeFileHotspots(inWindow, 10);

    return jsonResult({
      repoPath,
      dateRange: { start, end },
      commits: {
        total: inWindow.length,
        byType: commitTypes,
      },
      linesAdded: inWindow.reduce((s, c) => s + (c.linesAdded || 0), 0),
      linesDeleted: inWindow.reduce((s, c) => s + (c.linesDeleted || 0), 0),
      aiContribution: gitStats.aiRatio != null
        ? `${(gitStats.aiRatio * 100).toFixed(1)}%`
        : null,
      aiCommitRatio: gitStats.aiCommitRatio != null
        ? `${(gitStats.aiCommitRatio * 100).toFixed(1)}%`
        : null,
      fileHotspots,
      topAiCommits: inWindow
        .filter(c => c.isAI)
        .slice(0, 10)
        .map(c => ({
          hash: c.hash,
          subject: c.subject,
          confidence: c.aiConfidence,
          linesAdded: c.linesAdded,
          linesDeleted: c.linesDeleted,
        })),
    });
  } catch (err) {
    return errorResult(`Git 分析失败: ${err.message}`);
  }
}

/**
 * 成本分解
 */
export async function handleCostBreakdown(args, ctx) {
  const { records, config } = ctx;
  const refDate = args.startDate || today();
  const period = args.period || 'daily';
  const filtered = filterByProject(records, args.project);

  const hasCustomRange = args.startDate && args.endDate && args.endDate !== args.startDate;
  const { filtered: periodRecords, start, end } = hasCustomRange
    ? filterByDateRange(filtered, args.startDate, args.endDate)
    : filterRecordsByPeriod(filtered, period, refDate);

  if (periodRecords.length === 0) {
    return errorResult(`未找到 ${refDate} 范围内的记录`);
  }

  const stats = computeUsageStats(periodRecords, config.scenarioKeywords, config.costMode);

  // 按模型成本排序
  const modelCosts = Object.entries(stats.models || {})
    .map(([name, m]) => ({
      model: name,
      requests: m.count,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cacheRead: m.cacheRead,
      cacheCreate: m.cacheCreate,
      cost: m.cost,
    }))
    .sort((a, b) => (b.cost || 0) - (a.cost || 0));

  // 按项目分解
  const projectCosts = Object.entries(stats.projects || {})
    .map(([name, p]) => ({
      project: name,
      requests: p.requests,
      tokens: p.totalTokens,
    }))
    .sort((a, b) => b.requests - a.requests);

  return jsonResult({
    dateRange: { start, end },
    totalCost: stats.estimatedCost,
    costMode: stats.costMode,
    cacheEfficiency: {
      cacheRead: stats.cacheRead,
      cacheCreate: stats.cacheCreate,
      cacheRatio: stats.totalTokens > 0
        ? `${((stats.cacheRead / stats.totalTokens) * 100).toFixed(1)}%`
        : '0%',
    },
    byModel: modelCosts,
    byProject: projectCosts,
  });
}

/**
 * Tool 名称到 handler 的映射
 */
export const toolHandlers = {
  usage_summary: handleUsageSummary,
  daily_report: handleDailyReport,
  work_report: handleWorkReport,
  session_list: handleSessionList,
  trend_analysis: handleTrendAnalysis,
  ai_contribution: handleAiContribution,
  cost_breakdown: handleCostBreakdown,
};
