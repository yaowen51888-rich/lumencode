import { Table } from './table.js';

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
  const costStr = stats.estimatedCost ? `$${stats.estimatedCost.toFixed(2)}` : null;
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
  return `代码产出：${parts.join('、')}。`;
}

function buildAttributionSummaryLine(summary) {
  if (!summary) return null;
  const total = summary.totalLinesChanged || 0;
  if (total <= 0) return null;
  const confirmedPct = Math.round((summary.confirmedAILines / total) * 100);
  const upperPct = Math.round(((summary.confirmedAILines + summary.probableAILines + summary.possibleAILines) / total) * 100);
  const unknownPct = Math.round((summary.unknownLines / total) * 100);
  return `AI 归因汇总：确认 AI ${confirmedPct}% / 可能 AI 上限 ${upperPct}% / 未知 ${unknownPct}%。`;
}

function buildUnknownReasonLine(summary) {
  if (!summary?.unknownReasons?.length) return null;
  return `未归因原因：${summary.unknownReasons.join('、')}。`;
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

function fmtToken(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function pctChange(curr, prev) {
  if (!prev || prev === 0) return curr > 0 ? 100 : null;
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
  lines.push(`  Claude Code 使用报告 - ${formatPeriodTitle(period, startDate, endDate)}`);
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
  overviewTable.addRow(['活跃天数', `${activeDays} 天`, period === 'daily' ? '' : `日均请求 ${avgPerDay} 次`]);
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

    const totalToolCalls = Object.values(usageData.tools).reduce((s, v) => s + v, 0);
    const toolTable = new Table({
      columns: [
        { title: '工具', width: 28 },
        { title: '调用次数', width: 10 },
        { title: '占比', width: 8 },
      ],
    });

    const sortedTools = Object.entries(usageData.tools)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    for (const [name, count] of sortedTools) {
      toolTable.addRow([name, formatInt(count), formatPercent(count, totalToolCalls)]);
    }
    lines.push(toolTable.render());
    lines.push('');
  }

  lines.push('════════════════════════════════════════════════════════════════════');
  lines.push('');

  return lines.join('\n');
}

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

export function generateFeishuCard(usageData, gitData, period, startDate, endDate) {
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
      fields.push({ is_short: true, text: { tag: 'lark_md', content: `**AI 代码改写占比**\n${commitPct}%` } });
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
    header: { title: { tag: 'plain_text', content: `Claude Code 工作${periodLabel} - ${dateLabel}` } },
    elements,
  };
}

// ── 简报生成器 ──

export function generateBriefReport(usageData, gitData, period, startDate, endDate, prevData, platform = 'default') {
  const periodName = period === 'daily' ? '今日' : period === 'weekly' ? '本周' : '本月';
  const periodLabel = period === 'daily' ? '日报' : period === 'weekly' ? '周报' : '月报';
  const dateLabel = period === 'monthly' ? startDate.slice(0, 7) : period === 'weekly' ? `${startDate} ~ ${endDate}` : startDate;

  const isDingtalk = platform === 'dingtalk';
  const isFeishu = platform === 'feishu';

  // 钉钉用纯文本+emoji分隔，飞书/标准用 markdown
  const h2 = (text) => isDingtalk ? `─── ${text} ───` : `## ${text}`;
  const bullet = (text) => isDingtalk ? `• ${text}` : `- ${text}`;
  const bold = (text) => `**${text}**`;
  const code = (text) => `\`${text}\``;

  const lines = [];

  // 标题
  if (isDingtalk) {
    lines.push(`Claude Code 工作${periodLabel} - ${dateLabel}`);
  } else {
    lines.push(`# Claude Code 工作${periodLabel} - ${dateLabel}`);
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
  if (usageData.estimatedCost) coreMetrics.push(`费用：$${usageData.estimatedCost.toFixed(2)}`);

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

  // 4. 工作成果（Git）
  if (gitData && gitData.commits > 0) {
    lines.push(h2('代码产出'));
    lines.push('');

    const filesChanged = gitData.filesChanged || 0;
    const linesAdded = gitData.linesAdded || 0;
    const linesDeleted = gitData.linesDeleted || 0;
    lines.push(bullet(`提交 ${fmtN(gitData.commits)} 次，变更 ${fmtN(filesChanged)} 个文件，+${fmtN(linesAdded)}/-${fmtN(linesDeleted)} 行`));

    if (gitData.commitList?.length) {
      const workLine = buildGitSummaryLine(gitData.commitList);
      if (workLine) {
        // 将"主要工作："前缀去掉，只保留内容
        const content = workLine.replace(/^主要工作：/, '');
        const items = content.split('；').filter(Boolean);
        for (const item of items) {
          lines.push(bullet(item.trim()));
        }
      }
    }

    const attributionLine = buildAttributionSummaryLine(gitData.attributionSummary);
    if (attributionLine) {
      lines.push(bullet(attributionLine));
    }
    const unknownReasonLine = buildUnknownReasonLine(gitData.attributionSummary);
    if (unknownReasonLine) {
      lines.push(bullet(unknownReasonLine));
    }

    if (gitData.aiContribution && gitData.commits > 0) {
      const ai = gitData.aiContribution;
      const commitPct = Math.round((ai.aiCommitRatio ?? (ai.aiCommits / gitData.commits)) * 100);
      const linePct = Math.round(((ai.aiLineRatio ?? ai.aiRatio) || 0) * 100);
      if ((ai.aiLineRatio ?? ai.aiRatio ?? 0) > 0) {
        const aiAdded = ai.aiFileLinesAdded || 0;
        const aiDeleted = ai.aiFileLinesDeleted || 0;
        lines.push(bullet(`AI 代码改写占比 ${linePct}%，涉及 +${formatInt(aiAdded)}/-${formatInt(aiDeleted)} 行`));
      }
    }
    lines.push('');
  }

  // 5. 环比变化
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
      lines.push('');
    }
  }

  // 6. 效率与成本
  const efficiencyLines = [];
  if (usageData.estimatedCost && usageData.estimatedCost > 0) {
    if (usageData.activeDays > 0) {
      const dailyCost = (usageData.estimatedCost / usageData.activeDays).toFixed(2);
      const monthlyEst = (usageData.estimatedCost / usageData.activeDays * 30).toFixed(2);
      efficiencyLines.push(`日均费用 $${dailyCost}，月度预估 $${monthlyEst}`);
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

export function generateWorkReport(usageData, gitData, period, startDate, endDate, prevData, options) {
  // 向后兼容：options 可以是字符串（旧 platform 参数）
  const opts = typeof options === 'string'
    ? { level: 'detailed', platform: options }
    : { level: 'detailed', platform: 'default', ...options };
  const { level, platform: fmt } = opts;

  // 简报路由
  if (level === 'brief') {
    return generateBriefReport(usageData, gitData, period, startDate, endDate, prevData, fmt);
  }
  const lines = [];
  const periodLabel = period === 'daily' ? '日报' : period === 'weekly' ? '周报' : '月报';
  const dateLabel = period === 'monthly' ? startDate.slice(0, 7) : period === 'weekly' ? `${startDate} ~ ${endDate}` : startDate;

  lines.push(`# Claude Code 工作${periodLabel} - ${dateLabel}`);
  lines.push('');

  // 一、工作概述（自然语言摘要）
  const summary = generateAutoSummary(usageData, gitData, prevData, period, startDate, endDate);
  lines.push('## 一、工作概述');
  lines.push('');
  for (const p of summary.paragraphs) {
    lines.push(p);
    lines.push('');
  }

  // 1b. 环比深度对比
  if (prevData) {
    const deepChange = buildDeepChangeNarrative(usageData, prevData);
    if (deepChange) {
      lines.push(deepChange);
      lines.push('');
    }
  }

  // 二、项目进展
  const activeProjects = Object.entries(usageData.projects)
    .filter(([, data]) => data.sessions > 0 || data.requests > 0)
    .sort((a, b) => b[1].requests - a[1].requests);

  if (activeProjects.length > 0) {
    lines.push('## 二、项目进展');
    lines.push('');
    const totalProjRequests = Object.values(usageData.projects).reduce((s, v) => s + v.requests, 0);

    lines.push('| 项目 | 会话数 | 请求数 | 占比 |');
    lines.push('|------|--------|--------|------|');
    for (const [proj, data] of activeProjects) {
      const displayName = proj.length > 40 ? '...' + proj.slice(-37) : proj;
      lines.push(`| ${displayName} | ${formatInt(data.sessions)} | ${formatInt(data.requests)} | ${formatPercent(data.requests, totalProjRequests)} |`);
    }
    lines.push('');
  }

  // 三、工作类型分布
  if (usageData.scenarios) {
    lines.push('## 三、工作类型分布');
    lines.push('');
    const total = Object.values(usageData.scenarios).reduce((s, v) => s + v, 0) || 1;
    const sorted = Object.entries(usageData.scenarios)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);

    for (const [name, count] of sorted) {
      const pct = (count / total) * 100;
      lines.push(`- **${name}**：${pct.toFixed(1)}%（${formatInt(count)} 次）`);
    }
    lines.push('');
  }

  // 四、代码产出（叙事 + 统计）
  if (gitData && (gitData.commits > 0 || gitData.filesChanged > 0)) {
    lines.push('## 四、代码产出');
    lines.push('');

    // 4a. 工作成果叙事
    if (gitData.commitList?.length) {
      const narrative = buildCommitNarrative(gitData.commitList, { projectGroup: true, maxItems: 6 });
      if (narrative) {
        for (const proj of narrative) {
          if (narrative.length > 1) {
            lines.push(`### ${proj.project}`);
            lines.push('');
          }
          for (const sec of proj.sections) {
            const aiTag = sec.aiCount > 0 ? `（含 AI 辅助 ${sec.aiCount} 项）` : '';
            lines.push(`**${sec.label}**${aiTag}：`);
            for (const item of sec.items) {
              lines.push(`  - ${item}`);
            }
            if (sec.overflow > 0) {
              lines.push(`  - ...及其他 ${sec.overflow} 项`);
            }
            lines.push('');
          }
        }
      }
    }

    // 4b. 数字概要
    lines.push(`> 提交 ${formatInt(gitData.commits)} 次，变更 ${formatInt(gitData.filesChanged)} 个文件，+${formatInt(gitData.linesAdded)}/-${formatInt(gitData.linesDeleted)} 行`);
    lines.push('');

    const attributionLine = buildAttributionSummaryLine(gitData.attributionSummary);
    if (attributionLine) {
      lines.push(`- ${attributionLine.replace('AI 归因汇总：', '**AI 归因汇总**：')}`);
    }
    const unknownReasonLine = buildUnknownReasonLine(gitData.attributionSummary);
    if (unknownReasonLine) {
      lines.push(`- ${unknownReasonLine}`);
    }
    if (attributionLine || unknownReasonLine) lines.push('');

    // 4c. AI 贡献明细
    if (gitData.commitList?.length) {
      const aiDetail = buildAIContributionDetail(gitData.commitList);
      if (aiDetail) {
        lines.push('**AI 协作详情**：');
        lines.push('');
        const totalCommits = gitData.commits;
        const totalAI = aiDetail.explicit.length + aiDetail.sessionStrong.length + aiDetail.fileOverlap.length;
        const aiLinePct = Math.round(((gitData.aiContribution?.aiLineRatio ?? gitData.aiContribution?.aiRatio) || 0) * 100);
        lines.push(`- 高/中置信 AI 提交 **${totalAI}/${totalCommits}**（${aiLinePct}%），涉及 +${formatInt(aiDetail.totalAIFileAdded)}/-${formatInt(aiDetail.totalAIFileDeleted)} 行`);

        if (aiDetail.explicit.length > 0) {
          lines.push(`- **显式 AI**（${aiDetail.explicit.length} 项）：${aiDetail.explicit.map(s => `\`${s}\``).join('、')}`);
        }
        if (aiDetail.sessionStrong.length > 0) {
          lines.push(`- **强关联**（${aiDetail.sessionStrong.length} 项）：${aiDetail.sessionStrong.map(s => `\`${s}\``).join('、')}`);
        }
        if (aiDetail.fileOverlap.length > 0) {
          lines.push(`- **文件重叠**（${aiDetail.fileOverlap.length} 项）：${aiDetail.fileOverlap.map(s => `\`${s}\``).join('、')}`);
        }
        if (aiDetail.aiFiles.length > 0) {
          const topFiles = aiDetail.aiFiles.slice(0, 8).map(f => `\`${f}\``).join('、');
          const overflow = aiDetail.aiFiles.length > 8 ? ` 等 ${aiDetail.aiFiles.length} 个` : '';
          lines.push(`- **AI 涉及文件**：${topFiles}${overflow}`);
        }
        lines.push('');
      }
    }
  }

  // 五、成本与效率
  if (usageData.estimatedCost) {
    lines.push('## 五、成本与效率');
    lines.push('');
    lines.push(`- **预估费用**：$${usageData.estimatedCost.toFixed(2)}`);
    if (usageData.activeDays > 0) {
      const dailyCost = (usageData.estimatedCost / usageData.activeDays).toFixed(2);
      const monthlyEst = (usageData.estimatedCost / usageData.activeDays * 30).toFixed(2);
      lines.push(`- **日均费用**：$${dailyCost}`);
      lines.push(`- **月度预估**：$${monthlyEst}`);
    }
    // 优化建议
    const suggestions = buildSuggestions(usageData);
    if (suggestions.length > 0) {
      lines.push('');
      lines.push('**优化建议**：');
      for (const s of suggestions) {
        lines.push(`- ${s}`);
      }
    }
    lines.push('');
  }

  // 六、AI 辅助工具
  if (usageData.tools && Object.keys(usageData.tools).length > 0) {
    const sortedTools = Object.entries(usageData.tools).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const toolNames = sortedTools.map(([name]) => name).join('、');
    lines.push('## 六、AI 辅助工具使用');
    lines.push('');
    lines.push(`高频使用工具：${toolNames} 等，辅助代码开发、文档处理与项目管理。`);
    lines.push('');
  }

  return adaptPlatformOutput(lines.join('\n'), fmt);
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


