import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { parseJsonlFile } from './parser.js';

const fileCache = new Map();
const CACHE_MAX_FILES = 200;

export function getCachedFileRecords(filePath) {
  const { mtimeMs } = statSync(filePath);
  const cached = fileCache.get(filePath);
  if (cached && cached.mtime === mtimeMs) return cached.records;

  const records = parseJsonlFile(filePath);
  fileCache.set(filePath, { mtime: mtimeMs, records });

  // LRU eviction
  while (fileCache.size > CACHE_MAX_FILES) {
    const oldest = fileCache.keys().next().value;
    fileCache.delete(oldest);
  }

  return records;
}

export function invalidateFileCache() {
  fileCache.clear();
}

// 扫描 claudeDir 及其 projects/ 一层的最大 mtime，用于检测日志被追加 / 项目增删。
// Web 与 MCP 共用同一份失效口径，避免长驻客户端（Cursor 等 stdio）读到陈旧缓存。
export function getClaudeDirMaxMtime(claudeDir) {
  if (!claudeDir || !existsSync(claudeDir)) return 0;
  let maxMtime = 0;
  try {
    const scan = (target) => {
      const entries = readdirSync(target, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(target, entry.name);
        const st = statSync(fullPath);
        if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
        // 只深入 projects 目录一层，避免全盘扫描
        if (entry.isDirectory() && entry.name === 'projects') {
          const subEntries = readdirSync(fullPath, { withFileTypes: true });
          for (const sub of subEntries) {
            const subSt = statSync(join(fullPath, sub.name));
            if (subSt.mtimeMs > maxMtime) maxMtime = subSt.mtimeMs;
          }
        }
      }
    };
    scan(claudeDir);
  } catch { /* 忽略无权限等异常 */ }
  return maxMtime;
}
