import test from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
    const command = settings.hooks.PostToolBatch[0].hooks[0].command;
    assert.match(command, /hooks[\\/]claude-post-tool-batch\.js/);
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

test('post-tool-batch hook records one initialized batch payload', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'hook-post-tool-batch-'));
  try {
    execFileSync(process.execPath, [join(root, 'hooks', 'init-steps.js')], {
      cwd: tempDir,
      encoding: 'utf8',
    });

    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    const firstPath = join(srcDir, 'batch-a.js');
    const secondPath = join(srcDir, 'batch-b.js');
    writeFileSync(firstPath, 'export const batchA = true;\n');
    writeFileSync(secondPath, 'export const batchB = true;\n');

    const payload = JSON.stringify({
      cwd: tempDir,
      session_id: 'batch-session',
      batch_id: 'batch-id',
      tool_calls: [
        { tool_use_id: 'a', tool_name: 'Write', tool_input: { file_path: firstPath } },
        { tool_use_id: 'b', tool_name: 'Edit', tool_input: { file_path: secondPath } },
      ],
      timestamp: '2026-05-28T00:00:00.000Z',
    });

    execFileSync(process.execPath, [join(root, 'hooks', 'claude-post-tool-batch.js')], {
      cwd: tempDir,
      input: payload,
      encoding: 'utf8',
    });

    const tracker = new StepTracker(tempDir);
    await tracker.open();
    const stats = tracker.getStats();
    const head = tracker.db.getSessionHead('claude_code:batch-session');
    const step = tracker.db.getStepById(head);
    tracker.close();

    assert.equal(stats.stepCount, 1);
    assert.ok(head);
    assert.equal(step.tool_name, 'ToolBatch');
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

test('OpenCode hook records tool.execute.after payload with opencode origin session id', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'opencode-hook-post-tool-'));
  try {
    execFileSync(process.execPath, [join(root, 'hooks', 'init-steps.js')], {
      cwd: tempDir,
      encoding: 'utf8',
    });

    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    const filePath = join(srcDir, 'opencode-hooked.js');
    writeFileSync(filePath, 'export const opencodeHooked = true;\n');

    const payload = JSON.stringify({
      cwd: tempDir,
      sessionId: 'opencode-session',
      toolUseId: 'opencode-tool-use',
      toolName: 'write',
      toolInput: { path: filePath },
      timestamp: '2026-05-28T00:00:00.000Z',
    });

    execFileSync(process.execPath, [join(root, 'hooks', 'opencode-hook.js')], {
      cwd: tempDir,
      input: payload,
      encoding: 'utf8',
    });

    const tracker = new StepTracker(tempDir);
    await tracker.open();
    const stats = tracker.getStats();
    const head = tracker.db.getSessionHead('opencode:opencode-session');
    const rawHead = tracker.db.getSessionHead('opencode-session');
    const step = tracker.db.getStepById(head);
    tracker.close();

    assert.equal(stats.stepCount, 1);
    assert.equal(stats.sessionCount, 1);
    assert.ok(head);
    assert.equal(rawHead, null);
    assert.equal(step.origin, 'opencode');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('hooks manager enables status and backups for Claude Codex and OpenCode configs', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'hooks-manager-enable-'));
  try {
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    mkdirSync(join(tempDir, '.codex'), { recursive: true });
    writeFileSync(join(tempDir, '.claude', 'settings.local.json'), JSON.stringify({
      theme: 'dark',
      hooks: {
        PostToolUse: [
          { matcher: 'Write', hooks: [{ type: 'command', command: 'node other-hook.js' }] },
        ],
      },
    }, null, 2));
    writeFileSync(join(tempDir, '.codex', 'config.toml'), '[features]\nhooks = false\nmodel = "gpt-5"\n');

    const results = enableHooks(tempDir, [HOOK_TOOLS.CLAUDE, HOOK_TOOLS.CODEX, HOOK_TOOLS.OPENCODE], { backup: true });
    assert.deepEqual(results.map(result => result.changed), [true, true, true]);
    assert.ok(existsSync(join(tempDir, '.claude', 'settings.local.json.bak')));
    assert.ok(existsSync(join(tempDir, '.codex', 'config.toml.bak')));

    const settings = JSON.parse(readFileSync(join(tempDir, '.claude', 'settings.local.json'), 'utf8'));
    assert.equal(settings.theme, 'dark');
    assert.equal(settings.hooks.PostToolUse.length, 1);
    assert.equal(settings.hooks.PostToolBatch.length, 1);
    assert.match(settings.hooks.PostToolBatch[0].hooks[0].command, /claude-post-tool-batch\.js/);

    const config = readFileSync(join(tempDir, '.codex', 'config.toml'), 'utf8');
    assert.match(config, /\[features\]\nhooks = true\nmodel = "gpt-5"/);
    assert.match(config, /hooks[\\/]codex-hook\.js/);

    const status = getHooksStatus(tempDir);
    assert.equal(status.claude.enabled, true);
    assert.equal(status.claude.batchEnabled, true);
    assert.equal(status.codex.enabled, true);
    assert.equal(status.opencode.enabled, true);
    assert.ok(existsSync(join(tempDir, '.opencode', 'plugins', 'lumencode-step-tracker.js')));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('hooks manager disables only lumencode hooks', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'hooks-manager-disable-'));
  try {
    enableHooks(tempDir, [HOOK_TOOLS.CLAUDE, HOOK_TOOLS.CODEX, HOOK_TOOLS.OPENCODE], { backup: false });

    const settingsPath = join(tempDir, '.claude', 'settings.local.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    settings.hooks.PostToolUse = settings.hooks.PostToolUse || [];
    settings.hooks.PostToolUse.push({
      matcher: 'Edit',
      hooks: [{ type: 'command', command: 'node user-post-tool-use.js' }],
    });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    const configPath = join(tempDir, '.codex', 'config.toml');
    writeFileSync(configPath, `${readFileSync(configPath, 'utf8').trimEnd()}

[[hooks.PostToolUse]]
matcher = "Edit"
[[hooks.PostToolUse.hooks]]
type = "command"
command = 'node "user-hook.js"'
`);

    const results = disableHooks(tempDir, [HOOK_TOOLS.CLAUDE, HOOK_TOOLS.CODEX, HOOK_TOOLS.OPENCODE], { backup: true });
    assert.deepEqual(results.map(result => result.changed), [true, true, true]);

    const nextSettings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(nextSettings.hooks.PostToolUse.length, 1);
    assert.match(nextSettings.hooks.PostToolUse[0].hooks[0].command, /user-post-tool-use/);

    const nextConfig = readFileSync(configPath, 'utf8');
    assert.doesNotMatch(nextConfig, /codex-hook\.js/);
    assert.match(nextConfig, /user-hook\.js/);

    const status = getHooksStatus(tempDir);
    assert.equal(status.claude.enabled, false);
    assert.equal(status.codex.enabled, false);
    assert.equal(status.opencode.enabled, false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('hooks CLI status and enable commands work non-interactively', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'hooks-cli-'));
  try {
    const initial = execFileSync(process.execPath, [join(root, 'index.js'), 'hooks', 'status'], {
      cwd: tempDir,
      encoding: 'utf8',
    });
    assert.match(initial, /Claude Code: 未开启/);
    assert.match(initial, /Codex: 未开启/);
    assert.match(initial, /OpenCode: 未开启/);

    const enabled = execFileSync(process.execPath, [join(root, 'index.js'), 'hooks', 'enable', 'claude,codex,opencode', '--yes'], {
      cwd: tempDir,
      encoding: 'utf8',
    });
    assert.match(enabled, /Claude Code: 已开启/);
    assert.match(enabled, /Codex: 已开启/);
    assert.match(enabled, /OpenCode: 已开启/);

    const status = execFileSync(process.execPath, [join(root, 'index.js'), 'hooks', 'status'], {
      cwd: tempDir,
      encoding: 'utf8',
    });
    assert.match(status, /Claude Code: 已开启/);
    assert.match(status, /Codex: 已开启/);
    assert.match(status, /OpenCode: 已开启/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('hooks CLI enable prompts for detected tools when no tool args are provided', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'hooks-cli-prompt-'));
  try {
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    mkdirSync(join(tempDir, '.codex'), { recursive: true });
    mkdirSync(join(tempDir, '.opencode', 'plugins'), { recursive: true });
    writeFileSync(join(tempDir, '.claude', 'settings.local.json'), JSON.stringify({}, null, 2));
    writeFileSync(join(tempDir, '.codex', 'config.toml'), '[features]\n');
    writeFileSync(join(tempDir, '.opencode', 'plugins', 'lumencode-step-tracker.js'), 'export default {};\n');

    const proc = spawnSync(process.execPath, [join(root, 'index.js'), 'hooks', 'enable'], {
      cwd: tempDir,
      input: '1,3\n确认\n',
      encoding: 'utf8',
    });
    const output = `${proc.stdout || ''}${proc.stderr || ''}`;
    assert.equal(proc.status, 0, output);

    assert.match(output, /检测到:/);
    assert.match(output, /\[1\] Claude Code/);
    assert.match(output, /\[2\] Codex/);
    assert.match(output, /\[3\] OpenCode/);

    const status = getHooksStatus(tempDir);
    assert.equal(status.stepsInitialized, true);
    assert.equal(status.claude.enabled, true);
    assert.equal(status.codex.enabled, false);
    assert.equal(status.opencode.enabled, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
