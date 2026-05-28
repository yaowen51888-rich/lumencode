#!/usr/bin/env node
/**
 * OpenCode tool.execute.after adapter for step tracking.
 */
import { ORIGINS, recordToolUse } from '../lib/capture-recorder.js';

async function readPayload() {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    return JSON.parse(chunks.join(''));
  } catch {
    return null;
  }
}

async function main() {
  const payload = await readPayload();
  if (!payload) process.exit(0);

  const input = payload.input || {};
  const output = payload.output || {};
  const tool = payload.tool || input.tool || {};
  const cwd = payload.cwd || input.cwd || input.directory || payload.directory || process.cwd();

  try {
    await recordToolUse({
      origin: ORIGINS.OPENCODE,
      sessionId: payload.sessionId || payload.session_id || input.sessionID || input.sessionId || input.session_id || input.session?.id,
      toolUseId: payload.toolUseId || payload.tool_use_id || input.toolCallID || input.toolUseId || input.id,
      toolName: payload.toolName || payload.tool_name || input.toolName || input.tool || tool.name,
      toolInput: payload.toolInput || payload.tool_input || output.args || input.args || input.toolInput || {},
      toolResponse: payload.toolResponse || payload.tool_response || output.result || output,
      cwd,
      timestamp: payload.timestamp || new Date().toISOString(),
    });
  } catch (e) {
    if (process.env.DEBUG_STEP_TRACKER) console.error('[step-tracker]', e.message);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
