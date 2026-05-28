import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { BaseParser } from './base.js';
import { createUsageRecord } from '../models/usage-record.js';
import { getCachedFileRecords } from '../cache.js';
import { getProjectDisplayName } from '../aggregate.js';

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
    const { excludeProjects = [] } = options;
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

    // includeProjects 过滤交由外层 parseAllEnabledTools 按 basename 统一处理
    // 不在内层按 encoded 路径精确匹配，避免路径编码差异导致 session 全部丢失

    for (const projDir of dirs) {
      const projPath = join(projectsDir, projDir);
      const allEntries = readdirSync(projPath);
      const jsonlFiles = allEntries.filter(f => f.endsWith('.jsonl') && !f.includes('subagents'));

      const projName = getProjectDisplayName(projDir);

      // 并行读取所有 JSONL 文件（减少串行 IO 等待）
      const fileResults = await Promise.all(
        jsonlFiles.map(async (file) => {
          const filePath = join(projPath, file);
          const sessionIdFromFile = file.replace(/\.jsonl$/, '');
          const result = [];
          try {
            const fileRecords = getCachedFileRecords(filePath);
            for (const r of fileRecords) {
              result.push(this._convertToUsageRecord(r, projName, sessionIdFromFile));
            }
          } catch {}
          // 子 agent 日志
          try {
            const subRecords = this._parseSubagentFiles(dirname(filePath));
            for (const r of subRecords) {
              result.push(this._convertToUsageRecord(r, projName, sessionIdFromFile));
            }
          } catch {}
          return result;
        })
      );
      for (const fr of fileResults) records.push(...fr);

      // 当无主 JSONL 文件时，扫描 sessions-index.json 和 UUID 子目录
      if (jsonlFiles.length === 0) {
        // 解析 sessions-index.json 生成会话元数据记录
        const indexRecords = this._parseSessionsIndex(projPath, projName);
        records.push(...indexRecords);

        // 扫描 UUID 子目录中的 subagent JSONL 文件
        const uuidDirs = allEntries.filter(d => {
          const full = join(projPath, d);
          try { return statSync(full).isDirectory() && /^[0-9a-f]{8}-/i.test(d); } catch { return false; }
        });
        for (const uuidDir of uuidDirs) {
          const sessionDir = join(projPath, uuidDir);
          try {
            const subRecords = this._parseSubagentFiles(sessionDir);
            for (const r of subRecords) {
              records.push(this._convertToUsageRecord(r, projName, uuidDir));
            }
          } catch {}
        }
      }
    }

    return records;
  }

  _convertToUsageRecord(raw, projectDir, fallbackSessionId = '') {
    // 优先从 cwd 提取真实项目名，解决目录名编码中 - 无法区分路径分隔符和原字符的问题
    let projectName = projectDir || '';
    if (raw.cwd) {
      const normalized = raw.cwd.replace(/\\/g, '/').replace(/\/$/, '');
      const segments = normalized.split('/');
      const cwdBase = segments[segments.length - 1];
      if (cwdBase) projectName = cwdBase;
    }
    return createUsageRecord({
      timestamp: raw.timestamp || '',
      tool: 'claude',
      sessionId: raw.sessionId || fallbackSessionId || '',
      model: raw.model || '',
      inputTokens: raw.tokens?.input || 0,
      outputTokens: raw.tokens?.output || 0,
      cacheReadTokens: raw.tokens?.cacheRead || 0,
      cacheWriteTokens: raw.tokens?.cacheCreate || 0,
      costUSD: raw.costUSD ?? null,
      project: projectName,
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

  // 解析 sessions-index.json，从会话索引生成元数据记录
  _parseSessionsIndex(projPath, projName) {
    const indexPath = join(projPath, 'sessions-index.json');
    if (!existsSync(indexPath)) return [];

    const records = [];
    try {
      const raw = JSON.parse(readFileSync(indexPath, 'utf-8'));
      const entries = raw?.entries || [];
      for (const entry of entries) {
        if (!entry.sessionId) continue;
        // 检查对应的 .jsonl 是否还存在，存在则跳过（由主流程解析）
        const jsonlPath = entry.fullPath || join(projPath, entry.sessionId + '.jsonl');
        if (existsSync(jsonlPath)) continue;

        // 从索引条目创建占位 user+assistant 记录，确保会话被统计
        const ts = entry.created || entry.modified || '';
        records.push({
          type: 'user',
          role: 'user',
          timestamp: ts,
          model: '',
          text: entry.firstPrompt || entry.summary || '',
          toolCalls: [],
          sessionId: entry.sessionId,
          cwd: entry.projectPath || '',
          gitBranch: entry.gitBranch || '',
          project: projName || '',
          tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
          isSidechain: false,
          isSubagent: false,
          messageId: '',
          requestId: '',
          costUSD: null,
          isApiError: false,
          speed: 'standard',
          _fromIndex: true,
        });
        if (entry.messageCount > 0) {
          records.push({
            type: 'assistant',
            role: 'assistant',
            timestamp: entry.modified || ts,
            model: '',
            text: '',
            toolCalls: [],
            sessionId: entry.sessionId,
            cwd: entry.projectPath || '',
            gitBranch: entry.gitBranch || '',
            project: projName || '',
            tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
            isSidechain: false,
            isSubagent: false,
            messageId: '',
            requestId: '',
            costUSD: null,
            isApiError: false,
            speed: 'standard',
            _fromIndex: true,
          });
        }
      }
    } catch {}
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
