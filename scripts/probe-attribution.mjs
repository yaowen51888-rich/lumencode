#!/usr/bin/env node
// 一次性测量脚本：dump commit↔session 归因分布（sessionAttribution 四级 + classification + weak 明细）
// 用途：P1 grilling——量化现状归因准确率，判断 embedding 是否值得投入
// 用法：node scripts/probe-attribution.mjs [period] [date]   period: daily|weekly|monthly  默认 monthly
import { loadConfig } from '../lib/config.js';
import { parseAllEnabledTools } from '../lib/parsers/index.js';
import { registerAllParsers } from '../lib/parsers/register.js';
import { filterRecordsByPeriod, groupBySessions } from '../lib/aggregate.js';
import { getGitStatsForMultipleReposAsync, finalizeGitStats } from '../lib/git.js';

registerAllParsers();

const period = process.argv[2] || 'monthly';
const dateArg = process.argv[3] || new Date().toISOString().slice(0, 10);

const config = loadConfig();

const { records, toolBreakdown } = await parseAllEnabledTools(config, {
  excludeProjects: config.excludeProjects,
  includeProjects: config._autoRepos || undefined,
});
if (records.length === 0) {
  console.log('无 usage 记录，无法测量归因。');
  process.exit(1);
}

const { filtered, start, end } = filterRecordsByPeriod(records, period, dateArg);
console.log(`周期 ${period} (${start} ~ ${end})：${filtered.length} 条记录，工具 ${Object.keys(toolBreakdown || {}).join(',')}`);

if (!config.repos || config.repos.length === 0) {
  console.log('config.repos 为空，无 git 数据可归因。');
  process.exit(1);
}

const sessions = groupBySessions(filtered);
let gs = await getGitStatsForMultipleReposAsync(config.repos, start, end + 'T23:59:59');
gs = await finalizeGitStats(gs, sessions, {
  attribution: config.aiAttribution,
  stepTracking: config.stepTracking,
});

const commits = gs.commitList || [];
console.log(`\n=== commit 总数：${commits.length} ===`);

// ── 1. sessionAttribution 分布 ──
const bucket = {};
for (const c of commits) {
  const k = c.sessionAttribution || 'null';
  bucket[k] = (bucket[k] || 0) + 1;
}
console.log('\n=== sessionAttribution 分布 ===');
for (const [k, v] of Object.entries(bucket).sort((a, b) => b[1] - a[1])) {
  const pct = ((v / commits.length) * 100).toFixed(1);
  console.log(`  ${k.padEnd(16)} ${v}  (${pct}%)`);
}

// ── 2. classification 分布（attributionSummary） ──
console.log('\n=== attributionSummary（classification） ===');
const s = gs.attributionSummary || {};
const cls = ['confirmedAI', 'probableAI', 'possibleAI', 'unknown', 'human'];
for (const k of cls) {
  if (s[k]) console.log(`  ${k.padEnd(14)} commits=${s[k]}  lines=${s[k + 'Lines']}`);
}
console.log(`  totalItems=${s.totalItems} totalLines=${s.totalLinesChanged}`);
if (s.unknownReasons?.length) console.log(`  unknownReasons=${s.unknownReasons.join(',')}`);

// ── 3. weak / cross-day-weak 明细（embedding 唯一能改善的模糊地带） ──
const fuzzy = commits.filter(c => c.sessionAttribution === 'weak' || c.sessionAttribution === 'cross-day-weak');
console.log(`\n=== 模糊归因明细（weak + cross-day-weak）：${fuzzy.length} 条 ===`);
console.log('（这些是 embedding 唯一能改善的对象；strong 它无能为益）\n');
for (const c of fuzzy.slice(0, 40)) {
  const subj = (c.subject || '').slice(0, 50);
  console.log(`  [${c.sessionAttribution}] ${c.sessionId || '-'} | ${subj} | +${c.linesAdded || 0}/-${c.linesDeleted || 0}`);
}
if (fuzzy.length > 40) console.log(`  ... 还有 ${fuzzy.length - 40} 条`);
