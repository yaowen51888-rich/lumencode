import test from 'node:test';
import { strict as assert } from 'node:assert';
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StepTracker } from '../lib/step-tracker.js';
import {
  ORIGINS,
  normalizeOriginSessionId,
  recordToolBatch,
  recordToolUse,
} from '../lib/capture-recorder.js';

async function initLegacyStepDatabase(projectRoot) {
  const tracker = new StepTracker(projectRoot, { dbPath: 'legacy-setup/steps.db' });
  await tracker.open();
  tracker.close();
  mkdirSync(join(projectRoot, '.ccusage'), { recursive: true });
  const legacy = join(projectRoot, 'legacy-setup', 'steps.db');
  const target = join(projectRoot, '.ccusage', 'steps.db');
  writeFileSync(target, readFileSync(legacy));
}

test('normalizeOriginSessionId prefixes raw session ids and keeps prefixed ids stable', () => {
  assert.equal(
    normalizeOriginSessionId(ORIGINS.CLAUDE_CODE, 'session-a'),
    'claude_code:session-a'
  );
  assert.equal(
    normalizeOriginSessionId(ORIGINS.CODEX_CLI, 'codex_cli:session-b'),
    'codex_cli:session-b'
  );
  assert.equal(
    normalizeOriginSessionId(ORIGINS.OPENCODE, 'session-c'),
    'opencode:session-c'
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

test('recordToolUse migrates explicit legacy default dbPath before initialization check', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'capture-legacy-use-'));
  try {
    await initLegacyStepDatabase(tempDir);
    const filePath = join(tempDir, 'legacy-use.js');
    writeFileSync(filePath, 'export const legacyUse = true;\n');

    const result = await recordToolUse({
      origin: ORIGINS.CODEX_CLI,
      sessionId: 'session-a',
      toolUseId: 'tool-use-a',
      toolName: 'Write',
      toolInput: { file_path: filePath },
      cwd: tempDir,
      dbPath: '.ccusage/steps.db',
    });

    assert.equal(result.recorded, true);
    assert.equal(existsSync(join(tempDir, '.lumencode', 'steps.db')), true);
    assert.equal(existsSync(join(tempDir, '.ccusage', 'steps.db')), true);
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
    assert.equal(existsSync(join(tempDir, '.lumencode', 'steps.db')), false);
    assert.equal(existsSync(join(tempDir, '.ccusage', 'steps.db')), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('recordToolBatch records one step for multiple target files', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'capture-batch-'));
  try {
    const tracker = new StepTracker(tempDir);
    await tracker.open();
    tracker.close();

    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    const firstPath = join(srcDir, 'first.js');
    const secondPath = join(srcDir, 'second.js');
    writeFileSync(firstPath, 'export const first = true;\n');
    writeFileSync(secondPath, 'export const second = true;\n');

    const result = await recordToolBatch({
      origin: ORIGINS.CLAUDE_CODE,
      sessionId: 'batch-session',
      batchId: 'batch-a',
      cwd: tempDir,
      timestamp: '2026-05-28T00:00:00.000Z',
      toolCalls: [
        { toolUseId: 'a', toolName: 'Write', toolInput: { file_path: firstPath } },
        { toolUseId: 'b', toolName: 'Edit', toolInput: { file_path: secondPath } },
      ],
    });

    assert.equal(result.recorded, true);
    assert.equal(result.toolCallCount, 2);

    const verifyTracker = new StepTracker(tempDir);
    await verifyTracker.open();
    const stats = verifyTracker.getStats();
    const head = verifyTracker.db.getSessionHead('claude_code:batch-session');
    const step = verifyTracker.db.getStepById(head);
    verifyTracker.close();

    assert.equal(stats.stepCount, 1);
    assert.ok(head);
    assert.equal(step.tool_name, 'ToolBatch');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('recordToolBatch migrates explicit legacy default dbPath before initialization check', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'capture-legacy-batch-'));
  try {
    await initLegacyStepDatabase(tempDir);
    const firstPath = join(tempDir, 'legacy-first.js');
    writeFileSync(firstPath, 'export const legacyFirst = true;\n');

    const result = await recordToolBatch({
      origin: ORIGINS.CLAUDE_CODE,
      sessionId: 'batch-session',
      batchId: 'batch-a',
      cwd: tempDir,
      dbPath: '.ccusage/steps.db',
      toolCalls: [
        { toolUseId: 'a', toolName: 'Write', toolInput: { file_path: firstPath } },
      ],
    });

    assert.equal(result.recorded, true);
    assert.equal(existsSync(join(tempDir, '.lumencode', 'steps.db')), true);
    assert.equal(existsSync(join(tempDir, '.ccusage', 'steps.db')), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
test('recordToolUse returns lock_timeout when StepDatabase lock is busy', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'capture-lock-'));
  try {
    const tracker = new StepTracker(tempDir);
    await tracker.open();
    tracker.close();

    const lockPath = join(tempDir, '.lumencode', 'steps.db.lock');
    const fd = openSync(lockPath, 'wx');
    try {
      const filePath = join(tempDir, 'locked.js');
      writeFileSync(filePath, 'export const locked = true;\n');
      const result = await recordToolUse({
        origin: ORIGINS.CODEX_CLI,
        sessionId: 'session-lock',
        toolUseId: 'tool-lock',
        toolName: 'Write',
        toolInput: { file_path: filePath },
        cwd: tempDir,
      });

      assert.equal(result.recorded, false);
      assert.equal(result.reason, 'lock_timeout');
      assert.equal(result.sessionId, 'codex_cli:session-lock');
    } finally {
      closeSync(fd);
      unlinkSync(lockPath);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('recordToolBatch returns lock_timeout when StepDatabase lock is busy', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'capture-batch-lock-'));
  try {
    const tracker = new StepTracker(tempDir);
    await tracker.open();
    tracker.close();

    const lockPath = join(tempDir, '.lumencode', 'steps.db.lock');
    const fd = openSync(lockPath, 'wx');
    try {
      const filePath = join(tempDir, 'batch-locked.js');
      writeFileSync(filePath, 'export const batchLocked = true;\n');
      const result = await recordToolBatch({
        origin: ORIGINS.CLAUDE_CODE,
        sessionId: 'batch-lock',
        batchId: 'busy',
        cwd: tempDir,
        toolCalls: [
          { toolUseId: 'a', toolName: 'Write', toolInput: { file_path: filePath } },
        ],
      });

      assert.equal(result.recorded, false);
      assert.equal(result.reason, 'lock_timeout');
      assert.equal(result.sessionId, 'claude_code:batch-lock');
    } finally {
      closeSync(fd);
      unlinkSync(lockPath);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
