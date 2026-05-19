import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { BaseParser } from './base.js';
import { createUsageRecord } from '../models/usage-record.js';

export class OpencodeParser extends BaseParser {
  getInfo() {
    return {
      name: 'opencode',
      displayName: 'OpenCode',
      defaultDir: '~/.local/share/opencode',
      envVar: 'OPENCODE_DATA_DIR',
    };
  }

  async detect(config) {
    const dir = this.getDataDir(config);
    if (!dir) return false;
    try {
      const storageDir = join(dir, 'storage', 'message');
      return statSync(storageDir).isDirectory();
    } catch {
      return false;
    }
  }

  async parse(config, options = {}) {
    const dir = this.getDataDir(config);
    const records = [];
    if (!dir) return records;

    const messageDir = join(dir, 'storage', 'message');
    let sessionDirs;
    try {
      sessionDirs = readdirSync(messageDir).filter(d => {
        try {
          return statSync(join(messageDir, d)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return records;
    }

    for (const sessionId of sessionDirs) {
      const sessionPath = join(messageDir, sessionId);
      try {
        const files = readdirSync(sessionPath).filter(f => f.startsWith('msg_') && f.endsWith('.json'));
        for (const file of files) {
          try {
            const content = readFileSync(join(sessionPath, file), 'utf-8');
            const msg = JSON.parse(content);
            const record = this._convertMessage(msg, sessionId);
            if (record) records.push(record);
          } catch {}
        }
      } catch {}
    }

    return records;
  }

  _convertMessage(msg, sessionId) {
    if (!msg || typeof msg !== 'object') return null;

    const tokens = msg.tokens || {};
    const inputTokens = tokens.input || 0;
    const outputTokens = tokens.output || 0;

    if (inputTokens === 0 && outputTokens === 0) return null;

    return createUsageRecord({
      timestamp: msg.timestamp || msg.created_at || new Date().toISOString(),
      tool: 'opencode',
      sessionId: sessionId,
      model: msg.model || '',
      inputTokens: inputTokens,
      outputTokens: outputTokens,
      cacheReadTokens: tokens.cache?.read || 0,
      cacheWriteTokens: tokens.cache?.write || 0,
      costUSD: msg.cost || null,
      project: msg.project || msg.projectPath || '',
      metadata: {
        messageId: msg.id || '',
        role: msg.role || '',
        agent: msg.agent || '',
        provider: msg.provider || '',
      },
    });
  }
}
