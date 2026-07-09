import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

const STATUS_RELATIVE_PATH = '.lumencode/step-db-status.json';

export function getStepDatabaseStatusPath(projectRoot = process.cwd()) {
  return join(resolve(projectRoot || process.cwd()), STATUS_RELATIVE_PATH);
}

export function readStepDatabaseStatus(projectRoot = process.cwd()) {
  const statusPath = getStepDatabaseStatusPath(projectRoot);
  if (!existsSync(statusPath)) return null;
  try {
    return JSON.parse(readFileSync(statusPath, 'utf8'));
  } catch {
    return null;
  }
}

export function writeStepDatabaseStatus(projectRoot = process.cwd(), event = {}) {
  const statusPath = getStepDatabaseStatusPath(projectRoot);
  mkdirSync(dirname(statusPath), { recursive: true });
  const status = {
    ...event,
    recordedAt: new Date().toISOString(),
  };
  writeFileSync(statusPath, JSON.stringify(status, null, 2) + '\n', 'utf8');
  return status;
}
