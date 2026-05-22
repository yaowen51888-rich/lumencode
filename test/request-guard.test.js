import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

function loadGuardFactory() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const code = readFileSync(join(root, 'public', 'request-guard.js'), 'utf8');
  const context = { AbortController };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(code, context);
  return context.createLatestRequestGuard;
}

test('latest request guard aborts stale requests and marks only newest token current', () => {
  const createLatestRequestGuard = loadGuardFactory();
  const guard = createLatestRequestGuard();

  const first = guard.next();
  const second = guard.next();

  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.signal.aborted, false);
  assert.equal(second.isCurrent(), true);
});
