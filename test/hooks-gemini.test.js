import test from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { StepTracker } from '../lib/step-tracker.js';
import {
  disableHooks,
  enableHooks,
  getHooksStatus,
  HOOK_TOOLS,
} from '../lib/hooks-manager.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('Gemini hook writes .gemini/settings.json with correct structure', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'gemini-hook-enable-'));
  try {
    const results = enableHooks(tempDir, [HOOK_TOOLS.GEMINI], { backup: false });
    assert.equal(results.length, 1);
    assert.equal(results[0].changed, true);
    assert.equal(results[0].tool, HOOK_TOOLS.GEMINI);

    const settingsPath = join(tempDir, '.gemini', 'settings.json');
    assert.ok(existsSync(settingsPath));

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.ok(settings.hooks);
    assert.ok(Array.isArray(settings.hooks.AfterTool));

    const geminiHook = settings.hooks.AfterTool.find(entry =>
      entry.matcher === 'write_.*|edit_.*|replace' &&
      Array.isArray(entry.hooks) &&
      entry.hooks.some(h => h.name === 'lumencode-step-tracker')
    );
    assert.ok(geminiHook, 'Should find lumencode hook in AfterTool');
    assert.match(geminiHook.hooks[0].command, /hooks[\\/]gemini-hook\.js/);
    assert.equal(geminiHook.hooks[0].type, 'command');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Gemini hook is idempotent', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'gemini-hook-idempotent-'));
  try {
    const firstResults = enableHooks(tempDir, [HOOK_TOOLS.GEMINI], { backup: false });
    assert.equal(firstResults[0].changed, true);

    const secondResults = enableHooks(tempDir, [HOOK_TOOLS.GEMINI], { backup: false });
    assert.equal(secondResults[0].changed, false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Gemini hook can be disabled', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'gemini-hook-disable-'));
  try {
    enableHooks(tempDir, [HOOK_TOOLS.GEMINI], { backup: false });

    const settingsPath = join(tempDir, '.gemini', 'settings.json');
    assert.ok(existsSync(settingsPath));

    const disableResults = disableHooks(tempDir, [HOOK_TOOLS.GEMINI], { backup: false });
    assert.equal(disableResults.length, 1);
    assert.equal(disableResults[0].changed, true);
    assert.equal(disableResults[0].tool, HOOK_TOOLS.GEMINI);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const geminiHook = settings.hooks?.AfterTool?.find(entry =>
      entry.matcher === 'write_.*|edit_.*|replace'
    );
    assert.equal(geminiHook, undefined);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Gemini disable is idempotent', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'gemini-disable-idempotent-'));
  try {
    const firstDisable = disableHooks(tempDir, [HOOK_TOOLS.GEMINI], { backup: false });
    assert.equal(firstDisable[0].changed, false);

    const secondDisable = disableHooks(tempDir, [HOOK_TOOLS.GEMINI], { backup: false });
    assert.equal(secondDisable[0].changed, false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Gemini hook status detection', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'gemini-hook-status-'));
  try {
    let status = getHooksStatus(tempDir);
    assert.equal(status.gemini.enabled, false);
    assert.equal(status.gemini.configExists, false);

    enableHooks(tempDir, [HOOK_TOOLS.GEMINI], { backup: false });

    status = getHooksStatus(tempDir);
    assert.equal(status.gemini.enabled, true);
    assert.equal(status.gemini.configExists, true);

    disableHooks(tempDir, [HOOK_TOOLS.GEMINI], { backup: false });

    status = getHooksStatus(tempDir);
    assert.equal(status.gemini.enabled, false);
    // configExists should still be true since file exists but hook is removed
    assert.equal(status.gemini.configExists, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('gemini-hook.js records tool execution', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'gemini-hook-exec-'));
  try {
    // Initialize steps tracking
    execFileSync(process.execPath, [join(root, 'hooks', 'init-steps.js')], {
      cwd: tempDir,
      encoding: 'utf8',
    });

    const payload = JSON.stringify({
      cwd: tempDir,
      session_id: 'gemini-session',
      tool_name: 'write_file',
      tool_input: { file_path: '/tmp/test.js', content: 'test' },
      tool_response: { success: true },
      timestamp: '2026-05-28T00:00:00.000Z',
    });

    execFileSync(process.execPath, [join(root, 'hooks', 'gemini-hook.js')], {
      cwd: tempDir,
      input: payload,
      encoding: 'utf8',
    });

    const tracker = new StepTracker(tempDir);
    await tracker.open();
    const stats = tracker.getStats();
    tracker.close();

    assert.equal(stats.stepCount, 1);
    assert.equal(stats.sessionCount, 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('gemini-hook.js records replace tool execution', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'gemini-hook-replace-'));
  try {
    execFileSync(process.execPath, [join(root, 'hooks', 'init-steps.js')], {
      cwd: tempDir,
      encoding: 'utf8',
    });

    const payload = JSON.stringify({
      cwd: tempDir,
      session_id: 'gemini-session',
      tool_name: 'replace',
      tool_input: { file_path: '/tmp/test.js', old_string: 'a', new_string: 'b' },
      tool_response: { success: true },
    });

    execFileSync(process.execPath, [join(root, 'hooks', 'gemini-hook.js')], {
      cwd: tempDir,
      input: payload,
      encoding: 'utf8',
    });

    const tracker = new StepTracker(tempDir);
    await tracker.open();
    const stats = tracker.getStats();
    tracker.close();

    assert.equal(stats.stepCount, 1, 'replace 工具应被追踪');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Gemini hook preserves existing hooks', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'gemini-hook-preserve-'));
  try {
    // Create initial settings with existing hooks
    const settingsPath = join(tempDir, '.gemini', 'settings.json');
    const existingSettings = {
      hooks: {
        BeforeTool: [
          {
            matcher: 'read_file',
            hooks: [{ name: 'security-check', type: 'command', command: 'node check.js' }],
          },
        ],
      },
    };
    mkdirSync(join(tempDir, '.gemini'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(existingSettings, null, 2));

    // Enable Gemini hooks
    enableHooks(tempDir, [HOOK_TOOLS.GEMINI], { backup: false });

    const updated = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.ok(Array.isArray(updated.hooks.BeforeTool));
    assert.ok(Array.isArray(updated.hooks.AfterTool));
    assert.equal(updated.hooks.BeforeTool.length, 1);
    assert.equal(updated.hooks.BeforeTool[0].matcher, 'read_file');

    const geminiHook = updated.hooks.AfterTool.find(entry =>
      entry.matcher === 'write_.*|edit_.*|replace'
    );
    assert.ok(geminiHook);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Gemini hook disable only removes lumencode hooks', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'gemini-hook-selective-remove-'));
  try {
    const settingsPath = join(tempDir, '.gemini', 'settings.json');
    const settings = {
      hooks: {
        AfterTool: [
          {
            matcher: 'write_.*|edit_.*|replace',
            hooks: [
              { name: 'other-hook', type: 'command', command: 'node other.js' },
            ],
          },
        ],
      },
    };
    mkdirSync(join(tempDir, '.gemini'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    // Enable then disable Gemini hooks
    enableHooks(tempDir, [HOOK_TOOLS.GEMINI], { backup: false });
    disableHooks(tempDir, [HOOK_TOOLS.GEMINI], { backup: false });

    const final = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.ok(Array.isArray(final.hooks.AfterTool));
    assert.equal(final.hooks.AfterTool.length, 1);
    // Should preserve other-hook
    assert.equal(final.hooks.AfterTool[0].hooks[0].name, 'other-hook');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
