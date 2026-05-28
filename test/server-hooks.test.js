import test from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startServer } from '../lib/server.js';

function onceListening(server) {
  return new Promise(resolve => server.once('listening', resolve));
}

test('server exposes hooks status and enables hooks from web API', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'server-hooks-'));
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

    const initial = await fetch(`http://127.0.0.1:${port}/api/hooks`).then(res => res.json());
    assert.equal(initial.stepsInitialized, false);
    assert.equal(initial.claude.enabled, false);
    assert.equal(initial.codex.enabled, false);

    const enabled = await fetch(`http://127.0.0.1:${port}/api/hooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'enable', tools: 'claude,codex' }),
    }).then(res => res.json());

    assert.equal(enabled.success, true);
    assert.equal(enabled.status.stepsInitialized, true);
    assert.equal(enabled.status.claude.enabled, true);
    assert.equal(enabled.status.codex.enabled, true);
    assert.ok(existsSync(join(tempDir, '.ccusage', 'steps.db')));
    assert.ok(existsSync(join(tempDir, '.claude', 'settings.local.json')));
    assert.ok(existsSync(join(tempDir, '.codex', 'config.toml')));
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
