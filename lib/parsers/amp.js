import { readdirSync, readFileSync, statSync } from 'fs';
import { join, basename } from 'path';
import { BaseParser, num } from './base.js';
import { createUsageRecord } from '../models/usage-record.js';

export class AmpParser extends BaseParser {
  getInfo() {
    return { name: 'amp', displayName: 'Amp', defaultDir: '~/.local/share/amp', envVar: 'AMP_DATA_DIR' };
  }

  async detect(config) {
    const dir = this.getDataDir(config);
    if (!dir) return false;
    try { return statSync(join(dir, 'threads')).isDirectory(); } catch { return false; }
  }

  // 对齐参考 ccusage (amp/parser.rs)：
  //  - usageLedger.events 优先于 messages[].usage；二者互斥不叠加
  //  - ledger event: tokens.{input,output,total}(snake)，cache 经 to_messageId 关联 assistant message
  //  - message usage: {input,output,cacheCreation,cacheRead}Tokens + totalTokens(camel)
  //  - 仅 role==assistant 的 message 参与
  //  - total fallback: input/output 都 0 但有 total → 当 output
  //  - 全 0（含 cache 与 total）跳过
  async parse(config, options = {}) {
    const dir = this.getDataDir(config);
    const records = [];
    if (!dir) return records;
    const threadsDir = join(dir, 'threads');
    let files = [];
    try { files = readdirSync(threadsDir).filter(f => f.endsWith('.json')); } catch { return records; }

    for (const file of files) {
      const filePath = join(threadsDir, file);
      const threadId = file.replace(/\.json$/, '');
      let data;
      try { data = JSON.parse(readFileSync(filePath, 'utf-8')); }
      catch (e) { console.warn(`[amp] 解析失败: ${filePath}`, e.message); continue; }

      const sid = data.id || threadId;
      const project = data.repoUrl ? basename(data.repoUrl).replace(/\.git$/, '') : '';
      const messages = Array.isArray(data.messages) ? data.messages : [];

      // assistant message 的 cache 映射: messageId → [cacheCreation, cacheRead]，供 ledger 关联
      const cacheMap = new Map();
      for (const m of messages) {
        if (!m || m.role !== 'assistant') continue;
        const mid = m.messageId ?? m.message_id;
        if (mid == null) continue;
        const u = m.usage || {};
        cacheMap.set(Number(mid), [num(u.cacheCreationInputTokens), num(u.cacheReadInputTokens)]);
      }

      const ledger = data.usageLedger ?? data.usage_ledger;
      const events = ledger && Array.isArray(ledger.events) ? ledger.events : null;

      if (events && events.length) {
        for (const e of events) {
          if (!e || typeof e !== 'object') continue;
          const ts = e.timestamp;
          const model = e.model;
          if (!ts || !model) continue;
          const tokens = e.tokens || {};
          let inputTokens = num(tokens.input);
          let outputTokens = num(tokens.output);
          const total = num(tokens.total);
          let cacheWrite = 0, cacheRead = 0;
          const toMid = Number(e.toMessageId ?? e.to_message_id);
          if (!Number.isNaN(toMid) && cacheMap.has(toMid)) {
            [cacheWrite, cacheRead] = cacheMap.get(toMid);
          }
          if (!inputTokens && !outputTokens && total) outputTokens = total;
          if (!inputTokens && !outputTokens && !cacheWrite && !cacheRead && !total) continue;
          records.push(createUsageRecord({
            timestamp: ts, tool: 'amp', sessionId: sid, model,
            inputTokens, outputTokens, cacheWriteTokens: cacheWrite, cacheReadTokens: cacheRead,
            costUSD: null, project, metadata: { type: 'assistant', source: 'ledger' },
          }));
        }
        continue; // ledger 优先，处理则不再走 messages
      }

      // 无可用 ledger events → 从 assistant messages 解析
      for (const m of messages) {
        if (!m || m.role !== 'assistant') continue;
        const u = m.usage || {};
        const ts = u.timestamp || m.timestamp || data.timestamp;
        const model = u.model || m.model || data.model || '';
        if (!ts || !model) continue;
        let inputTokens = num(u.inputTokens);
        let outputTokens = num(u.outputTokens);
        const cacheWrite = num(u.cacheCreationInputTokens);
        const cacheRead = num(u.cacheReadInputTokens);
        const total = num(u.totalTokens ?? u.total);
        if (!inputTokens && !outputTokens && total) outputTokens = total;
        if (!inputTokens && !outputTokens && !cacheWrite && !cacheRead && !total) continue;
        records.push(createUsageRecord({
          timestamp: ts, tool: 'amp', sessionId: sid, model,
          inputTokens, outputTokens, cacheWriteTokens: cacheWrite, cacheReadTokens: cacheRead,
          costUSD: null, project, metadata: { type: 'assistant', source: 'message' },
        }));
      }
    }
    return records;
  }

  async getVersion() { return null; }
}
