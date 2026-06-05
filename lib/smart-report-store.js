import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { createHash } from 'crypto';

const STORE_FILE = 'records.json';

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashText(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

export function getSmartReportStoreDir(configPath) {
  return join(dirname(configPath || join(process.cwd(), 'config.json')), 'smart-reports');
}

export function buildSmartReportKey(input = {}) {
  return hashText(stableStringify({
    agent: input.agent || '',
    period: input.period || '',
    date: input.date || '',
    start: input.start || '',
    end: input.end || '',
    tool: input.tool || 'all',
    project: input.project || '',
    level: input.level || 'detailed',
    style: input.style && input.style !== 'default' ? input.style : '',
    platform: input.platform || 'default',
  }));
}

export function buildSourceHash(source = {}) {
  return hashText(stableStringify(source));
}

function getStorePath(storeDir) {
  return join(storeDir, STORE_FILE);
}

function readStore(storeDir) {
  const file = getStorePath(storeDir);
  if (!existsSync(file)) return { records: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.records) return { records: {} };
    return parsed;
  } catch {
    return { records: {} };
  }
}

function writeStore(storeDir, store) {
  if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true });
  writeFileSync(getStorePath(storeDir), JSON.stringify(store, null, 2), 'utf8');
}

export function readSmartReportRecord(storeDir, reportKey) {
  const store = readStore(storeDir);
  return store.records[reportKey] || null;
}

export function saveSmartReportRecord(storeDir, input) {
  const store = readStore(storeDir);
  const reportKey = buildSmartReportKey(input);
  const now = new Date().toISOString();
  const existing = store.records[reportKey] || null;
  const record = {
    id: existing?.id || reportKey,
    reportKey,
    agent: input.agent || '',
    period: input.period || '',
    date: input.date || '',
    start: input.start || '',
    end: input.end || '',
    tool: input.tool || 'all',
    project: input.project || '',
    level: input.level || 'detailed',
    style: input.style || 'default',
    platform: input.platform || 'default',
    markdown: input.markdown || '',
    sourceHash: input.sourceHash || '',
    sourceHashVersion: input.sourceHashVersion || 1,
    sourceReports: input.sourceReports || {},
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    generatedCount: (existing?.generatedCount || 0) + 1,
  };

  store.records[reportKey] = record;
  writeStore(storeDir, store);
  return record;
}
