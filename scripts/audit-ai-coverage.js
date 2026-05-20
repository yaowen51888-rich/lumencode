#!/usr/bin/env node
/**
 * AI 提交检测覆盖度审计脚本
 * 运行: node scripts/audit-ai-coverage.js
 */
import { execSync } from 'child_process';
import { loadConfig } from '../lib/config.js';

const config = loadConfig();

function auditRepo(repoPath) {
  console.log(`\n=== 审计仓库: ${repoPath} ===\n`);

  // 1. 获取所有提交消息
  const log = execSync(
    'git log --format="%H|%s|%an|%ae|%b" --all -n 200',
    { cwd: repoPath, encoding: 'utf-8', stdio: 'pipe' }
  );

  const commits = log.trim().split('\n').map(line => {
    const [hash, subject, author, email] = line.split('|');
    return { hash: hash.slice(0, 8), subject, author, email };
  });

  // 2. 当前检测能捕获的
  const currentPatterns = [
    /Co-Authored-By:\s*Claude/i,
    /Generated\s+with[\s\S]*Claude/i,
    /🤖\s*Generated/i,
    /Assisted-By:\s*Claude/i,
    /Co-Authored-By:\s*Copilot/i,
    /Co-Authored-By:\s*Cursor/i,
    /Generated\s+with[\s\S]*Aider/i,
  ];

  const detected = [];
  const missed = [];

  for (const c of commits) {
    const haystack = `${c.subject} ${c.author} ${c.email}`.toLowerCase();
    const isAI = currentPatterns.some(re => re.test(haystack));
    if (isAI) {
      detected.push(c);
    } else {
      // 检查是否可能是 AI 提交但未检测到
      const possibleAI = /\b(ai|claude|gpt|copilot|cursor|codex|aider|gemini|windsurf|tabnine|codeium|deepseek|llm|assistant)\b/i.test(haystack) ||
                         /\b(generated|assisted|co-authored|🤖|📝|✨)\b/i.test(c.subject);
      if (possibleAI) {
        missed.push(c);
      }
    }
  }

  console.log(`总提交数: ${commits.length}`);
  console.log(`当前检测到的 AI 提交: ${detected.length}`);
  console.log(`可能漏检的 AI 提交: ${missed.length}`);
  console.log(`漏检率: ${missed.length > 0 ? ((missed.length / (detected.length + missed.length)) * 100).toFixed(1) : 0}%`);

  if (missed.length > 0) {
    console.log('\n--- 可能漏检的提交样例（前 10 条）---');
    for (const c of missed.slice(0, 10)) {
      console.log(`  ${c.hash} | ${c.author} | ${c.subject}`);
    }
  }

  // 3. 作者统计
  const authorCounts = {};
  for (const c of commits) {
    const key = `${c.author} <${c.email}>`;
    authorCounts[key] = (authorCounts[key] || 0) + 1;
  }
  console.log('\n--- 作者分布（前 10）---');
  Object.entries(authorCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([author, count]) => {
      const isAIGuessed = /\b(ai|claude|gpt|bot|noreply|github-actions)\b/i.test(author);
      console.log(`  ${count.toString().padStart(3)} | ${isAIGuessed ? '[可能AI]' : '[人类] '} ${author}`);
    });
}

for (const repo of config.repos || []) {
  try {
    auditRepo(repo);
  } catch (e) {
    console.error(`审计失败: ${repo}`, e.message);
  }
}
