import test from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { StepTracker } from '../lib/step-tracker.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('hooks installer writes Claude settings with packaged hook path', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'hook-install-'));
  try {
    execFileSync(process.execPath, [join(root, 'hooks', 'install.js')], {
      cwd: tempDir,
      encoding: 'utf8',
    });

    const settingsPath = join(tempDir, '.claude', 'settings.local.json');
    assert.ok(existsSync(settingsPath));

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const command = settings.hooks.PostToolUse[0].hooks[0].command;
    assert.match(command, /hooks[\\/]post-tool-use\.js/);
    assert.ok(!command.includes(tempDir), 'hook command should point to installed package files');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('post-tool-use hook records initialized file write payload', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'hook-post-tool-'));
  try {
    execFileSync(process.execPath, [join(root, 'hooks', 'init-steps.js')], {
      cwd: tempDir,
      encoding: 'utf8',
    });

    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    const filePath = join(srcDir, 'hooked.js');
    writeFileSync(filePath, 'export const hooked = true;\n');

    const payload = JSON.stringify({
      cwd: tempDir,
      session_id: 'hook-session',
      tool_use_id: 'hook-tool-use',
      tool_name: 'Write',
      tool_input: { file_path: filePath },
      timestamp: '2026-05-28T00:00:00.000Z',
    });

    execFileSync(process.execPath, [join(root, 'hooks', 'post-tool-use.js')], {
      cwd: tempDir,
      input: payload,
      encoding: 'utf8',
    });

    const tracker = new StepTracker(tempDir);
    await tracker.open();
    const stats = tracker.getStats();
    const head = tracker.db.getSessionHead('claude_code:hook-session');
    const rawHead = tracker.db.getSessionHead('hook-session');
    tracker.close();

    assert.equal(stats.stepCount, 1);
    assert.equal(stats.sessionCount, 1);
    assert.ok(head);
    assert.equal(rawHead, null);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Codex hooks installer writes config with hooks feature and packaged hook path', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'codex-hook-install-'));
  try {
    execFileSync(process.execPath, [join(root, 'hooks', 'install-codex.js')], {
      cwd: tempDir,
      encoding: 'utf8',
    });

    const configPath = join(tempDir, '.codex', 'config.toml');
    assert.ok(existsSync(configPath));

    const config = readFileSync(configPath, 'utf8');
    assert.match(config, /\[features\]\s+hooks = true/);
    assert.match(config, /\[\[hooks\.PostToolUse\]\]/);
    assert.match(config, /hooks[\\/]codex-hook\.js/);
    assert.ok(!config.includes(tempDir), 'hook command should point to installed package files');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Codex hook records PostToolUse payload with codex origin session id', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'codex-hook-post-tool-'));
  try {
    execFileSync(process.execPath, [join(root, 'hooks', 'init-steps.js')], {
      cwd: tempDir,
      encoding: 'utf8',
    });

    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    const filePath = join(srcDir, 'codex-hooked.js');
    writeFileSync(filePath, 'export const codexHooked = true;\n');

    const payload = JSON.stringify({
      hook_event_name: 'PostToolUse',
      cwd: tempDir,
      session_id: 'codex-session',
      tool_use_id: 'codex-tool-use',
      tool_name: 'Write',
      tool_input: { file_path: filePath },
      timestamp: '2026-05-28T00:00:00.000Z',
    });

    execFileSync(process.execPath, [join(root, 'hooks', 'codex-hook.js')], {
      cwd: tempDir,
      input: payload,
      encoding: 'utf8',
    });

    const tracker = new StepTracker(tempDir);
    await tracker.open();
    const stats = tracker.getStats();
    const head = tracker.db.getSessionHead('codex_cli:codex-session');
    const rawHead = tracker.db.getSessionHead('codex-session');
    const step = tracker.db.getStepById(head);
    tracker.close();

    assert.equal(stats.stepCount, 1);
    assert.equal(stats.sessionCount, 1);
    assert.ok(head);
    assert.equal(rawHead, null);
    assert.equal(step.origin, 'codex_cli');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
