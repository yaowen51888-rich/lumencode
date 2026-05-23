import { COLORS, TEXT, ID, STORAGE } from './config.js';
import { esc, fmt, fmtShort, renderTrendArrow, destroyChart, destroyAllCharts, setChart } from './utils.js';
import { createLatestRequestGuard, fetchTools, fetchReport, fetchConfig, saveConfig, fetchDetails, fetchSessions } from './api.js';
import { renderDoughnut, renderBar, renderTrend, renderCommitTypeChart, renderCacheEfficiency, renderModelCostChart } from './charts.js';
import { renderGitInsights } from './git-insights.js';
import { loadWorkReport, copyWorkReport, downloadMarkdown, getWorkReportState, setWorkReportState } from './work-report.js';
import { exportCSV, printReport, exportJSON, exportHTML } from './export.js';
import { showSkeleton, hideSkeleton, showError, hideError, showEmpty, hideEmpty, clearReportUI } from './ui-state.js';

// ── 全局状态 ──
let currentPeriod = 'daily';
let currentDate = new Date().toISOString().slice(0, 10);
let currentTool = 'all';
let lastReportData = null;

// ── Drill-down 钻取弹窗 ──
function showDrill(title, html) {
  const drillTitle = document.getElementById(ID.DRILL_TITLE);
  const drillBody = document.getElementById(ID.DRILL_BODY);
  const drillModal = document.getElementById(ID.DRILL_MODAL);
  if (drillTitle) drillTitle.textContent = title;
  if (drillBody) drillBody.innerHTML = html;
  if (drillModal) drillModal.style.display = 'flex';
}

// 场景 drill-down 全局回调（由 charts.js 调用）
window._drillHandler = async (type, key, label) => {
  showDrill(esc(label) + ' 匹配示例', '<div class="drill-empty">加载中...</div>');
  try {
    const rows = await fetchDetails({ period: currentPeriod, date: currentDate, dimension: type, key });
    if (!rows.length) { showDrill(esc(label), '<div class="drill-empty">无匹配记录</div>'); return; }
    showDrill(esc(label) + ' 匹配示例', '<table class="drill-table"><tr><th>用户消息</th><th>时间</th></tr>' + rows.map(r => `<tr><td class="drill-text" title="${esc(r.text)}">${esc(r.text)}</td><td>${esc(r.timestamp?.slice(0, 16)?.replace('T', ' '))}</td></tr>`).join('') + '</table>');
  } catch {
    showDrill(esc(label), '<div class="drill-empty">加载失败</div>');
  }
};

// ── 返回报告视图 ──
function resetToReportView() {
  const workReportSection = document.getElementById(ID.WORK_REPORT_SECTION);
  const statsGrid = document.getElementById(ID.STATS_GRID);
  const chartsSection = document.getElementById(ID.ANALYTICS_SECTION);
  const gitSection = document.getElementById(ID.GIT_SECTION);
  const workReportBtn = document.getElementById(ID.WORK_REPORT_BTN);
  if (workReportSection) workReportSection.style.display = 'none';
  if (statsGrid) statsGrid.style.display = 'grid';
  if (chartsSection) chartsSection.style.display = 'block';
  if (gitSection) gitSection.style.display = gitSection.dataset.hasGit === 'true' ? 'block' : 'none';
  if (workReportBtn) workReportBtn.style.display = 'inline-block';
}

// ── Alpine.js Components ──
// ES Module 加载晚于 defer 脚本，Alpine 可能已初始化，需兼容两种时序
function registerAlpineComponents() {
  Alpine.data('toolTabs', () => ({
    activeTool: 'all',
    availableTools: [],
    showAddTool: false,
    collapsed: localStorage.getItem(STORAGE.SIDEBAR_COLLAPSED) === 'true',

    async init() {
      await this.loadTools();
    },

    async loadTools() {
      try {
        this.availableTools = await fetchTools();
      } catch {
        this.availableTools = [];
      }
    },

    setTool(name) {
      this.activeTool = name;
      window.dispatchEvent(new CustomEvent('tool-changed', { detail: name }));
    },

    toggleCollapse() {
      this.collapsed = !this.collapsed;
      localStorage.setItem(STORAGE.SIDEBAR_COLLAPSED, String(this.collapsed));
    },
  }));

  Alpine.data('app', () => ({
    activeTool: 'all',
    activePeriod: currentPeriod,
    currentDate: currentDate,
    loading: false,
    error: null,
    cache: {},
    lastReportData: null,
    reportRequestGuard: createLatestRequestGuard(),

    async init() {
      this.loadStateFromHash();

      window.addEventListener('tool-changed', e => {
        this.activeTool = e.detail;
        currentTool = e.detail;
        resetToReportView();
        this.loadCurrentView();
      });

      this.bindPeriodButtons();
      this.bindDateControls();
      await this.loadCurrentView();
    },

    bindPeriodButtons() {
      document.querySelectorAll('.category-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.category-tab').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.setPeriod(btn.dataset.period);
        });
      });
    },

    bindDateControls() {
      if (this._dateControlsBound) return;
      this._dateControlsBound = true;
      const dateInput = document.getElementById(ID.DATE_INPUT);
      if (dateInput) {
        dateInput.value = this.currentDate;
        dateInput.max = new Date().toISOString().slice(0, 10);
        dateInput.addEventListener('change', e => this.setDate(e.target.value));
      }
      document.getElementById(ID.PREV_DATE)?.addEventListener('click', () => this.shiftDate(-1));
      document.getElementById(ID.NEXT_DATE)?.addEventListener('click', () => this.shiftDate(1));
    },

    shiftDate(days) {
      const d = new Date(this.currentDate);
      d.setDate(d.getDate() + days);
      this.setDate(d.toISOString().slice(0, 10));
    },

    async loadCurrentView() {
      const tool = this.activeTool;
      const period = this.activePeriod;
      const date = this.currentDate;
      const cacheKey = `${tool}-${period}-${date}`;
      const request = this.reportRequestGuard.next();
      if (this.cache[cacheKey]) {
        this.renderData(this.cache[cacheKey]);
        this.loading = false;
        hideSkeleton();
        return;
      }

      this.loading = true;
      this.error = null;
      showSkeleton();
      hideError();

      try {
        const data = await fetchReport({ tool, period, date }, request.signal);
        if (!request.isCurrent() || tool !== this.activeTool || period !== this.activePeriod || date !== this.currentDate) return;

        if (!data || data.error) {
          if (data?.hint) this.error = data.hint;
          if (data?.error === TEXT.NOT_CONFIGURED) {
            showEmpty();
            try {
              const cfg = await fetchConfig();
              const welcomeClaudeDir = document.getElementById(ID.WELCOME_CLAUDE_DIR);
              const welcomeRepos = document.getElementById(ID.WELCOME_REPOS);
              if (welcomeClaudeDir) welcomeClaudeDir.value = cfg.claudeDir || '';
              if (welcomeRepos) welcomeRepos.value = (cfg.repos || []).join(', ');
            } catch {}
          } else {
            clearReportUI(destroyChart);
          }
          return;
        }

        hideEmpty();
        this.cache[cacheKey] = data;
        this.lastReportData = data;
        lastReportData = data;
        this.renderData(data);
      } catch (err) {
        if (err.name === 'AbortError') return;
        if (!request.isCurrent()) return;
        this.error = '网络错误: ' + err.message;
        showError(this.error);
      } finally {
        if (request.isCurrent()) {
          this.loading = false;
          hideSkeleton();
        }
      }
    },

    renderData(data) {
      const { usageStats, gitStats, start, end, reposConfigured } = data;

      const toolName = this.activeTool === 'all' ? TEXT.ALL_TOOLS : this.activeTool;
      const periodName = this.activePeriod === 'daily' ? TEXT.DAILY : this.activePeriod === 'weekly' ? TEXT.WEEKLY : TEXT.MONTHLY;
      document.getElementById(ID.REPORT_TITLE).textContent = `${toolName} ${TEXT.USAGE}${periodName}`;
      const analyticsTitle = document.querySelector(`#${ID.ANALYTICS_SECTION} .title-md`);
      if (analyticsTitle) analyticsTitle.textContent = this.activeTool === 'all' ? TEXT.DATA_ANALYSIS : `${toolName} ${TEXT.DATA_ANALYSIS}`;
      document.getElementById(ID.REPORT_DATE).textContent =
        this.activePeriod === 'daily' ? start :
        this.activePeriod === 'weekly' ? `${start} ~ ${end}` :
        start.slice(0, 7);

      document.getElementById(ID.STAT_SESSIONS).textContent = fmt(usageStats.sessionCount);
      document.getElementById(ID.STAT_REQUESTS).textContent = fmt(usageStats.requestCount);
      document.getElementById(ID.STAT_PROJECTS).textContent = Object.keys(usageStats.projects).length;
      document.getElementById(ID.STAT_TOKENS).textContent = fmt(usageStats.totalTokens);

      const tokenBreakdown = document.getElementById(ID.STAT_TOKEN_BREAKDOWN);
      if (tokenBreakdown) {
        tokenBreakdown.innerHTML = `<span>输入 ${fmt(usageStats.inputTokens)}</span><span>输出 ${fmt(usageStats.outputTokens)}</span>` +
          (usageStats.cacheRead > 0 ? `<span>缓存 ${fmt(usageStats.cacheRead)}</span>` : '');
      }

      const costEl = document.getElementById(ID.STAT_COST);
      if (costEl) {
        costEl.textContent = usageStats.estimatedCost ? `~$${usageStats.estimatedCost.toFixed(2)}` : '-';
      }

      const costModelEl = document.getElementById(ID.STAT_COST_MODEL);
      if (costModelEl && usageStats.models) {
        const modelEntries = Object.entries(usageStats.models).sort((a, b) => b[1].count - a[1].count);
        costModelEl.textContent = modelEntries.length > 0 ? modelEntries.slice(0, 2).map(([m]) => m.replace('claude-', '')).join(' · ') : '';
      }

      renderTrendArrow(ID.TREND_SESSIONS, usageStats.sessionCount, data.prevStats?.sessionCount);
      renderTrendArrow(ID.TREND_REQUESTS, usageStats.requestCount, data.prevStats?.requestCount);
      renderTrendArrow(ID.TREND_PROJECTS, Object.keys(usageStats.projects).length, data.prevStats && data.prevStats.projects ? Object.keys(data.prevStats.projects).length : null);
      renderTrendArrow(ID.TREND_TOKENS, usageStats.totalTokens, data.prevStats?.totalTokens);
      renderTrendArrow(ID.TREND_COST, usageStats.estimatedCost, data.prevStats?.estimatedCost);

      const hasData = usageStats.requestCount > 0;
      const noDataHint = document.getElementById(ID.NO_DATA_HINT);
      const chartsDashboard = document.getElementById(ID.CHARTS_DASHBOARD);
      if (noDataHint) noDataHint.style.display = hasData ? 'none' : 'block';
      if (chartsDashboard) chartsDashboard.style.display = hasData ? 'flex' : 'none';

      const trendSection = document.getElementById(ID.TREND_SECTION);
      if (data.trendData && Object.keys(data.trendData.dailyStats).length > 0) {
        trendSection.style.display = 'block';
        renderTrend(data.trendData);
      } else {
        trendSection.style.display = 'none';
      }

      // Cache efficiency chart
      const cacheSection = document.getElementById('cacheSection');
      if (cacheSection) {
        if (usageStats.cacheRead > 0 || usageStats.cacheCreate > 0) {
          cacheSection.style.display = 'block';
          renderCacheEfficiency(ID.CACHE_CHART, usageStats.cacheRead, usageStats.cacheCreate, usageStats.inputTokens, data.costBreakdown);
        } else {
          cacheSection.style.display = 'none';
        }
      }

      // Model cost chart
      const modelCostSection = document.getElementById('modelCostSection');
      if (modelCostSection) {
        if (data.costBreakdown?.models?.some(m => m.cost > 0)) {
          modelCostSection.style.display = 'block';
          renderModelCostChart(ID.MODEL_COST_CHART, usageStats.models, data.costBreakdown);
        } else {
          modelCostSection.style.display = 'none';
        }
      }

      if (!hasData) {
        destroyAllCharts([ID.SCENARIO_CHART, ID.MODEL_CHART, ID.PROJECT_CHART, ID.TOOL_CHART, ID.CACHE_CHART, ID.MODEL_COST_CHART]);
        this.updateGitPanel(gitStats, this.activeTool, reposConfigured);
        return;
      }

      // Scenarios
      renderDoughnut(ID.SCENARIO_CHART, usageStats.scenarios, '场景分布');

      // Models (with drill-down)
      const modelEntries = Object.entries(usageStats.models).sort((a, b) => b[1].count - a[1].count);
      destroyChart(ID.MODEL_CHART);
      const modelCtx = document.getElementById(ID.MODEL_CHART).getContext('2d');
      const modelChart = new Chart(modelCtx, {
        type: 'bar',
        data: { labels: modelEntries.map(([k]) => k), datasets: [{ label: '请求次数', data: modelEntries.map(([, v]) => v.count), backgroundColor: '#374151', borderRadius: 6, maxBarThickness: 20, barPercentage: 0.7 }] },
        options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y', scales: { x: { grid: { color: '#f3f4f6' }, ticks: { font: { family: 'Inter', size: 11 } } }, y: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 12 } } } }, plugins: { legend: { display: false } },
          onClick: async (evt, elements) => {
            if (elements.length === 0) return;
            const model = modelEntries[elements[0].index][0];
            showDrill(esc(model), '<div class="drill-empty">加载中...</div>');
            try {
              const rows = await fetchDetails({ period: this.activePeriod, date: this.currentDate, dimension: 'model', key: model });
              if (!rows.length) { showDrill(esc(model), '<div class="drill-empty">无数据</div>'); return; }
              showDrill(esc(model) + ' 按日分布', '<table class="drill-table"><tr><th>日期</th><th>请求数</th><th>输入Token</th><th>输出Token</th></tr>' + rows.map(r => `<tr><td>${esc(r.date)}</td><td>${r.requests}</td><td>${fmtShort(r.inputTokens)}</td><td>${fmtShort(r.outputTokens)}</td></tr>`).join('') + '</table>');
            } catch {}
          }
        }
      });
      setChart(ID.MODEL_CHART, modelChart);

      // Projects (with drill-down)
      const projEntries = Object.entries(usageStats.projects).filter(([, d]) => d.requests > 0).sort((a, b) => b[1].requests - a[1].requests).slice(0, 8);
      destroyChart(ID.PROJECT_CHART);
      const projCtx = document.getElementById(ID.PROJECT_CHART).getContext('2d');
      const projChart = new Chart(projCtx, {
        type: 'bar',
        data: { labels: projEntries.map(([k]) => k.length > 20 ? '...' + k.slice(-17) : k), datasets: [{ label: '请求数', data: projEntries.map(([, v]) => v.requests), backgroundColor: '#374151', borderRadius: 6, maxBarThickness: 20, barPercentage: 0.7 }] },
        options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y', scales: { x: { grid: { color: '#f3f4f6' }, ticks: { font: { family: 'Inter', size: 11 } } }, y: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 12 } } } }, plugins: { legend: { display: false } },
          onClick: async (evt, elements) => {
            if (elements.length === 0) return;
            const project = projEntries[elements[0].index][0];
            showDrill(esc(project), '<div class="drill-empty">加载中...</div>');
            try {
              const params = { project, period: this.activePeriod, date: this.currentDate };
              if (this.activeTool !== 'all') params.tool = this.activeTool;
              const rows = await fetchSessions(params);
              if (!rows.length) { showDrill(esc(project), '<div class="drill-empty">无数据</div>'); return; }
              const html = '<table class="drill-table">'
                + '<tr><th></th><th>会话ID</th><th>开始</th><th>时长</th><th>请求</th><th>工具</th><th>文件</th><th>提交</th></tr>'
                + rows.map((r, i) => {
                    const start = r.startTime ? r.startTime.slice(0, 16).replace('T', ' ') : '-';
                    const dur = r.duration ? (r.duration >= 3600 ? (r.duration / 3600).toFixed(1) + 'h' : r.duration >= 60 ? Math.round(r.duration / 60) + 'm' : r.duration + 's') : '-';
                    const cn = r.commits?.length || 0;
                    const toggle = cn > 0 ? `<button class="commit-toggle" data-idx="${i}">▸</button>` : '';
                    const tools = [...new Set(r.toolSequence || [])].slice(0, 3).join(', ');
                    const fileCount = r.touchedFileCount || 0;
                    const commitRows = cn > 0
                      ? `<tr class="commit-subrow" data-idx="${i}" style="display:none;"><td colspan="8"><table class="commit-subtable">
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
                    return `<tr><td>${toggle}</td><td class="drill-text" title="${esc(r.id)}">${esc(r.id)}</td><td>${start}</td><td>${dur}</td><td>${r.requests || '-'}</td><td class="drill-text">${tools || '-'}</td><td>${fileCount || '-'}</td><td>${cn || '-'}</td></tr>${commitRows}`;
                  }).join('')
                + '</table>';
              showDrill(esc(project) + ' 会话记录', html);
              document.querySelectorAll('.commit-toggle').forEach(btn => {
                btn.addEventListener('click', () => {
                  const idx = btn.dataset.idx;
                  const sub = document.querySelector(`.commit-subrow[data-idx="${idx}"]`);
                  const open = sub.style.display !== 'none';
                  sub.style.display = open ? 'none' : '';
                  btn.textContent = open ? '▸' : '▾';
                });
              });
            } catch {}
          }
        }
      });
      setChart(ID.PROJECT_CHART, projChart);

      // Tools
      const toolEntries = Object.entries(usageStats.tools).sort((a, b) => b[1] - a[1]).slice(0, 10);
      renderBar(ID.TOOL_CHART, toolEntries.map(([k]) => k), toolEntries.map(([, v]) => v), '调用次数');

      this.updateGitPanel(gitStats, this.activeTool, reposConfigured);
    },

    updateGitPanel(gitStats, activeTool = 'all', reposConfigured = false) {
      const gitSection = document.getElementById(ID.GIT_SECTION);
      const gitInsightsRow = document.getElementById(ID.GIT_INSIGHTS_ROW);
      const gitConfigured = gitStats !== null || reposConfigured;
      const hasGit = gitStats && (gitStats.commits > 0 || gitStats.filesChanged > 0);
      if (hasGit) {
        gitSection.style.display = 'block';
        gitSection.dataset.hasGit = 'true';
        document.getElementById(ID.GIT_STATS).innerHTML = `
          <div class="git-stat-item"><div class="git-stat-value">${fmt(gitStats.commits)}</div><div class="git-stat-label">提交次数</div></div>
          <div class="git-stat-item"><div class="git-stat-value">+${fmt(gitStats.linesAdded)}</div><div class="git-stat-label">新增行数</div></div>
          <div class="git-stat-item"><div class="git-stat-value">-${fmt(gitStats.linesDeleted)}</div><div class="git-stat-label">删除行数</div></div>
          <div class="git-stat-item"><div class="git-stat-value">${fmt(gitStats.filesChanged)}</div><div class="git-stat-label">变更文件</div></div>
        `;
        renderGitInsights(gitStats, activeTool);
      } else {
        gitSection.style.display = 'block';
        gitSection.dataset.hasGit = 'false';
        if (gitConfigured) {
          document.getElementById(ID.GIT_STATS).innerHTML = `<div style="text-align:center;padding:16px 0;grid-column:1/-1;"><p style="color:var(--muted);">该时间段暂无 Git 提交记录</p></div>`;
        } else {
          document.getElementById(ID.GIT_STATS).innerHTML = `<div style="text-align:center;padding:16px 0;grid-column:1/-1;"><p style="color:var(--muted);margin-bottom:12px;">配置本地项目路径后，可在此查看 Git 代码产出</p><button class="btn-outline" onclick="document.getElementById('${ID.SETTINGS_BTN}').click()">配置项目路径</button></div>`;
        }
        document.getElementById(ID.GIT_AI_STATS).innerHTML = '';
        if (gitInsightsRow) gitInsightsRow.style.display = 'none';
        destroyChart('commitTypeChart');
      }
    },

    setPeriod(period) {
      this.activePeriod = period;
      currentPeriod = period;
      this.saveStateToHash();
      resetToReportView();
      this.loadCurrentView();
    },

    setDate(date) {
      const today = new Date().toISOString().slice(0, 10);
      if (date > today) date = today;
      this.currentDate = date;
      currentDate = date;
      document.getElementById(ID.DATE_INPUT).value = date;
      this.saveStateToHash();
      resetToReportView();
      this.loadCurrentView();
    },

    loadStateFromHash() {
      const hash = location.hash.slice(1);
      if (!hash) return;
      const [p, d] = hash.split('/');
      if (p && ['daily', 'weekly', 'monthly'].includes(p)) {
        this.activePeriod = p;
        currentPeriod = p;
        document.querySelectorAll('.category-tab').forEach(b => b.classList.toggle('active', b.dataset.period === p));
      }
      if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
        this.currentDate = d;
        currentDate = d;
      }
    },

    saveStateToHash() {
      location.hash = `${this.activePeriod}/${this.currentDate}`;
    },
  }));
}

// ── Alpine 加载 ──
// Alpine 通过 queueMicrotask(start) 自动初始化
// 我们需要在 Alpine.start() 之前注册 Alpine.data()
// 方案：在 Alpine 脚本标签之前设置 alpine:init 监听器
// 用 inline script 在 head 中捕获 alpine:init 事件
document.addEventListener('alpine:init', registerAlpineComponents);
// 动态加载 Alpine（不在 HTML 预加载，确保我们的监听器先就位）
const alpineScript = document.createElement('script');
alpineScript.src = '/vendor/alpine.min.js';
document.head.appendChild(alpineScript);

// ── URL Hash State (non-Alpine fallback) ──
(function loadStateFromHashFallback() {
  const hash = location.hash.slice(1);
  if (!hash) return;
  const [p, d] = hash.split('/');
  if (p && ['daily', 'weekly', 'monthly'].includes(p)) {
    currentPeriod = p;
    document.querySelectorAll('.category-tab').forEach(b => b.classList.toggle('active', b.dataset.period === p));
  }
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    currentDate = d;
    document.getElementById(ID.DATE_INPUT).value = d;
  }
})();

// ── Welcome page config ──
document.getElementById(ID.WELCOME_START_BTN)?.addEventListener('click', async () => {
  const claudeDir = document.getElementById(ID.WELCOME_CLAUDE_DIR).value.trim();
  const reposRaw = document.getElementById(ID.WELCOME_REPOS).value.trim();
  const hint = document.getElementById(ID.WELCOME_HINT);

  if (!claudeDir) { hint.textContent = '请输入 Claude 日志目录路径'; hint.style.color = '#dc2626'; return; }

  const repos = reposRaw ? reposRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  try {
    hint.textContent = '保存配置中...';
    hint.style.color = 'var(--muted)';
    await saveConfig({ claudeDir, repos });
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
  try { return JSON.parse(localStorage.getItem(STORAGE.CONFIG) || '{}'); } catch { return {}; }
}

function saveLocalConfig(cfg) {
  localStorage.setItem(STORAGE.CONFIG, JSON.stringify(cfg));
}

async function syncConfigFromServer() {
  try {
    const serverCfg = await fetchConfig();
    const localCfg = loadLocalConfig();
    saveLocalConfig({ ...localCfg, ...serverCfg });
  } catch {}
}

syncConfigFromServer().then(() => {
  const appEl = document.querySelector('[x-data="app()"]');
  if (appEl && appEl._x_dataStack) loadData();
});

// ── Settings modal ──
const settingsModal = document.getElementById(ID.SETTINGS_MODAL);
const settingsBtn = document.getElementById(ID.SETTINGS_BTN);
const closeSettings = document.getElementById(ID.CLOSE_SETTINGS);
const saveSettingsEl = document.getElementById(ID.SAVE_SETTINGS);
const backdrop = settingsModal?.querySelector('.modal-backdrop');

settingsBtn?.addEventListener('click', async () => {
  let cfg = {};
  try { cfg = await fetchConfig(); } catch {}
  if (Object.keys(cfg).length === 0) cfg = loadLocalConfig();
  document.getElementById(ID.CFG_CLAUDE_DIR).value = cfg.claudeDir || '';
  document.getElementById(ID.CFG_REPOS).value = (cfg.repos || []).join('\n');
  document.getElementById(ID.CFG_EXCLUDE).value = (cfg.excludeProjects || []).join('\n');
  document.getElementById(ID.CFG_KEYWORDS).value = JSON.stringify(cfg.scenarioKeywords || {}, null, 2);
  settingsModal.style.display = 'flex';
});

function hideSettings() { if (settingsModal) settingsModal.style.display = 'none'; }
closeSettings?.addEventListener('click', hideSettings);
backdrop?.addEventListener('click', hideSettings);

saveSettingsEl?.addEventListener('click', async () => {
  let scenarioKeywords;
  try { scenarioKeywords = JSON.parse(document.getElementById(ID.CFG_KEYWORDS).value); } catch { alert('场景关键词 JSON 格式错误，请检查'); return; }
  const payload = {
    claudeDir: document.getElementById(ID.CFG_CLAUDE_DIR).value.trim(),
    repos: document.getElementById(ID.CFG_REPOS).value.split('\n').map(s => s.trim()).filter(Boolean),
    excludeProjects: document.getElementById(ID.CFG_EXCLUDE).value.split('\n').map(s => s.trim()).filter(Boolean),
    scenarioKeywords,
  };
  saveLocalConfig(payload);
  try {
    await saveConfig(payload);
    const appEl = document.querySelector('[x-data="app()"]');
    if (appEl && appEl._x_dataStack) {
      const app = appEl._x_dataStack[0];
      if (app && app.cache) app.cache = {};
    }
    await loadData();
    hideSettings();
  } catch (err) {
    alert('保存失败: ' + err.message);
  }
});

// ── Work report events ──
document.getElementById(ID.WORK_REPORT_BTN)?.addEventListener('click', async () => {
  await loadWorkReport(fetch, currentTool, currentPeriod, currentDate);
});

document.querySelectorAll('.level-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.level-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadWorkReport(fetch, currentTool, currentPeriod, currentDate, null, btn.dataset.level);
  });
});

document.querySelectorAll('.platform-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.platform-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadWorkReport(fetch, currentTool, currentPeriod, currentDate, btn.dataset.platform, null);
  });
});

document.getElementById(ID.BACK_TO_REPORT)?.addEventListener('click', () => {
  resetToReportView();
});

document.getElementById(ID.COPY_WORK_REPORT)?.addEventListener('click', copyWorkReport);

// ── Drill-down modal close ──
document.getElementById(ID.CLOSE_DRILL)?.addEventListener('click', () => {
  const drillModal = document.getElementById(ID.DRILL_MODAL);
  if (drillModal) drillModal.style.display = 'none';
});
document.getElementById(ID.DRILL_MODAL)?.querySelector('.modal-backdrop')?.addEventListener('click', () => {
  const drillModal = document.getElementById(ID.DRILL_MODAL);
  if (drillModal) drillModal.style.display = 'none';
});

// ── Export events ──
document.getElementById(ID.EXPORT_CSV_BTN)?.addEventListener('click', () => exportCSV(lastReportData, currentPeriod));
document.getElementById(ID.PRINT_BTN)?.addEventListener('click', () => printReport(lastReportData, currentPeriod));
document.getElementById(ID.EXPORT_JSON_BTN)?.addEventListener('click', () => exportJSON(lastReportData, currentPeriod));
document.getElementById(ID.EXPORT_HTML_BTN)?.addEventListener('click', () => exportHTML(lastReportData, currentPeriod));
document.getElementById(ID.DOWNLOAD_MD_BTN)?.addEventListener('click', () => {
  const state = getWorkReportState();
  downloadMarkdown(currentPeriod, currentDate);
});

// ── Dark mode ──
const themeBtn = document.getElementById(ID.THEME_BTN);
const moonIcon = document.getElementById(ID.MOON_ICON);
const sunIcon = document.getElementById(ID.SUN_ICON);
const savedTheme = localStorage.getItem(STORAGE.THEME);

function updateThemeIcon() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (moonIcon) moonIcon.style.display = isDark ? 'none' : '';
  if (sunIcon) sunIcon.style.display = isDark ? '' : 'none';
  if (themeBtn) themeBtn.title = isDark ? '切换日间模式' : '切换暗色模式';
}

if (savedTheme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
updateThemeIcon();

themeBtn?.addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem(STORAGE.THEME, 'light');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem(STORAGE.THEME, 'dark');
  }
  updateThemeIcon();
  const workReportSection = document.getElementById(ID.WORK_REPORT_SECTION);
  if (workReportSection && workReportSection.style.display !== 'none') return;
  const appEl = document.querySelector('[x-data="app()"]');
  if (appEl && appEl._x_dataStack) {
    const app = appEl._x_dataStack[0];
    if (app && app.loadCurrentView) app.loadCurrentView();
  }
});

// ── Compatibility: loadData ──
async function loadData() {
  const appEl = document.querySelector('[x-data="app()"]');
  if (appEl && appEl._x_dataStack) {
    const app = appEl._x_dataStack[0];
    if (app && app.loadCurrentView) {
      await app.loadCurrentView();
      return { success: true };
    }
  }
  return { success: false, error: 'alpine-not-ready' };
}
