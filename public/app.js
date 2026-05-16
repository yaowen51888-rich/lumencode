const COLORS = [
  '#fb923c', '#ec4899', '#8b5cf6', '#34d399',
  '#3b82f6', '#f59e0b', '#ef4444', '#10b981',
];

let currentPeriod = 'daily';
let currentDate = new Date().toISOString().slice(0, 10);

const charts = {};

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

function render(data) {
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

  // Cost card
  const costEl = document.getElementById('statCost');
  if (costEl) {
    costEl.textContent = usageStats.estimatedCost
      ? `~$${usageStats.estimatedCost.toFixed(2)}`
      : '-';
  }

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
    data: { labels: modelEntries.map(([k]) => k), datasets: [{ label: '请求次数', data: modelEntries.map(([, v]) => v.count), backgroundColor: '#111111', borderRadius: 6, barThickness: 20 }] },
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
    data: { labels: projEntries.map(([k]) => k.length > 20 ? '...' + k.slice(-17) : k), datasets: [{ label: '请求数', data: projEntries.map(([, v]) => v.requests), backgroundColor: '#111111', borderRadius: 6, barThickness: 20 }] },
    options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y', scales: { x: { grid: { color: '#f3f4f6' }, ticks: { font: { family: 'Inter', size: 11 } } }, y: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 12 } } } }, plugins: { legend: { display: false } },
      onClick: (evt, elements) => {
        if (elements.length === 0) return;
        const project = projEntries[elements[0].index][0];
        showDrill(project, '<div class="drill-empty">加载中...</div>');
        fetch(`/api/sessions?project=${encodeURIComponent(project)}`).then(r => r.json()).then(rows => {
          if (!rows.length) { showDrill(project, '<div class="drill-empty">无数据</div>'); return; }
          showDrill(project + ' 会话记录', '<table class="drill-table"><tr><th>会话ID</th><th>开始时间</th><th>请求数</th></tr>' + rows.map(r => `<tr><td class="drill-text" title="${r.id}">${r.id}</td><td>${r.startedAt ? r.startedAt.slice(0, 16).replace('T', ' ') : '-'}</td><td>${r.requests || '-'}</td></tr>`).join('') + '</table>');
        });
      }
    }
  });

  // Tools
  const toolEntries = Object.entries(usageStats.tools).sort((a, b) => b[1] - a[1]).slice(0, 10);
  renderBar('toolChart', toolEntries.map(([k]) => k), toolEntries.map(([, v]) => v), '调用次数');

  // Git
  const gitSection = document.getElementById('gitSection');
  if (gitStats && gitStats.commits > 0) {
    gitSection.style.display = 'block';
    gitSection.dataset.hasGit = 'true';
    document.getElementById('gitStats').innerHTML = `
      <div class="git-stat-item"><div class="git-stat-value">${fmt(gitStats.commits)}</div><div class="git-stat-label">提交次数</div></div>
      <div class="git-stat-item"><div class="git-stat-value">+${fmt(gitStats.linesAdded)}</div><div class="git-stat-label">新增行数</div></div>
      <div class="git-stat-item"><div class="git-stat-value">-${fmt(gitStats.linesDeleted)}</div><div class="git-stat-label">删除行数</div></div>
      <div class="git-stat-item"><div class="git-stat-value">${fmt(gitStats.filesChanged)}</div><div class="git-stat-label">变更文件</div></div>
    `;
  } else {
    gitSection.style.display = 'none';
    gitSection.dataset.hasGit = 'false';
  }
}

function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}

function renderDoughnut(canvasId, dataMap, label) {
  destroyChart(canvasId);
  const entries = Object.entries(dataMap).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const ctx = document.getElementById(canvasId).getContext('2d');
  charts[canvasId] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: entries.map(([k]) => k),
      datasets: [{
        data: entries.map(([, v]) => v),
        backgroundColor: COLORS,
        borderWidth: 0,
        hoverOffset: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: { position: 'right', labels: { font: { family: 'Inter', size: 12 }, padding: 16 } },
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
        backgroundColor: '#111111',
        borderRadius: 6,
        barThickness: 20,
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

// Event handlers
document.querySelectorAll('.category-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.category-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentPeriod = btn.dataset.period;
    loadData();
  });
});

document.getElementById('dateInput').value = currentDate;
document.getElementById('dateInput').addEventListener('change', (e) => {
  currentDate = e.target.value;
  loadData();
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
}

function hideSkeleton() {
  document.querySelectorAll('.card-value.skeleton').forEach(el => {
    el.classList.remove('skeleton');
  });
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
  document.querySelector('.charts-section').style.display = 'none';
  document.getElementById('trendSection').style.display = 'none';
  document.getElementById('gitSection').style.display = 'none';
  const empty = document.getElementById('emptyState');
  if (empty) empty.style.display = 'block';
}

function hideEmpty() {
  const empty = document.getElementById('emptyState');
  if (empty) empty.style.display = 'none';
  document.getElementById('statsGrid').style.display = 'grid';
  document.querySelector('.charts-section').style.display = 'block';
}

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
const chartsSection = document.querySelector('.charts-section');
const gitSection = document.getElementById('gitSection');

let currentWorkReportMarkdown = '';

workReportBtn.addEventListener('click', async () => {
  const res = await fetch(`/api/report?period=${currentPeriod}&date=${currentDate}&format=work`);
  if (!res.ok) return;
  const markdown = await res.text();
  currentWorkReportMarkdown = markdown;
  workReportContent.innerHTML = renderMarkdown(markdown);
  statsGrid.style.display = 'none';
  chartsSection.style.display = 'none';
  gitSection.style.display = 'none';
  workReportSection.style.display = 'block';
  workReportBtn.style.display = 'none';
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
