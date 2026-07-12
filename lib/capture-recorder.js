import { existsSync } from 'fs';
import { resolve } from 'path';
import { StepTracker } from './step-tracker.js';
import { migrateLegacyStepDatabase } from './step-db-paths.js';

export const ORIGINS = Object.freeze({
  CLAUDE_CODE: 'claude_code',
  CODEX_CLI: 'codex_cli',
  OPENCODE: 'opencode',
  GEMINI: 'gemini',
});

export function normalizeOriginSessionId(origin, sessionId) {
  const normalizedOrigin = origin || ORIGINS.CLAUDE_CODE;
  const rawSessionId = String(sessionId || 'unknown');
  const prefix = `${normalizedOrigin}:`;
  return rawSessionId.startsWith(prefix) ? rawSessionId : `${prefix}${rawSessionId}`;
}

export async function recordToolUse(payload = {}) {
  const cwd = resolve(payload.cwd || process.cwd());
  const resolvedDb = migrateLegacyStepDatabase(cwd, payload.dbPath);
  const dbPath = resolvedDb.dbPath;

  if (!existsSync(dbPath)) {
    return { recorded: false, reason: 'not_initialized' };
  }

  const origin = payload.origin || ORIGINS.CLAUDE_CODE;
  const sessionId = normalizeOriginSessionId(origin, payload.sessionId);
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
  } catch (err) {
    throw err;
  } finally {
    tracker.close();
  }
}

function normalizeToolCall(call = {}) {
  const tool = call.tool || {};
  return {
    toolUseId: call.toolUseId || call.tool_use_id || call.id || call.call_id || call.callId,
    toolName: call.toolName || call.tool_name || call.name || tool.name,
    toolInput: call.toolInput || call.tool_input || call.input || call.args || tool.input || {},
    toolResponse: call.toolResponse || call.tool_response || call.output || call.response || tool.output,
  };
}

export async function recordToolBatch(payload = {}) {
  const cwd = resolve(payload.cwd || process.cwd());
  const resolvedDb = migrateLegacyStepDatabase(cwd, payload.dbPath);
  const dbPath = resolvedDb.dbPath;

  if (!existsSync(dbPath)) {
    return { recorded: false, reason: 'not_initialized' };
  }

  const origin = payload.origin || ORIGINS.CLAUDE_CODE;
  const sessionId = normalizeOriginSessionId(origin, payload.sessionId);
  const toolCalls = Array.isArray(payload.toolCalls) ? payload.toolCalls.map(normalizeToolCall) : [];
  if (toolCalls.length === 0) {
    return { recorded: false, reason: 'empty_batch', sessionId, origin };
  }

  const batchId = payload.batchId || toolCalls
    .map(call => call.toolUseId || `${call.toolName || 'tool'}:${JSON.stringify(call.toolInput || {})}`)
    .join(',');

  const tracker = new StepTracker(cwd, { dbPath });
  try {
    await tracker.open();
    const stepId = await tracker.recordStep({
      origin,
      sessionId,
      toolUseId: `batch:${batchId}`,
      toolName: 'ToolBatch',
      toolInput: { toolCalls },
      toolCalls,
      cwd,
      timestamp: payload.timestamp || new Date().toISOString(),
    });
    return stepId
      ? { recorded: true, stepId, sessionId, origin, toolCallCount: toolCalls.length }
      : { recorded: false, reason: 'no_target_files', sessionId, origin, toolCallCount: toolCalls.length };
  } catch (err) {
    throw err;
  } finally {
    tracker.close();
  }
}
