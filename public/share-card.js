import { fmt, fmtShort } from './utils.js';

// 纯数据派生：从报告数据提取卡片所需字段。无 DOM/Canvas 依赖，可单测。
export function extractCardData(data, period) {
  const u = data?.usageStats || {};
  const g = data?.gitStats;
  const ai = g?.aiContribution;

  const periodLabel = formatPeriodLabel(period, data.start, data.end);

  let headline;
  const hasGit = !!(g && g.commits > 0 && ai);
  if (hasGit) {
    const totalLines = ai.totalLinesChanged || (ai.aiFileLinesAdded + ai.aiFileLinesDeleted + (ai.humanLinesChanged || 0)) || 1;
    const pct = Math.round((ai.aiLinesChanged / totalLines) * 100) || Math.round((ai.aiLineRatio || 0) * 100);
    headline = { label: 'AI 贡献率', value: `${pct}%` };
  } else {
    headline = { label: 'AI 交互次数', value: String(u.requestCount || 0) };
  }

  const stats = [];
  if (u.estimatedCost) stats.push({ label: '等效费用', value: `$${u.estimatedCost.toFixed(2)}` });
  if (hasGit) {
    // ponytail: 卡片 stat 列宽 260px，省略 -deleted 避免截断省略号；完整 +/- 在详报
    stats.push({ label: 'Git 产出', value: `${g.commits} commits · +${fmtShort(g.linesAdded)}` });
  } else if (u.totalTokens) {
    stats.push({ label: 'Token 消耗', value: fmtShort(u.totalTokens) });
  }
  if (u.sessionCount) stats.push({ label: '会话数', value: fmt(u.sessionCount) });
  const projects = Object.entries(u.projects || {})
    .filter(([, d]) => d.requests > 0)
    .sort((a, b) => b[1].requests - a[1].requests);
  if (projects.length) {
    const top = projects[0][0].replace(/\\/g, '/').replace(/\/$/, '').split('/').pop();
    stats.push({ label: '主力项目', value: top });
  }

  return { headline, periodLabel, stats: stats.slice(0, 4), hasGit };
}

function formatPeriodLabel(period, start, end) {
  switch (period) {
    case 'daily': return `日报 ${start}`;
    case 'weekly': return `周报 ${start} ~ ${end}`;
    case 'monthly': return `月报 ${start.slice(0, 7)}`;
    default: return `${start} ~ ${end}`;
  }
}

// Canvas 离屏渲染 1200×630 PNG。零新依赖，浏览器原生 Canvas 2D。
// style: 'aurora'（暗色发光）| 'clean'（干净风）；theme: 'dark' | 'light'
export async function renderShareCard(data, period, { style = 'aurora', theme = 'dark' } = {}) {
  const card = extractCardData(data, period);
  const W = 1200, H = 630;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';

  const pal = palette(style, theme);
  drawBackground(ctx, W, H, pal, style);
  drawHeadline(ctx, W, H, card, pal);
  drawStats(ctx, W, H, card, pal);
  drawBrandBand(ctx, W, H, pal);

  return new Promise(resolve => canvas.toBlob(b => resolve(b), 'image/png'));
}

function palette(style, theme) {
  const aurora = ['#7480e8', '#5ec2dc', '#5ec2a8'];
  if (style === 'aurora') {
    return { bg: '#0b0f14', fg: '#e5e7eb', muted: '#9ca3af', border: '#1f2937', accent: '#5ec2dc', aurora };
  }
  // clean
  if (theme === 'light') {
    return { bg: '#ffffff', fg: '#1f2328', muted: '#6b7280', border: '#e5e7eb', accent: '#0969da', aurora };
  }
  return { bg: '#0d1117', fg: '#e6edf3', muted: '#8b949e', border: '#30363d', accent: '#58a6ff', aurora };
}

function drawBackground(ctx, W, H, pal, style) {
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, W, H);
  if (style === 'aurora') {
    // 顶部极光发光斑
    const g = ctx.createRadialGradient(W * 0.78, H * 0.12, 20, W * 0.78, H * 0.12, 420);
    g.addColorStop(0, 'rgba(94,194,220,0.28)');
    g.addColorStop(0.5, 'rgba(116,128,232,0.12)');
    g.addColorStop(1, 'rgba(11,15,20,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const g2 = ctx.createRadialGradient(W * 0.15, H * 0.85, 10, W * 0.15, H * 0.85, 360);
    g2.addColorStop(0, 'rgba(94,194,168,0.18)');
    g2.addColorStop(1, 'rgba(11,15,20,0)');
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.strokeStyle = pal.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
}

function drawHeadline(ctx, W, H, card, pal) {
  // 周期小标签
  ctx.fillStyle = pal.muted;
  ctx.font = '500 22px "Inter Tight", -apple-system, sans-serif';
  ctx.fillText(card.periodLabel, 64, 110);

  // 头部 label
  ctx.fillStyle = pal.muted;
  ctx.font = '600 20px "Inter Tight", sans-serif';
  const EN_LABEL = card.headline.label === 'AI 贡献率' ? 'AI CONTRIBUTION'
    : card.headline.label === 'AI 交互次数' ? 'AI INTERACTIONS'
    : card.headline.label.toUpperCase();
  ctx.fillText(card.headline.label + ' / ' + EN_LABEL, 64, 200);

  // 大数字（极光渐变描边）
  ctx.font = '200 180px "Inter Tight", sans-serif';
  const maxHeadlineW = W - 64 - 64;
  let fs = 180;
  while (fs > 90 && ctx.measureText(card.headline.value).width > maxHeadlineW) {
    fs -= 20;
    ctx.font = `200 ${fs}px "Inter Tight", sans-serif`;
  }
  const grad = ctx.createLinearGradient(64, 220, 64 + 560, 400);
  grad.addColorStop(0, pal.aurora[0]);
  grad.addColorStop(0.5, pal.aurora[1]);
  grad.addColorStop(1, pal.aurora[2]);
  ctx.fillStyle = grad;
  ctx.fillText(card.headline.value, 64, 380);
}

function drawStats(ctx, W, H, card, pal) {
  if (!card.stats.length) return;
  const startX = 64, y = 470, gap = 280;
  ctx.font = '500 14px "Inter Tight", sans-serif';
  card.stats.forEach((s, i) => {
    const x = startX + i * gap;
    ctx.fillStyle = pal.muted;
    ctx.fillText(s.label, x, y);
    ctx.fillStyle = pal.fg;
    ctx.font = '600 22px "Inter Tight", sans-serif';
    let val = s.value;
    const maxStatW = 260;
    if (ctx.measureText(val).width > maxStatW) {
      while (val.length > 1 && ctx.measureText(val + '…').width > maxStatW) val = val.slice(0, -1);
      val = val + '…';
    }
    ctx.fillText(val, x, y + 34);
    ctx.font = '500 14px "Inter Tight", sans-serif';
  });
}

function drawBrandBand(ctx, W, H, pal) {
  const bandY = H - 76;
  ctx.strokeStyle = pal.border;
  ctx.beginPath();
  ctx.moveTo(64, bandY); ctx.lineTo(W - 64, bandY);
  ctx.stroke();

  // 极光圆点 + wordmark
  const dotX = 64, dotY = bandY + 38, r = 12;
  const g = ctx.createLinearGradient(dotX - r, dotY - r, dotX + r, dotY + r);
  g.addColorStop(0, pal.aurora[0]); g.addColorStop(0.5, pal.aurora[1]); g.addColorStop(1, pal.aurora[2]);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(dotX + r, dotY, r, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = pal.fg;
  ctx.font = '600 20px "Inter Tight", sans-serif';
  ctx.fillText('lumenCode', dotX + 38, dotY + 7);

  // install 命令 + github 回流链接（带 ref 参数，best-effort 归因）
  ctx.fillStyle = pal.muted;
  ctx.font = '500 15px "JetBrains Mono", monospace';
  ctx.fillText('npm i -g lumencode', 300, dotY + 7);
  ctx.fillStyle = pal.accent;
  ctx.fillText('github.com/yaowen51888-rich/lumencode?ref=lumencode-card', 520, dotY + 7);
}
