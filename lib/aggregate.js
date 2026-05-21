import { readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { getCachedFileRecords } from './cache.js';
import { aggregateScenarios } from './scenario.js';
import { parseSubagentFiles } from './parser.js';

// 兼容 UsageRecord 和原始记录格式的辅助函数
function getInputTokens(r) {
  if (r.inputTokens !== undefined) return r.inputTokens;
  return r.tokens?.input || 0;
}
function getOutputTokens(r) {
  if (r.outputTokens !== undefined) return r.outputTokens;
  return r.tokens?.output || 0;
}
function getCacheRead(r) {
  if (r.cacheReadTokens !== undefined) return r.cacheReadTokens;
  return r.tokens?.cacheRead || 0;
}
function getCacheCreate(r) {
  if (r.cacheWriteTokens !== undefined) return r.cacheWriteTokens;
  return r.tokens?.cacheCreate || 0;
}
function getModel(r) {
  return r.model || '';
}
function isAssistantRecord(r) {
  if (r.metadata?.type === 'assistant') return true;
  if (r.metadata?.type === 'user') return false;
  if (r.tool === 'codex') return true;
  if (r.tool === 'opencode' && r.metadata?.role !== 'user') return true;
  if (r.type === 'assistant' && !r.tool) return true;
  return false;
}

export function normalizeProjectPath(path) {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

function getProjectBaseName(projectPath) {
  if (!projectPath) return '';
  const normalized = projectPath.replace(/\\/g, '/').replace(/\/$/, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || '';
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

      // 解析子 agent 日志
      try {
        const sessionDir = dirname(filePath);
        const subRecords = parseSubagentFiles(sessionDir);
        for (const r of subRecords) {
          r.project = projName;
          allRecords.push(r);
        }
        projRequests += subRecords.filter(r => r.type === 'assistant').length;
        subRecords.filter(r => r.sessionId).forEach(r => projSessions.add(r.sessionId));
      } catch {}
    }

    if (projSessions.size > 0 || projRequests > 0) {
      projectStats[projName] = { sessions: projSessions.size, requests: projRequests };
    }
  }

  const deduped = deduplicateRecords(allRecords);
  return { records: deduped, projects: projectStats };
}

export function deduplicateRecords(records) {
  const seen = new Map();
  const nonDedupable = [];

  for (const r of records) {
    if (r.type !== 'assistant' || !r.messageId || !r.requestId) {
      nonDedupable.push(r);
      continue;
    }

    const key = `${r.messageId}:${r.requestId}`;
    const tokenCount = r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheCreate;
    const existing = seen.get(key);

    if (!existing || tokenCount > existing.tokenCount) {
      seen.set(key, { record: r, tokenCount });
    }
  }

  const deduped = [...nonDedupable];
  for (const { record } of seen.values()) {
    deduped.push(record);
  }

  deduped.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  return deduped;
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

export function computeUsageStats(records, scenarioKeywords, costMode = 'auto') {
  const stats = {
    sessionCount: new Set(records.filter(r => !(r.metadata?.isSubagent || r.isSubagent)).map(r => r.sessionId).filter(Boolean)).size,
    requestCount: records.filter(r => isAssistantRecord(r)).length,
    userMessageCount: records.filter(r => {
      const text = r.metadata?.text || r.text || '';
      const type = r.metadata?.type || r.type;
      return type === 'user' && text && !text.startsWith('<system-reminder');
    }).length,
    activeDays: new Set(records.filter(r => r.timestamp).map(r => r.timestamp.slice(0, 10))).size,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheCreate: 0,
    totalTokens: 0,
    subagentTokens: 0,
    models: {},
    tools: {},
    scenarios: {},
    projects: {},
    dailyStats: {},
    toolBreakdown: {}, // 新增：各工具数据分布
  };

  for (const r of records) {
    const inputTokens = getInputTokens(r);
    const outputTokens = getOutputTokens(r);
    const cacheRead = getCacheRead(r);
    const cacheCreate = getCacheCreate(r);
    const model = getModel(r);
    const isAssistant = isAssistantRecord(r);

    if (isAssistant) {
      stats.inputTokens += inputTokens;
      stats.outputTokens += outputTokens;
      stats.cacheRead += cacheRead;
      stats.cacheCreate += cacheCreate;
      const tokenTotal = inputTokens + outputTokens + cacheRead + cacheCreate;
      stats.totalTokens += tokenTotal;
      if (r.metadata?.isSubagent || r.isSubagent) stats.subagentTokens += tokenTotal;

      // Model
      if (model) {
        if (!stats.models[model]) stats.models[model] = { count: 0, outputTokens: 0, inputTokens: 0, cacheRead: 0 };
        stats.models[model].count++;
        stats.models[model].outputTokens += outputTokens;
        stats.models[model].inputTokens += inputTokens;
        stats.models[model].cacheRead += cacheRead;
      }
    }

    // Tool breakdown（新增）
    const toolName = r.tool || 'claude';
    if (!stats.toolBreakdown[toolName]) {
      stats.toolBreakdown[toolName] = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, count: 0 };
    }
    if (isAssistant) {
      stats.toolBreakdown[toolName].inputTokens += inputTokens;
      stats.toolBreakdown[toolName].outputTokens += outputTokens;
      stats.toolBreakdown[toolName].cacheRead += cacheRead;
      stats.toolBreakdown[toolName].cacheCreate += cacheCreate;
      stats.toolBreakdown[toolName].count++;
    }

    // Projects - 使用 basename 规范化，避免不同工具路径差异导致同一项目分裂
    const projectName = getProjectBaseName(r.project);
    if (projectName) {
      if (!stats.projects[projectName]) {
        stats.projects[projectName] = { sessions: new Set(), requests: 0 };
      }
      if (isAssistant) {
        stats.projects[projectName].requests++;
      }
      if (r.sessionId) {
        stats.projects[projectName].sessions.add(r.sessionId);
      }
    }

    // Tools (toolCalls) - 保持现有逻辑
    const toolCalls = r.metadata?.toolCalls || r.toolCalls || [];
    for (const tc of toolCalls) {
      stats.tools[tc.name] = (stats.tools[tc.name] || 0) + 1;
    }

    // Daily stats
    if (r.timestamp) {
      const date = r.timestamp.slice(0, 10);
      if (!stats.dailyStats[date]) {
        stats.dailyStats[date] = { requests: 0, userMessages: 0, inputTokens: 0, outputTokens: 0 };
      }
      if (isAssistant) {
        stats.dailyStats[date].requests++;
        stats.dailyStats[date].inputTokens += inputTokens;
        stats.dailyStats[date].outputTokens += outputTokens;
      }
      if (r.metadata?.type === 'user' || r.type === 'user') {
        const text = r.metadata?.text || r.text || '';
        if (text && !text.startsWith('<system-reminder')) {
          stats.dailyStats[date].userMessages++;
        }
      }
    }
  }

  // Scenarios
  stats.scenarios = aggregateScenarios(records, scenarioKeywords);

  // Cost estimation
  const estimatedCost = computeCostFromRecords(records, costMode);
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
    if (isAssistantRecord(r)) {
      dailyStats[date].requests++;
      dailyStats[date].inputTokens += getInputTokens(r);
      dailyStats[date].outputTokens += getOutputTokens(r);
    }
  }

  return { dailyStats, start: trendStart, end: trendEnd };
}

export function groupBySessions(records) {
  const sessions = {};
  const addUnique = (arr, value) => {
    if (value && !arr.includes(value)) arr.push(value);
  };
  const collectPathValues = (value, out = []) => {
    if (!value) return out;
    if (typeof value === 'string') return out;
    if (Array.isArray(value)) {
      for (const item of value) collectPathValues(item, out);
      return out;
    }
    if (typeof value !== 'object') return out;
    for (const [key, val] of Object.entries(value)) {
      if (typeof val === 'string' && /(?:file|path|filename|filepath)$/i.test(key)) {
        addUnique(out, val);
      } else if (val && typeof val === 'object') {
        collectPathValues(val, out);
      }
    }
    return out;
  };
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
        toolSequence: [],
        touchedFiles: [],
        shellCommands: [],
        gitCommitTimestamps: [],
        commits: [],
        toolCounts: {},
      };
    }
    const s = sessions[r.sessionId];
    if (r.timestamp && r.timestamp < s.startTime) s.startTime = r.timestamp;
    if (r.timestamp && r.timestamp > s.endTime) s.endTime = r.timestamp;
    const isAssistant = isAssistantRecord(r);
    // 统计工具归属（仅当记录有明确 tool 字段时）
    if (r.tool) {
      s.toolCounts[r.tool] = (s.toolCounts[r.tool] || 0) + 1;
    }
    if (isAssistant) {
      s.requests++;
      s.inputTokens += getInputTokens(r);
      s.outputTokens += getOutputTokens(r);
      if (getModel(r)) s.models.add(getModel(r));
      // 收集工具调用序列
      const toolCalls = r.metadata?.toolCalls || r.toolCalls || [];
      for (const tc of toolCalls) {
        s.toolSequence.push({
          name: tc.name,
          input: tc.input || {},
          timestamp: r.timestamp,
        });
        for (const p of collectPathValues(tc.input || {})) addUnique(s.touchedFiles, p);
        if (tc.name === 'Bash' && tc.input?.command) {
          addUnique(s.shellCommands, tc.input.command);
          if (/\bgit\s+commit\b/i.test(tc.input.command)) addUnique(s.gitCommitTimestamps, r.timestamp);
        }
      }
    }
    const recordType = r.metadata?.type || r.type;
    const recordText = r.metadata?.text || r.text;
    if (recordType === 'user' && recordText && !recordText.startsWith('<system-reminder')) {
      s.userMessages++;
      if (s.sampleTexts.length < 3) s.sampleTexts.push(recordText.slice(0, 100));
    }
  }
  return Object.values(sessions).map(s => {
    // 推导 primaryTool：出现次数最多的 tool
    let primaryTool = null;
    let maxCount = 0;
    for (const [tool, count] of Object.entries(s.toolCounts)) {
      if (count > maxCount) {
        maxCount = count;
        primaryTool = tool;
      }
    }
    const { toolCounts, ...rest } = s;
    return {
      ...rest,
      models: [...s.models],
      primaryTool,
    };
  }).sort((a, b) => b.endTime.localeCompare(a.endTime));
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

// ── Pricing Engine ──

const MODEL_PRICING = {
  'claude-sonnet-4-6':         { input: 3,    output: 15,   cacheRead: 0.30, cacheCreate: 3.75,  tier: null,         fastMultiplier: 5 },
  'claude-opus-4-6':           { input: 15,   output: 75,   cacheRead: 1.50, cacheCreate: 18.75, tier: { threshold: 200000, multiplier: 2 }, fastMultiplier: 6 },
  'claude-haiku-4-5':          { input: 0.80, output: 4,    cacheRead: 0.08, cacheCreate: 1.00,  tier: null,         fastMultiplier: 1 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4,    cacheRead: 0.08, cacheCreate: 1.00,  tier: null,         fastMultiplier: 1 },
};

const PROVIDER_PREFIXES = ['anthropic--', 'bedrock--', 'vertex--'];

export function resolveModelPricing(model) {
  const defaultPricing = MODEL_PRICING['claude-sonnet-4-6'];
  if (!model) return defaultPricing;

  // Tier 1: exact match
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];

  // Tier 2: strip provider prefix
  let stripped = model;
  for (const prefix of PROVIDER_PREFIXES) {
    if (model.startsWith(prefix)) {
      stripped = model.slice(prefix.length);
      break;
    }
  }
  if (MODEL_PRICING[stripped]) return MODEL_PRICING[stripped];

  // Tier 3: fuzzy match by family keyword
  const lower = stripped.toLowerCase();
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (lower.includes('opus') && key.includes('opus')) return pricing;
    if (lower.includes('sonnet') && key.includes('sonnet')) return pricing;
    if (lower.includes('haiku') && key.includes('haiku')) return pricing;
  }

  return defaultPricing;
}

function calculateRecordCost(record, pricing) {
  const totalContext = record.tokens.input + record.tokens.cacheRead + record.tokens.cacheCreate;
  const tier = pricing.tier && totalContext > pricing.tier.threshold ? pricing.tier : null;

  const inputRate = tier ? pricing.input * tier.multiplier : pricing.input;
  const outputRate = tier ? pricing.output * tier.multiplier : pricing.output;
  const cacheReadRate = tier ? pricing.cacheRead * tier.multiplier : pricing.cacheRead;
  const cacheCreateRate = tier ? pricing.cacheCreate * tier.multiplier : pricing.cacheCreate;

  const fastMul = record.speed === 'fast' ? (pricing.fastMultiplier || 1) : 1;

  return (
    (record.tokens.input / 1_000_000) * inputRate +
    (record.tokens.output / 1_000_000) * outputRate * fastMul +
    (record.tokens.cacheRead / 1_000_000) * cacheReadRate +
    (record.tokens.cacheCreate / 1_000_000) * cacheCreateRate
  );
}

export function computeCostFromRecords(records, costMode = 'auto') {
  let total = 0;
  for (const r of records) {
    if (r.type !== 'assistant') continue;
    if (costMode === 'display') {
      total += r.costUSD || 0;
    } else if (costMode === 'calculate' || r.costUSD == null || r.costUSD <= 0) {
      const pricing = resolveModelPricing(r.model);
      total += calculateRecordCost(r, pricing);
    } else {
      // auto mode with valid costUSD
      total += r.costUSD;
    }
  }
  return total;
}
