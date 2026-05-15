import { Table } from './table.js';

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

export function generateWorkReport(usageData, gitData, period, startDate, endDate) {
  const lines = [];
  const periodName = period === 'daily' ? '日报' : period === 'weekly' ? '周报' : '月报';

  lines.push(`# Claude Code 工作${periodName} - ${period === 'monthly' ? startDate.slice(0, 7) : startDate}`);
  lines.push('');

  // 一、工作概览
  lines.push('## 一、工作概览');
  lines.push('');
  lines.push(`- **独立会话**：${formatInt(usageData.sessionCount)} 个`);
  lines.push(`- **交互轮次**：${formatInt(usageData.requestCount)} 次`);
  lines.push(`- **覆盖项目**：${Object.keys(usageData.projects).length} 个`);
  if (usageData.activeDays > 1) {
    lines.push(`- **活跃天数**：${usageData.activeDays} 天`);
  }
  lines.push('');

  // 二、项目进展
  const activeProjects = Object.entries(usageData.projects)
    .filter(([, data]) => data.sessions > 0 || data.requests > 0)
    .sort((a, b) => b[1].requests - a[1].requests);

  if (activeProjects.length > 0) {
    lines.push('## 二、项目进展');
    lines.push('');
    lines.push('| 项目 | 会话数 | 请求数 | 占比 |');
    lines.push('|------|--------|--------|------|');
    const totalProjRequests = Object.values(usageData.projects).reduce((s, v) => s + v.requests, 0);
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

  // 四、代码产出
  if (gitData && (gitData.commits > 0 || gitData.filesChanged > 0)) {
    lines.push('## 四、代码产出');
    lines.push('');
    lines.push(`- **提交次数**：${formatInt(gitData.commits)} 次`);
    lines.push(`- **变更文件**：${formatInt(gitData.filesChanged)} 个`);
    lines.push(`- **新增行数**：+${formatInt(gitData.linesAdded)}`);
    lines.push(`- **删除行数**：-${formatInt(gitData.linesDeleted)}`);
    lines.push(`- **净增行数**：${gitData.linesAdded >= gitData.linesDeleted ? '+' : ''}${formatInt(gitData.linesAdded - gitData.linesDeleted)}`);
    lines.push('');
  }

  // 五、AI 辅助工具
  if (usageData.tools && Object.keys(usageData.tools).length > 0) {
    const sortedTools = Object.entries(usageData.tools).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const toolNames = sortedTools.map(([name]) => name).join('、');
    lines.push('## 五、AI 辅助工具使用');
    lines.push('');
    lines.push(`高频使用工具：${toolNames} 等，辅助代码开发、文档处理与项目管理。`);
    lines.push('');
  }

  return lines.join('\n');
}
