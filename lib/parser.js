import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

export function parseJsonlFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const records = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.type === 'user' || obj.type === 'assistant') {
        records.push(normalizeRecord(obj));
      }
    } catch {}
  }

  return records;
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
  };
}
