import { COLORS, SCENARIO_COLORS, COMMIT_TYPE_COLORS } from './config.js';
import { esc, fmt, fmtShort, destroyChart, setChart } from './utils.js';

/* ── Work Type Pie (doughnut with inner radius) ── */
export function renderWorkTypePie(canvasId, entries) {
  destroyChart(canvasId);
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const isDark = document.documentElement.classList.contains('dark');
  const ttBg = isDark ? '#1f222a' : '#f0eee7';
  const ttFg = isDark ? '#e8e9ef' : '#15151a';

  const labels = entries.map(([k]) => k);
  const data = entries.map(([, v]) => v);
  const colors = labels.map(k => SCENARIO_COLORS[k] || '#888');

  const chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderWidth: 0,
        hoverOffset: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: ttBg,
          titleColor: ttFg,
          bodyColor: ttFg,
          borderColor: isDark ? 'rgba(232,233,239,0.12)' : 'rgba(21,21,26,0.12)',
          borderWidth: 1,
          borderWidth: 0,
          cornerRadius: 0,
          padding: 8,
          titleFont: { family: 'JetBrains Mono', size: 11 },
          bodyFont: { family: 'JetBrains Mono', size: 11 },
          callbacks: {
            label: (c) => {
              const total = c.dataset.data.reduce((s, v) => s + v, 0);
              return ` ${c.label}: ${c.raw} (${((c.raw / total) * 100).toFixed(1)}%)`;
            },
          },
        },
      },
      onClick: (evt, elements) => {
        if (elements.length === 0) return;
        const label = entries[elements[0].index]?.[0];
        const scenarioKeyMap = { '编码': 'coding', '测试/QA': 'testing', '调试/排错': 'debugging', '文档': 'documentation', '阅读/研究': 'reading', '规划/设计': 'planning', '代码审查': 'review' };
        const key = scenarioKeyMap[label];
        if (!key) return;
        if (typeof window._drillHandler === 'function') window._drillHandler('scenario', key, label);
      },
    },
  });
  setChart(canvasId, chart);
}

/* ── Project Bars (horizontal bar, minimal style) ── */
export function renderProjectBars(canvasId, entries) {
  destroyChart(canvasId);
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const isDark = document.documentElement.classList.contains('dark');
  const gridColor = isDark ? 'rgba(232,233,239,0.06)' : 'rgba(21,21,26,0.06)';
  const tickColor = isDark ? 'rgba(232,233,239,0.55)' : 'rgba(21,21,26,0.55)';
  const barColor = isDark ? '#e8e9ef' : '#15151a';
  const accentColor = isDark ? '#7480e8' : '#4a52a8';
  const ttBg = isDark ? '#1f222a' : '#f0eee7';
  const ttFg = isDark ? '#e8e9ef' : '#15151a';

  const chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: entries.map(([k]) => k.length > 20 ? '...' + k.slice(-17) : k),
      datasets: [{
        data: entries.map(([, v]) => v.requests),
        backgroundColor: entries.map((_, i) => i === 0 ? accentColor : barColor),
        borderRadius: 4,
        maxBarThickness: 14,
        barPercentage: 0.7,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      scales: {
        x: {
          grid: { color: gridColor, drawBorder: false },
          ticks: { font: { family: 'JetBrains Mono', size: 10 }, color: tickColor },
          border: { display: false },
        },
        y: {
          grid: { display: false },
          ticks: { font: { family: 'JetBrains Mono', size: 11 }, color: tickColor },
          border: { display: false },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: ttBg,
          titleColor: ttFg,
          bodyColor: ttFg,
          borderColor: isDark ? 'rgba(232,233,239,0.12)' : 'rgba(21,21,26,0.12)',
          borderWidth: 1,
          cornerRadius: 4,
          padding: 8,
          titleFont: { family: 'JetBrains Mono', size: 11 },
          bodyFont: { family: 'JetBrains Mono', size: 11 },
        },
      },
      onClick: async (evt, elements) => {
        if (elements.length === 0) return;
        const project = entries[elements[0].index][0];
        showDrill(esc(project), '<div class="drill-empty">加载中...</div>');
        try {
          const appEl = document.querySelector('[x-data]');
          const app = appEl?._x_dataStack?.[0];
          const params = { project, period: app?.period || 'daily', date: app?.currentDate || new Date().toISOString().slice(0, 10) };
          if (app?.activeTool && app.activeTool !== 'all') params.tool = app.activeTool;
          const { fetchSessions } = await import('./api.js');
          const rows = await fetchSessions(params);
          renderSessionDrill(project, rows);
        } catch { showDrill(esc(project), '<div class="drill-empty">加载失败</div>'); }
      },
    },
  });
  setChart(canvasId, chart);
}

/* ── Timeline Area Chart ── */
export function renderTimelineArea(canvasId, trendData) {
  destroyChart(canvasId);
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const dates = Object.keys(trendData.dailyStats || {}).sort();
  if (dates.length === 0) return;

  const sessions = dates.map(d => trendData.dailyStats[d].requests || 0);
  const tokens = dates.map(d => ((trendData.dailyStats[d].inputTokens || 0) + (trendData.dailyStats[d].outputTokens || 0)) / 1_000_000);
  const labels = dates.map(d => d.slice(5));

  const isDark = document.documentElement.classList.contains('dark');
  const gridColor = isDark ? 'rgba(232,233,239,0.06)' : 'rgba(21,21,26,0.06)';
  const tickColor = isDark ? 'rgba(232,233,239,0.55)' : 'rgba(21,21,26,0.55)';
  const sessionColor = isDark ? '#e8e9ef' : '#15151a';
  const ttBg = isDark ? '#1f222a' : '#f0eee7';
  const ttFg = isDark ? '#e8e9ef' : '#15151a';

  /* Create gradient for tokens area */
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height || 280);
  gradient.addColorStop(0, 'rgba(116, 128, 232, 0.45)');
  gradient.addColorStop(0.6, 'rgba(94, 194, 220, 0.18)');
  gradient.addColorStop(1, 'rgba(94, 194, 168, 0)');

  const chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Tokens (M)',
          data: tokens,
          borderColor: '#7480e8',
          backgroundColor: gradient,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 1.4,
        },
        {
          label: 'Sessions',
          data: sessions,
          borderColor: sessionColor,
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 1.5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          grid: { color: gridColor, borderDash: [2, 4], drawBorder: false },
          ticks: { font: { family: 'JetBrains Mono', size: 10 }, color: tickColor, maxTicksLimit: 12 },
          border: { display: false },
        },
        y: {
          grid: { color: gridColor, drawBorder: false },
          ticks: { font: { family: 'JetBrains Mono', size: 10 }, color: tickColor },
          border: { display: false },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: ttBg,
          titleColor: ttFg,
          bodyColor: ttFg,
          borderColor: isDark ? 'rgba(232,233,239,0.12)' : 'rgba(21,21,26,0.12)',
          borderWidth: 1,
          cornerRadius: 4,
          padding: 8,
          titleFont: { family: 'JetBrains Mono', size: 11 },
          bodyFont: { family: 'JetBrains Mono', size: 11 },
        },
      },
    },
  });
  setChart(canvasId, chart);
}

/* ── Cache Stack (simple bar) ── */
export function renderCacheStack(canvasId, cacheRead, cacheCreate, inputTokens) {
  destroyChart(canvasId);
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const isDark = document.documentElement.classList.contains('dark');
  const ttBg = isDark ? '#1f222a' : '#f0eee7';
  const ttFg = isDark ? '#e8e9ef' : '#15151a';
  const forestColor = isDark ? '#5ec2a8' : '#3d7558';
  const rustColor = isDark ? '#7480e8' : '#4a52a8';
  const ochreColor = isDark ? '#c9a86b' : '#9a7836';

  const chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Token 构成'],
      datasets: [
        { label: '缓存命中', data: [cacheRead], backgroundColor: forestColor, borderRadius: 4 },
        { label: '新输入', data: [inputTokens], backgroundColor: rustColor, borderRadius: 4 },
        { label: '缓存写入', data: [cacheCreate], backgroundColor: ochreColor, borderRadius: 4 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          ticks: { display: false },
          border: { display: false },
        },
        y: {
          stacked: true,
          grid: { display: false },
          ticks: { display: false },
          border: { display: false },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: ttBg,
          titleColor: ttFg,
          bodyColor: ttFg,
          borderColor: isDark ? 'rgba(232,233,239,0.12)' : 'rgba(21,21,26,0.12)',
          borderWidth: 1,
          cornerRadius: 4,
          padding: 8,
        },
      },
    },
  });
  setChart(canvasId, chart);
}

/* ── Model Bars (rendered as HTML, not Chart.js, but kept for compatibility) ── */
export function renderModelBars(containerId, entries) {
  /* This is rendered via Alpine reactive data in app.js */
}

/* ── Drill helpers ── */
function showDrill(title, html) {
  const modal = document.getElementById('drillModal');
  const t = document.getElementById('drillTitle');
  const b = document.getElementById('drillBody');
  if (t) t.textContent = title;
  if (b) b.innerHTML = html;
  if (modal) modal.style.display = 'flex';
}

function renderSessionDrill(project, rows) {
  if (!rows.length) { showDrill(esc(project), '<div class="drill-empty">无数据</div>'); return; }
  const html = '<table class="drill-table">'
    + '<tr><th></th><th>会话ID</th><th>开始</th><th>时长</th><th>请求</th><th>Tokens</th><th>工具</th><th>文件</th><th>提交</th></tr>'
    + rows.map((r, i) => {
        const start = r.startTime ? r.startTime.slice(0, 16).replace('T', ' ') : '-';
        const dur = r.duration ? (r.duration >= 3600 ? (r.duration / 3600).toFixed(1) + 'h' : r.duration >= 60 ? Math.round(r.duration / 60) + 'm' : r.duration + 's') : '-';
        const cn = r.commits?.length || 0;
        const childN = r.children?.length || 0;
        // 下钻优先子代理（爆表根因），其次提交
        const toggle = childN > 0
          ? `<button class="children-toggle" data-idx="${i}">▸</button>`
          : cn > 0 ? `<button class="commit-toggle" data-idx="${i}">▸</button>` : '';
        const tools = [...new Set(r.toolSequence || [])].slice(0, 3).join(', ');
        const fileCount = r.touchedFileCount || 0;
        const tt = r.totalTokens || 0;
        const ttStr = tt >= 1e6 ? (tt / 1e6).toFixed(1) + 'M' : tt >= 1e3 ? (tt / 1e3).toFixed(0) + 'K' : String(tt);
        const badge = r.isHeavy ? `<span class="sess-badge heavy">🔥 ${ttStr}</span>` : r.isWarn ? `<span class="sess-badge warn">⚡ ${ttStr}</span>` : ttStr;
        const commitRows = cn > 0
          ? `<tr class="commit-subrow" data-idx="${i}" style="display:none;"><td colspan="9"><table class="commit-subtable">
               <tr><th>hash</th><th>type</th><th>subject</th><th class="num">+行</th><th class="num">-行</th><th>AI</th><th>证据</th></tr>
               ${r.commits.map(c => `<tr>
                 <td class="hash"><code>${c.hash.slice(0,7)}</code></td>
                 <td><span class="commit-type-tag type-${c.type}">${c.type}</span></td>
                 <td class="commit-subject" title="${esc(c.subject)}">${esc(c.subject)}</td>
                 <td class="num pos">+${fmt(c.linesAdded || 0)}</td>
                 <td class="num neg">-${fmt(c.linesDeleted || 0)}</td>
                 <td>${c.aiConfidence === 'high' ? 'H' : c.aiConfidence === 'medium' ? 'M' : c.aiConfidence === 'low' ? 'L' : ''}</td>
                 <td>${c.aiEvidenceDetails?.matchedFileCount ? `文件交集 ${c.aiEvidenceDetails.matchedFileCount}` : (c.attributionType || '')}</td>
               </tr>`).join('')}
             </table></td></tr>`
          : '';
        const childRows = childN > 0
          ? `<tr class="children-subrow" data-idx="${i}" style="display:none;"><td colspan="9"><table class="commit-subtable">
               <tr><th>子会话</th><th class="num">Tokens</th><th>工具</th><th class="num">请求</th></tr>
               ${r.children.map(c => {
                 const ct = c.totalTokens || 0;
                 const ctStr = ct >= 1e6 ? (ct / 1e6).toFixed(1) + 'M' : ct >= 1e3 ? (ct / 1e3).toFixed(0) + 'K' : String(ct);
                 const cbadge = c.isHeavy ? `<span class="sess-badge heavy">🔥 ${ctStr}</span>` : c.isWarn ? `<span class="sess-badge warn">⚡ ${ctStr}</span>` : ctStr;
                 return `<tr><td class="drill-text" title="${esc(c.id)}">${esc(String(c.id).slice(0, 12))}…</td><td class="num">${cbadge}</td><td>${esc(c.primaryTool || '-')}</td><td class="num">${c.requests || 0}</td></tr>`;
               }).join('')}
             </table></td></tr>`
          : '';
        return `<tr><td>${toggle}</td><td class="drill-text" title="${esc(r.id)}">${esc(r.id)}</td><td>${start}</td><td>${dur}</td><td>${r.requests || '-'}</td><td class="num">${badge}</td><td class="drill-text">${tools || '-'}</td><td>${fileCount || '-'}</td><td>${cn || '-'}</td></tr>${commitRows}${childRows}`;
      }).join('')
    + '</table>';
  showDrill(esc(project) + ' 会话记录', html);
  // 通用行展开：commit 子表 / children 子代理子表
  const bindToggle = (toggleClass, subrowClass) => {
    document.querySelectorAll('.' + toggleClass).forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = btn.dataset.idx;
        const sub = document.querySelector(`.${subrowClass}[data-idx="${idx}"]`);
        if (!sub) return;
        const open = sub.style.display !== 'none';
        sub.style.display = open ? 'none' : '';
        btn.textContent = open ? '▸' : '▾';
      });
    });
  };
  bindToggle('commit-toggle', 'commit-subrow');
  bindToggle('children-toggle', 'children-subrow');
}
