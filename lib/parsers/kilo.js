// lib/parsers/kilo.js
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { BaseParser } from './base.js';
import { createUsageRecord } from '../models/usage-record.js';
import { openDb } from './_sqlite.js';

const num = v => Number(v) || 0;

export class KiloParser extends BaseParser {
  getInfo() {
    return { name: 'kilo', displayName: 'Kilo', defaultDir: '~/.local/share/kilo', envVar: 'KILO_DATA_DIR' };
  }

  getDataDirs(config) {
    const fromConfig = config.kiloDir && config.kiloDir !== '' ? config.kiloDir : '';
    if (fromConfig) return splitPaths(fromConfig);
    if (process.env.KILO_DATA_DIR) return splitPaths(process.env.KILO_DATA_DIR);
    const home = homedir();
    return home ? [join(home, '.local', 'share', 'kilo')] : [];
  }

  async detect(config) {
    return this.getDataDirs(config).some(dir => existsSync(join(dir, 'kilo.db')));
  }

  // 对齐参考 ccusage adapter/kilo：~/.local/share/kilo/kilo.db，表 message(id, session_id, data JSON)
  // data 为 KiloMessage: {role:"assistant", modelID, time:{created}, tokens:{input,output,cache:{read,write},reasoning,total}, cost, providerID}
  // 仅 assistant；total fallback；按 message.id 去重。
  async parse(config, options = {}) {
    const seen = new Set();
    const records = [];
    for (const dir of this.getDataDirs(config)) {
      const dbPath = join(dir, 'kilo.db');
      if (!existsSync(dbPath)) continue;
      const got = await openDb(dbPath);
      if (!got) continue;
      const { db, close } = got;
      try {
        let rows;
        try { rows = db.exec('SELECT id, session_id, data FROM message'); } catch { continue; }
        if (!rows[0]) continue;
        for (const [rowId, rowSessionId, dataJson] of rows[0].values) {
          let value; try { value = JSON.parse(dataJson); } catch { continue; }
          const rec = this._messageToRecord(value, rowSessionId);
          if (!rec) continue;
          const msgId = value.id || `${dbPath}:${rowId}`;
          if (seen.has(msgId)) continue;
          seen.add(msgId);
          records.push(rec);
        }
      } catch (e) { console.warn('[kilo] parse error', e.message); }
      finally { try { close(); } catch { /* ignore */ } }
    }
    return records;
  }

  _messageToRecord(value, rowSessionId) {
    if (!value || value.role !== 'assistant') return null;
    const tokens = value.tokens;
    if (!tokens) return null;
    let inputTokens = num(tokens.input);
    let outputTokens = num(tokens.output);
    const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
    const cacheWrite = num(cache.write);
    const cacheRead = num(cache.read);
    const reasoning = num(tokens.reasoning);
    const total = num(tokens.total);
    if (!inputTokens && !outputTokens && total) outputTokens = total;
    if (!inputTokens && !outputTokens && !cacheWrite && !cacheRead && !reasoning && !total) return null;
    const model = value.modelID || '';
    if (!model) return null; // 参考要求 model
    const created = value.time && typeof value.time.created === 'number' ? value.time.created : null;
    const ts = created ? normalizeTimestampMs(created) : '';
    if (!ts) return null; // 参考要求有效 timestamp
    const sessionId = value.session_id || rowSessionId || '';
    const cost = typeof value.cost === 'number' ? value.cost : null;
    const metadata = { type: 'assistant', reasoningTokens: reasoning };
    if (value.providerID) metadata.provider = value.providerID;
    return createUsageRecord({
      timestamp: ts, tool: 'kilo', sessionId, model,
      inputTokens, outputTokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
      costUSD: cost, project: '', metadata,
    });
  }

  async getVersion() { return null; }
}

// 参考 normalize_timestamp：<1e12 视为秒，否则毫秒
function normalizeTimestampMs(v) {
  if (v <= 0) return '';
  const ms = v < 1e12 ? v * 1000 : v;
  const d = new Date(ms);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

function splitPaths(raw) {
  return String(raw).split(',').map(s => s.trim()).filter(s => s !== '');
}
