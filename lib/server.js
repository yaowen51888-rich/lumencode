import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { saveConfig } from './config.js';
import { generateWorkReport, generateFeishuCard } from './report.js';
import { collectAllRecords, filterRecordsByPeriod, groupBySessions } from './aggregate.js';
import { normalizeProjectPath } from './aggregate.js';
import { invalidateFileCache } from './cache.js';
import { invalidateGitCache, getGitStatsForMultipleReposAsync, finalizeGitStats } from './git.js';
import { identifyBillingBlocks } from './blocks.js';
import { detectAvailableTools } from './parsers/index.js';

const __dirname = fileURLToPath(new URL('..', import.meta.url));

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
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

  const PORT = process.env.CCUSAGE_PORT || 4567;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // API endpoint
    if (url.pathname === '/api/tools') {
      try {
        const tools = await detectAvailableTools(config);
        const enabled = config.enabledTools || tools.filter(t => t.detected).map(t => t.name);
        const result = tools.map(t => ({
          ...t,
          enabled: enabled.includes(t.name),
        }));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/report') {
      const period = url.searchParams.get('period') || 'daily';
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      const format = url.searchParams.get('format') || 'json';
      const tool = url.searchParams.get('tool') || 'all';

      // 未配置时返回友好提示
      if (!config.claudeDir || !existsSync(config.claudeDir)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: '未配置',
          hint: '尚未配置 Claude 日志目录，请在下方完成初始设置',
          claudeDir: config.claudeDir,
        }));
        return;
      }

      try {
        const data = await buildReportData(period, date, config, computeIncludeProjects(config));
        if (!data) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: '未找到数据',
            hint: '请检查 Claude 日志目录配置是否正确，确认目录下有 projects/ 子目录',
            claudeDir: config.claudeDir,
          }));
          return;
        }

        if (format === 'work') {
          const platform = url.searchParams.get('platform') || 'default';
          const level = url.searchParams.get('level') || 'detailed';
          const feishuCard = url.searchParams.get('feishuCard') === 'true';

          if (feishuCard) {
            const card = generateFeishuCard(data.usageStats, data.gitStats, period, data.start, data.end);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify(card));
            return;
          }

          const markdown = generateWorkReport(data.usageStats, data.gitStats, period, data.start, data.end, data.prevStats, { level, platform });
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
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

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/sessions') {
      const period = url.searchParams.get('period') || 'daily';
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      const project = url.searchParams.get('project') || '';
      try {
        const { records: allRecords } = collectAllRecords(config.claudeDir, config.excludeProjects, computeIncludeProjects(config));
        const { filtered, start, end } = filterRecordsByPeriod(allRecords, period, date);
        const projected = project ? filtered.filter(r => r.project === project) : filtered;
        const sessions = groupBySessions(projected);

        // 附加 commits 信息（若配置了 repos）
        if (config.repos?.length) {
          try {
            const gitStats = await getGitStatsForMultipleReposAsync(config.repos, start, end + 'T23:59:59');
            finalizeGitStats(gitStats, sessions); // 会回填 session.commits
          } catch {}
        }

        // 精简返回字段，去掉 toolSequence/sampleTexts 等大字段
        const slim = sessions.map(s => ({
          id: s.id,
          project: s.project,
          startTime: s.startTime,
          endTime: s.endTime,
          requests: s.requests,
          inputTokens: s.inputTokens,
          outputTokens: s.outputTokens,
          models: s.models,
          commits: s.commits || [],
        }));

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(slim));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/details') {
      const period = url.searchParams.get('period') || 'daily';
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      const dimension = url.searchParams.get('dimension') || '';
      const key = url.searchParams.get('key') || '';
      try {
        const { records: allRecords } = collectAllRecords(config.claudeDir, config.excludeProjects, computeIncludeProjects(config));
        const { filtered } = filterRecordsByPeriod(allRecords, period, date);
        let result = [];
        if (dimension === 'model') {
          const modelRecords = filtered.filter(r => r.type === 'assistant' && r.model === key);
          const dailyMap = {};
          for (const r of modelRecords) {
            const d = r.timestamp.slice(0, 10);
            if (!dailyMap[d]) dailyMap[d] = { date: d, requests: 0, inputTokens: 0, outputTokens: 0 };
            dailyMap[d].requests++;
            dailyMap[d].inputTokens += r.tokens.input;
            dailyMap[d].outputTokens += r.tokens.output;
          }
          result = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
        } else if (dimension === 'scenario') {
          const matched = filtered.filter(r => r.type === 'user' && r.text);
          for (const r of matched) {
            const lower = r.text.toLowerCase();
            const keywords = config.scenarioKeywords?.[key] || [];
            for (const kw of keywords) {
              if (lower.includes(kw.toLowerCase())) {
                result.push({ text: r.text.slice(0, 200), timestamp: r.timestamp, project: r.project });
                break;
              }
            }
            if (result.length >= 10) break;
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Billing blocks endpoint
    if (url.pathname === '/api/blocks') {
      const period = url.searchParams.get('period') || 'daily';
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      try {
        const { records: allRecords } = collectAllRecords(config.claudeDir, config.excludeProjects, computeIncludeProjects(config));
        const { filtered } = filterRecordsByPeriod(allRecords, period, date);
        const blocks = identifyBillingBlocks(filtered, 5, config.costMode);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(blocks));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Config endpoint
    if (url.pathname === '/api/config') {
      if (req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
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
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const newConfig = JSON.parse(body);
            if (newConfig.claudeDir !== undefined) config.claudeDir = newConfig.claudeDir;
            if (newConfig.codexDir !== undefined) config.codexDir = newConfig.codexDir;
            if (newConfig.opencodeDir !== undefined) config.opencodeDir = newConfig.opencodeDir;
            if (newConfig.enabledTools !== undefined) config.enabledTools = newConfig.enabledTools;
            if (newConfig.repos !== undefined) {
              config.repos = newConfig.repos;
            }
            if (newConfig.excludeProjects !== undefined) config.excludeProjects = newConfig.excludeProjects;
            if (newConfig.scenarioKeywords !== undefined) config.scenarioKeywords = newConfig.scenarioKeywords;
            invalidateFileCache();
            invalidateGitCache();
            saveConfig(config, configPath);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, path: configPath }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // Static files
    let filePath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
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

  server.listen(PORT, () => {
    console.log(`\n  ccusage-report server running at http://localhost:${PORT}\n`);

    // Auto-open browser
    const openCmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    import('child_process').then(({ exec }) => {
      exec(`${openCmd} http://localhost:${PORT}`, () => {});
    });
  });
}
