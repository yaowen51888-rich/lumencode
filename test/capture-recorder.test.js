import test from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StepTracker } from '../lib/step-tracker.js';
import {
  ORIGINS,
  normalizeOriginSessionId,
  recordToolUse,
} from '../lib/capture-recorder.js';

test('normalizeOriginSessionId prefixes raw session ids and keeps prefixed ids stable', () => {
  assert.equal(
    normalizeOriginSessionId(ORIGINS.CLAUDE_CODE, 'session-a'),
    'claude_code:session-a'
  );
  assert.equal(
    normalizeOriginSessionId(ORIGINS.CODEX_CLI, 'codex_cli:session-b'),
    'codex_cli:session-b'
  );
});

test('recordToolUse records target file writes under origin-prefixed session id', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'capture-recorder-'));
  try {
    const tracker = new StepTracker(tempDir);
    await tracker.open();
    tracker.close();

    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    const filePath = join(srcDir, 'capture.js');
    writeFileSync(filePath, 'export const captured = true;\n');

    const result = await recordToolUse({
      origin: ORIGINS.CLAUDE_CODE,
      sessionId: 'session-a',
      toolUseId: 'tool-use-a',
      toolName: 'Write',
      toolInput: { file_path: filePath },
      cwd: tempDir,
      timestamp: '2026-05-28T00:00:00.000Z',
    });

    assert.equal(result.recorded, true);
    assert.equal(result.sessionId, 'claude_code:session-a');

    const verifyTracker = new StepTracker(tempDir);
    await verifyTracker.open();
    const head = verifyTracker.db.getSessionHead('claude_code:session-a');
    const rawHead = verifyTracker.db.getSessionHead('session-a');
    const step = verifyTracker.db.getStepById(head);
    verifyTracker.close();

    assert.ok(head);
    assert.equal(rawHead, null);
    assert.equal(step.origin, 'claude_code');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('recordToolUse no-ops when step tracking database is not initialized', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'capture-no-db-'));
  try {
    const result = await recordToolUse({
      origin: ORIGINS.CODEX_CLI,
      sessionId: 'session-a',
      toolUseId: 'tool-use-a',
      toolName: 'Write',
      toolInput: { file_path: join(tempDir, 'missing.js') },
      cwd: tempDir,
    });

    assert.equal(result.recorded, false);
    assert.equal(result.reason, 'not_initialized');
    assert.equal(existsSync(join(tempDir, '.ccusage', 'steps.db')), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
