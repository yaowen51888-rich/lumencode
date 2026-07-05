// lib/parsers/codebuff.js
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { BaseParser } from './base.js';
import { createUsageRecord } from '../models/usage-record.js';

// 参考 ccusage codebuff/paths.rs：默认扫描 3 通道 manicode / manicode-dev / manicode-staging
const CHANNELS = ['manicode', 'manicode-dev', 'manicode-staging'];

export class CodebuffParser extends BaseParser {
  getInfo() {
    return { name: 'codebuff', displayName: 'Codebuff', defaultDir: '~/.config/manicode', envVar: 'CODEBUFF_DATA_DIR' };
  }

  // 覆写：默认返回 3 通道目录（多账号/多环境）；用户 config 或 env 可指定单目录
  getDataDirs(config) {
    const fromConfig = config.codebuffDir && config.codebuffDir !== '' ? config.codebuffDir : '';
    if (fromConfig) return splitPaths(fromConfig);
    if (process.env.CODEBUFF_DATA_DIR) return splitPaths(process.env.CODEBUFF_DATA_DIR);
    const home = homedir();
    if (!home) return [];
    return CHANNELS.map(c => join(home, '.config', c));
  }

  async detect(config) {
    return this.getDataDirs(config).some(dir => {
      try { return statSync(join(dir, 'projects')).isDirectory(); } catch { return false; }
    });
  }

  async parse(config, options = {}) {
    const records = [];
    for (const dir of this.getDataDirs(config)) {
      const projectsDir = join(dir, 'projects');
      if (!existsSync(projectsDir)) continue;
      // 参考实现：递归找名为 chat-messages.json 的文件（不假设 chats 层级）
      for (const filePath of this._findChatMessages(projectsDir)) {
        const chatDir = dirname(filePath);
        let cwd = '';
        try { cwd = JSON.parse(readFileSync(join(chatDir, 'run-state.json'), 'utf-8')).cwd || ''; }
        catch { /* run-state.json 缺失 */ }
        try {
          const msgs = JSON.parse(readFileSync(filePath, 'utf-8'));
          const list = Array.isArray(msgs) ? msgs : (msgs.messages || []);
          for (const m of list) {
            const credits = m.credits ?? m.message?.credits ?? 0;
            if (!credits) continue;
            // chatId 形如 2026-07-04T12-34-56Z（文件名安全，':'→'-'），转回 ISO
            const chatId = basename(chatDir);
            const fixed = chatId.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
            const ts = isNaN(Date.parse(fixed)) ? new Date().toISOString() : fixed;
            records.push(createUsageRecord({
              timestamp: ts, tool: 'codebuff', sessionId: chatId,
              model: m.model || m.message?.model || '',
              inputTokens: 0, outputTokens: 0,
              costUSD: Math.round(credits * 0.01 * 1000) / 1000, // 1 credit = $0.01（参考用 pricing map，此处降级估算）
              project: (cwd || '').replace(/\\/g, '/'),
              metadata: { type: 'assistant', degraded: 'codebuff-credits-only', credits },
            }));
          }
        } catch { /* chat-messages.json 损坏，跳过 */ }
      }
    }
    return records;
  }

  // 递归收集所有 chat-messages.json
  _findChatMessages(root) {
    const out = [];
    const walk = (d) => {
      let entries = [];
      try { entries = readdirSync(d); } catch { return; }
      for (const e of entries) {
        const full = join(d, e);
        let st; try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) { walk(full); continue; }
        if (e === 'chat-messages.json') out.push(full);
      }
    };
    walk(root);
    return out;
  }

  async getVersion() { return null; }
}

function splitPaths(raw) {
  return String(raw).split(',').map(s => s.trim()).filter(s => s !== '');
}
