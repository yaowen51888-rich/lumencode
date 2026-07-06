import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { BaseParser, num, epochMsToISO as msToIso } from './base.js';
import { createUsageRecord } from '../models/usage-record.js';
import { openDb, pickTable, columns } from './_sqlite.js';

export class GooseParser extends BaseParser {
  getInfo() {
    // envVar: 本项目 GOOSE_DATA_DIR + 参考 ccusage 的 GOOSE_PATH_ROOT（语义统一为「含 sessions/ 子目录的根」）
    return { name: 'goose', displayName: 'Goose', defaultDir: '~/.local/share/goose', envVar: ['GOOSE_DATA_DIR', 'GOOSE_PATH_ROOT'] };
  }

  async detect(config) {
    const dir = this.getDataDir(config);
    if (!dir) return false;
    const sessionsDir = join(dir, 'sessions');
    try {
      if (existsSync(join(sessionsDir, 'sessions.db'))) return true;
      return readdirSync(sessionsDir).some(f => f.endsWith('.jsonl'));
    } catch { return false; }
  }

  async parse(config, options = {}) {
    const dir = this.getDataDir(config);
    const records = [];
    if (!dir) return records;
    const sessionsDir = join(dir, 'sessions');

    // 优先 SQLite（v1.10+）
    const dbPath = join(sessionsDir, 'sessions.db');
    if (existsSync(dbPath)) {
      const sqliteRecords = await this._parseSqlite(dbPath);
      records.push(...sqliteRecords);
      if (records.length) return records;
    }

    // legacy JSONL fallback（v1.10 前，每会话一文件）
    try {
      const files = readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
      for (const f of files) records.push(...this._parseLegacyJsonl(join(sessionsDir, f)));
    } catch (e) { console.warn('[goose] parse error', e.message); }
    return records;
  }

  // SQLite schema 对齐参考 ccusage (goose/loader.rs)：
  //   表 sessions(复数)，列含 model_config_json(JSON) / provider_name / created_at /
  //   total_tokens / input_tokens / output_tokens / accumulated_*。
  // 动态探测表名/列以容忍版本差异；model 从 model_config_json.modelName 解析；
  // token 优先 accumulated_*，回退普通列；reasoning = total - input - output。
  async _parseSqlite(dbPath) {
    const records = [];
    const got = await openDb(dbPath);
    if (!got) return records;
    const { db, close } = got;
    try {
      const table = pickTable(db, ['sessions', 'session']);
      if (!table) return records;
      const cols = columns(db, table);
      const wanted = [
        'id', 'model_config_json', 'provider_name', 'created_at',
        'total_tokens', 'input_tokens', 'output_tokens',
        'accumulated_total_tokens', 'accumulated_input_tokens', 'accumulated_output_tokens',
      ];
      const present = wanted.filter(c => cols.includes(c));
      if (!present.includes('id')) return records;
      let sql = `SELECT ${present.map(c => `"${c}"`).join(', ')} FROM "${table}"`;
      if (present.includes('model_config_json')) {
        sql += ` WHERE model_config_json IS NOT NULL AND TRIM(model_config_json) != ''`;
      }
      let rows;
      try { rows = db.exec(sql); } catch { return records; }
      if (!rows[0]) return records;
      const idx = c => present.indexOf(c);
      for (const row of rows[0].values) {
        const at = c => { const i = idx(c); return i >= 0 ? row[i] : null; };
        const id = at('id');
        if (!id) continue;
        const hasModelConfig = present.includes('model_config_json');
        const model = parseModelName(at('model_config_json'));
        // 有 model_config_json 列但解析失败（无效 JSON/无 modelName）→ 跳过该行，对齐参考 ccusage
        if (hasModelConfig && !model) continue;
        const inputTokens = num(at('accumulated_input_tokens')) || num(at('input_tokens'));
        const outputTokens = num(at('accumulated_output_tokens')) || num(at('output_tokens'));
        const totalTokens = num(at('accumulated_total_tokens')) || num(at('total_tokens')) || (inputTokens + outputTokens);
        if (!inputTokens && !outputTokens && !totalTokens) continue;
        const reasoning = Math.max(0, totalTokens - inputTokens - outputTokens);
        const provider = str(at('provider_name'));
        const ts = parseGooseTs(at('created_at'));
        const metadata = { type: 'assistant', totalTokens, reasoningTokens: reasoning };
        if (provider) metadata.provider = provider;
        records.push(createUsageRecord({
          timestamp: ts, tool: 'goose', sessionId: str(id),
          model, inputTokens, outputTokens, costUSD: null, project: '',
          metadata,
        }));
      }
    } catch (e) { console.warn('[goose] sqlite error', e.message); }
    finally { try { close(); } catch { /* ignore */ } }
    return records;
  }

  _parseLegacyJsonl(filePath) {
    const records = [];
    const sessionId = filePath.split(/[\\/]/).pop().replace(/\.jsonl$/, '');
    let lastTokens = null;
    try {
      const lines = readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        let obj; try { obj = JSON.parse(line); } catch { continue; }
        const tok = obj.tokenCount || obj.usage || obj.session_token_count;
        if (!tok) continue;
        const cur = { input: tok.inputTokens || tok.input || 0, output: tok.outputTokens || tok.output || 0 };
        const delta = lastTokens
          ? { input: Math.max(0, cur.input - lastTokens.input), output: Math.max(0, cur.output - lastTokens.output) }
          : cur;
        lastTokens = cur;
        if (!delta.input && !delta.output) continue;
        records.push(createUsageRecord({
          timestamp: obj.timestamp || new Date().toISOString(), tool: 'goose', sessionId,
          model: obj.model || '', inputTokens: delta.input, outputTokens: delta.output,
          project: (obj.workingDirectory || obj.cwd || '').replace(/\\/g, '/'),
          metadata: { type: 'assistant' },
        }));
      }
    } catch (e) { console.warn('[goose] jsonl error', e.message); }
    return records;
  }

  async getVersion() { return null; }
}

// ---- goose 专用辅助（pickTable/columns 复用 _sqlite.js） ----

function parseModelName(json) {
  if (!json) return '';
  try {
    const cfg = JSON.parse(json);
    return cfg.modelName || cfg.model_name || cfg.model || '';
  } catch { return ''; }
}

function parseGooseTs(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return msToIso(v);
  const s = String(v).trim();
  if (!s) return '';
  if (/^\d+$/.test(s)) return msToIso(Number(s));
  // "2026-05-01 01:02:03" → ISO（空格→T，缺时区补 Z）
  const normalized = s.replace(' ', 'T');
  const withTz = /[zZ]|[+-]\d\d:?\d\d$/.test(normalized) ? normalized : normalized + 'Z';
  const d = new Date(withTz);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

function str(v) { return v == null ? '' : String(v); }
