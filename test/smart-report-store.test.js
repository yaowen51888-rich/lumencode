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
  assert.equal(
    buildSmartReportKey(base),
    buildSmartReportKey({ ...base, style: 'default' }),
  );
  assert.notEqual(
    buildSmartReportKey(base),
    buildSmartReportKey({ ...base, style: 'workhorse' }),
  );
  // agent 不参与 key 生成——不同智能体共享同一份报告
  assert.equal(
    buildSmartReportKey(base),
    buildSmartReportKey({ ...base, agent: 'codex' }),
  );
  assert.equal(
    buildSmartReportKey(base),
    buildSmartReportKey({ ...base, agent: 'opencode' }),
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

test('saveSmartReportRecord creates separate records for different smart report styles', async () => withTempDir(async (configDir) => {
  const storeDir = getSmartReportStoreDir(join(configDir, 'config.json'));
  const base = {
    agent: 'opencode',
    period: 'weekly',
    date: '2026-06-04',
    tool: 'all',
    project: '',
    level: 'detailed',
    platform: 'default',
    markdown: '# Report',
    sourceHash: 'hash',
  };

  const normal = saveSmartReportRecord(storeDir, { ...base, style: 'default' });
  const workhorse = saveSmartReportRecord(storeDir, { ...base, style: 'workhorse' });

  assert.notEqual(normal.id, workhorse.id);
  assert.equal(normal.style, 'default');
  assert.equal(workhorse.style, 'workhorse');
  assert.equal(readSmartReportRecord(storeDir, buildSmartReportKey({ ...base })).id, normal.id);
  assert.equal(readSmartReportRecord(storeDir, buildSmartReportKey({ ...base, style: 'workhorse' })).id, workhorse.id);
}));

test('saveSmartReportRecord overwrites same record across different agents', async () => withTempDir(async (configDir) => {
  const storeDir = getSmartReportStoreDir(join(configDir, 'config.json'));
  const base = {
    agent: 'claude',
    period: 'daily',
    date: '2026-06-04',
    tool: 'all',
    project: '',
    level: 'detailed',
    platform: 'default',
    markdown: '# Claude Report',
    sourceHash: 'hash-1',
  };

  const claudeRecord = saveSmartReportRecord(storeDir, { ...base });
  const codexRecord = saveSmartReportRecord(storeDir, { ...base, agent: 'codex', markdown: '# Codex Report', sourceHash: 'hash-2' });

  // 同一个 key，所以是覆盖而不是新建
  assert.equal(claudeRecord.id, codexRecord.id);
  assert.equal(codexRecord.generatedCount, 2);
  assert.equal(codexRecord.markdown, '# Codex Report');
  assert.equal(codexRecord.agent, 'codex'); // agent 元数据保留最后一次的

  const loaded = readSmartReportRecord(storeDir, buildSmartReportKey(base));
  assert.equal(loaded.markdown, '# Codex Report');
  assert.equal(loaded.generatedCount, 2);
}));
