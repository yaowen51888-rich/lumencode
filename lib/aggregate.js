import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { parseJsonlFile } from './parser.js';
import { aggregateScenarios } from './scenario.js';
import { getGitStatsForMultipleRepos } from './git.js';

export function normalizeProjectPath(path) {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

function encodeProjectPath(projectPath) {
  return projectPath
    .replace(/:[\\/]/, '--')        // D:/ → D--
    .replace(/[\\/]/g, '-');        // 剩余 / 或 \ → -
}

export function collectAllRecords(claudeDir, excludeProjects = [], includeProjects = null) {
  const projectsDir = join(claudeDir, 'projects');
  const allRecords = [];
  const projectStats = {};

  if (!statSync(projectsDir).isDirectory()) {
    return { records: [], projects: {} };
  }

  const dirs = readdirSync(projectsDir).filter(d => {
    const full = join(projectsDir, d);
    return statSync(full).isDirectory() && !excludeProjects.includes(d);
  });

  // 反向编码匹配：把 includeProjects 编码为目录名
  const encodedIncludes = includeProjects
    ? new Set(includeProjects.map(p => encodeProjectPath(normalizeProjectPath(p))))
    : null;

  for (const projDir of dirs) {
    const projPath = join(projectsDir, projDir);
    const projName = decodeProjectName(projDir);

    if (encodedIncludes) {
      if (!encodedIncludes.has(projDir)) {
        continue;
      }
    }

    const files = readdirSync(projPath).filter(f => f.endsWith('.jsonl') && !f.includes('subagents'));

    let projRequests = 0;
    let projSessions = new Set();

    for (const file of files) {
      const filePath = join(projPath, file);
      try {
        const records = parseJsonlFile(filePath);
        for (const r of records) {
          r.project = projName;
          allRecords.push(r);
        }
        const sessionRecords = records.filter(r => r.sessionId);
        sessionRecords.forEach(r => projSessions.add(r.sessionId));
        projRequests += records.filter(r => r.type === 'assistant').length;
      } catch {}
    }

    if (projSessions.size > 0 || projRequests > 0) {
      projectStats[projName] = { sessions: projSessions.size, requests: projRequests };
    }
  }

  return { records: allRecords, projects: projectStats };
}

function decodeProjectName(dirName) {
  let decoded = dirName
    .replace(/^([A-Z])-/, '$1:/')
    .replace(/--/g, '/')
    .replace(/-/g, '/');

  if (dirName.startsWith('...')) {
    decoded = '.../' + decoded.slice(3);
  }

  // 去掉尾部多余斜杠
  decoded = decoded.replace(/\/+$/, '');

  if (/^[A-Z]:$/.test(decoded)) {
    decoded = decoded + ' [空路径]';
  }

  return decoded || '[未知项目]';
}

export function computeUsageStats(records, scenarioKeywords) {
  const stats = {
    sessionCount: new Set(records.map(r => r.sessionId).filter(Boolean)).size,
    requestCount: records.filter(r => r.type === 'assistant').length,
    userMessageCount: records.filter(r => r.type === 'user' && r.text && !r.text.startsWith('<system-reminder')).length,
    activeDays: new Set(records.filter(r => r.timestamp).map(r => r.timestamp.slice(0, 10))).size,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheCreate: 0,
    totalTokens: 0,
    models: {},
    tools: {},
    scenarios: {},
    projects: {},
    dailyStats: {},
  };

  for (const r of records) {
    // Token
    if (r.type === 'assistant') {
      stats.inputTokens += r.tokens.input;
      stats.outputTokens += r.tokens.output;
      stats.cacheRead += r.tokens.cacheRead;
      stats.cacheCreate += r.tokens.cacheCreate;
      stats.totalTokens += r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheCreate;

      // Model
      if (r.model) {
        if (!stats.models[r.model]) stats.models[r.model] = { count: 0, outputTokens: 0 };
        stats.models[r.model].count++;
        stats.models[r.model].outputTokens += r.tokens.output;
      }
    }

    // Projects
    if (r.project) {
      if (!stats.projects[r.project]) {
        stats.projects[r.project] = { sessions: new Set(), requests: 0 };
      }
      if (r.type === 'assistant') {
        stats.projects[r.project].requests++;
      }
      if (r.sessionId) {
        stats.projects[r.project].sessions.add(r.sessionId);
      }
    }

    // Tools
    for (const tc of r.toolCalls) {
      stats.tools[tc.name] = (stats.tools[tc.name] || 0) + 1;
    }

    // Daily stats
    if (r.timestamp) {
      const date = r.timestamp.slice(0, 10);
      if (!stats.dailyStats[date]) {
        stats.dailyStats[date] = { requests: 0, userMessages: 0, inputTokens: 0, outputTokens: 0 };
      }
      if (r.type === 'assistant') {
        stats.dailyStats[date].requests++;
        stats.dailyStats[date].inputTokens += r.tokens.input;
        stats.dailyStats[date].outputTokens += r.tokens.output;
      }
      if (r.type === 'user' && r.text && !r.text.startsWith('<system-reminder')) {
        stats.dailyStats[date].userMessages++;
      }
    }
  }

  // Scenarios
  stats.scenarios = aggregateScenarios(records, scenarioKeywords);

  // Convert project session Sets to sizes
  for (const proj of Object.keys(stats.projects)) {
    stats.projects[proj] = {
      sessions: stats.projects[proj].sessions.size,
      requests: stats.projects[proj].requests,
    };
  }

  return stats;
}

export function filterRecordsByPeriod(records, period, refDate) {
  const d = new Date(refDate);
  let start, end;

  switch (period) {
    case 'daily':
      start = formatDate(d);
      end = start;
      break;
    case 'weekly': {
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday start
      const monday = new Date(d);
      monday.setDate(diff);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      start = formatDate(monday);
      end = formatDate(sunday);
      break;
    }
    case 'monthly':
      start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
      end = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()).padStart(2, '0')}`;
      break;
    default:
      start = formatDate(d);
      end = start;
  }

  const filtered = records.filter(r => {
    if (!r.timestamp) return false;
    const date = r.timestamp.slice(0, 10);
    return date >= start && date <= end;
  });

  return { filtered, start, end };
}

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
