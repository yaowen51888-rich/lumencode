import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { BaseParser } from './base.js';
import { createUsageRecord } from '../models/usage-record.js';

// SQLite 数据库文件大小上限（100MB），超过则跳过解析避免 OOM
const MAX_DB_SIZE = 100 * 1024 * 1024;

// 增量解析缓存：基于 opencode.db 的 mtime
const _opencodeCache = {
  dbPath: '',
  mtimeMs: 0,
  size: 0,
  records: null,
};

export class OpencodeParser extends BaseParser {
  getInfo() {
    return {
      name: 'opencode',
      displayName: 'OpenCode',
      defaultDir: '~/.local/share/opencode',
      envVar: 'OPENCODE_DATA_DIR',
    };
  }

  async detect(config) {
    const dir = this.getDataDir(config);
    if (!dir) return false;
    try {
      return existsSync(join(dir, 'opencode.db'));
    } catch {
      return false;
    }
  }

  async parse(config, options = {}) {
    const dir = this.getDataDir(config);
    const records = [];
    if (!dir) return records;

    const dbPath = join(dir, 'opencode.db');
    if (!existsSync(dbPath)) return records;

    // 检查文件大小，避免大文件导致 Array buffer allocation failed
    const fileSize = statSync(dbPath).size;
    if (fileSize > MAX_DB_SIZE) {
      console.warn(`OpenCode: opencode.db 过大 (${(fileSize / 1024 / 1024).toFixed(0)}MB)，跳过解析`);
      return records;
    }

    // 增量缓存：如果 db 文件未变化，直接返回缓存
    const { mtimeMs } = statSync(dbPath);
    if (_opencodeCache.dbPath === dbPath && _opencodeCache.mtimeMs === mtimeMs && _opencodeCache.size === fileSize && _opencodeCache.records) {
      return _opencodeCache.records;
    }

    let db;
    try {
      const initSqlJs = (await import('sql.js')).default;
      const SQL = await initSqlJs();
      const dbBuf = readFileSync(dbPath);
      db = new SQL.Database(dbBuf);

      // 读取 session -> project 映射
      const sessionMap = {};
      // 不同版本 schema 不同，探测可用列
      let sessCols;
      try {
        const colInfo = db.exec("PRAGMA table_info(session)");
        sessCols = colInfo[0] ? colInfo[0].values.map(r => r[1]) : [];
      } catch { sessCols = []; }
      const hasPath = sessCols.includes('path');
      const hasDir = sessCols.includes('directory');
      const sessSelect = hasDir
        ? `SELECT id, directory${hasPath ? ', path' : ''} FROM session`
        : 'SELECT id FROM session';
      try {
        const sessRows = db.exec(sessSelect);
        if (sessRows[0]) {
          for (const row of sessRows[0].values) {
            const id = row[0];
            const dir = hasDir ? (row[1] || '') : '';
            const p = hasPath ? (row[2] || '') : '';
            sessionMap[id] = (p || dir || '').replace(/\\/g, '/');
          }
        }
      } catch (e) { console.warn("[opencode] parse error", e.message); }

      // 读取所有 message（表可能不存在于精简 schema）
      let msgRows;
      try {
        msgRows = db.exec(
          "SELECT id, session_id, time_created, data FROM message ORDER BY time_created"
        );
      } catch (e) {
        console.warn("[opencode] message 表不存在或查询失败:", e.message);
        return records;
      }
      if (!msgRows[0]) return records;

      // 计算 delta tokens（message 中 tokens 是按 session 累计的值）
      const lastTokensBySession = {};

      for (const [msgId, sessionId, timeCreated, dataStr] of msgRows[0].values) {
        let data;
        try { data = JSON.parse(dataStr); } catch { continue; }

        const role = data.role || '';
        const timestamp = new Date(timeCreated).toISOString();
        const project = sessionMap[sessionId] || '';
        const model = data.modelID || data.model?.modelID || '';

        // User messages for scenario classification
        if (role === 'user') {
          const text = this._extractUserText(db, msgId);
          if (text) {
            records.push(createUsageRecord({
              timestamp,
              tool: 'opencode',
              sessionId: sessionId || '',
              model: '',
              inputTokens: 0,
              outputTokens: 0,
              project,
              metadata: { type: 'user', text },
            }));
          }
          continue;
        }

        // Assistant messages with token usage
        if (role === 'assistant' && data.tokens) {
          const t = data.tokens;
          const current = {
            input: t.input || 0,
            output: t.output || 0,
            cacheRead: t.cache?.read || 0,
            cacheWrite: t.cache?.write || 0,
          };

          const prev = lastTokensBySession[sessionId] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
          const delta = {
            input: Math.max(0, current.input - prev.input),
            output: Math.max(0, current.output - prev.output),
            cacheRead: Math.max(0, current.cacheRead - prev.cacheRead),
            cacheWrite: Math.max(0, current.cacheWrite - prev.cacheWrite),
          };
          lastTokensBySession[sessionId] = current;

          // Collect tool calls from parts
          const toolCalls = this._extractToolCalls(db, msgId);

          if (delta.input > 0 || delta.output > 0) {
            records.push(createUsageRecord({
              timestamp,
              tool: 'opencode',
              sessionId: sessionId || '',
              model,
              inputTokens: delta.input,
              outputTokens: delta.output,
              cacheReadTokens: delta.cacheRead,
              cacheWriteTokens: delta.cacheWrite,
              costUSD: data.cost ?? null,
              project,
              metadata: {
                type: 'assistant',
                toolCalls,
                reasoningOutputTokens: t.reasoning || 0,
              },
            }));
          }
        }
      }

      // 更新增量缓存
      _opencodeCache.dbPath = dbPath;
      _opencodeCache.mtimeMs = mtimeMs;
      _opencodeCache.size = fileSize;
      _opencodeCache.records = records;
    } catch (err) {
      console.warn('OpenCode parse error:', err.message);
    } finally {
      if (db) db.close();
    }

    return records;
  }

  _extractUserText(db, msgId) {
    try {
      const rows = db.exec(
        "SELECT data FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'text'",
        [msgId]
      );
      if (rows[0]?.values?.length) {
        const parts = [];
        for (const [dataStr] of rows[0].values) {
          const d = JSON.parse(dataStr);
          if (d.text) parts.push(d.text);
        }
        return parts.join(' ').trim();
      }
    } catch (e) { console.warn("[opencode] parse error", e.message); }
    return '';
  }

  _extractToolCalls(db, msgId) {
    const calls = [];
    try {
      const rows = db.exec(
        "SELECT data FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'tool'",
        [msgId]
      );
      if (rows[0]?.values) {
        for (const [dataStr] of rows[0].values) {
          const d = JSON.parse(dataStr);
          const name = d.name || d.tool || 'unknown';
          calls.push({ name });
        }
      }
    } catch (e) { console.warn("[opencode] parse error", e.message); }
    return calls;
  }

  async getVersion(config) {
    const dir = this.getDataDir(config);
    if (!dir) return null;
    const dbPath = join(dir, 'opencode.db');
    if (!existsSync(dbPath)) return null;
    try {
      if (statSync(dbPath).size > MAX_DB_SIZE) return null;
      const initSqlJs = (await import('sql.js')).default;
      const SQL = await initSqlJs();
      const dbBuf = readFileSync(dbPath);
      const db = new SQL.Database(dbBuf);
      const rows = db.exec("SELECT value FROM settings WHERE key = 'version'");
      db.close();
      return rows[0]?.values?.[0]?.[0] || null;
    } catch {
      return null;
    }
  }
}
