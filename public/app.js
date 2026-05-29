import { COLORS, SCENARIO_COLORS, TEXT, ID, STORAGE } from './config.js';
import { esc, fmt, fmtShort, destroyChart, destroyAllCharts, getChart, setChart, todayISO, fmtDate, aggregateToolsByServer, TOOL_DISPLAY_NAMES, groupMcpByServer } from './utils.js';
import { createLatestRequestGuard, fetchTools, fetchReport, fetchConfig, saveConfig, fetchDetails, fetchSessions, fetchStepStats, fetchHooksStatus, updateHooks } from './api.js';
import { renderWorkTypePie, renderModelBars, renderProjectBars, renderTimelineArea, renderCacheStack } from './charts.js';
import { renderGitInsights, renderLineBlameEvidence } from './git-insights.js';
import { loadWorkReport, copyWorkReport, downloadMarkdown, getWorkReportState, setWorkReportState } from './work-report.js';
import { exportCSV, printReport, exportJSON, exportHTML } from './export.js';

/* ── Alpine App Component ── */
function appState() {
  return {
    /* state */
    view: 'ledger',
    period: 'daily',
    activeTool: 'all',
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
    toolColors: { claude: 'var(--claude)', codex: 'var(--codex)', opencode: 'var(--opencode)' },
    toolSubNames: { claude: 'ANTHROPIC', codex: 'OPENAI', opencode: 'OSS' },

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
    toolRankMode: 'calls', // 'calls' | 'uses'
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
        !this.hooksStatus.opencode?.enabled;
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
          `steps ${this.hooksStatus.stepsReadyCount || 0}/${total}`,
        ];
        return `设置内项目 hooks：${parts.join(' / ')}`;
      }
      const parts = [
        `Claude ${this.hooksStatus.claude?.enabled ? '已开启' : '未开启'}`,
        `Codex ${this.hooksStatus.codex?.enabled ? '已开启' : '未开启'}`,
        `OpenCode ${this.hooksStatus.opencode?.enabled ? '已开启' : '未开启'}`,
        `steps ${this.hooksStatus.stepsInitialized ? '已初始化' : '未初始化'}`,
      ];
      return parts.join(' / ');
    },

    /* ── init ── */
    async init() {
      this.loadStateFromHash();
      if (this.theme === 'dark') document.documentElement.classList.add('dark');
      else document.documentElement.classList.remove('dark');
      this.$watch('view', (value) => {
        if (value === 'ledger' && this.lastReportData) {
          this.$nextTick(() => this.renderCharts(this.lastReportData));
        }
      });
      await this.loadTools();
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
    },

    /* ── theme ── */
    toggleTheme() {
      this.theme = this.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem(STORAGE.THEME, this.theme);
      if (this.theme === 'dark') document.documentElement.classList.add('dark');
      else document.documentElement.classList.remove('dark');
      /* re-render charts to pick up new colors */
      if (this.lastReportData && this.view === 'ledger') this.renderCharts(this.lastReportData);
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
      this.loadCurrentView();
      if (this.view === 'report') this.loadReportContent();
    },

    setToolRankMode(mode) {
      this.toolRankMode = mode;
      this._computeToolRank();
    },

    setToolRankTab(tab) {
      this.toolRankTab = tab;
      this._computeToolRank();
      const container = document.getElementById('toolCallsContainer');
      if (container) container.scrollTop = 0;
    },

    _computeToolRank() {
      const usageStats = this._lastUsageStats || {};
      const mode = this.toolRankMode;
      const tab = this.toolRankTab;

      // 提取数值的辅助函数
      const getValue = (val) => typeof val === 'number' ? val : (val[mode] || 0);
      // 预计算三个 Tab 的总 calls（用于标签展示）
      const sumCalls = (obj) => Object.values(obj || {}).reduce((s, v) => s + (typeof v === 'number' ? v : (v.calls || 0)), 0);
      this.toolRankAllTotal = sumCalls(usageStats.tools);
      this.toolRankSkillTotal = sumCalls(usageStats.skills);
      this.toolRankMcpTotal = sumCalls(usageStats.mcpTools);

      if (tab === 'all') {
        const aggregated = aggregateToolsByServer(usageStats.tools || {}, mode);
        const entries = Object.entries(aggregated).sort((a, b) => b[1] - a[1]);
        const maxValue = Math.max(...entries.map(([, v]) => v), 1);
        this.toolRankData = entries.map(([name, value]) => ({
          name,
          value,
          pct: Math.round((value / maxValue) * 100),
          displayName: TOOL_DISPLAY_NAMES[name] || '',
        }));
        this.toolRankTotalCalls = this.toolRankAllTotal;
      } else if (tab === 'skill') {
        const skills = usageStats.skills || {};
        const entries = Object.entries(skills).sort((a, b) => getValue(b[1]) - getValue(a[1]));
        const maxValue = Math.max(...entries.map(([, v]) => getValue(v)), 1);
        this.toolRankData = entries.map(([name, val]) => {
          const value = getValue(val);
          return { name, value, pct: Math.round((value / maxValue) * 100), displayName: '' };
        });
        this.toolRankTotalCalls = this.toolRankSkillTotal;
      } else if (tab === 'mcp') {
        this.toolRankData = groupMcpByServer(usageStats.mcpTools || {}, mode);
        this.toolRankTotalCalls = this.toolRankMcpTotal;
      }

      this.toolRankTotal = this.toolRankData.length;

      // 为每个非分组行添加序号（用于模板渲染）
      let rank = 0;
      for (const item of this.toolRankData) {
        if (!item.isGroup) {
          item.rank = ++rank;
        }
      }
    },

    /* ── period / date ── */
    setPeriod(p) {
      this.period = p;
      if (p !== 'custom') {
        this.customStart = '';
        this.customEnd = '';
        this.saveStateToHash();
        this.loadCurrentView();
        if (this.view === 'report') this.loadReportContent();
      }
    },

    onCustomStartChange() {
      if (this.customStart && this.customEnd) {
        this.loadCurrentView();
        if (this.view === 'report') this.loadReportContent();
      }
    },

    onCustomEndChange() {
      if (this.customStart && this.customEnd) {
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
      this.loadCurrentView();
      if (this.view === 'report') this.loadReportContent();
    },

    onDateChange() {
      if (this.currentDate > this.today) this.currentDate = this.today;
      this.saveStateToHash();
      this.loadCurrentView();
      if (this.view === 'report') this.loadReportContent();
    },

    loadStateFromHash() {
      const hash = location.hash.slice(1);
      if (!hash) return;
      const [p, d] = hash.split('/');
      if (p && ['daily', 'weekly', 'monthly', 'custom'].includes(p)) this.period = p;
      if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) this.currentDate = d;
    },

    saveStateToHash() {
      location.hash = `${this.period}/${this.currentDate}`;
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
      this.cacheSavingText = saving > 0 ? `本月缓存命中节省 <span class="font-mono" style="color:var(--forest)">$${saving.toFixed(2)}</span> ≈ 总成本 ${((saving / Math.max(cost, 1)) * 100).toFixed(1)}%` : '';

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
      const toolColors = { claude: 'var(--claude)', codex: 'var(--codex)', opencode: 'var(--opencode)' };
      const toolDisplayNames = { claude: 'Claude Code', codex: 'OpenAI Codex', opencode: 'OpenCode' };
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
        return { name: toolDisplayNames[name] || name, pct, tokens: fmtShort(tok), color: toolColors[name] || 'var(--foreground)' };
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
      this.loadReportContent();
    },

    async loadReportContent() {
      try {
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
      } catch (e) { console.warn('loadReportContent failed:', e); }
    },

    setReportLevel(level) {
      this.reportLevel = level;
      this.loadReportContent();
    },

    setReportPlatform(platform) {
      this.reportPlatform = platform;
      this.loadReportContent();
    },

    setReportProject(project) {
      this.reportProject = project;
      this.loadReportContent();
    },

    async copyReport() {
      await copyWorkReport();
      this.copied = true;
      setTimeout(() => this.copied = false, 1400);
    },

    downloadReport() {
      downloadMarkdown(this.period, this.currentDate);
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
window.openSettings = async () => {
  const modal = document.getElementById('settingsModal');
  if (modal) modal.style.display = 'flex';
  try {
    const cfg = await fetchConfig();
    const dirEl = document.getElementById('cfgClaudeDir');
    const reposEl = document.getElementById('cfgRepos');
    const excludeEl = document.getElementById('cfgExclude');
    const kwEl = document.getElementById('cfgKeywords');
    if (dirEl) dirEl.value = cfg.claudeDir || '';
    if (reposEl) reposEl.value = (cfg.repos || []).join('\n');
    if (excludeEl) excludeEl.value = (cfg.excludeProjects || []).join('\n');
    if (kwEl) kwEl.value = cfg.scenarioKeywords ? JSON.stringify(cfg.scenarioKeywords, null, 2) : '{}';
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
  let scenarioKeywords;
  try { scenarioKeywords = JSON.parse(document.getElementById('cfgKeywords').value); } catch { showToast('场景关键词 JSON 格式错误'); return; }
  const payload = {
    claudeDir: document.getElementById('cfgClaudeDir').value.trim(),
    repos: document.getElementById('cfgRepos').value.split('\n').map(s => s.trim()).filter(Boolean),
    excludeProjects: document.getElementById('cfgExclude').value.split('\n').map(s => s.trim()).filter(Boolean),
    scenarioKeywords,
  };
  try {
    await saveConfig(payload);
    document.getElementById('settingsModal').style.display = 'none';
    window.location.reload();
  } catch (err) { showToast('保存失败: ' + err.message); }
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
