import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { writeStepDatabaseStatus } from './step-db-status.js';

export const DEFAULT_STEP_DB_RELATIVE_PATH = '.lumencode/steps.db';
export const LEGACY_STEP_DB_RELATIVE_PATH = '.ccusage/steps.db';
export const STEP_DB_IGNORE_ENTRY = '.lumencode/';

function normalizeRelativePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.?\//, '');
}

export function resolveStepDbPath(projectRoot = process.cwd(), configuredDbPath = null) {
  const root = resolve(projectRoot || process.cwd());
  const raw = configuredDbPath == null || configuredDbPath === ''
    ? DEFAULT_STEP_DB_RELATIVE_PATH
    : String(configuredDbPath);
  const normalized = isAbsolute(raw) ? raw : normalizeRelativePath(raw);
  const isLegacyDefaultConfig = !isAbsolute(raw) && normalized === LEGACY_STEP_DB_RELATIVE_PATH;
  const isDefaultPath = !isAbsolute(raw) && (
    normalized === DEFAULT_STEP_DB_RELATIVE_PATH ||
    isLegacyDefaultConfig
  );

  if (isDefaultPath) {
    return {
      projectRoot: root,
      dbPath: join(root, DEFAULT_STEP_DB_RELATIVE_PATH),
      relativePath: DEFAULT_STEP_DB_RELATIVE_PATH,
      legacyDbPath: join(root, LEGACY_STEP_DB_RELATIVE_PATH),
      isDefaultPath: true,
      isLegacyDefaultConfig,
    };
  }

  return {
    projectRoot: root,
    dbPath: isAbsolute(raw) ? raw : join(root, normalized),
    relativePath: isAbsolute(raw) ? null : normalized,
    legacyDbPath: null,
    isDefaultPath: false,
    isLegacyDefaultConfig: false,
  };
}

export function migrateLegacyStepDatabase(projectRoot = process.cwd(), configuredDbPath = null) {
  const resolved = resolveStepDbPath(projectRoot, configuredDbPath);
  if (!resolved.isDefaultPath || !resolved.legacyDbPath) {
    return { ...resolved, migrated: false };
  }
  if (!existsSync(resolved.legacyDbPath)) {
    return { ...resolved, migrated: false };
  }

  mkdirSync(dirname(resolved.dbPath), { recursive: true });
  try {
    copyFileSync(resolved.legacyDbPath, resolved.dbPath, constants.COPYFILE_EXCL);
  } catch (err) {
    if (err?.code === 'EEXIST') {
      return { ...resolved, migrated: false, legacyPresent: true };
    }
    throw err;
  }

  writeStepDatabaseStatus(resolved.projectRoot, {
    type: 'legacy_migrated',
    sourcePath: resolved.legacyDbPath,
    targetPath: resolved.dbPath,
    message: '已从旧版 .ccusage/steps.db 复制到 .lumencode/steps.db。',
  });
  return { ...resolved, migrated: true };
}

export function ensureStepDatabaseGitignore(projectRoot = process.cwd()) {
  const root = resolve(projectRoot || process.cwd());
  const ignorePath = join(root, '.gitignore');
  const existing = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
  const lines = existing.split(/\r?\n/).map(line => line.trim());
  if (lines.includes(STEP_DB_IGNORE_ENTRY)) return false;

  const prefix = existing && !existing.endsWith('\n') ? `${existing}\n` : existing;
  writeFileSync(ignorePath, `${prefix}${STEP_DB_IGNORE_ENTRY}\n`, 'utf8');
  return true;
}
