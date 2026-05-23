// HTML 实体转义
export function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 数字格式化
export function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + ' M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + ' K';
  return n.toLocaleString('zh-CN');
}

// 短数字格式化（图表用）
export function fmtShort(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

// Chart 实例注册表
const charts = {};

export function getChart(key) {
  return charts[key] || null;
}

export function setChart(key, instance) {
  charts[key] = instance;
}

export function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}

export function destroyAllCharts(keys) {
  keys.forEach(destroyChart);
}

// 趋势箭头
export function renderTrendArrow(elId, current, previous) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (previous == null || previous === undefined || previous === 0 || current == null || current === undefined) {
    el.textContent = '';
    el.className = 'card-trend';
    return;
  }
  const pct = ((current - previous) / previous * 100).toFixed(0);
  const val = Math.abs(Number(pct));
  if (pct > 0) { el.textContent = `↑${val}%`; el.className = 'card-trend up'; }
  else if (pct < 0) { el.textContent = `↓${val}%`; el.className = 'card-trend down'; }
  else { el.textContent = '—'; el.className = 'card-trend flat'; }
}

// Chart 更新或创建：若实例存在且类型匹配则 update，否则 destroy + recreate
export function getOrCreateChart(key, canvasId, factory) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const existing = getChart(key);
  if (existing) {
    try {
      return factory(existing, canvas);
    } catch {
      destroyChart(key);
    }
  }
  const instance = factory(null, canvas);
  if (instance) setChart(key, instance);
  return instance;
}
