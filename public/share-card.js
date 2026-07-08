import { fmt, fmtShort } from './utils.js';
import qrcode from './vendor/qrcode-generator.js';

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

// 卡片尺寸。横图 OG 比例；竖图 3:4 适配微信/小红书信息流（不被裁切）。
export const CARD_SIZES = {
  landscape: { W: 1200, H: 630 },
  portrait: { W: 1200, H: 1600 },
};

// 扫码回流 URL（PNG 链接不可点，QR 修正归因闭环）。
const QR_URL = 'https://github.com/yaowen51888-rich/lumencode?ref=lumencode-card';

// Canvas 离屏渲染 PNG。零新依赖（QR 用本地 vendor），浏览器原生 Canvas 2D。
// style: 'aurora'（暗色发光）| 'light'（浅色模式）；orientation: 'landscape' | 'portrait'
export async function renderShareCard(data, period, { style = 'aurora', orientation = 'landscape' } = {}) {
  const { W, H } = CARD_SIZES[orientation] || CARD_SIZES.landscape;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  drawCard(canvas.getContext('2d'), W, H, extractCardData(data, period), style, orientation);
  return new Promise(resolve => canvas.toBlob(b => resolve(b), 'image/png'));
}

// 预览复用：直接渲染到给定 canvas（modal 缩略预览用，跳过 toBlob）。
export function drawShareCardTo(canvas, data, period, { style = 'aurora', orientation = 'landscape' } = {}) {
  const { W, H } = CARD_SIZES[orientation] || CARD_SIZES.landscape;
  canvas.width = W; canvas.height = H;
  drawCard(canvas.getContext('2d'), W, H, extractCardData(data, period), style, orientation);
}

function drawCard(ctx, W, H, card, style, orientation) {
  ctx.textBaseline = 'alphabetic';
  const pal = palette(style);
  drawBackground(ctx, W, H, pal, style);
  drawHeadline(ctx, W, H, card, pal, orientation);
  drawStats(ctx, W, H, card, pal, orientation);
  drawBrandBand(ctx, W, H, pal, orientation);
}

function palette(style) {
  const aurora = ['#7480e8', '#5ec2dc', '#5ec2a8'];
  if (style === 'light') {
    // 浅色模式：白底深字，保留彩色 aurora 渐变作点缀，与暗色强对比。
    return { bg: '#ffffff', fg: '#1f2328', muted: '#6b7280', border: '#e5e7eb', accent: '#0969da', aurora };
  }
  // aurora 暗色发光
  return { bg: '#0b0f14', fg: '#e5e7eb', muted: '#9ca3af', border: '#1f2937', accent: '#5ec2dc', aurora };
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
  } else {
    // 浅色：右下角极淡彩色晕，避免纯白寡淡，不抢主体。
    const g = ctx.createRadialGradient(W * 0.85, H * 0.9, 20, W * 0.85, H * 0.9, 560);
    g.addColorStop(0, 'rgba(116,128,232,0.10)');
    g.addColorStop(0.5, 'rgba(94,194,220,0.05)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.strokeStyle = pal.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
}

function drawHeadline(ctx, W, H, card, pal, orientation) {
  const portrait = orientation === 'portrait';
  const padX = 64;

  // 周期小标签
  ctx.fillStyle = pal.muted;
  ctx.font = `500 ${portrait ? 30 : 22}px "Inter Tight", -apple-system, sans-serif`;
  ctx.fillText(card.periodLabel, padX, portrait ? 130 : 110);

  // 头部 label（中 / 英）
  ctx.fillStyle = pal.muted;
  ctx.font = `600 ${portrait ? 26 : 20}px "Inter Tight", sans-serif`;
  const EN_LABEL = card.headline.label === 'AI 贡献率' ? 'AI CONTRIBUTION'
    : card.headline.label === 'AI 交互次数' ? 'AI INTERACTIONS'
    : card.headline.label.toUpperCase();
  ctx.fillText(card.headline.label + ' / ' + EN_LABEL, padX, portrait ? 270 : 200);

  // 大数字（极光渐变填色）
  const baseFs = portrait ? 280 : 180;
  const maxHeadlineW = W - padX * 2;
  let fs = baseFs;
  ctx.font = `200 ${fs}px "Inter Tight", sans-serif`;
  const minFs = portrait ? 120 : 90;
  while (fs > minFs && ctx.measureText(card.headline.value).width > maxHeadlineW) {
    fs -= 20;
    ctx.font = `200 ${fs}px "Inter Tight", sans-serif`;
  }
  const grad = ctx.createLinearGradient(padX, 220, padX + 560, 400);
  grad.addColorStop(0, pal.aurora[0]);
  grad.addColorStop(0.5, pal.aurora[1]);
  grad.addColorStop(1, pal.aurora[2]);
  ctx.fillStyle = grad;
  ctx.fillText(card.headline.value, padX, portrait ? 540 : 380);

  // 竖图：大数字下方副标题，填充垂直留白
  if (portrait) {
    ctx.fillStyle = pal.muted;
    ctx.font = '500 28px "Inter Tight", sans-serif';
    ctx.fillText('由 AI 协作生成 · 你的编码画像', padX, 660);
  }
}

function drawStats(ctx, W, H, card, pal, orientation) {
  if (!card.stats.length) return;
  const portrait = orientation === 'portrait';
  const padX = 64;
  ctx.font = '500 14px "Inter Tight", sans-serif';
  if (!portrait) {
    // 横图：单行 4 列
    const y = 470, gap = 280, maxStatW = 260;
    card.stats.forEach((s, i) => {
      const x = padX + i * gap;
      ctx.fillStyle = pal.muted;
      ctx.fillText(s.label, x, y);
      ctx.fillStyle = pal.fg;
      ctx.font = '600 22px "Inter Tight", sans-serif';
      let val = s.value;
      if (ctx.measureText(val).width > maxStatW) {
        while (val.length > 1 && ctx.measureText(val + '…').width > maxStatW) val = val.slice(0, -1);
        val = val + '…';
      }
      ctx.fillText(val, x, y + 34);
      ctx.font = '500 14px "Inter Tight", sans-serif';
    });
    return;
  }
  // 竖图：小节标 + 2 列 × 2 行
  ctx.fillStyle = pal.muted;
  ctx.font = '600 22px "Inter Tight", sans-serif';
  ctx.fillText('本周数据 / WEEKLY STATS', padX, 760);

  const colGap = 560, rows = [860, 1080], maxStatW = 480;
  card.stats.forEach((s, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = padX + col * colGap, y = rows[row] || rows[1];
    ctx.fillStyle = pal.muted;
    ctx.font = '500 22px "Inter Tight", sans-serif';
    ctx.fillText(s.label, x, y);
    ctx.fillStyle = pal.fg;
    ctx.font = '600 30px "Inter Tight", sans-serif';
    let val = s.value;
    if (ctx.measureText(val).width > maxStatW) {
      while (val.length > 1 && ctx.measureText(val + '…').width > maxStatW) val = val.slice(0, -1);
      val = val + '…';
    }
    ctx.fillText(val, x, y + 42);
    ctx.font = '500 16px "Inter Tight", sans-serif';
  });
}

function drawBrandBand(ctx, W, H, pal, orientation) {
  const portrait = orientation === 'portrait';
  const padX = 64;
  const bandY = portrait ? H - 240 : H - 76;

  ctx.strokeStyle = pal.border;
  ctx.beginPath();
  ctx.moveTo(padX, bandY); ctx.lineTo(W - padX, bandY);
  ctx.stroke();

  // 极光圆点 + wordmark
  const dotX = padX, dotY = bandY + (portrait ? 44 : 38), r = 12;
  const g = ctx.createLinearGradient(dotX - r, dotY - r, dotX + r, dotY + r);
  g.addColorStop(0, pal.aurora[0]); g.addColorStop(0.5, pal.aurora[1]); g.addColorStop(1, pal.aurora[2]);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(dotX + r, dotY, r, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = pal.fg;
  ctx.font = `600 ${portrait ? 24 : 20}px "Inter Tight", sans-serif`;
  ctx.fillText('lumenCode', dotX + 38, dotY + 7);

  if (!portrait) {
    // 横图：install + github 同行
    ctx.fillStyle = pal.muted;
    ctx.font = '500 15px "JetBrains Mono", monospace';
    ctx.fillText('npm i -g lumencode', 300, dotY + 7);
    ctx.fillStyle = pal.accent;
    ctx.fillText('github.com/yaowen51888-rich/lumencode?ref=lumencode-card', 520, dotY + 7);
    return;
  }
  // 竖图：install / github 两行竖排左侧，右下角 QR
  const monoBase = bandY + 100;
  ctx.fillStyle = pal.muted;
  ctx.font = '500 22px "JetBrains Mono", monospace';
  ctx.fillText('npm i -g lumencode', padX, monoBase);
  ctx.fillStyle = pal.accent;
  ctx.font = '500 22px "JetBrains Mono", monospace';
  ctx.fillText('github.com/yaowen51888-rich/lumencode', padX, monoBase + 38);

  // 右下角 QR：白底深码固定，扫码器兼容（不随主题反色）
  const qrSize = 200, qrX = W - padX - qrSize, qrY = bandY + 30;
  ctx.fillStyle = pal.muted;
  ctx.font = '500 18px "Inter Tight", sans-serif';
  ctx.fillText('扫码查看 →', qrX, qrY - 10);
  drawQR(ctx, QR_URL, qrX, qrY, qrSize);
}

// QR 码：白底圆角块 + 深色模块。固定深码浅底保证跨主题可扫。
function drawQR(ctx, url, x, y, size) {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const n = qr.getModuleCount();
  // 白底圆角
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, x, y, size, size, 14); ctx.fill();
  // 模块（内留 quiet zone）
  const pad = size * 0.06;
  const px = (size - pad * 2) / n;
  ctx.fillStyle = '#1f2328';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(x + pad + c * px, y + pad + r * px, px, px);
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
