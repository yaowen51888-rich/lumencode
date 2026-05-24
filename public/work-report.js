import { ID, TEXT } from './config.js';
import { esc } from './utils.js';

// ── Markdown 渲染 ──
export function renderMarkdown(md) {
  const lines = md.split('\n');
  const out = [];
  let inTable = false;

  function inline(s) {
    const safe = esc(s);
    return safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('|')) {
      if (!inTable) { inTable = true; out.push('<table class="md-table">'); }
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      if (cells.every(c => /^[-:]+$/.test(c.replace(/\|/g, '')))) continue;
      const tag = inTable && out[out.length - 1] === '<table class="md-table">' ? 'th' : 'td';
      out.push('<tr>' + cells.map(c => `<${tag}>${inline(c)}</${tag}>`).join('') + '</tr>');
      continue;
    } else if (inTable) {
      inTable = false;
      out.push('</table>');
    }

    if (line.startsWith('# ')) { out.push(`<h1 class="md-h1">${inline(line.slice(2))}</h1>`); continue; }
    if (line.startsWith('## ')) { out.push(`<h2 class="md-h2">${inline(line.slice(3))}</h2>`); continue; }
    if (line.startsWith('- ') || line.startsWith('• ')) { out.push(`<li class="md-li">${inline(line.slice(2))}</li>`); continue; }
    if (/^[━─]+/.test(line.trim()) && line.trim().length >= 5) { out.push(`<div class="md-divider">${inline(line.trim())}</div>`); continue; }
    if (line.trim() === '') { out.push(''); continue; }
    out.push(`<p class="md-p">${inline(line)}</p>`);
  }

  if (inTable) out.push('</table>');
  let html = out.join('\n');
  html = html.replace(/(<li[^>]*>[<\s\S]*?<\/li>\n?)+/g, m => '<ul class="md-ul">\n' + m + '</ul>\n');
  return html;
}

// ── 工作汇报状态 ──
let currentWorkReportMarkdown = '';
let currentPlatform = 'default';
let currentLevel = 'detailed';

export function getWorkReportState() {
  return { markdown: currentWorkReportMarkdown, platform: currentPlatform, level: currentLevel };
}

export function setWorkReportState(state) {
  if (state.markdown !== undefined) currentWorkReportMarkdown = state.markdown;
  if (state.platform !== undefined) currentPlatform = state.platform;
  if (state.level !== undefined) currentLevel = state.level;
}

// ── 加载并渲染工作汇报 (legacy, kept for compatibility) ──
export async function loadWorkReport(fetchFn, tool, period, date, platform, level) {
  if (platform) currentPlatform = platform;
  if (level) currentLevel = level;

  const params = { tool, period, date, format: 'work', platform: currentPlatform, level: currentLevel };
  const qs = new URLSearchParams(params).toString();
  const res = await fetchFn(`/api/report?${qs}`);
  if (!res.ok) return;
  const markdown = await res.text();
  currentWorkReportMarkdown = markdown;
}

// ── 复制 ──
export async function copyWorkReport() {
  const text = currentWorkReportMarkdown;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

// ── 下载 Markdown ──
export function downloadMarkdown(period, date) {
  if (!currentWorkReportMarkdown) return;
  const blob = new Blob([currentWorkReportMarkdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `work-report-${period}-${date}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
