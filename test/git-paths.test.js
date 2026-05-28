import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  normalizePathForGit,
  projectMatches,
  toRepoRelativePath,
} from '../lib/git-paths.js';

test('normalizePathForGit - normalizes slashes case and trailing slash', () => {
  assert.equal(normalizePathForGit('D:\\repo\\lib\\a.js'), 'd:/repo/lib/a.js');
});

test('toRepoRelativePath - returns repo relative paths', () => {
  assert.equal(toRepoRelativePath('D:/repo/lib/a.js', 'D:/repo'), 'lib/a.js');
  assert.equal(toRepoRelativePath('lib/a.js', 'D:/repo'), 'lib/a.js');
  assert.equal(toRepoRelativePath('D:/other/repo/lib/a.js', 'D:/repo'), 'd:/other/repo/lib/a.js');
});

test('projectMatches - matches only compatible project paths', () => {
  assert.equal(projectMatches('D:/work/app', 'app'), true);
  assert.equal(projectMatches('D:/work/app', 'D:/other/app'), false);
});
