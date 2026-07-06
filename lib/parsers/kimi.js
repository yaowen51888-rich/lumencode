import { readFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { BaseParser, num, walkFiles } from './base.js';
import { createUsageRecord } from '../models/usage-record.js';

export class KimiParser extends BaseParser {
  getInfo() {
    // envVar: 参考名 KIMI_DATA_DIR 优先，旧名 KIMI_SHARE_DIR 兼容迁移
    return { name: 'kimi', displayName: 'Kimi CLI', defaultDir: '~/.kimi', envVar: ['KIMI_DATA_DIR', 'KIMI_SHARE_DIR'] };
  }

  async detect(config) {
    const dir = this.getDataDir(config);
    if (!dir) return false;
    try { return statSync(join(dir, 'sessions')).isDirectory(); } catch { return false; }
  }

  // 真实结构（实测 ~/.kimi）：sessions/<workdirHash>/<sessionId>/wire.jsonl
  //   wire.jsonl 每行 {timestamp, message:{type:"StatusUpdate", payload:{token_usage:{input_other,output,input_cache_read,input_cache_creation}, message_id, ...}}}
  //   token_usage 为单次调用值（非累积），直接映射；按 message_id 去重。
  //   参考 ccusage adapter/kimi/parser.rs：input_other → input tokens。
  //   model 不在日志中，用 kimi-for-coding 别名（pricing 已映射到 kimi-k2.5）。
  async parse(config, options = {}) {
    const dir = this.getDataDir(config);
    const records = [];
    if (!dir) return records;
    const sessionsDir = join(dir, 'sessions');
    if (!existsSync(sessionsDir)) return records;

    const seen = new Set(); // 按 message_id 去重
    for (const wire of walkFiles(sessionsDir, (f, s, e) => e === 'wire.jsonl')) {
      const sessionId = this._sessionIdFromPath(wire);
      let lines = [];
      try { lines = readFileSync(wire, 'utf-8').split('\n').filter(l => l.trim()); }
      catch { continue; }
      for (const line of lines) {
        let obj; try { obj = JSON.parse(line); } catch { continue; }
        const msg = obj?.message;
        const usage = msg?.type === 'StatusUpdate' ? msg?.payload?.token_usage : null;
        if (!usage) continue;
        const messageId = msg?.payload?.message_id;
        if (messageId) {
          if (seen.has(messageId)) continue;
          seen.add(messageId);
        }
        const inputTokens = num(usage.input_other) + num(usage.input);
        const outputTokens = num(usage.output);
        const cacheReadTokens = num(usage.input_cache_read);
        const cacheWriteTokens = num(usage.input_cache_creation);
        if (!inputTokens && !outputTokens && !cacheReadTokens && !cacheWriteTokens) continue;
        records.push(createUsageRecord({
          timestamp: toISO(obj.timestamp),
          tool: 'kimi', sessionId,
          model: 'kimi-for-coding',
          inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
          costUSD: null, project: '',
          metadata: { type: 'assistant', messageId, source: 'wire.jsonl' },
        }));
      }
    }
    return records;
  }

  // 路径形如 .../sessions/<hash>/<sessionId>[/subagents/...]/wire.jsonl → 取 <sessionId>
  _sessionIdFromPath(wirePath) {
    const parts = wirePath.split(/[/\\]/);
    const idx = parts.lastIndexOf('sessions');
    if (idx >= 0 && idx + 2 < parts.length) return parts[idx + 2];
    return parts[parts.length - 2] || '';
  }

  async getVersion() { return null; }
}

// Kimi wire.jsonl timestamp 为 epoch 秒（浮点）；兜底当前时间
function toISO(ts) {
  const n = Number(ts);
  if (!n) return new Date().toISOString();
  return new Date(n * 1000).toISOString();
}
