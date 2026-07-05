// lib/parsers/codebuff.js
import { readFileSync, statSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { BaseParser, num, walkFiles, splitMulti as splitPaths } from './base.js';
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

  // chat-messages.json assistant 消息含完整 usage（参考 ccusage codebuff/parser.rs 测试 fixture）：
  //   {role:"assistant", metadata:{model, usage:{inputTokens,outputTokens,cacheCreationInputTokens,cacheReadInputTokens}}, credits}
  // cost：有 credits 用 credits×$0.01（Codebuff 自家计费），否则留 null 由 pricing 按 model+token 算
  async parse(config, options = {}) {
    const records = [];
    for (const dir of this.getDataDirs(config)) {
      const projectsDir = join(dir, 'projects');
      if (!existsSync(projectsDir)) continue;
      for (const filePath of walkFiles(projectsDir, (f, s, e) => e === 'chat-messages.json')) {
        const chatDir = dirname(filePath);
        let cwd = '';
        try { cwd = JSON.parse(readFileSync(join(chatDir, 'run-state.json'), 'utf-8')).cwd || ''; }
        catch { /* run-state.json 缺失 */ }
        try {
          const msgs = JSON.parse(readFileSync(filePath, 'utf-8'));
          const list = Array.isArray(msgs) ? msgs : (msgs.messages || []);
          // chatId 形如 2026-07-04T12-34-56Z（文件名安全，':'→'-'），转回 ISO
          const chatId = basename(chatDir);
          const fixed = chatId.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
          const ts = isNaN(Date.parse(fixed)) ? new Date().toISOString() : fixed;
          for (const m of list) {
            const meta = m.metadata || m.message?.metadata || {};
            const usage = meta.usage || m.usage || {};
            const model = meta.model || m.model || m.message?.model || '';
            const credits = num(m.credits ?? m.message?.credits);
            const inputTokens = num(usage.inputTokens ?? usage.prompt_tokens);
            const outputTokens = num(usage.outputTokens ?? usage.completion_tokens);
            const cacheReadTokens = num(usage.cacheReadInputTokens ?? usage.cached_tokens);
            const cacheWriteTokens = num(usage.cacheCreationInputTokens);
            // 兜底：仅有 totalTokens 时全计 output（参考 ccusage parse_usage_object）
            const totalTokens = num(usage.totalTokens);
            const out = outputTokens || (inputTokens || cacheReadTokens || cacheWriteTokens ? 0 : totalTokens);

            if (!credits && !inputTokens && !out && !cacheReadTokens && !cacheWriteTokens) continue;
            const costUSD = credits ? Math.round(credits * 0.01 * 1000) / 1000 : null;
            records.push(createUsageRecord({
              timestamp: m.timestamp || ts, tool: 'codebuff', sessionId: chatId,
              model,
              inputTokens, outputTokens: out, cacheReadTokens, cacheWriteTokens,
              costUSD, project: (cwd || '').replace(/\\/g, '/'),
              metadata: { type: 'assistant', credits: credits || null, messageId: m.id },
            }));
          }
        } catch { /* chat-messages.json 损坏，跳过 */ }
      }
    }
    return records;
  }

  async getVersion() { return null; }
}
