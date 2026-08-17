import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions } from '../lib/updater.js';

test('compareVersions 数值比较非字符串比较', () => {
  assert.equal(compareVersions('1.10.0', '1.4.2'), 1);
  assert.equal(compareVersions('1.4.2', '1.10.0'), -1);
});

test('compareVersions 相等与 v 前缀', () => {
  assert.equal(compareVersions('1.4.2', 'v1.4.2'), 0);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
});

test('compareVersions 缺段补 0', () => {
  assert.equal(compareVersions('1.4', '1.4.0'), 0);
  assert.equal(compareVersions('2.0', '1.9.9'), 1);
});
