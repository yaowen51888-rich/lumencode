#!/usr/bin/env node
import { loadConfig, initConfig, getConfigPath } from './lib/config.js';
import { collectAllRecords, computeUsageStats, filterRecordsByPeriod, normalizeProjectPath, computeTrendData, computePrevPeriodRange, groupBySessions } from './lib/aggregate.js';
import { getGitStatsForMultipleReposAsync, invalidateGitCache, finalizeGitStats } from './lib/git.js';
import { invalidateFileCache } from './lib/cache.js';
import { generateReport, generateWorkReport } from './lib/report.js';
import { startServer } from './lib/server.js';
import { detectClaudeDir, deriveProjectPaths } from './lib/parser.js';
import { identifyBillingBlocks } from './lib/blocks.js';

const args = process.argv.slice(2);
const command = args[0];

function loadCliConfig() {
  let config = loadConfig();

  // 零配置：自动检测 claudeDir
  if (!config.claudeDir || config.claudeDir === '') {
    config.claudeDir = detectClaudeDir() || config.claudeDir;
  }

  // 零配置：自动推导项目路径（从 cwd 字段）
  if ((!config.repos || config.repos.length === 0) && config.claudeDir) {
    try {
      const derived = deriveProjectPaths(config.claudeDir, config.excludeProjects || []);
      if (derived.length > 0) {
        config._autoRepos = derived;
      }
    } catch {}
  }

  // 日期参数
  let dateArg = new Date().toISOString().slice(0, 10);
  for (let i = 2; i < args.length; i++) {
    if (!args[i].startsWith('--')) {
      dateArg = args[i];
      break;
    }
  }

  // --projects 参数
  let includeProjects = null;
  const projectsIdx = args.indexOf('--projects');
  if (projectsIdx !== -1 && args[projectsIdx + 1]) {
    includeProjects = args[projectsIdx + 1].split(',').map(p => p.trim());
  }

  // 推导 includeProjects
  let effectiveIncludeProjects = includeProjects;
  if (!effectiveIncludeProjects && config.repos && config.repos.length > 0) {
    effectiveIncludeProjects = config.repos.map(r => normalizeProjectPath(r));
  } else if (!effectiveIncludeProjects && config._autoRepos && config._autoRepos.length > 0) {
    effectiveIncludeProjects = config._autoRepos.map(r => normalizeProjectPath(r));
  }

  // 自动推导的 repos 也用于 Git 统计
  if ((!config.repos || config.repos.length === 0) && config._autoRepos) {
    config.repos = config._autoRepos;
  }

  const configPath = getConfigPath();
  return { config, dateArg, effectiveIncludeProjects, configPath };
}

async function buildReportData(period, dateArg, config, effectiveIncludeProjects) {
  const { records } = collectAllRecords(config.claudeDir, config.excludeProjects, effectiveIncludeProjects);
  if (records.length === 0) {
    return null;
  }

  const { filtered, start, end } = filterRecordsByPeriod(records, period, dateArg);
  const usageStats = computeUsageStats(filtered, config.scenarioKeywords, config.costMode);
  const sessions = groupBySessions(filtered);

  let gitStats = null;
  if (config.repos && config.repos.length > 0) {
    gitStats = await getGitStatsForMultipleReposAsync(config.repos, start, end + 'T23:59:59');
    gitStats = finalizeGitStats(gitStats, sessions);
  }

  const trendData = computeTrendData(records, period, dateArg);

  // Previous period stats for trend comparison
  const prevRange = computePrevPeriodRange(period, dateArg);
  const prevFiltered = records.filter(r => {
    if (!r.timestamp) return false;
    const date = r.timestamp.slice(0, 10);
    return date >= prevRange.start && date <= prevRange.end;
  });
  const prevStats = prevFiltered.length > 0 ? computeUsageStats(prevFiltered, config.scenarioKeywords, config.costMode) : null;

  // 精简 sessions 仅保留 UI/导出需要的字段，避免 payload 膨胀
  const slimSessions = sessions.map(s => ({
    id: s.id,
    project: s.project,
    startTime: s.startTime,
    endTime: s.endTime,
    requests: s.requests,
    commits: s.commits || [],
  }));

  // 5-hour billing blocks
  const billingBlocks = identifyBillingBlocks(filtered, config.blockQuota ? 5 : 5, config.costMode);

  return { usageStats, gitStats, sessions: slimSessions, start, end, trendData, prevStats, billingBlocks };
}

if (!command || command === 'help' || command === '--help') {
  console.log(`
用法: ccusage-report <命令> [周期] [日期] [选项]

命令:
  report   生成使用报告（默认命令）
  serve    启动 Web 服务（默认端口 4567）
  init     初始化配置文件
  help     显示帮助信息

周期:
  daily    日报（默认）
  weekly   周报
  monthly  月报

日期:
  指定报告的参考日期，格式 YYYY-MM-DD（默认今天）

选项:
  --projects   只统计指定项目，多个项目用逗号分隔
  --work       输出工作汇报版本（Markdown 格式）
  --brief      配合 --work 使用，输出简报（3-5 句话）

示例:
  ccusage-report report daily 2026-05-15
  ccusage-report report daily --projects D://fzwork
  ccusage-report report weekly 2026-05-15 --projects D://fzwork,E://play/idea
  ccusage-report report daily --work
  ccusage-report report daily --work --brief
  ccusage-report serve
  ccusage-report init

零配置:
  首次运行自动检测 Claude 日志目录和项目路径，无需手动配置。
  如需自定义，运行 ccusage-report init 或在 Web 模式下点击设置。
`);
  process.exit(0);
}

if (command === 'init') {
  initConfig(args[1]);
  process.exit(0);
}

if (command === 'serve') {
  const { config, effectiveIncludeProjects, configPath } = loadCliConfig();
  startServer(config, effectiveIncludeProjects, buildReportData, configPath);
} else {
  // report command (default)
  const period = args[1] || 'daily';
  const isWorkMode = args.includes('--work');
  const isBrief = args.includes('--brief');
  const { config, dateArg, effectiveIncludeProjects } = loadCliConfig();

  console.log('正在扫描 Claude Code 日志...');
  const { records, projects } = collectAllRecords(config.claudeDir, config.excludeProjects, effectiveIncludeProjects);

  if (records.length === 0) {
    console.log('未找到任何会话记录。可能原因：');
    console.log(`  1. Claude 日志目录不存在或路径错误: ${config.claudeDir}`);
    console.log(`  2. 该目录下没有 projects/ 子目录`);
    console.log('请运行 ccusage-report init 创建配置文件，或在 Web 模式下点击设置按钮配置。');
    process.exit(1);
  }

  const subagentCount = records.filter(r => r.isSubagent).length;
  console.log(`已加载 ${records.length} 条记录（含 ${subagentCount} 条子 agent），${Object.keys(projects).length} 个项目`);

  const { filtered, start, end } = filterRecordsByPeriod(records, period, dateArg);
  console.log(`筛选 ${period} 数据: ${start} ~ ${end}，共 ${filtered.length} 条记录`);

  const usageStats = computeUsageStats(filtered, config.scenarioKeywords, config.costMode);
  if (usageStats.subagentTokens > 0) {
    console.log(`子 agent Token 消耗: ${fmtNum(usageStats.subagentTokens)}（占比 ${(usageStats.subagentTokens / usageStats.totalTokens * 100).toFixed(1)}%）`);
  }

  let gitStats = null;
  if (config.repos && config.repos.length > 0) {
    console.log('正在统计 Git 指标...');
    gitStats = await getGitStatsForMultipleReposAsync(config.repos, start, end + 'T23:59:59');
  }

  // 上一周期数据（用于工作汇报环比）
  const prevRange = computePrevPeriodRange(period, dateArg);
  const prevFiltered = records.filter(r => {
    if (!r.timestamp) return false;
    const date = r.timestamp.slice(0, 10);
    return date >= prevRange.start && date <= prevRange.end;
  });
  const prevStats = prevFiltered.length > 0 ? computeUsageStats(prevFiltered, config.scenarioKeywords, config.costMode) : null;

  const report = isWorkMode
    ? generateWorkReport(usageStats, gitStats, period, start, end, prevStats, { level: isBrief ? 'brief' : 'detailed' })
    : generateReport(usageStats, gitStats, period, start, end);
  console.log(report);
}

function fmtNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}
