import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('settings dirty observer only watches dynamic field containers', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /MutationObserver\(update\)\.observe\(view,/);
  assert.match(source, /dynamicIds\.forEach/);
});
