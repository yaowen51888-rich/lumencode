// test/git-conventional.test.js — Conventional Commit 解析
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { parseConventional } from '../lib/git.js';

test('parseConventional - 基本类型', () => {
  assert.deepEqual(parseConventional('feat: add login'), { type: 'feat', scope: null, isBreaking: false });
  assert.deepEqual(parseConventional('fix: handle null'), { type: 'fix', scope: null, isBreaking: false });
  assert.deepEqual(parseConventional('refactor: extract helper'), { type: 'refactor', scope: null, isBreaking: false });
  assert.deepEqual(parseConventional('docs: update readme'), { type: 'docs', scope: null, isBreaking: false });
  assert.deepEqual(parseConventional('test: cover edge'), { type: 'test', scope: null, isBreaking: false });
  assert.deepEqual(parseConventional('chore: bump dep'), { type: 'chore', scope: null, isBreaking: false });
  assert.deepEqual(parseConventional('perf: avoid recompute'), { type: 'perf', scope: null, isBreaking: false });
  assert.deepEqual(parseConventional('style: format'), { type: 'style', scope: null, isBreaking: false });
  assert.deepEqual(parseConventional('ci: tweak workflow'), { type: 'ci', scope: null, isBreaking: false });
  assert.deepEqual(parseConventional('build: upgrade node'), { type: 'build', scope: null, isBreaking: false });
  assert.deepEqual(parseConventional('revert: undo X'), { type: 'revert', scope: null, isBreaking: false });
});

test('parseConventional - 带 scope', () => {
  assert.deepEqual(parseConventional('feat(api): add endpoint'), { type: 'feat', scope: 'api', isBreaking: false });
  assert.deepEqual(parseConventional('fix(ui-button): hover state'), { type: 'fix', scope: 'ui-button', isBreaking: false });
});

test('parseConventional - 带 ! 表示 breaking', () => {
  assert.deepEqual(parseConventional('feat!: drop legacy'), { type: 'feat', scope: null, isBreaking: true });
  assert.deepEqual(parseConventional('feat(api)!: drop v1'), { type: 'feat', scope: 'api', isBreaking: true });
});

test('parseConventional - BREAKING CHANGE 关键字', () => {
  const r = parseConventional('feat: rename method (BREAKING CHANGE: old name removed)');
  assert.equal(r.type, 'feat');
  assert.equal(r.isBreaking, true);
});

test('parseConventional - 大小写不敏感', () => {
  assert.equal(parseConventional('FEAT: add x').type, 'feat');
  assert.equal(parseConventional('Fix: handle y').type, 'fix');
});

test('parseConventional - 不匹配 → other', () => {
  assert.deepEqual(parseConventional('随便写一句'), { type: 'other', scope: null, isBreaking: false });
  assert.deepEqual(parseConventional('Initial commit'), { type: 'other', scope: null, isBreaking: false });
  assert.deepEqual(parseConventional(''), { type: 'other', scope: null, isBreaking: false });
});

test('parseConventional - other 也能识别 BREAKING', () => {
  const r = parseConventional('Major rewrite. BREAKING CHANGE: API redesigned.');
  assert.equal(r.type, 'other');
  assert.equal(r.isBreaking, true);
});

test('parseConventional - 不在白名单的类型 → other', () => {
  assert.deepEqual(parseConventional('hotfix: urgent patch'), { type: 'other', scope: null, isBreaking: false });
  assert.deepEqual(parseConventional('wip: in progress'), { type: 'other', scope: null, isBreaking: false });
});
