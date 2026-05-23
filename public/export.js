import { TEXT } from './config.js';
import { esc, fmt, fmtShort, getChart } from './utils.js';

// ── CSV 导出 ──
export function exportCSV(data, period) {
  if (!data) return;
  const { usageStats, gitStats, start, end } = data;
  const lines = [];

  lines.push('# 概览统计');
  lines.push('指标,数值');
  lines.push(`会话数,${usageStats.sessionCount}`);
  lines.push(`请求数,${usageStats.requestCount}`);
  lines.push(`用户消息,${usageStats.userMessageCount}`);
  lines.push(`覆盖项目,${Object.keys(usageStats.projects).length}`);
  lines.push(`输入Token,${usageStats.inputTokens}`);
  lines.push(`输出Token,${usageStats.outputTokens}`);
  lines.push(`缓存读取Token,${usageStats.cacheRead}`);
  lines.push(`总Token,${usageStats.totalTokens}`);
  if (usageStats.estimatedCost) lines.push(`预估费用,$${usageStats.estimatedCost.toFixed(2)}`);
  if (usageStats.subagentTokens > 0) lines.push(`子Agent Token,${usageStats.subagentTokens}`);
  if (gitStats && gitStats.commits > 0) {
    lines.push(`Git提交,${gitStats.commits}`);
    lines.push(`新增行数,+${gitStats.linesAdded}`);
    lines.push(`删除行数,-${gitStats.linesDeleted}`);
    lines.push(`变更文件,${gitStats.filesChanged}`);
    if (gitStats.aiContribution) {
      const ai = gitStats.aiContribution;
      const pct = Math.round((ai.aiCommits / gitStats.commits) * 100);
      lines.push(`高/中置信AI提交,${ai.aiCommits}/${gitStats.commits} (${pct}%)`);
      lines.push(`高置信提交,${ai.highConfidenceCommits}`);
      lines.push(`AI命中文件新增行,+${ai.aiFileLinesAdded}`);
      lines.push(`AI命中文件删除行,-${ai.aiFileLinesDeleted}`);
      lines.push(`低置信关联提交,${ai.lowConfidenceCommits}`);
    }
    if (gitStats.commitTypes) {
      for (const [t, n] of Object.entries(gitStats.commitTypes).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])) {
        lines.push(`commit类型-${t},${n}`);
      }
    }
  }
  lines.push('');

  const daily = usageStats.dailyStats || {};
  if (Object.keys(daily).length > 0) {
    lines.push('# 每日明细');
    lines.push('日期,请求数,用户消息,输入Token,输出Token,缓存读取');
    for (const d of Object.keys(daily).sort()) {
      const s = daily[d];
      lines.push(`${d},${s.requests},${s.userMessages || 0},${s.inputTokens},${s.outputTokens},${s.cacheRead || 0}`);
    }
    lines.push('');
  }

  const projEntries = Object.entries(usageStats.projects).sort((a, b) => b[1].requests - a[1].requests);
  if (projEntries.length > 0) {
    lines.push('# 项目分布');
    lines.push('项目,请求数,会话数');
    for (const [name, d] of projEntries) {
      const sess = d.sessions instanceof Set ? d.sessions.size : (d.sessions || 0);
      lines.push(`"${name.replace(/"/g, '""')}",${d.requests},${sess}`);
    }
    lines.push('');
  }

  const modelEntries = Object.entries(usageStats.models).sort((a, b) => b[1].count - a[1].count);
  if (modelEntries.length > 0) {
    lines.push('# 模型分布');
    lines.push('模型,请求数,输入Token,输出Token,缓存读取');
    for (const [name, d] of modelEntries) {
      lines.push(`"${name}",${d.count},${d.inputTokens},${d.outputTokens},${d.cacheRead || 0}`);
    }
    lines.push('');
  }

  const toolEntries = Object.entries(usageStats.tools).sort((a, b) => b[1] - a[1]);
  if (toolEntries.length > 0) {
    lines.push('# 工具使用');
    lines.push('工具,调用次数');
    for (const [name, count] of toolEntries) lines.push(`${name},${count}`);
    lines.push('');
  }

  const scenarioEntries = Object.entries(usageStats.scenarios).sort((a, b) => b[1] - a[1]);
  if (scenarioEntries.length > 0) {
    lines.push('# 场景分布');
    lines.push('场景,请求数');
    for (const [name, count] of scenarioEntries) lines.push(`${name},${count}`);
  }

  const csv = lines.join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ccusage-${period}-${start}-${end}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Print helper ──
function printTable(title, headers, rows) {
  if (!rows || rows.length === 0) return '';
  return `<h2>${esc(title)}</h2><table><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;
}

// ── Print / PDF ──
export function printReport(data, period) {
  if (!data) return;
  const { usageStats, gitStats, start, end } = data;
  const periodName = period === 'daily' ? TEXT.DAILY : period === 'weekly' ? TEXT.WEEKLY : TEXT.MONTHLY;
  const dateRange = period === 'daily' ? start : `${start} ~ ${end}`;

  const imgs = {};
  const charts = {};
  // 从 utils 的 getChart 获取所有图表
  for (const key of ['scenarioChart', 'modelChart', 'projectChart', 'toolChart', 'trendChart', 'commitTypeChart']) {
    const ch = getChart(key);
    if (ch) { try { imgs[key] = ch.toBase64Image(); } catch {} }
  }

  const projRows = Object.entries(usageStats.projects).sort((a, b) => b[1].requests - a[1].requests).map(([n, d]) => [n, d.requests, d.sessions instanceof Set ? d.sessions.size : (d.sessions || 0)]);
  const modelRows = Object.entries(usageStats.models).sort((a, b) => b[1].count - a[1].count).map(([n, d]) => [n, d.count, fmtShort(d.inputTokens), fmtShort(d.outputTokens)]);
  const toolRows = Object.entries(usageStats.tools).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, c]) => [n, c]);
  const scenarioRows = Object.entries(usageStats.scenarios).sort((a, b) => b[1] - a[1]).map(([n, c]) => [n, c]);

  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Claude Code 使用${periodName}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',-apple-system,sans-serif;color:#111;padding:32px 40px;max-width:800px;margin:0 auto;font-size:13px;line-height:1.5}
h1{font-size:20px;margin-bottom:2px;letter-spacing:-0.3px}
.sub{color:#6b7280;font-size:12px;margin-bottom:20px}
.summary{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:20px}
.s{text-align:center;padding:10px 6px;background:#f5f5f5;border-radius:6px}
.sv{font-size:18px;font-weight:600;letter-spacing:-0.3px}
.sl{font-size:10px;color:#6b7280;margin-top:2px}
h2{font-size:13px;margin-top:18px;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid #e5e7eb}
table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:12px}
th,td{padding:5px 8px;text-align:left;border-bottom:1px solid #e5e7eb}
th{font-weight:600;background:#f8f9fa}
.charts{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0}
.cc{text-align:center}
.cc p{font-size:11px;font-weight:600;margin-bottom:2px}
.cc img{max-width:100%;height:180px;object-fit:contain}
.ft{text-align:center;color:#9ca3af;font-size:10px;margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb}
@media print{body{padding:20px 24px}@page{margin:15mm}}
</style></head><body>
<h1>Claude Code 使用${periodName}</h1>
<p class="sub">${dateRange} · 生成于 ${new Date().toLocaleString('zh-CN')}</p>
<div class="summary">
<div class="s"><div class="sv">${fmt(usageStats.sessionCount)}</div><div class="sl">独立会话</div></div>
<div class="s"><div class="sv">${fmt(usageStats.requestCount)}</div><div class="sl">交互轮次</div></div>
<div class="s"><div class="sv">${Object.keys(usageStats.projects).length}</div><div class="sl">覆盖项目</div></div>
<div class="s"><div class="sv">${fmt(usageStats.totalTokens)}</div><div class="sl">Token 消耗</div></div>
<div class="s"><div class="sv">${usageStats.estimatedCost ? '$' + usageStats.estimatedCost.toFixed(2) : '-'}</div><div class="sl">预估费用</div></div>
</div>
${printTable('项目分布', ['项目', '请求数', '会话数'], projRows)}
${printTable('模型分布', ['模型', '请求数', '输入', '输出'], modelRows)}
${printTable('工具使用排行', ['工具', '调用次数'], toolRows)}
${printTable('场景分布', ['场景', '请求数'], scenarioRows)}
${gitStats && gitStats.commits > 0 ? printTable('Git 代码产出', ['指标', '数值'], (() => {
  const rows = [['提交次数', gitStats.commits], ['新增行数', '+' + fmt(gitStats.linesAdded)], ['删除行数', '-' + fmt(gitStats.linesDeleted)], ['变更文件', gitStats.filesChanged]];
  if (gitStats.aiContribution) {
    const ai = gitStats.aiContribution;
    const pct = Math.round((ai.aiCommits / gitStats.commits) * 100);
    rows.push(['高/中置信 AI 提交', `${ai.aiCommits}/${gitStats.commits} (${pct}%)`]);
    rows.push(['高置信提交', `${ai.highConfidenceCommits}`]);
    rows.push(['AI 命中文件新增行', `+${ai.aiFileLinesAdded}`]);
    rows.push(['AI 命中文件删除行', `-${ai.aiFileLinesDeleted}`]);
    rows.push(['低置信关联提交', `${ai.lowConfidenceCommits}`]);
  }
  return rows;
})()) : ''}
${gitStats && gitStats.commitTypes ? (() => {
  const types = Object.entries(gitStats.commitTypes).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  return types.length ? printTable('提交类型分布', ['类型', '数量'], types.map(([t, n]) => [t, n])) : '';
})() : ''}
${gitStats && gitStats.fileHotspots?.length ? printTable('文件热点 Top 10', ['文件', '触碰', '+行', '-行'], gitStats.fileHotspots.map(h => [h.path, h.touches, '+' + fmt(h.added), '-' + fmt(h.deleted)])) : ''}
${(imgs.scenarioChart || imgs.modelChart) ? `<h2>图表</h2><div class="charts">${imgs.scenarioChart ? '<div class="cc"><p>工作类型分布</p><img src="' + imgs.scenarioChart + '"></div>' : ''}${imgs.modelChart ? '<div class="cc"><p>模型使用分布</p><img src="' + imgs.modelChart + '"></div>' : ''}</div><div class="charts">${imgs.projectChart ? '<div class="cc"><p>项目使用分布</p><img src="' + imgs.projectChart + '"></div>' : ''}${imgs.toolChart ? '<div class="cc"><p>工具调用排行</p><img src="' + imgs.toolChart + '"></div>' : ''}</div>` : ''}
<p class="ft">LumenCode · 数据来自本地日志，不上传至任何服务器</p>
</body></html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
  setTimeout(() => { win.print(); }, 400);
}

// ── JSON Export ──
export function exportJSON(data, period) {
  if (!data) return;
  const json = JSON.stringify({
    period,
    start: data.start,
    end: data.end,
    usageStats: data.usageStats,
    gitStats: data.gitStats ? {
      commits: data.gitStats.commits,
      linesAdded: data.gitStats.linesAdded,
      linesDeleted: data.gitStats.linesDeleted,
      filesChanged: data.gitStats.filesChanged,
      aiContribution: data.gitStats.aiContribution,
      commitTypes: data.gitStats.commitTypes,
      fileHotspots: data.gitStats.fileHotspots,
    } : null,
    costBreakdown: data.costBreakdown || null,
    exportedAt: new Date().toISOString(),
  }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ccusage-${period}-${data.start}-${data.end}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── HTML Export ──
export function exportHTML(data, period) {
  if (!data) return;
  const { usageStats, gitStats, start, end } = data;
  const periodName = period === 'daily' ? TEXT.DAILY : period === 'weekly' ? TEXT.WEEKLY : TEXT.MONTHLY;

  const imgs = {};
  for (const key of ['scenarioChart', 'modelChart', 'projectChart', 'toolChart', 'trendChart', 'commitTypeChart']) {
    const ch = getChart(key);
    if (ch) { try { imgs[key] = ch.toBase64Image(); } catch {} }
  }

  const projRows = Object.entries(usageStats.projects).sort((a, b) => b[1].requests - a[1].requests).map(([n, d]) => [n, d.requests, d.sessions instanceof Set ? d.sessions.size : (d.sessions || 0)]);
  const modelRows = Object.entries(usageStats.models).sort((a, b) => b[1].count - a[1].count).map(([n, d]) => [n, d.count, fmtShort(d.inputTokens), fmtShort(d.outputTokens), d.cost ? '$' + d.cost.toFixed(2) : '-']);
  const toolRows = Object.entries(usageStats.tools).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, c]) => [n, c]);
  const scenarioRows = Object.entries(usageStats.scenarios).sort((a, b) => b[1] - a[1]).map(([n, c]) => [n, c]);

  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>AI 编码助手使用${periodName}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',-apple-system,sans-serif;color:#111;padding:32px 40px;max-width:800px;margin:0 auto;font-size:13px;line-height:1.5}
h1{font-size:20px;margin-bottom:2px;letter-spacing:-0.3px}
.sub{color:#6b7280;font-size:12px;margin-bottom:20px}
.summary{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:20px}
.s{text-align:center;padding:10px 6px;background:#f5f5f5;border-radius:6px}
.sv{font-size:18px;font-weight:600;letter-spacing:-0.3px}
.sl{font-size:10px;color:#6b7280;margin-top:2px}
h2{font-size:13px;margin-top:18px;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid #e5e7eb}
table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:12px}
th,td{padding:5px 8px;text-align:left;border-bottom:1px solid #e5e7eb}
th{font-weight:600;background:#f8f9fa}
.charts{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0}
.cc{text-align:center}
.cc p{font-size:11px;font-weight:600;margin-bottom:2px}
.cc img{max-width:100%;height:180px;object-fit:contain}
.ft{text-align:center;color:#9ca3af;font-size:10px;margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb}
@media print{body{padding:20px 24px}@page{margin:15mm}}
</style></head><body>
<h1>AI 编码助手使用${periodName}</h1>
<p class="sub">${start}${end !== start ? ' ~ ' + end : ''} · 生成于 ${new Date().toLocaleString('zh-CN')}</p>
<div class="summary">
<div class="s"><div class="sv">${fmt(usageStats.sessionCount)}</div><div class="sl">独立会话</div></div>
<div class="s"><div class="sv">${fmt(usageStats.requestCount)}</div><div class="sl">交互轮次</div></div>
<div class="s"><div class="sv">${Object.keys(usageStats.projects).length}</div><div class="sl">覆盖项目</div></div>
<div class="s"><div class="sv">${fmt(usageStats.totalTokens)}</div><div class="sl">Token 消耗</div></div>
<div class="s"><div class="sv">${usageStats.estimatedCost ? '$' + usageStats.estimatedCost.toFixed(2) : '-'}</div><div class="sl">预估费用</div></div>
</div>
${printTable('项目分布', ['项目', '请求数', '会话数'], projRows)}
${printTable('模型分布', ['模型', '请求数', '输入', '输出', '费用'], modelRows)}
${printTable('工具使用排行', ['工具', '调用次数'], toolRows)}
${printTable('场景分布', ['场景', '请求数'], scenarioRows)}
${data.costBreakdown?.models?.length ? printTable('模型费用', ['模型', '费用', '计费方式', '请求数'], data.costBreakdown.models.map(m => [m.name, '$' + (m.cost || 0).toFixed(2), m.mode === 'actual' ? '实际' : m.mode === 'estimated' ? '估算' : '未知', m.requests])) : ''}
${gitStats && gitStats.commits > 0 ? printTable('Git 代码产出', ['指标', '数值'], [['提交次数', gitStats.commits], ['新增行数', '+' + fmt(gitStats.linesAdded)], ['删除行数', '-' + fmt(gitStats.linesDeleted)], ['变更文件', gitStats.filesChanged]]) : ''}
${(imgs.scenarioChart || imgs.modelChart) ? `<h2>图表</h2><div class="charts">${imgs.scenarioChart ? '<div class="cc"><p>工作类型分布</p><img src="' + imgs.scenarioChart + '"></div>' : ''}${imgs.modelChart ? '<div class="cc"><p>模型使用分布</p><img src="' + imgs.modelChart + '"></div>' : ''}</div>` : ''}
<p class="ft">LumenCode · 数据来自本地日志，不上传至任何服务器</p>
</body></html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ccusage-${period}-${start}-${end}.html`;
  a.click();
  URL.revokeObjectURL(url);
}
