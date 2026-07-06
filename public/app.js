import { COLORS, SCENARIO_COLORS, TEXT, ID, STORAGE } from './config.js';
import { esc, fmt, fmtShort, destroyChart, destroyAllCharts, getChart, setChart, todayISO, fmtDate, TOOL_DISPLAY_NAMES, groupMcpByServer, aggregateToolsWithDualCounts, TOOL_COLORS, TOOL_SUB_NAMES, TOOL_META, toolDisplayName } from './utils.js';
import { createLatestRequestGuard, fetchTools, fetchReport, fetchConfig, saveConfig, fetchDetails, fetchSessions, fetchStepStats, fetchHooksStatus, updateHooks, fetchSmartReportTools, fetchSmartReportRecord, generateSmartReport } from './api.js';
import { renderWorkTypePie, renderModelBars, renderProjectBars, renderTimelineArea, renderCacheStack } from './charts.js';
import { renderGitInsights, renderLineBlameEvidence } from './git-insights.js';
import { loadWorkReport, copyWorkReport, downloadMarkdown, getWorkReportState, setWorkReportState } from './work-report.js';
import { exportCSV, printReport, exportJSON, exportHTML } from './export.js';
import { formatViewStateHash, parseViewStateHash } from './view-state.js';

/* ── Alpine App Component ── */
function appState() {
  return {
    /* state */
    view: 'ledger',
    period: 'daily',
    activeTool: 'all',
    sourcePaletteOpen: false,
    sourceQuery: '',
    railCollapsed: localStorage.getItem(STORAGE.SIDEBAR_COLLAPSED) === 'true',
    theme: localStorage.getItem(STORAGE.THEME) || 'dark',
    currentDate: todayISO(),
    today: todayISO(),
    loading: false,
    error: null,
    hasData: false,
    availableTools: [],
    appName: 'LumenCode',
    appVersion: '',
    lastReportData: null,
    cache: {},
    _cacheOrder: [],
    _cacheMaxSize: 30,
    reportRequestGuard: createLatestRequestGuard(),

    /* report view state */
    reportLevel: 'detailed',
    reportPlatform: 'default',
    reportProject: '',
    reportProjects: [],
    copied: false,
    reportHtml: '',
    reportContentMode: 'source',
    smartReportTools: [],
    smartReportAgent: '',
    smartReportStyle: ['default', 'workhorse'].includes(localStorage.getItem(STORAGE.SMART_REPORT_STYLE)) ? localStorage.getItem(STORAGE.SMART_REPORT_STYLE) : 'default',
    smartReportStyleModalOpen: false,
    smartReportLoading: false,
    smartReportError: '',
    smartReportMarkdown: '',
    smartReportHtml: '',
    smartReportCopied: false,
    exportModalOpen: false,
    exportModalAction: 'copy',
    exportModalTarget: 'source',
    smartReportRecord: null,
    smartReportRecordMeta: '',
    smartReportNeedsUpdate: false,
    smartReportUpdateMessage: '',
    smartReportJob: null,
    smartReportStatusMessage: '',
    smartReportPollTimer: null,
    smartReportElapsedTimer: null,
    smartReportCompletionTimer: null,
    smartReportStartedAt: '',
    smartReportNow: Date.now(),
    smartReportProgress: 0,

    /* constants */
    customStart: '',
    customEnd: '',
    periods: [
      { id: 'daily', cn: '日', en: 'DAY' },
      { id: 'weekly', cn: '周', en: 'WEEK' },
      { id: 'monthly', cn: '月', en: 'MONTH' },
      { id: 'custom', cn: '自定义', en: 'CUSTOM' },
    ],
    colors: {
      rust: 'var(--rust)', dest: 'var(--dest)', forest: 'var(--forest)',
      ochre: 'var(--ochre)', clay: 'var(--clay)',
    },
    toolColors: TOOL_COLORS,
    toolSubNames: TOOL_SUB_NAMES,

    /* computed getters */
    get periodMeta() { return this.periods.find(p => p.id === this.period) || this.periods[0]; },
    get dateDisplay() {
      if (this.period === 'custom') {
        if (this.customStart && this.customEnd) return `${this.customStart.replace(/-/g, '.')} — ${this.customEnd.replace(/-/g, '.')}`;
        return '选择日期范围';
      }
      if (this.period === 'daily') return this.currentDate.replace(/-/g, '.');
      if (this.period === 'weekly') {
        const d = new Date(this.currentDate);
        const start = new Date(d); start.setDate(d.getDate() - d.getDay() + 1);
        const end = new Date(start); end.setDate(start.getDate() + 6);
        return `${fmtDate(start)} — ${fmtDate(end)}`;
      }
      return this.currentDate.slice(0, 7).replace('-', '.');
    },
    get generatedAt() { return fmtDate(new Date()) + ' · ' + new Date().toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'}) + ' UTC+8'; },
    get traceId() { return 'CT-' + this.currentDate.replace(/-/g, '-'); },

    /* 15 工具 Coverage：active（本周期有 sessions）+ idle（已支持无数据），usagePct 按 sessions 占比 */
    get coverageTools() {
      const all = Object.keys(TOOL_META);
      const maxSess = Math.max(1, ...all.map(n => this.toolSessions[n] || 0));
      return all.map(name => {
        const sess = this.toolSessions[name] || 0;
        const idle = sess === 0;
        return {
          name,
          displayName: toolDisplayName(name),
          color: TOOL_COLORS[name] || 'var(--rust)',
          sub: TOOL_SUB_NAMES[name] || name.toUpperCase(),
          tokens: this.toolTokens[name] || '',
          sessions: sess,
          usagePct: sess ? Math.round((sess / maxSess) * 100) : 0,
          idle,
        };
      });
    },
    get coverageActiveCount() { return this.coverageTools.filter(t => !t.idle).length; },
    /* SourceSelector palette：当前选中工具 + 搜索过滤后的 active/idle 两组 */
    get currentToolMeta() {
      if (this.activeTool === 'all') {
        return { name: 'all', displayName: '全部工具', sub: 'ALL SOURCES', color: null };
      }
      const t = this.coverageTools.find(x => x.name === this.activeTool);
      return t || { name: this.activeTool, displayName: toolDisplayName(this.activeTool), sub: TOOL_SUB_NAMES[this.activeTool] || this.activeTool.toUpperCase(), color: TOOL_COLORS[this.activeTool] || 'var(--rust)' };
    },
    get filteredActiveTools() {
      const q = this.sourceQuery.trim().toLowerCase();
      const list = this.coverageTools.filter(t => !t.idle);
      if (!q) return list;
      return list.filter(t => t.displayName.toLowerCase().includes(q) || t.sub.toLowerCase().includes(q));
    },
    get filteredIdleTools() {
      const q = this.sourceQuery.trim().toLowerCase();
      const list = this.coverageTools.filter(t => t.idle);
      if (!q) return list;
      return list.filter(t => t.displayName.toLowerCase().includes(q) || t.sub.toLowerCase().includes(q));
    },

    /* KPI defaults */
    kpiData: [
      { label: '活跃天数', sub: 'ACTIVE DAYS', value: '-', unit: '/ 31', delta: '', trend: 'flat' },
      { label: '覆盖项目', sub: 'PROJECTS', value: '-', unit: '个', delta: '', trend: 'flat' },
      { label: '高峰天数', sub: 'PEAK DAYS', value: '-', unit: '天', delta: '', trend: 'flat' },
      { label: 'Token 消耗 · 含缓存', sub: 'TOKENS · INC. CACHE', value: '-', unit: 'M', delta: '', trend: 'flat' },
      { label: '估算成本', sub: 'EST. COST USD', value: '-', unit: '', delta: '', trend: 'flat' },
    ],

    /* AI contribution defaults */
    aiLinePct: 0,
    aiLinePctDisplay: 0,
    _aiPctAnim: null,
    aiSummaryDesc: '',
    attributionPct: '0% / 100%',
    confirmedPct: 0,
    inferredPct: 0,
    unattribPct: 0,
    sourceClaudePct: 0,
    sourceCodexPct: 0,
    sourceOpencodePct: 0,
    sourceBreakdown: [],
    aiContributionMeta: '- / - LINES',
    lineBlameEvidence: null,
    lineBlamePrecision: '',
    stepStats: null,
    stepStatusLabel: '',
    hooksStatus: null,
    hooksBusy: false,
    gitOutputCells: [
      { l: '提交', en: 'COMMITS', v: '-', c: '' },
      { l: '变更文件', en: 'FILES', v: '-', c: '' },
      { l: '新增', en: '+ ADDED', v: '-', c: 'var(--forest)' },
      { l: '删除', en: '− REMOVED', v: '-', c: 'var(--dest)' },
    ],
    attributionCells: [
      { l: 'AI 改写', en: 'REWRITE', v: '-', c: '' },
      { l: 'AI 提交', en: 'COMMITS', v: '-', c: 'var(--forest)' },
      { l: '可能上限', en: 'MAX', v: '-', c: '' },
      { l: '高·中置信', en: 'HI · MID', v: '-', c: 'var(--ochre)' },
      { l: 'AI 新增', en: '+ AI', v: '-', c: 'var(--forest)' },
      { l: 'AI 删除', en: '− AI', v: '-', c: 'var(--dest)' },
    ],

    /* section data defaults */
    editTypeData: [],
    topFilesData: [],
    topFilesMeta: '+0 / −0',
    workTypeData: [],
    modelData: [],
    topModelName: '-',
    activeModels: '-',
    cacheHitRate: 0,
    cacheDelta: '',
    cacheData: [],
    cacheSavingText: '',
    timelineMeta: [
      { l: 'PEAK DAY', v: '-', s: '-' },
      { l: 'AVG / DAY', v: '-', s: 'sessions' },
      { l: 'LONGEST STREAK', v: '-', s: 'consecutive days' },
      { l: 'IDLE DAYS', v: '-', s: 'no activity' },
    ],
    toolRankData: [],
    toolRankTotal: 0,
    toolRankTab: 'all',
    toolRankTotalCalls: 0,
    toolRankAllTotal: 0,
    toolRankSkillTotal: 0,
    toolRankMcpTotal: 0,
    projectData: [],

    /* tool summary for rail */
    toolTokens: { all: '-' },
    toolSessions: { all: 0 },

    /* report view data */
    reportKpis: [
      { l: 'TOKENS', v: '-', s: '估算成本 -', accent: false },
      { l: 'COMMITS', v: '-', s: '- / - 行', accent: false },
      { l: 'AI CONTRIBUTION', v: '-', s: '- 行可独立运行', accent: true },
      { l: 'ACTIVE DAYS', v: '-', s: '连续 - 天最长', accent: false },
    ],
    reportSubTitle: '',
    reportSummary: '',
    reportHighlights: [],

    get hooksNeedAction() {
      if (!this.hooksStatus) return false;
      return !this.hooksStatus.stepsInitialized ||
        !this.hooksStatus.claude?.enabled ||
        !this.hooksStatus.codex?.enabled ||
        !this.hooksStatus.opencode?.enabled ||
        !this.hooksStatus.gemini?.enabled;
    },

    get hooksStatusText() {
      if (!this.hooksStatus) return '正在检查 hooks 状态';
      const total = this.hooksStatus.projectCount ?? this.hooksStatus.claude?.total ?? 0;
      if (this.hooksStatus.targetMode === 'configured-projects') {
        if (total === 0) return '未配置项目，请先在设置中添加项目路径';
        const parts = [
          `Claude ${this.hooksStatus.claude?.enabledCount || 0}/${total}`,
          `Codex ${this.hooksStatus.codex?.enabledCount || 0}/${total}`,
          `OpenCode ${this.hooksStatus.opencode?.enabledCount || 0}/${total}`,
          `Gemini ${this.hooksStatus.gemini?.enabledCount || 0}/${total}`,
          `steps ${this.hooksStatus.stepsReadyCount || 0}/${total}`,
        ];
        return `设置内项目 hooks：${parts.join(' / ')}`;
      }
      const parts = [
        `Claude ${this.hooksStatus.claude?.enabled ? '已开启' : '未开启'}`,
        `Codex ${this.hooksStatus.codex?.enabled ? '已开启' : '未开启'}`,
        `OpenCode ${this.hooksStatus.opencode?.enabled ? '已开启' : '未开启'}`,
        `Gemini ${this.hooksStatus.gemini?.enabled ? '已开启' : '未开启'}`,
        `steps ${this.hooksStatus.stepsInitialized ? '已初始化' : '未初始化'}`,
      ];
      return parts.join(' / ');
    },

    /* ── init ── */
    async init() {
      this.initSourcePaletteKb();
      this.loadStateFromHash();
      if (this.theme === 'dark') document.documentElement.classList.add('dark');
      else document.documentElement.classList.remove('dark');
      this.$watch('view', (value) => {
        if (value === 'ledger' && this.lastReportData) {
          this.$nextTick(() => this.renderCharts(this.lastReportData));
        }
      });
      await this.loadTools();
      await this.loadSmartReportTools();
      await this.loadHooksStatus();
      await this.loadStepStats();
      // 首次加载时先获取全量数据填充侧边栏，再按当前工具加载
      if (this.activeTool !== 'all') {
        try {
          const allData = await fetchReport({ tool: 'all', period: this.period, date: this.currentDate });
          if (allData && !allData.error) {
            this.computeToolTokens(allData.usageStats, allData.toolBreakdown);
          }
        } catch {}
      }
      await this.loadCurrentView();
      if (this.view === 'report') await this.loadReportContent();
    },

    /* ── theme ── */
    toggleTheme() { this.setTheme(this.theme === 'dark' ? 'light' : 'dark'); },
    setTheme(v) {
      if (v !== 'dark' && v !== 'light') return;
      if (this.theme === v) return;
      this.theme = v;
      localStorage.setItem(STORAGE.THEME, v);
      if (v === 'dark') document.documentElement.classList.add('dark');
      else document.documentElement.classList.remove('dark');
      /* re-render charts to pick up new colors */
      if (this.lastReportData && this.view === 'ledger') this.renderCharts(this.lastReportData);
    },
    setReportStyle(v) {
      this.smartReportStyle = v === 'workhorse' ? 'workhorse' : 'default';
      localStorage.setItem(STORAGE.SMART_REPORT_STYLE, this.smartReportStyle);
    },

    /* ── tools ── */
    async loadTools() {
      try {
        const data = await fetchTools();
        this.availableTools = data.tools || data || [];
        if (data.appName) this.appName = data.appName;
        if (data.appVersion) this.appVersion = data.appVersion;
      } catch (e) { console.warn('loadTools failed:', e); this.availableTools = []; }
    },

    async loadSmartReportTools() {
      try {
        const data = await fetchSmartReportTools();
        this.smartReportTools = data.tools || [];
        const savedAgent = localStorage.getItem(STORAGE.SMART_REPORT_AGENT);
        const firstDetected = this.smartReportTools.find(t => t.detected);
        const savedDetected = this.smartReportTools.find(t => t.detected && t.name === savedAgent);
        this.smartReportAgent = savedDetected?.name || firstDetected?.name || '';
        await this.loadSmartReportRecord();
      } catch (e) {
        console.warn('loadSmartReportTools failed:', e);
        this.smartReportTools = [];
        this.smartReportAgent = '';
      }
    },

    async loadStepStats() {
      try {
        const data = await fetchStepStats();
        this.stepStats = data;
        this.stepStatusLabel = data?.available
          ? `STEP READY · ${data.stepCount || 0}`
          : 'STEP NOT READY';
      } catch {
        this.stepStats = null;
        this.stepStatusLabel = '';
      }
    },

    async loadHooksStatus() {
      try {
        this.hooksStatus = await fetchHooksStatus();
      } catch (e) {
        console.warn('loadHooksStatus failed:', e);
        this.hooksStatus = null;
      }
    },

    showHooksConfirmModal() {
      const count = this.hooksStatus?.projectCount ?? 0;
      const el = document.getElementById('hooksConfirmCount');
      if (el) el.textContent = count;
      const modal = document.getElementById('hooksConfirmModal');
      if (modal) modal.style.display = 'flex';
    },

    hideHooksConfirmModal() {
      const modal = document.getElementById('hooksConfirmModal');
      if (modal) modal.style.display = 'none';
    },

    async enableHooksFromUi() {
      this.hideHooksConfirmModal();
      if (this.hooksBusy) return;
      this.hooksBusy = true;
      try {
        await updateHooks('enable');
        await this.loadHooksStatus();
        await this.loadStepStats();
        showToast('hooks 已开启');
      } catch (err) {
        showToast('开启 hooks 失败: ' + err.message);
      } finally {
        this.hooksBusy = false;
      }
    },

    showHooksDisableConfirmModal() {
      const modal = document.getElementById('hooksDisableConfirmModal');
      if (modal) modal.style.display = 'flex';
    },

    hideHooksDisableConfirmModal() {
      const modal = document.getElementById('hooksDisableConfirmModal');
      if (modal) modal.style.display = 'none';
    },

    async disableHooksFromUi() {
      this.hideHooksDisableConfirmModal();
      if (this.hooksBusy) return;
      this.hooksBusy = true;
      try {
        await updateHooks('disable');
        await this.loadHooksStatus();
        await this.loadStepStats();
        showToast('hooks 已关闭');
      } catch (err) {
        showToast('关闭 hooks 失败: ' + err.message);
      } finally {
        this.hooksBusy = false;
      }
    },

    setTool(name) {
      this.activeTool = name;
      this.resetSmartReportDisplay();
      this.loadCurrentView();
      if (this.view === 'report') this.loadReportContent();
    },

    /* ── SourceSelector palette ── */
    openSourcePalette() { this.sourceQuery = ''; this.sourcePaletteOpen = true; },
    closeSourcePalette() { this.sourcePaletteOpen = false; },
    setSource(name) { this.closeSourcePalette(); this.setTool(name); },
    setView(v) {
      if (v === 'settings') { this.view = 'settings'; this.saveStateToHash(); window.openSettings(); return; }
      v === 'report' ? this.openReport() : this.showLedger();
    },
    initSourcePaletteKb() {
      document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          this.sourcePaletteOpen = !this.sourcePaletteOpen;
          if (this.sourcePaletteOpen) this.sourceQuery = '';
        } else if (e.key === 'Escape' && this.sourcePaletteOpen) {
          this.sourcePaletteOpen = false;
        }
      });
    },

    setToolRankTab(tab) {
      this.toolRankTab = tab;
      this._computeToolRank();
      const container = document.getElementById('toolCallsContainer');
      if (container) container.scrollTop = 0;
    },

    _computeToolRank() {
      const usageStats = this._lastUsageStats || {};
      const tab = this.toolRankTab;
      const getCalls = (val) => typeof val === 'number' ? val : (val.calls || 0);
      const getUses = (val) => typeof val === 'number' ? val : (val.uses || 0);
      const sumCalls = (obj) => Object.values(obj || {}).reduce((s, v) => s + getCalls(v), 0);

      this.toolRankAllTotal = sumCalls(usageStats.tools);
      this.toolRankSkillTotal = sumCalls(usageStats.skills);
      this.toolRankMcpTotal = sumCalls(usageStats.mcpTools);

      if (tab === 'all') {
        const dual = aggregateToolsWithDualCounts(usageStats.tools || {});
        const entries = Object.entries(dual).sort((a, b) => b[1].uses - a[1].uses);
        const maxUses = Math.max(...entries.map(([, v]) => v.uses), 1);
        this.toolRankData = entries.map(([name, d]) => ({
          name,
          calls: d.calls,
          uses: d.uses,
          value: d.calls,
          pct: Math.round((d.uses / maxUses) * 100),
          displayName: TOOL_DISPLAY_NAMES[name] || '',
        }));
        this.toolRankTotalCalls = this.toolRankAllTotal;
      } else if (tab === 'skill') {
        const skills = usageStats.skills || {};
        const entries = Object.entries(skills).sort((a, b) => getUses(b[1]) - getUses(a[1]));
        const maxUses = Math.max(...entries.map(([, v]) => getUses(v)), 1);
        this.toolRankData = entries.map(([name, val]) => {
          const calls = getCalls(val);
          const uses = getUses(val);
          return {
            name,
            calls,
            uses,
            value: calls,
            pct: Math.round((uses / maxUses) * 100),
            displayName: '',
          };
        });
        this.toolRankTotalCalls = this.toolRankSkillTotal;
      } else if (tab === 'mcp') {
        this.toolRankData = groupMcpByServer(usageStats.mcpTools || {});
        this.toolRankTotalCalls = this.toolRankMcpTotal;
      }

      this.toolRankTotal = this.toolRankData.length;
      let rank = 0;
      for (const item of this.toolRankData) {
        if (!item.isGroup) item.rank = ++rank;
      }
    },

    /* ── period / date ── */
    setPeriod(p) {
      this.period = p;
      if (p !== 'custom') {
        this.customStart = '';
        this.customEnd = '';
        this.saveStateToHash();
        this.resetSmartReportDisplay();
        this.loadCurrentView();
        if (this.view === 'report') this.loadReportContent();
      }
    },

    onCustomStartChange() {
      if (this.customStart && this.customEnd) {
        this.resetSmartReportDisplay();
        this.loadCurrentView();
        if (this.view === 'report') this.loadReportContent();
      }
    },

    onCustomEndChange() {
      if (this.customStart && this.customEnd) {
        this.resetSmartReportDisplay();
        this.loadCurrentView();
        if (this.view === 'report') this.loadReportContent();
      }
    },

    shiftDate(dir) {
      const d = new Date(this.currentDate);
      if (this.period === 'monthly') {
        d.setMonth(d.getMonth() + dir);
      } else {
        const step = this.period === 'weekly' ? 7 * dir : dir;
        d.setDate(d.getDate() + step);
      }
      this.currentDate = d.toISOString().slice(0, 10);
      this.saveStateToHash();
      this.resetSmartReportDisplay();
      this.loadCurrentView();
      if (this.view === 'report') this.loadReportContent();
    },

    onDateChange() {
      if (this.currentDate > this.today) this.currentDate = this.today;
      this.saveStateToHash();
      this.resetSmartReportDisplay();
      this.loadCurrentView();
      if (this.view === 'report') this.loadReportContent();
    },

    loadStateFromHash() {
      const state = parseViewStateHash(location.hash);
      this.view = state.view;
      this.period = state.period;
      if (state.currentDate) this.currentDate = state.currentDate;
      // 直链/刷新进入 settings 时，表单元素已随 x-show 渲染在 DOM，立即填充
      if (state.view === 'settings') window.openSettings?.();
    },

    saveStateToHash() {
      location.hash = formatViewStateHash({ view: this.view, period: this.period, currentDate: this.currentDate });
    },

    /* ── data loading ── */
    async loadCurrentView() {
      const cacheKey = `${this.activeTool}-${this.period}-${this.period === 'custom' ? this.customStart + '~' + this.customEnd : this.currentDate}`;
      const request = this.reportRequestGuard.next();

      if (this.cache[cacheKey]) {
        const idx = this._cacheOrder.indexOf(cacheKey);
        if (idx !== -1) { this._cacheOrder.splice(idx, 1); this._cacheOrder.push(cacheKey); }
        this.renderData(this.cache[cacheKey]);
        this.loading = false;
        return;
      }

      this.loading = true;
      this.error = null;

      try {
        const params = { tool: this.activeTool, period: this.period, date: this.currentDate };
        if (this.period === 'custom' && this.customStart && this.customEnd) {
          params.start = this.customStart;
          params.end = this.customEnd;
        }
        const data = await fetchReport(params, request.signal);
        if (!request.isCurrent()) return;

        if (!data || data.error) {
          this.hasData = false;
          if (data?.error === TEXT.NOT_CONFIGURED) {
            this.showWelcome();
          }
          return;
        }

        this.hideWelcome();
        this.cache[cacheKey] = data;
        this._cacheOrder.push(cacheKey);
        while (this._cacheOrder.length > this._cacheMaxSize) {
          const old = this._cacheOrder.shift();
          delete this.cache[old];
        }
        this.lastReportData = data;
        this.renderData(data);
      } catch (err) {
        if (err.name === 'AbortError') return;
        this.error = err.message;
        showToast('加载失败: ' + err.message);
      } finally {
        if (request.isCurrent()) this.loading = false;
      }
    },

    showWelcome() {
      const wp = document.getElementById(ID.WELCOME_PAGE);
      if (wp) wp.style.display = 'flex';
    },

    hideWelcome() {
      const wp = document.getElementById(ID.WELCOME_PAGE);
      if (wp) wp.style.display = 'none';
    },

    /* ── render data ── */
    renderData(data) {
      const { usageStats, gitStats, start, end, prevStats, trendData, costBreakdown } = data;
      this._lastUsageStats = usageStats;
      this.hasData = usageStats.requestCount > 0;
      if (!this.hasData) {
        this.kpiData = [
          { label: '活跃天数', sub: 'ACTIVE DAYS', value: '-', unit: '/ ' + (this.period === 'daily' ? '1' : this.period === 'weekly' ? '7' : '31'), delta: '', trend: 'flat' },
          { label: '覆盖项目', sub: 'PROJECTS', value: '0', unit: '个', delta: '', trend: 'flat' },
          { label: '高峰天数', sub: 'PEAK DAYS', value: '-', unit: '天', delta: '', trend: 'flat' },
          { label: 'Token 消耗 · 含缓存', sub: 'TOKENS · INC. CACHE', value: '0.00', unit: 'M', delta: '', trend: 'flat' },
          { label: '估算成本', sub: 'EST. COST USD', value: '$0.00', unit: '', delta: '', trend: 'flat' },
        ];
        destroyAllCharts(['workTypeChart', 'modelChart', 'projectChart', 'toolChart', 'timelineChart', 'commitTypeChart', 'cacheChart']);
        return;
      }

      /* KPI strip */
      const days = Object.keys(usageStats.dailyStats || {}).length || 1;
      const totalMin = Math.round((usageStats.requestCount || 0) * 2.4);
      const peakDay = Object.entries(usageStats.dailyStats || {}).sort((a, b) => (b[1].requests || 0) - (a[1].requests || 0))[0];
      const tokensM = (usageStats.totalTokens / 1_000_000).toFixed(2);
      const cost = usageStats.estimatedCost || 0;
      const prevCost = prevStats?.estimatedCost || 0;
      const costDelta = prevCost > 0 ? ((cost - prevCost) / prevCost * 100).toFixed(1) : 0;
      const costTrend = cost > prevCost ? 'up' : cost < prevCost ? 'down' : 'flat';

      this.kpiData = [
        { label: '活跃天数', sub: 'ACTIVE DAYS', value: String(days), unit: '/ ' + (this.period === 'daily' ? '1' : this.period === 'weekly' ? '7' : '31'), delta: '', trend: 'flat' },
        { label: '覆盖项目', sub: 'PROJECTS', value: String(Object.keys(usageStats.projects || {}).length), unit: '个', delta: '', trend: 'flat' },
        { label: '高峰天数', sub: 'PEAK DAYS', value: peakDay ? peakDay[0].slice(5) : '-', unit: '天', delta: '', trend: 'flat' },
        { label: 'Token 消耗 · 含缓存', sub: 'TOKENS · INC. CACHE', value: tokensM, unit: 'M', delta: '', trend: 'flat' },
        { label: '估算成本', sub: 'EST. COST USD', value: '$' + cost.toFixed(2), unit: '', delta: (costDelta > 0 ? '+' : '') + costDelta + '%', trend: costTrend },
      ];

      /* AI contribution */
      this.renderAIContribution(gitStats, usageStats);

      /* Edit types (commit types) */
      const typeEntries = gitStats?.commitTypes ? Object.entries(gitStats.commitTypes).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]) : [];
      const maxType = Math.max(...typeEntries.map(([, v]) => v), 1);
      const inkSteps = ['var(--rust)', 'var(--ink-82)', 'var(--ink-62)', 'var(--ink-46)', 'var(--ink-32)', 'var(--ink-22)'];
      this.editTypeData = typeEntries.map(([name, value], idx) => ({
        name, value, pct: Math.round((value / maxType) * 100),
        color: inkSteps[Math.min(idx, inkSteps.length - 1)],
      }));

      /* Top files */
      const hotspots = gitStats?.fileHotspots || [];
      this.topFilesData = hotspots.slice(0, 10).map(h => ({ path: h.path, commits: h.touches, plus: h.added, minus: h.deleted }));
      const totalAdded = hotspots.reduce((s, h) => s + (h.added || 0), 0);
      const totalDeleted = hotspots.reduce((s, h) => s + (h.deleted || 0), 0);
      this.topFilesMeta = `+${fmt(totalAdded)} / −${fmt(totalDeleted)}`;

      /* Work type (scenarios) */
      const scenarioEntries = Object.entries(usageStats.scenarios || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
      const totalScenario = scenarioEntries.reduce((s, [, v]) => s + v, 0) || 1;
      this.workTypeData = scenarioEntries.map(([name, value], i) => ({
        name, value: Math.round((value / totalScenario) * 100),
        color: SCENARIO_COLORS[name] || '#888',
        hidden: false,
      }));

      /* Models */
      const modelEntries = Object.entries(usageStats.models || {}).sort((a, b) => b[1].count - a[1].count);
      const maxModel = Math.max(...modelEntries.map(([, v]) => v.count), 1);
      const totalModelReq = modelEntries.reduce((s, [, v]) => s + v.count, 0) || 1;
      this.modelData = modelEntries.map(([name, d]) => ({
        name, pct: Math.round((d.count / totalModelReq) * 100),
        barPct: Math.round((d.count / maxModel) * 100),
      }));
      this.topModelName = modelEntries[0]?.[0] || '-';
      this.activeModels = `${modelEntries.length} / 12`;

      /* Cache */
      const cacheRead = usageStats.cacheRead || 0;
      const cacheCreate = usageStats.cacheCreate || 0;
      const inputTok = usageStats.inputTokens || 1;
      const cacheTotal = cacheRead + cacheCreate + inputTok;
      this.cacheHitRate = cacheTotal > 0 ? Math.round((cacheRead / cacheTotal) * 100) : 0;
      this.cacheDelta = cacheRead > 0 ? '+17pp' : '';
      this.cacheData = [
        { label: '命中', en: 'HIT', value: this.cacheHitRate, color: 'var(--forest)' },
        { label: '未命中', en: 'MISS', value: cacheTotal > 0 ? Math.round((inputTok / cacheTotal) * 100) : 0, color: 'var(--ochre)' },
        { label: '未启用', en: 'OFF', value: cacheTotal > 0 ? Math.max(0, 100 - this.cacheHitRate - Math.round((inputTok / cacheTotal) * 100)) : 0, color: 'var(--clay)' },
      ];
      const saving = costBreakdown?.cacheSaving || 0;
      this.cacheSavingText = saving > 0 ? `本月缓存命中节省 <span class="font-mono" style="color:var(--forest)">$${saving.toFixed(2)}</span> ≈ 潜在成本降低 ${((saving / Math.max(cost + saving, 1)) * 100).toFixed(1)}%` : '';

      /* Timeline */
      this.renderTimeline(trendData, usageStats);

      /* Projects */
      const projEntries = Object.entries(usageStats.projects || {}).filter(([, d]) => d.requests > 0).sort((a, b) => b[1].requests - a[1].requests).slice(0, 8);
      this.projectData = projEntries.map(([name, d]) => ({ name: name.length > 20 ? '...' + name.slice(-17) : name, value: d.requests }));

      /* Tool rank */
      this._computeToolRank();

      /* Tool rail tokens — only refresh sidebar when viewing all tools */
      if (this.activeTool === 'all') {
        this.computeToolTokens(usageStats, data.toolBreakdown);
      }

      /* Git insights (existing chart + table) */
      if (gitStats && (gitStats.commits > 0 || gitStats.filesChanged > 0)) {
        renderGitInsights(gitStats, this.activeTool);
      }

      /* Report view data pre-compute */
      this.computeReportData(data);

      /* Project list for report view */
      this.reportProjects = Object.keys(data.projectDetails || {}).sort();

      /* Charts (Chart.js) */
      this.$nextTick(() => this.renderCharts(data));
    },

    toggleWorkType(idx) {
      const item = this.workTypeData[idx];
      if (!item) return;
      item.hidden = !item.hidden;
      const chart = getChart('workTypeChart');
      if (chart) {
        chart.toggleDataVisibility(idx);
        chart.update();
      }
    },

    _animatePct(target) {
      if (this._aiPctAnim) cancelAnimationFrame(this._aiPctAnim);
      const start = this.aiLinePctDisplay || 0;
      const duration = 800;
      const t0 = performance.now();
      const tick = (now) => {
        const elapsed = now - t0;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        this.aiLinePctDisplay = Math.round(start + (target - start) * eased);
        if (progress < 1) this._aiPctAnim = requestAnimationFrame(tick);
      };
      this._aiPctAnim = requestAnimationFrame(tick);
    },

    renderAIContribution(gitStats, usageStats) {
      const ai = gitStats?.aiContribution;
      if (!ai || !gitStats || gitStats.commits <= 0) {
        this.aiLinePct = 0;
        this.aiLinePctDisplay = 0;
        if (this._aiPctAnim) cancelAnimationFrame(this._aiPctAnim);
        this.aiSummaryDesc = '暂无 Git 数据';
        return;
      }
      const totalLines = ai.totalLinesChanged || (ai.aiFileLinesAdded + ai.aiFileLinesDeleted + (ai.humanLinesChanged || 0)) || 1;
      const targetPct = Math.round((ai.aiLinesChanged / totalLines) * 100) || Math.round((ai.aiLineRatio || 0) * 100);
      this.aiLinePct = targetPct;
      this._animatePct(targetPct);
      this.aiContributionMeta = `${fmt(ai.aiLinesChanged || 0)} / ${fmt(totalLines)} LINES`;

      if (gitStats.attributionSummary) {
        const s = gitStats.attributionSummary;
        const upperPct = Math.round(((s.confirmedAILines + s.probableAILines + s.possibleAILines) / (s.totalLinesChanged || 1)) * 100);
        const weightedPct = Math.round((ai.weightedAILineRatio || 0) * 100);
        let desc = '代码变更有 AI 参与';
        if (ai.possibleAICommits > 0) {
          desc += `，可能 AI 影响 <strong>${ai.possibleAICommits}</strong> 提交`;
        }
        if (weightedPct > targetPct) {
          desc += `，加权影响力 <strong>${weightedPct}%</strong>`;
        }
        if (s.mergeCommits > 0) {
          desc += `，已排除 <strong>${s.mergeCommits}</strong> 个合并提交`;
        }
        this.aiSummaryDesc = desc;
        this.confirmedPct = Math.round((s.confirmedAILines / (s.totalLinesChanged || 1)) * 100);
        this.inferredPct = Math.round((s.probableAILines / (s.totalLinesChanged || 1)) * 100);
        this.unattribPct = Math.max(0, 100 - this.confirmedPct - this.inferredPct);
        this.attributionPct = `${this.confirmedPct}% / ${upperPct}%`;
      } else {
        this.aiSummaryDesc = '代码变更有 AI 参与';
        this.confirmedPct = this.aiLinePct;
        this.inferredPct = 0;
        this.unattribPct = 100 - this.aiLinePct;
        this.attributionPct = `${this.aiLinePct}% / 100%`;
      }

      const commitPct = Math.round((ai.aiCommits / gitStats.commits) * 100);
      this.gitOutputCells = [
        { l: '提交', en: 'COMMITS', v: String(gitStats.commits), c: '' },
        { l: '变更文件', en: 'FILES', v: String(gitStats.filesChanged), c: '' },
        { l: '新增', en: '+ ADDED', v: '+' + fmt(gitStats.linesAdded), c: 'var(--forest)' },
        { l: '删除', en: '− REMOVED', v: '−' + fmt(gitStats.linesDeleted), c: 'var(--dest)' },
      ];
      this.attributionCells = [
        { l: 'AI 改写', en: 'REWRITE', v: this.aiLinePct + '%', c: '' },
        { l: 'AI 提交', en: 'COMMITS', v: `${ai.aiCommits}/${gitStats.commits}`, c: 'var(--forest)' },
        { l: '可能上限', en: 'MAX', v: (this.confirmedPct + this.inferredPct) + '%', c: '' },
        { l: '高·中置信', en: 'HI · MID', v: `${ai.highConfidenceCommits}/${ai.mediumConfidenceCommits}`, c: 'var(--ochre)' },
        { l: 'AI 新增', en: '+ AI', v: '+' + fmt(ai.aiFileLinesAdded), c: 'var(--forest)' },
        { l: 'AI 删除', en: '− AI', v: '−' + fmt(ai.aiFileLinesDeleted), c: 'var(--dest)' },
      ];

      /* Source breakdown from real toolBreakdown data */
      const toolTokMap = {};
      const toolColors = this.toolColors;
      const toolDisplayNames = (n) => toolDisplayName(n);
      if (usageStats.toolBreakdown) {
        for (const [k, v] of Object.entries(usageStats.toolBreakdown)) {
          toolTokMap[k] = (v.inputTokens || 0) + (v.outputTokens || 0);
        }
      }
      const entries = Object.entries(toolTokMap).filter(([, v]) => v > 0);
      const totalToolTok = entries.reduce((s, [, v]) => s + v, 0) || 1;
      const sorted = entries.sort((a, b) => b[1] - a[1]);
      let pctSum = 0;
      this.sourceBreakdown = sorted.map(([name, tok], i) => {
        const isLast = i === sorted.length - 1;
        const pct = isLast ? Math.max(0, 100 - pctSum) : Math.round((tok / totalToolTok) * 100);
        pctSum += pct;
        return { name: toolDisplayNames(name) || name, pct, tokens: fmtShort(tok), color: toolColors[name] || 'var(--foreground)' };
      });

      /* Line-level blame evidence */
      const blameEv = renderLineBlameEvidence(gitStats?.commitList);
      if (blameEv) {
        this.lineBlameEvidence = blameEv;
        this.lineBlamePrecision = `行级归因: ${blameEv.aiLines}/${blameEv.totalLines} 行 (${blameEv.precision}%) · ${blameEv.commitCount} 提交`;
      } else {
        this.lineBlameEvidence = null;
        this.lineBlamePrecision = '';
      }
    },

    renderTimeline(trendData, usageStats) {
      const dailyStats = trendData?.dailyStats || {};
      const dates = Object.keys(dailyStats).sort();
      if (dates.length === 0) {
        this.timelineMeta = [
          { l: 'PEAK DAY', v: '-', s: '-' },
          { l: 'AVG / DAY', v: '-', s: 'sessions' },
          { l: 'LONGEST STREAK', v: '-', s: 'consecutive days' },
          { l: 'IDLE DAYS', v: '-', s: 'no activity' },
        ];
        return;
      }
      const sessionsArr = dates.map(d => dailyStats[d].requests || 0);
      const tokensArr = dates.map(d => ((dailyStats[d].inputTokens || 0) + (dailyStats[d].outputTokens || 0)) / 1_000_000);
      const maxSess = Math.max(...sessionsArr);
      const maxIdx = sessionsArr.indexOf(maxSess);
      const avgSess = (sessionsArr.reduce((s, v) => s + v, 0) / sessionsArr.length).toFixed(1);
      this.timelineMeta = [
        { l: 'PEAK DAY', v: dates[maxIdx]?.slice(5).replace('-', '.') || '-', s: maxSess + ' sessions' },
        { l: 'AVG / DAY', v: avgSess, s: 'sessions' },
        { l: 'LONGEST STREAK', v: '-', s: 'consecutive days' },
        { l: 'IDLE DAYS', v: '-', s: 'no activity' },
      ];
    },

    computeToolTokens(usageStats, toolBreakdown) {
      if (!toolBreakdown || Object.keys(toolBreakdown).length === 0) {
        const total = usageStats.totalTokens || 0;
        this.toolTokens = { all: total >= 1_000_000 ? (total / 1_000_000).toFixed(2) + 'M' : fmtShort(total) };
        this.toolSessions = { all: usageStats.sessionCount || 0 };
        return;
      }
      // 从 toolBreakdown 聚合计算 all 值，确保与各工具之和一致
      let allTok = 0;
      let allSess = 0;
      for (const [name, data] of Object.entries(toolBreakdown)) {
        const tok = (data.inputTokens || 0) + (data.outputTokens || 0) + (data.cacheRead || 0) + (data.cacheCreate || 0);
        allTok += tok;
        const sess = data.sessionCount || data.sessions || 0;
        allSess += sess;
        this.toolTokens[name] = tok >= 1_000_000 ? (tok / 1_000_000).toFixed(2) + 'M' : fmtShort(tok);
        this.toolSessions[name] = sess;
      }
      this.toolTokens.all = allTok >= 1_000_000 ? (allTok / 1_000_000).toFixed(2) + 'M' : fmtShort(allTok);
      this.toolSessions.all = allSess;
    },

    computeReportData(data) {
      const { usageStats, gitStats, start, end, prevStats } = data;
      const cost = usageStats.estimatedCost || 0;
      const ai = gitStats?.aiContribution;
      const aiPct = ai ? Math.round((ai.aiLinesChanged / (ai.totalLinesChanged || 1)) * 100) : 0;
      const weightedPct = ai ? Math.round((ai.weightedAILineRatio || 0) * 100) : 0;
      const days = Object.keys(usageStats.dailyStats || {}).length || 1;
      let aiSubText = `${fmt(ai?.aiLinesChanged || 0)} 行严格可认定`;
      if (ai?.possibleAICommits > 0) {
        aiSubText += `，${ai.possibleAICommits} 提交可能 AI 参与`;
      }
      this.reportKpis = [
        { l: 'TOKENS', v: (usageStats.totalTokens / 1_000_000).toFixed(2) + 'M', s: `估算成本 $${cost.toFixed(2)}`, accent: false },
        { l: 'COMMITS', v: String(gitStats?.commits || 0), s: `+${fmt(gitStats?.linesAdded || 0)} / −${fmt(gitStats?.linesDeleted || 0)} 行`, accent: false },
        { l: 'AI CONTRIBUTION', v: aiPct + '%', s: aiSubText, accent: true },
        { l: 'ACTIVE DAYS', v: days + ' / ' + (this.period === 'weekly' ? '7' : '31'), s: '连续 - 天最长', accent: false },
      ];
      this.reportSubTitle = `生成 ${start}${end !== start ? ' ~ ' + end : ''} · 来源 ${this.availableTools.length + 1} 个工具`;
      let summaryText = `本${this.periodMeta.cn}跨 ${this.availableTools.length + 1} 个 AI 编程工具汇总 <span class="font-mono" style="background:var(--ink-12);padding:2px 6px;border-radius:4px;">${days}</span> 个活跃工作日，消耗 <span class="font-mono" style="background:var(--ink-12);padding:2px 6px;border-radius:4px;">${(usageStats.totalTokens / 1_000_000).toFixed(2)}M</span> tokens，估算成本 <span class="font-mono" style="background:var(--ink-12);padding:2px 6px;border-radius:4px;">$${cost.toFixed(2)}</span>。AI 贡献率 <span class="font-mono" style="background:var(--ink-12);padding:2px 6px;border-radius:4px;color:var(--rust)">${aiPct}%</span>`;
      if (weightedPct > aiPct) {
        summaryText += `，加权 AI 影响力 ${weightedPct}%`;
      }
      summaryText += '。';
      this.reportSummary = summaryText;
      this.reportHighlights = [
        { l: 'AI 主导编辑占比', v: aiPct + '%' },
        { l: '本月新增提交', v: String(gitStats?.commits || 0) },
        { l: '节省推理成本', v: '$' + (data.costBreakdown?.cacheSaving || 0).toFixed(2), c: 'var(--forest)' },
        { l: 'Cache 命中率提升', v: '+17pp', c: 'var(--forest)' },
        { l: '活跃模型数', v: `${Object.keys(usageStats.models || {}).length} / 12` },
        { l: '工作仓库数', v: String(Object.keys(usageStats.projects || {}).length) },
      ];
    },

    renderCharts(data) {
      const { usageStats, gitStats, trendData, costBreakdown } = data;
      if (!usageStats || usageStats.requestCount <= 0) {
        destroyAllCharts(['workTypeChart', 'modelChart', 'projectChart', 'toolChart', 'timelineChart', 'commitTypeChart']);
        return;
      }

      /* Work Type Pie */
      const scenarioEntries = Object.entries(usageStats.scenarios || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
      renderWorkTypePie('workTypeChart', scenarioEntries);

      /* Model Bars */
      const modelEntries = Object.entries(usageStats.models || {}).sort((a, b) => b[1].count - a[1].count);
      renderModelBars('modelBarsContainer', modelEntries);

      /* Project Bars */
      const projEntries = Object.entries(usageStats.projects || {}).filter(([, d]) => d.requests > 0).sort((a, b) => b[1].requests - a[1].requests).slice(0, 8);
      renderProjectBars('projectChart', projEntries);

      /* Timeline Area */
      if (trendData && Object.keys(trendData.dailyStats || {}).length > 0) {
        renderTimelineArea('timelineChart', trendData);
      } else {
        destroyChart('timelineChart');
      }

      /* Cache is rendered via pure HTML/CSS bars in the new design */
    },

    /* ── view switching ── */
    openReport() {
      this.view = 'report';
      this.saveStateToHash();
      this.loadReportContent();
    },

    showLedger() {
      this.view = 'ledger';
      this.saveStateToHash();
    },

    async loadReportContent() {
      try {
        if (!['detailed', 'brief'].includes(this.reportLevel)) this.reportLevel = 'detailed';
        const params = { tool: this.activeTool, period: this.period, date: this.currentDate, format: 'work', platform: this.reportPlatform, level: this.reportLevel };
        if (this.period === 'custom' && this.customStart && this.customEnd) {
          params.start = this.customStart;
          params.end = this.customEnd;
        }
        if (this.reportProject) {
          params.project = this.reportProject;
        }
        const qs = new URLSearchParams(params).toString();
        const res = await fetch(`/api/report?${qs}`);
        if (!res.ok) return;
        const markdown = await res.text();
        setWorkReportState({ markdown, platform: this.reportPlatform, level: this.reportLevel });
        this.reportHtml = this.renderMarkdownToReportHtml(markdown);
        await this.loadSmartReportRecord();
      } catch (e) { console.warn('loadReportContent failed:', e); }
    },

    setReportLevel(level) {
      this.reportLevel = ['detailed', 'brief'].includes(level) ? level : 'detailed';
      this.resetSmartReportDisplay();
      this.loadReportContent();
    },

    setReportPlatform(platform) {
      this.reportPlatform = platform;
      this.resetSmartReportDisplay();
      this.loadReportContent();
    },

    setReportProject(project) {
      this.reportProject = project;
      this.resetSmartReportDisplay();
      this.loadReportContent();
    },

    setSmartReportAgent(agent) {
      this.smartReportAgent = agent;
      localStorage.setItem(STORAGE.SMART_REPORT_AGENT, agent);
      this.resetSmartReportDisplay();
      this.loadSmartReportRecord();
    },

    resetSmartReportDisplay() {
      this.stopSmartReportPolling();
      this.stopSmartReportElapsedTimer();
      this.stopSmartReportCompletionTimer();
      this.smartReportError = '';
      this.smartReportMarkdown = '';
      this.smartReportHtml = '';
      this.smartReportRecord = null;
      this.smartReportRecordMeta = '';
      this.smartReportNeedsUpdate = false;
      this.smartReportUpdateMessage = '';
      this.smartReportJob = null;
      this.smartReportLoading = false;
      this.smartReportStatusMessage = '';
      this.smartReportStartedAt = '';
      this.smartReportNow = Date.now();
      this.smartReportProgress = 0;
      this.reportContentMode = 'source';
    },

    smartReportParams() {
      const params = {
        agent: this.smartReportAgent,
        tool: this.activeTool,
        period: this.period,
        date: this.currentDate,
        level: this.reportLevel,
        style: this.smartReportStyle,
        platform: this.reportPlatform,
        project: this.reportProject,
      };
      if (this.period === 'custom' && this.customStart && this.customEnd) {
        params.start = this.customStart;
        params.end = this.customEnd;
      }
      return params;
    },

    setReportContentMode(mode) {
      this.reportContentMode = mode === 'smart' ? 'smart' : 'source';
    },

    openSmartReportStyleModal() {
      if (!this.smartReportAgent || this.smartReportLoading) return;
      this.smartReportStyleModalOpen = true;
    },

    closeSmartReportStyleModal() {
      this.smartReportStyleModalOpen = false;
    },

    async confirmSmartReportStyle(style) {
      this.smartReportStyle = style === 'workhorse' ? 'workhorse' : 'default';
      localStorage.setItem(STORAGE.SMART_REPORT_STYLE, this.smartReportStyle);
      this.closeSmartReportStyleModal();
      this.resetSmartReportDisplay();
      await this.generateSmartReportContent();
    },

    applySmartReportRecord(record, meta = {}) {
      if (record?.style) this.smartReportStyle = record.style;
      this.smartReportRecord = record || null;
      this.smartReportMarkdown = record?.markdown || '';
      this.smartReportHtml = this.renderMarkdownToReportHtml(this.smartReportMarkdown);
      this.smartReportRecordMeta = record ? this.formatSmartReportRecordMeta(record) : '';
      this.smartReportNeedsUpdate = !!record && !!meta.needsUpdate;
      this.smartReportUpdateMessage = this.smartReportNeedsUpdate ? '当前统计数据或原始报告已变化，建议重新生成智能报告。' : '';
      if (!record && this.reportContentMode === 'smart') this.reportContentMode = 'source';
    },

    applySmartReportJob(job) {
      this.smartReportJob = job || null;
      if (!job) {
        this.smartReportLoading = false;
        this.smartReportStatusMessage = '';
        this.smartReportStartedAt = '';
        this.smartReportProgress = 0;
        this.stopSmartReportPolling();
        this.stopSmartReportElapsedTimer();
        this.stopSmartReportCompletionTimer();
        return;
      }
      if (job.status === 'running') {
        this.stopSmartReportCompletionTimer();
        this.smartReportLoading = true;
        this.smartReportError = '';
        this.smartReportStartedAt = job.startedAt || this.smartReportStartedAt || new Date().toISOString();
        if (this.smartReportProgress <= 0) this.smartReportProgress = 4;
        this.updateSmartReportProgress();
        this.startSmartReportElapsedTimer();
        this.smartReportStatusMessage = '后台生成中，页面可刷新，回来后会继续显示进度。';
        this.scheduleSmartReportPolling();
        return;
      }
      if (job.status === 'completed') {
        // 仅在用户本会话主动触发生成（loading=true）时播放"生成完成"动画；
        // 被动加载（init / 切换 agent / 切换日期）发现已完成的残留 job 时静默应用，避免"生成中"一闪而过
        if (this.smartReportLoading) {
          this.finishSmartReportProgress();
        } else {
          this.smartReportLoading = false;
          this.smartReportStatusMessage = '';
          this.smartReportStartedAt = '';
          this.smartReportProgress = 0;
          this.stopSmartReportPolling();
          this.stopSmartReportElapsedTimer();
          this.stopSmartReportCompletionTimer();
        }
        return;
      }
      this.smartReportLoading = false;
      this.smartReportStatusMessage = '';
      this.smartReportStartedAt = '';
      this.smartReportProgress = 0;
      this.stopSmartReportPolling();
      this.stopSmartReportElapsedTimer();
      this.stopSmartReportCompletionTimer();
      if (job.status === 'failed') {
        // 仅主动生成（含轮询发现失败）才提示；被动加载撞残留 failed job 时静默
        if (this.smartReportLoading) {
          this.smartReportError = job.error || '智能报告生成失败';
          showToast(this.smartReportError);
        }
      }
    },

    startSmartReportElapsedTimer() {
      this.smartReportNow = Date.now();
      if (this.smartReportElapsedTimer) return;
      this.smartReportElapsedTimer = setInterval(() => {
        this.smartReportNow = Date.now();
        this.updateSmartReportProgress();
      }, 1000);
    },

    stopSmartReportElapsedTimer() {
      if (this.smartReportElapsedTimer) {
        clearInterval(this.smartReportElapsedTimer);
        this.smartReportElapsedTimer = null;
      }
    },

    stopSmartReportCompletionTimer() {
      if (this.smartReportCompletionTimer) {
        clearTimeout(this.smartReportCompletionTimer);
        this.smartReportCompletionTimer = null;
      }
    },

    updateSmartReportProgress() {
      if (!this.smartReportLoading || this.smartReportProgress >= 100) return;
      const startedAt = Date.parse(this.smartReportStartedAt || this.smartReportJob?.startedAt || '');
      if (!Number.isFinite(startedAt)) {
        this.smartReportProgress = Math.max(this.smartReportProgress, 4);
        return;
      }
      const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      const eased = 1 - Math.exp(-seconds / 180);
      const target = Math.min(95, Math.round(6 + eased * 89));
      this.smartReportProgress = Math.max(this.smartReportProgress, target);
    },

    finishSmartReportProgress() {
      this.stopSmartReportPolling();
      this.stopSmartReportElapsedTimer();
      this.stopSmartReportCompletionTimer();
      this.smartReportLoading = true;
      this.smartReportError = '';
      this.smartReportProgress = 100;
      this.smartReportStatusMessage = '生成完成，正在展示结果...';
      this.smartReportCompletionTimer = setTimeout(() => {
        this.smartReportCompletionTimer = null;
        this.smartReportLoading = false;
        this.smartReportStatusMessage = '';
        this.smartReportStartedAt = '';
      }, 1200);
    },

    get smartReportElapsedLabel() {
      if (!this.smartReportLoading) return '';
      if (this.smartReportProgress >= 100) return '100%';
      const startedAt = Date.parse(this.smartReportStartedAt || this.smartReportJob?.startedAt || '');
      if (!Number.isFinite(startedAt)) return '正在启动后台任务';
      const seconds = Math.max(0, Math.floor((this.smartReportNow - startedAt) / 1000));
      if (seconds < 60) return `已等待 ${seconds} 秒`;
      const minutes = Math.floor(seconds / 60);
      const rest = seconds % 60;
      return `已等待 ${minutes} 分 ${String(rest).padStart(2, '0')} 秒`;
    },

    // CLI 未安装的智能体 displayName 列表，供合并提示点名（左栏数据驱动，与此无关）
    get missingSmartReportAgents() {
      return this.smartReportTools
        .filter(t => !t.detected)
        .map(t => `${t.displayName} CLI`);
    },

    scheduleSmartReportPolling() {
      this.stopSmartReportPolling();
      this.smartReportPollTimer = setTimeout(() => {
        this.smartReportPollTimer = null;
        this.loadSmartReportRecord();
      }, 2500);
    },

    stopSmartReportPolling() {
      if (this.smartReportPollTimer) {
        clearTimeout(this.smartReportPollTimer);
        this.smartReportPollTimer = null;
      }
    },

    formatSmartReportRecordMeta(record) {
      const updatedAt = record?.updatedAt ? new Date(record.updatedAt) : null;
      const time = updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt.toLocaleString('zh-CN', { hour12: false }) : '';
      const count = record?.generatedCount ? `第 ${record.generatedCount} 次生成` : '已生成';
      const styleLabel = record?.style === 'workhorse' ? '管理汇报' : '默认风格';
      return time ? `${styleLabel} · ${count} · ${time}` : `${styleLabel} · ${count}`;
    },

    async loadSmartReportRecord() {
      if (!this.smartReportAgent) {
        this.resetSmartReportDisplay();
        return;
      }
      try {
        const data = await fetchSmartReportRecord(this.smartReportParams());
        this.smartReportError = '';
        this.applySmartReportRecord(data.record || null, { needsUpdate: data.needsUpdate });
        this.applySmartReportJob(data.job || null);
        if (data.job?.status === 'completed' && data.record) this.reportContentMode = 'smart';
      } catch (err) {
        console.warn('loadSmartReportRecord failed:', err);
        this.applySmartReportRecord(null);
        this.applySmartReportJob(null);
      }
    },

    async generateSmartReportContent() {
      if (!this.smartReportAgent || this.smartReportLoading) return;
      this.smartReportLoading = true;
      this.smartReportError = '';
      this.smartReportStartedAt = new Date().toISOString();
      this.smartReportProgress = 4;
      this.smartReportStatusMessage = '正在提交后台生成任务...';
      this.startSmartReportElapsedTimer();
      try {
        const payload = this.smartReportParams();
        const data = await generateSmartReport(payload);
        this.applySmartReportRecord(data.record || (data.markdown ? { ...payload, markdown: data.markdown, generatedCount: 1, updatedAt: new Date().toISOString() } : null), { needsUpdate: false });
        this.applySmartReportJob(data.job || null);
        if (data.record && !data.job) this.reportContentMode = 'smart';
      } catch (err) {
        this.smartReportError = err.message || '智能报告生成失败';
        this.stopSmartReportElapsedTimer();
        showToast(this.smartReportError);
      } finally {
        if (this.smartReportJob?.status !== 'running') this.smartReportLoading = false;
      }
    },

    async copySmartReport() {
      if (!this.smartReportMarkdown) return;
      await navigator.clipboard.writeText(this.smartReportMarkdown);
      this.smartReportCopied = true;
      setTimeout(() => this.smartReportCopied = false, 1400);
    },

    downloadSmartReport() {
      if (!this.smartReportMarkdown) return;
      const blob = new Blob([this.smartReportMarkdown], { type: 'text/markdown;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `smart-report-${this.smartReportStyle}-${this.period}-${this.currentDate}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
    },

    async copyReport() {
      await copyWorkReport();
      this.copied = true;
      setTimeout(() => this.copied = false, 1400);
    },

    downloadReport() {
      downloadMarkdown(this.period, this.currentDate);
    },

    openExportModal(action) {
      // 无智能报告 → 直接执行原报告，避免单选项空弹窗
      if (!this.smartReportMarkdown) {
        return action === 'copy' ? this.copyReport() : this.downloadReport();
      }
      this.exportModalAction = action;
      this.exportModalTarget = 'source';
      this.exportModalOpen = true;
    },

    closeExportModal() {
      this.exportModalOpen = false;
    },

    confirmExport() {
      const action = this.exportModalAction;
      const target = this.exportModalTarget;
      this.closeExportModal();
      if (action === 'copy') {
        return target === 'smart' ? this.copySmartReport() : this.copyReport();
      }
      return target === 'smart' ? this.downloadSmartReport() : this.downloadReport();
    },

    renderMarkdownToReportHtml(md) {
      const lines = md.split('\n');
      const out = [];
      let inTable = false;
      // Security: esc() MUST run first to neutralize HTML, then regex adds safe tags on escaped content
      const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('|')) {
          if (!inTable) { inTable = true; out.push('<table class="md-table">'); }
          const cells = line.split('|').slice(1, -1).map(c => c.trim());
          if (cells.every(c => /^[-:]+$/.test(c.replace(/\|/g, '')))) continue;
          const tag = inTable && out[out.length - 1] === '<table class="md-table">' ? 'th' : 'td';
          out.push('<tr>' + cells.map(c => `<${tag}>${inline(c)}</${tag}>`).join('') + '</tr>');
          continue;
        } else if (inTable) { inTable = false; out.push('</table>'); }
        if (line.startsWith('# ')) { out.push(`<h1 class="md-h1">${inline(line.slice(2))}</h1>`); continue; }
        if (line.startsWith('## ')) { out.push(`<h2 class="md-h2">${inline(line.slice(3))}</h2>`); continue; }
        if (line.startsWith('### ')) { out.push(`<h3 class="md-h3">${inline(line.slice(4))}</h3>`); continue; }
        if (line.startsWith('- ') || line.startsWith('• ')) { out.push(`<li class="md-li">${inline(line.slice(2))}</li>`); continue; }
        if (/^[━─]+/.test(line.trim()) && line.trim().length >= 5) { out.push(`<div class="md-divider">${inline(line.trim())}</div>`); continue; }
        if (line.trim() === '') { out.push(''); continue; }
        out.push(`<p class="md-p">${inline(line)}</p>`);
      }
      if (inTable) out.push('</table>');
      let html = out.join('\n');
      html = html.replace(/(<li[^>]*>[<\s\S]*?<\/li>\n?)+/g, m => '<ul class="md-ul">\n' + m + '</ul>\n');
      return html;
    },

    /* ── exports ── */
    exportCSV() { if (this.lastReportData) exportCSV(this.lastReportData, this.period); },
    exportJSON() { if (this.lastReportData) exportJSON(this.lastReportData, this.period); },
    exportHTML() { if (this.lastReportData) exportHTML(this.lastReportData, this.period); },
    printReport() { if (this.lastReportData) printReport(this.lastReportData, this.period); },
  };
}

/* ── Register Alpine component ── */
document.addEventListener('alpine:init', () => {
  Alpine.data('app', appState);
});

/* Dynamic load Alpine after listener is ready */
const alpineScript = document.createElement('script');
alpineScript.src = '/vendor/alpine.min.js';
document.head.appendChild(alpineScript);

/* ── Utilities ── */
function showToast(msg) {
  const toast = document.getElementById(ID.TOAST);
  if (!toast) return;
  toast.textContent = msg;
  toast.style.display = 'block';
  toast.style.opacity = '1';
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => { toast.style.display = 'none'; }, 300); }, 3000);
}

/* ── Settings Modal ── */
const SCENARIO_LABELS = { coding: '编码', testing: '测试', debugging: '调试', documentation: '文档', review: '审查', planning: '规划', refactoring: '重构' };

function renderKeywordsEditor(keywords) {
  const container = document.getElementById('cfgKeywordsEditor');
  if (!container) return;
  container.innerHTML = '';
  for (const [key, label] of Object.entries(SCENARIO_LABELS)) {
    const words = keywords[key] || [];
    const row = document.createElement('div');
    row.className = 'kw-row';
    row.dataset.key = key;

    const lbl = document.createElement('div');
    lbl.className = 'kw-label';
    lbl.textContent = label;

    const tags = document.createElement('div');
    tags.className = 'kw-tags';
    for (const w of words) tags.appendChild(makeKwTag(w));

    const addWrap = document.createElement('div');
    addWrap.className = 'kw-add-row';
    const addBtn = document.createElement('button');
    addBtn.className = 'kw-add-btn';
    addBtn.textContent = '+';
    addBtn.title = '添加关键词';
    addBtn.onclick = () => {
      addWrap.innerHTML = '';
      const inp = document.createElement('input');
      inp.className = 'kw-add-input';
      inp.placeholder = '关键词';
      const ok = document.createElement('button');
      ok.className = 'kw-add-btn';
      ok.textContent = '确定';
      ok.onclick = () => {
        const v = inp.value.trim();
        if (v && !tags.querySelector('[data-word="' + CSS.escape(v) + '"]')) tags.insertBefore(makeKwTag(v), addWrap);
        resetAddBtn();
      };
      inp.onkeydown = (e) => { if (e.key === 'Enter') ok.click(); if (e.key === 'Escape') resetAddBtn(); };
      addWrap.appendChild(inp);
      addWrap.appendChild(ok);
      inp.focus();
    };
    function resetAddBtn() { addWrap.innerHTML = ''; addWrap.appendChild(addBtn); }
    resetAddBtn();

    row.appendChild(lbl);
    row.appendChild(tags);
    row.appendChild(addWrap);
    container.appendChild(row);
  }
}

function makeKwTag(word) {
  const tag = document.createElement('span');
  tag.className = 'kw-tag';
  tag.dataset.word = word;
  tag.textContent = word;
  const x = document.createElement('span');
  x.className = 'kw-tag-remove';
  x.textContent = '×';
  x.onclick = () => tag.remove();
  tag.appendChild(x);
  return tag;
}

function collectKeywordsFromEditor() {
  const result = {};
  const container = document.getElementById('cfgKeywordsEditor');
  if (!container) return result;
  for (const row of container.querySelectorAll('.kw-row')) {
    const key = row.dataset.key;
    const words = Array.from(row.querySelectorAll('.kw-tag')).map(t => t.dataset.word);
    if (words.length > 0) result[key] = words;
  }
  // 清洗校验：先 trim 再去重、过滤空串、截断超长词、过滤控制字符
  for (const [key, words] of Object.entries(result)) {
    result[key] = [...new Set(words.map(w => w.trim()))]
      .filter(w => w.length > 0 && w.length <= 50)
      .filter(w => !/[\x00-\x1f\x7f]/.test(w));
  }
  return result;
}

window.closeSettings = () => {
  const modal = document.getElementById('settingsModal');
  if (modal) modal.style.display = 'none';
};


/* ── Path Tag Editor ── */
const FOLDER_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
const CLOSE_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

function renderPathTags(containerId, paths) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  for (let i = 0; i < paths.length; i++) {
    const tag = document.createElement('div');
    tag.className = 'path-tag';
    tag.innerHTML = `
      <span class="path-tag-icon">${FOLDER_ICON}</span>
      <span class="path-tag-text" title="${esc(paths[i])}">${esc(paths[i])}</span>
      <button class="path-tag-remove" onclick="removePathTag('${containerId}', ${i})" title="删除">${CLOSE_ICON}</button>
    `;
    container.appendChild(tag);
  }
}

function addPathTag(containerId, inputId) {
  const input = document.getElementById(inputId);
  const container = document.getElementById(containerId);
  if (!input || !container) return;
  const raw = input.value.trim();
  if (!raw) return;
  // 支持粘贴多行或多逗号分隔的内容，一次性解析添加
  const paths = raw.split(/[,，\n\r]+/).map(s => s.trim()).filter(Boolean);
  const existing = getPathTags(containerId);
  for (const p of paths) {
    if (!existing.includes(p)) existing.push(p);
  }
  renderPathTags(containerId, existing);
  input.value = '';
  input.focus();
}

function removePathTag(containerId, index) {
  const paths = getPathTags(containerId);
  paths.splice(index, 1);
  renderPathTags(containerId, paths);
}

window.addPathTag = addPathTag;
window.removePathTag = removePathTag;

function getPathTags(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return [];
  return Array.from(container.querySelectorAll('.path-tag-text')).map(el => el.textContent);
}

/* ── Settings: tool dirs / enabled chips / costMode / stepTracking ── */
// 工具目录键 + 展示名 + 默认路径占位（与 lib/parsers/* 的 defaultDir 对齐）
const TOOL_DIR_DEFS = [
  { key: 'codexDir',    name: 'codex',    ph: '~/.codex' },
  { key: 'opencodeDir', name: 'opencode', ph: '~/.local/share/opencode' },
  { key: 'geminiDir',   name: 'gemini',   ph: '~/.gemini' },
  { key: 'qwenDir',     name: 'qwen',     ph: '~/.qwen' },
  { key: 'gooseDir',    name: 'goose',    ph: '~/.config/goose' },
  { key: 'ampDir',      name: 'amp',      ph: '~/.amp' },
  { key: 'hermesDir',   name: 'hermes',   ph: '~/.hermes' },
  { key: 'openclawDir', name: 'openclaw', ph: '~/.openclaw' },
  { key: 'kimiDir',     name: 'kimi',     ph: '~/.kimi' },
  { key: 'codebuffDir', name: 'codebuff', ph: '~/.codebuff' },
  { key: 'droidDir',    name: 'droid',    ph: '~/.droid' },
  { key: 'piDir',       name: 'pi',       ph: '~/.pi' },
  { key: 'kiloDir',     name: 'kilo',     ph: '~/.kilo' },
  { key: 'copilotDir',  name: 'copilot',  ph: '~/.copilot/otel' },
];

function renderToolDirsEditor(cfg) {
  const container = document.getElementById('cfgToolDirsEditor');
  if (!container) return;
  container.innerHTML = '';
  for (const def of TOOL_DIR_DEFS) {
    // meta 来自静态 TOOL_META（受信常量，非用户输入），innerHTML 无注入风险
    const meta = TOOL_META[def.name] || { displayName: def.name, color: 'var(--muted-foreground)' };
    const row = document.createElement('div');
    row.className = 'cfg-dir-row';
    const lbl = document.createElement('label');
    lbl.className = 'cfg-dir-label';
    lbl.innerHTML = `<span class="cfg-tool-dot" style="background:${meta.color}"></span>${meta.displayName}`;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'form-input cfg-dir-input';
    inp.dataset.key = def.key;
    inp.placeholder = def.ph;
    inp.value = cfg[def.key] || '';
    row.appendChild(lbl);
    row.appendChild(inp);
    container.appendChild(row);
  }
}

function collectToolDirs() {
  const out = {};
  for (const inp of document.querySelectorAll('#cfgToolDirsEditor .cfg-dir-input')) {
    out[inp.dataset.key] = inp.value.trim();
  }
  return out;
}

function renderEnabledToolsChips(enabledTools) {
  const container = document.getElementById('cfgEnabledToolsChips');
  if (!container) return;
  container.innerHTML = '';
  const enabled = Array.isArray(enabledTools) ? enabledTools : [];
  // 空数组语义=自动检测全部，UI 上表现为全不选（保存时空数组维持自动）
  for (const def of TOOL_DIR_DEFS) {
    // meta 来自静态 TOOL_META（受信常量），innerHTML 无注入风险
    const meta = TOOL_META[def.name] || { displayName: def.name, color: 'var(--muted-foreground)' };
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'cfg-toggle-chip' + (enabled.includes(def.name) ? ' active' : '');
    chip.dataset.tool = def.name;
    chip.innerHTML = `<span class="cfg-tool-dot" style="background:${meta.color}"></span>${meta.displayName}`;
    chip.onclick = () => chip.classList.toggle('active');
    container.appendChild(chip);
  }
}

function collectEnabledTools() {
  return Array.from(document.querySelectorAll('#cfgEnabledToolsChips .cfg-toggle-chip.active'))
    .map(el => el.dataset.tool);
}

function setCostModeRadio(value) {
  const v = ['auto', 'calculate', 'display'].includes(value) ? value : 'auto';
  const el = document.querySelector(`input[name="cfgCostMode"][value="${v}"]`);
  if (el) el.checked = true;
}
function getCostModeRadio() {
  const el = document.querySelector('input[name="cfgCostMode"]:checked');
  return el ? el.value : 'auto';
}

function fillStepTracking(st) {
  const enabled = document.getElementById('cfgStepEnabled');
  if (enabled) enabled.checked = st && st.enabled !== false;
  const db = document.getElementById('cfgStepDbPath');
  if (db) db.value = st?.dbPath || '';
  const max = document.getElementById('cfgStepMaxSize');
  if (max) max.value = st?.maxFileSize || '';
  const ign = document.getElementById('cfgStepIgnore');
  if (ign) ign.value = Array.isArray(st?.ignorePatterns) ? st.ignorePatterns.join(', ') : '';
}

function collectStepTracking() {
  const ign = (document.getElementById('cfgStepIgnore')?.value || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return {
    enabled: document.getElementById('cfgStepEnabled')?.checked !== false,
    dbPath: document.getElementById('cfgStepDbPath')?.value.trim() || '.ccusage/steps.db',
    maxFileSize: Number(document.getElementById('cfgStepMaxSize')?.value) || 10485760,
    ignorePatterns: ign,
  };
}

function showAttributionPreview(att) {
  const pre = document.getElementById('cfgAttributionPreview');
  if (!pre) return;
  try { pre.textContent = JSON.stringify(att, null, 2); }
  catch { pre.textContent = '(无法序列化)'; }
}

function syncAppearanceRadios() {
  const appEl = document.querySelector('[x-data]');
  const app = appEl?._x_dataStack?.[0];
  const theme = app?.theme || 'dark';
  const style = app?.smartReportStyle || 'default';
  const tEl = document.querySelector(`input[name="cfgTheme"][value="${theme}"]`);
  if (tEl) tEl.checked = true;
  const sEl = document.querySelector(`input[name="cfgReportStyle"][value="${style}"]`);
  if (sEl) sEl.checked = true;
}

// 三个折叠区开关
window.toggleToolDirsSection = () => toggleCfgFold('cfgToolDirsSection', 'cfgToolDirsToggle');
window.toggleStepAdvSection = () => toggleCfgFold('cfgStepAdvSection', 'cfgStepAdvToggle');
window.toggleAttributionSection = () => toggleCfgFold('cfgAttributionSection', 'cfgAttributionToggle');
function toggleCfgFold(sectionId, btnId) {
  const section = document.getElementById(sectionId);
  const btn = document.getElementById(btnId);
  if (!section || !btn) return;
  const isHidden = section.style.display === 'none';
  section.style.display = isHidden ? 'block' : 'none';
  btn.classList.toggle('expanded', isHidden);
}

window.openSettings = async () => {
  // 设置已迁移为独立页面（侧栏 nav），此处仅负责把配置加载进表单
  const hint = document.getElementById('cfgSaveHint');
  if (hint) { hint.textContent = ''; hint.className = ''; }
  try {
    const cfg = await fetchConfig();
    const dirEl = document.getElementById('cfgClaudeDir');
    if (dirEl) dirEl.value = cfg.claudeDir || '';
    renderPathTags('cfgReposTags', cfg.repos || []);
    renderPathTags('cfgExcludeTags', cfg.excludeProjects || []);
    renderKeywordsEditor(cfg.scenarioKeywords || {});
    renderToolDirsEditor(cfg);
    renderEnabledToolsChips(cfg.enabledTools || []);
    setCostModeRadio(cfg.costMode);
    fillStepTracking(cfg.stepTracking);
    showAttributionPreview(cfg.aiAttribution);
    syncAppearanceRadios();
  } catch (err) {
    showToast('加载配置失败: ' + err.message);
  }
};

document.getElementById('welcomeStartBtn')?.addEventListener('click', async () => {
  const claudeDir = document.getElementById('welcomeClaudeDir').value.trim();
  const reposRaw = document.getElementById('welcomeRepos').value.trim();
  const hint = document.getElementById('welcomeHint');
  if (!claudeDir) { hint.textContent = '请输入 Claude 日志目录路径'; hint.style.color = 'var(--dest)'; return; }
  const repos = reposRaw ? reposRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  try {
    hint.textContent = '保存配置中...'; hint.style.color = 'var(--muted-foreground)';
    await saveConfig({ claudeDir, repos });
    hint.textContent = '配置已保存，加载数据中...';
    window.location.reload();
  } catch (err) { hint.textContent = '保存失败: ' + err.message; hint.style.color = 'var(--dest)'; }
});

window.saveSettings = async () => {
  const hint = document.getElementById('cfgSaveHint');
  const scenarioKeywords = collectKeywordsFromEditor();
  const payload = {
    claudeDir: document.getElementById('cfgClaudeDir').value.trim(),
    repos: getPathTags('cfgReposTags'),
    excludeProjects: getPathTags('cfgExcludeTags'),
    scenarioKeywords,
    ...collectToolDirs(),
    enabledTools: collectEnabledTools(),
    costMode: getCostModeRadio(),
    stepTracking: collectStepTracking(),
  };
  try {
    await saveConfig(payload);
    if (hint) { hint.textContent = '配置已保存'; hint.className = 'cfg-save-ok'; }
    setTimeout(() => window.location.reload(), 1200);
  } catch (err) {
    if (hint) { hint.textContent = '保存失败: ' + err.message; hint.className = 'cfg-save-err'; }
  }
};

/* ── Drill-down global handler ── */
window._drillHandler = async (type, key, label) => {
  const modal = document.getElementById(ID.DRILL_MODAL);
  const title = document.getElementById(ID.DRILL_TITLE);
  const body = document.getElementById(ID.DRILL_BODY);
  if (title) title.textContent = label + ' 匹配示例';
  if (body) body.innerHTML = '<div class="drill-empty">加载中...</div>';
  if (modal) modal.style.display = 'flex';
  try {
    const appEl = document.querySelector('[x-data]');
    const app = appEl?._x_dataStack?.[0];
    const period = app?.period || 'daily';
    const date = app?.currentDate || new Date().toISOString().slice(0, 10);
    const rows = await fetchDetails({ period, date, dimension: type, key });
    if (!rows.length) { if (body) body.innerHTML = '<div class="drill-empty">无匹配记录</div>'; return; }
    if (body) body.innerHTML = '<table class="drill-table"><tr><th>用户消息</th><th>时间</th></tr>' + rows.map(r => `<tr><td class="drill-text" title="${esc(r.text)}">${esc(r.text)}</td><td>${esc(r.timestamp?.slice(0, 16)?.replace('T', ' '))}</td></tr>`).join('') + '</table>';
  } catch (e) {
    console.warn('drillHandler failed:', e);
    if (body) body.innerHTML = '<div class="drill-empty">加载失败</div>';
  }
};
