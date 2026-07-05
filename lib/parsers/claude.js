import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { execFileSync } from 'child_process';
import { BaseParser } from './base.js';
import { createUsageRecord } from '../models/usage-record.js';
import { getCachedFileRecords } from '../cache.js';
import { getProjectDisplayName } from '../aggregate.js';

const gitRootCache = new Map();

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/$/, '');
}

function resolveGitRoot(cwd) {
  const normalized = normalizePath(cwd);
  if (!normalized) return '';
  if (gitRootCache.has(normalized)) return gitRootCache.get(normalized);
  let root = normalized;
  try {
    root = normalizePath(execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: normalized,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
  } catch {
    root = normalized;
  }
  gitRootCache.set(normalized, root);
  return root;
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

      // getCachedFileRecords 为同步阻塞读，Promise.all 此处不产生真并发；
      // 保留 map 结构因 cache 命中后仅 statSync，开销低，未命中串行读在 5min TTL 内仅首次
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
          } catch (e) { console.warn(`[claude] 读取文件记录失败: ${filePath}`, e.message); }
          // 子 agent 日志
          try {
            const subRecords = this._parseSubagentFiles(dirname(filePath), sessionIdFromFile);
            for (const r of subRecords) {
              // subagent 的 sessionId 在 _parseSubagentFiles 已确保非空（obj.sessionId 或文件名），fallback 传空避免回退污染父
              result.push(this._convertToUsageRecord(r, projName, ''));
            }
          } catch (e) { console.warn(`[claude] 解析子agent失败: ${filePath}`, e.message); }
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
            const subRecords = this._parseSubagentFiles(sessionDir, uuidDir);
            for (const r of subRecords) {
              records.push(this._convertToUsageRecord(r, projName, ''));
            }
          } catch (e) { console.warn(`[claude] 扫描UUID子目录subagent失败: ${uuidDir}`, e.message); }
        }
      }
    }

    return records;
  }

  _convertToUsageRecord(raw, projectDir, fallbackSessionId = '') {
    // 优先将 cwd 归一到 Git 根目录，避免 monorepo 子目录会话与仓库提交失配
    let projectName = projectDir || '';
    if (raw.cwd) {
      projectName = resolveGitRoot(raw.cwd) || projectName;
    }
    return createUsageRecord({
      timestamp: raw.timestamp || '',
      tool: 'claude',
      sessionId: raw.sessionId || fallbackSessionId || '',
      parentSessionId: raw.parentSessionId || '',
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

  _parseSubagentFiles(sessionDir, parentSessionId = '') {
    const subagentsDir = join(sessionDir, 'subagents');
    const records = [];
    try {
      if (!statSync(subagentsDir).isDirectory()) return records;
    } catch {
      return records;
    }

    const files = readdirSync(subagentsDir).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const subId = file.replace(/\.jsonl$/, '');
      try {
        const content = readFileSync(join(subagentsDir, file), 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            if (obj.type === 'user' || obj.type === 'assistant') {
              if (obj.isApiErrorMessage === true) continue;
              const r = this._normalizeRawRecord(obj);
              // 子代理独立身份：parentSessionId 关联父会话；sessionId 优先取原始值，回退文件名（子 uuid）
              r.isSubagent = true;
              r.parentSessionId = parentSessionId;
              if (!r.sessionId) r.sessionId = subId;
              records.push(r);
            }
          } catch (e) { /* JSONL 单行解析失败，跳过 */ }
        }
      } catch (e) { console.warn(`[claude] 读取subagent文件失败: ${file}`, e.message); }
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
    } catch (e) { console.warn(`[claude] 解析sessions-index失败: ${projPath}`, e.message); }
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
