import { closeSync, existsSync, openSync, statSync, unlinkSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import { StepTracker } from './step-tracker.js';

export const ORIGINS = Object.freeze({
  CLAUDE_CODE: 'claude_code',
  CODEX_CLI: 'codex_cli',
});

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

async function withDbLock(dbPath, fn) {
  const lockPath = `${dbPath}.lock`;
  const deadline = Date.now() + 2_000;
  let fd = null;

  while (Date.now() < deadline) {
    try {
      fd = openSync(lockPath, 'wx');
      break;
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 10_000) unlinkSync(lockPath);
      } catch {}
      await sleep(50);
    }
  }

  if (fd === null) return null;

  try {
    return await fn();
  } finally {
    try { closeSync(fd); } catch {}
    try { unlinkSync(lockPath); } catch {}
  }
}

export function normalizeOriginSessionId(origin, sessionId) {
  const normalizedOrigin = origin || ORIGINS.CLAUDE_CODE;
  const rawSessionId = String(sessionId || 'unknown');
  const prefix = `${normalizedOrigin}:`;
  return rawSessionId.startsWith(prefix) ? rawSessionId : `${prefix}${rawSessionId}`;
}

export async function recordToolUse(payload = {}) {
  const cwd = resolve(payload.cwd || process.cwd());
  const dbPath = payload.dbPath
    ? (isAbsolute(payload.dbPath) ? payload.dbPath : join(cwd, payload.dbPath))
    : join(cwd, '.ccusage', 'steps.db');

  if (!existsSync(dbPath)) {
    return { recorded: false, reason: 'not_initialized' };
  }

  const origin = payload.origin || ORIGINS.CLAUDE_CODE;
  const sessionId = normalizeOriginSessionId(origin, payload.sessionId);

  const result = await withDbLock(dbPath, async () => {
    const tracker = new StepTracker(cwd, { dbPath });
    try {
      await tracker.open();
      const stepId = await tracker.recordStep({
        origin,
        sessionId,
        toolUseId: payload.toolUseId,
        toolName: payload.toolName,
        toolInput: payload.toolInput,
        toolResponse: payload.toolResponse,
        cwd,
        timestamp: payload.timestamp || new Date().toISOString(),
      });
      return stepId
        ? { recorded: true, stepId, sessionId, origin }
        : { recorded: false, reason: 'no_target_files', sessionId, origin };
    } finally {
      tracker.close();
    }
  });

  return result || { recorded: false, reason: 'lock_timeout', sessionId, origin };
}
