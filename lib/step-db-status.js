import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { DEFAULT_STEP_DB_RELATIVE_PATH } from './step-db-paths.js';

const STATUS_RELATIVE_PATH = '.lumencode/step-db-status.json';

export function getStepDatabaseStatusPath(projectRoot = process.cwd()) {
  return join(resolve(projectRoot || process.cwd()), STATUS_RELATIVE_PATH);
}

function fileSize(path) {
  try { return statSync(path).size; } catch { return 0; }
}

export function readStepDatabaseStatus(projectRoot = process.cwd()) {
  const root = resolve(projectRoot || process.cwd());
  const statusPath = getStepDatabaseStatusPath(root);
  if (!existsSync(statusPath)) return null;
  let stored;
  try { stored = JSON.parse(readFileSync(statusPath, 'utf8')); } catch { return null; }
  const dbPath = stored.sourcePath || join(root, DEFAULT_STEP_DB_RELATIVE_PATH);
  return {
    engine: stored.engine || null,
    schemaVersion: stored.schemaVersion ?? null,
    dbSizeBytes: fileSize(dbPath),
    walSizeBytes: fileSize(`${dbPath}-wal`),
    ...stored,
  };
}

export function writeStepDatabaseStatus(projectRoot = process.cwd(), event = {}) {
  const statusPath = getStepDatabaseStatusPath(projectRoot);
  mkdirSync(dirname(statusPath), { recursive: true });
  const status = { ...event, recordedAt: new Date().toISOString() };
  writeFileSync(statusPath, JSON.stringify(status, null, 2) + '\n', 'utf8');
  return status;
}
