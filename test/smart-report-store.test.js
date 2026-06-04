import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildSmartReportKey,
  getSmartReportStoreDir,
  readSmartReportRecord,
  saveSmartReportRecord,
} from '../lib/smart-report-store.js';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'smart-report-store-'));
  return Promise.resolve(fn(dir)).finally(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });
}

test('buildSmartReportKey separates report level and dimensions', () => {
  const base = {
    agent: 'claude',
    period: 'weekly',
    date: '2026-06-04',
    tool: 'all',
    project: '',
    level: 'detailed',
    platform: 'default',
  };

  assert.notEqual(
    buildSmartReportKey(base),
    buildSmartReportKey({ ...base, level: 'brief' }),
  );
  assert.equal(
    buildSmartReportKey(base),
    buildSmartReportKey({ ...base, level: 'detailed' }),
  );
});

test('saveSmartReportRecord creates a new record and updates same key later', async () => withTempDir(async (configDir) => {
  const storeDir = getSmartReportStoreDir(join(configDir, 'config.json'));
  const keyInput = {
    agent: 'claude',
    period: 'daily',
    date: '2026-06-04',
    tool: 'all',
    project: '',
    level: 'brief',
    platform: 'default',
  };

  const first = saveSmartReportRecord(storeDir, {
    ...keyInput,
    markdown: '# First',
    sourceHash: 'hash-1',
    sourceReports: { detailedHash: 'd1', briefHash: 'b1' },
  });
  const second = saveSmartReportRecord(storeDir, {
    ...keyInput,
    markdown: '# Second',
    sourceHash: 'hash-2',
    sourceReports: { detailedHash: 'd2', briefHash: 'b2' },
  });

  assert.equal(first.id, second.id);
  assert.equal(second.generatedCount, 2);
  assert.equal(second.markdown, '# Second');
  assert.equal(second.sourceHash, 'hash-2');
  assert.equal(second.createdAt, first.createdAt);
  assert.notEqual(second.updatedAt, '');

  const loaded = readSmartReportRecord(storeDir, buildSmartReportKey(keyInput));
  assert.equal(loaded.markdown, '# Second');
  assert.equal(loaded.generatedCount, 2);
}));

test('saveSmartReportRecord creates separate records for different levels', async () => withTempDir(async (configDir) => {
  const storeDir = getSmartReportStoreDir(join(configDir, 'config.json'));
  const base = {
    agent: 'codex',
    period: 'daily',
    date: '2026-06-04',
    tool: 'all',
    project: '',
    platform: 'default',
    markdown: '# Report',
    sourceHash: 'hash',
  };

  const detailed = saveSmartReportRecord(storeDir, { ...base, level: 'detailed' });
  const brief = saveSmartReportRecord(storeDir, { ...base, level: 'brief' });

  assert.notEqual(detailed.id, brief.id);
  assert.equal(readSmartReportRecord(storeDir, buildSmartReportKey({ ...base, level: 'detailed' })).id, detailed.id);
  assert.equal(readSmartReportRecord(storeDir, buildSmartReportKey({ ...base, level: 'brief' })).id, brief.id);
}));
