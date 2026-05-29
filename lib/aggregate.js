import { readdirSync, statSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { getCachedFileRecords } from './cache.js';
import { aggregateScenarios } from './scenario.js';
import { parseSubagentFiles } from './parser.js';
import { getInputTokens, getOutputTokens, getCacheRead, getCacheCreate, getModel, isAssistantRecord } from './record-utils.js';
import { resolveModelPricing } from './pricing-loader.js';

// 重新导出以保持向后兼容（测试和其他模块从 aggregate.js 引用）
export { resolveModelPricing };

export function normalizeProjectPath(path) {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

function getProjectBaseName(projectPath) {
  if (!projectPath) return '';
  const normalized = projectPath.replace(/\\/g, '/').replace(/\/$/, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || '';
}

export function encodeProjectPath(projectPath) {
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
    const projName = getProjectDisplayName(projDir);

    if (encodedIncludes) {
      if (!encodedIncludes.has(projDir)) {
        continue;
      }
    }

    const allEntries = readdirSync(projPath);
    const files = allEntries.filter(f => f.endsWith('.jsonl') && !f.includes('subagents'));

    let projRequests = 0;
    let projSessions = new Set();

    for (const file of files) {
      const filePath = join(projPath, file);
      const sessionIdFromFile = file.replace(/\.jsonl$/, '');
      try {
        const records = getCachedFileRecords(filePath);
        for (const r of records) {
          if (!r.sessionId) r.sessionId = sessionIdFromFile;
          r.project = projName;
          allRecords.push(r);
        }
        const sessionRecords = records.filter(r => r.sessionId);
        sessionRecords.forEach(r => projSessions.add(r.sessionId));
        projRequests += records.filter(r => isAssistantRecord(r)).length;
      } catch (e) { console.warn(`[aggregate] 读取文件记录失败: ${filePath}`, e.message); }

      // 解析子 agent 日志
      try {
        const sessionDir = dirname(filePath);
        const subRecords = parseSubagentFiles(sessionDir);
        for (const r of subRecords) {
          if (!r.sessionId) r.sessionId = sessionIdFromFile;
          r.project = projName;
          allRecords.push(r);
        }
        projRequests += subRecords.filter(r => isAssistantRecord(r)).length;
        subRecords.filter(r => r.sessionId).forEach(r => projSessions.add(r.sessionId));
      } catch (e) { console.warn(`[aggregate] 解析子agent失败: ${filePath}`, e.message); }
    }

    // 当无主 JSONL 文件时，扫描 sessions-index.json 和 UUID 子目录
    if (files.length === 0) {
      // 解析 sessions-index.json
      const indexPath = join(projPath, 'sessions-index.json');
      if (existsSync(indexPath)) {
        try {
          const raw = JSON.parse(readFileSync(indexPath, 'utf-8'));
          for (const entry of raw?.entries || []) {
            if (!entry.sessionId) continue;
            const jsonlPath = entry.fullPath || join(projPath, entry.sessionId + '.jsonl');
            if (existsSync(jsonlPath)) continue;
            const ts = entry.created || entry.modified || '';
            const userRec = {
              type: 'user', role: 'user', timestamp: ts, model: '',
              text: entry.firstPrompt || entry.summary || '', toolCalls: [],
              sessionId: entry.sessionId, cwd: entry.projectPath || '',
              gitBranch: entry.gitBranch || '', project: projName,
              tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
              isSidechain: false, isSubagent: false, messageId: '', requestId: '',
              costUSD: null, isApiError: false, speed: 'standard', _fromIndex: true,
            };
            allRecords.push(userRec);
            projSessions.add(entry.sessionId);
            if (entry.messageCount > 0) {
              allRecords.push({
                type: 'assistant', role: 'assistant',
                timestamp: entry.modified || ts, model: '',
                text: '', toolCalls: [], sessionId: entry.sessionId,
                cwd: entry.projectPath || '', gitBranch: entry.gitBranch || '',
                project: projName,
                tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
                isSidechain: false, isSubagent: false, messageId: '', requestId: '',
                costUSD: null, isApiError: false, speed: 'standard', _fromIndex: true,
              });
              projRequests++;
            }
          }
        } catch (e) { console.warn(`[aggregate] 解析sessions-index失败: ${indexPath}`, e.message); }
      }

      // 扫描 UUID 子目录中的 subagent 文件
      const uuidDirs = allEntries.filter(d => {
        const full = join(projPath, d);
        try { return statSync(full).isDirectory() && /^[0-9a-f]{8}-/i.test(d); } catch { return false; }
      });
      for (const uuidDir of uuidDirs) {
        const sessionDir = join(projPath, uuidDir);
        try {
          const subRecords = parseSubagentFiles(sessionDir);
          for (const r of subRecords) {
            if (!r.sessionId) r.sessionId = uuidDir;
            r.project = projName;
            allRecords.push(r);
          }
          projRequests += subRecords.filter(r => isAssistantRecord(r)).length;
          subRecords.filter(r => r.sessionId).forEach(r => projSessions.add(r.sessionId));
        } catch (e) { console.warn(`[aggregate] 扫描UUID子目录失败: ${uuidDir}`, e.message); }
      }
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
    if (!isAssistantRecord(r) || (!r.messageId && !r.metadata?.messageId) || (!r.requestId && !r.metadata?.requestId)) {
      nonDedupable.push(r);
      continue;
    }

    const key = `${r.messageId || r.metadata?.messageId}:${r.requestId || r.metadata?.requestId}`;
    const tokenCount = getInputTokens(r) + getOutputTokens(r) + getCacheRead(r) + getCacheCreate(r);
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

// 有损解码：encode 中 / 和 \ 都映射为 -，decode 无法区分 - 是路径分隔符还是项目名原字符
// 因此 decode 结果可能不准确（如 ccusage-report → ccusage/report）
// 内部匹配用原始目录名，此函数仅用于展示
export function decodeProjectName(dirName) {
  let decoded = dirName
    .replace(/^([A-Z])-/, '$1:/')
    .replace(/--/g, '/')
    .replace(/-/g, '/');

  if (dirName.startsWith('...')) {
    decoded = '.../' + decoded.slice(3);
  }

  decoded = decoded.replace(/\/+$/, '');

  if (/^[A-Z]:$/.test(decoded)) {
    decoded = decoded + ' [空路径]';
  }

  return decoded || '[未知项目]';
}

// 从有损 decode 结果中提取项目显示名：取最后一个路径段
export function getProjectDisplayName(dirName) {
  const decoded = decodeProjectName(dirName);
  const segments = decoded.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return segments[segments.length - 1] || decoded || '[未知项目]';
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
    skills: {},
    mcpTools: {},
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
        if (!stats.models[model]) stats.models[model] = { count: 0, outputTokens: 0, inputTokens: 0, cacheRead: 0, cacheCreate: 0, cost: 0, costMode: 'unknown' };
        stats.models[model].count++;
        stats.models[model].outputTokens += outputTokens;
        stats.models[model].inputTokens += inputTokens;
        stats.models[model].cacheRead += cacheRead;
        stats.models[model].cacheCreate += cacheCreate;
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
        stats.projects[projectName] = { sessions: new Set(), requests: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, estimatedCost: 0, models: {} };
      }
      if (isAssistant) {
        stats.projects[projectName].requests++;
        stats.projects[projectName].inputTokens += inputTokens;
        stats.projects[projectName].outputTokens += outputTokens;
        stats.projects[projectName].cacheRead += cacheRead;
        stats.projects[projectName].cacheCreate += cacheCreate;
        const pricing = model ? resolveModelPricing(model) : { unknown: true };
        const recCost = (r.costUSD != null && r.costUSD > 0) ? r.costUSD : calculateRecordCost(r, pricing);
        stats.projects[projectName].estimatedCost += recCost;
        if (model) {
          if (!stats.projects[projectName].models[model]) stats.projects[projectName].models[model] = { count: 0, inputTokens: 0, outputTokens: 0 };
          stats.projects[projectName].models[model].count++;
          stats.projects[projectName].models[model].inputTokens += inputTokens;
          stats.projects[projectName].models[model].outputTokens += outputTokens;
        }
      }
      if (r.sessionId) {
        stats.projects[projectName].sessions.add(r.sessionId);
      }
    }

    // Tools (toolCalls) - calls: 总调用次数, uses: 使用次数（同一 record 内同名工具只算一次）
    const toolCalls = r.metadata?.toolCalls || r.toolCalls || [];
    for (const tc of toolCalls) {
      if (!stats.tools[tc.name]) stats.tools[tc.name] = { calls: 0, uses: 0 };
      stats.tools[tc.name].calls++;
      if (projectName && stats.projects[projectName]) {
        if (!stats.projects[projectName].tools) stats.projects[projectName].tools = {};
        if (!stats.projects[projectName].tools[tc.name]) stats.projects[projectName].tools[tc.name] = { calls: 0, uses: 0 };
        stats.projects[projectName].tools[tc.name].calls++;
      }
      // Skill 细分采集
      if (tc.name === 'Skill' && tc.input?.skill) {
        const sk = tc.input.skill;
        if (!stats.skills[sk]) stats.skills[sk] = { calls: 0, uses: 0 };
        stats.skills[sk].calls++;
      }
      // MCP 细分采集
      if (tc.name.startsWith('mcp__')) {
        if (!stats.mcpTools[tc.name]) stats.mcpTools[tc.name] = { calls: 0, uses: 0 };
        stats.mcpTools[tc.name].calls++;
      }
    }
    const uniqueToolNames = new Set(toolCalls.map(tc => tc.name));
    for (const name of uniqueToolNames) {
      if (!stats.tools[name]) stats.tools[name] = { calls: 0, uses: 0 };
      stats.tools[name].uses++;
      if (projectName && stats.projects[projectName] && stats.projects[projectName].tools[name]) {
        stats.projects[projectName].tools[name].uses++;
      }
      // 同步更新 skills / mcpTools 的 uses
      if (name === 'Skill') {
        const skillCall = toolCalls.find(tc => tc.name === 'Skill' && tc.input?.skill);
        if (skillCall) {
          const sk = skillCall.input.skill;
          if (!stats.skills[sk]) stats.skills[sk] = { calls: 0, uses: 0 };
          stats.skills[sk].uses++;
        }
      }
      if (name.startsWith('mcp__')) {
        if (!stats.mcpTools[name]) stats.mcpTools[name] = { calls: 0, uses: 0 };
        stats.mcpTools[name].uses++;
      }
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

  // Cost accuracy metadata
  const modelPricingStatus = {};
  const uniqueModels = Object.keys(stats.models);
  for (const m of uniqueModels) {
    const p = resolveModelPricing(m);
    modelPricingStatus[m] = p.unknown ? 'unknown' : 'estimated';
  }
  // Check if any records have actual costUSD (Claude API mode)
  const hasActualCost = records.some(r => {
    if (!isAssistantRecord(r)) return false;
    return r.costUSD != null && r.costUSD > 0;
  });
  if (hasActualCost) {
    for (const m of uniqueModels) {
      // Models with actual costUSD are accurate, not estimated
      const hasModelActualCost = records.some(r => {
        if (!isAssistantRecord(r) || getModel(r) !== m) return false;
        return r.costUSD != null && r.costUSD > 0;
      });
      if (hasModelActualCost) modelPricingStatus[m] = 'actual';
    }
  }
  const unknownModels = uniqueModels.filter(m => modelPricingStatus[m] === 'unknown');
  stats.costMeta = {
    accuracy: hasActualCost ? 'mixed' : (unknownModels.length > 0 ? 'partial' : 'estimated'),
    modelPricingStatus,
    unknownModels,
    hasActualCost,
  };

  // Per-model cost calculation
  for (const m of uniqueModels) {
    stats.models[m].costMode = modelPricingStatus[m] || 'unknown';
    stats.models[m].cost = 0;
  }
  for (const r of records) {
    if (!isAssistantRecord(r)) continue;
    const model = getModel(r);
    if (!model || !stats.models[model]) continue;
    const costUSD = r.costUSD ?? null;
    if (costMode === 'display') {
      stats.models[model].cost += costUSD || 0;
    } else if (costMode === 'calculate' || costUSD == null || costUSD <= 0) {
      const pricing = resolveModelPricing(model);
      stats.models[model].cost += calculateRecordCost(r, pricing);
    } else {
      stats.models[model].cost += costUSD;
    }
  }
  for (const m of uniqueModels) {
    stats.models[m].cost = Math.round(stats.models[m].cost * 100) / 100;
  }

  // Convert project session Sets to sizes
  for (const proj of Object.keys(stats.projects)) {
    const p = stats.projects[proj];
    stats.projects[proj] = {
      sessions: p.sessions.size,
      requests: p.requests,
      inputTokens: p.inputTokens || 0,
      outputTokens: p.outputTokens || 0,
      cacheRead: p.cacheRead || 0,
      cacheCreate: p.cacheCreate || 0,
      estimatedCost: p.estimatedCost || 0,
      models: p.models || {},
      tools: p.tools || {},
    };
  }

  return stats;
}

export function filterRecordsByPeriod(records, period, refDate, options = {}) {
  // 字符串日期 "2026-05-26" 被 new Date() 解析为 UTC 午夜，
  // formatDate 用本地时间，UTC- 时区下日期会偏移一天。
  // 修复：将 YYYY-MM-DD 字符串按本地时间解析
  let d;
  if (typeof refDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(refDate)) {
    const [y, m, day] = refDate.split('-').map(Number);
    d = new Date(y, m - 1, day);
  } else {
    d = new Date(refDate);
  }
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
    case 'custom':
      start = options.customStart || formatDate(d);
      end = options.customEnd || start;
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
    if (!dailyStats[date]) dailyStats[date] = { requests: 0, inputTokens: 0, outputTokens: 0, tools: {} };
    if (isAssistantRecord(r)) {
      dailyStats[date].requests++;
      dailyStats[date].inputTokens += getInputTokens(r);
      dailyStats[date].outputTokens += getOutputTokens(r);
    }
    const toolCalls = r.metadata?.toolCalls || r.toolCalls || [];
    for (const tc of toolCalls) {
      if (!dailyStats[date].tools[tc.name]) dailyStats[date].tools[tc.name] = { calls: 0, uses: 0 };
      dailyStats[date].tools[tc.name].calls++;
    }
    const uniqueNames = new Set(toolCalls.map(tc => tc.name));
    for (const name of uniqueNames) {
      if (!dailyStats[date].tools[name]) dailyStats[date].tools[name] = { calls: 0, uses: 0 };
      dailyStats[date].tools[name].uses++;
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

export function computePrevPeriodRange(period, refDate, options = {}) {
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
    case 'custom': {
      const cs = options.customStart || formatDate(d);
      const ce = options.customEnd || cs;
      const spanMs = new Date(ce) - new Date(cs) + 86400000; // inclusive days
      const gap = 86400000; // 1 day gap
      const prevEnd = new Date(new Date(cs).getTime() - gap);
      const prevStart = new Date(prevEnd.getTime() - spanMs + 86400000);
      return { start: formatDate(prevStart), end: formatDate(prevEnd) };
    }
    default:
      d.setDate(d.getDate() - 1);
      return { start: formatDate(d), end: formatDate(d) };
  }
}

// ── Pricing Engine ──

function calculateRecordCost(record, pricing) {
  if (pricing.unknown) return 0;

  const input = getInputTokens(record);
  const output = getOutputTokens(record);
  const cacheRead = getCacheRead(record);
  const cacheCreate = getCacheCreate(record);
  const totalContext = input + cacheRead + cacheCreate;
  const tier = pricing.tier && totalContext > pricing.tier.threshold ? pricing.tier : null;

  const inputRate = tier ? pricing.input * tier.multiplier : pricing.input;
  const outputRate = tier ? pricing.output * tier.multiplier : pricing.output;
  const cacheReadRate = tier ? pricing.cacheRead * tier.multiplier : pricing.cacheRead;
  const cacheCreateRate = tier ? pricing.cacheCreate * tier.multiplier : pricing.cacheCreate;

  const speed = record.speed || record.metadata?.speed || 'standard';
  const fastMul = speed === 'fast' ? (pricing.fastMultiplier || 1) : 1;

  return (
    (input / 1_000_000) * inputRate +
    (output / 1_000_000) * outputRate * fastMul +
    (cacheRead / 1_000_000) * cacheReadRate +
    (cacheCreate / 1_000_000) * cacheCreateRate
  );
}

export function computeCostFromRecords(records, costMode = 'auto') {
  let total = 0;
  for (const r of records) {
    if (!isAssistantRecord(r)) continue;
    const costUSD = r.costUSD ?? null;
    if (costMode === 'display') {
      total += costUSD || 0;
    } else if (costMode === 'calculate' || costUSD == null || costUSD <= 0) {
      const pricing = resolveModelPricing(getModel(r));
      total += calculateRecordCost(r, pricing);
    } else {
      total += costUSD;
    }
  }
  return total;
}
