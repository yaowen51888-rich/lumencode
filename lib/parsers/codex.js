import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, basename, dirname } from 'path';
import { BaseParser } from './base.js';
import { createUsageRecord } from '../models/usage-record.js';

export class CodexParser extends BaseParser {
  getInfo() {
    return {
      name: 'codex',
      displayName: 'OpenAI Codex',
      defaultDir: '~/.codex',
      envVar: 'CODEX_HOME',
    };
  }

  async detect(config) {
    const dir = this.getDataDir(config);
    if (!dir) return false;
    try {
      const sessionsDir = join(dir, 'sessions');
      return statSync(sessionsDir).isDirectory();
    } catch {
      try {
        const archivedDir = join(dir, 'archived_sessions');
        return statSync(archivedDir).isDirectory();
      } catch {
        return false;
      }
    }
  }

  async parse(config, options = {}) {
    const dir = this.getDataDir(config);
    const records = [];
    if (!dir) return records;

    const files = this._collectJsonlFiles(dir);
    const parsedSessionIds = new Set();

    for (const filePath of files) {
      try {
        const fileRecords = this._parseFile(filePath);
        for (const r of fileRecords) {
          if (r.sessionId) parsedSessionIds.add(r.sessionId);
          records.push(r);
        }
      } catch (err) {
        console.warn(`Codex 解析文件失败: ${filePath}`, err.message);
      }
    }

    // 从 state DB 的 threads 表补充缺失的会话（JSONL 被清理/归档的场景）
    const fallbackRecords = await this._parseStateDb(dir, parsedSessionIds);
    records.push(...fallbackRecords);

    return records;
  }

  _collectJsonlFiles(dir) {
    const files = [];
    const sessionsDir = join(dir, 'sessions');
    try {
      if (statSync(sessionsDir).isDirectory()) {
        files.push(...this._walkDir(sessionsDir));
      }
    } catch {}

    const archivedDir = join(dir, 'archived_sessions');
    try {
      if (statSync(archivedDir).isDirectory()) {
        const archived = readdirSync(archivedDir).filter(f => f.endsWith('.jsonl'));
        for (const f of archived) {
          files.push(join(archivedDir, f));
        }
      }
    } catch {}

    return files;
  }

  _walkDir(dir) {
    const results = [];
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            results.push(...this._walkDir(fullPath));
          } else if (entry.endsWith('.jsonl')) {
            results.push(fullPath);
          }
        } catch {}
      }
    } catch {}
    return results;
  }

  _looksLikeNonProject(name) {
    if (!name || name.length < 2) return true;
    // 日期格式：2026-05-20, 20260520
    if (/^\d{4}-\d{2}-\d{2}$/.test(name)) return true;
    if (/^\d{8}$/.test(name)) return true;
    // 纯数字（如 20）
    if (/^\d+$/.test(name)) return true;
    // Hash：16-64 位十六进制
    if (/^[0-9a-f]{16,64}$/i.test(name)) return true;
    return false;
  }

  _inferProject(filePath) {
    let dir = dirname(filePath);
    const root = dirname(dirname(filePath));
    while (dir !== root && dir !== dirname(dir)) {
      const dirName = basename(dir);
      if (dirName === 'sessions' || dirName === 'archived_sessions') {
        return '';
      }
      if (!this._looksLikeNonProject(dirName)) {
        return dirName;
      }
      dir = dirname(dir);
    }
    return '';
  }

  _parseFile(filePath) {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    let sessionId = '';
    let currentModel = '';
    let lastTokenUsage = null;
    let project = '';
    const records = [];
    const pendingToolCalls = [];
    const userTexts = [];

    for (const line of lines) {
      try {
        const event = JSON.parse(line);

        if (event.type === 'session_meta' && event.payload) {
          if (event.payload.id) sessionId = event.payload.id;
          if (event.payload.project) {
            project = event.payload.project;
          } else if (event.payload.cwd) {
            project = event.payload.cwd.replace(/\\/g, '/');
          }
        }

        if (event.type === 'turn_context' && event.payload?.model) {
          currentModel = event.payload.model;
        }

        // 提取用户消息文本（用于场景分类）
        if (event.type === 'response_item' && event.payload?.role === 'user') {
          const text = this._extractText(event.payload.content);
          if (text && !text.startsWith('<system-reminder') && !text.startsWith('# AGENTS.md')) {
            userTexts.push(text);
            records.push(createUsageRecord({
              timestamp: event.timestamp || new Date().toISOString(),
              tool: 'codex',
              sessionId: sessionId || basename(filePath, '.jsonl'),
              model: '',
              inputTokens: 0,
              outputTokens: 0,
              project: project || this._inferProject(filePath),
              metadata: { type: 'user', text },
            }));
          }
        }

        // 收集工具调用
        if (event.type === 'response_item' && event.payload?.type === 'function_call') {
          pendingToolCalls.push({ name: event.payload.name || 'unknown' });
        }

        if (event.type === 'event_msg' && event.payload?.type === 'token_count') {
          const info = event.payload.info;
          if (!info || !info.total_token_usage) continue;

          const total = info.total_token_usage;
          const current = {
            input: total.input_tokens || 0,
            output: total.output_tokens || 0,
            cachedInput: total.cached_input_tokens || 0,
            cacheCreation: total.cache_creation_input_tokens || 0,
            reasoningOutput: total.reasoning_output_tokens || 0,
          };

          let delta = { ...current };
          if (lastTokenUsage) {
            delta.input = Math.max(0, current.input - lastTokenUsage.input);
            delta.output = Math.max(0, current.output - lastTokenUsage.output);
            delta.cachedInput = Math.max(0, current.cachedInput - lastTokenUsage.cachedInput);
            delta.cacheCreation = Math.max(0, current.cacheCreation - lastTokenUsage.cacheCreation);
          }
          lastTokenUsage = current;

          if (delta.input > 0 || delta.output > 0) {
            records.push(createUsageRecord({
              timestamp: event.timestamp || new Date().toISOString(),
              tool: 'codex',
              sessionId: sessionId || basename(filePath, '.jsonl'),
              model: currentModel || 'gpt-5',
              inputTokens: delta.input,
              outputTokens: delta.output,
              cacheReadTokens: delta.cachedInput,
              cacheWriteTokens: delta.cacheCreation,
              costUSD: null,
              project: project || this._inferProject(filePath),
              metadata: {
                type: 'assistant',
                toolCalls: pendingToolCalls.splice(0),
                reasoningOutputTokens: delta.reasoningOutput,
                isFallback: !currentModel,
              },
            }));
          }
        }
      } catch {}
    }

    return records;
  }

  _extractText(content) {
    if (!content) return '';
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      return content
        .filter(c => c && (c.type === 'input_text' || c.type === 'text'))
        .map(c => c.text || '')
        .join(' ')
        .trim();
    }
    return '';
  }

  // 从 state_*.sqlite 的 threads 表提取 JSONL 已丢失的会话元数据
  async _parseStateDb(dir, alreadyParsed) {
    const records = [];
    try {
      // 查找最新版本的 state DB
      const entries = readdirSync(dir);
      const stateDbs = entries
        .filter(f => /^state_\d+\.sqlite$/.test(f))
        .sort()
        .reverse();
      if (stateDbs.length === 0) return records;

      const dbPath = join(dir, stateDbs[0]);
      if (!existsSync(dbPath)) return records;

      const initSqlJs = (await import('sql.js')).default;
      const SQL = await initSqlJs();
      const dbBuf = readFileSync(dbPath);
      const db = new SQL.Database(dbBuf);

      const rows = db.exec(
        `SELECT id, cwd, tokens_used, title, git_branch, model,
                created_at_ms, updated_at_ms, first_user_message, archived
         FROM threads`
      );

      if (rows[0]) {
        for (const [sid, cwd, tokens, title, gitBranch, model, createdMs, updatedMs, firstMsg, archived] of rows[0].values) {
          if (!sid || alreadyParsed.has(sid)) continue;
          const project = (cwd || '').replace(/\\/g, '/');
          const ts = createdMs ? new Date(createdMs).toISOString() : '';
          const tsEnd = updatedMs ? new Date(updatedMs).toISOString() : ts;

          // User record
          records.push(createUsageRecord({
            timestamp: ts,
            tool: 'codex',
            sessionId: sid,
            model: '',
            inputTokens: 0,
            outputTokens: 0,
            project,
            metadata: { type: 'user', text: firstMsg || title || '', _fromStateDb: true },
          }));
          // Assistant record with total tokens
          if (tokens > 0) {
            records.push(createUsageRecord({
              timestamp: tsEnd,
              tool: 'codex',
              sessionId: sid,
              model: model || '',
              inputTokens: tokens,
              outputTokens: 0,
              project,
              metadata: { type: 'assistant', _fromStateDb: true, gitBranch },
            }));
          }
        }
      }
      db.close();
    } catch {}
    return records;
  }

  async getVersion(config) {
    const dir = this.getDataDir(config);
    if (!dir) return null;
    try {
      const data = JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8'));
      return data.latest_version || null;
    } catch {
      return null;
    }
  }
}
