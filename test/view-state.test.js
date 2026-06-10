import test from 'node:test';
import assert from 'node:assert/strict';
import { formatViewStateHash, parseViewStateHash } from '../public/view-state.js';

test('parseViewStateHash restores report view from hash', () => {
  assert.deepEqual(parseViewStateHash('#report/weekly/2026-06-05'), {
    view: 'report',
    period: 'weekly',
    currentDate: '2026-06-05',
  });
});

test('parseViewStateHash keeps old period/date hashes compatible', () => {
  assert.deepEqual(parseViewStateHash('#monthly/2026-06-01'), {
    view: 'ledger',
    period: 'monthly',
    currentDate: '2026-06-01',
  });
});

test('formatViewStateHash includes current view', () => {
  assert.equal(formatViewStateHash({
    view: 'report',
    period: 'daily',
    currentDate: '2026-06-05',
  }), 'report/daily/2026-06-05');
});
