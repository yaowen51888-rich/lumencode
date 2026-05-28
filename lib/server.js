import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { saveConfig } from './config.js';
import { generateWorkReport, generateFeishuCard } from './report.js';
import { collectAllRecords, filterRecordsByPeriod, groupBySessions, computeUsageStats, computeTrendData, computePrevPeriodRange } from './aggregate.js';
import { normalizeProjectPath } from './aggregate.js';
import { invalidateFileCache } from './cache.js';
import { invalidateGitCache, getGitStatsForMultipleReposAsync, finalizeGitStats } from './git.js';
import { identifyBillingBlocks } from './blocks.js';
import { detectAvailableTools, parseAllEnabledTools } from './parsers/index.js';
import { isAssistantRecord, getInputTokens, getOutputTokens } from './record-utils.js';
import { StepTracker } from './step-tracker.js';

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

  const PORT = process.env.LUMENCODE_PORT || 4567;

  // ── 解析结果级缓存（避免同一秒内多次全量解析） ──
  let _parsedCache = null;
  let _parsedCacheKey = '';
  let _parsedCacheExpire = 0;
  const PARSED_CACHE_TTL = 30_000; // 30s

  // ── 查询结果缓存（按查询条件缓存 buildReportData 结果） ──
  const _reportCache = new Map();
  const REPORT_CACHE_TTL = 30_000; // 30s
  const REPORT_CACHE_MAX_SIZE = 50;

  function getReportCacheKey(period, date, tool, customStart, customEnd, format) {
    return `${period}|${date}|${tool || 'all'}|${customStart || ''}|${customEnd || ''}|${format || 'json'}`;
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
  }

  function getCachedParse(config, includeProjects) {
    const key = `${config.claudeDir}|${includeProjects?.join(',') || ''}`;
    const now = Date.now();
    if (_parsedCache && _parsedCacheKey === key && now < _parsedCacheExpire) return _parsedCache;
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
    return result;
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
    if (url.pathname === '/api/tools') {
      try {
        const tools = await detectAvailableTools(config);
        const enabled = config.enabledTools || tools.filter(t => t.detected).map(t => t.name);
        const result = {
          appName: 'LumenCode',
          appVersion: 'v' + appVersion,
          tools: tools.map(({ name, displayName, detected, version }) => ({
            name, displayName, detected, version,
            enabled: enabled.includes(name),
          })),
        };
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
        const reportCacheKey = getReportCacheKey(period, date, tool, customStart, customEnd, format);
        let data = getCachedReport(reportCacheKey);
        if (data) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': 'http://localhost:' + PORT,
            'X-Cache': 'HIT',
          });
          res.end(JSON.stringify(data));
          return;
        }

        const parsed = await getOrParse(config, includeProjects);
        data = await buildReportData(period, date, config, includeProjects, tool, parsed, { customStart, customEnd });
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
          const level = url.searchParams.get('level') || 'detailed';
          const feishuCard = url.searchParams.get('feishuCard') === 'true';
          const project = url.searchParams.get('project') || '';

          if (feishuCard) {
            const card = generateFeishuCard(data.usageStats, data.gitStats, period, data.start, data.end, tool);
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
            if (config.repos?.length > 0) {
              const matchedRepo = config.repos.find(r => getProjectBaseName(r) === project);
              if (matchedRepo) {
                try {
                  const { getGitStatsAsync } = await import('./git.js');
                  const sessions = groupBySessions(projFiltered);
                  const { finalizeGitStats, getGitStatsForMultipleReposAsync } = await import('./git.js');
                  let repoGit = await getGitStatsForMultipleReposAsync([matchedRepo], pStart, pEnd + 'T23:59:59');
                  repoGit = await finalizeGitStats(repoGit, sessions, {
                    attribution: config.aiAttribution,
                    stepTracking: config.stepTracking,
                  });
                  projGitStats = repoGit;
                } catch (e) { console.warn("[server] error", e.message); }
              }
            } else {
              projGitStats = null;
            }
          }

          const markdown = generateWorkReport(projUsageStats, projGitStats, period, data.start, data.end, projPrevStats, { level, platform, tool, projectName });
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Access-Control-Allow-Origin': 'http://localhost:' + PORT,
          });
          res.end(markdown);
          return;
        }

        // 按工具替换 aiContribution
        if (tool !== 'all' && data.gitStats?.aiContributionByTool) {
          const toolAi = data.gitStats.aiContributionByTool[tool];
          if (toolAi) {
            data.gitStats.aiContribution = toolAi;
          }
        }

        // 添加费用分解
        if (data.usageStats?.models) {
          const modelEntries = Object.entries(data.usageStats.models)
            .sort((a, b) => b[1].cost - a[1].cost);
          const totalCost = modelEntries.reduce((s, [, d]) => s + (d.cost || 0), 0);
          // 缓存节省 = (inputTokens - cacheRead) * avgInputRate - 已通过 cacheRead 低价体现
          // 简化：缓存节省 = cacheRead * avgInputRate * (1 - cacheReadRate/inputRate)
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

        // 写入查询结果缓存
        setCachedReport(reportCacheKey, data);

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': 'http://localhost:' + PORT,
          'X-Cache': 'MISS',
        });
        res.end(JSON.stringify(data));
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
          const matched = filtered.filter(r => {
            const text = r.metadata?.text || r.text || '';
            const type = r.metadata?.type || r.type;
            return type === 'user' && text;
          });
          for (const r of matched) {
            const text = r.metadata?.text || r.text || '';
            const lower = text.toLowerCase();
            const keywords = config.scenarioKeywords?.[key] || [];
            for (const kw of keywords) {
              if (lower.includes(kw.toLowerCase())) {
                result.push({ text: text.slice(0, 200), timestamp: r.timestamp, project: r.project });
                break;
              }
            }
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
            if (newConfig.repos !== undefined) { if (!Array.isArray(newConfig.repos)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'repos 格式无效' })); return; } config.repos = newConfig.repos; }
            if (newConfig.excludeProjects !== undefined) config.excludeProjects = newConfig.excludeProjects;
            if (newConfig.scenarioKeywords !== undefined) config.scenarioKeywords = newConfig.scenarioKeywords;
            if (newConfig.stepTracking !== undefined) config.stepTracking = newConfig.stepTracking;
            invalidateFileCache();
            invalidateGitCache();
            _parsedCache = null; // 配置变更后清除解析缓存
            invalidateReportCache(); // 配置变更后清除查询结果缓存
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
    process.stdout.write('\n');
    process.stdout.write(`  ${green}${B}✓${R}  Server ready at ${blue}${B}http://localhost:${PORT}${R}\n`);
    process.stdout.write('\n');

    // Auto-open browser
    const openCmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    import('child_process').then(({ exec }) => {
      exec(`${openCmd} http://localhost:${PORT}`, () => {});
    });
  });
}
