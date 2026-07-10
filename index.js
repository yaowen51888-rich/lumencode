#!/usr/bin/env node
import { loadConfig, initConfig, getConfigPath } from './lib/config.js';
import { collectAllRecords, computeUsageStats, filterRecordsByPeriod, normalizeProjectPath, computeTrendData, computePrevPeriodRange, groupBySessions, buildAttributionContextSessions } from './lib/aggregate.js';
import { getGitStatsForMultipleReposAsync, invalidateGitCache, finalizeGitStats, computeCommitTypes, computeFileHotspots } from './lib/git.js';
import { invalidateFileCache } from './lib/cache.js';
import { generateReport, generateWorkReport, generateBossReport, workReportFooter } from './lib/report.js';
import { startServer } from './lib/server.js';
import { detectClaudeDir, deriveProjectPaths } from './lib/parser.js';
import { identifyBillingBlocks } from './lib/blocks.js';
import { parseAllEnabledTools, detectAvailableTools } from './lib/parsers/index.js';
import { registerAllParsers } from './lib/parsers/register.js';
import { initPricing, preloadUnknownPricing } from './lib/pricing-loader.js';
import { createInterface } from 'readline';
import { stdin as input, stdout as output } from 'process';
import { createRequire } from 'module';
import { enableHooks, disableHooks, getHooksStatus, HOOK_TOOLS, initStepTracking } from './lib/hooks-manager.js';

// 版本号取自 package.json，cwd 无关
const { version: APP_VERSION } = createRequire(import.meta.url)('./package.json');

// 注册所有解析器
registerAllParsers();

const args = process.argv.slice(2);
const command = args[0];

function parseHookTools(values) {
  const raw = values.length > 0 ? values : ['claude', 'codex', 'opencode', 'gemini'];
  const tools = new Set();
  for (const value of raw) {
    for (const part of value.split(',')) {
      const tool = part.trim().toLowerCase();
      if (!tool) continue;
      if (tool === 'claude' || tool === 'claude-code') tools.add(HOOK_TOOLS.CLAUDE);
      else if (tool === 'codex') tools.add(HOOK_TOOLS.CODEX);
      else if (tool === 'opencode' || tool === 'open-code') tools.add(HOOK_TOOLS.OPENCODE);
      else if (tool === 'gemini' || tool === 'gemini-cli') tools.add(HOOK_TOOLS.GEMINI);
      else throw new Error(`不支持的 hooks 工具: ${part}`);
    }
  }
  return [...tools];
}

function detectedHookTools(status = getHooksStatus(process.cwd())) {
  const tools = [];
  if (status.claude.configExists || status.claude.enabled) tools.push(HOOK_TOOLS.CLAUDE);
  if (status.codex.configExists || status.codex.enabled) tools.push(HOOK_TOOLS.CODEX);
  if (status.opencode.configExists || status.opencode.enabled) tools.push(HOOK_TOOLS.OPENCODE);
  if (status.gemini.configExists || status.gemini.enabled) tools.push(HOOK_TOOLS.GEMINI);
  return tools.length > 0 ? tools : [HOOK_TOOLS.CLAUDE, HOOK_TOOLS.CODEX, HOOK_TOOLS.OPENCODE, HOOK_TOOLS.GEMINI];
}

function formatEnabled(value) {
  return value ? '已开启' : '未开启';
}

function printHooksStatus(status) {
  console.log('Hooks 状态:');
  const claudeMode = status.claude.batchEnabled ? 'batch' : status.claude.legacyEnabled ? 'legacy' : '';
  console.log(`- Claude Code: ${status.claude.invalid ? '配置文件 JSON 无效' : formatEnabled(status.claude.enabled)}${claudeMode ? ` (${claudeMode})` : ''}`);
  console.log(`- Codex: ${formatEnabled(status.codex.enabled)}`);
  console.log(`- OpenCode: ${formatEnabled(status.opencode.enabled)}`);
  console.log(`- Gemini CLI: ${status.gemini.invalid ? '配置文件 JSON 无效' : formatEnabled(status.gemini.enabled)}`);
  console.log(`- steps 数据库: ${status.stepsInitialized ? '已初始化' : '未初始化'}`);
  console.log(`- 项目: ${status.projectRoot}`);
}

function printHookResults(results, action) {
  for (const result of results) {
    const name = hookToolName(result.tool);
    console.log(`- ${name}: ${result.changed ? action : '无需变更'} (${result.configPath})`);
    if (result.backupPath) console.log(`  备份: ${result.backupPath}`);
  }
}

function hookToolName(tool) {
  if (tool === HOOK_TOOLS.CLAUDE) return 'Claude Code';
  if (tool === HOOK_TOOLS.CODEX) return 'Codex';
  if (tool === HOOK_TOOLS.OPENCODE) return 'OpenCode';
  if (tool === HOOK_TOOLS.GEMINI) return 'Gemini CLI';
  return 'Unknown';
}

function createPromptSession() {
  const rl = createInterface({ input, output });
  const lines = [];
  const waiters = [];
  let closed = false;

  rl.on('line', line => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()('');
  });

  return {
    async ask(prompt) {
      output.write(prompt);
      if (lines.length > 0) return lines.shift();
      if (closed) return '';
      return new Promise(resolve => waiters.push(resolve));
    },
    close() {
      rl.close();
    },
  };
}

async function promptHookTools(defaultTools, rl) {
  console.log('检测到:');
  defaultTools.forEach((tool, index) => {
    console.log(`[${index + 1}] ${hookToolName(tool)}`);
  });

  const answer = await rl.ask('请选择要开启 hooks 的工具（例如 1,2，直接回车选择全部）: ');
  const raw = answer.trim();
  if (!raw) return defaultTools;
  const selected = [];
  for (const part of raw.split(',')) {
    const idx = Number(part.trim());
    if (!Number.isInteger(idx) || idx < 1 || idx > defaultTools.length) {
      throw new Error(`无效选择: ${part}`);
    }
    selected.push(defaultTools[idx - 1]);
  }
  return [...new Set(selected)];
}

async function confirmHooksEnable(tools, status, rl) {
  console.log('即将开启 AI 工具 hooks。');
  console.log('操作类型: 修改当前项目的本地 AI 工具配置文件。');
  console.log(`影响范围: ${tools.includes(HOOK_TOOLS.CLAUDE) ? '.claude/settings.local.json ' : ''}${tools.includes(HOOK_TOOLS.CODEX) ? '.codex/config.toml' : ''}`);
  console.log('用途: 记录 PostToolUse 事件，用于行级 AI 归因。');
  console.log(`steps 数据库: ${status.stepsInitialized ? '已初始化' : '将初始化 .lumencode/steps.db'}`);
  console.log('风险: 只启用当前项目 hooks，不修改全局配置或其它项目。');

  const answer = await rl.ask('请输入“确认”继续: ');
  return answer.trim() === '确认' || answer.trim().toLowerCase() === 'yes' || answer.trim().toLowerCase() === 'y';
}

async function handleHooksCommand() {
  const subcommand = args[1] || 'status';
  if (subcommand === 'init') {
    const stats = await initStepTracking(process.cwd());
    console.log(`Step tracking initialized at .lumencode/steps.db`);
    console.log(`  Steps: ${stats.stepCount}, Sessions: ${stats.sessionCount}`);
    return;
  }
  if (subcommand === 'status') {
    printHooksStatus(getHooksStatus(process.cwd()));
    return;
  }

  const yes = args.includes('--yes') || args.includes('-y');
  const toolArgs = args.slice(2).filter(arg => arg !== '--yes' && arg !== '-y');
  const status = getHooksStatus(process.cwd());
  const rl = createPromptSession();
  let tools;
  try {
    tools = toolArgs.length > 0
      ? parseHookTools(toolArgs)
      : await promptHookTools(detectedHookTools(status), rl);

    if (subcommand === 'enable') {
      if (!yes && !(await confirmHooksEnable(tools, status, rl))) {
        console.log('已取消，未修改配置。');
        return;
      }
      const stats = await initStepTracking(process.cwd());
      console.log(`Step tracking initialized at .lumencode/steps.db`);
      console.log(`  Steps: ${stats.stepCount}, Sessions: ${stats.sessionCount}`);
      const results = enableHooks(process.cwd(), tools, { backup: true });
      printHookResults(results, '已开启');
      return;
    }

    if (subcommand === 'disable') {
      const results = disableHooks(process.cwd(), tools, { backup: true });
      printHookResults(results, '已关闭');
      return;
    }
  } finally {
    rl.close();
  }

  console.log('未知 hooks 命令。用法: node index.js hooks status|enable|disable|init [claude,codex] [--yes]');
}

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
    // 外扩窗口仅用于跨天提交匹配；归因与统计严格按真实周期 [start, end]
    // 用 Date.parse 数值比较，避免对带时区偏移日期的字符串字典序错位
    if (gs.commitList) {
      const startMs = Date.parse(`${start}T00:00:00`);
      const endMs = Date.parse(`${end}T23:59:59`);
      if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
        gs.commitList = gs.commitList.filter(c => {
          const t = Date.parse(c.date);
          return Number.isFinite(t) && t >= startMs && t <= endMs;
        });
      }
    }
    gs = await finalizeGitStats(gs, sessions, {
      attribution: config.aiAttribution,
      stepTracking: config.stepTracking,
      attributionSessions: buildAttributionContextSessions(toolRecords, {
        start,
        backDays: config.aiAttribution?.windows?.crossDayWindowDays,
        projectBases: coveredBases,
      }),
      excludeFilePatterns: config.excludeFilePatterns,
    });
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
      // sessionCount 取当日过滤后的 statsTB（computeUsageStats 产出），
      // 而非 parsed 全量 base.sessionCount——否则历史用过但本周期无活动的工具
      //（如 codex）会误显 active 进度条
      sessionCount: s.sessionCount ?? 0,
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

if (command === '--version' || command === '-V') {
  console.log(APP_VERSION);
  process.exit(0);
}

if (!command || command === 'help' || command === '--help') {
  console.log(`
用法: lumencode <命令> [周期] [日期] [选项]

命令:
  report   生成使用报告（默认命令）
  serve    启动 Web 服务（默认端口 4567）
  init     初始化配置文件
  help     显示帮助信息
  -V, --version  显示版本号

周期:
  daily    日报（默认）
  weekly   周报
  monthly  月报

日期:
  指定报告的参考日期，格式 YYYY-MM-DD（默认今天）

选项:
  --projects   只统计指定项目，多个项目用逗号分隔
  --work       输出工作汇报版本（Markdown 格式）
  --boss       输出 Boss 报告（给领导看的版本，凸显工作成果）
  --brief      配合 --work 使用，输出简报（3-5 句话）
  --no-brand   去掉 --work 报告末尾的 LumenCode 尾注

示例:
  lumencode report daily 2026-05-15
  lumencode report daily --projects D://fzwork
  lumencode report weekly 2026-05-15 --projects D://fzwork,E://play/idea
  lumencode report daily --work
  lumencode report daily --work --brief
  lumencode report weekly --boss
  node index.js serve
  node index.js init
  node index.js hooks status
  node index.js hooks enable
  node index.js hooks disable
  node index.js hooks:init
  node index.js hooks:install
  node index.js hooks:install-claude
  node index.js hooks:install-codex

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

if (command === 'hooks') {
  await handleHooksCommand();
  process.exit(0);
}

if (command === 'hooks:init') {
  await import('./hooks/init-steps.js');
  process.exit(0);
}

if (command === 'hooks:install' || command === 'hooks:install-claude') {
  await import('./hooks/install.js');
  process.exit(0);
}

if (command === 'hooks:install-codex') {
  await import('./hooks/install-codex.js');
  process.exit(0);
}

if (command === 'serve') {
  const { config, effectiveIncludeProjects, configPath } = loadCliConfig();
  startServer(config, effectiveIncludeProjects, buildReportData, configPath);
} else {
  // report command (default)
  const period = args[1] || 'daily';
  const isWorkMode = args.includes('--work');
  const isBossMode = args.includes('--boss');
  const isBrief = args.includes('--brief');
  const noBrand = args.includes('--no-brand');
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
    gitStats = await finalizeGitStats(gitStats, sessions, {
      attribution: config.aiAttribution,
      stepTracking: config.stepTracking,
      attributionSessions: buildAttributionContextSessions(records, {
        start,
        backDays: config.aiAttribution?.windows?.crossDayWindowDays,
        projectBases: new Set(filtered.map(r => (r.project || '').replace(/\\/g, '/').replace(/\/$/, '').split('/').pop()).filter(Boolean)),
      }),
      excludeFilePatterns: config.excludeFilePatterns,
    });
  }

  // 上一周期数据（用于工作汇报环比）
  const prevRange = computePrevPeriodRange(period, dateArg);
  const prevFiltered = records.filter(r => {
    if (!r.timestamp) return false;
    const date = r.timestamp.slice(0, 10);
    return date >= prevRange.start && date <= prevRange.end;
  });
  const prevStats = prevFiltered.length > 0 ? computeUsageStats(prevFiltered, config.scenarioKeywords, config.costMode) : null;

  const report = isBossMode
    ? generateBossReport(usageStats, gitStats, period, start, end, prevStats)
    : isWorkMode
      ? generateWorkReport(usageStats, gitStats, period, start, end, prevStats, { level: isBrief ? 'brief' : 'detailed' })
      : generateReport(usageStats, gitStats, period, start, end);
  if (isWorkMode && !noBrand && config.branding?.workReport !== false) {
    console.log(report + workReportFooter('default'));
  } else {
    console.log(report);
  }
}

function fmtNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

