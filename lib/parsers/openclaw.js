// lib/parsers/openclaw.js
import { readdirSync, readFileSync, lstatSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { BaseParser, splitMulti as splitPaths } from './base.js';
import { createUsageRecord } from '../models/usage-record.js';

// 参考 ccusage openclaw/paths.rs：默认候选 4 目录（含别名 clawdbot/moltbot/moldbot）
const CANDIDATES = ['.openclaw', '.clawdbot', '.moltbot', '.moldbot'];

export class OpenclawParser extends BaseParser {
  getInfo() {
    // envVar: 参考名 OPENCLAW_DIR 优先，旧名 OPENCLAW_STATE_DIR 兼容
    return { name: 'openclaw', displayName: 'OpenClaw', defaultDir: '~/.openclaw', envVar: ['OPENCLAW_DIR', 'OPENCLAW_STATE_DIR'] };
  }

  getDataDirs(config) {
    const fromConfig = config.openclawDir && config.openclawDir !== '' ? config.openclawDir : '';
    if (fromConfig) return splitPaths(fromConfig);
    for (const v of ['OPENCLAW_DIR', 'OPENCLAW_STATE_DIR']) {
      if (process.env[v]) return splitPaths(process.env[v]);
    }
    const home = homedir();
    if (!home) return [];
    return CANDIDATES.map(c => join(home, c));
  }

  async detect(config) {
    return this.getDataDirs(config).some(dir => existsSync(dir));
  }

  async parse(config, options = {}) {
    const records = [];
    for (const dir of this.getDataDirs(config)) {
      if (!existsSync(dir)) continue;
      // sessions.json 索引优先（本项目兼容）；无索引则递归 .jsonl（含归档），对齐参考
      const indexed = this._parseIndex(join(dir, 'sessions.json'));
      if (indexed.length) { records.push(...indexed); continue; }
      this._walkDir(dir, records);
    }
    return records;
  }

  _parseIndex(indexPath) {
    if (!existsSync(indexPath)) return [];
    try {
      const raw = JSON.parse(readFileSync(indexPath, 'utf-8'));
      const entries = Array.isArray(raw) ? raw : (raw.sessions || raw.entries || []);
      return entries.filter(e => e && e.sessionId).map(e => createUsageRecord({
        timestamp: this._toISO(e.updatedAt) || this._toISO(e.createdAt) || '',
        tool: 'openclaw', sessionId: e.sessionId, model: e.model || '',
        inputTokens: e.inputTokens || 0, outputTokens: e.outputTokens || 0,
        costUSD: e.costUsd ?? null, project: '',
        metadata: { type: 'assistant', _fromIndex: true },
      }));
    } catch (e) { console.warn('[openclaw] sessions.json error', e.message); return []; }
  }

  _toISO(v) {
    if (!v) return '';
    if (typeof v === 'number') return new Date(v).toISOString();
    const d = new Date(v);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  }

  // 递归收集会话 .jsonl（含 .jsonl.deleted.* / .jsonl.reset.* 归档），跳过 symlink
  _walkDir(dir, records) {
    let entries = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e);
      let st; try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue; // 防 symlink 循环
      if (st.isDirectory()) { this._walkDir(full, records); continue; }
      if (!st.isFile() || !isSessionFile(e)) continue;
      const sid = e.replace(/\.jsonl.*$/, '');
      try {
        for (const line of readFileSync(full, 'utf-8').split('\n')) {
          if (!line.trim()) continue;
          let obj; try { obj = JSON.parse(line); } catch { continue; }
          const u = obj.message?.usage || obj.usage || {};
          const inT = u.input || u.inputTokens || 0;
          const outT = u.output || u.outputTokens || 0;
          if (!inT && !outT) continue;
          records.push(createUsageRecord({
            timestamp: obj.timestamp || new Date().toISOString(),
            tool: 'openclaw', sessionId: obj.sessionId || sid,
            model: obj.message?.model || obj.model || '',
            inputTokens: inT, outputTokens: outT,
            cacheReadTokens: u.cacheRead || 0, cacheWriteTokens: u.cacheWrite || 0,
            costUSD: u.costUsd ?? null, project: '',
            metadata: { type: 'assistant' },
          }));
        }
      } catch (ex) { console.warn(`[openclaw] 解析失败: ${full}`, ex.message); }
    }
  }

  async getVersion() { return null; }
}

function isSessionFile(name) {
  const i = name.indexOf('.jsonl');
  if (i < 0) return false;
  const suffix = name.slice(i);
  return suffix === '.jsonl' || suffix.startsWith('.jsonl.deleted.') || suffix.startsWith('.jsonl.reset.');
}
