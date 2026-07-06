// lib/parsers/pi.js
import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { BaseParser, num, walkFiles, splitMulti as splitPaths } from './base.js';
import { createUsageRecord } from '../models/usage-record.js';

export class PiParser extends BaseParser {
  getInfo() {
    return { name: 'pi', displayName: 'pi-agent', defaultDir: '~/.pi/agent/sessions', envVar: 'PI_AGENT_DIR' };
  }

  getDataDirs(config) {
    const fromConfig = config.piDir && config.piDir !== '' ? config.piDir : '';
    if (fromConfig) return splitPaths(fromConfig);
    if (process.env.PI_AGENT_DIR) return splitPaths(process.env.PI_AGENT_DIR);
    const home = homedir();
    return home ? [join(home, '.pi', 'agent', 'sessions')] : [];
  }

  async detect(config) {
    return this.getDataDirs(config).some(dir => existsSync(dir));
  }

  // 对齐参考 ccusage adapter/pi：sessions/<project>/<file>.jsonl，每行
  //   {type:"message", timestamp, message:{role:"assistant", model, usage:{input,output,cacheRead,cacheWrite,totalTokens,cost:{total}}}}
  // 仅 type=message + role=assistant 计；total fallback；model 加 [pi] 前缀；按 entry_id 去重。
  async parse(config, options = {}) {
    const seen = new Set();
    const records = [];
    for (const dir of this.getDataDirs(config)) {
      if (!existsSync(dir)) continue;
      for (const filePath of walkFiles(dir, (f, s, e) => e.endsWith('.jsonl'))) {
        const project = this._extractProject(filePath);
        const sessionId = this._extractSessionId(filePath);
        try {
          for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
            if (!line.trim() || !line.includes('"usage"') || !line.includes('"message"')) continue;
            let obj; try { obj = JSON.parse(line); } catch { continue; }
            if (!isPiMessageUsage(obj)) continue;
            const ts = obj.timestamp;
            if (!ts) continue;
            const msg = obj.message;
            const u = msg.usage || {};
            let inputTokens = num(u.input);
            let outputTokens = num(u.output);
            const cacheRead = num(u.cacheRead);
            const cacheWrite = num(u.cacheWrite);
            const total = num(u.totalTokens);
            if (!inputTokens && !outputTokens && total) outputTokens = total;
            if (!inputTokens && !outputTokens && !cacheRead && !cacheWrite && !total) continue;
            const model = msg.model ? `[pi] ${msg.model}` : '';
            const displayCost = (u.cost && typeof u.cost === 'object' && typeof u.cost.total === 'number') ? u.cost.total : null;
            const id = `${project}:${sessionId}:${ts}:${model}:${inputTokens}:${outputTokens}:${cacheWrite}:${cacheRead}:${displayCost}`;
            if (seen.has(id)) continue;
            seen.add(id);
            records.push(createUsageRecord({
              timestamp: ts, tool: 'pi', sessionId, model,
              inputTokens, outputTokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
              costUSD: displayCost, project,
              metadata: { type: 'assistant' },
            }));
          }
        } catch (e) { console.warn(`[pi] 解析失败: ${filePath}`, e.message); }
      }
    }
    return records;
  }

  // session_id: 文件名第一个 '_' 后部分（参考 split_once('_')）
  _extractSessionId(filePath) {
    const stem = basename(filePath).replace(/\.jsonl$/, '');
    const idx = stem.indexOf('_');
    return idx >= 0 ? stem.slice(idx + 1) : stem;
  }

  // project: 路径中 'sessions' 后的下一段
  _extractProject(filePath) {
    const parts = filePath.split(/[\\/]/);
    const i = parts.lastIndexOf('sessions');
    return i >= 0 && i + 1 < parts.length ? parts[i + 1] : 'unknown';
  }

  async getVersion() { return null; }
}

function isPiMessageUsage(obj) {
  if (obj.type && obj.type !== 'message') return false;
  const msg = obj.message;
  if (!msg) return false;
  return msg.role === 'assistant' && !!msg.usage;
}
