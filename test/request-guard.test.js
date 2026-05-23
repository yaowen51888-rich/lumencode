import test from 'node:test';
import assert from 'node:assert/strict';
import { createLatestRequestGuard } from '../public/api.js';

test('latest request guard aborts stale requests and marks only newest token current', () => {
  const guard = createLatestRequestGuard();

  const first = guard.next();
  const second = guard.next();

  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.signal.aborted, false);
  assert.equal(second.isCurrent(), true);
});
