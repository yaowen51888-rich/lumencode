import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { BaseParser } from './base.js';
import { createUsageRecord } from '../models/usage-record.js';
import { getCachedFileRecords } from '../cache.js';

function encodeProjectPath(projectPath) {
  return projectPath
    .replace(/:[\\/]/, '--')
    .replace(/[\\/]/g, '-');
}

function decodeProjectName(dirName) {
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

    // includeProjects 过滤 + 反查正确项目名
    const normalizedIp = includeProjects
      ? includeProjects.map(p => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, ''))
      : null;
    const encodedIncludes = normalizedIp
      ? new Set(normalizedIp.map(p => encodeProjectPath(p)))
      : null;
    // encoded → 原始 includeProject 路径的反查表
    const encodedToOriginal = normalizedIp
      ? new Map(normalizedIp.map(p => [encodeProjectPath(p), p]))
      : null;

    for (const projDir of dirs) {
      if (encodedIncludes && !encodedIncludes.has(projDir)) continue;

      const projPath = join(projectsDir, projDir);
      const files = readdirSync(projPath).filter(f => f.endsWith('.jsonl') && !f.includes('subagents'));

      // 优先使用 includeProject 原始路径（避免 decodeProjectName 的有损解码）
      const projName = (encodedToOriginal && encodedToOriginal.get(projDir)) || decodeProjectName(projDir);

      for (const file of files) {
        const filePath = join(projPath, file);
        try {
          const fileRecords = getCachedFileRecords(filePath);
          for (const r of fileRecords) {
            records.push(this._convertToUsageRecord(r, projName));
          }
        } catch {}

        // 子 agent 日志
        try {
          const subRecords = this._parseSubagentFiles(dirname(filePath));
          for (const r of subRecords) {
            records.push(this._convertToUsageRecord(r, projName));
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

  async getVersion() {
    try {
      const { execSync } = await import('child_process');
      const cmd = process.platform === 'win32' ? 'claude --version' : 'claude --version 2>/dev/null';
      const out = execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim();
      const m = out.match(/(\d+\.\d+\.\d+)/);
      return m ? m[1] : out.split(' ')[0];
    } catch {
      return null;
    }
  }
}
