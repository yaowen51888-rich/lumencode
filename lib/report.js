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

  // 6. Git 产出（如有）
  if (gitStats && gitStats.commits > 0) {
    const gitLine = buildGitNarrative(gitStats, periodName);
    parts.push(gitLine);
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
      const pct = Math.round((ai.aiCommits / gitData.commits) * 100);
      gitTable.addRow(['高/中置信 AI 提交', `${ai.aiCommits}/${gitData.commits}`, `${pct}%`]);
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

export function generateWorkReport(usageData, gitData, period, startDate, endDate, prevData, platform) {
  const fmt = platform || 'default';
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

  // 二、项目进展
  const activeProjects = Object.entries(usageData.projects)
    .filter(([, data]) => data.sessions > 0 || data.requests > 0)
    .sort((a, b) => b[1].requests - a[1].requests);

  if (activeProjects.length > 0) {
    lines.push('## 二、项目进展');
    lines.push('');
    const totalProjRequests = Object.values(usageData.projects).reduce((s, v) => s + v.requests, 0);

    if (fmt === 'feishu') {
      // 飞书：用列表替代表格
      for (const [proj, data] of activeProjects) {
        const displayName = simplifyPath(proj);
        const pct = ((data.requests / totalProjRequests) * 100).toFixed(1);
        lines.push(`- **${displayName}**：${formatInt(data.sessions)} 个会话，${formatInt(data.requests)} 次请求（${pct}%）`);
      }
    } else if (fmt === 'dingtalk') {
      // 钉钉：纯文本缩进
      for (const [proj, data] of activeProjects) {
        const displayName = simplifyPath(proj);
        const pct = ((data.requests / totalProjRequests) * 100).toFixed(1);
        lines.push(`  ${displayName}：${data.sessions} 会话 / ${data.requests} 请求 / ${pct}%`);
      }
    } else {
      // 标准格式：Markdown 表格
      lines.push('| 项目 | 会话数 | 请求数 | 占比 |');
      lines.push('|------|--------|--------|------|');
      for (const [proj, data] of activeProjects) {
        const displayName = proj.length > 40 ? '...' + proj.slice(-37) : proj;
        lines.push(`| ${displayName} | ${formatInt(data.sessions)} | ${formatInt(data.requests)} | ${formatPercent(data.requests, totalProjRequests)} |`);
      }
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

  // 四、代码产出
  if (gitData && (gitData.commits > 0 || gitData.filesChanged > 0)) {
    lines.push('## 四、代码产出');
    lines.push('');
    lines.push(`- **提交次数**：${formatInt(gitData.commits)} 次`);
    lines.push(`- **变更文件**：${formatInt(gitData.filesChanged)} 个`);
    lines.push(`- **新增行数**：+${formatInt(gitData.linesAdded)}`);
    lines.push(`- **删除行数**：-${formatInt(gitData.linesDeleted)}`);
    lines.push(`- **净增行数**：${gitData.linesAdded >= gitData.linesDeleted ? '+' : ''}${formatInt(gitData.linesAdded - gitData.linesDeleted)}`);
    if (gitData.aiContribution && gitData.commits > 0) {
      const ai = gitData.aiContribution;
      const pct = Math.round((ai.aiCommits / gitData.commits) * 100);
      lines.push(`- **高/中置信 AI 提交**：${ai.aiCommits}/${gitData.commits} (${pct}%)`);
      lines.push(`- **高置信提交**：${ai.highConfidenceCommits}`);
      lines.push(`- **AI 命中文件新增行**：+${ai.aiFileLinesAdded}`);
      lines.push(`- **AI 命中文件删除行**：-${ai.aiFileLinesDeleted}`);
      lines.push(`- **低置信关联提交**：${ai.lowConfidenceCommits}`);
    }
    if (gitData.commitTypes) {
      const typeEntries = Object.entries(gitData.commitTypes)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1]);
      if (typeEntries.length > 0) {
        const typeStr = typeEntries.map(([t, n]) => `${t} ${n}`).join('、');
        lines.push(`- **提交类型**：${typeStr}`);
      }
    }
    if (gitData.fileHotspots?.length) {
      const top = gitData.fileHotspots.slice(0, 5)
        .map(h => `\`${h.path.split('/').slice(-2).join('/')}\` (${h.touches} 次)`)
        .join('、');
      lines.push(`- **变更最多的文件**：${top}`);
    }
    lines.push('');
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

  return lines.join('\n');
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
