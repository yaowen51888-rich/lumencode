import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { BaseParser } from './base.js';
import { createUsageRecord } from '../models/usage-record.js';
import { getCachedFileRecords } from '../cache.js';

export class ClaudeParser extends BaseParser {
  getInfo() {
    return {
      name: 'claude',
      displayName: 'Claude Code',
      defaultDir: '~/.claude',
      envVar: 'CLAUDE_CONFIG_DIR',
    };
  }

  async detect(config) {
    const dir = this.getDataDir(config);
    if (!dir) return false;
    try {
      const projectsDir = join(dir, 'projects');
      return statSync(projectsDir).isDirectory();
    } catch {
      return false;
    }
  }

  async parse(config, options = {}) {
    const dir = this.getDataDir(config);
    const { excludeProjects = [], includeProjects = null } = options;
    const records = [];

    if (!dir) return records;

    const projectsDir = join(dir, 'projects');
    let dirs;
    try {
      dirs = readdirSync(projectsDir).filter(d => {
        const full = join(projectsDir, d);
        return statSync(full).isDirectory() && !excludeProjects.includes(d);
      });
    } catch {
      return records;
    }

    for (const projDir of dirs) {
      const projPath = join(projectsDir, projDir);
      const files = readdirSync(projPath).filter(f => f.endsWith('.jsonl') && !f.includes('subagents'));

      for (const file of files) {
        const filePath = join(projPath, file);
        try {
          const fileRecords = getCachedFileRecords(filePath);
          for (const r of fileRecords) {
            records.push(this._convertToUsageRecord(r, projDir));
          }
        } catch {}

        // 子 agent 日志
        try {
          const subRecords = this._parseSubagentFiles(dirname(filePath));
          for (const r of subRecords) {
            records.push(this._convertToUsageRecord(r, projDir));
          }
        } catch {}
      }
    }

    return records;
  }

  _convertToUsageRecord(raw, projectDir) {
    return createUsageRecord({
      timestamp: raw.timestamp || '',
      tool: 'claude',
      sessionId: raw.sessionId || '',
      model: raw.model || '',
      inputTokens: raw.tokens?.input || 0,
      outputTokens: raw.tokens?.output || 0,
      cacheReadTokens: raw.tokens?.cacheRead || 0,
      cacheWriteTokens: raw.tokens?.cacheCreate || 0,
      costUSD: raw.costUSD ?? null,
      project: projectDir || '',
      metadata: {
        type: raw.type,
        role: raw.role,
        text: raw.text,
        toolCalls: raw.toolCalls,
        isSubagent: raw.isSubagent,
        isSidechain: raw.isSidechain,
        speed: raw.speed,
      },
    });
  }

  _parseSubagentFiles(sessionDir) {
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
        const content = readFileSync(join(subagentsDir, file), 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            if (obj.type === 'user' || obj.type === 'assistant') {
              if (obj.isApiErrorMessage === true) continue;
              records.push(this._normalizeRawRecord(obj));
            }
          } catch {}
        }
      } catch {}
    }

    for (const r of records) {
      r.isSubagent = true;
    }
    return records;
  }

  _normalizeRawRecord(obj) {
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
}
