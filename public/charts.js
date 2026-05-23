import { COLORS, SCENARIO_COLORS, COMMIT_TYPE_COLORS, TEXT } from './config.js';
import { esc, fmt, fmtShort, destroyChart, setChart } from './utils.js';

// ── Doughnut ──
export function renderDoughnut(canvasId, dataMap, label) {
  destroyChart(canvasId);
  const entries = Object.entries(dataMap).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const wrap = document.getElementById(canvasId).parentElement;
  wrap.style.height = '260px';
  const ctx = document.getElementById(canvasId).getContext('2d');
  const colors = entries.map(([k]) => SCENARIO_COLORS[k] || COLORS[entries.length % COLORS.length]);
  const instance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: entries.map(([k]) => k),
      datasets: [{ data: entries.map(([, v]) => v), backgroundColor: colors, borderWidth: 0, hoverOffset: 4 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '65%',
      plugins: {
        legend: { position: 'bottom', labels: { font: { family: 'Inter', size: 11 }, padding: 12, boxWidth: 10, usePointStyle: true, pointStyle: 'circle' } },
        tooltip: { callbacks: { label: (c) => { const total = c.dataset.data.reduce((s, v) => s + v, 0); return ` ${c.label}: ${c.raw} (${((c.raw / total) * 100).toFixed(1)}%)`; } } },
      },
      onClick: (evt, elements) => {
        if (elements.length === 0) return;
        const clickEntries = Object.entries(dataMap).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
        const label = clickEntries[elements[0].index]?.[0];
        const scenarioKeyMap = { '编码': 'coding', '测试/QA': 'testing', '调试/排错': 'debugging', '文档': 'documentation', '阅读/研究': 'reading', '规划/设计': 'planning', '代码审查': 'review' };
        const key = scenarioKeyMap[label];
        if (!key) return;
        if (typeof window._drillHandler === 'function') window._drillHandler('scenario', key, label);
      },
    },
  });
  setChart(canvasId, instance);
  return instance;
}

// ── Bar ──
export function renderBar(canvasId, labels, data, datasetLabel) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId).getContext('2d');
  const instance = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: datasetLabel, data, backgroundColor: '#374151', borderRadius: 6, maxBarThickness: 20, barPercentage: 0.7 }] },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      scales: { x: { grid: { color: '#f3f4f6' }, ticks: { font: { family: 'Inter', size: 11 } } }, y: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 12 } } } },
      plugins: { legend: { display: false } },
    },
  });
  setChart(canvasId, instance);
  return instance;
}

// ── Commit Type ──
export function renderCommitTypeChart(typeEntries) {
  destroyChart('commitTypeChart');
  const canvas = document.getElementById('commitTypeChart');
  const wrap = canvas.parentElement;
  wrap.style.height = Math.max(180, typeEntries.length * 32 + 40) + 'px';
  const labels = typeEntries.map(([k]) => k);
  const data = typeEntries.map(([, v]) => v);
  const colors = labels.map(k => COMMIT_TYPE_COLORS[k] || COMMIT_TYPE_COLORS.other);
  const ctx = canvas.getContext('2d');
  const instance = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: '提交数', data, backgroundColor: colors, borderRadius: 6, maxBarThickness: 20, barPercentage: 0.65, categoryPercentage: 0.85 }] },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      scales: { x: { grid: { color: '#f3f4f6' }, ticks: { font: { family: 'Inter', size: 11 }, precision: 0 } }, y: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 12 } } } },
      plugins: { legend: { display: false } },
    },
  });
  setChart('commitTypeChart', instance);
  return instance;
}

// ── Trend (dual-axis line) ──
export function renderTrend(trendData) {
  destroyChart('trendChart');
  const dates = Object.keys(trendData.dailyStats).sort();
  const requests = dates.map(d => trendData.dailyStats[d].requests);
  const tokens = dates.map(d => ((trendData.dailyStats[d].inputTokens || 0) + (trendData.dailyStats[d].outputTokens || 0)) / 1000);
  const labels = dates.map(d => d.slice(5));
  const ctx = document.getElementById('trendChart');
  if (!ctx) return null;
  const instance = new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: '请求数', data: requests, borderColor: '#111111', backgroundColor: 'rgba(17,17,17,0.08)', fill: true, tension: 0.3, pointRadius: 3, yAxisID: 'y' },
        { label: 'Token (K)', data: tokens, borderColor: '#8b5cf6', backgroundColor: 'rgba(139,92,246,0.08)', fill: true, tension: 0.3, pointRadius: 3, yAxisID: 'y1' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      scales: {
        y: { position: 'left', grid: { color: '#f3f4f6' }, ticks: { font: { family: 'Inter', size: 11 } }, title: { display: true, text: '请求数', font: { family: 'Inter', size: 12 } } },
        y1: { position: 'right', grid: { display: false }, ticks: { font: { family: 'Inter', size: 11 } }, title: { display: true, text: 'Token (K)', font: { family: 'Inter', size: 12 } } },
        x: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 11 } } },
      },
      plugins: { legend: { position: 'top', labels: { font: { family: 'Inter', size: 12 }, padding: 16 } } },
    },
  });
  setChart('trendChart', instance);
  return instance;
}

// ── Cache Efficiency ──
export function renderCacheEfficiency(canvasId, cacheRead, cacheCreate, inputTokens, costBreakdown) {
  const total = cacheRead + inputTokens + cacheCreate;
  if (total === 0) { destroyChart(canvasId); return null; }

  destroyChart(canvasId);
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const instance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Token 构成'],
      datasets: [
        { label: '缓存命中', data: [cacheRead], backgroundColor: '#22c55e', borderRadius: 4 },
        { label: '新输入', data: [inputTokens], backgroundColor: '#3b82f6', borderRadius: 4 },
        { label: '缓存写入', data: [cacheCreate], backgroundColor: '#f59e0b', borderRadius: 4 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      scales: {
        x: { stacked: true, grid: { color: '#f3f4f6' }, ticks: { font: { family: 'Inter', size: 11 }, callback: v => fmtShort(v) } },
        y: { stacked: true, grid: { display: false }, ticks: { font: { family: 'Inter', size: 12 } } },
      },
      plugins: {
        legend: { position: 'bottom', labels: { font: { family: 'Inter', size: 11 }, padding: 12, boxWidth: 10, usePointStyle: true, pointStyle: 'circle' } },
        tooltip: {
          callbacks: {
            label: (c) => {
              const pct = total > 0 ? ((c.raw / total) * 100).toFixed(1) : 0;
              return ` ${c.dataset.label}: ${fmtShort(c.raw)} (${pct}%)`;
            },
          },
        },
      },
    },
  });
  setChart(canvasId, instance);
  return instance;
}

// ── Model Cost ──
export function renderModelCostChart(canvasId, models, costBreakdown) {
  if (!costBreakdown?.models?.length) { destroyChart(canvasId); return null; }

  const entries = costBreakdown.models.filter(m => m.cost > 0);
  if (entries.length === 0) { destroyChart(canvasId); return null; }

  const labels = entries.map(m => m.name.length > 22 ? '...' + m.name.slice(-19) : m.name);
  const data = entries.map(m => m.cost);
  const modeColors = { actual: '#22c55e', estimated: '#3b82f6', unknown: '#9ca3af' };
  const colors = entries.map(m => modeColors[m.mode] || modeColors.unknown);

  destroyChart(canvasId);
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const instance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: '费用 ($)', data, backgroundColor: colors, borderRadius: 6, maxBarThickness: 20, barPercentage: 0.7 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      scales: {
        x: { grid: { color: '#f3f4f6' }, ticks: { font: { family: 'Inter', size: 11 }, callback: v => '$' + v.toFixed(2) } },
        y: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 12 } } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => {
              const entry = entries[c.dataIndex];
              const modeLabel = { actual: '实际计费', estimated: '估算', unknown: '未知定价' };
              return ` $${c.raw.toFixed(2)} (${modeLabel[entry?.mode] || entry?.mode}, ${entry?.requests || 0} 次)`;
            },
          },
        },
      },
    },
  });
  setChart(canvasId, instance);
  return instance;
}
