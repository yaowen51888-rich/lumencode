import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { saveConfig } from './config.js';
import { generateWorkReport } from './report.js';
import { normalizeProjectPath } from './aggregate.js';
import { invalidateFileCache } from './cache.js';
import { invalidateGitCache } from './git.js';

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
    if (url.pathname === '/api/report') {
      const period = url.searchParams.get('period') || 'daily';
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      const format = url.searchParams.get('format') || 'json';

      try {
        const data = await buildReportData(period, date, config, computeIncludeProjects(config));
        if (!data) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No records found' }));
          return;
        }

        if (format === 'work') {
          const markdown = generateWorkReport(data.usageStats, data.gitStats, period, data.start, data.end);
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(markdown);
          return;
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

    // Config endpoint
    if (url.pathname === '/api/config') {
      if (req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({
          claudeDir: config.claudeDir,
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
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
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
