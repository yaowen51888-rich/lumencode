import { ID } from './config.js';
import { esc, fmt, destroyChart } from './utils.js';
import { renderCommitTypeChart } from './charts.js';

export function renderGitInsights(gitStats, activeTool = 'all') {
  const aiStatsEl = document.getElementById(ID.GIT_AI_STATS);
  const ai = gitStats.aiContribution;
  if (!ai || gitStats.commits <= 0) { aiStatsEl.innerHTML = ''; return; }

  const commitPct = Math.round((ai.aiCommitRatio ?? (ai.aiCommits / gitStats.commits)) * 100);
  const linePct = Math.round(((ai.aiLineRatio ?? ai.aiRatio) || 0) * 100);
  const toolNames = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
  const toolLabel = activeTool !== 'all' ? ((toolNames[activeTool] || activeTool) + ' ') : '';

  const totalLines = ai.totalLinesChanged || (ai.aiFileLinesAdded + ai.aiFileLinesDeleted + (ai.humanLinesChanged || 0)) || 1;
  const aiLinePct = Math.round((ai.aiLinesChanged / totalLines) * 100) || linePct;

  const toolTheme = activeTool !== 'all' ? `theme-${activeTool}` : 'theme-all';

  let summaryDesc = '';
  if (activeTool !== 'all') {
    summaryDesc = `${toolLabel}代码变更有 AI 参与`;
  } else if (gitStats.attributionSummary) {
    const s = gitStats.attributionSummary;
    const upperPct = Math.round(((s.confirmedAILines + s.probableAILines + s.possibleAILines) / (s.totalLinesChanged || 1)) * 100);
    summaryDesc = `代码变更有 AI 参与（可能上限 <strong>${upperPct}%</strong>）`;
  } else {
    summaryDesc = '代码变更有 AI 参与';
  }

  const summaryHtml = `
    <div class="ai-summary-card ${toolTheme}">
      <div class="ai-summary-left">
        <span class="ai-summary-pct">${aiLinePct}%</span>
        <span class="ai-summary-desc">${summaryDesc}</span>
      </div>
      <div class="ai-summary-right">
        <span class="ai-summary-commits">${ai.aiCommits}/${gitStats.commits} 提交使用 AI (${commitPct}%)</span>
        <div class="ai-summary-bar"><div class="ai-summary-bar-fill" style="width:${commitPct}%"></div></div>
      </div>
    </div>
  `;

  const tip = (text) => `<span class="metric-tip" data-tip="${text}">?</span>`;
  const kv = (value, label, tipText) =>
    `<div class="ai-kv-row"><span class="ai-kv-val">${value}</span><span class="ai-kv-lbl">${label}${tipText ? tip(tipText) : ''}</span></div>`;

  let metrics = [];

  if (activeTool !== 'all') {
    const total = ai.totalLinesChanged || 1;
    const confirmedPct = Math.round((ai.aiLinesChanged / total) * 100);
    const humanPct = 100 - confirmedPct;
    metrics.push(kv(`${confirmedPct}%`, `${toolLabel}确认 AI`, '该工具关联的 AI 提交代码行占总变更行比例'));
    metrics.push(kv(`${humanPct}%`, `${toolLabel}未归因`, '未关联到该工具 AI session 的代码行'));
  } else if (gitStats.attributionSummary) {
    const s = gitStats.attributionSummary;
    const total = s.totalLinesChanged || 1;
    const confirmedPct = Math.round((s.confirmedAILines / total) * 100);
    const upperPct = Math.round(((s.confirmedAILines + s.probableAILines + s.possibleAILines) / total) * 100);
    const unknownPct = Math.round((s.unknownLines / total) * 100);
    metrics.push(kv(`${confirmedPct}%`, '确认 AI 改动', '有明确 AI 签名或高置信 session 关联+文件交集的代码行占比'));
    metrics.push(kv(`${upperPct}%`, '可能 AI 上限', '确认+弱信号匹配的最大覆盖面，实际 AI 参与度在此区间内'));
    metrics.push(kv(`${unknownPct}%`, '未归因改动', '未能关联到任何 AI session 的代码行'));
  }

  metrics.push(kv(`${linePct}%`, `${toolLabel}AI 代码改写`, 'AI 命中文件的新增+删除行占总变更行比例'));
  metrics.push(kv(`${ai.aiCommits}/${gitStats.commits}`, `${toolLabel}AI 提交 (${commitPct}%)`, '高/中置信度 AI 提交占总提交比'));
  metrics.push(kv(`${ai.highConfidenceCommits}/${ai.mediumConfidenceCommits}`, `${toolLabel}高/中置信`, '高=签名或Bash关联+交集；中=时间窗关联+交集'));
  metrics.push(kv(`+${fmt(ai.aiFileLinesAdded)}`, `${toolLabel}AI 新增行`, 'AI 提交中与 session 文件有交集的新增行'));
  metrics.push(kv(`-${fmt(ai.aiFileLinesDeleted)}`, `${toolLabel}AI 删除行`, 'AI 提交中与 session 文件有交集的删除行'));

  if (activeTool !== 'all' && gitStats.aiContributionByTool) {
    const globalAi = gitStats.aiContributionByTool;
    const allAiCommits = (globalAi.claude?.aiCommits || 0) + (globalAi.codex?.aiCommits || 0) + (globalAi.opencode?.aiCommits || 0) + (globalAi['generic-ai']?.aiCommits || 0);
    const globalPct = gitStats.commits > 0 ? Math.round((allAiCommits / gitStats.commits) * 100) : 0;
    metrics.push(kv(`${globalPct}%`, '全局 AI 提交率', '所有工具的 AI 归因提交数占总提交数比例'));
  }

  aiStatsEl.innerHTML = `${summaryHtml}<div class="ai-metrics-list">${metrics.join('')}</div>`;

  // 提交类型分布 + 文件热点
  const row = document.getElementById(ID.GIT_INSIGHTS_ROW);
  const typeEntries = gitStats.commitTypes
    ? Object.entries(gitStats.commitTypes).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    : [];
  const hotspots = gitStats.fileHotspots || [];

  if (typeEntries.length === 0 && hotspots.length === 0) {
    row.style.display = 'none';
    destroyChart('commitTypeChart');
    return;
  }
  row.style.display = '';

  if (typeEntries.length > 0) {
    renderCommitTypeChart(typeEntries);
  } else {
    destroyChart('commitTypeChart');
  }

  const hostEl = document.getElementById(ID.FILE_HOTSPOTS_TABLE);
  if (hotspots.length === 0) {
    hostEl.innerHTML = '<div class="hotspots-empty">无文件变更数据</div>';
  } else {
    const maxTouch = Math.max(...hotspots.map(h => h.touches));
    const truncate = (p) => p.length > 40 ? '...' + p.slice(-37) : p;
    hostEl.innerHTML = `
      <table class="hotspots-tbl">
        <thead><tr><th>文件</th><th class="num">触碰</th><th class="num">+行</th><th class="num">-行</th><th>热度</th></tr></thead>
        <tbody>${hotspots.map(h => {
          const pct = Math.max(8, Math.round((h.touches / maxTouch) * 100));
          return `<tr>
            <td class="hotspot-path" title="${esc(h.path)}">${esc(truncate(h.path))}</td>
            <td class="num">${h.touches}</td>
            <td class="num pos">+${fmt(h.added)}</td>
            <td class="num neg">-${fmt(h.deleted)}</td>
            <td><div class="hotspot-bar"><div class="hotspot-bar-fill" style="width:${pct}%"></div></div></td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
  }
}
