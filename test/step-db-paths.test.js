import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_STEP_DB_RELATIVE_PATH,
  LEGACY_STEP_DB_RELATIVE_PATH,
  resolveStepDbPath,
  migrateLegacyStepDatabase,
  ensureStepDatabaseGitignore,
} from '../lib/step-db-paths.js';
import {
  getStepDatabaseStatusPath,
  readStepDatabaseStatus,
  writeStepDatabaseStatus,
} from '../lib/step-db-status.js';

function tempProject() {
  return mkdtempSync(join(tmpdir(), 'lumencode-step-paths-'));
}

test('resolveStepDbPath uses product-owned default when config is missing', () => {
  const root = tempProject();
  const resolved = resolveStepDbPath(root);
  assert.equal(resolved.relativePath, DEFAULT_STEP_DB_RELATIVE_PATH);
  assert.equal(resolved.isDefaultPath, true);
  assert.equal(resolved.isLegacyDefaultConfig, false);
  assert.equal(resolved.dbPath, join(root, '.lumencode', 'steps.db'));
  assert.equal(resolved.legacyDbPath, join(root, '.ccusage', 'steps.db'));
});

test('resolveStepDbPath upgrades old default config to product-owned default', () => {
  const root = tempProject();
  const resolved = resolveStepDbPath(root, LEGACY_STEP_DB_RELATIVE_PATH);
  assert.equal(resolved.relativePath, DEFAULT_STEP_DB_RELATIVE_PATH);
  assert.equal(resolved.isDefaultPath, true);
  assert.equal(resolved.isLegacyDefaultConfig, true);
  assert.equal(resolved.dbPath, join(root, '.lumencode', 'steps.db'));
});

test('resolveStepDbPath respects custom relative path', () => {
  const root = tempProject();
  const resolved = resolveStepDbPath(root, 'custom/steps.db');
  assert.equal(resolved.relativePath, 'custom/steps.db');
  assert.equal(resolved.isDefaultPath, false);
  assert.equal(resolved.dbPath, join(root, 'custom', 'steps.db'));
  assert.equal(resolved.legacyDbPath, null);
});

test('resolveStepDbPath normalizes Windows-style custom relative path', () => {
  const root = tempProject();
  const resolved = resolveStepDbPath(root, 'custom\\steps.db');
  assert.equal(resolved.relativePath, 'custom/steps.db');
  assert.equal(resolved.isDefaultPath, false);
  assert.equal(resolved.dbPath, join(root, 'custom', 'steps.db'));
  assert.equal(resolved.legacyDbPath, null);
});

test('ensureStepDatabaseGitignore adds .lumencode only during explicit init', () => {
  const root = tempProject();
  ensureStepDatabaseGitignore(root);
  const text = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.match(text, /^\.lumencode\/$/m);

  ensureStepDatabaseGitignore(root);
  const lines = readFileSync(join(root, '.gitignore'), 'utf8')
    .split(/\r?\n/)
    .filter(line => line === '.lumencode/');
  assert.equal(lines.length, 1);
});

test('migrateLegacyStepDatabase copies legacy default database and records status', () => {
  const root = tempProject();
  mkdirSync(join(root, '.ccusage'), { recursive: true });
  writeFileSync(join(root, '.ccusage', 'steps.db'), 'legacy db\n');

  migrateLegacyStepDatabase(root);

  assert.equal(readFileSync(join(root, '.lumencode', 'steps.db'), 'utf8'), 'legacy db\n');
  assert.equal(readFileSync(join(root, '.ccusage', 'steps.db'), 'utf8'), 'legacy db\n');
  assert.equal(readStepDatabaseStatus(root).type, 'legacy_migrated');
});

test('migrateLegacyStepDatabase does not modify gitignore', () => {
  const root = tempProject();
  mkdirSync(join(root, '.ccusage'), { recursive: true });
  writeFileSync(join(root, '.ccusage', 'steps.db'), 'legacy db\n');

  migrateLegacyStepDatabase(root);

  assert.equal(existsSync(join(root, '.gitignore')), false);
});

test('migrateLegacyStepDatabase does not overwrite existing product database', () => {
  const root = tempProject();
  mkdirSync(join(root, '.ccusage'), { recursive: true });
  mkdirSync(join(root, '.lumencode'), { recursive: true });
  writeFileSync(join(root, '.ccusage', 'steps.db'), 'legacy db\n');
  writeFileSync(join(root, '.lumencode', 'steps.db'), 'new db\n');

  const result = migrateLegacyStepDatabase(root);

  assert.equal(result.migrated, false);
  assert.equal(result.legacyPresent, true);
  assert.equal(readFileSync(join(root, '.lumencode', 'steps.db'), 'utf8'), 'new db\n');
  assert.equal(readStepDatabaseStatus(root), null);
});

test('migrateLegacyStepDatabase skips custom paths', () => {
  const root = tempProject();
  mkdirSync(join(root, '.ccusage'), { recursive: true });
  writeFileSync(join(root, '.ccusage', 'steps.db'), 'legacy db\n');

  migrateLegacyStepDatabase(root, 'custom/steps.db');

  assert.equal(existsSync(join(root, 'custom', 'steps.db')), false);
  assert.equal(readStepDatabaseStatus(root), null);
});

test('writeStepDatabaseStatus writes newline-terminated JSON with recordedAt', () => {
  const root = tempProject();
  const statusPath = getStepDatabaseStatusPath(root);

  writeStepDatabaseStatus(root, { type: 'checked' });

  const text = readFileSync(statusPath, 'utf8');
  const status = readStepDatabaseStatus(root);
  assert.equal(text.endsWith('\n'), true);
  assert.equal(status.type, 'checked');
  assert.equal(typeof status.recordedAt, 'string');
});
