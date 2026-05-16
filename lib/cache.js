import { statSync } from 'fs';
import { parseJsonlFile } from './parser.js';

const fileCache = new Map();

export function getCachedFileRecords(filePath) {
  const { mtimeMs } = statSync(filePath);
  const cached = fileCache.get(filePath);
  if (cached && cached.mtime === mtimeMs) return cached.records;

  const records = parseJsonlFile(filePath);
  fileCache.set(filePath, { mtime: mtimeMs, records });
  return records;
}

export function invalidateFileCache() {
  fileCache.clear();
}
