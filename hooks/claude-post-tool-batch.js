#!/usr/bin/env node
/**
 * Claude Code PostToolBatch hook for step tracking.
 * Records one step per completed tool batch.
 */
import { ORIGINS, recordToolBatch } from '../lib/capture-recorder.js';

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

function normalizeToolCalls(payload) {
  const rawCalls = payload.tool_calls || payload.toolCalls || payload.tools || [];
  if (!Array.isArray(rawCalls)) return [];
  return rawCalls.map(call => ({
    toolUseId: call.tool_use_id || call.toolUseId || call.id,
    toolName: call.tool_name || call.toolName || call.name,
    toolInput: call.tool_input || call.toolInput || call.input || {},
    toolResponse: call.tool_response || call.toolResponse || call.output,
  }));
}

async function main() {
  const payload = await readPayload();
  if (!payload) process.exit(0);

  const cwd = payload.cwd || payload.projectPath || process.cwd();
  try {
    await recordToolBatch({
      origin: ORIGINS.CLAUDE_CODE,
      sessionId: payload.session_id || payload.sessionId,
      batchId: payload.batch_id || payload.batchId,
      toolCalls: normalizeToolCalls(payload),
      cwd,
      timestamp: payload.timestamp || new Date().toISOString(),
    });
  } catch (e) {
    if (process.env.DEBUG_STEP_TRACKER) console.error('[step-tracker]', e.message);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
