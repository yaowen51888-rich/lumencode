#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook for step tracking.
 * Reads JSON payload from stdin, records the tool call as a step.
 * Silently no-ops if .ccusage/steps.db doesn't exist.
 */
import { ORIGINS, recordToolUse } from '../lib/capture-recorder.js';

async function main() {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  let payload;
  try {
    payload = JSON.parse(chunks.join(''));
  } catch { process.exit(0); }

  const cwd = payload.cwd || payload.projectPath || process.cwd();

  try {
    await recordToolUse({
      origin: ORIGINS.CLAUDE_CODE,
      sessionId: payload.session_id || payload.sessionId,
      toolUseId: payload.tool_use_id || payload.toolUseId,
      toolName: payload.tool_name || payload.toolName,
      toolInput: payload.tool_input || payload.toolInput,
      toolResponse: payload.tool_response || payload.toolResponse,
      cwd,
      timestamp: payload.timestamp || new Date().toISOString(),
    });
  } catch (e) {
    // Never fail the agent
    if (process.env.DEBUG_STEP_TRACKER) console.error('[step-tracker]', e.message);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
