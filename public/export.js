import { TEXT } from './config.js';
import { esc, fmt, fmtShort, getChart } from './utils.js';

// 工具调用值兼容：{name: number} 或 {name: {calls, uses}}
const toolCalls = (v) => typeof v === 'number' ? v : (v.calls || 0);
const toolUses = (v) => typeof v === 'number' ? v : (v.uses || 0);
const periodName = (p) => p === 'daily' ? TEXT.DAILY : p === 'weekly' ? TEXT.WEEKLY : TEXT.MONTHLY;
const dateRange = (start, end) => start === end ? start : `${start} ~ ${end}`;
const csvCell = (s) => `"${String(s).replace(/"/g, '""')}"`;
const costModeLabel = (m) => m === 'actual' ? '实际' : m === 'estimated' ? '估算' : '未知';

// 共享 Blob 下载
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// ── 统一数据准备：CSV / HTML / Print 共用，保证三导出字段对齐 ──
// 返回纯数组/对象结构，渲染器各自决定列布局，数据源唯一
function buildSections(data) {
  const { usageStats: u = {}, gitStats: g } = data || {};

  // 概览：含 Git 指标（CSV 概览、HTML 均消费）
  const overview = [
    ['会话数', u.sessionCount],
    ['请求数', u.requestCount],
    ['用户消息', u.userMessageCount],
    ['覆盖项目', Object.keys(u.projects || {}).length],
    ['输入Token', u.inputTokens],
    ['输出Token', u.outputTokens],
    ['缓存读取Token', u.cacheRead],
  ];
  if (u.cacheCreate) overview.push(['缓存写入Token', u.cacheCreate]);
  overview.push(['总Token', u.totalTokens]);
  if (u.estimatedCost) overview.push(['预估费用', `$${u.estimatedCost.toFixed(2)}`]);
  if (u.subagentTokens > 0) overview.push(['子Agent Token', u.subagentTokens]);
  if (g && g.commits > 0) {
    overview.push(
      ['Git提交', g.commits],
      ['新增行数', `+${g.linesAdded}`],
      ['删除行数', `-${g.linesDeleted}`],
      ['变更文件', g.filesChanged],
    );
    if (g.aiContribution) {
      const ai = g.aiContribution;
      const pct = Math.round((ai.aiCommits / g.commits) * 100);
      overview.push(
        ['高/中置信AI提交', `${ai.aiCommits}/${g.commits} (${pct}%)`],
        ['高置信提交', ai.highConfidenceCommits],
        ['AI命中文件新增行', `+${ai.aiFileLinesAdded}`],
        ['AI命中文件删除行', `-${ai.aiFileLinesDeleted}`],
        ['低置信关联提交', ai.lowConfidenceCommits],
      );
    }
  }

  // 每日明细：dailyStats 仅含 requests/userMessages/inputTokens/outputTokens（aggregate.js:382）
  const daily = Object.entries(u.dailyStats || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([d, s]) => ({ date: d, requests: s.requests, userMessages: s.userMessages || 0, inputTokens: s.inputTokens, outputTokens: s.outputTokens }));

  const projects = Object.entries(u.projects || {})
    .sort((a, b) => b[1].requests - a[1].requests)
    .map(([name, d]) => ({ name, requests: d.requests, sessions: d.sessions instanceof Set ? d.sessions.size : (d.sessions || 0) }));

  const models = Object.entries(u.models || {})
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, d]) => ({ name, count: d.count, inputTokens: d.inputTokens, outputTokens: d.outputTokens, cacheRead: d.cacheRead || 0, cost: d.cost }));

  const tools = Object.entries(u.tools || {})
    .sort((a, b) => toolCalls(b[1]) - toolCalls(a[1]))
    .map(([name, v]) => ({ name, calls: toolCalls(v), uses: toolUses(v) }));

  const scenarios = Object.entries(u.scenarios || {})
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  const costModels = (data.costBreakdown?.models || [])
    .map(m => ({ name: m.name, cost: m.cost || 0, mode: m.mode, requests: m.requests }));

  // Git 子表
  const commitTypes = g?.commitTypes
    ? Object.entries(g.commitTypes).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count }))
    : [];
  const fileHotspots = (g?.fileHotspots || []).map(h => ({ path: h.path, touches: h.touches, added: h.added, deleted: h.deleted }));

  return { overview, daily, projects, models, tools, scenarios, costModels, commitTypes, fileHotspots };
}

// ── CSV 导出 ──
export function exportCSV(data, period) {
  if (!data) return;
  const s = buildSections(data);
  const out = [];

  out.push('# 概览统计', '指标,数值');
  for (const [k, v] of s.overview) out.push(`${k},${v}`);
  out.push('');

  if (s.daily.length) {
    out.push('# 每日明细', '日期,请求数,用户消息,输入Token,输出Token');
    for (const d of s.daily) out.push(`${d.date},${d.requests},${d.userMessages},${d.inputTokens},${d.outputTokens}`);
    out.push('');
  }
  if (s.projects.length) {
    out.push('# 项目分布', '项目,请求数,会话数');
    for (const p of s.projects) out.push(`${csvCell(p.name)},${p.requests},${p.sessions}`);
    out.push('');
  }
  if (s.models.length) {
    out.push('# 模型分布', '模型,请求数,输入Token,输出Token,缓存读取');
    for (const m of s.models) out.push(`${csvCell(m.name)},${m.count},${m.inputTokens},${m.outputTokens},${m.cacheRead}`);
    out.push('');
  }
  if (s.tools.length) {
    out.push('# 工具使用', '工具,调用次数,使用次数');
    for (const t of s.tools) out.push(`${t.name},${t.calls},${t.uses}`);
    out.push('');
  }
  if (s.scenarios.length) {
    out.push('# 场景分布', '场景,请求数');
    for (const sc of s.scenarios) out.push(`${sc.name},${sc.count}`);
    out.push('');
  }
  if (s.costModels.length) {
    out.push('# 模型费用', '模型,费用,计费方式,请求数');
    for (const cm of s.costModels) out.push(`${csvCell(cm.name)},$${cm.cost.toFixed(2)},${costModeLabel(cm.mode)},${cm.requests}`);
    out.push('');
  }
  if (s.commitTypes.length) {
    out.push('# 提交类型分布', '类型,数量');
    for (const ct of s.commitTypes) out.push(`${ct.type},${ct.count}`);
    out.push('');
  }
  if (s.fileHotspots.length) {
    out.push('# 文件热点Top10', '文件,触碰,+行,-行');
    for (const h of s.fileHotspots) out.push(`${csvCell(h.path)},${h.touches},+${h.added},-${h.deleted}`);
  }

  download(new Blob(['﻿' + out.join('\n')], { type: 'text/csv;charset=utf-8' }), `ccusage-${period}-${data.start}-${data.end}.csv`);
}

// ── HTML 渲染：print 与 exportHTML 共用 ──
function htmlTable(title, headers, rows) {
  if (!rows || rows.length === 0) return '';
  const head = headers.map((h, i) => `<th data-col="${i}" tabindex="0" role="button" aria-sort="none" aria-label="按 ${esc(h)} 排序">${esc(h)}</th>`).join('');
  return `<h2>${esc(title)}</h2><table><thead><tr>${head}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function collectCharts() {
  const imgs = {};
  for (const key of ['scenarioChart', 'modelChart', 'projectChart', 'toolChart', 'trendChart', 'commitTypeChart']) {
    const ch = getChart(key);
    if (ch) { try { imgs[key] = ch.toBase64Image(); } catch {} }
  }
  return imgs;
}

// 暗色：默认浅色；prefers-color-scheme 自动跟随；data-theme 手动覆盖；打印强制浅色省墨
const REPORT_CSS = `:root{--fg:#111;--bg-sub:#f5f5f5;--muted:#6b7280;--border:#e5e7eb;--th-bg:#f8f9fa;--body-bg:#fff}
[data-theme="dark"]{--fg:#e5e7eb;--bg-sub:#1f2937;--muted:#9ca3af;--border:#374151;--th-bg:#111827;--body-bg:#0b0f14}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--fg:#e5e7eb;--bg-sub:#1f2937;--muted:#9ca3af;--border:#374151;--th-bg:#111827;--body-bg:#0b0f14}}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',-apple-system,sans-serif;color:var(--fg);background:var(--body-bg);padding:32px 40px;max-width:800px;margin:0 auto;font-size:13px;line-height:1.5}
h1{font-size:20px;margin-bottom:2px;letter-spacing:-0.3px}
.sub{color:var(--muted);font-size:12px;margin-bottom:20px}
.summary{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:20px}
.s{text-align:center;padding:10px 6px;background:var(--bg-sub);border-radius:6px}
.sv{font-size:18px;font-weight:600;letter-spacing:-0.3px}
.sl{font-size:10px;color:var(--muted);margin-top:2px}
h2{font-size:13px;margin-top:18px;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid var(--border)}
table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:12px}
th,td{padding:5px 8px;text-align:left;border-bottom:1px solid var(--border)}
th{font-weight:600;background:var(--th-bg);cursor:pointer;user-select:none;white-space:nowrap}
th:hover{color:var(--muted)}
th[aria-sort="ascending"]::after{content:" \\25B4"}
th[aria-sort="descending"]::after{content:" \\25BE"}
.charts{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0}
.cc{text-align:center}
.cc p{font-size:11px;font-weight:600;margin-bottom:2px}
.cc img{max-width:100%;height:180px;object-fit:contain}
.ft{text-align:center;color:var(--muted);font-size:10px;margin-top:24px;padding-top:12px;border-top:1px solid var(--border)}
.toggle{position:fixed;top:16px;right:16px;border:1px solid var(--border);background:var(--bg-sub);color:var(--fg);padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit}
.toggle:hover{color:var(--muted)}
@media print{body{padding:20px 24px}:root,[data-theme="dark"],[data-theme="light"]{--fg:#111;--bg-sub:#f5f5f5;--muted:#6b7280;--border:#e5e7eb;--th-bg:#f8f9fa;--body-bg:#fff}.toggle{display:none}@page{margin:15mm}}`;

function renderReportHtml(data, period) {
  const s = buildSections(data);
  const u = data.usageStats;
  const pn = periodName(period);
  const imgs = collectCharts();

  const summary = `<div class="summary">
<div class="s"><div class="sv">${fmt(u.sessionCount)}</div><div class="sl">独立会话</div></div>
<div class="s"><div class="sv">${fmt(u.requestCount)}</div><div class="sl">交互轮次</div></div>
<div class="s"><div class="sv">${Object.keys(u.projects).length}</div><div class="sl">覆盖项目</div></div>
<div class="s"><div class="sv">${fmt(u.totalTokens)}</div><div class="sl">Token 消耗</div></div>
<div class="s"><div class="sv">${u.estimatedCost ? '$' + u.estimatedCost.toFixed(2) : '-'}</div><div class="sl">预估费用</div></div>
</div>`;

  const tables = [
    htmlTable('项目分布', ['项目', '请求数', '会话数'], s.projects.map(p => [p.name, p.requests, p.sessions])),
    htmlTable('模型分布', ['模型', '请求数', '输入', '输出', '费用'], s.models.map(m => [m.name, m.count, fmtShort(m.inputTokens), fmtShort(m.outputTokens), m.cost ? '$' + m.cost.toFixed(2) : '-'])),
    htmlTable('工具使用排行', ['工具', '调用次数', '使用次数'], s.tools.slice(0, 10).map(t => [t.name, t.calls, t.uses])),
    htmlTable('场景分布', ['场景', '请求数'], s.scenarios.map(sc => [sc.name, sc.count])),
    htmlTable('模型费用', ['模型', '费用', '计费方式', '请求数'], s.costModels.map(cm => [cm.name, '$' + cm.cost.toFixed(2), costModeLabel(cm.mode), cm.requests])),
    htmlTable('提交类型分布', ['类型', '数量'], s.commitTypes.map(ct => [ct.type, ct.count])),
    htmlTable('文件热点 Top 10', ['文件', '触碰', '+行', '-行'], s.fileHotspots.map(h => [h.path, h.touches, '+' + fmt(h.added), '-' + fmt(h.deleted)])),
  ].join('');

  const hasChart = imgs.scenarioChart || imgs.modelChart || imgs.projectChart || imgs.toolChart;
  const charts = hasChart ? `<h2>图表</h2><div class="charts">${imgs.scenarioChart ? `<div class="cc"><p>工作类型分布</p><img src="${imgs.scenarioChart}"></div>` : ''}${imgs.modelChart ? `<div class="cc"><p>模型使用分布</p><img src="${imgs.modelChart}"></div>` : ''}</div>${(imgs.projectChart || imgs.toolChart) ? `<div class="charts">${imgs.projectChart ? `<div class="cc"><p>项目使用分布</p><img src="${imgs.projectChart}"></div>` : ''}${imgs.toolChart ? `<div class="cc"><p>工具调用排行</p><img src="${imgs.toolChart}"></div>` : ''}</div>` : ''}` : '';

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>AI 编码助手使用${pn}</title>
<style>
${REPORT_CSS}
</style></head><body>
<button class="toggle" id="theme-toggle" aria-label="切换主题">🌙 暗色</button>
<h1>AI 编码助手使用${pn}</h1>
<p class="sub">${dateRange(data.start, data.end)} · 生成于 ${new Date().toLocaleString('zh-CN')}</p>
${summary}
${tables}
${charts}
<p class="ft">LumenCode · 数据来自本地日志，不上传至任何服务器</p>
<script>
(function(){
  var root=document.documentElement,btn=document.getElementById('theme-toggle');
  // 主题：优先 localStorage 记忆，否则跟随系统
  try{var s=localStorage.getItem('lc-report-theme');if(s)root.setAttribute('data-theme',s);}catch(e){}
  function isDark(){var t=root.getAttribute('data-theme');return t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches);}
  function sync(){btn.textContent=isDark()?'☀ 浅色':'🌙 暗色';}
  sync();
  btn.addEventListener('click',function(){root.setAttribute('data-theme',isDark()?'light':'dark');try{localStorage.setItem('lc-report-theme',root.getAttribute('data-theme'));}catch(e){}sync();});
  // 表格排序：点击/回车表头，数值列数值排序，占位符(-/空)沉底
  function num(v){var n=parseFloat(String(v).replace(/[^0-9.\\-]/g,''));return isFinite(n)?n:NaN;}
  function cellVal(c){var t=(c&&c.textContent||'').trim();return t==='-'||t===''?{num:true,n:-Infinity,s:t}:{num:isFinite(num(t)),n:num(t),s:t};}
  document.querySelectorAll('table').forEach(function(table){
    var tbody=table.querySelector('tbody');if(!tbody)return;
    table.querySelectorAll('th').forEach(function(th,ci){
      var fire=function(){
        var rows=Array.from(tbody.rows),asc=th.getAttribute('aria-sort')!=='ascending';
        var allNum=rows.every(function(r){var v=cellVal(r.cells[ci]);return v.num;});
        rows.sort(function(a,b){var x=cellVal(a.cells[ci]),y=cellVal(b.cells[ci]);if(allNum)return x.n-y.n;return x.s.localeCompare(y.s,'zh');});
        if(!asc)rows.reverse();
        rows.forEach(function(r){tbody.appendChild(r);});
        table.querySelectorAll('th').forEach(function(h){h.setAttribute('aria-sort','none');});
        th.setAttribute('aria-sort',asc?'ascending':'descending');
      };
      th.addEventListener('click',fire);
      th.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();fire();}});
    });
  });
})();
</script>
</body></html>`;
}

// ── Print / PDF ──
export function printReport(data, period) {
  if (!data) return;
  const win = window.open('', '_blank');
  win.document.write(renderReportHtml(data, period));
  win.document.close();
  setTimeout(() => { win.print(); }, 400);
}

// ── HTML 导出 ──
export function exportHTML(data, period) {
  if (!data) return;
  download(new Blob([renderReportHtml(data, period)], { type: 'text/html;charset=utf-8' }), `ccusage-${period}-${data.start}-${data.end}.html`);
}

// ── JSON 导出 ──
// ponytail: Set→Array replacer，避免 projects[].sessions（Set）序列化为 {} 丢数据
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
  }, (k, v) => v instanceof Set ? [...v] : v, 2);
  download(new Blob([json], { type: 'application/json' }), `ccusage-${period}-${data.start}-${data.end}.json`);
}
