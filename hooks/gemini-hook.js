#!/usr/bin/env node
/**
 * Gemini CLI AfterTool hook for step tracking.
 * Records one step per tool execution.
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

  const cwd = payload.cwd || payload.projectPath || process.cwd();
  try {
    // Gemini AfterTool hook payload: tool_name, tool_input, tool_response, cwd/session_id
    await recordToolUse({
      origin: ORIGINS.GEMINI,
      sessionId: payload.session_id || payload.sessionId || process.env.GEMINI_SESSION_ID,
      toolUseId: `${payload.tool_name}-${Date.now()}`,
      toolName: payload.tool_name,
      toolInput: payload.tool_input || {},
      toolResponse: payload.tool_response || {},
      cwd,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    if (process.env.DEBUG_STEP_TRACKER) console.error('[gemini-hook]', e.message);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
