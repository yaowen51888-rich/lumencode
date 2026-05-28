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
    assert.ok(existsSync(join(repoDir, '.ccusage', 'steps.db')));
    assert.ok(existsSync(join(repoDir, '.claude', 'settings.local.json')));
    assert.ok(existsSync(join(repoDir, '.codex', 'config.toml')));
    assert.ok(existsSync(join(repoDir, '.opencode', 'plugins', 'lumencode-step-tracker.js')));
    assert.equal(existsSync(join(launchDir, '.ccusage', 'steps.db')), false);
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
    assert.equal(existsSync(join(tempDir, '.ccusage', 'steps.db')), false);
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
