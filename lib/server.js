import { createServer } from 'http';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, extname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { saveConfig } from './config.js';
import { parseRepoPaths } from './path-utils.js';
import { generateWorkReport, generateFeishuCard, generateBossReport } from './report.js';
import { classifyRecord } from './scenario.js';
import { collectAllRecords, filterRecordsByPeriod, groupBySessions, computeUsageStats, computeTrendData, computePrevPeriodRange } from './aggregate.js';
import { normalizeProjectPath } from './aggregate.js';
import { invalidateFileCache } from './cache.js';
import { invalidateGitCache, getGitStatsForMultipleReposAsync, finalizeGitStats, computeAIContribution, computeCommitTypes, computeFileHotspots } from './git.js';
import { identifyBillingBlocks } from './blocks.js';
import { detectAvailableTools, parseAllEnabledTools } from './parsers/index.js';
import { isAssistantRecord, getInputTokens, getOutputTokens } from './record-utils.js';
import { StepTracker } from './step-tracker.js';
import { disableHooks, enableHooks, getHooksStatus, HOOK_TOOLS, initStepTracking } from './hooks-manager.js';
import { SMART_REPORT_PROMPT_MARKER, buildSmartReportContext, createSmartReport, detectSmartReportAgents, normalizeSmartReportMarkdown } from './smart-report.js';
import { buildSmartReportKey, buildSourceHash, getSmartReportStoreDir, readSmartReportRecord, saveSmartReportRecord } from './smart-report-store.js';

// basename 提取，兼容不同路径格式
function getProjectBaseName(p) {
  if (!p) return '';
  return p.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() || '';
}

const __dirname = fileURLToPath(new URL('..', import.meta.url));

// 读取应用版本号（必须在 __dirname 定义之后）
let appVersion = '0.0.0';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
  appVersion = pkg.version || '0.0.0';
} catch (e) { console.warn("[server] error", e.message); }

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function startServer(config, effectiveIncludeProjects, buildReportData, configPath) {
  function computeIncludeProjects(cfg) {
    if (cfg.repos && cfg.repos.length > 0) {
      return cfg.repos.map(r => normalizeProjectPath(r));
    }
    return null;
  }

  function getHookProjectRoots(cfg) {
    if (!Array.isArray(cfg.repos)) return [];
    return [...new Set(cfg.repos.map(r => normalizeProjectPath(String(r || '').trim())).filter(Boolean))];
  }

  function getConfiguredHooksStatus(cfg) {
    const projectRoots = getHookProjectRoots(cfg);
    const projects = projectRoots.map(root => getHooksStatus(root));
    const total = projects.length;
    const enabledCount = (tool) => projects.filter(p => p[tool]?.enabled).length;
    const stepsReadyCount = projects.filter(p => p.stepsInitialized).length;
    const toolStatus = (tool) => ({
      enabled: total > 0 && enabledCount(tool) === total,
      enabledCount: enabledCount(tool),
      total,
    });

    return {
      targetMode: 'configured-projects',
      projectCount: total,
      projects,
      stepsInitialized: total > 0 && stepsReadyCount === total,
      stepsReadyCount,
      claude: toolStatus(HOOK_TOOLS.CLAUDE),
      codex: toolStatus(HOOK_TOOLS.CODEX),
      opencode: toolStatus(HOOK_TOOLS.OPENCODE),
    };
  }

  const PORT = process.env.LUMENCODE_PORT || 4567;

  // ── 解析结果级缓存（避免频繁全量解析 JSONL） ──
  let _parsedCache = null;
  let _parsedCacheKey = '';
  let _parsedCacheExpire = 0;
  let _parsedCacheMtime = 0;
  const PARSED_CACHE_TTL = 300_000; // 5min，配合 mtime 检测

  // ── 查询结果缓存（按查询条件缓存 buildReportData 结果） ──
  const _reportCache = new Map();
  const REPORT_CACHE_TTL = 30_000; // 30s
  const REPORT_CACHE_MAX_SIZE = 50;

  // ── work 报告缓存（缓存 format=work 最终 markdown/feishuCard） ──
  const _workReportCache = new Map();
  const WORK_REPORT_CACHE_TTL = 30_000; // 30s
  const WORK_REPORT_CACHE_MAX_SIZE = 100;

  // ── 维度元数据缓存（工具列表、智能报告 agents，配置变更时清空） ──
  let _toolsCacheData = null;
  let _toolsCacheExpire = 0;
  let _smartReportToolsCacheData = null;
  let _smartReportToolsCacheExpire = 0;
  const TOOLS_CACHE_TTL = 60_000; // 60s
  const SMART_REPORT_TOOLS_CACHE_TTL = 60_000; // 60s

  const smartReportJobs = new Map();
  const SMART_REPORT_JOB_KEEP_MS = 30 * 60_000;

  function getReportCacheKey(period, date, tool, customStart, customEnd) {
    return `${period}|${date}|${tool || 'all'}|${customStart || ''}|${customEnd || ''}`;
  }

  function getCachedReport(cacheKey) {
    const cached = _reportCache.get(cacheKey);
    if (cached && Date.now() < cached.expire) return cached.data;
    _reportCache.delete(cacheKey);
    return null;
  }

  function setCachedReport(cacheKey, data) {
    _reportCache.set(cacheKey, { data, expire: Date.now() + REPORT_CACHE_TTL });
    // LRU: 超出限制时删除最早的条目
    while (_reportCache.size > REPORT_CACHE_MAX_SIZE) {
      const oldest = _reportCache.keys().next().value;
      _reportCache.delete(oldest);
    }
  }

  function invalidateReportCache() {
    _reportCache.clear();
    _workReportCache.clear();
  }

  // ── work 报告缓存 helpers ──
  function getWorkReportCacheKey(baseKey, platform, level, project, feishuCard) {
    return `${baseKey}|${platform || 'default'}|${level || 'detailed'}|${project || ''}|${feishuCard ? '1' : '0'}`;
  }

  function getCachedWorkReport(cacheKey) {
    const cached = _workReportCache.get(cacheKey);
    if (cached && Date.now() < cached.expire) return cached.data;
    _workReportCache.delete(cacheKey);
    return null;
  }

  function setCachedWorkReport(cacheKey, data) {
    _workReportCache.set(cacheKey, { data, expire: Date.now() + WORK_REPORT_CACHE_TTL });
    while (_workReportCache.size > WORK_REPORT_CACHE_MAX_SIZE) {
      const oldest = _workReportCache.keys().next().value;
      _workReportCache.delete(oldest);
    }
  }

  function writeJson(res, statusCode, data) {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'http://localhost:' + PORT,
    });
    res.end(JSON.stringify(data));
  }

  function publicSmartReportJob(job) {
    if (!job) return null;
    return {
      id: job.id,
      reportKey: job.reportKey,
      status: job.status,
      error: job.error || '',
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt || '',
    };
  }

  function rememberSmartReportJob(job) {
    smartReportJobs.set(job.reportKey, job);
    return job;
  }

  function forgetSmartReportJobLater(reportKey) {
    setTimeout(() => {
      const job = smartReportJobs.get(reportKey);
      if (job && job.status !== 'running') smartReportJobs.delete(reportKey);
    }, SMART_REPORT_JOB_KEEP_MS).unref?.();
  }

  function parseHookTools(value) {
    if (!value) return [HOOK_TOOLS.CLAUDE, HOOK_TOOLS.CODEX, HOOK_TOOLS.OPENCODE];
    const tools = [];
    for (const raw of String(value).split(',')) {
      const tool = raw.trim().toLowerCase();
      if (!tool) continue;
      if (tool === 'claude' || tool === 'claude-code') tools.push(HOOK_TOOLS.CLAUDE);
      else if (tool === 'codex') tools.push(HOOK_TOOLS.CODEX);
      else if (tool === 'opencode' || tool === 'open-code') tools.push(HOOK_TOOLS.OPENCODE);
    }
    return [...new Set(tools)];
  }

  function readJsonBody(req, res, callback) {
    let body = '';
    let bodySize = 0;
    const MAX_BODY = 1024 * 1024; // 1MB
    req.on('data', chunk => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) { req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => {
      if (bodySize > MAX_BODY) {
        writeJson(res, 413, { error: '请求体过大' });
        return;
      }
      try {
        Promise.resolve(callback(body ? JSON.parse(body) : {})).catch(err => {
          console.error('API error:', err.message);
          writeJson(res, 500, { error: err.message || '服务器内部错误' });
        });
      } catch {
        writeJson(res, 400, { error: 'JSON 解析失败' });
      }
    });
  }

  // 取 claudeDir 及其一级子目录/文件的最大 mtime，用于检测日志是否被追加或项目增删
  function getClaudeDirMaxMtime(config) {
    const dir = config.claudeDir;
    if (!dir || !existsSync(dir)) return 0;
    let maxMtime = 0;
    try {
      const scan = (target) => {
        const entries = readdirSync(target, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(target, entry.name);
          const st = statSync(fullPath);
          if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
          // 只深入 projects 目录一层，避免全盘扫描
          if (entry.isDirectory() && entry.name === 'projects') {
            const subEntries = readdirSync(fullPath, { withFileTypes: true });
            for (const sub of subEntries) {
              const subPath = join(fullPath, sub.name);
              const subSt = statSync(subPath);
              if (subSt.mtimeMs > maxMtime) maxMtime = subSt.mtimeMs;
            }
          }
        }
      };
      scan(dir);
    } catch { /* 忽略无权限等异常 */ }
    return maxMtime;
  }

  function getCachedParse(config, includeProjects) {
    const key = `${config.claudeDir}|${includeProjects?.join(',') || ''}`;
    const now = Date.now();
    if (_parsedCache && _parsedCacheKey === key && now < _parsedCacheExpire) {
      const currentMtime = getClaudeDirMaxMtime(config);
      if (currentMtime === _parsedCacheMtime) return _parsedCache;
    }
    return null;
  }

  async function getOrParse(config, includeProjects) {
    const cached = getCachedParse(config, includeProjects);
    if (cached) return cached;
    const result = await parseAllEnabledTools(config, {
      excludeProjects: config.excludeProjects,
      includeProjects,
    });
    _parsedCache = result;
    _parsedCacheKey = `${config.claudeDir}|${includeProjects?.join(',') || ''}`;
    _parsedCacheExpire = Date.now() + PARSED_CACHE_TTL;
    _parsedCacheMtime = getClaudeDirMaxMtime(config);
    return result;
  }

  function deriveProjectGitStats(gitStats, project, start, end, attributionOptions) {
    if (!gitStats?.commitList?.length || !project) return null;
    const windowEnd = end + 'T23:59:59';
    const commitList = gitStats.commitList.filter(c => {
      return getProjectBaseName(c.repo) === project && (c.date || '') >= start && (c.date || '') <= windowEnd;
    });
    if (commitList.length === 0) return null;

    return {
      commits: commitList.length,
      filesChanged: new Set(commitList.flatMap(c => (c.files || []).map(f => f.path))).size,
      linesAdded: commitList.reduce((s, c) => s + (c.linesAdded || 0), 0),
      linesDeleted: commitList.reduce((s, c) => s + (c.linesDeleted || 0), 0),
      commitList,
      commitTypes: computeCommitTypes(commitList),
      fileHotspots: computeFileHotspots(commitList, 10),
      aiContribution: computeAIContribution(commitList, null, attributionOptions),
      attributionSummary: gitStats.attributionSummary,
    };
  }

  function parseSmartReportParams(input = {}) {
    return {
      agent: input.agent || '',
      period: input.period || 'daily',
      date: input.date || new Date().toISOString().slice(0, 10),
      start: input.start || '',
      end: input.end || '',
      tool: input.tool || 'all',
      project: input.project || '',
      level: input.level || 'detailed',
      style: input.style || 'default',
      platform: input.platform || 'default',
    };
  }

  function validateSmartReportParams(params) {
    const validPeriods = ['daily', 'weekly', 'monthly', 'custom'];
    if (!validPeriods.includes(params.period)) {
      return `无效的 period 参数，可选值：${validPeriods.join('/')}`;
    }
    if (params.period === 'custom') {
      if (!params.start || !params.end || !/^\d{4}-\d{2}-\d{2}$/.test(params.start) || !/^\d{4}-\d{2}-\d{2}$/.test(params.end)) {
        return '自定义周期需要 start 和 end 参数 (YYYY-MM-DD)';
      }
      if (params.start > params.end) return '起始日期不能晚于结束日期';
    }
    const validStyles = ['default', 'workhorse'];
    if (!validStyles.includes(params.style)) {
      return `无效的 style 参数，可选值：${validStyles.join('/')}`;
    }
    return '';
  }

  function buildSmartReportRecordIdentity(params, data) {
    return {
      period: params.period,
      date: params.period === 'daily' ? data.start : '',
      start: data.start,
      end: data.end,
      tool: params.tool,
      project: params.project,
      level: params.level,
      style: params.style,
      platform: params.platform,
    };
  }

  function isSmartReportInternalRecord(record) {
    const text = String(record?.metadata?.text || record?.text || '');
    return text.includes(SMART_REPORT_PROMPT_MARKER)
      || text.includes('LumenCode 的智能报告分析器');
  }

  function filterInternalSmartReportParsed(parsed) {
    if (!parsed?.records?.length) return parsed;
    const internalSessions = new Set(
      parsed.records
        .filter(isSmartReportInternalRecord)
        .map(r => r.sessionId)
        .filter(Boolean)
    );
    if (internalSessions.size === 0) return parsed;

    const records = parsed.records.filter(r => !internalSessions.has(r.sessionId));
    const toolBreakdown = {};
    for (const [tool, base] of Object.entries(parsed.toolBreakdown || {})) {
      toolBreakdown[tool] = { recordCount: 0, sessionCount: 0, error: base.error };
    }
    const groups = {};
    for (const record of records) {
      const tool = record.tool || 'claude';
      if (!groups[tool]) groups[tool] = { recordCount: 0, sessions: new Set() };
      groups[tool].recordCount++;
      if (record.sessionId) groups[tool].sessions.add(record.sessionId);
    }
    for (const [tool, group] of Object.entries(groups)) {
      toolBreakdown[tool] = {
        recordCount: group.recordCount,
        sessionCount: group.sessions.size,
      };
    }
    return { ...parsed, records, toolBreakdown };
  }

  function sourceReportHashesMatch(record, source) {
    const saved = record?.sourceReports || {};
    const current = source?.sourceHashes || {};
    if (!saved.detailedHash && !saved.briefHash && !saved.bossHash) return false;
    return ['detailedHash', 'briefHash', 'bossHash'].every(key => (saved[key] || '') === (current[key] || ''));
  }

  function smartReportNeedsUpdate(record, source) {
    if (!record?.sourceHash) return false;
    if (record.sourceHash === source.sourceHash) return false;
    // sourceHash 含浮点末位敏感字段（cost 等），重解析可能漂移；
    // 三个渲染后文本 hash（cost 已 toFixed）全等即视为同源，避免误报"数据已变化"
    if (sourceReportHashesMatch(record, source)) return false;
    return true;
  }

  function normalizeSmartReportRecord(record, source, params) {
    if (!record?.markdown || !source) return record;
    const context = buildSmartReportContext(source.reportData, source.workMarkdown, {
      period: params.period,
      date: params.date,
      tool: params.tool,
      project: params.project,
      level: params.level,
      style: params.style,
      platform: params.platform,
      sourceReports: source.sourceReports,
      // 重归一化沿用记录已有时点，保证快照块稳定、不随每次读取变化
      generatedAt: record.createdAt || record.updatedAt || '',
    });
    const markdown = normalizeSmartReportMarkdown(record.markdown, context);
    return markdown === record.markdown ? record : { ...record, markdown };
  }

  async function buildSmartReportSource(params) {
    const includeProjects = computeIncludeProjects(config);
    const parsed = filterInternalSmartReportParsed(await getOrParse(config, includeProjects));
    const data = await buildReportData(params.period, params.date, config, includeProjects, params.tool, parsed, {
      customStart: params.start,
      customEnd: params.end,
    });
    if (!data) return null;

    let reportData = data;
    let workUsageStats = data.usageStats;
    let workGitStats = data.gitStats;
    let workPrevStats = data.prevStats;
    let projectName = '';

    if (params.project) {
      const { records: allRecords } = parsed;
      const toolRecords = params.tool !== 'all' ? allRecords.filter(r => r.tool === params.tool) : allRecords;
      const projRecords = toolRecords.filter(r => getProjectBaseName(r.project) === params.project);
      const { filtered: projFiltered, start: pStart, end: pEnd } = filterRecordsByPeriod(projRecords, params.period, params.date, { customStart: params.start, customEnd: params.end });
      workUsageStats = projFiltered.length > 0 ? computeUsageStats(projFiltered, config.scenarioKeywords, config.costMode) : { requestCount: 0, projects: {} };
      workPrevStats = null;
      workGitStats = deriveProjectGitStats(data.gitStats, params.project, pStart, pEnd, config.aiAttribution);
      projectName = params.project;
      reportData = {
        ...data,
        usageStats: workUsageStats,
        gitStats: workGitStats,
        prevStats: workPrevStats,
      };
    }

    const detailedMarkdown = generateWorkReport(workUsageStats, workGitStats, params.period, data.start, data.end, workPrevStats, { level: 'detailed', platform: params.platform, tool: params.tool, projectName });
    const briefMarkdown = generateWorkReport(workUsageStats, workGitStats, params.period, data.start, data.end, workPrevStats, { level: 'brief', platform: params.platform, tool: params.tool, projectName });
    const bossMarkdown = generateBossReport(workUsageStats, workGitStats, params.period, data.start, data.end, workPrevStats, params.platform);
    const workMarkdown = params.level === 'brief' ? briefMarkdown : detailedMarkdown;
    const includeBossSource = params.style === 'workhorse';
    const sourceReports = {
      detailedMarkdown,
      briefMarkdown,
      bossMarkdown: includeBossSource ? bossMarkdown : '',
    };
    const sourceHashes = {
      detailedHash: buildSourceHash(detailedMarkdown),
      briefHash: buildSourceHash(briefMarkdown),
      bossHash: includeBossSource ? buildSourceHash(bossMarkdown) : '',
    };
    const sourceHash = buildSourceHash(buildSmartReportContext(reportData, workMarkdown, {
      period: params.period,
      date: params.date,
      tool: params.tool,
      project: params.project,
      level: params.level,
      style: params.style,
      platform: params.platform,
      sourceReports,
    }));

    return {
      data,
      reportData,
      workMarkdown,
      sourceReports,
      sourceHashes,
      sourceHash,
      identity: buildSmartReportRecordIdentity(params, data),
    };
  }

  function prepareJsonReportData(baseData, tool) {
    const data = { ...baseData };

    if (tool !== 'all' && data.gitStats?.aiContributionByTool) {
      const toolAi = data.gitStats.aiContributionByTool[tool];
      if (toolAi) {
        data.gitStats = { ...data.gitStats, aiContribution: toolAi };
      }
    }

    if (data.usageStats?.models) {
      const modelEntries = Object.entries(data.usageStats.models)
        .sort((a, b) => b[1].cost - a[1].cost);
      const totalCost = modelEntries.reduce((s, [, d]) => s + (d.cost || 0), 0);
      const cacheRead = data.usageStats.cacheRead || 0;
      const cacheCreate = data.usageStats.cacheCreate || 0;
      let cacheSaving = 0;
      if (totalCost > 0 && (cacheRead + cacheCreate) > 0) {
        const totalInput = data.usageStats.inputTokens || 1;
        const avgInputCostPerToken = totalCost / (totalInput + data.usageStats.outputTokens + cacheRead + cacheCreate || 1);
        cacheSaving = Math.round(cacheRead * avgInputCostPerToken * 0.9 * 100) / 100;
      }
      data.costBreakdown = {
        models: modelEntries.map(([name, d]) => ({
          name,
          cost: d.cost || 0,
          mode: d.costMode || 'unknown',
          requests: d.count,
          inputTokens: d.inputTokens,
          outputTokens: d.outputTokens,
        })),
        cacheSaving,
        total: Math.round(totalCost * 100) / 100,
      };
    }

    return data;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // 安全响应头
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    // API endpoint
    if (url.pathname === '/api/smart-report/tools') {
      try {
        let result = _smartReportToolsCacheData && Date.now() < _smartReportToolsCacheExpire ? _smartReportToolsCacheData : null;
        if (!result) {
          const tools = await detectSmartReportAgents();
          result = { tools };
          _smartReportToolsCacheData = result;
          _smartReportToolsCacheExpire = Date.now() + SMART_REPORT_TOOLS_CACHE_TTL;
        }
        writeJson(res, 200, result);
      } catch (err) {
        console.error('API error:', err.message);
        writeJson(res, 500, { error: err.message || '服务端内部错误' });
      }
      return;
    }

    if (url.pathname === '/api/smart-report') {
      if (req.method === 'GET') {
        const params = parseSmartReportParams({
          agent: url.searchParams.get('agent') || '',
          period: url.searchParams.get('period') || 'daily',
          date: url.searchParams.get('date') || '',
          start: url.searchParams.get('start') || '',
          end: url.searchParams.get('end') || '',
          tool: url.searchParams.get('tool') || 'all',
          project: url.searchParams.get('project') || '',
          level: url.searchParams.get('level') || 'detailed',
          style: url.searchParams.get('style') || 'default',
          platform: url.searchParams.get('platform') || 'default',
        });
        const validationError = validateSmartReportParams(params);
        if (validationError) {
          writeJson(res, 400, { error: validationError });
          return;
        }

        const source = await buildSmartReportSource(params);
        if (!source) {
          writeJson(res, 200, { record: null, needsUpdate: false });
          return;
        }

        const storeDir = getSmartReportStoreDir(configPath);
        let record = readSmartReportRecord(storeDir, buildSmartReportKey(source.identity));
        if (!record) {
          record = readSmartReportRecord(storeDir, buildSmartReportKey(params));
        }
        record = normalizeSmartReportRecord(record, source, params);
        const reportKey = buildSmartReportKey(source.identity);
        const job = smartReportJobs.get(reportKey) || null;
        const needsUpdate = smartReportNeedsUpdate(record, source);
        writeJson(res, 200, {
          record,
          job: publicSmartReportJob(job),
          needsUpdate,
          currentSourceHash: source.sourceHash,
          range: { start: source.data.start, end: source.data.end },
        });
        return;
      }

      if (req.method !== 'POST') {
        writeJson(res, 405, { error: 'Method not allowed' });
        return;
      }

      readJsonBody(req, res, async (body) => {
        const params = parseSmartReportParams(body);
        const validationError = validateSmartReportParams(params);
        if (validationError) {
          writeJson(res, 400, { error: validationError });
          return;
        }

        const source = await buildSmartReportSource(params);
        if (!source) {
          writeJson(res, 404, { error: '未找到可用于智能报告的数据' });
          return;
        }

        const storeDir = getSmartReportStoreDir(configPath);
        const reportKey = buildSmartReportKey(source.identity);
        const existingJob = smartReportJobs.get(reportKey);
        if (existingJob?.status === 'running') {
          const record = normalizeSmartReportRecord(readSmartReportRecord(storeDir, reportKey), source, params);
          writeJson(res, 202, {
            record,
            job: publicSmartReportJob(existingJob),
            needsUpdate: smartReportNeedsUpdate(record, source),
            currentSourceHash: source.sourceHash,
          });
          return;
        }

        const job = rememberSmartReportJob({
          id: randomUUID(),
          reportKey,
          status: 'running',
          error: '',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          completedAt: '',
        });

        Promise.resolve().then(async () => {
          try {
            const markdown = await createSmartReport({
              agent: params.agent,
              reportData: source.reportData,
              workMarkdown: source.workMarkdown,
              options: { period: params.period, date: params.date, tool: params.tool, project: params.project, level: params.level, style: params.style, platform: params.platform, sourceReports: source.sourceReports },
              requireAvailable: true,
            });
            const record = saveSmartReportRecord(storeDir, {
              ...source.identity,
              markdown,
              sourceHash: source.sourceHash,
              sourceHashVersion: 2,
              sourceReports: source.sourceHashes,
            });
            job.status = 'completed';
            job.record = record;
            job.completedAt = new Date().toISOString();
            job.updatedAt = job.completedAt;
          } catch (err) {
            job.status = 'failed';
            job.error = err.message || '智能报告生成失败';
            job.updatedAt = new Date().toISOString();
          } finally {
            forgetSmartReportJobLater(reportKey);
          }
        });

        const record = normalizeSmartReportRecord(readSmartReportRecord(storeDir, reportKey), source, params);
        writeJson(res, 202, {
          record,
          job: publicSmartReportJob(job),
          needsUpdate: smartReportNeedsUpdate(record, source),
          currentSourceHash: source.sourceHash,
        });
      });
      return;
    }

    if (url.pathname === '/api/hooks') {
      try {
        if (req.method === 'GET') {
          writeJson(res, 200, getConfiguredHooksStatus(config));
          return;
        }

        if (req.method === 'POST') {
          readJsonBody(req, res, async (body) => {
            const action = body.action || 'enable';
            const tools = parseHookTools(body.tools || url.searchParams.get('tools'));
            if (tools.length === 0) {
              writeJson(res, 400, { error: '未选择支持的 hooks 工具' });
              return;
            }
            const projectRoots = getHookProjectRoots(config);
            if (projectRoots.length === 0) {
              writeJson(res, 400, { error: '请先在设置中添加项目路径，页面开启 hooks 只作用于设置内配置的项目。' });
              return;
            }
            const stepTracking = [];
            const results = [];
            for (const projectRoot of projectRoots) {
              let projectStepTracking = null;
              if (action !== 'disable') {
                projectStepTracking = await initStepTracking(projectRoot);
                stepTracking.push({ projectRoot, ...projectStepTracking });
              }
              const projectResults = action === 'disable'
                ? disableHooks(projectRoot, tools, { backup: true })
                : enableHooks(projectRoot, tools, { backup: true });
              results.push({ projectRoot, stepTracking: projectStepTracking, results: projectResults });
            }
            writeJson(res, 200, {
              success: true,
              action,
              stepTracking,
              results,
              status: getConfiguredHooksStatus(config),
            });
          });
          return;
        }

        writeJson(res, 405, { error: 'Method not allowed' });
      } catch (err) {
        console.error('API error:', err.message);
        writeJson(res, 500, { error: err.message || '服务器内部错误' });
      }
      return;
    }

    if (url.pathname === '/api/tools') {
      try {
        let result = _toolsCacheData && Date.now() < _toolsCacheExpire ? _toolsCacheData : null;
        if (!result) {
          const tools = await detectAvailableTools(config);
          const enabled = config.enabledTools || tools.filter(t => t.detected).map(t => t.name);
          result = {
            appName: 'LumenCode',
            appVersion: 'v' + appVersion,
            tools: tools.map(({ name, displayName, detected, version }) => ({
              name, displayName, detected, version,
              enabled: enabled.includes(name),
            })),
          };
          _toolsCacheData = result;
          _toolsCacheExpire = Date.now() + TOOLS_CACHE_TTL;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'http://localhost:' + PORT });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        console.error('API error:', err.message);
        res.end(JSON.stringify({ error: '服务器内部错误' }));
      }
      return;
    }

    if (url.pathname === '/api/report') {
      const VALID_PERIODS = ['daily', 'weekly', 'monthly', 'custom'];
      const rawPeriod = url.searchParams.get('period') || 'daily';
      if (!VALID_PERIODS.includes(rawPeriod)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `无效的 period 参数，可选值：${VALID_PERIODS.join('/')}` }));
        return;
      }
      const period = rawPeriod;
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      const format = url.searchParams.get('format') || 'json';
      const tool = url.searchParams.get('tool') || 'all';
      const customStart = url.searchParams.get('start') || '';
      const customEnd = url.searchParams.get('end') || '';
      const includeProjects = computeIncludeProjects(config);

      // Validate custom range
      if (period === 'custom') {
        if (!customStart || !customEnd || !/^\d{4}-\d{2}-\d{2}$/.test(customStart) || !/^\d{4}-\d{2}-\d{2}$/.test(customEnd)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '自定义周期需要 start 和 end 参数 (YYYY-MM-DD)' }));
          return;
        }
        if (customStart > customEnd) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '起始日期不能晚于结束日期' }));
          return;
        }
        const spanMs = new Date(customEnd) - new Date(customStart);
        if (spanMs > 90 * 86400000) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '自定义周期最长 90 天' }));
          return;
        }
      }

      // 未配置时返回友好提示
      if (!config.claudeDir || !existsSync(config.claudeDir)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: '未配置',
          hint: '尚未配置 Claude 日志目录，请在下方完成初始设置',
        }));
        return;
      }

      try {
        // 查询结果缓存：相同条件直接返回缓存
        const reportCacheKey = getReportCacheKey(period, date, tool, customStart, customEnd);
        let data = getCachedReport(reportCacheKey);
        if (data && format !== 'work') {
          const responseData = prepareJsonReportData(data, tool);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': 'http://localhost:' + PORT,
            'X-Cache': 'HIT',
          });
          res.end(JSON.stringify(responseData));
          return;
        }

        let parsed = null;
        if (!data) {
          parsed = await getOrParse(config, includeProjects);
          data = await buildReportData(period, date, config, includeProjects, tool, parsed, { customStart, customEnd });
          if (data) setCachedReport(reportCacheKey, data);
        }
        if (!data) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: '未找到数据',
            hint: '请检查 Claude 日志目录配置是否正确，确认目录下有 projects/ 子目录',
          }));
          return;
        }

        if (format === 'work') {
          const platform = url.searchParams.get('platform') || 'default';
          const requestedLevel = url.searchParams.get('level') || 'detailed';
          const level = requestedLevel === 'brief' ? 'brief' : 'detailed';
          const feishuCard = url.searchParams.get('feishuCard') === 'true';
          const project = url.searchParams.get('project') || '';

          // work 报告结果缓存：相同 platform/level/project/feishuCard 直接返回
          const workCacheKey = getWorkReportCacheKey(reportCacheKey, platform, level, project, feishuCard);
          const cachedWork = getCachedWorkReport(workCacheKey);
          if (cachedWork) {
            res.writeHead(200, {
              'Content-Type': feishuCard ? 'application/json' : 'text/plain; charset=utf-8',
              'Access-Control-Allow-Origin': 'http://localhost:' + PORT,
              'X-Cache': 'HIT',
            });
            res.end(feishuCard ? JSON.stringify(cachedWork) : cachedWork);
            return;
          }

          if (feishuCard) {
            const card = generateFeishuCard(data.usageStats, data.gitStats, period, data.start, data.end, tool);
            setCachedWorkReport(workCacheKey, card);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'http://localhost:' + PORT });
            res.end(JSON.stringify(card));
            return;
          }

          // 单项目报告：过滤记录后重新计算统计
          let projUsageStats = data.usageStats;
          let projGitStats = data.gitStats;
          let projPrevStats = data.prevStats;
          let projectName = '';

          if (project) {
            if (!parsed) parsed = await getOrParse(config, includeProjects);
            const { records: allRecords } = parsed;
            const toolRecords = tool !== 'all' ? allRecords.filter(r => r.tool === tool) : allRecords;
            // basename 匹配
            const projRecords = toolRecords.filter(r => {
              return getProjectBaseName(r.project) === project;
            });
            const { filtered: projFiltered, start: pStart, end: pEnd } = filterRecordsByPeriod(projRecords, period, date, { customStart, customEnd });
            projUsageStats = projFiltered.length > 0 ? computeUsageStats(projFiltered, config.scenarioKeywords, config.costMode) : { requestCount: 0, projects: {} };
            projectName = project;

            // 上一周期
            const prevRange = computePrevPeriodRange(period, date, { customStart, customEnd });
            const prevProjFiltered = projRecords.filter(r => {
              if (!r.timestamp) return false;
              const d = r.timestamp.slice(0, 10);
              return d >= prevRange.start && d <= prevRange.end;
            });
            projPrevStats = prevProjFiltered.length > 0 ? computeUsageStats(prevProjFiltered, config.scenarioKeywords, config.costMode) : null;

            // 单项目 Git 统计
            projGitStats = deriveProjectGitStats(data.gitStats, project, pStart, pEnd, config.aiAttribution);
          }

          const markdown = generateWorkReport(projUsageStats, projGitStats, period, data.start, data.end, projPrevStats, { level, platform, tool, projectName });
          setCachedWorkReport(workCacheKey, markdown);
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Access-Control-Allow-Origin': 'http://localhost:' + PORT,
          });
          res.end(markdown);
          return;
        }

        const responseData = prepareJsonReportData(data, tool);

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': 'http://localhost:' + PORT,
          'X-Cache': 'MISS',
        });
        res.end(JSON.stringify(responseData));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        console.error('API error:', err.message);
        res.end(JSON.stringify({ error: '服务器内部错误' }));
      }
      return;
    }

    if (url.pathname === '/api/sessions') {
      const period = url.searchParams.get('period') || 'daily';
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      const project = url.searchParams.get('project') || '';
      const tool = url.searchParams.get('tool') || '';
      try {
        const { records: allRecords } = await getOrParse(config, computeIncludeProjects(config));
        const { filtered, start, end } = filterRecordsByPeriod(allRecords, period, date);
        const tooledRecords = tool ? filtered.filter(r => r.tool === tool) : filtered;
        // basename 匹配，兼容不同工具的路径格式差异
        const projected = project ? tooledRecords.filter(r => getProjectBaseName(r.project) === project) : tooledRecords;
        const sessions = groupBySessions(projected);

        // 附加 commits 信息（若配置了 repos），按覆盖项目过滤，扩展窗口匹配跨天提交
        if (config.repos?.length) {
          try {
            const coveredBases = new Set(projected.map(r => getProjectBaseName(r.project)).filter(Boolean));
            const sessionRepos = config.repos.filter(r => coveredBases.has(getProjectBaseName(r)));
            if (sessionRepos.length > 0) {
              const extEnd = new Date(end);
              extEnd.setDate(extEnd.getDate() + 2);
              const gitStats = await getGitStatsForMultipleReposAsync(sessionRepos, start, extEnd.toISOString().slice(0, 10) + 'T23:59:59');
              await finalizeGitStats(gitStats, sessions, {
                attribution: config.aiAttribution,
                stepTracking: config.stepTracking,
              });
            }
          } catch (e) { console.warn("[server] error", e.message); }
        }

        // 精简返回字段，保留效率指标
        const slim = sessions.map(s => {
          const startMs = Date.parse(s.startTime);
          const endMs = Date.parse(s.endTime);
          const duration = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.round((endMs - startMs) / 1000) : 0;
          return {
            id: s.id,
            project: s.project,
            startTime: s.startTime,
            endTime: s.endTime,
            duration,
            requests: s.requests,
            userMessages: s.userMessages,
            inputTokens: s.inputTokens,
            outputTokens: s.outputTokens,
            models: s.models,
            primaryTool: s.primaryTool || null,
            touchedFileCount: (s.touchedFiles || []).length,
            toolSequence: (s.toolSequence || []).map(tc => tc.name),
            shellCommandCount: (s.shellCommands || []).length,
            commits: s.commits || [],
          };
        });

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'http://localhost:' + PORT });
        res.end(JSON.stringify(slim));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        console.error('API error:', err.message);
        res.end(JSON.stringify({ error: '服务器内部错误' }));
      }
      return;
    }

    if (url.pathname === '/api/details') {
      const period = url.searchParams.get('period') || 'daily';
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      const dimension = url.searchParams.get('dimension') || '';
      const key = url.searchParams.get('key') || '';
      try {
        const { records: allRecords } = await getOrParse(config, computeIncludeProjects(config));
        const { filtered } = filterRecordsByPeriod(allRecords, period, date);
        let result = [];
        if (dimension === 'model') {
          const modelRecords = filtered.filter(r => {
            return isAssistantRecord(r) && (r.model || '') === key;
          });
          const dailyMap = {};
          for (const r of modelRecords) {
            const d = r.timestamp.slice(0, 10);
            if (!dailyMap[d]) dailyMap[d] = { date: d, requests: 0, inputTokens: 0, outputTokens: 0 };
            dailyMap[d].requests++;
            dailyMap[d].inputTokens += getInputTokens(r);
            dailyMap[d].outputTokens += getOutputTokens(r);
          }
          result = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
        } else if (dimension === 'scenario') {
          // 复用 classifyRecord 确保与统计逻辑一致
          const matched = filtered.filter(r => {
            const classified = classifyRecord(r, config.scenarioKeywords);
            return !!classified[key];
          });
          for (const r of matched) {
            const text = r.metadata?.text || r.text || '';
            result.push({ text: text.slice(0, 200), timestamp: r.timestamp, project: r.project });
            if (result.length >= 10) break;
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'http://localhost:' + PORT });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        console.error('API error:', err.message);
        res.end(JSON.stringify({ error: '服务器内部错误' }));
      }
      return;
    }

    // Billing blocks endpoint
    if (url.pathname === '/api/blocks') {
      const period = url.searchParams.get('period') || 'daily';
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      try {
        const { records: allRecords } = await getOrParse(config, computeIncludeProjects(config));
        const { filtered } = filterRecordsByPeriod(allRecords, period, date);
        const blocks = identifyBillingBlocks(filtered, 5, config.costMode);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'http://localhost:' + PORT });
        res.end(JSON.stringify(blocks));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        console.error('API error:', err.message);
        res.end(JSON.stringify({ error: '服务器内部错误' }));
      }
      return;
    }

    // Config endpoint
    if (url.pathname === '/api/config') {
      if (req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': 'http://localhost:' + PORT,
        });
        res.end(JSON.stringify({
          claudeDir: config.claudeDir,
          codexDir: config.codexDir || '',
          opencodeDir: config.opencodeDir || '',
          enabledTools: config.enabledTools || [],
          repos: config.repos || [],
          excludeProjects: config.excludeProjects || [],
          scenarioKeywords: config.scenarioKeywords || {},
        }));
        return;
      }

      if (req.method === 'POST') {
        let body = '';
        let bodySize = 0;
        const MAX_BODY = 1024 * 1024; // 1MB
        req.on('data', chunk => {
          bodySize += chunk.length;
          if (bodySize > MAX_BODY) { req.destroy(); return; }
          body += chunk;
        });
        req.on('end', () => {
          if (bodySize > MAX_BODY) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '请求体过大' }));
            return;
          }
          try {
            const newConfig = JSON.parse(body);
            // 路径字段验证：必须是字符串且路径存在或为空
            const validatePath = (v) => typeof v === 'string' && !v.includes('..') && !/[`$|;&<>!\n\r]/.test(v) && v.length < 500;
            if (newConfig.claudeDir !== undefined) { if (!validatePath(newConfig.claudeDir)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'claudeDir 格式无效' })); return; } config.claudeDir = newConfig.claudeDir; }
            if (newConfig.codexDir !== undefined) { if (!validatePath(newConfig.codexDir)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'codexDir 格式无效' })); return; } config.codexDir = newConfig.codexDir; }
            if (newConfig.opencodeDir !== undefined) { if (!validatePath(newConfig.opencodeDir)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'opencodeDir 格式无效' })); return; } config.opencodeDir = newConfig.opencodeDir; }
            if (newConfig.enabledTools !== undefined) config.enabledTools = newConfig.enabledTools;
            if (newConfig.repos !== undefined) config.repos = parseRepoPaths(newConfig.repos);
            if (newConfig.excludeProjects !== undefined) config.excludeProjects = parseRepoPaths(newConfig.excludeProjects);
            if (newConfig.scenarioKeywords !== undefined) {
              // 服务端校验：限制关键词长度和数量
              const sk = newConfig.scenarioKeywords;
              if (typeof sk === 'object' && sk !== null) {
                const sanitized = {};
                for (const [scene, words] of Object.entries(sk)) {
                  if (!Array.isArray(words)) continue;
                  sanitized[scene] = words
                    .map(w => String(w).trim())
                    .filter(w => w.length > 0 && w.length <= 100)
                    .filter(w => !/[\x00-\x1f\x7f]/.test(w))
                    .slice(0, 50);
                }
                config.scenarioKeywords = sanitized;
              }
            }
            if (newConfig.stepTracking !== undefined) config.stepTracking = newConfig.stepTracking;
            invalidateFileCache();
            invalidateGitCache();
            _parsedCache = null; // 配置变更后清除解析缓存
            invalidateReportCache(); // 配置变更后清除查询结果缓存
            _toolsCacheData = null; // 配置变更后清除工具列表缓存
            _toolsCacheExpire = 0;
            _smartReportToolsCacheData = null; // 配置变更后清除智能报告 agents 缓存
            _smartReportToolsCacheExpire = 0;
            saveConfig(config, configPath);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'http://localhost:' + PORT });
            res.end(JSON.stringify({ success: true }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'JSON 解析失败' }));
          }
        });
        return;
      }

      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // Step blame stats API
    if (url.pathname === '/api/step-stats') {
      let stepStats = { stepCount: 0, sessionCount: 0, available: false };
      try {
        if (config.stepTracking?.enabled !== false) {
          for (const repo of config.repos || []) {
            const tracker = new StepTracker(repo, { dbPath: config.stepTracking?.dbPath });
            if (await tracker.isAvailableAsync()) {
              await tracker.open();
              stepStats = { ...tracker.getStats(), available: true };
              tracker.close();
              break;
            }
          }
        }
      } catch { /* step tracking not available */ }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': 'http://localhost:' + PORT,
      });
      res.end(JSON.stringify(stepStats));
      return;
    }

    // Favicon - 返回空响应避免 404 控制台报错
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Static files
    let filePath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    // 防止路径遍历：normalize 后检查
    filePath = filePath.replace(/\.\./g, '').replace(/\\/g, '/');
    const resolved = resolve(__dirname, 'public', filePath.replace(/^\//, ''));
    const publicDir = resolve(__dirname, 'public');

    if (!resolved.startsWith(publicDir + sep) && resolved !== publicDir) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (!existsSync(resolved)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const content = readFileSync(resolved);
    const type = MIME[extname(resolved)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(content);
  });

  // 防止未处理异常导致进程崩溃
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err.message);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
  });

  server.listen(PORT, '127.0.0.1', () => {
    const B = '\x1b[1m';
    const R = '\x1b[0m';
    const cyan = '\x1b[96m';
    const green = '\x1b[92m';
    const yellow = '\x1b[93m';
    const blue = '\x1b[94m';
    const dim = '\x1b[2m';
    const actualPort = server.address()?.port || PORT;

    const banner = [
      '',
      `${B}${cyan}   _                                 _____          _      ${R}`,
      `${B}${cyan}  | |                               / ____|        | |     ${R}`,
      `${B}${cyan}  | |    _   _ _ __ ___   ___ _ __ | |     ___   __| | ___ ${R}`,
      `${B}${cyan}  | |   | | | | '_ \` _ \\ / _ \\ '_ \\| |    / _ \\ / _\` |/ _ \\${R}`,
      `${B}${cyan}  | |___| |_| | | | | | |  __/ | | | |___| (_) | (_| |  __/${R}`,
      `${B}${cyan}  |______\\__,_|_| |_| |_|\\___|_| |_|\\_____\\___/ \\__,_|\\___|${R}`,
      '',
    ].join('\n');

    process.stdout.write(banner + '\n');
    process.stdout.write(`  ${green}${B}v${appVersion}${R}  ${yellow}AI Coding Assistant Analytics${R}\n`);
    process.stdout.write('\n');

    if (config.claudeDir) {
      process.stdout.write(`  ${dim}●${R}  ${B}Data Dir${R}    ${config.claudeDir}\n`);
    }
    if (configPath) {
      process.stdout.write(`  ${dim}●${R}  ${B}Config${R}      ${configPath}\n`);
    }
    const repoCount = config.repos?.length || 0;
    if (repoCount > 0) {
      process.stdout.write(`  ${dim}●${R}  ${B}Projects${R}    ${repoCount} repo(s) detected\n`);
    }
    const hookStatus = getConfiguredHooksStatus(config);
    const hookParts = [
      `Claude ${hookStatus.claude.enabledCount}/${hookStatus.projectCount}`,
      `Codex ${hookStatus.codex.enabledCount}/${hookStatus.projectCount}`,
      `OpenCode ${hookStatus.opencode.enabledCount}/${hookStatus.projectCount}`,
      `steps ${hookStatus.stepsReadyCount}/${hookStatus.projectCount}`,
    ];
    process.stdout.write(`  ${dim}●${R}  ${B}Hooks${R}       ${hookParts.join(' / ')}\n`);
    if (hookStatus.projectCount === 0) {
      process.stdout.write(`  ${yellow}${B}!${R}  未配置项目路径：请先在页面设置中添加项目，页面开启 hooks 只作用于设置内项目。\n`);
    } else if (!hookStatus.claude.enabled || !hookStatus.codex.enabled || !hookStatus.opencode.enabled || !hookStatus.stepsInitialized) {
      process.stdout.write(`  ${yellow}${B}!${R}  行级归因未完整开启：在页面中开启，或进入项目目录运行 ${B}npx lumencode hooks enable${R}。\n`);
    }
    process.stdout.write('\n');
    process.stdout.write(`  ${green}${B}✓${R}  Server ready at ${blue}${B}http://localhost:${actualPort}${R}\n`);
    process.stdout.write('\n');

    // Auto-open browser
    if (process.env.LUMENCODE_NO_OPEN !== '1') {
      const openCmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      import('child_process').then(({ exec }) => {
        exec(`${openCmd} http://localhost:${actualPort}`, () => {});
      });
    }
  });

  return server;
}
