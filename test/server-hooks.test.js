import test from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startServer } from '../lib/server.js';

function onceListening(server) {
  return new Promise(resolve => server.once('listening', resolve));
}

test('server exposes hooks status and enables hooks from web API', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'server-hooks-'));
  const launchDir = join(tempDir, 'launch');
  const repoDir = join(tempDir, 'repo');
  const oldCwd = process.cwd();
  const oldPort = process.env.LUMENCODE_PORT;
  const oldNoOpen = process.env.LUMENCODE_NO_OPEN;
  mkdirSync(launchDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  process.chdir(launchDir);
  process.env.LUMENCODE_PORT = '0';
  process.env.LUMENCODE_NO_OPEN = '1';

  const server = startServer({ repos: [repoDir] }, null, async () => null, join(tempDir, 'config.json'));
  try {
    await onceListening(server);
    const { port } = server.address();

    const initial = await fetch(`http://127.0.0.1:${port}/api/hooks`).then(res => res.json());
    assert.equal(initial.projectCount, 1);
    assert.equal(initial.stepsInitialized, false);
    assert.equal(initial.claude.enabled, false);
    assert.equal(initial.codex.enabled, false);
    assert.equal(initial.opencode.enabled, false);

    const enabled = await fetch(`http://127.0.0.1:${port}/api/hooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'enable', tools: 'claude,codex,opencode' }),
    }).then(res => res.json());

    assert.equal(enabled.success, true);
    assert.equal(enabled.status.stepsInitialized, true);
    assert.equal(enabled.status.claude.enabled, true);
    assert.equal(enabled.status.codex.enabled, true);
    assert.equal(enabled.status.opencode.enabled, true);
    assert.ok(existsSync(join(repoDir, '.lumencode', 'steps.db')));
    assert.ok(existsSync(join(repoDir, '.claude', 'settings.local.json')));
    assert.ok(existsSync(join(repoDir, '.codex', 'config.toml')));
    assert.ok(existsSync(join(repoDir, '.opencode', 'plugins', 'lumencode-step-tracker.js')));
    assert.equal(existsSync(join(launchDir, '.lumencode', 'steps.db')), false);
    assert.equal(existsSync(join(launchDir, '.claude', 'settings.local.json')), false);
    assert.equal(existsSync(join(launchDir, '.codex', 'config.toml')), false);
    assert.equal(existsSync(join(launchDir, '.opencode', 'plugins', 'lumencode-step-tracker.js')), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    process.chdir(oldCwd);
    if (oldPort === undefined) delete process.env.LUMENCODE_PORT;
    else process.env.LUMENCODE_PORT = oldPort;
    if (oldNoOpen === undefined) delete process.env.LUMENCODE_NO_OPEN;
    else process.env.LUMENCODE_NO_OPEN = oldNoOpen;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('server hooks API requires configured repos instead of using launch directory', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'server-hooks-empty-'));
  const oldCwd = process.cwd();
  const oldPort = process.env.LUMENCODE_PORT;
  const oldNoOpen = process.env.LUMENCODE_NO_OPEN;
  process.chdir(tempDir);
  process.env.LUMENCODE_PORT = '0';
  process.env.LUMENCODE_NO_OPEN = '1';

  const server = startServer({}, null, async () => null, join(tempDir, 'config.json'));
  try {
    await onceListening(server);
    const { port } = server.address();

    const res = await fetch(`http://127.0.0.1:${port}/api/hooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'enable', tools: 'claude,codex,opencode' }),
    });
    const body = await res.json();

    assert.equal(res.status, 400);
    assert.match(body.error, /项目路径/);
    assert.equal(existsSync(join(tempDir, '.lumencode', 'steps.db')), false);
    assert.equal(existsSync(join(tempDir, '.claude', 'settings.local.json')), false);
    assert.equal(existsSync(join(tempDir, '.codex', 'config.toml')), false);
    assert.equal(existsSync(join(tempDir, '.opencode', 'plugins', 'lumencode-step-tracker.js')), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    process.chdir(oldCwd);
    if (oldPort === undefined) delete process.env.LUMENCODE_PORT;
    else process.env.LUMENCODE_PORT = oldPort;
    if (oldNoOpen === undefined) delete process.env.LUMENCODE_NO_OPEN;
    else process.env.LUMENCODE_NO_OPEN = oldNoOpen;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('adding new project via /api/config inherits enabled hooks', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'server-hooks-inherit-'));
  const launchDir = join(tempDir, 'launch');
  const repo1 = join(tempDir, 'repo1');
  const repo2 = join(tempDir, 'repo2');
  const oldCwd = process.cwd();
  const oldPort = process.env.LUMENCODE_PORT;
  const oldNoOpen = process.env.LUMENCODE_NO_OPEN;
  mkdirSync(launchDir, { recursive: true });
  mkdirSync(repo1, { recursive: true });
  mkdirSync(repo2, { recursive: true });
  process.chdir(launchDir);
  process.env.LUMENCODE_PORT = '0';
  process.env.LUMENCODE_NO_OPEN = '1';

  const server = startServer({ repos: [repo1] }, null, async () => null, join(tempDir, 'config.json'));
  try {
    await onceListening(server);
    const { port } = server.address();

    // 先给 repo1 开启 claude hook（仅 claude，用于验证继承工具集精确）
    await fetch(`http://127.0.0.1:${port}/api/hooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'enable', tools: 'claude' }),
    }).then(res => res.json());

    // 新增 repo2 到配置
    const saved = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repos: [repo1, repo2] }),
    }).then(res => res.json());
    assert.equal(saved.success, true);

    // repo2 应自动继承 claude hook + steps.db
    assert.ok(existsSync(join(repo2, '.claude', 'settings.local.json')));
    assert.ok(existsSync(join(repo2, '.lumencode', 'steps.db')));

    const status = await fetch(`http://127.0.0.1:${port}/api/hooks`).then(res => res.json());
    assert.equal(status.projectCount, 2);
    const repo2Status = status.projects.find(p => p.claude.configPath.replace(/\\/g, '/').includes('/repo2/'));
    assert.ok(repo2Status, 'repo2 status found');
    assert.equal(repo2Status.claude.enabled, true);
    // 仅继承了 claude，codex 不应被开启
    assert.equal(repo2Status.codex.enabled, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    process.chdir(oldCwd);
    if (oldPort === undefined) delete process.env.LUMENCODE_PORT;
    else process.env.LUMENCODE_PORT = oldPort;
    if (oldNoOpen === undefined) delete process.env.LUMENCODE_NO_OPEN;
    else process.env.LUMENCODE_NO_OPEN = oldNoOpen;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('adding new project does not inherit hooks when none enabled', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'server-hooks-noinherit-'));
  const launchDir = join(tempDir, 'launch');
  const repo1 = join(tempDir, 'repo1');
  const repo2 = join(tempDir, 'repo2');
  const oldCwd = process.cwd();
  const oldPort = process.env.LUMENCODE_PORT;
  const oldNoOpen = process.env.LUMENCODE_NO_OPEN;
  mkdirSync(launchDir, { recursive: true });
  mkdirSync(repo1, { recursive: true });
  mkdirSync(repo2, { recursive: true });
  process.chdir(launchDir);
  process.env.LUMENCODE_PORT = '0';
  process.env.LUMENCODE_NO_OPEN = '1';

  const server = startServer({ repos: [repo1] }, null, async () => null, join(tempDir, 'config.json'));
  try {
    await onceListening(server);
    const { port } = server.address();

    // repo1 未开任何 hook，新增 repo2 不应继承
    await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repos: [repo1, repo2] }),
    }).then(res => res.json());

    assert.equal(existsSync(join(repo2, '.claude', 'settings.local.json')), false);
    assert.equal(existsSync(join(repo2, '.lumencode', 'steps.db')), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    process.chdir(oldCwd);
    if (oldPort === undefined) delete process.env.LUMENCODE_PORT;
    else process.env.LUMENCODE_PORT = oldPort;
    if (oldNoOpen === undefined) delete process.env.LUMENCODE_NO_OPEN;
    else process.env.LUMENCODE_NO_OPEN = oldNoOpen;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

