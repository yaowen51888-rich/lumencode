import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { BaseParser } from './base.js';
import { createUsageRecord } from '../models/usage-record.js';

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

    try {
      const initSqlJs = (await import('sql.js')).default;
      const SQL = await initSqlJs();
      const dbBuf = readFileSync(dbPath);
      const db = new SQL.Database(dbBuf);

      // 读取 session -> project 映射
      const sessionMap = {};
      const sessRows = db.exec('SELECT id, directory, path FROM session');
      if (sessRows[0]) {
        for (const [id, dir, p] of sessRows[0].values) {
          sessionMap[id] = (p || dir || '').replace(/\\/g, '/');
        }
      }

      // 读取所有 message
      const msgRows = db.exec(
        "SELECT id, session_id, time_created, data FROM message ORDER BY time_created"
      );
      if (!msgRows[0]) { db.close(); return records; }

      // 计算 delta tokens（message 中 tokens 是累计值）
      let lastTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

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

          const delta = {
            input: Math.max(0, current.input - lastTokens.input),
            output: Math.max(0, current.output - lastTokens.output),
            cacheRead: Math.max(0, current.cacheRead - lastTokens.cacheRead),
            cacheWrite: Math.max(0, current.cacheWrite - lastTokens.cacheWrite),
          };
          lastTokens = current;

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

      db.close();
    } catch (err) {
      console.warn('OpenCode parse error:', err.message);
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
    } catch {}
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
    } catch {}
    return calls;
  }
}
