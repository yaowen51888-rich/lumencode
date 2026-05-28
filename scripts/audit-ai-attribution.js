#!/usr/bin/env node
import { loadConfig } from '../lib/config.js';
import { registerParser, parseAllEnabledTools } from '../lib/parsers/index.js';
import { ClaudeParser } from '../lib/parsers/claude.js';
import { groupBySessions } from '../lib/aggregate.js';
import { getGitStatsForMultipleReposAsync, finalizeGitStats } from '../lib/git.js';

registerParser(ClaudeParser);

const config = loadConfig();
const { records } = await parseAllEnabledTools(config);
const sessions = groupBySessions(records);

console.log(`总 session 数: ${sessions.length}`);

// 检查 session 的 touchedFiles
for (const s of sessions.slice(0, 5)) {
  const { extractTouchedFilesFromSession } = await import('../lib/git.js');
  // 直接读取函数（非导出），用替代方式
}

// 直接测试 git 统计
const end = new Date().toISOString();
const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

for (const repo of config.repos || []) {
  try {
    const gitStats = await getGitStatsForMultipleReposAsync([repo], start.slice(0, 10), end);
    const result = await finalizeGitStats(gitStats, sessions);
    console.log(`\n=== ${repo} ===`);
    console.log(`总提交数: ${result.commits}`);
    console.log(`AI 提交数: ${result.aiContribution?.aiCommits || 0}`);
    console.log(`AI 占比: ${((result.aiContribution?.aiRatio || 0) * 100).toFixed(1)}%`);
    console.log(`显式 AI: ${result.aiContribution?.highConfidenceCommits || 0}`);
    console.log(`Session 归因(MEDIUM+HIGH): ${result.aiContribution?.mediumConfidenceCommits || 0}`);
    console.log(`弱归因(LOW): ${result.aiContribution?.lowConfidenceCommits || 0}`);

    // 显示归因样例
    const aiCommits = (result.commitList || []).filter(c => c.isAI).slice(0, 5);
    if (aiCommits.length > 0) {
      console.log('AI 提交样例:');
      for (const c of aiCommits) {
        console.log(`  ${c.hash?.slice(0, 8)} | ${c.attributionType} | ${c.subject?.slice(0, 50)}`);
      }
    }
  } catch (e) {
    console.error(`失败: ${repo}`, e.message);
  }
}
