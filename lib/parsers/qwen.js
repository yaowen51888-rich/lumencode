import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { GeminiParser } from './gemini.js';

// Qwen Code 基于 gemini-cli fork，字段映射与 Gemini 一致，仅目录结构不同（projects/<proj>/chats）。
export class QwenParser extends GeminiParser {
  getInfo() {
    return { name: 'qwen', displayName: 'Qwen Code', defaultDir: '~/.qwen', envVar: 'QWEN_DATA_DIR' };
  }

  async detect(config) {
    const dir = this.getDataDir(config);
    if (!dir) return false;
    try { return statSync(join(dir, 'projects')).isDirectory(); } catch { return false; }
  }

  _collectChatFiles(dir) {
    const out = [];
    const projectsDir = join(dir, 'projects');
    let projs = [];
    try {
      projs = readdirSync(projectsDir).filter(d => {
        try { return statSync(join(projectsDir, d)).isDirectory(); } catch { return false; }
      });
    } catch { return out; }
    for (const proj of projs) {
      const chatsDir = join(projectsDir, proj, 'chats');
      let files = [];
      try { files = readdirSync(chatsDir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      for (const file of files) {
        out.push({ path: join(chatsDir, file), sessionId: file.replace(/\.jsonl$/, ''), project: proj });
      }
    }
    return out;
  }
}
