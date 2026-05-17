// DESIGN.md monochrome 灰阶（按视觉权重从重到轻）— 用于 doughnut/bar 等需要区分类目的场景
const COLORS = [
  '#111111', // ink
  '#374151', // body
  '#4b5563',
  '#6b7280', // muted
  '#898989', // muted-soft
  '#9ca3af',
  '#cbd5e1',
  '#e5e7eb', // surface-strong
];

let currentPeriod = 'daily';
let currentDate = new Date().toISOString().slice(0, 10);
let lastReportData = null;

const charts = {};

// ── URL Hash State ──
function loadStateFromHash() {
  const hash = location.hash.slice(1);
  if (!hash) return;
  const [p, d] = hash.split('/');
  if (p && ['daily', 'weekly', 'monthly'].includes(p)) {
    currentPeriod = p;
    document.querySelectorAll('.category-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.period === p);
    });
  }
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    currentDate = d;
    document.getElementById('dateInput').value = d;
  }
}

function saveStateToHash() {
  location.hash = `${currentPeriod}/${currentDate}`;
}

loadStateFromHash();

async function loadData() {
  showSkeleton();
  hideError();

  try {
    const res = await fetch(`/api/report?period=${currentPeriod}&date=${currentDate}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showError(err.hint || ('数据加载失败: ' + res.status));
      return;
    }
    const data = await res.json();
    if (!data || data.error) {
      if (data?.hint) showError(data.hint);
      showEmpty();
      return;
    }
    hideEmpty();
    render(data);
  } catch (err) {
    showError('网络错误: ' + err.message);
  } finally {
    hideSkeleton();
  }
}

function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + ' M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + ' K';
  return n.toLocaleString('zh-CN');
}

function renderTrendArrow(elId, current, previous) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (previous == null || previous === undefined || previous === 0 || current == null || current === undefined) { el.textContent = ''; el.className = 'card-trend'; return; }
  const pct = ((current - previous) / previous * 100).toFixed(0);
  const val = Math.abs(Number(pct));
  if (pct > 0) { el.textContent = `↑${val}%`; el.className = 'card-trend up'; }
  else if (pct < 0) { el.textContent = `↓${val}%`; el.className = 'card-trend down'; }
  else { el.textContent = '—'; el.className = 'card-trend flat'; }
}

function render(data) {
  lastReportData = data;
  const { usageStats, gitStats, start, end } = data;

  // Title & date
  const periodName = currentPeriod === 'daily' ? '日报' : currentPeriod === 'weekly' ? '周报' : '月报';
  document.getElementById('reportTitle').textContent = `Claude Code 使用${periodName}`;
  document.getElementById('reportDate').textContent =
    currentPeriod === 'daily' ? start :
    currentPeriod === 'weekly' ? `${start} ~ ${end}` :
    start.slice(0, 7);

  // Stats cards
  document.getElementById('statSessions').textContent = fmt(usageStats.sessionCount);
  document.getElementById('statRequests').textContent = fmt(usageStats.requestCount);
  document.getElementById('statProjects').textContent = Object.keys(usageStats.projects).length;
  document.getElementById('statTokens').textContent = fmt(usageStats.totalTokens);

  // Token breakdown
  const tokenBreakdown = document.getElementById('statTokenBreakdown');
  if (tokenBreakdown) {
    tokenBreakdown.innerHTML = `<span>输入 ${fmt(usageStats.inputTokens)}</span><span>输出 ${fmt(usageStats.outputTokens)}</span>` +
      (usageStats.cacheRead > 0 ? `<span>缓存 ${fmt(usageStats.cacheRead)}</span>` : '');
  }

  // Cost card
  const costEl = document.getElementById('statCost');
  if (costEl) {
    costEl.textContent = usageStats.estimatedCost
      ? `~$${usageStats.estimatedCost.toFixed(2)}`
      : '-';
  }

  // Cost model breakdown
  const costModelEl = document.getElementById('statCostModel');
  if (costModelEl && usageStats.models) {
    const modelEntries = Object.entries(usageStats.models).sort((a, b) => b[1].count - a[1].count);
    costModelEl.textContent = modelEntries.length > 0 ? modelEntries.slice(0, 2).map(([m]) => m.replace('claude-', '')).join(' · ') : '';
  }

  // Trend arrows (compare with previous period)
  renderTrendArrow('trendSessions', usageStats.sessionCount, data.prevStats?.sessionCount);
  renderTrendArrow('trendRequests', usageStats.requestCount, data.prevStats?.requestCount);
  renderTrendArrow('trendProjects', Object.keys(usageStats.projects).length, data.prevStats && data.prevStats.projects ? Object.keys(data.prevStats.projects).length : null);
  renderTrendArrow('trendTokens', usageStats.totalTokens, data.prevStats?.totalTokens);
  renderTrendArrow('trendCost', usageStats.estimatedCost, data.prevStats?.estimatedCost);

  // Trend chart
  const trendSection = document.getElementById('trendSection');
  if (data.trendData && Object.keys(data.trendData.dailyStats).length > 0) {
    trendSection.style.display = 'block';
    renderTrend(data.trendData);
  } else {
    trendSection.style.display = 'none';
  }

  // Scenarios
  renderDoughnut('scenarioChart', usageStats.scenarios, '场景分布');

  // Models (with drill-down)
  const modelEntries = Object.entries(usageStats.models).sort((a, b) => b[1].count - a[1].count);
  destroyChart('modelChart');
  const modelCtx = document.getElementById('modelChart').getContext('2d');
  charts['modelChart'] = new Chart(modelCtx, {
    type: 'bar',
    data: { labels: modelEntries.map(([k]) => k), datasets: [{ label: '请求次数', data: modelEntries.map(([, v]) => v.count), backgroundColor: '#374151', borderRadius: 6, maxBarThickness: 20, barPercentage: 0.7 }] },
    options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y', scales: { x: { grid: { color: '#f3f4f6' }, ticks: { font: { family: 'Inter', size: 11 } } }, y: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 12 } } } }, plugins: { legend: { display: false } },
      onClick: (evt, elements) => {
        if (elements.length === 0) return;
        const model = modelEntries[elements[0].index][0];
        showDrill(model, '<div class="drill-empty">加载中...</div>');
        fetch(`/api/details?period=${currentPeriod}&date=${currentDate}&dimension=model&key=${encodeURIComponent(model)}`).then(r => r.json()).then(rows => {
          if (!rows.length) { showDrill(model, '<div class="drill-empty">无数据</div>'); return; }
          showDrill(model + ' 按日分布', '<table class="drill-table"><tr><th>日期</th><th>请求数</th><th>输入Token</th><th>输出Token</th></tr>' + rows.map(r => `<tr><td>${r.date}</td><td>${r.requests}</td><td>${fmtShort(r.inputTokens)}</td><td>${fmtShort(r.outputTokens)}</td></tr>`).join('') + '</table>');
        });
      }
    }
  });

  // Projects (with drill-down)
  const projEntries = Object.entries(usageStats.projects)
    .filter(([, d]) => d.requests > 0)
    .sort((a, b) => b[1].requests - a[1].requests)
    .slice(0, 8);
  destroyChart('projectChart');
  const projCtx = document.getElementById('projectChart').getContext('2d');
  charts['projectChart'] = new Chart(projCtx, {
    type: 'bar',
    data: { labels: projEntries.map(([k]) => k.length > 20 ? '...' + k.slice(-17) : k), datasets: [{ label: '请求数', data: projEntries.map(([, v]) => v.requests), backgroundColor: '#374151', borderRadius: 6, maxBarThickness: 20, barPercentage: 0.7 }] },
    options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y', scales: { x: { grid: { color: '#f3f4f6' }, ticks: { font: { family: 'Inter', size: 11 } } }, y: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 12 } } } }, plugins: { legend: { display: false } },
      onClick: (evt, elements) => {
        if (elements.length === 0) return;
        const project = projEntries[elements[0].index][0];
        showDrill(project, '<div class="drill-empty">加载中...</div>');
        fetch(`/api/sessions?project=${encodeURIComponent(project)}&period=${currentPeriod}&date=${currentDate}`).then(r => r.json()).then(rows => {
          if (!rows.length) { showDrill(project, '<div class="drill-empty">无数据</div>'); return; }
          const html = '<table class="drill-table">'
            + '<tr><th></th><th>会话ID</th><th>开始时间</th><th>请求数</th><th>提交数</th></tr>'
            + rows.map((r, i) => {
                const start = r.startTime ? r.startTime.slice(0, 16).replace('T', ' ') : '-';
                const cn = r.commits?.length || 0;
                const toggle = cn > 0 ? `<button class="commit-toggle" data-idx="${i}">▸</button>` : '';
                const commitRows = cn > 0
                  ? `<tr class="commit-subrow" data-idx="${i}" style="display:none;"><td colspan="5"><table class="commit-subtable">
                       <tr><th>hash</th><th>type</th><th>subject</th><th class="num">+行</th><th class="num">-行</th><th>AI</th></tr>
                       ${r.commits.map(c => `<tr>
                         <td class="hash"><code>${c.hash.slice(0,7)}</code></td>
                         <td><span class="commit-type-tag type-${c.type}">${c.type}</span></td>
                         <td class="commit-subject" title="${(c.subject || '').replace(/"/g, '&quot;')}">${c.subject || ''}</td>
                         <td class="num pos">+${fmt(c.linesAdded || 0)}</td>
                         <td class="num neg">-${fmt(c.linesDeleted || 0)}</td>
                         <td>${c.isAI ? '🤖' : ''}</td>
                       </tr>`).join('')}
                     </table></td></tr>`
                  : '';
                return `<tr><td>${toggle}</td><td class="drill-text" title="${r.id}">${r.id}</td><td>${start}</td><td>${r.requests || '-'}</td><td>${cn || '-'}</td></tr>${commitRows}`;
              }).join('')
            + '</table>';
          showDrill(project + ' 会话记录', html);
          // 绑定展开/折叠
          document.querySelectorAll('.commit-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
              const idx = btn.dataset.idx;
              const sub = document.querySelector(`.commit-subrow[data-idx="${idx}"]`);
              const open = sub.style.display !== 'none';
              sub.style.display = open ? 'none' : '';
              btn.textContent = open ? '▸' : '▾';
            });
          });
        });
      }
    }
  });

  // Tools
  const toolEntries = Object.entries(usageStats.tools).sort((a, b) => b[1] - a[1]).slice(0, 10);
  renderBar('toolChart', toolEntries.map(([k]) => k), toolEntries.map(([, v]) => v), '调用次数');

  // Git
  const gitSection = document.getElementById('gitSection');
  const gitInsightsRow = document.getElementById('gitInsightsRow');
  const hasGit = gitStats && (gitStats.commits > 0 || gitStats.filesChanged > 0);
  if (hasGit) {
    gitSection.style.display = 'block';
    gitSection.dataset.hasGit = 'true';
    document.getElementById('gitStats').innerHTML = `
      <div class="git-stat-item"><div class="git-stat-value">${fmt(gitStats.commits)}</div><div class="git-stat-label">提交次数</div></div>
      <div class="git-stat-item"><div class="git-stat-value">+${fmt(gitStats.linesAdded)}</div><div class="git-stat-label">新增行数</div></div>
      <div class="git-stat-item"><div class="git-stat-value">-${fmt(gitStats.linesDeleted)}</div><div class="git-stat-label">删除行数</div></div>
      <div class="git-stat-item"><div class="git-stat-value">${fmt(gitStats.filesChanged)}</div><div class="git-stat-label">变更文件</div></div>
    `;
    renderGitInsights(gitStats);
  } else {
    gitSection.style.display = 'block';
    gitSection.dataset.hasGit = 'false';
    document.getElementById('gitStats').innerHTML = `
      <div style="text-align:center;padding:16px 0;grid-column:1/-1;">
        <p style="color:var(--muted);margin-bottom:12px;">配置本地项目路径后，可在此查看 Git 代码产出</p>
        <button class="btn-outline" onclick="document.getElementById('settingsBtn').click()">配置项目路径</button>
      </div>
    `;
    document.getElementById('gitAiStats').innerHTML = '';
    if (gitInsightsRow) gitInsightsRow.style.display = 'none';
    destroyChart('commitTypeChart');
  }
}

function renderGitInsights(gitStats) {
  // AI 贡献度卡片
  const aiStatsEl = document.getElementById('gitAiStats');
  const ai = gitStats.aiContribution;
  if (ai && gitStats.commits > 0) {
    const pct = Math.round((ai.aiCommits / gitStats.commits) * 100);
    aiStatsEl.innerHTML = `
      <div class="git-stat-item git-ai-card"><div class="git-stat-value">${pct}%</div><div class="git-stat-label">AI 辅助提交（${ai.aiCommits}/${gitStats.commits}）</div></div>
      <div class="git-stat-item git-ai-card"><div class="git-stat-value">+${fmt(ai.aiLinesAdded)}</div><div class="git-stat-label">AI 新增行</div></div>
      <div class="git-stat-item git-ai-card"><div class="git-stat-value">-${fmt(ai.aiLinesDeleted)}</div><div class="git-stat-label">AI 删除行</div></div>
    `;
  } else {
    aiStatsEl.innerHTML = '';
  }

  // 提交类型分布 + 文件热点
  const row = document.getElementById('gitInsightsRow');
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

  // 文件热点表
  const hostEl = document.getElementById('fileHotspotsTable');
  if (hotspots.length === 0) {
    hostEl.innerHTML = '<div class="hotspots-empty">无文件变更数据</div>';
  } else {
    const maxTouch = Math.max(...hotspots.map(h => h.touches));
    const truncate = (p) => p.length > 40 ? '...' + p.slice(-37) : p;
    hostEl.innerHTML = `
      <table class="hotspots-tbl">
        <thead><tr><th>文件</th><th class="num">触碰</th><th class="num">+行</th><th class="num">-行</th><th>热度</th></tr></thead>
        <tbody>
          ${hotspots.map(h => {
            const pct = Math.max(8, Math.round((h.touches / maxTouch) * 100));
            return `<tr>
              <td class="hotspot-path" title="${h.path}">${truncate(h.path)}</td>
              <td class="num">${h.touches}</td>
              <td class="num pos">+${fmt(h.added)}</td>
              <td class="num neg">-${fmt(h.deleted)}</td>
              <td><div class="hotspot-bar"><div class="hotspot-bar-fill" style="width:${pct}%"></div></div></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
  }
}

function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}

const SCENARIO_COLORS = {
  '编码': '#8ab8a0',
  '测试/QA': '#c8b880',
  '调试/排错': '#c49090',
  '文档': '#90a8c8',
  '阅读/研究': '#a090c0',
  '规划/设计': '#c8a080',
  '代码审查': '#80b8b8',
  '其他': '#a8a8a8',
};

function renderDoughnut(canvasId, dataMap, label) {
  destroyChart(canvasId);
  const entries = Object.entries(dataMap).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  // legend 放底部需要更高容器
  const wrap = document.getElementById(canvasId).parentElement;
  wrap.style.height = '260px';
  const ctx = document.getElementById(canvasId).getContext('2d');
  const colors = entries.map(([k]) => SCENARIO_COLORS[k] || COLORS[entries.length % COLORS.length]);
  charts[canvasId] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: entries.map(([k]) => k),
      datasets: [{
        data: entries.map(([, v]) => v),
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
        legend: { position: 'bottom', labels: { font: { family: 'Inter', size: 11 }, padding: 12, boxWidth: 10, usePointStyle: true, pointStyle: 'circle' } },
        tooltip: {
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
        const clickEntries = Object.entries(dataMap).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
        const label = clickEntries[elements[0].index]?.[0];
        const scenarioKeyMap = { '编码': 'coding', '测试/QA': 'testing', '调试/排错': 'debugging', '文档': 'documentation', '阅读/研究': 'reading', '规划/设计': 'planning', '代码审查': 'review' };
        const key = scenarioKeyMap[label];
        if (!key) return;
        showDrill(label + ' 匹配示例', '<div class="drill-empty">加载中...</div>');
        fetch(`/api/details?period=${currentPeriod}&date=${currentDate}&dimension=scenario&key=${encodeURIComponent(key)}`).then(r => r.json()).then(rows => {
          if (!rows.length) { showDrill(label, '<div class="drill-empty">无匹配记录</div>'); return; }
          showDrill(label + ' 匹配示例', '<table class="drill-table"><tr><th>用户消息</th><th>时间</th></tr>' + rows.map(r => `<tr><td class="drill-text" title="${r.text.replace(/"/g, '&quot;')}">${r.text}</td><td>${r.timestamp.slice(0, 16).replace('T', ' ')}</td></tr>`).join('') + '</table>');
        });
      },
    },
  });
}

function renderBar(canvasId, labels, data, datasetLabel) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId).getContext('2d');
  charts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: datasetLabel,
        data,
        backgroundColor: '#374151',
        borderRadius: 6,
        maxBarThickness: 20,
        barPercentage: 0.7,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      scales: {
        x: { grid: { color: '#f3f4f6' }, ticks: { font: { family: 'Inter', size: 11 } } },
        y: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 12 } } },
      },
      plugins: {
        legend: { display: false },
      },
    },
  });
}

// Muted tone 高级色板：统一明度 ~66%、统一饱和度 ~22%，
// 有 hue 倾向但不跳，整体收敛在灰调 family 内
const COMMIT_TYPE_COLORS = {
  feat:     '#8ab8a0',
  fix:      '#c49090',
  refactor: '#a090c0',
  docs:     '#90a8c8',
  test:     '#c8b880',
  chore:    '#a8a8a8',
  perf:     '#c890b0',
  style:    '#80b8b8',
  ci:       '#c8a080',
  build:    '#a8c880',
  revert:   '#c49090',
  other:    '#b8b8b8',
};

function renderCommitTypeChart(typeEntries) {
  destroyChart('commitTypeChart');
  const canvas = document.getElementById('commitTypeChart');
  const wrap = canvas.parentElement;
  wrap.style.height = Math.max(180, typeEntries.length * 32 + 40) + 'px';

  const labels = typeEntries.map(([k]) => k);
  const data = typeEntries.map(([, v]) => v);
  const colors = labels.map(k => COMMIT_TYPE_COLORS[k] || COMMIT_TYPE_COLORS.other);

  const ctx = canvas.getContext('2d');
  charts['commitTypeChart'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: '提交数',
        data,
        backgroundColor: colors,
        borderRadius: 6,
        maxBarThickness: 20,
        barPercentage: 0.65,
        categoryPercentage: 0.85,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      scales: {
        x: { grid: { color: '#f3f4f6' }, ticks: { font: { family: 'Inter', size: 11 }, precision: 0 } },
        y: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 12 } } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

function resetToReportView() {
  workReportSection.style.display = 'none';
  statsGrid.style.display = 'grid';
  chartsSection.style.display = 'block';
  gitSection.style.display = gitSection.dataset.hasGit === 'true' ? 'block' : 'none';
  workReportBtn.style.display = 'inline-block';
}

// Event handlers
document.querySelectorAll('.category-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.category-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentPeriod = btn.dataset.period;
    resetToReportView();
    loadData();
    saveStateToHash();
  });
});

document.getElementById('dateInput').value = currentDate;
document.getElementById('dateInput').addEventListener('change', (e) => {
  currentDate = e.target.value;
  resetToReportView();
  loadData();
  saveStateToHash();
});

// ── Trend chart ──

function renderTrend(trendData) {
  const dates = Object.keys(trendData.dailyStats).sort();
  const requests = dates.map(d => trendData.dailyStats[d].requests);
  const tokens = dates.map(d => ((trendData.dailyStats[d].inputTokens || 0) + (trendData.dailyStats[d].outputTokens || 0)) / 1000);
  const labels = dates.map(d => d.slice(5));

  destroyChart('trendChart');
  const ctx = document.getElementById('trendChart');
  if (!ctx) return;
  charts['trendChart'] = new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '请求数',
          data: requests,
          borderColor: '#111111',
          backgroundColor: 'rgba(17,17,17,0.08)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          yAxisID: 'y',
        },
        {
          label: 'Token (K)',
          data: tokens,
          borderColor: '#8b5cf6',
          backgroundColor: 'rgba(139,92,246,0.08)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          yAxisID: 'y1',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { position: 'left', grid: { color: '#f3f4f6' }, ticks: { font: { family: 'Inter', size: 11 } }, title: { display: true, text: '请求数', font: { family: 'Inter', size: 12 } } },
        y1: { position: 'right', grid: { display: false }, ticks: { font: { family: 'Inter', size: 11 } }, title: { display: true, text: 'Token (K)', font: { family: 'Inter', size: 12 } } },
        x: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 11 } } },
      },
      plugins: {
        legend: { position: 'top', labels: { font: { family: 'Inter', size: 12 }, padding: 16 } },
      },
    },
  });
}

// ── UX states ──

function showSkeleton() {
  document.querySelectorAll('.card-value').forEach(el => {
    if (!el.classList.contains('skeleton')) {
      el._origText = el.textContent;
      el.textContent = '';
      el.classList.add('skeleton');
    }
  });
  document.querySelectorAll('.chart-wrap').forEach(el => {
    if (!el.querySelector('.chart-skeleton')) {
      const overlay = document.createElement('div');
      overlay.className = 'chart-skeleton';
      overlay.innerHTML = '<div class="chart-skeleton-bar"></div><div class="chart-skeleton-bar"></div><div class="chart-skeleton-bar"></div><div class="chart-skeleton-bar"></div><div class="chart-skeleton-bar"></div>';
      el.appendChild(overlay);
    }
  });
}

function hideSkeleton() {
  document.querySelectorAll('.card-value.skeleton').forEach(el => {
    el.classList.remove('skeleton');
  });
  document.querySelectorAll('.chart-skeleton').forEach(el => el.remove());
}

function showError(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.style.display = 'block';
  toast.style.opacity = '1';
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => { toast.style.display = 'none'; }, 300);
  }, 3000);
}

function hideError() {
  const toast = document.getElementById('toast');
  if (toast) toast.style.display = 'none';
}

function showEmpty() {
  document.querySelectorAll('.card-value').forEach(el => el.textContent = '-');
  document.getElementById('statsGrid').style.display = 'none';
  document.getElementById('analyticsSection').style.display = 'none';
  document.getElementById('trendSection').style.display = 'none';
  document.getElementById('gitSection').style.display = 'none';
  const wp = document.getElementById('welcomePage');
  if (wp) wp.style.display = 'flex';
  // 未配置时隐藏顶部操作按钮
  ['exportCsvBtn', 'printBtn', 'workReportBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

function hideEmpty() {
  const wp = document.getElementById('welcomePage');
  if (wp) wp.style.display = 'none';
  document.getElementById('statsGrid').style.display = 'grid';
  document.getElementById('analyticsSection').style.display = 'block';
  document.getElementById('trendSection').style.display = 'block';
  // 恢复顶部操作按钮
  ['exportCsvBtn', 'printBtn', 'workReportBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
  });
}

// ── Welcome page config ──
document.getElementById('welcomeStartBtn')?.addEventListener('click', async () => {
  const claudeDir = document.getElementById('welcomeClaudeDir').value.trim();
  const reposRaw = document.getElementById('welcomeRepos').value.trim();
  const hint = document.getElementById('welcomeHint');

  if (!claudeDir) {
    hint.textContent = '请输入 Claude 日志目录路径';
    hint.style.color = '#dc2626';
    return;
  }

  const repos = reposRaw ? reposRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

  try {
    hint.textContent = '保存配置中...';
    hint.style.color = 'var(--muted)';
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudeDir, repos }),
    });
    if (!res.ok) throw new Error('保存失败');
    hint.textContent = '配置已保存，加载数据中...';
    hideEmpty();
    await loadData();
  } catch (err) {
    hint.textContent = '保存失败: ' + err.message;
    hint.style.color = '#dc2626';
  }
});

// ── Config: localStorage + server sync ──

function loadLocalConfig() {
  try { return JSON.parse(localStorage.getItem('ccusage-config') || '{}'); } catch { return {}; }
}

function saveLocalConfig(cfg) {
  localStorage.setItem('ccusage-config', JSON.stringify(cfg));
}

async function syncConfigToServer() {
  const cfg = loadLocalConfig();
  if (Object.keys(cfg).length > 0) {
    try {
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
    } catch {}
  }
}

// Page load: sync local config to server, then load data
syncConfigToServer().then(() => loadData());

// Settings modal
const settingsModal = document.getElementById('settingsModal');
const settingsBtn = document.getElementById('settingsBtn');
const closeSettings = document.getElementById('closeSettings');
const saveSettings = document.getElementById('saveSettings');
const backdrop = settingsModal.querySelector('.modal-backdrop');

settingsBtn.addEventListener('click', async () => {
  // Read from localStorage first, fallback to server
  const cfg = loadLocalConfig();
  if (Object.keys(cfg).length === 0) {
    const res = await fetch('/api/config');
    if (res.ok) Object.assign(cfg, await res.json());
  }
  document.getElementById('cfgClaudeDir').value = cfg.claudeDir || '';
  document.getElementById('cfgRepos').value = (cfg.repos || []).join('\n');
  document.getElementById('cfgExclude').value = (cfg.excludeProjects || []).join('\n');
  document.getElementById('cfgKeywords').value = JSON.stringify(cfg.scenarioKeywords || {}, null, 2);
  settingsModal.style.display = 'flex';
});

function hideSettings() {
  settingsModal.style.display = 'none';
}

closeSettings.addEventListener('click', hideSettings);
backdrop.addEventListener('click', hideSettings);

saveSettings.addEventListener('click', async () => {
  let scenarioKeywords;
  try {
    scenarioKeywords = JSON.parse(document.getElementById('cfgKeywords').value);
  } catch {
    alert('场景关键词 JSON 格式错误，请检查');
    return;
  }
  const payload = {
    claudeDir: document.getElementById('cfgClaudeDir').value.trim(),
    repos: document.getElementById('cfgRepos').value.split('\n').map(s => s.trim()).filter(Boolean),
    excludeProjects: document.getElementById('cfgExclude').value.split('\n').map(s => s.trim()).filter(Boolean),
    scenarioKeywords,
  };
  // Save to localStorage
  saveLocalConfig(payload);
  // Sync to server
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.ok) {
    hideSettings();
    loadData();
  } else {
    const err = await res.json().catch(() => ({}));
    alert('保存失败: ' + (err.error || '未知错误'));
  }
});

function renderMarkdown(md) {
  const lines = md.split('\n');
  const out = [];
  let inTable = false;

  function inline(s) {
    return s
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Table
    if (line.startsWith('|')) {
      if (!inTable) {
        inTable = true;
        out.push('<table class="md-table">');
      }
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      if (cells.every(c => /^[-:]+$/.test(c.replace(/\|/g, '')))) {
        // separator row, skip
        continue;
      }
      const tag = inTable && out[out.length - 1] === '<table class="md-table">' ? 'th' : 'td';
      out.push('<tr>' + cells.map(c => `<${tag}>${inline(c)}</${tag}>`).join('') + '</tr>');
      continue;
    } else if (inTable) {
      inTable = false;
      out.push('</table>');
    }

    // Heading
    if (line.startsWith('# ')) {
      out.push(`<h1 class="md-h1">${inline(line.slice(2))}</h1>`);
      continue;
    }
    if (line.startsWith('## ')) {
      out.push(`<h2 class="md-h2">${inline(line.slice(3))}</h2>`);
      continue;
    }

    // List
    if (line.startsWith('- ')) {
      out.push(`<li class="md-li">${inline(line.slice(2))}</li>`);
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      out.push('');
      continue;
    }

    // Paragraph
    out.push(`<p class="md-p">${inline(line)}</p>`);
  }

  if (inTable) out.push('</table>');

  // Wrap consecutive li in ul
  let html = out.join('\n');
  html = html.replace(/(<li[^>]*>[<\s\S]*?<\/li>\n?)+/g, m => '<ul class="md-ul">\n' + m + '</ul>\n');

  return html;
}

// Work report
const workReportBtn = document.getElementById('workReportBtn');
const backToReport = document.getElementById('backToReport');
const copyWorkReport = document.getElementById('copyWorkReport');
const workReportSection = document.getElementById('workReportSection');
const workReportContent = document.getElementById('workReportContent');
const statsGrid = document.getElementById('statsGrid');
const chartsSection = document.getElementById('analyticsSection');
const gitSection = document.getElementById('gitSection');

let currentWorkReportMarkdown = '';
let currentPlatform = 'default';

workReportBtn.addEventListener('click', async () => {
  await loadWorkReport('default');
});

async function loadWorkReport(platform) {
  currentPlatform = platform || 'default';
  const res = await fetch(`/api/report?period=${currentPeriod}&date=${currentDate}&format=work&platform=${currentPlatform}`);
  if (!res.ok) return;
  const markdown = await res.text();
  currentWorkReportMarkdown = markdown;
  workReportContent.innerHTML = renderMarkdown(markdown);
  statsGrid.style.display = 'none';
  chartsSection.style.display = 'none';
  gitSection.style.display = 'none';
  workReportSection.style.display = 'block';
  workReportBtn.style.display = 'none';
}

// Platform tabs
document.querySelectorAll('.platform-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.platform-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadWorkReport(btn.dataset.platform);
  });
});

backToReport.addEventListener('click', () => {
  workReportSection.style.display = 'none';
  statsGrid.style.display = 'grid';
  chartsSection.style.display = 'block';
  gitSection.style.display = gitSection.dataset.hasGit === 'true' ? 'block' : 'none';
  workReportBtn.style.display = 'inline-block';
});

copyWorkReport.addEventListener('click', async () => {
  const text = currentWorkReportMarkdown;
  try {
    await navigator.clipboard.writeText(text);
    copyWorkReport.textContent = '已复制';
    setTimeout(() => copyWorkReport.textContent = '复制', 1500);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    copyWorkReport.textContent = '已复制';
    setTimeout(() => copyWorkReport.textContent = '复制', 1500);
  }
});

// ── Drill-down ──

const drillModal = document.getElementById('drillModal');
const drillTitle = document.getElementById('drillTitle');
const drillBody = document.getElementById('drillBody');

document.getElementById('closeDrill').addEventListener('click', () => { drillModal.style.display = 'none'; });
drillModal.querySelector('.modal-backdrop').addEventListener('click', () => { drillModal.style.display = 'none'; });

function showDrill(title, html) {
  drillTitle.textContent = title;
  drillBody.innerHTML = html;
  drillModal.style.display = 'flex';
}

function fmtShort(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

// ── CSV Export (comprehensive) ──
document.getElementById('exportCsvBtn').addEventListener('click', () => {
  if (!lastReportData) return;
  const { usageStats, gitStats, start, end } = lastReportData;
  const lines = [];

  // Section 1: Summary
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
      lines.push(`AI辅助提交,${ai.aiCommits}/${gitStats.commits} (${pct}%)`);
      lines.push(`AI新增行,+${ai.aiLinesAdded}`);
      lines.push(`AI删除行,-${ai.aiLinesDeleted}`);
    }
    if (gitStats.commitTypes) {
      for (const [t, n] of Object.entries(gitStats.commitTypes).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])) {
        lines.push(`commit类型-${t},${n}`);
      }
    }
  }
  lines.push('');

  // Section 2: Daily breakdown
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

  // Section 3: Project breakdown
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

  // Section 4: Model breakdown
  const modelEntries = Object.entries(usageStats.models).sort((a, b) => b[1].count - a[1].count);
  if (modelEntries.length > 0) {
    lines.push('# 模型分布');
    lines.push('模型,请求数,输入Token,输出Token,缓存读取');
    for (const [name, d] of modelEntries) {
      lines.push(`"${name}",${d.count},${d.inputTokens},${d.outputTokens},${d.cacheRead || 0}`);
    }
    lines.push('');
  }

  // Section 5: Tool usage
  const toolEntries = Object.entries(usageStats.tools).sort((a, b) => b[1] - a[1]);
  if (toolEntries.length > 0) {
    lines.push('# 工具使用');
    lines.push('工具,调用次数');
    for (const [name, count] of toolEntries) {
      lines.push(`${name},${count}`);
    }
    lines.push('');
  }

  // Section 6: Scenario distribution
  const scenarioEntries = Object.entries(usageStats.scenarios).sort((a, b) => b[1] - a[1]);
  if (scenarioEntries.length > 0) {
    lines.push('# 场景分布');
    lines.push('场景,请求数');
    for (const [name, count] of scenarioEntries) {
      lines.push(`${name},${count}`);
    }
  }

  const csv = lines.join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ccusage-${currentPeriod}-${start}-${end}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── Print / PDF (formatted report) ──
function printTable(title, headers, rows) {
  if (!rows || rows.length === 0) return '';
  return `<h2>${title}</h2><table><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
}

document.getElementById('printBtn').addEventListener('click', () => {
  if (!lastReportData) return;
  const { usageStats, gitStats, start, end } = lastReportData;
  const periodName = currentPeriod === 'daily' ? '日报' : currentPeriod === 'weekly' ? '周报' : '月报';
  const dateRange = currentPeriod === 'daily' ? start : `${start} ~ ${end}`;

  // Capture chart images
  const imgs = {};
  for (const [key, chart] of Object.entries(charts)) {
    try { imgs[key] = chart.toBase64Image(); } catch {}
  }

  const projRows = Object.entries(usageStats.projects)
    .sort((a, b) => b[1].requests - a[1].requests)
    .map(([n, d]) => [n, d.requests, d.sessions instanceof Set ? d.sessions.size : (d.sessions || 0)]);

  const modelRows = Object.entries(usageStats.models)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([n, d]) => [n, d.count, fmtShort(d.inputTokens), fmtShort(d.outputTokens)]);

  const toolRows = Object.entries(usageStats.tools).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, c]) => [n, c]);

  const scenarioRows = Object.entries(usageStats.scenarios).sort((a, b) => b[1] - a[1]).map(([n, c]) => [n, c]);

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Claude Code 使用${periodName}</title>
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
</style>
</head>
<body>
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
  const rows = [
    ['提交次数', gitStats.commits],
    ['新增行数', '+' + fmt(gitStats.linesAdded)],
    ['删除行数', '-' + fmt(gitStats.linesDeleted)],
    ['变更文件', gitStats.filesChanged],
  ];
  if (gitStats.aiContribution) {
    const ai = gitStats.aiContribution;
    const pct = Math.round((ai.aiCommits / gitStats.commits) * 100);
    rows.push(['AI 辅助提交', `${ai.aiCommits}/${gitStats.commits} (${pct}%)`]);
  }
  return rows;
})()) : ''}
${gitStats && gitStats.commitTypes ? (() => {
  const types = Object.entries(gitStats.commitTypes).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  return types.length ? printTable('提交类型分布', ['类型', '数量'], types.map(([t, n]) => [t, n])) : '';
})() : ''}
${gitStats && gitStats.fileHotspots?.length ? printTable('文件热点 Top 10', ['文件', '触碰', '+行', '-行'], gitStats.fileHotspots.map(h => [h.path, h.touches, '+' + fmt(h.added), '-' + fmt(h.deleted)])) : ''}
${(imgs.scenarioChart || imgs.modelChart) ? `<h2>图表</h2><div class="charts">${imgs.scenarioChart ? '<div class="cc"><p>工作类型分布</p><img src="' + imgs.scenarioChart + '"></div>' : ''}${imgs.modelChart ? '<div class="cc"><p>模型使用分布</p><img src="' + imgs.modelChart + '"></div>' : ''}</div><div class="charts">${imgs.projectChart ? '<div class="cc"><p>项目使用分布</p><img src="' + imgs.projectChart + '"></div>' : ''}${imgs.toolChart ? '<div class="cc"><p>工具调用排行</p><img src="' + imgs.toolChart + '"></div>' : ''}</div>` : ''}
<p class="ft">ccusage-report · 数据来自本地日志，不上传至任何服务器</p>
</body>
</html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
  setTimeout(() => { win.print(); }, 400);
});

// ── Download MD ──
document.getElementById('downloadMdBtn').addEventListener('click', () => {
  if (!currentWorkReportMarkdown) return;
  const blob = new Blob([currentWorkReportMarkdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `work-report-${currentPeriod}-${currentDate}.md`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── Date navigation ──
function shiftDate(days) {
  const d = new Date(currentDate);
  d.setDate(d.getDate() + days);
  currentDate = d.toISOString().slice(0, 10);
  document.getElementById('dateInput').value = currentDate;
  resetToReportView();
  loadData();
  saveStateToHash();
}

document.getElementById('prevDate').addEventListener('click', () => {
  const step = currentPeriod === 'daily' ? -1 : currentPeriod === 'weekly' ? -7 : -30;
  shiftDate(step);
});

document.getElementById('nextDate').addEventListener('click', () => {
  const step = currentPeriod === 'daily' ? 1 : currentPeriod === 'weekly' ? 7 : 30;
  shiftDate(step);
});

// ── Dark mode ──
const themeBtn = document.getElementById('themeBtn');
const savedTheme = localStorage.getItem('ccusage-theme');
if (savedTheme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');

themeBtn.addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('ccusage-theme', 'light');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('ccusage-theme', 'dark');
  }
  loadData();
});

// ── Hook into loadData ──
const origLoadData = loadData;
const enhancedLoadData = async function() {
  await origLoadData.call(this);
};
// Override
loadData = enhancedLoadData;
