#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook for step tracking.
 * Reads JSON payload from stdin, records the tool call as a step.
 * Silently no-ops if .ccusage/steps.db doesn't exist.
 */
import { resolve } from 'path';
import { existsSync } from 'fs';
import { StepTracker } from '../lib/step-tracker.js';

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

  // Silently no-op if not initialized
  const dbPath = resolve(cwd, '.ccusage', 'steps.db');
  if (!existsSync(dbPath)) process.exit(0);

  try {
    const tracker = new StepTracker(cwd, { dbPath });
    await tracker.open();
    await tracker.recordStep({
      sessionId: payload.session_id || payload.sessionId,
      toolUseId: payload.tool_use_id || payload.toolUseId,
      toolName: payload.tool_name || payload.toolName,
      toolInput: payload.tool_input || payload.toolInput,
      toolResponse: payload.tool_response || payload.toolResponse,
      cwd,
      timestamp: payload.timestamp || new Date().toISOString(),
    });
    tracker.close();
  } catch (e) {
    // Never fail the agent
    if (process.env.DEBUG_STEP_TRACKER) console.error('[step-tracker]', e.message);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
