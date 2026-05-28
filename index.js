#!/usr/bin/env node
import { loadConfig, initConfig, getConfigPath } from './lib/config.js';
import { collectAllRecords, computeUsageStats, filterRecordsByPeriod, normalizeProjectPath, computeTrendData, computePrevPeriodRange, groupBySessions } from './lib/aggregate.js';
import { getGitStatsForMultipleReposAsync, invalidateGitCache, finalizeGitStats, computeCommitTypes, computeFileHotspots } from './lib/git.js';
import { invalidateFileCache } from './lib/cache.js';
import { generateReport, generateWorkReport } from './lib/report.js';
import { startServer } from './lib/server.js';
import { detectClaudeDir, deriveProjectPaths } from './lib/parser.js';
import { identifyBillingBlocks } from './lib/blocks.js';
import { registerParser, parseAllEnabledTools, detectAvailableTools } from './lib/parsers/index.js';
import { ClaudeParser } from './lib/parsers/claude.js';
import { CodexParser } from './lib/parsers/codex.js';
import { OpencodeParser } from './lib/parsers/opencode.js';
import { initPricing, preloadUnknownPricing } from './lib/pricing-loader.js';

// 注册所有解析器
registerParser(ClaudeParser);
registerParser(CodexParser);
registerParser(OpencodeParser);

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
  let dateArg = (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`; })();
  const skipArgs = new Set();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--projects' || args[i] === '--start' || args[i] === '--end') {
      skipArgs.add(i);
      skipArgs.add(i + 1);
    }
  }
  for (let i = 2; i < args.length; i++) {
    if (skipArgs.has(i)) continue;
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

async function buildReportData(period, dateArg, config, effectiveIncludeProjects, tool = 'all', preParsed = null, options = {}) {
  // 使用预解析结果或全量解析
  let records, toolBreakdown;
  if (preParsed) {
    ({ records, toolBreakdown } = preParsed);
  } else {
    ({ records, toolBreakdown } = await parseAllEnabledTools(config, {
      excludeProjects: config.excludeProjects,
      includeProjects: effectiveIncludeProjects,
    }));
  }

  if (records.length === 0) {
    return null;
  }

  // 预加载未知模型定价
  await preloadUnknownPricing(records);

  // 按工具过滤
  const toolRecords = tool !== 'all' ? records.filter(r => r.tool === tool) : records;
  if (toolRecords.length === 0) {
    return null;
  }

  const { filtered, start, end } = filterRecordsByPeriod(toolRecords, period, dateArg, { customStart: options.customStart, customEnd: options.customEnd });
  const reposConfigured = !!(config.repos && config.repos.length > 0);

  // ── 第一层并发：三个独立的同步计算 ──
  const [usageStats, sessions, billingBlocks] = [
    computeUsageStats(filtered, config.scenarioKeywords, config.costMode),
    groupBySessions(filtered),
    identifyBillingBlocks(filtered, config.blockQuota ? 5 : 5, config.costMode),
  ];

  // ── 第二层并发：gitStats(async) + trendData + prevStats ──
  const gitStatsPromise = (async () => {
    if (!reposConfigured) return null;
    const coveredBases = new Set(filtered.map(r => {
      const p = r.project || '';
      return p.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop();
    }).filter(Boolean));
    let toolRepos = config.repos.filter(r => coveredBases.has(r.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop()));
    if (toolRepos.length === 0) toolRepos = config.repos;
    if (toolRepos.length === 0) return null;
    const extendedEnd = new Date(end);
    extendedEnd.setDate(extendedEnd.getDate() + 2);
    const extendedEndStr = extendedEnd.toISOString().slice(0, 10) + 'T23:59:59';
    let gs = await getGitStatsForMultipleReposAsync(toolRepos, start, extendedEndStr);
    gs = finalizeGitStats(gs, sessions, { attribution: config.aiAttribution });
    if (gs.commitList) {
      const windowStart = start;
      const windowEnd = end + 'T23:59:59';
      const inWindow = gs.commitList.filter(c => (c.date || '') >= windowStart && (c.date || '') <= windowEnd);
      gs.commits = inWindow.length;
      gs.linesAdded = inWindow.reduce((s, c) => s + (c.linesAdded || 0), 0);
      gs.linesDeleted = inWindow.reduce((s, c) => s + (c.linesDeleted || 0), 0);
      gs.filesChanged = new Set(inWindow.flatMap(c => (c.files || []).map(f => f.path))).size;
      gs.commitTypes = computeCommitTypes(inWindow);
      gs.fileHotspots = computeFileHotspots(inWindow, 10);
    }
    return gs;
  })();

  const trendDataPromise = Promise.resolve(computeTrendData(toolRecords, period, dateArg));

  const prevStatsPromise = (async () => {
    const prevRange = computePrevPeriodRange(period, dateArg, { customStart: options.customStart, customEnd: options.customEnd });
    const prevFiltered = toolRecords.filter(r => {
      if (!r.timestamp) return false;
      const date = r.timestamp.slice(0, 10);
      return date >= prevRange.start && date <= prevRange.end;
    });
    return prevFiltered.length > 0 ? computeUsageStats(prevFiltered, config.scenarioKeywords, config.costMode) : null;
  })();

  const [gitStats, trendData, prevStats] = await Promise.all([gitStatsPromise, trendDataPromise, prevStatsPromise]);

  // ── 第三层：依赖 usageStats 的同步派生 ──
  const slimSessions = sessions.map(s => ({
    id: s.id,
    project: s.project,
    startTime: s.startTime,
    endTime: s.endTime,
    requests: s.requests,
    commits: s.commits || [],
  }));

  const statsTB = usageStats.toolBreakdown || {};
  const mergedBreakdown = {};
  for (const [name, base] of Object.entries(toolBreakdown)) {
    const s = statsTB[name] || {};
    mergedBreakdown[name] = {
      inputTokens: s.inputTokens || 0,
      outputTokens: s.outputTokens || 0,
      cacheRead: s.cacheRead || 0,
      cacheCreate: s.cacheCreate || 0,
      count: s.count || 0,
      sessionCount: base.sessionCount || 0,
    };
  }
  for (const [name, data] of Object.entries(statsTB)) {
    if (!mergedBreakdown[name]) {
      mergedBreakdown[name] = {
        inputTokens: data.inputTokens || 0,
        outputTokens: data.outputTokens || 0,
        cacheRead: data.cacheRead || 0,
        cacheCreate: data.cacheCreate || 0,
        count: data.count || 0,
        sessionCount: 0,
      };
    }
  }

  // ── 第四层：projectDetails（从 commitList 按 repo 分组派生，无需再次 git 调用）──
  const projectDetails = {};
  const projEntries = Object.entries(usageStats.projects || {}).sort((a, b) => b[1].requests - a[1].requests);
  if (reposConfigured && gitStats?.commitList?.length) {
    const windowEnd = end + 'T23:59:59';
    const inWindow = gitStats.commitList.filter(c => (c.date || '') >= start && (c.date || '') <= windowEnd);
    const repoGroups = new Map();
    for (const c of inWindow) {
      const base = (c.repo || '').replace(/\\/g, '/').replace(/\/$/, '').split('/').pop();
      if (!base) continue;
      if (!repoGroups.has(base)) repoGroups.set(base, []);
      repoGroups.get(base).push(c);
    }
    for (const [projName, projStats] of projEntries) {
      const repoCommits = repoGroups.get(projName) || [];
      if (repoCommits.length === 0) {
        projectDetails[projName] = { usage: projStats, git: null, topCommits: [] };
        continue;
      }
      const uniqueFiles = new Set();
      let linesAdded = 0, linesDeleted = 0;
      for (const c of repoCommits) {
        linesAdded += c.linesAdded || 0;
        linesDeleted += c.linesDeleted || 0;
        for (const f of c.files || []) uniqueFiles.add(f.path);
      }
      const topCommits = repoCommits
        .filter(c => c.type === 'feat' || c.type === 'fix')
        .slice(0, 5)
        .map(c => ({ type: c.type, subject: c.subject, scope: c.scope }));
      projectDetails[projName] = {
        usage: projStats,
        git: {
          commits: repoCommits.length, linesAdded, linesDeleted,
          filesChanged: uniqueFiles.size,
          fileHotspots: computeFileHotspots(repoCommits, 5),
        },
        topCommits,
      };
    }
  } else {
    for (const [projName, projStats] of projEntries) {
      projectDetails[projName] = { usage: projStats, git: null, topCommits: [] };
    }
  }

  // 工具检测诊断：记录每个工具的检测状态和数据目录
  const diagnostics = {};
  try {
    const availableTools = await detectAvailableTools(config);
    for (const t of availableTools) {
      diagnostics[t.name] = { detected: t.detected, dataDir: t.dataDir || null };
    }
  } catch {}

  return { usageStats, gitStats, reposConfigured, sessions: slimSessions, start, end, trendData, prevStats, billingBlocks, toolBreakdown: mergedBreakdown, projectDetails, _diagnostics: diagnostics };
}

if (!command || command === 'help' || command === '--help') {
  console.log(`
用法: lumencode <命令> [周期] [日期] [选项]

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
  lumencode report daily 2026-05-15
  lumencode report daily --projects D://fzwork
  lumencode report weekly 2026-05-15 --projects D://fzwork,E://play/idea
  lumencode report daily --work
  lumencode report daily --work --brief
  lumencode serve
  lumencode init

零配置:
  首次运行自动检测 Claude 日志目录和项目路径，无需手动配置。
  如需自定义，运行 lumencode init 或在 Web 模式下点击设置。
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

  console.log('正在扫描 AI 编码助手日志...');
  const { records, toolBreakdown } = await parseAllEnabledTools(config, {
    excludeProjects: config.excludeProjects,
    includeProjects: effectiveIncludeProjects,
  });

  // 预加载未知模型定价
  await preloadUnknownPricing(records);

  if (records.length === 0) {
    console.log('未找到任何会话记录。可能原因：');
    console.log(`  1. 日志目录不存在或路径错误`);
    console.log(`  2. 该目录下没有可解析的数据`);
    console.log('请运行 lumencode init 创建配置文件，或在 Web 模式下点击设置按钮配置。');
    process.exit(1);
  }

  const projectSet = new Set(records.map(r => r.project).filter(Boolean));
  const toolNames = Object.keys(toolBreakdown || {});
  console.log(`已加载 ${records.length} 条记录，${projectSet.size} 个项目，工具: ${toolNames.join(', ')}`);

  const { filtered, start, end } = filterRecordsByPeriod(records, period, dateArg);
  console.log(`筛选 ${period} 数据: ${start} ~ ${end}，共 ${filtered.length} 条记录`);

  const usageStats = computeUsageStats(filtered, config.scenarioKeywords, config.costMode);
  usageStats.toolBreakdown = toolBreakdown;

  let gitStats = null;
  if (config.repos && config.repos.length > 0) {
    console.log('正在统计 Git 指标...');
    const sessions = groupBySessions(filtered);
    gitStats = await getGitStatsForMultipleReposAsync(config.repos, start, end + 'T23:59:59');
    gitStats = finalizeGitStats(gitStats, sessions, { attribution: config.aiAttribution });
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
