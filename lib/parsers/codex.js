import { readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { BaseParser } from './base.js';
import { createUsageRecord } from '../models/usage-record.js';

export class CodexParser extends BaseParser {
  getInfo() {
    return {
      name: 'codex',
      displayName: 'OpenAI Codex',
      defaultDir: '~/.codex',
      envVar: 'CODEX_HOME',
    };
  }

  async detect(config) {
    const dir = this.getDataDir(config);
    if (!dir) return false;
    try {
      const sessionsDir = join(dir, 'sessions');
      return statSync(sessionsDir).isDirectory();
    } catch {
      try {
        const archivedDir = join(dir, 'archived_sessions');
        return statSync(archivedDir).isDirectory();
      } catch {
        return false;
      }
    }
  }

  async parse(config, options = {}) {
    const dir = this.getDataDir(config);
    const records = [];
    if (!dir) return records;

    const files = this._collectJsonlFiles(dir);

    for (const filePath of files) {
      try {
        const fileRecords = this._parseFile(filePath);
        records.push(...fileRecords);
      } catch (err) {
        console.warn(`Codex 解析文件失败: ${filePath}`, err.message);
      }
    }

    return records;
  }

  _collectJsonlFiles(dir) {
    const files = [];
    const sessionsDir = join(dir, 'sessions');
    try {
      if (statSync(sessionsDir).isDirectory()) {
        files.push(...this._walkDir(sessionsDir));
      }
    } catch {}

    const archivedDir = join(dir, 'archived_sessions');
    try {
      if (statSync(archivedDir).isDirectory()) {
        const archived = readdirSync(archivedDir).filter(f => f.endsWith('.jsonl'));
        for (const f of archived) {
          files.push(join(archivedDir, f));
        }
      }
    } catch {}

    return files;
  }

  _walkDir(dir) {
    const results = [];
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            results.push(...this._walkDir(fullPath));
          } else if (entry.endsWith('.jsonl')) {
            results.push(fullPath);
          }
        } catch {}
      }
    } catch {}
    return results;
  }

  _parseFile(filePath) {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    let sessionId = '';
    let currentModel = '';
    let lastTokenUsage = null;
    const records = [];

    for (const line of lines) {
      try {
        const event = JSON.parse(line);

        if (event.type === 'session_meta' && event.payload?.id) {
          sessionId = event.payload.id;
        }

        if (event.type === 'turn_context' && event.payload?.model) {
          currentModel = event.payload.model;
        }

        if (event.type === 'event_msg' && event.payload?.type === 'token_count') {
          const info = event.payload.info;
          if (!info || !info.total_token_usage) continue;

          const total = info.total_token_usage;
          const current = {
            input: total.input_tokens || 0,
            output: total.output_tokens || 0,
            cachedInput: total.cached_input_tokens || 0,
            cacheCreation: total.cache_creation_input_tokens || 0,
            reasoningOutput: total.reasoning_output_tokens || 0,
          };

          let delta = { ...current };
          if (lastTokenUsage) {
            delta.input = Math.max(0, current.input - lastTokenUsage.input);
            delta.output = Math.max(0, current.output - lastTokenUsage.output);
            delta.cachedInput = Math.max(0, current.cachedInput - lastTokenUsage.cachedInput);
            delta.cacheCreation = Math.max(0, current.cacheCreation - lastTokenUsage.cacheCreation);
          }
          lastTokenUsage = current;

          if (delta.input > 0 || delta.output > 0) {
            records.push(createUsageRecord({
              timestamp: event.timestamp || new Date().toISOString(),
              tool: 'codex',
              sessionId: sessionId || basename(filePath, '.jsonl'),
              model: currentModel || 'gpt-5',
              inputTokens: delta.input,
              outputTokens: delta.output,
              cacheReadTokens: delta.cachedInput,
              cacheWriteTokens: delta.cacheCreation,
              costUSD: null,
              metadata: {
                reasoningOutputTokens: delta.reasoningOutput,
                isFallback: !currentModel,
              },
            }));
          }
        }
      } catch {}
    }

    return records;
  }
}
