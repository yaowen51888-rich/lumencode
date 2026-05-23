import test from 'node:test';
import assert from 'node:assert/strict';
import { createLatestRequestGuard } from '../public/api.js';

test('createLatestRequestGuard creates functional guard', () => {
  const guard = createLatestRequestGuard();
  assert.equal(typeof guard.next, 'function');

  const first = guard.next();
  assert.equal(typeof first.signal, 'object');
  assert.equal(typeof first.isCurrent, 'function');
  assert.equal(first.isCurrent(), true);
});

test('new request aborts previous', () => {
  const guard = createLatestRequestGuard();
  const first = guard.next();
  const second = guard.next();

  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.signal.aborted, false);
  assert.equal(second.isCurrent(), true);
});
