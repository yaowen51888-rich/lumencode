import { Table } from './table.js';
import { resolveModelPricing } from './pricing-loader.js';

export function generateAutoSummary(usageStats, gitStats, prevStats, period, start, end) {
  const periodName = period === 'daily' ? '今日' : period === 'weekly' ? '本周' : '本月';
  const prevName = period === 'daily' ? '昨日' : period === 'weekly' ? '上周' : '上月';
  const parts = [];

  // 1. 核心指标叙述
  const coreLine = buildCoreNarrative(usageStats, periodName);
  parts.push(coreLine);

  // 2. 环比变化
  if (prevStats) {
    const changeLine = buildChangeNarrative(usageStats, prevStats, periodName, prevName);
    if (changeLine) parts.push(changeLine);
  }

  // 3. 项目亮点
  const projLine = buildProjectNarrative(usageStats, periodName);
  if (projLine) parts.push(projLine);

  // 4. 场景与模型
  const sceneLine = buildSceneNarrative(usageStats, periodName);
  if (sceneLine) parts.push(sceneLine);

  // 5. 缓存效率
  const cacheLine = buildCacheNarrative(usageStats);
  if (cacheLine) parts.push(cacheLine);

  // 6. Git 产出（如有）— 叙事式
  if (gitStats && gitStats.commits > 0) {
    const gitLine = buildGitNarrative(gitStats, periodName);
    parts.push(gitLine);

    // 追加一行的成果摘要
    if (gitStats.commitList?.length) {
      const summary = buildGitSummaryLine(gitStats.commitList);
      if (summary) parts.push(summary);
    }
  }

  return { paragraphs: parts, periodName, prevName };
}

function buildCoreNarrative(stats, periodName) {
  const reqStr = fmtN(stats.requestCount);
  const tokenStr = fmtToken(stats.totalTokens);
  const sessionStr = fmtN(stats.sessionCount);
  const costStr = stats.estimatedCost != null && stats.estimatedCost > 0 ? `$${stats.estimatedCost.toFixed(2)}` : null;
  const projCount = Object.keys(stats.projects).length;

  let line = `${periodName}共发起 ${reqStr} 次 AI 交互（${sessionStr} 个会话），消耗 ${tokenStr} Token`;
  if (projCount > 1) line += `，覆盖 ${projCount} 个项目`;
  if (costStr) line += `，预估费用 ${costStr}`;
  line += '。';
  return line;
}

function buildChangeNarrative(stats, prev, periodName, prevName) {
  const changes = [];

  const reqPct = pctChange(stats.requestCount, prev.requestCount);
  if (reqPct !== null) changes.push(`交互量${formatPct(reqPct)}`);

  const tokenPct = pctChange(stats.totalTokens, prev.totalTokens);
  if (tokenPct !== null) changes.push(`Token 消耗${formatPct(tokenPct)}`);

  const costPct = pctChange(stats.estimatedCost, prev.estimatedCost);
  if (costPct !== null) changes.push(`费用${formatPct(costPct)}`);

  if (changes.length === 0) return null;
  return `相比${prevName}，${changes.join('、')}。`;
}

function buildProjectNarrative(stats, periodName) {
  const projects = Object.entries(stats.projects)
    .filter(([, d]) => d.requests > 0)
    .sort((a, b) => b[1].requests - a[1].requests);
  if (projects.length === 0) return null;

  const totalReqs = projects.reduce((s, [, d]) => s + d.requests, 0);
  const top = projects[0];
  const topPct = Math.round(top[1].requests / totalReqs * 100);
  const topName = simplifyPath(top[0]);

  if (projects.length === 1) {
    return `主要工作集中在 ${topName} 项目，共 ${fmtN(top[1].requests)} 次交互。`;
  }

  const second = projects[1];
  const secondName = simplifyPath(second[0]);
  return `主要工作集中在 ${topName}（占 ${topPct}%）和 ${secondName}（${fmtN(second[1].requests)} 次）。`;
}

function buildSceneNarrative(stats, periodName) {
  const scenarios = Object.entries(stats.scenarios || {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  if (scenarios.length === 0) return null;

  const total = scenarios.reduce((s, [, v]) => s + v, 0);
  const topScenes = scenarios.slice(0, 2).map(([name, count]) => {
    const pct = Math.round(count / total * 100);
    return `${name}（${pct}%）`;
  });
  const sceneStr = topScenes.join('、');

  // 模型信息
  const models = Object.entries(stats.models || {}).sort((a, b) => b[1].count - a[1].count);
  let modelStr = '';
  if (models.length > 0) {
    const topModel = models[0][0].replace('claude-', '');
    const modelPct = Math.round(models[0][1].count / stats.requestCount * 100);
    modelStr = `，以 ${topModel} 模型为主（${modelPct}%）`;
  }

  return `使用场景以 ${sceneStr} 为主${modelStr}。`;
}

function buildCacheNarrative(stats) {
  const total = stats.cacheRead + stats.inputTokens;
  if (total === 0) return null;
  const cacheRate = Math.round(stats.cacheRead / total * 100);
  if (cacheRate < 5) return null;
  return `缓存命中率 ${cacheRate}%，${cacheRate > 60 ? '缓存利用良好' : cacheRate > 30 ? '缓存利用中等' : '可考虑增加上下文复用'}。`;
}

function buildGitNarrative(git, periodName) {
  const parts = [];
  parts.push(`${fmtN(git.commits)} 次提交`);
  if (git.linesAdded > 0 || git.linesDeleted > 0) {
    const net = git.linesAdded - git.linesDeleted;
    parts.push(`+${fmtN(git.linesAdded)}/-${fmtN(git.linesDeleted)} 行`);
    if (net > 0) parts.push(`净增 ${fmtN(net)} 行`);
  }
  if (git.filesChanged > 0) {
    parts.push(`变更 ${fmtN(git.filesChanged)} 个文件`);
  }
  let line = `代码产出：${parts.join('、')}。`;

  // AI 参与度总结（与 UI summary card 对齐）
  if (git.aiContribution && git.commits > 0) {
    const ai = git.aiContribution;
    const totalLines = ai.totalLinesChanged || 1;
    const aiLinePct = Math.round((ai.aiLinesChanged / totalLines) * 100);
    const commitPct = Math.round((ai.aiCommitRatio ?? (ai.aiCommits / git.commits)) * 100);
    const possibleCommitPct = ai.possibleAICommits > 0 ? Math.round((ai.possibleAICommits / git.commits) * 100) : 0;
    const weightedPct = Math.round((ai.weightedAILineRatio || 0) * 100);
    line += ` 高/中置信 AI 提交 ${ai.aiCommits}/${git.commits} (${commitPct}%)，`;
    if (ai.possibleAICommits > 0) {
      line += `可能 AI 提交 ${ai.possibleAICommits} (${possibleCommitPct}%)，`;
    }
    line += `AI 代码改写占比 ${aiLinePct}%`;
    if (weightedPct > aiLinePct) {
      line += `，加权影响力 ${weightedPct}%`;
    }
    line += '。';
  }

  return line;
}

function buildAttributionSummaryLine(summary) {
  if (!summary) return null;
  const total = summary.totalLinesChanged || 0;
  if (total <= 0) return null;
  const confirmedPct = Math.round((summary.confirmedAILines / total) * 100);
  const upperPct = Math.round(((summary.confirmedAILines + summary.probableAILines + summary.possibleAILines) / total) * 100);
  const unknownPct = Math.round((summary.unknownLines / total) * 100);
  let line = `AI 归因汇总：确认 AI ${confirmedPct}% / 可能 AI 上限 ${upperPct}% / 未知 ${unknownPct}%。`;
  if (summary.mergeCommits > 0) {
    line += `（已排除 ${summary.mergeCommits} 个合并提交，共 ${formatInt(summary.mergeCommitLines)} 行）`;
  }
  return line;
}

function buildUnknownReasonLine(summary) {
  if (!summary?.unknownReasons?.length) return null;
  return `未归因原因：${summary.unknownReasons.join('、')}。`;
}

function buildAttributionQualityLine(quality) {
  if (!quality || quality.totalLineBlameCommits <= 0) return null;
  const coveragePct = Math.round((quality.lineCoverage || 0) * 100);
  const parts = [`行级映射覆盖率 ${coveragePct}%`];
  if ((quality.unknownLines || 0) > 0) {
    parts.push(`未知 ${formatInt(quality.unknownLines)} 行`);
  }
  if (quality.confidence === 'low' || quality.confidence === 'none') {
    parts.push('归因置信度较低');
  }
  return `归因质量：${parts.join('，')}。`;
}

// 一行式成果摘要：从 commitList 提取 feat/fix 数量和代表性描述
function buildGitSummaryLine(commitList) {
  const feats = commitList.filter(c => c.type === 'feat');
  const fixes = commitList.filter(c => c.type === 'fix');
  const refactors = commitList.filter(c => c.type === 'refactor');
  const parts = [];
  if (feats.length > 0) {
    const examples = feats.slice(0, 2).map(c => cleanSubject(c.subject, c.scope)).filter(Boolean);
    const suffix = feats.length > 2 ? ` 等 ${feats.length} 项` : '';
    parts.push(`新功能 ${examples.join('、')}${suffix}`);
  }
  if (fixes.length > 0) {
    const examples = fixes.slice(0, 2).map(c => cleanSubject(c.subject, c.scope)).filter(Boolean);
    const suffix = fixes.length > 2 ? ` 等 ${fixes.length} 项` : '';
    parts.push(`修复 ${examples.join('、')}${suffix}`);
  }
  if (refactors.length > 0) {
    parts.push(`重构 ${refactors.length} 处`);
  }
  if (parts.length === 0) return null;
  return `主要工作：${parts.join('；')}。`;
}

// 环比深度对比：项目活跃度变化、会话效率变化
function buildDeepChangeNarrative(curr, prev) {
  const changes = [];

  // 项目活跃度变化
  const currProjects = new Set(Object.keys(curr.projects || {}));
  const prevProjects = new Set(Object.keys(prev.projects || {}));
  const newProjects = [...currProjects].filter(p => !prevProjects.has(p));
  const droppedProjects = [...prevProjects].filter(p => !currProjects.has(p));
  if (newProjects.length > 0) {
    changes.push(`新增活跃项目 ${newProjects.map(simplifyPath).join('、')}`);
  }
  if (droppedProjects.length > 0) {
    changes.push(`${droppedProjects.map(simplifyPath).join('、')} 项目本期无活动`);
  }

  // 会话效率：avg requests per session
  const currAvg = curr.sessionCount > 0 ? (curr.requestCount / curr.sessionCount).toFixed(1) : 0;
  const prevAvg = prev.sessionCount > 0 ? (prev.requestCount / prev.sessionCount).toFixed(1) : 0;
  if (currAvg > 0 && prevAvg > 0) {
    const diff = currAvg - prevAvg;
    if (Math.abs(diff) >= 0.5) {
      changes.push(`会话平均交互 ${currAvg} 次（${diff > 0 ? '↑' : '↓'}${Math.abs(diff).toFixed(1)}）`);
    }
  }

  // Token 效率：output/input ratio
  const currRatio = curr.inputTokens > 0 ? (curr.outputTokens / curr.inputTokens).toFixed(2) : 0;
  const prevRatio = prev.inputTokens > 0 ? (prev.outputTokens / prev.inputTokens).toFixed(2) : 0;
  if (currRatio > 0 && prevRatio > 0) {
    const diff = currRatio - prevRatio;
    if (Math.abs(diff) >= 0.1) {
      changes.push(`输出/输入比 ${currRatio}（${diff > 0 ? '↑' : '↓'}${Math.abs(diff).toFixed(2)}）`);
    }
  }

  if (changes.length === 0) return null;
  return `**效率变化**：${changes.join('；')}。`;
}

// ── Commit 叙事提取 ──

const TYPE_LABELS = {
  feat: '新功能',
  fix: '缺陷修复',
  refactor: '重构',
  perf: '性能优化',
  docs: '文档',
  test: '测试',
  chore: '工程维护',
  style: '代码风格',
  ci: 'CI/CD',
  build: '构建',
  revert: '回退',
  other: '其他',
};

// 从 commitList 生成按 type 分组的叙事
export function buildCommitNarrative(commitList, { projectGroup = false, maxItems = 8 } = {}) {
  if (!commitList?.length) return null;

  const typeOrder = ['feat', 'fix', 'refactor', 'perf', 'docs', 'test', 'chore', 'style', 'ci', 'build', 'revert', 'other'];

  // 按 project 分组（可选）
  if (projectGroup) {
    const byProject = groupBy(commitList, c => c.repo || '');
    const results = [];
    for (const [repo, commits] of byProject) {
      const narrative = buildSingleProjectNarrative(commits, typeOrder, maxItems);
      if (narrative) {
        narrative.project = simplifyPath(repo);
        results.push(narrative);
      }
    }
    return results.length > 0 ? results : null;
  }

  return buildSingleProjectNarrative(commitList, typeOrder, maxItems);
}

function buildSingleProjectNarrative(commitList, typeOrder, maxItems) {
  const byType = groupBy(commitList, c => c.type || 'other');
  const sections = [];

  for (const type of typeOrder) {
    const commits = byType.get(type);
    if (!commits?.length) continue;

    const label = TYPE_LABELS[type] || type;
    const subjects = commits.map(c => cleanSubject(c.subject, c.scope)).filter(Boolean);
    if (subjects.length === 0) continue;

    const display = subjects.slice(0, maxItems);
    const overflow = subjects.length > maxItems ? subjects.length - maxItems : 0;

    sections.push({
      type,
      label,
      count: commits.length,
      items: display,
      overflow,
      aiCount: commits.filter(c => c.isAI).length,
    });
  }

  return sections.length > 0 ? { sections, totalCommits: commitList.length } : null;
}

function cleanSubject(subject, scope) {
  if (!subject) return null;
  // 去掉 conventional commit 前缀
  let s = subject.replace(/^(feat|fix|refactor|docs|test|chore|perf|style|ci|build|revert)(\([^)]+\))?!?:\s*/i, '');
  if (!s.trim()) return null;
  // 去掉 emoji 前缀（覆盖常见 emoji 区块 + Dingbats + Symbols）
  s = s.replace(/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]\s*/u, '').trim();
  // 截断过长 subject
  if (s.length > 60) s = s.slice(0, 57) + '...';
  // 如果有 scope，附加在前面
  if (scope) s = `[${scope}] ${s}`;
  return s;
}

function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

// AI 贡献明细：按 attributionType 拆分 commit，汇总 AI 涉及的文件
export function buildAIContributionDetail(commitList) {
  if (!commitList?.length) return null;

  const explicit = [];    // Co-Authored-By / Generated with
  const sessionStrong = []; // session_strong / session_strong_file_overlap
  const fileOverlap = [];   // session_file_overlap / session_file_overlap_dominant
  const aiFiles = new Set();
  let totalAIFileAdded = 0;
  let totalAIFileDeleted = 0;

  for (const c of commitList) {
    if (c.aiConfidence !== 'high' && c.aiConfidence !== 'medium') continue;
    const subject = cleanSubject(c.subject, c.scope) || c.subject?.slice(0, 40);
    if (!subject) continue;

    if (c.attributionType === 'explicit') {
      explicit.push(subject);
    } else if (c.attributionType?.startsWith('session_strong')) {
      sessionStrong.push(subject);
    } else if (c.attributionType?.startsWith('session_file_overlap')) {
      fileOverlap.push(subject);
    }

    // 汇总 AI 涉及的文件
    const matched = c.aiEvidenceDetails?.matchedFiles || [];
    for (const f of matched) aiFiles.add(f);
    // 对于 explicit 类型，所有文件都算
    if (c.attributionType === 'explicit' && !matched.length) {
      for (const f of c.files || []) aiFiles.add(f.path);
    }

    // 累计文件级行数
    const matchSet = matched.length > 0 ? new Set(matched) : null;
    for (const f of c.files || []) {
      if (!matchSet || matchSet.has(f.path)) {
        totalAIFileAdded += f.added || 0;
        totalAIFileDeleted += f.deleted || 0;
      }
    }
  }

  const total = explicit.length + sessionStrong.length + fileOverlap.length;
  if (total === 0) return null;

  return {
    explicit,
    sessionStrong,
    fileOverlap,
    aiFiles: [...aiFiles].sort(),
    totalAIFileAdded,
    totalAIFileDeleted,
  };
}

function simplifyPath(p) {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

function fmtN(n) {
  if (n >= 10_000) return (n / 10_000).toFixed(1) + '万';
  return n.toLocaleString('zh-CN');
}

// ── 洞察生成器 ──

function buildCoreInsight(stats, periodName) {
  if (stats.requestCount === 0) return null;
  const insights = [];
  const avgPerDay = stats.activeDays > 0 ? (stats.requestCount / stats.activeDays) : 0;
  if (stats.activeDays > 1 && avgPerDay > 30) {
    insights.push(`日均 ${avgPerDay.toFixed(0)} 次交互，使用强度较高`);
  } else if (stats.activeDays > 1 && avgPerDay < 5) {
    insights.push(`日均 ${avgPerDay.toFixed(1)} 次交互，使用频率较低`);
  }
  const outputRatio = stats.totalTokens > 0 ? stats.outputTokens / stats.totalTokens : 0;
  if (outputRatio > 0.6) insights.push('输出 Token 占比偏高，提示词可进一步精炼');
  if (stats.heavySessionCount > 0) {
    insights.push(`${stats.heavySessionCount} 个会话超 100 万 token，建议复查是否 agent 失控或上下文堆积`);
  }
  return insights.length > 0 ? insights.join('；') + '。' : null;
}

function buildProjectInsight(projects) {
  const entries = Object.entries(projects).filter(([, d]) => d.requests > 0);
  if (entries.length < 2) return null;
  const total = entries.reduce((s, [, d]) => s + d.requests, 0);
  const topPct = Math.round((entries[0][1].requests / total) * 100);
  if (topPct > 80) return `工作高度集中于单一项目（${simplifyPath(entries[0][0])}，${topPct}%），可考虑是否需要多项目并行。`;
  if (entries.length >= 4) return `涉及 ${entries.length} 个项目，注意上下文切换对效率的影响。`;
  return null;
}

function buildScenarioInsight(scenarios) {
  const entries = Object.entries(scenarios).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  const total = entries.reduce((s, [, v]) => s + v, 0);
  const topName = entries[0][0];
  const topPct = Math.round((entries[0][1] / total) * 100);
  if (topPct > 70) return `使用场景以${topName}为绝对主导（${topPct}%），可拓展其他场景以提升 AI 辅助覆盖面。`;
  // 检查是否有编码+研究组合
  const names = new Set(entries.map(([k]) => k));
  if (names.has('编码') && names.has('阅读/研究') && entries.length >= 3) {
    return '编码与研读均衡，AI 在理解与实现两个环节均有参与。';
  }
  return null;
}

function buildGitInsight(git) {
  if (!git || git.commits === 0) return null;
  const insights = [];
  if (git.aiContribution) {
    const ai = git.aiContribution;
    const ratio = ai.aiCommitRatio ?? (ai.aiCommits ? ai.aiCommits / git.commits : 0);
    const commitPct = Math.round(ratio * 100);
    const possiblePct = Math.round((ai.possibleAICommitRatio || 0) * 100);
    if (!isNaN(commitPct)) {
      if (commitPct > 80) insights.push('AI 参与度极高，核心代码产出几乎全程 AI 辅助');
      else if (commitPct > 50) insights.push('AI 参与度较高，超过半数提交有 AI 辅助');
      else if (commitPct > 0) insights.push(`高/中置信 AI 参与 ${commitPct}% 的提交，人机协作比例适中`);
      else if (possiblePct > 0) insights.push(`无高/中置信 AI 提交，但 ${possiblePct}% 提交可能受 AI 影响`);
    }
  }
  const netLines = git.linesAdded - git.linesDeleted;
  if (git.linesAdded > 0) {
    const addDelRatio = git.linesDeleted > 0 ? (git.linesAdded / git.linesDeleted).toFixed(1) : null;
    if (addDelRatio && parseFloat(addDelRatio) > 3) insights.push('以新增代码为主，处于功能开发阶段');
    else if (addDelRatio && parseFloat(addDelRatio) < 1) insights.push('删除多于新增，可能处于重构或清理阶段');
  }
  return insights.length > 0 ? insights.join('；') + '。' : null;
}

/**
 * 效率指标板块——量化投入产出比
 */
function buildEfficiencyMetrics(usageData, gitData) {
  const lines = [];
  const metrics = [];
  const reqCount = usageData.requestCount || 0;
  // ponytail: 分母优先 AI 归因行，回退总行；AI 行更能反映真实单价
  const aiLines = gitData?.aiContribution?.aiLinesAdded || gitData?.linesAdded || 0;

  // 样本量不足时不生成效率指标
  if (reqCount < 5) return null;

  // 1. 交互效率：每次交互的产出
  if (gitData && reqCount > 0) {
    const commits = gitData.commits || 0;
    const linesAdded = gitData.linesAdded || 0;
    const filesChanged = gitData.filesChanged || 0;

    if (commits > 0) {
      const reqsPerCommit = Math.round(reqCount / commits);
      metrics.push(`- **交互/提交比**：${reqsPerCommit}:1（每 ${reqsPerCommit} 次交互产出 1 次提交）`);
    }
    if (linesAdded > 0) {
      const linesPerReq = (linesAdded / reqCount).toFixed(1);
      metrics.push(`- **每次交互新增**：${linesPerReq} 行`);
    }
    if (filesChanged > 0 && commits > 0) {
      const filesPerCommit = (filesChanged / commits).toFixed(1);
      metrics.push(`- **每次提交变更**：${filesPerCommit} 个文件`);
    }
  }

  // 2. 成本效率
  if (usageData.estimatedCost && usageData.estimatedCost > 0) {
    if (reqCount > 0) {
      const costPerReq = (usageData.estimatedCost / reqCount).toFixed(3);
      metrics.push(`- **每次交互成本**：$${costPerReq}`);
    }
    if (aiLines > 0) {
      const costPerK = (usageData.estimatedCost / (aiLines / 1000)).toFixed(2);
      metrics.push(`- **每千行 AI 代码成本**：$${costPerK}`);
    }
    if (usageData.cacheSaving > 0) {
      // 分母用「潜在总成本」（无缓存时本该花 = 实际花费 + 节省），占比必 <100%，语义清晰
      const potential = usageData.estimatedCost + usageData.cacheSaving;
      const pct = ((usageData.cacheSaving / potential) * 100).toFixed(1);
      metrics.push(`- **缓存命中节省**：$${usageData.cacheSaving.toFixed(2)}（潜在成本降低 ${pct}%）`);
    }
  }

  // 3. 日均产出
  if (usageData.activeDays > 0) {
    const dailyMetrics = [];
    if (reqCount > 0) {
      dailyMetrics.push(`日均 ${Math.round(reqCount / usageData.activeDays)} 次交互`);
    }
    if (gitData) {
      if (gitData.commits > 0) {
        dailyMetrics.push(`${(gitData.commits / usageData.activeDays).toFixed(1)} 次提交`);
      }
      if (gitData.linesAdded > 0) {
        dailyMetrics.push(`+${Math.round(gitData.linesAdded / usageData.activeDays)} 行`);
      }
    }
    if (dailyMetrics.length > 0) {
      metrics.push(`- **日均产出**：${dailyMetrics.join('，')}`);
    }
  }

  // 4. Token 效率
  if (usageData.outputTokens > 0 && reqCount > 0) {
    const outputPerReq = (usageData.outputTokens / reqCount).toFixed(0);
    metrics.push(`- **每次交互输出**：${Number(outputPerReq).toLocaleString('zh-CN')} Token`);
  }

  if (metrics.length === 0) return null;

  for (const m of metrics) lines.push(m);

  // 效率洞察
  const insights = [];
  if (gitData && gitData.commits > 0 && reqCount > 0) {
    const ratio = reqCount / gitData.commits;
    if (ratio < 5) {
      insights.push('交互-提交转化率极高，说明需求明确、AI 理解准确，**沟通效率优秀**。');
    } else if (ratio > 20) {
      insights.push('交互-提交比较高，说明有较多的**探索和调试**过程——这在复杂任务中是正常的，但可以评估是否通过更精确的提示词降低无效交互。');
    }
  }
  if (usageData.estimatedCost && aiLines > 0) {
    const costPerAILine = usageData.estimatedCost / aiLines;
    if (costPerAILine > 0.1) {
      insights.push(`每 AI 行成本 $${costPerAILine.toFixed(3)}，属于较高水平——通常意味着在做架构设计或复杂逻辑，而非批量生成。`);
    } else if (costPerAILine < 0.01 && aiLines > 100) {
      insights.push(`每 AI 行成本仅 $${costPerAILine.toFixed(4)}，AI 辅助的**批量生成效率很高**。`);
    }
  }

  if (insights.length > 0) {
    lines.push('');
    for (const ins of insights) {
      lines.push(`> ${ins}`);
    }
  }

  lines.push('');
  return lines;
}

/**
 * 简报一句话结论——提炼本期最核心的结论
 */
function buildBriefConclusion(usageData, gitData) {
  const parts = [];

  // 产出维度
  if (gitData && gitData.commits > 0) {
    const featCount = (gitData.commitList || []).filter(c => {
      const s = (c.subject || c.message || '').toLowerCase();
      return s.startsWith('feat') || s.startsWith('feature');
    }).length;
    const fixCount = (gitData.commitList || []).filter(c => {
      const s = (c.subject || c.message || '').toLowerCase();
      return s.startsWith('fix') || s.startsWith('bug');
    }).length;

    if (featCount > 0 && fixCount > 0) {
      parts.push(`交付 ${featCount} 个新功能、修复 ${fixCount} 个缺陷`);
    } else if (featCount > 0) {
      parts.push(`交付 ${featCount} 个新功能`);
    } else if (fixCount > 0) {
      parts.push(`修复 ${fixCount} 个缺陷`);
    }
  }

  // AI 参与维度
  if (gitData?.aiContribution) {
    const aiPct = Math.round(((gitData.aiContribution.aiLineRatio ?? gitData.aiContribution.aiRatio) || 0) * 100);
    if (aiPct >= 80) {
      parts.push('AI 深度参与开发（占比 ' + aiPct + '%）');
    } else if (aiPct >= 50) {
      parts.push('AI 辅助占比 ' + aiPct + '%');
    }
  }

  // 成本维度
  if (usageData.estimatedCost && usageData.estimatedCost > 0) {
    if (usageData.activeDays > 0) {
      const dailyCost = usageData.estimatedCost / usageData.activeDays;
      if (dailyCost >= 50) {
        parts.push('日均费用 $' + dailyCost.toFixed(0) + '，投入强度高');
      } else if (dailyCost >= 10) {
        parts.push('日均费用 $' + dailyCost.toFixed(0));
      }
    }
  }

  if (parts.length === 0) return null;
  return '> ' + parts.join('，') + '。';
}

/**
 * 简报环比方向性结论——从数据变化中提炼方向判断
 */
function buildBriefDirection(usageData, prevData, gitData) {
  if (!prevData) return null;

  const conclusions = [];

  // 交互效率：交互量变化 vs 产出变化
  const reqPct = pctChange(usageData.requestCount, prevData.requestCount);
  const costPct = pctChange(usageData.estimatedCost, prevData.estimatedCost);

  // 如果交互量下降但成本上升 → 单次交互变贵了
  if (reqPct !== null && costPct !== null) {
    const reqDown = reqPct < -10;
    const costUp = costPct > 10;
    if (reqDown && costUp) {
      conclusions.push('交互量下降但费用上升，单次交互成本增加——可能使用了更贵的大模型');
    }
  }

  // 产出效率
  if (gitData && gitData.commits > 0 && usageData.requestCount > 0) {
    const commitsPerReq = gitData.commits / usageData.requestCount;
    if (commitsPerReq >= 0.1) {
      const reqsPerCommit = Math.round(1 / commitsPerReq);
      const efficiency = reqsPerCommit <= 10 ? '良好' : reqsPerCommit <= 30 ? '中等' : '偏低';
      conclusions.push(`每 ${reqsPerCommit} 次交互产出 1 次提交，交互-产出转化率${efficiency}`);
    }
  }

  if (conclusions.length === 0) return null;
  return conclusions.length > 0 ? conclusions.join('；') : null;
}

function buildCostInsight(stats) {
  if (!stats.estimatedCost || stats.estimatedCost <= 0) return null;
  if (stats.activeDays > 0) {
    const dailyCost = stats.estimatedCost / stats.activeDays;
    if (dailyCost > 10) return '日均费用较高，建议关注高消耗模型的使用场景优化。';
    if (dailyCost < 1) return '日均费用较低，AI 辅助工具的性价比表现良好。';
  }
  return null;
}

/**
 * 成本结构分析——按模型/按项目/按天的成本拆解
 */
function buildCostStructureAnalysis(usageData) {
  if (!usageData.estimatedCost || usageData.estimatedCost <= 0) return null;

  const lines = [];

  // ── 按模型拆解 ──
  if (usageData.models && Object.keys(usageData.models).length > 0) {
    const modelCosts = Object.entries(usageData.models)
      .filter(([, m]) => (m.cost || 0) > 0)
      .sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0));

    if (modelCosts.length > 0) {
      lines.push('**费用构成（按模型）**：');
      const totalCost = usageData.estimatedCost;
      const fuzzyPriced = []; // [model, 实际计价 key]
      for (const [model, data] of modelCosts.slice(0, 5)) {
        const cost = data.cost || 0;
        const pct = Math.round((cost / totalCost) * 100);
        const outputTokens = data.outputTokens || 0;
        const outputK = outputTokens >= 1000 ? (outputTokens / 1000).toFixed(1) + 'K' : String(outputTokens);
        const pricing = resolveModelPricing(model);
        const estMark = pricing.fuzzy ? '，估算价' : '';
        if (pricing.fuzzy) fuzzyPriced.push([model, pricing.fuzzyKey]);
        lines.push(`- **${model}**：$${cost.toFixed(2)}（${pct}%，输出 ${outputK} Token${estMark}）`);
      }
      if (fuzzyPriced.length > 0) {
        const detail = fuzzyPriced.map(([m, k]) => `${m} 按 ${k} 计价`).join('；');
        lines.push(`> 估算价说明：以下模型未在定价表中精确命中，费用按相近模型估算——${detail}。如需精确计费，可在 \`data/pricing.json\` 的 \`overrides\` 中添加 \`aliasOf\` 映射。`);
      }
      // 集中度判断
      if (modelCosts.length >= 2) {
        const topPct = Math.round(((modelCosts[0][1].cost || 0) / totalCost) * 100);
        if (topPct >= 80) {
          lines.push(`> 费用高度集中在 ${modelCosts[0][0]}（${topPct}%），可评估是否有更经济的模型替代部分场景。`);
        } else if (topPct >= 60) {
          lines.push(`> ${modelCosts[0][0]} 占 ${topPct}% 费用，其余 ${modelCosts.length - 1} 个模型分担 ${100 - topPct}%。`);
        }
      }
      lines.push('');
    }
  }

  // ── 按项目拆解 ──
  const projects = Object.entries(usageData.projects || {})
    .filter(([, d]) => (d.estimatedCost || 0) > 0)
    .sort((a, b) => (b[1].estimatedCost || 0) - (a[1].estimatedCost || 0));
  if (projects.length > 1) {
    lines.push('**费用分配（按项目）**：');
    const totalCost = usageData.estimatedCost;
    for (const [proj, data] of projects) {
      const cost = data.estimatedCost || 0;
      const pct = Math.round((cost / totalCost) * 100);
      lines.push(`- **${simplifyPath(proj)}**：$${cost.toFixed(2)}（${pct}%）`);
    }
    lines.push('');
  }

  // ── 按天波动 ──
  if (usageData.dailyStats && Object.keys(usageData.dailyStats).length >= 3) {
    const dailyEntries = Object.entries(usageData.dailyStats)
      .map(([date, ds]) => ({ date, cost: ds.estimatedCost || 0, requests: ds.requests || 0 }))
      .filter(d => d.cost > 0)
      .sort((a, b) => a.date.localeCompare(b.date));

    if (dailyEntries.length >= 3) {
      const avgCost = dailyEntries.reduce((s, d) => s + d.cost, 0) / dailyEntries.length;
      const maxDay = dailyEntries.reduce((a, b) => a.cost > b.cost ? a : b);
      const minDay = dailyEntries.reduce((a, b) => a.cost < b.cost ? a : b);
      const volatility = avgCost > 0 ? ((maxDay.cost - minDay.cost) / avgCost * 100).toFixed(0) : 0;

      lines.push('**费用波动**：');
      lines.push(`- 日均 $${avgCost.toFixed(2)}，最高 ${maxDay.date}（$${maxDay.cost.toFixed(2)}），最低 ${minDay.date}（$${minDay.cost.toFixed(2)}），波动幅度 ${volatility}%`);

      if (parseFloat(volatility) > 200) {
        lines.push('> 日费用波动极大，可能存在偶发性大批量任务。建议排查高峰日的具体工作内容，评估是否可以分散执行。');
      } else if (parseFloat(volatility) > 100) {
        lines.push('> 日费用波动较大，说明工作节奏不均匀。如果与工作日/周末模式相关，属于正常现象。');
      } else {
        lines.push('> 日费用波动适中，消费节奏较为平稳。');
      }
      lines.push('');
    }
  }

  return lines.length > 0 ? lines : null;
}

function buildDailyTrendInsight(dailyStats, period) {
  const dates = Object.keys(dailyStats).sort();
  if (dates.length < 2) return null;

  const lines = [];
  const periodLabel = period === 'weekly' ? '本周' : '本月';

  // 峰值日
  let peakDate = dates[0], peakReqs = 0;
  for (const d of dates) {
    if (dailyStats[d].requests > peakReqs) {
      peakReqs = dailyStats[d].requests;
      peakDate = d;
    }
  }

  // 活跃分布
  const activeDays = dates.length;
  const totalDays = period === 'weekly' ? 7 : 30;
  const coverage = Math.round((activeDays / totalDays) * 100);

  if (peakReqs > 0) {
    lines.push(`**${periodLabel}活跃趋势**：${activeDays} 天有活动（覆盖率 ${coverage}%），峰值在 ${peakDate}（${fmtN(peakReqs)} 次交互）。`);
  }

  // 连续活跃检测
  let maxStreak = 1, streak = 1;
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(dates[i - 1]);
    const curr = new Date(dates[i]);
    const diff = (curr - prev) / (1000 * 60 * 60 * 24);
    if (diff === 1) {
      streak++;
      maxStreak = Math.max(maxStreak, streak);
    } else {
      streak = 1;
    }
  }
  if (maxStreak >= 3) {
    lines.push(`最长连续活跃 ${maxStreak} 天。`);
  }

  // 请求量趋势（前半 vs 后半）
  if (dates.length >= 4) {
    const mid = Math.floor(dates.length / 2);
    const firstHalfReqs = dates.slice(0, mid).reduce((s, d) => s + dailyStats[d].requests, 0);
    const secondHalfReqs = dates.slice(mid).reduce((s, d) => s + dailyStats[d].requests, 0);
    if (firstHalfReqs > 0 && secondHalfReqs > 0) {
      const trend = secondHalfReqs > firstHalfReqs * 1.3 ? '呈上升趋势' :
                    secondHalfReqs < firstHalfReqs * 0.7 ? '呈下降趋势' : '基本平稳';
      lines.push(`交互量${trend}。`);
    }
  }

  return lines.length > 0 ? lines.join('') : null;
}

function fmtToken(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function pctChange(curr, prev) {
  if (prev == null || prev === 0) return curr > 0 ? 100 : null;
  return Math.round((curr - prev) / prev * 100);
}

function formatPct(pct) {
  if (pct > 0) return `↑${pct}%`;
  if (pct < 0) return `↓${Math.abs(pct)}%`;
  return '持平';
}

export function generateReport(usageData, gitData, period, startDate, endDate) {
  const lines = [];

  lines.push('');
  lines.push(`════════════════════════════════════════════════════════════════════`);
  lines.push(`  AI 编码助手使用报告 - ${formatPeriodTitle(period, startDate, endDate)}`);
  lines.push(`════════════════════════════════════════════════════════════════════`);
  lines.push('');

  // 1. 使用概览
  lines.push('┌─────────────────────────────────────┐');
  lines.push('│  一、使用概览                        │');
  lines.push('└─────────────────────────────────────┘');
  lines.push('');

  const overviewTable = new Table({
    columns: [
      { title: '指标', width: 20 },
      { title: '数值', width: 15 },
      { title: '说明', width: 25 },
    ],
  });

  const totalSessions = usageData.sessionCount;
  const totalRequests = usageData.requestCount;
  const totalUserMessages = usageData.userMessageCount;
  const avgPerDay = usageData.activeDays > 0 ? (totalRequests / usageData.activeDays).toFixed(1) : '0';
  const activeDays = usageData.activeDays;
  const avgMsgPerSession = totalSessions > 0 ? (totalUserMessages / totalSessions).toFixed(1) : '0';
  const avgReqPerSession = totalSessions > 0 ? (totalRequests / totalSessions).toFixed(1) : '0';

  overviewTable.addRow(['会话数', formatInt(totalSessions), '独立对话数']);
  overviewTable.addRow(['用户消息数', formatInt(totalUserMessages), '用户主动发出的消息']);
  overviewTable.addRow(['总请求数', formatInt(totalRequests), '含 assistant 响应']);
  overviewTable.addRow(['活跃天数', `${activeDays} 天`, period === 'daily' ? '' : `活跃日均 ${avgPerDay} 次`]);
  overviewTable.addRow(['Token 总消耗', formatNumber(usageData.totalTokens), `≈ ${formatNumber(Math.round(usageData.totalTokens / (totalRequests || 1)))}/请求`]);
  overviewTable.addRow(['输入 Token', formatNumber(usageData.inputTokens), '']);
  overviewTable.addRow(['输出 Token', formatNumber(usageData.outputTokens), '']);
  overviewTable.addRow(['Cache 命中', formatNumber(usageData.cacheRead), formatPercent(usageData.cacheRead, usageData.cacheRead + usageData.inputTokens)]);
  lines.push(overviewTable.render());
  lines.push('');

  // 2. 效率指标
  if (gitData && (gitData.commits > 0 || gitData.filesChanged > 0)) {
    lines.push('┌─────────────────────────────────────┐');
    lines.push('│  二、效率指标（Git）                 │');
    lines.push('└─────────────────────────────────────┘');
    lines.push('');

    const gitTable = new Table({
      columns: [
        { title: '指标', width: 20 },
        { title: '数值', width: 15 },
        { title: '日均', width: 15 },
      ],
    });

    const days = usageData.activeDays || 1;
    gitTable.addRow(['提交次数', String(gitData.commits), (gitData.commits / days).toFixed(1)]);
    gitTable.addRow(['变更文件数', String(gitData.filesChanged), (gitData.filesChanged / days).toFixed(1)]);
    gitTable.addRow(['新增行数', String(gitData.linesAdded), (gitData.linesAdded / days).toFixed(1)]);
    gitTable.addRow(['删除行数', String(gitData.linesDeleted), (gitData.linesDeleted / days).toFixed(1)]);
    gitTable.addRow(['净增行数', String(gitData.linesAdded - gitData.linesDeleted), ((gitData.linesAdded - gitData.linesDeleted) / days).toFixed(1)]);
    if (gitData.aiContribution && gitData.commits > 0) {
      const ai = gitData.aiContribution;
      const commitPct = Math.round((ai.aiCommitRatio ?? (ai.aiCommits / gitData.commits)) * 100);
      gitTable.addRow(['高/中置信 AI 提交', `${ai.aiCommits}/${gitData.commits}`, `${commitPct}%`]);
      gitTable.addRow(['高置信提交', String(ai.highConfidenceCommits), '']);
      gitTable.addRow(['AI 命中文件新增行', String(ai.aiFileLinesAdded), '']);
      gitTable.addRow(['AI 命中文件删除行', String(ai.aiFileLinesDeleted), '']);
      if (ai.possibleAICommits > 0) {
        const possiblePct = Math.round((ai.possibleAICommits / gitData.commits) * 100);
        gitTable.addRow(['可能 AI 提交', `${ai.possibleAICommits}/${gitData.commits}`, `${possiblePct}%`]);
      }
      gitTable.addRow(['低置信关联提交', String(ai.lowConfidenceCommits), '']);
    }
    lines.push(gitTable.render());
    lines.push('');

    // 日维度拆解
    if (period !== 'daily' && gitData.commitsByDate) {
      const dates = Object.keys(gitData.commitsByDate).sort();
      if (dates.length > 0) {
        lines.push('  每日提交趋势:');
        lines.push('');
        const trendTable = new Table({
          columns: [
            { title: '日期', width: 12 },
            { title: '提交', width: 8 },
            { title: '文件', width: 8 },
            { title: '+行', width: 10 },
            { title: '-行', width: 10 },
          ],
        });
        for (const d of dates) {
          const ld = gitData.linesByDate?.[d] || { added: 0, deleted: 0, files: 0 };
          trendTable.addRow([
            d,
            String(gitData.commitsByDate[d]),
            String(ld.files),
            String(ld.added),
            String(ld.deleted),
          ]);
        }
        lines.push(trendTable.render());
        lines.push('');
      }
    }

    // 2b 提交类型分布
    if (gitData.commitTypes) {
      const typeEntries = Object.entries(gitData.commitTypes)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1]);
      if (typeEntries.length > 0) {
        const typeTotal = typeEntries.reduce((s, [, v]) => s + v, 0);
        lines.push('  提交类型分布:');
        lines.push('');
        const typeTable = new Table({
          columns: [
            { title: '类型', width: 12 },
            { title: '数量', width: 8 },
            { title: '占比', width: 8 },
            { title: '可视化', width: 32 },
          ],
        });
        for (const [type, count] of typeEntries) {
          const pct = (count / typeTotal) * 100;
          const bar = makeBar(pct, 20);
          typeTable.addRow([type, formatInt(count), pct.toFixed(1) + '%', bar + ` ${pct.toFixed(0)}%`]);
        }
        lines.push(typeTable.render());
        lines.push('');
      }
    }

    // 2c 文件热点 Top 10
    if (gitData.fileHotspots?.length) {
      lines.push('  文件热点 Top 10:');
      lines.push('');
      const hotTable = new Table({
        columns: [
          { title: '文件', width: 40 },
          { title: '触碰', width: 6 },
          { title: '+行', width: 8 },
          { title: '-行', width: 8 },
        ],
      });
      for (const h of gitData.fileHotspots) {
        const display = h.path.length > 38 ? '...' + h.path.slice(-35) : h.path;
        hotTable.addRow([display, String(h.touches), String(h.added), String(h.deleted)]);
      }
      lines.push(hotTable.render());
      lines.push('');
    }
  }

  // 3. 使用场景分布
  if (usageData.scenarios) {
    lines.push('┌─────────────────────────────────────┐');
    lines.push('│  三、使用场景分布                    │');
    lines.push('└─────────────────────────────────────┘');
    lines.push('');

    const scenarioTable = new Table({
      columns: [
        { title: '场景', width: 15 },
        { title: '次数', width: 10 },
        { title: '占比', width: 8 },
        { title: '可视化', width: 32 },
      ],
    });

    const total = Object.values(usageData.scenarios).reduce((s, v) => s + v, 0) || 1;
    const sorted = Object.entries(usageData.scenarios)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);

    for (const [name, count] of sorted) {
      const pct = (count / total) * 100;
      const bar = makeBar(pct, 20);
      scenarioTable.addRow([name, formatInt(count), pct.toFixed(1) + '%', bar + ` ${pct.toFixed(0)}%`]);
    }
    lines.push(scenarioTable.render());
    lines.push('');
  }

  // 4. 模型使用分布
  if (usageData.models && Object.keys(usageData.models).length > 0) {
    lines.push('┌─────────────────────────────────────┐');
    lines.push('│  四、模型使用分布                    │');
    lines.push('└─────────────────────────────────────┘');
    lines.push('');

    const modelTotal = Object.values(usageData.models).reduce((s, v) => s + v.count, 0);
    const modelTable = new Table({
      columns: [
        { title: '模型', width: 22 },
        { title: '请求次数', width: 10 },
        { title: '占比', width: 8 },
        { title: '输出 Token', width: 14 },
      ],
    });

    for (const [model, data] of Object.entries(usageData.models).sort((a, b) => b[1].count - a[1].count)) {
      modelTable.addRow([model, formatInt(data.count), formatPercent(data.count, modelTotal), formatNumber(data.outputTokens)]);
    }
    lines.push(modelTable.render());
    lines.push('');
  }

  // 5. 项目维度
  if (usageData.projects && Object.keys(usageData.projects).length > 0) {
    lines.push('┌─────────────────────────────────────┐');
    lines.push('│  五、项目使用分布                    │');
    lines.push('└─────────────────────────────────────┘');
    lines.push('');

    const totalProjRequests = Object.values(usageData.projects).reduce((s, v) => s + v.requests, 0);
    const projTable = new Table({
      columns: [
        { title: '项目', width: 38 },
        { title: '会话', width: 8 },
        { title: '请求', width: 8 },
        { title: '占比', width: 8 },
      ],
    });

    const activeProjects = Object.entries(usageData.projects)
      .filter(([, data]) => data.sessions > 0 || data.requests > 0)
      .sort((a, b) => b[1].requests - a[1].requests);

    for (const [proj, data] of activeProjects) {
      const displayName = proj.length > 36 ? '...' + proj.slice(-33) : proj;
      projTable.addRow([displayName, formatInt(data.sessions), formatInt(data.requests), formatPercent(data.requests, totalProjRequests)]);
    }
    lines.push(projTable.render());
    lines.push('');
  }

  // 6. 工具调用排行
  if (usageData.tools && Object.keys(usageData.tools).length > 0) {
    lines.push('┌─────────────────────────────────────┐');
    lines.push('│  六、工具调用排行 (Top 10)           │');
    lines.push('└─────────────────────────────────────┘');
    lines.push('');

    const toolValues = Object.values(usageData.tools);
    const totalToolCalls = toolValues.reduce((s, v) => s + toolCalls(v), 0);
    const toolTable = new Table({
      columns: [
        { title: '工具', width: 28 },
        { title: '调用次数', width: 10 },
        { title: '使用次数', width: 10 },
        { title: '占比', width: 8 },
      ],
    });

    const sortedTools = Object.entries(usageData.tools)
      .sort((a, b) => toolCalls(b[1]) - toolCalls(a[1]))
      .slice(0, 10);

    for (const [name, val] of sortedTools) {
      const calls = toolCalls(val);
      const uses = toolUses(val);
      toolTable.addRow([name, formatInt(calls), formatInt(uses), formatPercent(calls, totalToolCalls)]);
    }
    lines.push(toolTable.render());
    lines.push('');
  }

  lines.push('════════════════════════════════════════════════════════════════════');
  lines.push('');

  return lines.join('\n');
}

// ── 工具值类型兼容辅助 ──
function toolCalls(v) { return typeof v === 'number' ? v : (v.calls || 0); }
function toolUses(v) { return typeof v === 'number' ? v : (v.uses || 0); }

function formatPeriodTitle(period, start, end) {
  switch (period) {
    case 'daily': return `日报 ${start}`;
    case 'weekly': return `周报 ${start} ~ ${end}`;
    case 'monthly': return `月报 ${start.slice(0, 7)}`;
    default: return `${start} ~ ${end}`;
  }
}

function formatNumber(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + ' M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + ' K';
  return n.toLocaleString('zh-CN');
}

function formatInt(n) {
  return n.toLocaleString('zh-CN');
}

function formatPercent(n, total) {
  if (total === 0) return '0.0%';
  return ((n / total) * 100).toFixed(1) + '%';
}

function makeBar(pct, width = 20) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

// ── 平台输出适配 ──

function adaptPlatformOutput(markdown, platform) {
  if (platform === 'dingtalk') return adaptDingtalk(markdown);
  if (platform === 'feishu') return adaptFeishu(markdown);
  return markdown;
}

function adaptDingtalk(md) {
  // 钉钉 Markdown 限制：不支持表格、## 标题渲染不佳
  let out = md;
  // ## 标题 → 加粗 + 分割线
  out = out.replace(/^## (.+)$/gm, '**$1**\n---');
  // Markdown 表格 → 列表（简化处理：整块替换）
  out = out.replace(/\|[-| ]+\|\n/g, ''); // 去掉分隔行
  out = out.replace(/^\|(.+)\|$/gm, (_, content) => {
    const cells = content.split('|').map(c => c.trim());
    if (cells.length >= 2) return `- ${cells.join('：')}`;
    return `- ${content.trim()}`;
  });
  // 反引号路径 → 引号
  out = out.replace(/`([^`]+)`/g, '"$1"');
  return out;
}

function adaptFeishu(md) {
  // 飞书：去掉 Markdown 表格，改用列表
  let out = md;
  out = out.replace(/\|[-| ]+\|\n/g, '');
  out = out.replace(/^\|(.+)\|$/gm, (_, content) => {
    const cells = content.split('|').map(c => c.trim());
    if (cells.length >= 2) return `- ${cells.join('：')}`;
    return `- ${content.trim()}`;
  });
  return out;
}

// ── 飞书卡片 JSON 生成 ──

export function generateFeishuCard(usageData, gitData, period, startDate, endDate, tool) {
  const periodLabel = period === 'daily' ? '日报' : period === 'weekly' ? '周报' : '月报';
  const dateLabel = period === 'monthly' ? startDate.slice(0, 7) : period === 'weekly' ? `${startDate} ~ ${endDate}` : startDate;

  const summary = generateAutoSummary(usageData, gitData, null, period, startDate, endDate);
  const elements = [];

  // 核心叙事
  elements.push({ tag: 'div', text: { tag: 'lark_md', content: summary.paragraphs[0] || '' } });
  elements.push({ tag: 'hr' });

  // 指标字段
  const fields = [];
  if (usageData.requestCount > 0) {
    fields.push({ is_short: true, text: { tag: 'lark_md', content: `**交互数**\n${formatInt(usageData.requestCount)} 次` } });
  }
  if (usageData.sessionCount > 0) {
    fields.push({ is_short: true, text: { tag: 'lark_md', content: `**会话数**\n${formatInt(usageData.sessionCount)}` } });
  }
  if (gitData?.commits > 0) {
    fields.push({ is_short: true, text: { tag: 'lark_md', content: `**提交数**\n${formatInt(gitData.commits)} 次` } });
    if (gitData.attributionSummary) {
      const s = gitData.attributionSummary;
      const total = s.totalLinesChanged || 1;
      const confirmedPct = Math.round((s.confirmedAILines / total) * 100);
      fields.push({ is_short: true, text: { tag: 'lark_md', content: `**确认 AI**\n${confirmedPct}%` } });
    }
    if (gitData.aiContribution) {
      const ai = gitData.aiContribution;
      const commitPct = Math.round((ai.aiCommitRatio ?? (ai.aiCommits / gitData.commits)) * 100);
      fields.push({ is_short: true, text: { tag: 'lark_md', content: `**AI 提交**\n${ai.aiCommits}/${gitData.commits} (${commitPct}%)` } });
      if (ai.possibleAICommits > 0) {
        const possiblePct = Math.round((ai.possibleAICommits / gitData.commits) * 100);
        fields.push({ is_short: true, text: { tag: 'lark_md', content: `**可能 AI**\n${ai.possibleAICommits} (${possiblePct}%)` } });
      }
    }
  }
  if (usageData.estimatedCost) {
    fields.push({ is_short: true, text: { tag: 'lark_md', content: `**费用**\n$${usageData.estimatedCost.toFixed(2)}` } });
  }
  if (fields.length > 0) {
    elements.push({ tag: 'div', fields });
    elements.push({ tag: 'hr' });
  }

  // 工作成果
  if (gitData?.commitList?.length) {
    const workLine = buildGitSummaryLine(gitData.commitList);
    if (workLine) {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: workLine } });
    }
  }

  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `${tool && tool !== 'all' ? toolTitle(tool) : 'AI 编码助手'} 工作${periodLabel} - ${dateLabel}` } },
    elements,
  };
}

// ── 简报生成器 ──

export function generateBriefReport(usageData, gitData, period, startDate, endDate, prevData, platform = 'default', tool) {
  const periodName = period === 'daily' ? '今日' : period === 'weekly' ? '本周' : '本月';
  const periodLabel = period === 'daily' ? '日报' : period === 'weekly' ? '周报' : '月报';
  const dateLabel = period === 'monthly' ? startDate.slice(0, 7) : period === 'weekly' ? `${startDate} ~ ${endDate}` : startDate;
  const titlePrefix = tool && tool !== 'all' ? toolTitle(tool) : 'AI 编码助手';

  const isDingtalk = platform === 'dingtalk';
  const isFeishu = platform === 'feishu';

  // 钉钉用纯文本+emoji分隔，飞书/标准用 markdown
  const h2 = (text) => isDingtalk ? `─── ${text} ───` : `## ${text}`;
  const bullet = (text) => isDingtalk ? `• ${text}` : `- ${text}`;
  const bold = (text) => `**${text}**`;
  const code = (text) => `\`${text}\``;

  const lines = [];

  // ── 一句话结论（简报开头） ──
  const conclusionLine = buildBriefConclusion(usageData, gitData);
  if (conclusionLine) {
    lines.push(conclusionLine);
    lines.push('');
  }

  // 标题
  if (isDingtalk) {
    lines.push(`${titlePrefix} 工作${periodLabel} - ${dateLabel}`);
  } else {
    lines.push(`# ${titlePrefix} 工作${periodLabel} - ${dateLabel}`);
  }
  lines.push('');

  // 1. 核心叙事（复用 generateAutoSummary）
  const summary = generateAutoSummary(usageData, gitData, prevData, period, startDate, endDate);
  if (summary.paragraphs[0]) {
    lines.push(summary.paragraphs[0]);
    lines.push('');
  }

  // 2. 核心指标区
  const coreMetrics = [];
  coreMetrics.push(`交互：${fmtN(usageData.requestCount)} 次（${fmtN(usageData.sessionCount)} 会话）`);
  coreMetrics.push(`Token：${fmtToken(usageData.totalTokens)}（输入 ${fmtToken(usageData.inputTokens)} / 输出 ${fmtToken(usageData.outputTokens)}）`);
  const projCount = Object.keys(usageData.projects).length;
  if (projCount > 0) coreMetrics.push(`项目：${projCount} 个`);
  if (usageData.estimatedCost) {
    let costLabel = `等效费用：$${usageData.estimatedCost.toFixed(2)}`;
    if (usageData.costMeta?.unknownModels?.length) {
      costLabel += `（不含 ${usageData.costMeta.unknownModels.join('、')}，无定价数据）`;
    } else if (!usageData.costMeta?.hasActualCost) {
      costLabel += '（按定价表估算）';
    }
    coreMetrics.push(costLabel);
  }

  if (coreMetrics.length > 0) {
    lines.push(h2('核心指标'));
    lines.push('');
    for (const m of coreMetrics) lines.push(bullet(m));
    lines.push('');
  }

  // 3. 项目亮点
  const projects = Object.entries(usageData.projects)
    .filter(([, d]) => d.requests > 0)
    .sort((a, b) => b[1].requests - a[1].requests);
  if (projects.length > 0) {
    const totalReqs = projects.reduce((s, [, d]) => s + d.requests, 0);
    const top = projects[0];
    const topPct = Math.round(top[1].requests / totalReqs * 100);
    const topName = simplifyPath(top[0]);

    lines.push(h2('项目亮点'));
    lines.push('');

    if (projects.length === 1) {
      lines.push(bullet(`主要工作集中在 ${code(topName)}，共 ${fmtN(top[1].requests)} 次交互`));
    } else {
      lines.push(bullet(`主要工作集中在 ${code(topName)}（占 ${topPct}%，${fmtN(top[1].requests)} 次）`));
      const others = projects.slice(1, 3).map(([name, data]) => `${code(simplifyPath(name))}（${fmtN(data.requests)} 次）`);
      if (others.length > 0) {
        lines.push(bullet(`其他：${others.join('、')}`));
      }
    }
    lines.push('');
  }

  // 4. 工作成果（Git） — 动态裁剪：提交数少时简化
  if (gitData && gitData.commits > 0) {
    lines.push(h2('代码产出'));
    lines.push('');

    const filesChanged = gitData.filesChanged || 0;
    const linesAdded = gitData.linesAdded || 0;
    const linesDeleted = gitData.linesDeleted || 0;
    lines.push(bullet(`提交 ${fmtN(gitData.commits)} 次，变更 ${fmtN(filesChanged)} 个文件，+${fmtN(linesAdded)}/-${fmtN(linesDeleted)} 行`));

    // AI 参与度概要（3+ 提交时才展示百分比）
    if (gitData.aiContribution && gitData.commits >= 3) {
      const ai = gitData.aiContribution;
      const totalLines = ai.totalLinesChanged || 1;
      const aiLinePct = Math.round((ai.aiLinesChanged / totalLines) * 100);
      const commitPct = Math.round((ai.aiCommitRatio ?? (ai.aiCommits / gitData.commits)) * 100);
      const possibleCommitPct = ai.possibleAICommits > 0 ? Math.round((ai.possibleAICommits / gitData.commits) * 100) : 0;
      const weightedPct = Math.round((ai.weightedAILineRatio || 0) * 100);
      let line = `${aiLinePct}% 代码变更有 AI 参与，${ai.aiCommits}/${gitData.commits} 提交使用 AI (${commitPct}%)`;
      if (ai.possibleAICommits > 0) {
        line += `，可能 AI 提交 ${ai.possibleAICommits} (${possibleCommitPct}%)`;
      }
      if (weightedPct > aiLinePct) {
        line += `，加权影响力 ${weightedPct}%`;
      }
      lines.push(bullet(line));
    }

    if (gitData.commitList?.length) {
      const workLine = buildGitSummaryLine(gitData.commitList);
      if (workLine) {
        const content = workLine.replace(/^主要工作：/, '');
        const items = content.split('；').filter(Boolean);
        for (const item of items) {
          lines.push(bullet(item.trim()));
        }
      }
    }

    // 归因摘要（3+ 提交时才展示）
    if (gitData.commits >= 3) {
      const attributionLine = buildAttributionSummaryLine(gitData.attributionSummary);
      if (attributionLine) {
        lines.push(bullet(attributionLine));
      }
    }
    const attributionQualityLine = buildAttributionQualityLine(gitData.attributionQuality);
    if (attributionQualityLine) {
      lines.push(bullet(attributionQualityLine));
    }

    // AI 代码改写占比（3+ 提交时才展示）
    if (gitData.aiContribution && gitData.commits >= 3) {
      const ai = gitData.aiContribution;
      const linePct = Math.round(((ai.aiLineRatio ?? ai.aiRatio) || 0) * 100);
      if ((ai.aiLineRatio ?? ai.aiRatio ?? 0) > 0) {
        const aiAdded = ai.aiFileLinesAdded || 0;
        const aiDeleted = ai.aiFileLinesDeleted || 0;
        lines.push(bullet(`AI 代码改写占比 ${linePct}%，涉及 +${formatInt(aiAdded)}/-${formatInt(aiDeleted)} 行`));
      }
    }
    lines.push('');
  }

  // 5. 环比变化（含方向性结论）
  if (prevData) {
    const changes = [];
    const reqPct = pctChange(usageData.requestCount, prevData.requestCount);
    if (reqPct !== null) changes.push(`交互量${formatPct(reqPct)}`);
    const tokenPct = pctChange(usageData.totalTokens, prevData.totalTokens);
    if (tokenPct !== null) changes.push(`Token 消耗${formatPct(tokenPct)}`);
    const costPct = pctChange(usageData.estimatedCost, prevData.estimatedCost);
    if (costPct !== null) changes.push(`费用${formatPct(costPct)}`);

    if (changes.length > 0) {
      const prevName = period === 'daily' ? '昨日' : period === 'weekly' ? '上周' : '上月';
      lines.push(h2('环比变化'));
      lines.push('');
      lines.push(bullet(`相比${prevName}，${changes.join('、')}`));

      // 方向性结论
      const direction = buildBriefDirection(usageData, prevData, gitData);
      if (direction) {
        lines.push(bullet(direction));
      }
      lines.push('');
    }
  }

  // 6. 效率与成本
  const efficiencyLines = [];
  if (usageData.estimatedCost && usageData.estimatedCost > 0) {
    if (usageData.activeDays > 0) {
      const dailyCost = (usageData.estimatedCost / usageData.activeDays).toFixed(2);
      const monthlyEst = (usageData.estimatedCost / usageData.activeDays * 30).toFixed(2);
      efficiencyLines.push(`日均等效费用 $${dailyCost}，月度预估 $${monthlyEst}`);
    }
  }
  const cacheTotal = usageData.cacheRead + usageData.inputTokens;
  if (cacheTotal > 0) {
    const cacheRate = Math.round(usageData.cacheRead / cacheTotal * 100);
    if (cacheRate >= 5) {
      const cacheText = cacheRate > 60 ? '缓存利用良好' : cacheRate > 30 ? '缓存利用中等' : '可考虑增加上下文复用';
      efficiencyLines.push(`缓存命中率 ${cacheRate}%，${cacheText}`);
    }
  }
  if (efficiencyLines.length > 0) {
    lines.push(h2('效率提示'));
    lines.push('');
    for (const l of efficiencyLines) lines.push(bullet(l));
    lines.push('');
  }

  let result = lines.join('\n').trim();

  // 平台适配
  if (isDingtalk) {
    result = adaptDingtalkBrief(result);
  } else if (isFeishu) {
    result = adaptFeishuBrief(result);
  }

  return result;
}

// 钉钉简报适配：去掉 markdown 语法，使用纯文本+emoji
function adaptDingtalkBrief(text) {
  return text
    .replace(/^#+ /gm, '') // 去掉 markdown 标题
    .replace(/\*\*(.+?)\*\*/g, '$1') // 去掉加粗
    .replace(/`([^`]+)`/g, '$1') // 去掉代码标记
    .replace(/^─── (.+) ───$/gm, '━ $1 ━') // 分隔线风格统一
    .trim();
}

// 飞书简报适配：保留 markdown，简化表格
function adaptFeishuBrief(text) {
  return text.trim();
}

// ── 详报生成器（支持简报/详报分级 + 平台适配）──

const TOOL_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

function toolTitle(tool) {
  return TOOL_LABELS[tool] || 'AI 编码助手';
}

/**
 * Boss 报告——给领导看的工作汇报
 *
 * 设计哲学：
 * 1. 凸显工作成果——交付了多少、做了什么
 * 2. 说管理者语言——不说技术黑话
 * 3. 不给自己挖坑——不暴露"AI干了97%"这种数据
 * 4. 费用包装为"技术工具投入"——工作日计算
 */
export function generateBossReport(usageData, gitData, period, startDate, endDate, prevData, platform = 'default') {
  const periodName = period === 'daily' ? '今日' : period === 'weekly' ? '本周' : '本月';
  const dateLabel = period === 'monthly' ? startDate.slice(0, 7) : period === 'weekly' ? `${startDate} ~ ${endDate}` : startDate;
  const lines = [];

  lines.push(`# 工作${periodName === '今日' ? '日报' : periodName === '本周' ? '周报' : '月报'} - ${dateLabel}`);
  lines.push('');

  // ── 一、工作成果概述（领导第一眼看到的内容） ──
  const summary = buildBossSummary(usageData, gitData, periodName);
  lines.push(summary);
  lines.push('');

  // ── 二、核心产出（具体做了什么） ──
  const output = buildBossOutput(usageData, gitData, periodName);
  if (output) {
    lines.push('## 本期工作内容');
    lines.push('');
    for (const l of output) lines.push(l);
    lines.push('');
  }

  // ── 三、工作强度（凸工作态度） ──
  const intensity = buildBossIntensity(usageData, periodName);
  if (intensity) {
    lines.push('## 工作投入');
    lines.push('');
    for (const l of intensity) lines.push(l);
    lines.push('');
  }

  // ── 四、环比亮点（挑好的说） ──
  if (prevData) {
    const comparison = buildBossComparison(usageData, prevData, gitData, periodName);
    if (comparison) {
      lines.push('## 工作对比');
      lines.push('');
      for (const l of comparison) lines.push(l);
      lines.push('');
    }
  }

  // ── 五、技术工具投入（费用用工作日算，包装为投入） ──
  const cost = buildBossCost(usageData, periodName);
  if (cost) {
    lines.push('## 技术工具投入');
    lines.push('');
    for (const l of cost) lines.push(l);
    lines.push('');
  }

  const result = lines.join('\n').trim();

  // 平台适配
  if (platform === 'dingtalk') return adaptDingtalkBoss(result);
  if (platform === 'feishu') return adaptFeishuBoss(result);
  return result;
}

/**
 * 钉钉 Boss 报告适配——纯文本 + emoji 分隔，适合群消息
 */
function adaptDingtalkBoss(text) {
  return text
    .replace(/^# (.+)$/gm, '$1')
    .replace(/^## (.+)$/gm, '\n─── $1 ───')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '"$1"')
    .replace(/^> (.+)$/gm, '$1')
    .trim();
}

/**
 * 飞书 Boss 报告适配——保留 Markdown（飞书支持良好）
 */
function adaptFeishuBoss(text) {
  // 飞书支持标准 Markdown，只需确保格式兼容
  return text.trim();
}

function buildBossSummary(usageData, gitData, periodName) {
  const parts = [];

  // 产出维度
  if (gitData && gitData.commits > 0) {
    const featCount = (gitData.commitList || []).filter(c => {
      const s = (c.subject || c.message || '').toLowerCase();
      return s.startsWith('feat') || s.startsWith('feature');
    }).length;
    const fixCount = (gitData.commitList || []).filter(c => {
      const s = (c.subject || c.message || '').toLowerCase();
      return s.startsWith('fix') || s.startsWith('bug');
    }).length;
    const refactorCount = (gitData.commitList || []).filter(c => {
      const s = (c.subject || c.message || '').toLowerCase();
      return s.startsWith('refactor');
    }).length;
    const perfCount = (gitData.commitList || []).filter(c => {
      const s = (c.subject || c.message || '').toLowerCase();
      return s.startsWith('perf');
    }).length;

    const items = [];
    if (featCount > 0) items.push(`完成 ${featCount} 项功能开发`);
    if (fixCount > 0) items.push(`解决 ${fixCount} 个问题`);
    if (refactorCount > 0) items.push(`优化 ${refactorCount} 处代码结构`);
    if (perfCount > 0) items.push(`提升 ${perfCount} 处性能`);
    if (items.length > 0) parts.push(items.join('，'));

    // AI 协同效率——包装为"善用 AI 工具"
    if (gitData.aiContribution) {
      const aiRatio = gitData.aiContribution.aiLineRatio ?? gitData.aiContribution.aiRatio;
      if (aiRatio > 0) {
        const aiPct = Math.round(aiRatio * 100);
        if (aiPct >= 80) {
          parts.push('AI 辅助编码深度协同，开发效率显著提升');
        } else if (aiPct >= 50) {
          parts.push('充分运用 AI 辅助工具，人机协作高效');
        } else {
          parts.push('善用 AI 工具辅助编码');
        }
      }
    }
  } else {
    // 无 Git 数据时用交互量代替
    const reqCount = usageData.requestCount || 0;
    if (reqCount > 0) {
      parts.push(`累计进行 ${fmtN(reqCount)} 次 AI 辅助操作`);
    }
  }

  // 项目维度
  const projects = Object.entries(usageData.projects || {}).filter(([, d]) => d.requests > 0);
  if (projects.length > 1) {
    parts.push(`覆盖 ${projects.length} 个项目`);
  }

  // 态度维度
  if (usageData.activeDays > 0) {
    const totalDays = periodName === '今日' ? 1 : periodName === '本周' ? 7 : 30;
    const coverage = Math.round((usageData.activeDays / totalDays) * 100);
    if (coverage >= 70) {
      parts.push('保持高效持续产出');
    } else if (usageData.activeDays >= 5) {
      parts.push('工作节奏紧凑');
    }
  }

  if (parts.length === 0) return `${periodName}使用 AI 辅助工具进行日常工作。`;
  return `${periodName}${parts.join('，')}。`;
}

/**
 * Boss 报告的工作内容——只展示摘要数字和分类，不暴露 commit message
 */
function buildBossOutput(usageData, gitData, periodName) {
  if (!gitData || gitData.commits === 0) return null;
  const lines = [];

  // 数字概要——说管理者听得懂的
  const linesAdded = gitData.linesAdded || 0;
  const linesDeleted = gitData.linesDeleted || 0;
  const filesChanged = gitData.filesChanged || 0;
  const commits = gitData.commits || 0;

  lines.push(`本期共提交 ${commits} 次代码变更，涉及 ${filesChanged} 个文件，新增 ${fmtN(linesAdded)} 行代码。`);
  lines.push('');

  // 分类摘要——只说做了几类事，不说具体 commit
  const commitList = gitData.commitList || [];
  const categories = {
    '功能开发': c => { const s = (c.subject || c.message || '').toLowerCase(); return s.startsWith('feat') || s.startsWith('feature'); },
    '问题修复': c => { const s = (c.subject || c.message || '').toLowerCase(); return s.startsWith('fix') || s.startsWith('bug'); },
    '代码优化': c => { const s = (c.subject || c.message || '').toLowerCase(); return s.startsWith('refactor') || s.startsWith('perf'); },
    '文档更新': c => { const s = (c.subject || c.message || '').toLowerCase(); return s.startsWith('doc'); },
    '测试完善': c => { const s = (c.subject || c.message || '').toLowerCase(); return s.startsWith('test'); },
    '工程维护': c => { const s = (c.subject || c.message || '').toLowerCase(); return s.startsWith('chore') || s.startsWith('ci') || s.startsWith('build') || s.startsWith('release'); },
  };

  const catResults = {};
  for (const [cat, fn] of Object.entries(categories)) {
    const items = commitList.filter(fn);
    if (items.length > 0) catResults[cat] = items.length;
  }
  // 未分类的
  const classified = Object.values(categories).flatMap(fn => commitList.filter(fn));
  const unclassified = commitList.length - new Set(classified).size;
  if (unclassified > 0) catResults['其他改进'] = unclassified;

  if (Object.keys(catResults).length > 0) {
    lines.push('**工作内容分类**：');
    for (const [cat, count] of Object.entries(catResults)) {
      lines.push(`- ${cat}：${count} 项`);
    }
    lines.push('');
  }

  // 净代码增长——突出正面的
  const netLines = linesAdded - linesDeleted;
  if (netLines > 0) {
    lines.push(`> 净增代码 ${fmtN(netLines)} 行，项目功能持续扩展。`);
  } else if (linesAdded > 0) {
    lines.push(`> 代码变更以优化重构为主，代码库更加精简。`);
  }

  // AI 协同效率——在产出板块结尾展示
  if (gitData.aiContribution) {
    const ai = gitData.aiContribution;
    const aiLineRatio = ai.aiLineRatio ?? ai.aiRatio;
    if (aiLineRatio > 0) {
      const aiPct = Math.round(aiLineRatio * 100);
      const aiCommits = ai.aiCommits || 0;
      const totalCommits = gitData.commits || 1;
      const commitPct = Math.round((aiCommits / totalCommits) * 100);
      lines.push('');
      lines.push(`**AI 辅助编码效率**：${aiPct}% 的代码由 AI 辅助生成（涉及 ${aiCommits}/${totalCommits} 次提交），显著提升开发迭代速度。`);
    }
  }

  return lines;
}

/**
 * Boss 报告的工作投入——凸工作态度，不凸技术细节
 */
function buildBossIntensity(usageData, periodName) {
  const lines = [];
  const totalDays = periodName === '今日' ? 1 : periodName === '本周' ? 7 : 30;
  const activeDays = usageData.activeDays || 0;

  if (activeDays > 0) {
    const coverage = Math.round((activeDays / totalDays) * 100);

    // 用项目维度说事
    const projects = Object.entries(usageData.projects || {}).filter(([, d]) => d.requests > 0);
    const projNames = projects.map(([p]) => simplifyPath(p));

    if (periodName === '今日') {
      // 日报用简洁措辞
      if (projNames.length === 1) {
        lines.push(`全天专注于 **${projNames[0]}** 项目开发。`);
      } else if (projNames.length > 1) {
        lines.push(`全天推进 ${projNames.join('、')} 等项目。`);
      }
    } else if (projNames.length === 1) {
      lines.push(`持续 ${activeDays} 天在 **${projNames[0]}** 项目上集中投入。`);
    } else if (projNames.length > 1) {
      lines.push(`持续 ${activeDays} 天保持活跃，同时推进 ${projNames.join('、')} 等项目。`);
    } else {
      lines.push(`${periodName}共 ${activeDays} 天有工作产出。`);
    }

    // 工作节奏描述（仅周报/月报）
    if (periodName !== '今日' && usageData.dailyStats) {
      const dailyEntries = Object.entries(usageData.dailyStats).filter(([, ds]) => (ds.requests || 0) > 0);
      if (dailyEntries.length >= 3) {
        // 连续活跃天数
        const dates = dailyEntries.map(([d]) => d).sort();
        let maxStreak = 1, streak = 1;
        for (let i = 1; i < dates.length; i++) {
          const prev = new Date(dates[i - 1]);
          const curr = new Date(dates[i]);
          const diff = (curr - prev) / (1000 * 60 * 60 * 24);
          if (diff <= 1.5) { streak++; maxStreak = Math.max(maxStreak, streak); }
          else { streak = 1; }
        }
        if (maxStreak >= 5) {
          lines.push(`最长连续工作 ${maxStreak} 天，工作节奏稳定。`);
        }
      }
    }

    // 覆盖率用工作态度的语言说（仅周报/月报）
    if (periodName !== '今日') {
      if (coverage >= 80) {
        lines.push(`> 工作覆盖率 ${coverage}%，全程高投入。`);
      } else if (coverage >= 50) {
        lines.push(`> 工作覆盖率 ${coverage}%，保持稳定产出节奏。`);
      }
    }

    lines.push('');
  }

  return lines.length > 0 ? lines : null;
}

/**
 * Boss 报告的环比对比——挑好的说，不好的用正面语言
 */
function buildBossComparison(usageData, prevData, gitData, periodName) {
  if (!prevData) return null;
  const lines = [];
  const prevName = periodName === '今日' ? '昨日' : periodName === '本周' ? '上周' : '上月';

  const reqPct = pctChange(usageData.requestCount, prevData.requestCount);
  const costPct = pctChange(usageData.estimatedCost, prevData.estimatedCost);

  const parts = [];

  // 交互量——下降不一定是坏事，可以用"效率"包装
  if (reqPct !== null) {
    if (reqPct > 0) {
      parts.push(`工作强度提升 ${reqPct}%`);
    } else if (reqPct > -15) {
      parts.push('工作节奏保持稳定');
    }
    // 下降超过15%就不提交互量了，跳过
  }

  // 费用——如果上升了但交互量也上升，说明是工作量增加
  if (costPct !== null && costPct > 0 && reqPct !== null && reqPct > 0) {
    // 费用上升但交互量也上升——说明工作量增加带动
    parts.push('投入随工作量同步增长');
  }
  // 费用下降或持平——不提

  if (parts.length > 0) {
    lines.push(`相比${prevName}，${parts.join('，')}。`);
  } else {
    lines.push(`与${prevName}相比，工作保持稳定推进。`);
  }

  // 效率洞察——如果产出不变但交互减少
  if (gitData && gitData.commits > 0 && reqPct !== null && reqPct < 0) {
    lines.push('> 在工作量调整的同时，持续保持代码产出，工作效率稳定。');
  }

  return lines.length > 0 ? lines : null;
}

/**
 * Boss 报告的费用——工作日计算，包装为"技术工具投入"
 */
function buildBossCost(usageData, periodName) {
  if (!usageData.estimatedCost || usageData.estimatedCost <= 0) return null;
  const lines = [];

  const activeDays = usageData.activeDays || 1;
  const dailyCost = usageData.estimatedCost / activeDays;

  lines.push(`本期技术工具投入约 **$${usageData.estimatedCost.toFixed(0)}**（日均 $${dailyCost.toFixed(0)}），用于 AI 辅助编码、代码分析等研发提效工具。`);
  lines.push('');

  // 工作日计算月度预估——不把周末算进去
  if (periodName !== '今日') {
    const workdays = Math.min(activeDays, periodName === '本周' ? 5 : 22);
    const workdayDaily = usageData.estimatedCost / workdays;
    const monthlyEst = workdayDaily * 22;  // 按每月22个工作日算
    lines.push(`按工作日折算，月度工具预算约 $${monthlyEst.toFixed(0)}。`);
    lines.push('');
  }

  return lines;
}

export function generateWorkReport(usageData, gitData, period, startDate, endDate, prevData, options) {
  // 向后兼容：options 可以是字符串（旧 platform 参数）
  const opts = typeof options === 'string'
    ? { level: 'detailed', platform: options }
    : { level: 'detailed', platform: 'default', ...options };
  const { level, platform: fmt, tool, projectName } = opts;
  const toolLabel = tool && tool !== 'all' ? toolTitle(tool) : 'AI 编码助手';
  const titlePrefix = projectName ? `${projectName} · ${toolLabel}` : toolLabel;

  // 简报路由
  if (level === 'brief') {
    return generateBriefReport(usageData, gitData, period, startDate, endDate, prevData, fmt, tool);
  }
  const lines = [];
  const periodLabel = period === 'daily' ? '日报' : period === 'weekly' ? '周报' : period === 'monthly' ? '月报' : '自定义';
  const dateLabel = period === 'monthly' ? startDate.slice(0, 7) : period === 'daily' ? startDate : `${startDate} ~ ${endDate}`;

  lines.push(`# ${titlePrefix} 工作${periodLabel} - ${dateLabel}`);
  lines.push('');

  // 动态编号：收集要渲染的板块，最后统一编号
  const sections = [];

  // 板块 1：工作概述（始终存在）
  {
    const sectionLines = [];
    const summary = generateAutoSummary(usageData, gitData, prevData, period, startDate, endDate);
    for (const p of summary.paragraphs) {
      sectionLines.push(p);
      sectionLines.push('');
    }
    const coreInsight = buildCoreInsight(usageData, summary.periodName);
    if (coreInsight) {
      sectionLines.push(`> ${coreInsight}`);
      sectionLines.push('');
    }
    if (prevData) {
      const deepChange = buildDeepChangeNarrative(usageData, prevData);
      if (deepChange) {
        sectionLines.push(deepChange);
        sectionLines.push('');
      }
    }
    if (period !== 'daily' && usageData.dailyStats) {
      const trendLine = buildDailyTrendInsight(usageData.dailyStats, period);
      if (trendLine) {
        sectionLines.push(trendLine);
        sectionLines.push('');
      }
    }
    sections.push({ title: '工作概述', lines: sectionLines });
  }

  // 板块 2：项目进展
  const activeProjects = Object.entries(usageData.projects)
    .filter(([, data]) => data.sessions > 0 || data.requests > 0)
    .sort((a, b) => b[1].requests - a[1].requests);

  if (activeProjects.length > 0) {
    const sectionLines = [];
    const totalProjRequests = Object.values(usageData.projects).reduce((s, v) => s + v.requests, 0);

    sectionLines.push('| 项目 | 会话数 | 请求数 | 占比 |');
    sectionLines.push('|------|--------|--------|------|');
    for (const [proj, data] of activeProjects) {
      const displayName = proj.length > 40 ? '...' + proj.slice(-37) : proj;
      sectionLines.push(`| ${displayName} | ${formatInt(data.sessions)} | ${formatInt(data.requests)} | ${formatPercent(data.requests, totalProjRequests)} |`);
    }
    sectionLines.push('');
    const projInsight = buildProjectInsight(usageData.projects);
    if (projInsight) {
      sectionLines.push(`> ${projInsight}`);
      sectionLines.push('');
    }
    sections.push({ title: '项目进展', lines: sectionLines });
  }

  // 板块 3：工作类型分布
  if (usageData.scenarios) {
    const sectionLines = [];
    const total = Object.values(usageData.scenarios).reduce((s, v) => s + v, 0) || 1;
    const sorted = Object.entries(usageData.scenarios)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);

    for (const [name, count] of sorted) {
      const pct = (count / total) * 100;
      sectionLines.push(`- **${name}**：${pct.toFixed(1)}%（${formatInt(count)} 次）`);
    }
    sectionLines.push('');
    const sceneInsight = buildScenarioInsight(usageData.scenarios);
    if (sceneInsight) {
      sectionLines.push(`> ${sceneInsight}`);
      sectionLines.push('');
    }
    sections.push({ title: '工作类型分布', lines: sectionLines });
  }

  // 板块 4：代码产出
  if (gitData && (gitData.commits > 0 || gitData.filesChanged > 0)) {
    const sectionLines = [];

    // 4a. 工作成果叙事
    if (gitData.commitList?.length) {
      const narrative = buildCommitNarrative(gitData.commitList, { projectGroup: true, maxItems: 6 });
      if (narrative) {
        for (const proj of narrative) {
          if (narrative.length > 1) {
            sectionLines.push(`### ${proj.project}`);
            sectionLines.push('');
          }
          for (const sec of proj.sections) {
            const aiTag = sec.aiCount > 0 ? `（含 AI 辅助 ${sec.aiCount} 项）` : '';
            sectionLines.push(`**${sec.label}**${aiTag}：`);
            for (const item of sec.items) {
              sectionLines.push(`  - ${item}`);
            }
            if (sec.overflow > 0) {
              sectionLines.push(`  - ...及其他 ${sec.overflow} 项`);
            }
            sectionLines.push('');
          }
        }
      }
    }

    // 4b. 数字概要
    sectionLines.push(`> 提交 ${formatInt(gitData.commits)} 次，变更 ${formatInt(gitData.filesChanged)} 个文件，+${formatInt(gitData.linesAdded)}/-${formatInt(gitData.linesDeleted)} 行`);
    sectionLines.push('');

    const attributionLine = buildAttributionSummaryLine(gitData.attributionSummary);
    if (attributionLine) {
      sectionLines.push(`- ${attributionLine.replace('AI 归因汇总：', '**AI 归因汇总**：')}`);
    }
    const unknownReasonLine = buildUnknownReasonLine(gitData.attributionSummary);
    if (unknownReasonLine) {
      sectionLines.push(`- ${unknownReasonLine}`);
    }
    const attributionQualityLine = buildAttributionQualityLine(gitData.attributionQuality);
    if (attributionQualityLine) {
      sectionLines.push(`- ${attributionQualityLine}`);
    }
    if (attributionLine || unknownReasonLine || attributionQualityLine) sectionLines.push('');

    // 4c. AI 贡献明细
    if (gitData.commitList?.length) {
      const aiDetail = buildAIContributionDetail(gitData.commitList);
      if (aiDetail) {
        sectionLines.push('**AI 协作详情**：');
        sectionLines.push('');
        const totalCommits = gitData.commits;
        const totalAI = aiDetail.explicit.length + aiDetail.sessionStrong.length + aiDetail.fileOverlap.length;
        const aiLinePct = Math.round(((gitData.aiContribution?.aiLineRatio ?? gitData.aiContribution?.aiRatio) || 0) * 100);
        sectionLines.push(`- 高/中置信 AI 提交 **${totalAI}/${totalCommits}**（${aiLinePct}%），涉及 +${formatInt(aiDetail.totalAIFileAdded)}/-${formatInt(aiDetail.totalAIFileDeleted)} 行`);

        if (gitData.aiContribution?.possibleAICommits > 0) {
          const possiblePct = Math.round((gitData.aiContribution.possibleAICommits / totalCommits) * 100);
          sectionLines.push(`- 可能 AI 提交 **${gitData.aiContribution.possibleAICommits}/${totalCommits}**（${possiblePct}%）`);
        }
        if (gitData.aiContribution?.weightedAILineRatio > 0) {
          sectionLines.push(`- 加权 AI 影响力 **${Math.round(gitData.aiContribution.weightedAILineRatio * 100)}%**`);
        }

        // 汇总统计（不列出具体 commit subject，工作汇报中无阅读价值）
        const parts = [];
        if (aiDetail.explicit.length > 0) parts.push(`显式标记 ${aiDetail.explicit.length} 项`);
        if (aiDetail.sessionStrong.length > 0) parts.push(`会话强关联 ${aiDetail.sessionStrong.length} 项`);
        if (aiDetail.fileOverlap.length > 0) parts.push(`文件重叠 ${aiDetail.fileOverlap.length} 项`);
        if (parts.length > 0) {
          sectionLines.push(`- 归因方式：${parts.join('、')}`);
        }
        if (aiDetail.aiFiles.length > 0) {
          const topFiles = aiDetail.aiFiles.slice(0, 5).join('、');
          const overflow = aiDetail.aiFiles.length > 5 ? ` 等 ${aiDetail.aiFiles.length} 个` : '';
          sectionLines.push(`- **AI 涉及文件**：${topFiles}${overflow}`);
        }
        sectionLines.push('');
      }
    }
    const gitInsight = buildGitInsight(gitData);
    if (gitInsight) {
      sectionLines.push(`> ${gitInsight}`);
      sectionLines.push('');
    }
    sections.push({ title: '代码产出', lines: sectionLines });
  }

  // 板块：效率指标
  {
    const effLines = buildEfficiencyMetrics(usageData, gitData);
    if (effLines) {
      sections.push({ title: '效率指标', lines: effLines });
    }
  }

  // 板块：成本与效率
  if (usageData.estimatedCost) {
    const sectionLines = [];
    sectionLines.push(`- **预估等效费用**：$${usageData.estimatedCost.toFixed(2)}`);
    if (usageData.activeDays > 0) {
      const dailyCost = (usageData.estimatedCost / usageData.activeDays).toFixed(2);
      const monthlyEst = (usageData.estimatedCost / usageData.activeDays * 30).toFixed(2);
      sectionLines.push(`- **日均费用**：$${dailyCost}`);
      sectionLines.push(`- **月度预估**：$${monthlyEst}`);
    }
    // 费用准确性声明
    if (usageData.costMeta) {
      const meta = usageData.costMeta;
      const notes = [];
      if (meta.hasActualCost) notes.push('部分数据来自 API 实际计费');
      const estimatedModels = Object.entries(meta.modelPricingStatus || {})
        .filter(([, v]) => v === 'estimated')
        .map(([k]) => k);
      if (estimatedModels.length > 0) notes.push(`${estimatedModels.join('、')} 按官方定价表估算`);
      if (meta.unknownModels?.length > 0) notes.push(`${meta.unknownModels.join('、')} 无定价数据，未计入费用`);
      if (notes.length > 0) {
        sectionLines.push(`- **计费说明**：${notes.join('；')}`);
      }
    }
    // 优化建议
    const suggestions = buildSuggestions(usageData);
    if (suggestions.length > 0) {
      sectionLines.push('');
      sectionLines.push('**优化建议**：');
      for (const s of suggestions) {
        sectionLines.push(`- ${s}`);
      }
    }

    // 成本结构分析
    const costStructure = buildCostStructureAnalysis(usageData);
    if (costStructure) {
      sectionLines.push('');
      for (const l of costStructure) {
        sectionLines.push(l);
      }
    }

    sectionLines.push('');
    const costInsight = buildCostInsight(usageData);
    if (costInsight) {
      sectionLines.push(`> ${costInsight}`);
      sectionLines.push('');
    }
    sections.push({ title: '成本与效率', lines: sectionLines });
  }

  // 板块：工具使用与分析（合并模式展示 + 深度分析）
  const toolSectionLines = buildToolAnalysis(usageData);
  if (toolSectionLines) {
    sections.push({ title: '工具使用分析', lines: toolSectionLines });
  }

  // 统一渲染板块，动态编号
  const cnNums = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  for (let i = 0; i < sections.length; i++) {
    const num = cnNums[i] || (i + 1);
    lines.push(`## ${num}、${sections[i].title}`);
    lines.push('');
    for (const l of sections[i].lines) {
      lines.push(l);
    }
  }

  return adaptPlatformOutput(lines.join('\n'), fmt);
}

/**
 * 工具使用数据分析——从数据中提炼现象、规律和洞察
 */
function buildToolAnalysis(usageData) {
  if (!usageData.tools || Object.keys(usageData.tools).length === 0) return null;

  const lines = [];

  // ── 基础数据准备 ──
  const sortedTools = Object.entries(usageData.tools).sort((a, b) => toolCalls(b[1]) - toolCalls(a[1]));
  const totalCalls = sortedTools.reduce((s, [, v]) => s + toolCalls(v), 0) || 1;
  const uniqueToolCount = sortedTools.length;

  // ── 样本量校验 ──
  const lowSample = totalCalls < 20;
  const veryLowSample = totalCalls < 5;
  if (veryLowSample) {
    lines.push(`> 样本量过少（仅 ${totalCalls} 次工具调用），以下分析仅供参考，统计结论可靠性有限。`);
    lines.push('');
  } else if (lowSample) {
    lines.push(`> 样本量较少（${totalCalls} 次工具调用），分析结论的统计意义有限。`);
    lines.push('');
  }

  // ── 分类统计 ──
  const TOOL_CATEGORIES = {
    Write: '代码编辑', Edit: '代码编辑', NotebookEdit: '代码编辑', replace_symbol_body: '代码编辑',
    replace_content: '代码编辑', insert_before_symbol: '代码编辑', insert_after_symbol: '代码编辑',
    write: '代码编辑', edit: '代码编辑',
    Read: '代码阅读', Glob: '代码阅读', Grep: '代码阅读', find_symbol: '代码阅读',
    find_declaration: '代码阅读', find_referencing_symbols: '代码阅读', find_implementations: '代码阅读',
    get_symbols_overview: '代码阅读', initial_instructions: '代码阅读', get_diagnostics_for_file: '代码阅读',
    glob: '代码阅读', read: '代码阅读',
    Bash: '执行/运行', shell_command: '执行/运行', bash: '执行/运行',
    TaskCreate: '规划管理', TaskUpdate: '规划管理', TaskList: '规划管理', Agent: '规划管理',
    EnterPlanMode: '规划管理', ExitPlanMode: '规划管理', update_plan: '规划管理', todowrite: '规划管理',
    WebSearch: '搜索研究', WebFetch: '搜索研究', view_image: '代码阅读',
  };
  const catCalls = { '代码编辑': 0, '代码阅读': 0, '执行/运行': 0, '规划管理': 0, '搜索研究': 0, '其他': 0 };

  for (const [name, val] of sortedTools) {
    const calls = toolCalls(val);
    let cat = TOOL_CATEGORIES[name];
    if (!cat) {
      if (name.startsWith('mcp__Playwright') || name.startsWith('browser_')) cat = '执行/运行';
      else if (name.startsWith('mcp__context7') || name.startsWith('mcp__open-websearch') || name.startsWith('mcp__mcp-deepwiki') || name.startsWith('mcp__web_reader')) cat = '搜索研究';
      else if (name.startsWith('mcp__serena')) cat = '代码编辑';
      else cat = '其他';
    }
    catCalls[cat] += calls;
  }

  const activeCats = Object.entries(catCalls).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (activeCats.length === 0) return null;

  // ══════════════════════════════════════
  // 零、分类概览（原"工具使用模式"的数据展示）
  // ══════════════════════════════════════
  for (const [cat, count] of activeCats) {
    const rawPct = (count / totalCalls) * 100;
    const pct = rawPct < 1 ? '<1' : Math.round(rawPct);
    lines.push(`- **${cat}**：${pct}%（${formatInt(count)} 次）`);
  }

  // Top 3 工具
  const top3 = sortedTools.slice(0, 3);
  if (top3.length > 0) {
    lines.push('');
    lines.push(`> 使用最频繁的工具：${top3.map(([n, val]) => {
      const c = toolCalls(val);
      return `${n}（${formatInt(c)} 次）`;
    }).join('、')}。`);
  }
  lines.push('');

  // ══════════════════════════════════════
  // 一、工作模式判断
  // ══════════════════════════════════════
  const patterns = [];
  const catPcts = {};
  for (const [cat, count] of activeCats) {
    catPcts[cat] = Math.round((count / totalCalls) * 100);
  }

  // 判断主导工作模式
  const dominant = activeCats[0];
  const dominantPct = catPcts[dominant[0]];

  if (catPcts['代码编辑'] >= 40) {
    patterns.push('以**深度开发**为主——大量使用代码编辑类工具，处于密集编码阶段');
  } else if (catPcts['代码阅读'] >= 35) {
    patterns.push('以**代码审查与理解**为主——大量阅读代码，可能在熟悉代码库或进行 code review');
  } else if (catPcts['搜索研究'] >= 30) {
    patterns.push('以**调研探索**为主——频繁使用搜索和文档工具，处于技术调研或方案选型阶段');
  } else if (catPcts['执行/运行'] >= 25) {
    patterns.push('以**测试验证**为主——频繁执行命令，可能在调试、运行测试或部署验证');
  } else if (catPcts['规划管理'] >= 25) {
    patterns.push('以**任务规划与协调**为主——大量使用任务管理和子代理工具，处于项目管理或任务拆解阶段');
  }

  // 多模式叠加判断（作为对主模式的补充，避免与主模式矛盾）
  const mainMode = patterns[0] || '';
  if (catPcts['代码编辑'] >= 25 && catPcts['代码阅读'] >= 20) {
    patterns.push('编辑与阅读比例均衡（编辑 ' + catPcts['代码编辑'] + '% : 阅读 ' + catPcts['代码阅读'] + '%），体现出**边读边改**的渐进式开发风格');
  }
  if (catPcts['执行/运行'] >= 30 && catPcts['代码阅读'] >= 20 && !mainMode.includes('代码审查')) {
    patterns.push('执行与阅读联动（执行 ' + catPcts['执行/运行'] + '% : 阅读 ' + catPcts['代码阅读'] + '%），说明在**边查边试**——先阅读理解代码，再执行命令验证');
  }
  if (catPcts['代码编辑'] >= 15 && catPcts['执行/运行'] >= 30) {
    patterns.push('编辑占比 ' + catPcts['代码编辑'] + '% 配合 ' + catPcts['执行/运行'] + '% 的执行量，体现出**快速迭代、频繁验证**的开发节奏');
  }
  if (catPcts['搜索研究'] >= 15 && catPcts['代码编辑'] >= 15) {
    patterns.push('搜索与编辑联动（搜索 ' + catPcts['搜索研究'] + '% : 编辑 ' + catPcts['代码编辑'] + '%），说明在**边查文档边编码**');
  }

  if (patterns.length === 0 && dominantPct < 40) {
    patterns.push('工具使用分布较为**均匀多元**，属于**全栈协作模式**——各类工具交替使用，工作节奏多样');
  }

  lines.push('**工作模式**：' + patterns[0]);
  for (let i = 1; i < patterns.length; i++) {
    lines.push('');
    lines.push('> ' + patterns[i]);
  }

  // ══════════════════════════════════════
  // 二、迭代度分析（Calls / Uses 比率）
  // ══════════════════════════════════════
  lines.push('');
  lines.push('**迭代度分析**：');

  const iterativeTools = [];
  for (const [name, val] of sortedTools) {
    const calls = toolCalls(val);
    const uses = toolUses(val);
    if (uses > 0 && calls > uses * 1.5 && calls >= 5) {
      iterativeTools.push({ name, calls, uses, ratio: (calls / uses).toFixed(1) });
    }
  }
  iterativeTools.sort((a, b) => b.ratio - a.ratio);

  if (iterativeTools.length === 0) {
    lines.push('各工具的调用/使用比接近 1:1，说明工具调用**目标明确**，较少在同一轮对话中重复调用同一工具。');
  } else {
    const topIterative = iterativeTools.slice(0, 3);
    const insights = topIterative.map(t => {
      const meaning = getIterativeInsight(t.name, t.ratio);
      return `**${t.name}**（调用 ${formatInt(t.calls)} 次 / 使用 ${formatInt(t.uses)} 次，比率 ${t.ratio}×）——${meaning}`;
    });
    for (const ins of insights) {
      lines.push('- ' + ins);
    }

    // 综合判断
    const hasHighIteration = iterativeTools.some(t => parseFloat(t.ratio) >= 3);
    if (hasHighIteration) {
      lines.push('');
      lines.push('> 存在高迭代工具（比率 ≥ 3×），整体工作风格偏向**渐进式打磨**——在单次交互中反复调整，直到达到预期效果。');
    } else {
      lines.push('');
      lines.push('> 迭代倍率适中（均 < 3×），说明虽然存在重复调用，但**收敛速度较快**，每次调整的方向性较强。');
    }
  }

  // ══════════════════════════════════════
  // 三、集中度与多样性
  // ══════════════════════════════════════
  lines.push('');
  lines.push('**工具分布特征**：');

  const top1Pct = Math.round((toolCalls(sortedTools[0][1]) / totalCalls) * 100);
  const top3Calls = sortedTools.slice(0, Math.min(3, sortedTools.length)).reduce((s, [, v]) => s + toolCalls(v), 0);
  const top3Pct = Math.round((top3Calls / totalCalls) * 100);

  if (top1Pct >= 50) {
    lines.push(`最常用工具 **${sortedTools[0][0]}** 占比达 ${top1Pct}%，存在明显的**单工具依赖**现象。`);
    lines.push(`> 高度集中在单一工具上，可能意味着工作内容比较单一，或该工具承载了过多的操作类型。建议关注是否有更细粒度的工具可以替代部分操作。`);
  } else if (top3Pct >= 70) {
    lines.push(`前 3 个工具合计占比 ${top3Pct}%（其中 ${sortedTools[0][0]} ${top1Pct}%），呈现**适度集中**的分布。`);
    lines.push(`> 核心工具集明确，同时保留了足够的工具多样性。这是一个健康的工作模式——核心流程稳定，辅助工具按需调用。`);
  } else if (top3Pct >= 50) {
    lines.push(`前 3 个工具合计占比 ${top3Pct}%，分布**相对分散**，使用了 ${uniqueToolCount} 种不同的工具。`);
    lines.push(`> 工具使用面较广，说明工作内容**多样化**——不局限于单一操作类型，覆盖了开发链路的多个环节。`);
  } else {
    lines.push(`工具分布**高度分散**，前 3 个工具仅占 ${top3Pct}%，共使用了 ${uniqueToolCount} 种工具。`);
    lines.push(`> 极其多元的工具使用，说明工作内容复杂度高，涉及多个维度的操作。这也可能意味着任务类型跨度较大。`);
  }

  // ══════════════════════════════════════
  // 四、关键发现
  // ══════════════════════════════════════
  const findings = [];

  // 发现1：编辑/阅读比率
  const editCalls = catCalls['代码编辑'];
  const readCalls = catCalls['代码阅读'];
  if (editCalls > 0 && readCalls > 0) {
    const editReadRatio = editCalls / readCalls;
    if (editReadRatio >= 3) {
      findings.push('编辑/阅读比达 **' + editReadRatio.toFixed(1) + ':1**，远高于均衡值。说明对代码库已有较高熟悉度，以"写"为主——可能处于功能快速落地阶段。');
    } else if (editReadRatio >= 1.5) {
      findings.push('编辑/阅读比约 **' + editReadRatio.toFixed(1) + ':1**，略偏编辑。说明在"先理解再修改"的节奏中，修改动作更加频繁，属于**高效迭代**的工作状态。');
    } else if (editReadRatio >= 0.7) {
      findings.push('编辑/阅读比约 **' + editReadRatio.toFixed(1) + ':1**，接近均衡。体现出**审慎的工程习惯**——先充分理解再动手修改，降低出错风险。');
    } else {
      findings.push('编辑/阅读比仅 **' + editReadRatio.toFixed(1) + ':1**，以阅读为主。可能正在**熟悉新代码库、做技术评审或排查问题**。');
    }
  }

  // 发现2：Agent/子代理使用
  const agentTool = sortedTools.find(([n]) => n === 'Agent');
  if (agentTool) {
    const agentCalls = toolCalls(agentTool[1]);
    const agentPct = Math.round((agentCalls / totalCalls) * 100);
    if (agentPct >= 15) {
      findings.push('Agent（子代理）调用占比达 **' + agentPct + '%**，大量使用并行/委托式工作模式。说明善于利用**任务拆解和并行执行**来提升效率。');
    } else if (agentPct >= 5) {
      findings.push('Agent（子代理）调用占 **' + agentPct + '%**，适度使用了子代理进行任务委派。');
    }
  }

  // 发现3：MCP工具使用
  const mcpTools = sortedTools.filter(([n]) => n.startsWith('mcp__'));
  if (mcpTools.length >= 3) {
    const mcpCalls = mcpTools.reduce((s, [, v]) => s + toolCalls(v), 0);
    const mcpPct = Math.round((mcpCalls / totalCalls) * 100);
    const mcpServers = new Set(mcpTools.map(([n]) => n.split('__')[1]?.split('_')[0]).filter(Boolean));
    findings.push('使用了 **' + mcpTools.length + ' 种** MCP 工具（来自 ' + mcpServers.size + ' 个 MCP 服务），占总调用的 **' + mcpPct + '%**。说明充分利用了外部工具生态，扩展了 AI 的能力边界。');
  }

  // 发现4：搜索工具依赖
  const searchCalls = catCalls['搜索研究'];
  if (searchCalls > 0) {
    const searchPct = Math.round((searchCalls / totalCalls) * 100);
    if (searchPct >= 25) {
      findings.push('搜索研究类工具占比 **' + searchPct + '%**，对外部信息有较高依赖。说明当前工作中有大量**需要参考文档、查证资料**的场景。');
    }
  }

  if (findings.length > 0) {
    lines.push('');
    lines.push('**关键发现**：');
    for (const f of findings) {
      lines.push('- ' + f);
    }
  }

  return lines;
}

/**
 * 根据工具名称和迭代比率，返回有意义的分析文案
 */
function getIterativeInsight(toolName, ratio) {
  const r = parseFloat(ratio);
  const level = r >= 5 ? '极高频' : r >= 3 ? '高频' : '中频';

  const insights = {
    'Bash': level + '迭代执行——可能在**反复调试命令、逐步修正参数**，或执行多步部署/测试流程',
    'Edit': level + '迭代编辑——在同一段代码上**反复打磨**，体现出精细化的代码调整过程',
    'Write': level + '迭代写入——可能在**分步骤创建多个文件**，或反复重写同一文件',
    'Read': level + '迭代阅读——在同一次对话中**反复查阅**同一文件或多个文件，可能在深入理解代码逻辑',
    'Grep': level + '迭代搜索——**多轮搜索不同关键词**，说明在进行系统性的代码定位或模式分析',
    'Glob': level + '迭代搜索文件——**多轮文件匹配**，可能在探索项目结构或定位特定类型的文件',
    'Agent': level + '迭代派发子任务——在单次对话中**多次委派不同子任务**，说明任务复杂度较高，需要多步骤协调',
    'WebSearch': level + '迭代搜索——在单次对话中**多次搜索不同话题**，说明调研范围较广',
  };

  if (insights[toolName]) return insights[toolName];

  // MCP 工具的特殊处理
  if (toolName.startsWith('mcp__Playwright') || toolName.startsWith('browser_')) {
    return level + '迭代浏览器操作——可能在**反复调试页面交互**，或多步骤自动化测试';
  }
  if (toolName.startsWith('mcp__serena')) {
    return level + '迭代代码操作——使用 Serena 进行**多步骤代码重构或分析**';
  }
  if (toolName.startsWith('mcp__context7') || toolName.startsWith('mcp__open-websearch') || toolName.startsWith('mcp__web_reader')) {
    return level + '迭代信息检索——**多轮查证不同文档**，在进行系统性的技术调研';
  }

  return level + '迭代调用——在单次对话中重复使用该工具，说明对该工具的**操作具有多步骤特性**';
}


function buildSuggestions(stats) {
  const tips = [];
  // 缓存命中率
  const cacheTotal = stats.cacheRead + stats.inputTokens;
  if (cacheTotal > 0) {
    const cacheRate = Math.round(stats.cacheRead / cacheTotal * 100);
    if (cacheRate < 20) tips.push('缓存命中率较低（' + cacheRate + '%），建议增加上下文复用以降低费用');
  }
  // 输出占比
  if (stats.totalTokens > 0) {
    const outputRatio = stats.outputTokens / stats.totalTokens;
    if (outputRatio > 0.6) tips.push('输出 Token 占比较高（' + Math.round(outputRatio * 100) + '%），考虑更精确的提示词以减少冗余输出');
  }
  // 子 agent 占比
  if (stats.subagentTokens > 0 && stats.totalTokens > 0) {
    const subRatio = stats.subagentTokens / stats.totalTokens;
    if (subRatio > 0.4) tips.push('子 agent 消耗占 ' + Math.round(subRatio * 100) + '%，关注是否存在过度拆分任务的情况');
  }
  return tips;
}



// ── CLI --work 报告尾注：传播层便宜杠杆，默认开，--no-brand / config.branding.workReport=false 可关 ──
export function workReportFooter(platform = 'default') {
  const md = `\n\n---\n*由 [LumenCode](https://github.com/yaowen51888-rich/lumencode) 生成 · \`npm i -g lumencode\` 一键查看你的 AI 编码报告*`;
  // ponytail: CLI 仅传 'default'；dingtalk 分支镜像 adaptDingtalk 模式，预留给 Web/MCP 平台复用
  if (platform === 'dingtalk') {
    return '\n\n---\n由 LumenCode 生成 · npm i -g lumencode 一键查看你的 AI 编码报告';
  }
  return md;
}
