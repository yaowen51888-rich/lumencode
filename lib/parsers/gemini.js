import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { BaseParser } from './base.js';
import { createUsageRecord } from '../models/usage-record.js';

const TOKEN_KEYS = {
  input: ['input', 'prompt', 'input_tokens', 'prompt_tokens', 'promptTokenCount'],
  output: ['output', 'candidates', 'output_tokens', 'candidates_tokens', 'candidatesTokenCount'],
  cached: ['cached', 'cached_tokens', 'cachedContentTokenCount'],
  thoughts: ['thoughts', 'reasoning', 'thoughts_tokens', 'reasoning_tokens'],
  tool: ['tool', 'tool_tokens'],
  total: ['total', 'total_tokens'],
};

function firstNum(obj, keys) {
  for (const k of keys) {
    const v = Number(obj?.[k]);
    if (v > 0) return v;
  }
  return 0;
}

export class GeminiParser extends BaseParser {
  getInfo() {
    // envVar: 参考名 GEMINI_DATA_DIR 优先，旧名 GEMINI_HOME 兼容
    return { name: 'gemini', displayName: 'Gemini CLI', defaultDir: '~/.gemini', envVar: ['GEMINI_DATA_DIR', 'GEMINI_HOME'] };
  }

  async detect(config) {
    const dir = this.getDataDir(config);
    if (!dir) return false;
    try { return statSync(join(dir, 'tmp')).isDirectory(); } catch { return false; }
  }

  // 收集 chat 文件：[{path, sessionId, project}]。GeminiParser 在 tmp/ 下递归收 .json + .jsonl
  // （对齐参考 ccusage gemini/paths.rs）。QwenParser 覆写此方法适配 projects/<p>/chats 结构。
  _collectChatFiles(dir) {
    const out = [];
    this._walkCollect(join(dir, 'tmp'), out);
    return out;
  }

  _walkCollect(d, out) {
    let entries = [];
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      const full = join(d, e);
      let st; try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { this._walkCollect(full, out); continue; }
      if (e.endsWith('.json') || e.endsWith('.jsonl')) {
        out.push({ path: full, sessionId: e.replace(/\.(json|jsonl)$/, ''), project: '' });
      }
    }
  }

  async parse(config, options = {}) {
    const dir = this.getDataDir(config);
    const records = [];
    if (!dir) return records;

    for (const { path: filePath, sessionId, project } of this._collectChatFiles(dir)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        if (filePath.endsWith('.json')) {
          // .json 整体单文档
          let obj; try { obj = JSON.parse(content); } catch { continue; }
          this._pushRecords(obj, sessionId, project, records);
        } else {
          // .jsonl 按行
          for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            let obj; try { obj = JSON.parse(line); } catch { continue; }
            this._pushRecords(obj, sessionId, project, records);
          }
        }
      } catch (e) { console.warn(`[${this.getInfo().name}] 解析失败: ${filePath}`, e.message); }
    }
    return records;
  }

  // 单 JSON 对象 → records。覆盖三种形态：
  //  1) messages[type:gemini]（每条含 tokens）
  //  2) 顶层 type:gemini 直连事件
  //  3) 顶层 tokens / usageMetadata / stats
  _pushRecords(obj, sessionId, project, records) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj.messages)) {
      for (const m of obj.messages) {
        if (!m || m.type !== 'gemini') continue;
        const rec = this._recordFromLine(m, sessionId, project);
        if (rec) records.push(rec);
      }
      return;
    }
    const rec = this._recordFromLine(obj, sessionId, project);
    if (rec) records.push(rec);
  }

  // 单记录对象 → UsageRecord | null。tokens / usageMetadata / stats 三种字段名兼容。
  _recordFromLine(obj, sessionId, project) {
    const tokens = obj.tokens || obj.usageMetadata || obj.stats || obj;
    const inputTokens = firstNum(tokens, TOKEN_KEYS.input);
    const outputTokens = firstNum(tokens, TOKEN_KEYS.output);
    if (!inputTokens && !outputTokens) return null;
    const cacheRead = firstNum(tokens, TOKEN_KEYS.cached);
    const thoughts = firstNum(tokens, TOKEN_KEYS.thoughts);
    const tool = firstNum(tokens, TOKEN_KEYS.tool);
    const total = firstNum(tokens, TOKEN_KEYS.total);
    const metadata = { type: 'assistant' };
    if (thoughts) metadata.reasoningTokens = thoughts;
    if (tool) metadata.toolTokens = tool;
    if (total) metadata.totalTokens = total;
    if (!obj.tokens && obj.usageMetadata) metadata.degraded = `${this.getInfo().name}-usageMetadata`;
    return createUsageRecord({
      timestamp: obj.timestamp || obj.startTime || obj.created_at || new Date().toISOString(),
      tool: this.getInfo().name,
      sessionId: obj.sessionId || obj.session_id || sessionId,
      model: obj.model || obj.message?.model || obj.record?.model || '',
      inputTokens, outputTokens, cacheReadTokens: cacheRead,
      costUSD: obj.costUSD ?? null, project: obj.cwd || project || '',
      metadata,
    });
  }
}
