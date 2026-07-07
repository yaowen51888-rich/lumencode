// 逻辑安全 bench：复刻 buildReportData 各阶段，performance.now() 计时。
// 不改任何业务代码，纯导入测量。monthly（最大窗口=最坏 compute）。
import { performance } from 'perf_hooks';
import { loadConfig } from '../lib/config.js';
import { detectClaudeDir, deriveProjectPaths } from '../lib/parser.js';
import { parseAllEnabledTools } from '../lib/parsers/index.js';
import { registerAllParsers } from '../lib/parsers/register.js';
registerAllParsers();
import { preloadUnknownPricing } from '../lib/pricing-loader.js';
import {
  computeUsageStats, filterRecordsByPeriod, groupBySessions,
  computeTrendData, computePrevPeriodRange, normalizeProjectPath,
} from '../lib/aggregate.js';
import { getGitStatsForMultipleReposAsync, finalizeGitStats } from '../lib/git.js';

const ms = (t) => `${t.toFixed(0).padStart(5)} ms`;
const now = () => performance.now();
const today = (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`; })();

// ── 1. 加载 config（复刻 loadCliConfig 的零配置推导）──
let config = loadConfig();
if (!config.claudeDir || config.claudeDir === '') config.claudeDir = detectClaudeDir() || config.claudeDir;
if ((!config.repos || config.repos.length === 0) && config.claudeDir) {
  try { config.repos = deriveProjectPaths(config.claudeDir, config.excludeProjects || []); } catch {}
}
console.log(`claudeDir: ${config.claudeDir}`);
console.log(`repos: ${(config.repos || []).length} 个 → ${(config.repos || []).slice(0, 5).join(', ')}`);
console.log(`period: monthly  date: ${today}\n${'─'.repeat(50)}`);

const includeProjects = (config.repos && config.repos.length > 0)
  ? config.repos.map(r => normalizeProjectPath(r)) : null;

// ── 2. 冷解析（cache.js 空）──
let t = now();
const cold = await parseAllEnabledTools(config, { excludeProjects: config.excludeProjects, includeProjects });
const tColdParse = now() - t;
console.log(`parse (COLD)        ${ms(tColdParse)}   records=${cold.records.length}`);

// ── 3. 热解析（cache.js 命中，仅 dedup+sort 重建）──
t = now();
const warm = await parseAllEnabledTools(config, { excludeProjects: config.excludeProjects, includeProjects });
const tWarmParse = now() - t;
console.log(`parse (WARM)        ${ms(tWarmParse)}   records=${warm.records.length}`);

const { records, toolBreakdown } = warm;

// ── 4. pricing 预加载（可能触发网络，含在总耗时里）──
t = now();
await preloadUnknownPricing(records);
const tPricing = now() - t;
console.log(`preloadPricing      ${ms(tPricing)}`);

// ── 5. 周期过滤（monthly）──
t = now();
const { filtered, start, end } = filterRecordsByPeriod(records, 'monthly', today);
const tFilter = now() - t;
console.log(`filterRecords       ${ms(tFilter)}    窗口=${start}~${end} filtered=${filtered.length}`);

// ── 6. computeUsageStats（主成本，含 scenarios/cost 多 pass）──
t = now();
const usageStats = computeUsageStats(filtered, config.scenarioKeywords, config.costMode);
const tCompute = now() - t;
console.log(`computeUsageStats   ${ms(tCompute)}   requests=${usageStats.requestCount}`);

// ── 7. groupBySessions（collectPathValues 重活）──
t = now();
const sessions = groupBySessions(filtered);
const tSessions = now() - t;
console.log(`groupBySessions     ${ms(tSessions)}   sessions=${sessions.length}`);

// ── 8. trendData（28-180 天扫描）──
t = now();
const trendData = computeTrendData(records, 'monthly', today);
const tTrend = now() - t;
console.log(`computeTrendData    ${ms(tTrend)}`);

// ── 9. prevStats（再算一遍 computeUsageStats）──
t = now();
const prevRange = computePrevPeriodRange('monthly', today);
const prevFiltered = records.filter(r => {
  if (!r.timestamp) return false;
  const d = r.timestamp.slice(0, 10);
  return d >= prevRange.start && d <= prevRange.end;
});
const prevStats = prevFiltered.length > 0 ? computeUsageStats(prevFiltered, config.scenarioKeywords, config.costMode) : null;
const tPrev = now() - t;
console.log(`prevStats           ${ms(tPrev)}    prevRecords=${prevFiltered.length}`);

// ── 10. git（仅 repos 配置时）──
if (config.repos && config.repos.length > 0) {
  const extendedEnd = new Date(end); extendedEnd.setDate(extendedEnd.getDate() + 2);
  const extendedEndStr = extendedEnd.toISOString().slice(0, 10) + 'T23:59:59';
  t = now();
  let gs = await getGitStatsForMultipleReposAsync(config.repos, start, extendedEndStr);
  const tGitFetch = now() - t;
  t = now();
  gs = await finalizeGitStats(gs, sessions, { attribution: config.aiAttribution, stepTracking: config.stepTracking });
  const tGitFinalize = now() - t;
  console.log(`git fetch           ${ms(tGitFetch)}   commits=${gs?.commitList?.length || 0}`);
  console.log(`git finalize        ${ms(tGitFinalize)}`);
}

console.log('─'.repeat(50));
