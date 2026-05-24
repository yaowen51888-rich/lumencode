import { esc, fmt, destroyChart } from './utils.js';

/* ── Git Insights (adapted for new design) ──
   In the new design, AI contribution is rendered directly via Alpine.js
   reactive data in app.js. This module is kept for backward compatibility
   and provides data formatting utilities. ── */

export function renderGitInsights(gitStats, activeTool = 'all') {
  /* No-op: new design renders git insights via Alpine reactive state */
  if (!gitStats) return;
  /* Render commit type chart if a container exists (legacy fallback) */
  const typeEntries = gitStats.commitTypes
    ? Object.entries(gitStats.commitTypes).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    : [];
  if (typeEntries.length > 0 && document.getElementById('commitTypeChart')) {
    renderCommitTypeChart(typeEntries);
  }
}

function renderCommitTypeChart(typeEntries) {
  destroyChart('commitTypeChart');
  const canvas = document.getElementById('commitTypeChart');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  if (wrap) wrap.style.height = Math.max(180, typeEntries.length * 32 + 40) + 'px';
  const labels = typeEntries.map(([k]) => k);
  const data = typeEntries.map(([, v]) => v);
  const colors = labels.map(k => COMMIT_TYPE_COLORS[k] || COMMIT_TYPE_COLORS.other);
  const ctx = canvas.getContext('2d');
  const instance = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: '提交数', data, backgroundColor: colors, borderRadius: 6, maxBarThickness: 20, barPercentage: 0.65, categoryPercentage: 0.85 }] },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      scales: { x: { grid: { color: 'var(--border)' }, ticks: { font: { family: 'JetBrains Mono', size: 11 }, precision: 0 } }, y: { grid: { display: false }, ticks: { font: { family: 'JetBrains Mono', size: 12 } } } },
      plugins: { legend: { display: false } },
    },
  });
  setChart('commitTypeChart', instance);
}

const COMMIT_TYPE_COLORS = {
  feat: '#8ab8a0', fix: '#c49090', refactor: '#a090c0', docs: '#90a8c8',
  test: '#c8b880', chore: '#a8a8a8', perf: '#c890b0', style: '#80b8b8',
  ci: '#c8a080', build: '#a8c880', revert: '#c49090', other: '#b8b8b8',
};
