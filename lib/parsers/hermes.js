// lib/parsers/hermes.js
import { existsSync } from 'fs';
import { join } from 'path';
import { BaseParser, num, epochMsToISO as msToIso } from './base.js';
import { createUsageRecord } from '../models/usage-record.js';
import { openDb, pickTable, columns } from './_sqlite.js';

export class HermesParser extends BaseParser {
  getInfo() {
    return { name: 'hermes', displayName: 'Hermes Agent', defaultDir: '~/.hermes', envVar: 'HERMES_HOME' };
  }

  async detect(config) {
    const dir = this.getDataDir(config);
    if (!dir) return false;
    return existsSync(join(dir, 'state.db'));
  }

  // 对齐参考 ccusage (hermes/loader.rs)：表 sessions，started_at 为 REAL（秒或毫秒），
  // 可选列 billing_provider/message_count/estimated_cost_usd/actual_cost_usd。
  // 动态探测列以容忍版本差异；参考 schema 无 ended_at，故不硬依赖。
  // 全 0（含 cost）跳过；cost 取 actual_cost_usd 优先，回退 estimated_cost_usd。
  async parse(config, options = {}) {
    const dir = this.getDataDir(config);
    const records = [];
    if (!dir) return records;
    const got = await openDb(join(dir, 'state.db'));
    if (!got) return records;
    const { db, close } = got;
    try {
      const table = pickTable(db, ['sessions', 'session']);
      if (!table) return records;
      const cols = columns(db, table);
      const wanted = [
        'id', 'model', 'billing_provider', 'started_at', 'message_count',
        'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
        'reasoning_tokens', 'estimated_cost_usd', 'actual_cost_usd',
      ];
      const present = wanted.filter(c => cols.includes(c));
      if (!present.includes('id') || !present.includes('model')) return records;
      const sql = `SELECT ${present.map(c => `"${c}"`).join(', ')} FROM "${table}" WHERE model IS NOT NULL AND TRIM(model) != ''`;
      let rows;
      try { rows = db.exec(sql); } catch { return records; }
      if (!rows[0]) return records;
      const idx = c => present.indexOf(c);
      for (const row of rows[0].values) {
        const at = c => { const i = idx(c); return i >= 0 ? row[i] : null; };
        const id = at('id');
        const model = str(at('model'));
        if (!id || !model) continue;
        const inputTokens = num(at('input_tokens'));
        const outputTokens = num(at('output_tokens'));
        const cacheRead = num(at('cache_read_tokens'));
        const cacheWrite = num(at('cache_write_tokens'));
        const reasoning = num(at('reasoning_tokens'));
        const messageCount = num(at('message_count'));
        const provider = str(at('billing_provider'));
        const actualCost = fnum(at('actual_cost_usd'));
        const estCost = fnum(at('estimated_cost_usd'));
        const cost = actualCost != null ? actualCost : estCost;
        if (!inputTokens && !outputTokens && !cacheRead && !cacheWrite && !reasoning && cost == null) continue;
        const ts = msToIso(at('started_at'));
        const metadata = { type: 'assistant', reasoningTokens: reasoning, messageCount };
        if (provider) metadata.provider = provider;
        records.push(createUsageRecord({
          timestamp: ts, tool: 'hermes', sessionId: str(id), model,
          inputTokens, outputTokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
          costUSD: cost != null ? cost : null, project: '', metadata,
        }));
      }
    } catch (e) { console.warn('[hermes] parse error', e.message); }
    finally { try { close(); } catch { /* close 失败忽略 */ } }
    return records;
  }

  async getVersion() { return null; }
}

// ---- 辅助（str/fnum 本地；num/msToIso 复用 base.js；pickTable/columns 复用 _sqlite.js） ----
function str(v) { return v == null ? '' : String(v); }
function fnum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
