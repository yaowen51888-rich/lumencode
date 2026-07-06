// lib/parsers/copilot.js
// GitHub Copilot CLI OpenTelemetry 文件导出解析。
// ponytail: 参考实现含 4 源（ChatSpan/InferenceLog/AgentTurnLog/AgentSummarySpan）跨源优先级去重，
// 本实现简化为：提取 attributes.gen_ai.usage.* token + 按 traceId:spanId 去重。
// 已知简化：未做跨源重复消除，真实数据可能多计（同一调用多 OTel 记录）。待真实样本接入后复核。
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { BaseParser, num, splitMulti as splitPaths } from './base.js';
import { createUsageRecord } from '../models/usage-record.js';

const MODEL_ATTRS = ['gen_ai.response.model', 'gen_ai.request.model'];
const SESSION_ATTRS = [
  'gen_ai.conversation.id', 'copilot_chat.session_id', 'copilot_chat.chat_session_id',
  'session.id', 'github.copilot.interaction_id', 'gen_ai.response.id',
];

export class CopilotParser extends BaseParser {
  getInfo() {
    // envVar: 参考 COPILOT_OTEL_FILE_EXPORTER_PATH（指向单个文件或目录），无标准数据目录 env
    return { name: 'copilot', displayName: 'GitHub Copilot CLI', defaultDir: '~/.copilot/otel', envVar: ['COPILOT_OTEL_FILE_EXPORTER_PATH', 'COPILOT_DATA_DIR'] };
  }

  getDataDirs(config) {
    const fromConfig = config.copilotDir && config.copilotDir !== '' ? config.copilotDir : '';
    if (fromConfig) return splitPaths(fromConfig);
    for (const v of ['COPILOT_OTEL_FILE_EXPORTER_PATH', 'COPILOT_DATA_DIR']) {
      if (process.env[v]) return splitPaths(process.env[v]);
    }
    const home = homedir();
    return home ? [join(home, '.copilot', 'otel')] : [];
  }

  async detect(config) {
    return this.getDataDirs(config).some(dir => {
      try { return statSync(dir).isDirectory(); } catch { return false; }
    });
  }

  async parse(config, options = {}) {
    const seen = new Set();
    const records = [];
    for (const dir of this.getDataDirs(config)) {
      let files = [];
      try { files = readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => join(dir, f)); }
      catch { continue; }
      for (const filePath of files) {
        try {
          for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
            if (!line.trim() || !line.includes('"attributes"')) continue;
            let obj; try { obj = JSON.parse(line); } catch { continue; }
            const rec = this._recordFromOtel(obj);
            if (!rec) continue;
            const dedup = rec.sessionId + '|' + rec.metadata.dedupKey;
            if (seen.has(dedup)) continue;
            seen.add(dedup);
            records.push(rec);
          }
        } catch (e) { console.warn(`[copilot] 解析失败: ${filePath}`, e.message); }
      }
    }
    return records;
  }

  _recordFromOtel(obj) {
    const attrs = obj.attributes;
    if (!attrs || typeof attrs !== 'object') return null;
    const input = num(attrs['gen_ai.usage.input_tokens']);
    const output = num(attrs['gen_ai.usage.output_tokens']);
    const cacheRead = num(attrs['gen_ai.usage.cache_read.input_tokens']);
    const cacheCreation = num(attrs['gen_ai.usage.cache_write.input_tokens'])
      || num(attrs['gen_ai.usage.cache_creation.input_tokens']);
    const reasoning = num(attrs['gen_ai.usage.reasoning.output_tokens'])
      || num(attrs['gen_ai.usage.reasoning_tokens']);
    const total = num(attrs['gen_ai.usage.total_tokens'])
      || num(attrs['gen_ai.usage.total.token_count']);
    // 参考：input 减去与 cacheRead 的重叠部分
    const inputAdj = input - Math.min(input, cacheRead);
    let outputTokens = output;
    if (!inputAdj && !outputTokens && total) outputTokens = total;
    if (!inputAdj && !outputTokens && !cacheCreation && !cacheRead && !reasoning && !total) return null;
    const model = firstStr(attrs, MODEL_ATTRS) || 'unknown';
    const sessionId = firstStr(attrs, SESSION_ATTRS)
      || str(obj.traceId) || str(obj.spanContext && obj.spanContext.traceId) || 'unknown-session';
    const traceId = str(obj.traceId) || str(obj.spanContext && obj.spanContext.traceId);
    const spanId = str(obj.spanId) || str(obj.spanContext && obj.spanContext.spanId);
    const ts = this._timestampFrom(obj);
    const dedupKey = (traceId && spanId) ? `${traceId}:${spanId}` : `span:${sessionId}:${ts}`;
    return createUsageRecord({
      timestamp: ts, tool: 'copilot', sessionId, model,
      inputTokens: inputAdj, outputTokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheCreation,
      costUSD: null, project: '',
      metadata: { type: 'assistant', reasoningTokens: reasoning, dedupKey },
    });
  }

  // OTel timestamp 优先级链：[sec,nanos] 数组 → 标量（自适应 s/ms/μs/ns）→ timeUnixNano → now
  _timestampFrom(obj) {
    return this._tsFromHrTime(obj)
      || this._tsFromScalar(obj)
      || this._tsFromNano(obj)
      || new Date().toISOString();
  }

  // 高分辨率时间对 [seconds, nanoseconds]
  _tsFromHrTime(obj) {
    for (const key of ['endTime', 'startTime', 'hrTime', '_hrTime', 'time']) {
      const v = obj[key];
      if (Array.isArray(v) && v.length >= 2 && num(v[0]) > 0) {
        const ms = num(v[0]) * 1000 + num(v[1]) / 1e6;
        if (ms > 0) return new Date(ms).toISOString();
      }
    }
    return '';
  }

  // 标量时间戳，按量级自适应单位（ns/μs/ms/s）
  _tsFromScalar(obj) {
    for (const key of ['timestamp', 'observedTimestamp']) {
      const v = obj[key];
      if (typeof v === 'number' && v > 0) {
        const ms = v >= 1e17 ? v / 1e6 : v >= 1e14 ? v / 1e3 : v >= 1e11 ? v : v * 1e3;
        return new Date(ms).toISOString();
      }
    }
    return '';
  }

  _tsFromNano(obj) {
    const nano = num(obj.timeUnixNano);
    return nano > 0 ? new Date(nano / 1e6).toISOString() : '';
  }

  async getVersion() { return null; }
}

function firstStr(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}
function str(v) { return (typeof v === 'string' && v.trim()) ? v.trim() : ''; }
