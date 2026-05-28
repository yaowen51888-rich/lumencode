#!/usr/bin/env node
/**
 * Codex PostToolUse hook adapter.
 * Normalizes Codex hook payloads and records tool calls through capture-recorder.
 */
import { ORIGINS, recordToolUse } from '../lib/capture-recorder.js';

function normalizeEventName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

async function readPayload() {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  try {
    return JSON.parse(chunks.join(''));
  } catch {
    return null;
  }
}

async function main() {
  const payload = await readPayload();
  if (!payload) process.exit(0);

  const eventName = normalizeEventName(
    payload.hook_event_name || payload.hookEventName || payload.event
  );
  if (eventName !== 'posttooluse') process.exit(0);

  const tool = payload.tool || {};
  const cwd = payload.cwd || payload.projectPath || payload.workspace || process.cwd();

  try {
    await recordToolUse({
      origin: ORIGINS.CODEX_CLI,
      sessionId: payload.session_id || payload.sessionId,
      toolUseId: payload.tool_use_id || payload.toolUseId || payload.call_id || payload.callId,
      toolName: payload.tool_name || payload.toolName || tool.name,
      toolInput: payload.tool_input || payload.toolInput || payload.input || tool.input,
      toolResponse: payload.tool_response || payload.toolResponse || payload.output || tool.output,
      cwd,
      timestamp: payload.timestamp || new Date().toISOString(),
    });
  } catch (e) {
    if (process.env.DEBUG_STEP_TRACKER) console.error('[step-tracker]', e.message);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
