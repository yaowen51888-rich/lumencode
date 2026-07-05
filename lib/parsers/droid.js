// lib/parsers/droid.js
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';
import { BaseParser } from './base.js';
import { createUsageRecord } from '../models/usage-record.js';

const num = v => Number(v) || 0;

export class DroidParser extends BaseParser {
  getInfo() {
    // envVar: 参考名 DROID_SESSIONS_DIR 优先，旧名 FACTORY_HOME 兼容（语义=父目录，补 sessions）
    return { name: 'droid', displayName: 'Droid', defaultDir: '~/.factory/sessions', envVar: ['DROID_SESSIONS_DIR', 'FACTORY_HOME'] };
  }

  getDataDirs(config) {
    const fromConfig = config.droidDir && config.droidDir !== '' ? config.droidDir : '';
    if (fromConfig) return splitPaths(fromConfig);
    // FACTORY_HOME 旧名指 ~/.factory 父目录，需补 sessions；DROID_SESSIONS_DIR 直接用
    if (process.env.DROID_SESSIONS_DIR) return splitPaths(process.env.DROID_SESSIONS_DIR);
    if (process.env.FACTORY_HOME) return splitPaths(process.env.FACTORY_HOME).map(p => join(p, 'sessions'));
    const home = homedir();
    return home ? [join(home, '.factory', 'sessions')] : [];
  }

  async detect(config) {
    return this.getDataDirs(config).some(dir => existsSync(dir));
  }

  // 对齐参考 ccusage droid/parser.rs：解析 *.settings.json，重复 session_id 取最新 timestamp
  async parse(config, options = {}) {
    const bySession = new Map();
    for (const dir of this.getDataDirs(config)) {
      if (!existsSync(dir)) continue;
      for (const filePath of this._findSettingsFiles(dir)) {
        const rec = this._parseSettingsFile(filePath);
        if (!rec) continue;
        const prev = bySession.get(rec.sessionId);
        // 取 timestamp 更新的快照（同 session 多 .settings.json 文件，如 archive/）
        if (!prev || (rec.timestamp || '') > (prev.timestamp || '')) {
          bySession.set(rec.sessionId, rec);
        }
      }
    }
    return Array.from(bySession.values());
  }

  _findSettingsFiles(root) {
    const out = [];
    const walk = (d) => {
      let entries = [];
      try { entries = readdirSync(d); } catch { return; }
      for (const e of entries) {
        const full = join(d, e);
        let st; try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) { walk(full); continue; }
        if (e.endsWith('.settings.json')) out.push(full);
      }
    };
    walk(root);
    return out;
  }

  _parseSettingsFile(filePath) {
    let obj;
    try { obj = JSON.parse(readFileSync(filePath, 'utf-8')); }
    catch { return null; }
    if (!obj || typeof obj !== 'object') return null;
    const u = obj.tokenUsage || {};
    let inputTokens = num(u.inputTokens);
    let outputTokens = num(u.outputTokens);
    const cacheWrite = num(u.cacheCreationTokens);
    const cacheRead = num(u.cacheReadTokens);
    const thinking = num(u.thinkingTokens);
    const total = num(u.totalTokens);
    if (!inputTokens && !outputTokens && total) outputTokens = total; // total fallback
    if (!inputTokens && !outputTokens && !cacheWrite && !cacheRead && !thinking && !total) return null;

    const sessionId = basename(filePath).replace(/\.settings\.json$/, '');
    const provider = normalizeProvider(obj.providerLock);
    let model = obj.model ? normalizeModelName(obj.model) : '';
    if (!model) model = extractSidecarModel(filePath) || defaultModel(provider);

    const ts = obj.providerLockTimestamp
      ? (isNaN(Date.parse(obj.providerLockTimestamp)) ? fileMtimeISO(filePath) : new Date(obj.providerLockTimestamp).toISOString())
      : fileMtimeISO(filePath);

    return createUsageRecord({
      timestamp: ts, tool: 'droid', sessionId, model,
      inputTokens, outputTokens, cacheWriteTokens: cacheWrite, cacheReadTokens: cacheRead,
      costUSD: null, project: '',
      metadata: { type: 'assistant', provider, reasoningTokens: thinking },
    });
  }

  async getVersion() { return null; }
}

// model 归一化：去 custom: 前缀、[..] 后缀、小写、. /空格/- → - 合并（对齐参考 normalize_droid_model_name）
function normalizeModelName(model) {
  const raw = String(model).replace(/^custom:/, '');
  let depth = 0; let cleaned = '';
  for (const ch of raw) {
    if (ch === '[') { depth++; continue; }
    if (ch === ']') { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0) cleaned += ch;
  }
  return cleaned.trim().replace(/[.\s-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

function normalizeProvider(v) {
  if (!v) return 'unknown';
  const s = String(v).trim().toLowerCase().replace(/-/g, '_');
  if (!s) return 'unknown';
  if (['claude', 'anthropic'].includes(s)) return 'anthropic';
  if (s === 'openai') return 'openai';
  if (['google', 'google_ai', 'gemini', 'vertex', 'vertex_ai'].includes(s)) return 'google';
  if (['xai', 'x_ai', 'grok'].includes(s)) return 'xai';
  return s;
}

function defaultModel(provider) {
  return { anthropic: 'claude-unknown', openai: 'gpt-unknown', google: 'gemini-unknown', xai: 'grok-unknown' }[provider] || 'unknown';
}

// sidecar <sessionId>.jsonl 含 "Model: XXX" 行 → 提取归一化 model
function extractSidecarModel(settingsPath) {
  const prefix = basename(settingsPath).replace(/\.settings\.json$/, '');
  let content;
  try { content = readFileSync(join(dirname(settingsPath), `${prefix}.jsonl`), 'utf-8'); }
  catch { return ''; }
  for (const line of content.split('\n').slice(0, 500)) {
    const m = line.match(/Model:\s*([^"\\\[]+)/);
    if (m) {
      const normalized = normalizeModelName(m[1].trim());
      if (normalized) return normalized;
    }
  }
  return '';
}

function fileMtimeISO(filePath) {
  try { return new Date(statSync(filePath).mtimeMs).toISOString(); }
  catch { return ''; }
}

function splitPaths(raw) {
  return String(raw).split(',').map(s => s.trim()).filter(s => s !== '');
}
