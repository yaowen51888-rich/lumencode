import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';

export function parseJsonlFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const records = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.type === 'user' || obj.type === 'assistant') {
        if (obj.isApiErrorMessage === true) continue;
        records.push(normalizeRecord(obj));
      }
    } catch {}
  }

  return records;
}

// 解析子 agent 日志（subagents/ 目录下的 JSONL 文件）
export function parseSubagentFiles(sessionDir) {
  const subagentsDir = join(sessionDir, 'subagents');
  const records = [];

  try {
    if (!statSync(subagentsDir).isDirectory()) return records;
  } catch {
    return records;
  }

  const files = readdirSync(subagentsDir).filter(f => f.endsWith('.jsonl'));
  for (const file of files) {
    try {
      const filePath = join(subagentsDir, file);
      const subRecords = parseJsonlFile(filePath);
      // 标记为子 agent 记录
      for (const r of subRecords) {
        r.isSubagent = true;
      }
      records.push(...subRecords);
    } catch {}
  }

  return records;
}

// 自动检测 claudeDir
export function detectClaudeDir() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;

  const candidates = [
    join(home, '.claude'),
    join(home, '.config', 'claude'),
  ];

  for (const dir of candidates) {
    try {
      const projectsDir = join(dir, 'projects');
      if (statSync(projectsDir).isDirectory()) return dir;
    } catch {}
  }

  return null;
}

// 从 JSONL 的 cwd 字段自动推导项目路径
export function deriveProjectPaths(claudeDir, excludeProjects = []) {
  const projectsDir = join(claudeDir, 'projects');
  const paths = new Set();

  try {
    if (!statSync(projectsDir).isDirectory()) return [];
  } catch {
    return [];
  }

  const dirs = readdirSync(projectsDir).filter(d => {
    const full = join(projectsDir, d);
    return statSync(full).isDirectory() && !excludeProjects.includes(d);
  });

  for (const projDir of dirs) {
    const projPath = join(projectsDir, projDir);
    const files = readdirSync(projPath).filter(f => f.endsWith('.jsonl') && !f.includes('subagents'));

    for (const file of files) {
      try {
        const content = readFileSync(join(projPath, file), 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            if (obj.cwd) {
              // 只保留真实的文件系统路径
              const cwd = obj.cwd.replace(/\\/g, '/').replace(/\/$/, '');
              if (cwd.startsWith('/') || /^[A-Z]:\//i.test(cwd)) {
                paths.add(cwd);
              }
            }
          } catch {}
        }
      } catch {}
    }
  }

  return [...paths].sort();
}

function normalizeRecord(obj) {
  const msg = obj.message || {};
  const content = msg.content || '';
  let text = '';
  let toolCalls = [];

  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'text') text += (c.text || '');
      if (c.type === 'tool_use') {
        toolCalls.push({ name: c.name || '', input: c.input || {} });
      }
    }
    text = text.trim();
  }

  const usage = obj.usage || msg.usage || {};

  return {
    type: obj.type,
    role: msg.role || '',
    timestamp: obj.timestamp || '',
    model: msg.model || '',
    text: text.trim(),
    toolCalls,
    sessionId: obj.sessionId || '',
    cwd: obj.cwd || '',
    gitBranch: obj.gitBranch || '',
    project: '',
    tokens: {
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cacheCreate: usage.cache_creation_input_tokens || usage.cache_creation?.ephemeral_5m_input_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
    },
    isSidechain: obj.isSidechain || false,
    isSubagent: false,
    messageId: msg.id || '',
    requestId: obj.requestId || '',
    costUSD: obj.costUSD ?? null,
    isApiError: obj.isApiErrorMessage || false,
    speed: usage.speed || 'standard',
  };
}
