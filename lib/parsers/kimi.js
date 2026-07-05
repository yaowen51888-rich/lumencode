import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { BaseParser } from './base.js';
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

  async parse(config, options = {}) {
    const dir = this.getDataDir(config);
    const records = [];
    if (!dir) return records;
    const sessionsDir = join(dir, 'sessions');

    // 真实结构（实测 ~/.kimi）：sessions/<workdirHash>/<sessionId>/context.jsonl
    //   + context_1.jsonl / context_2.jsonl（compaction 分片，同结构）
    //   + wire.jsonl（协议日志，无 token）+ state.json（会话元信息）
    // 仅读 context*.jsonl；分片内 token_count 单调，每分片独立 delta 基线
    // （kimi 压缩后 token_count 重置，跨分片不连续）。
    let hashes = [];
    try {
      hashes = readdirSync(sessionsDir).filter(d => {
        try { return statSync(join(sessionsDir, d)).isDirectory(); } catch { return false; }
      });
    } catch { return records; }

    for (const hash of hashes) {
      const hashDir = join(sessionsDir, hash);
      let sids = [];
      try {
        sids = readdirSync(hashDir).filter(d => {
          try { return statSync(join(hashDir, d)).isDirectory(); } catch { return false; }
        });
      } catch { continue; }
      for (const sid of sids) {
        const sidDir = join(hashDir, sid);
        let ctxFiles = [];
        try {
          ctxFiles = readdirSync(sidDir)
            .filter(f => /^context(_\d+)?\.jsonl$/.test(f))
            .sort(); // context.jsonl, context_1.jsonl, context_2.jsonl ...
        } catch { continue; }
        if (!ctxFiles.length) continue;
        for (const ctxFile of ctxFiles) {
          const ctx = join(sidDir, ctxFile);
          let lines = [];
          try { lines = readFileSync(ctx, 'utf-8').split('\n').filter(l => l.trim()); }
          catch { continue; } // 单分片读失败不影响其他分片
          let lastTotal = 0; // 每分片独立基线
          for (const line of lines) {
            let obj; try { obj = JSON.parse(line); } catch { continue; }
            if (obj.role !== '_usage' || typeof obj.token_count !== 'number') continue;
            const delta = Math.max(0, obj.token_count - lastTotal);
            lastTotal = obj.token_count;
            if (!delta) continue;
            // 降级：Kimi 仅记录累积总量，无 input/output 拆分，delta 全计 input
            records.push(createUsageRecord({
              timestamp: obj.timestamp || new Date().toISOString(),
              tool: 'kimi', sessionId: sid,
              model: '', inputTokens: delta, outputTokens: 0,
              costUSD: null, project: '',
              metadata: { type: 'assistant', degraded: 'kimi-cumulative-only', cumulativeTotal: obj.token_count, shard: ctxFile },
            }));
          }
        }
      }
    }
    return records;
  }

  async getVersion() { return null; }
}
