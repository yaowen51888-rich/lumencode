#!/usr/bin/env node
// 一次性测量脚本：量化 P0 行级归因降级率（v3，读 step-tracker 内部计数）
// 读 commit.lineBlame.alignedFiles/degradedFiles（step-tracker.js getLineAttributionForCommit 产出）
// 用法：node scripts/probe-line-degradation.mjs [period] [date]  默认 monthly
import { loadConfig } from '../lib/config.js';
import { parseAllEnabledTools } from '../lib/parsers/index.js';
import { registerAllParsers } from '../lib/parsers/register.js';
import { filterRecordsByPeriod, groupBySessions } from '../lib/aggregate.js';
import { getGitStatsForMultipleReposAsync, finalizeGitStats } from '../lib/git.js';

registerAllParsers();

const period = process.argv[2] || 'monthly';
const dateArg = process.argv[3] || new Date().toISOString().slice(0, 10);
const config = loadConfig();

const { records } = await parseAllEnabledTools(config, {
  excludeProjects: config.excludeProjects,
  includeProjects: config._autoRepos || undefined,
});
if (records.length === 0) { console.log('无 usage 记录。'); process.exit(1); }

const { filtered, start, end } = filterRecordsByPeriod(records, period, dateArg);
console.log(`周期 ${period} (${start} ~ ${end})：${filtered.length} 条记录`);
if (!config.repos?.length) { console.log('config.repos 为空。'); process.exit(1); }

const sessions = groupBySessions(filtered);
let gs = await getGitStatsForMultipleReposAsync(config.repos, start, end + 'T23:59:59');
gs = await finalizeGitStats(gs, sessions, { attribution: config.aiAttribution, stepTracking: config.stepTracking });

const commits = gs.commitList || [];
let withBlame = 0, withoutBlame = 0;
let totAligned = 0, totDegraded = 0;
let totDrift = 0, totNoContent = 0, totNoAdded = 0, totFuzzy = 0;

console.log(`\n=== commit 总数：${commits.length} ===`);
for (const c of commits) {
  if (c.lineBlame) {
    withBlame++;
    totAligned += c.lineBlame.alignedFiles || 0;
    totDegraded += c.lineBlame.degradedFiles || 0;
    totFuzzy += c.lineBlame.fuzzyFiles || 0;
    totDrift += c.lineBlame.degradedDrift || 0;
    totNoContent += c.lineBlame.degradedNoContent || 0;
    totNoAdded += c.lineBlame.degradedNoAdded || 0;
  } else {
    withoutBlame++;
  }
}

console.log(`\n=== 行级归因覆盖 ===`);
console.log(`  有 lineBlame(行级归因命中)  ${withBlame}  (${(withBlame/(commits.length||1)*100).toFixed(1)}%)`);
console.log(`  无 lineBlame(未命中)        ${withoutBlame}  (${(withoutBlame/(commits.length||1)*100).toFixed(1)}%)`);

const proj = totAligned + totFuzzy + totDegraded;
const hitPct = (totAligned + totFuzzy) / (proj || 1) * 100;
console.log(`\n=== 逐行投影 vs fuzzy vs 比例法（共 ${proj} 个文件） ===`);
console.log(`  aligned(精确投影)  ${totAligned}  (${(totAligned/(proj||1)*100).toFixed(1)}%)`);
console.log(`  fuzzy(drift投影)   ${totFuzzy}  (${(totFuzzy/(proj||1)*100).toFixed(1)}%)`);
console.log(`  degraded(比例法)   ${totDegraded}  (${(totDegraded/(proj||1)*100).toFixed(1)}%)`);
console.log(`  ★ 逐行命中(aligned+fuzzy) ${totAligned + totFuzzy}/${proj} = ${hitPct.toFixed(1)}%`);
if (totDegraded > 0) {
  console.log(`\n=== 降级主因细分（fuzzy 仅救 drift） ===`);
  console.log(`  drift(内容漂移)    ${totDrift}  (${(totDrift/(totDegraded||1)*100).toFixed(1)}%)  ← fuzzy 内容对齐可救`);
  console.log(`  noContent          ${totNoContent}  (${(totNoContent/(totDegraded||1)*100).toFixed(1)}%)  ← git/step 取不到内容`);
  console.log(`  noAdded            ${totNoAdded}  (${(totNoAdded/(totDegraded||1)*100).toFixed(1)}%)  ← 纯删除/addedLines 解析失败`);
}

console.log(`\n=== 结论判读 ===`);
if (proj === 0) console.log('  → 无文件进入行级归因（steps.db 无匹配 / stepTracking 未启用）');
else if (hitPct < 20) console.log(`  → 逐行命中率仅 ${hitPct.toFixed(1)}%，行级归因近乎失效，根因待查`);
else if (hitPct < 60) console.log(`  → 逐行命中率 ${hitPct.toFixed(1)}%，中等`);
else console.log(`  → 逐行命中率 ${hitPct.toFixed(1)}%，行级归因健康`);
