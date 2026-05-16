import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { getCachedFileRecords } from './cache.js';
import { aggregateScenarios } from './scenario.js';

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
        const records = getCachedFileRecords(filePath);
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
        if (!stats.models[r.model]) stats.models[r.model] = { count: 0, outputTokens: 0, inputTokens: 0, cacheRead: 0 };
        stats.models[r.model].count++;
        stats.models[r.model].outputTokens += r.tokens.output;
        stats.models[r.model].inputTokens += r.tokens.input;
        stats.models[r.model].cacheRead += r.tokens.cacheRead;
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

  // Cost estimation
  const MODEL_PRICING = {
    'claude-sonnet-4-6':         { input: 3,    output: 15,   cacheRead: 0.30 },
    'claude-opus-4-6':           { input: 15,   output: 75,   cacheRead: 1.50 },
    'claude-haiku-4-5':          { input: 0.80, output: 4,    cacheRead: 0.08 },
    'claude-haiku-4-5-20251001': { input: 0.80, output: 4,    cacheRead: 0.08 },
  };
  const DEFAULT_PRICING = MODEL_PRICING['claude-sonnet-4-6'];

  let estimatedCost = 0;
  for (const [model, data] of Object.entries(stats.models)) {
    const pricing = MODEL_PRICING[model] || DEFAULT_PRICING;
    estimatedCost += (data.inputTokens / 1_000_000) * pricing.input;
    estimatedCost += (data.outputTokens / 1_000_000) * pricing.output;
    estimatedCost += (data.cacheRead / 1_000_000) * pricing.cacheRead;
  }
  stats.estimatedCost = Math.round(estimatedCost * 100) / 100;

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

export function computeTrendData(allRecords, period, refDate) {
  const d = new Date(refDate);
  let trendDays;
  switch (period) {
    case 'daily': trendDays = 7; break;
    case 'weekly': trendDays = 28; break;
    case 'monthly': trendDays = 180; break;
    default: trendDays = 7;
  }

  const trendStartDate = new Date(d);
  trendStartDate.setDate(trendStartDate.getDate() - trendDays + 1);

  const trendStart = formatDate(trendStartDate);
  const trendEnd = formatDate(d);

  const dailyStats = {};
  for (const r of allRecords) {
    if (!r.timestamp) continue;
    const date = r.timestamp.slice(0, 10);
    if (date < trendStart || date > trendEnd) continue;
    if (!dailyStats[date]) dailyStats[date] = { requests: 0, inputTokens: 0, outputTokens: 0 };
    if (r.type === 'assistant') {
      dailyStats[date].requests++;
      dailyStats[date].inputTokens += r.tokens.input;
      dailyStats[date].outputTokens += r.tokens.output;
    }
  }

  return { dailyStats, start: trendStart, end: trendEnd };
}

export function groupBySessions(records) {
  const sessions = {};
  for (const r of records) {
    if (!r.sessionId) continue;
    if (!sessions[r.sessionId]) {
      sessions[r.sessionId] = {
        id: r.sessionId,
        project: r.project,
        startTime: r.timestamp,
        endTime: r.timestamp,
        requests: 0,
        userMessages: 0,
        inputTokens: 0,
        outputTokens: 0,
        models: new Set(),
        sampleTexts: [],
      };
    }
    const s = sessions[r.sessionId];
    if (r.timestamp && r.timestamp < s.startTime) s.startTime = r.timestamp;
    if (r.timestamp && r.timestamp > s.endTime) s.endTime = r.timestamp;
    if (r.type === 'assistant') {
      s.requests++;
      s.inputTokens += r.tokens.input;
      s.outputTokens += r.tokens.output;
      if (r.model) s.models.add(r.model);
    }
    if (r.type === 'user' && r.text && !r.text.startsWith('<system-reminder')) {
      s.userMessages++;
      if (s.sampleTexts.length < 3) s.sampleTexts.push(r.text.slice(0, 100));
    }
  }
  return Object.values(sessions).map(s => ({
    ...s,
    models: [...s.models],
  })).sort((a, b) => b.endTime.localeCompare(a.endTime));
}

export function computePrevPeriodRange(period, refDate) {
  const d = new Date(refDate);
  switch (period) {
    case 'daily':
      d.setDate(d.getDate() - 1);
      return { start: formatDate(d), end: formatDate(d) };
    case 'weekly': {
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      d.setDate(diff - 7);
      const prevMonday = new Date(d);
      const prevSunday = new Date(d);
      prevSunday.setDate(prevMonday.getDate() + 6);
      return { start: formatDate(prevMonday), end: formatDate(prevSunday) };
    }
    case 'monthly': {
      d.setMonth(d.getMonth() - 1);
      const y = d.getFullYear(), m = d.getMonth();
      return { start: `${y}-${String(m + 1).padStart(2, '0')}-01`, end: `${y}-${String(m + 1).padStart(2, '0')}-${String(new Date(y, m + 1, 0).getDate()).padStart(2, '0')}` };
    }
    default:
      d.setDate(d.getDate() - 1);
      return { start: formatDate(d), end: formatDate(d) };
  }
}
