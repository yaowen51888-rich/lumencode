import { statSync } from 'fs';
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
