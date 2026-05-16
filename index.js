#!/usr/bin/env node
import { loadConfig, initConfig, getConfigPath } from './lib/config.js';
import { collectAllRecords, computeUsageStats, filterRecordsByPeriod, normalizeProjectPath, computeTrendData } from './lib/aggregate.js';
import { getGitStatsForMultipleReposAsync, invalidateGitCache } from './lib/git.js';
import { invalidateFileCache } from './lib/cache.js';
import { generateReport, generateWorkReport } from './lib/report.js';
import { startServer } from './lib/server.js';

const args = process.argv.slice(2);
const command = args[0];

function loadCliConfig() {
  const config = loadConfig();

  // 日期参数：跳过 -- 开头的选项，取第一个非选项参数
  let dateArg = new Date().toISOString().slice(0, 10);
  for (let i = 2; i < args.length; i++) {
    if (!args[i].startsWith('--')) {
      dateArg = args[i];
      break;
    }
  }

  // 解析 --projects 参数
  let includeProjects = null;
  const projectsIdx = args.indexOf('--projects');
  if (projectsIdx !== -1 && args[projectsIdx + 1]) {
    includeProjects = args[projectsIdx + 1].split(',').map(p => p.trim());
  }

  // 如果没有命令行指定 includeProjects，尝试从 repos 推导
  let effectiveIncludeProjects = includeProjects;
  if (!effectiveIncludeProjects && config.repos && config.repos.length > 0) {
    effectiveIncludeProjects = config.repos.map(r => normalizeProjectPath(r));
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
  const usageStats = computeUsageStats(filtered, config.scenarioKeywords);

  let gitStats = null;
  if (config.repos && config.repos.length > 0) {
    gitStats = await getGitStatsForMultipleReposAsync(config.repos, start, end + 'T23:59:59');
  }

  const trendData = computeTrendData(records, period, dateArg);
  return { usageStats, gitStats, start, end, trendData };
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

示例:
  ccusage-report report daily 2026-05-15
  ccusage-report report daily --projects D://fzwork
  ccusage-report report weekly 2026-05-15 --projects D://fzwork,E://play/idea
  ccusage-report report daily --work
  ccusage-report serve
  ccusage-report init
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

  console.log(`已加载 ${records.length} 条记录，${Object.keys(projects).length} 个项目`);

  const { filtered, start, end } = filterRecordsByPeriod(records, period, dateArg);
  console.log(`筛选 ${period} 数据: ${start} ~ ${end}，共 ${filtered.length} 条记录`);

  const usageStats = computeUsageStats(filtered, config.scenarioKeywords);

  let gitStats = null;
  if (config.repos && config.repos.length > 0) {
    console.log('正在统计 Git 指标...');
    gitStats = await getGitStatsForMultipleReposAsync(config.repos, start, end + 'T23:59:59');
  }

  const report = isWorkMode
    ? generateWorkReport(usageStats, gitStats, period, start, end)
    : generateReport(usageStats, gitStats, period, start, end);
  console.log(report);
}
