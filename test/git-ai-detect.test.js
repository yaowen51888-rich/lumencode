// test/git-ai-detect.test.js — AI commit 检测
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { detectAICommit, computeAIContribution, computeCommitTypes, computeFileHotspots } from '../lib/git.js';

test('detectAICommit - Co-Authored-By: Claude', () => {
  const r = detectAICommit('feat: add x', 'me@x', 'Body line\nCo-Authored-By: Claude <noreply@anthropic.com>');
  assert.equal(r.isAI, true);
  assert.ok(r.signals.includes('coAuthor'));
});

test('detectAICommit - 🤖 Generated emoji', () => {
  const r = detectAICommit('chore: setup', 'me@x', '🤖 Generated with Claude Code');
  assert.equal(r.isAI, true);
  assert.ok(r.signals.includes('robotEmoji') || r.signals.includes('generatedWith'));
});

test('detectAICommit - Generated with Claude', () => {
  const r = detectAICommit('feat: x', 'me@x', 'Generated with [Claude Code](https://...)');
  assert.equal(r.isAI, true);
  assert.ok(r.signals.includes('generatedWith'));
});

test('detectAICommit - Assisted-By: Claude', () => {
  const r = detectAICommit('refactor: split', 'me@x', 'Assisted-By: Claude Sonnet');
  assert.equal(r.isAI, true);
  assert.ok(r.signals.includes('assistedBy'));
});

test('detectAICommit - 作者邮箱含 claude', () => {
  const r = detectAICommit('chore: bump', 'claude-bot@example.com');
  assert.equal(r.isAI, true);
  assert.ok(r.signals.includes('authorClaude'));
});

test('detectAICommit - noreply@anthropic', () => {
  const r = detectAICommit('docs: update', 'noreply@anthropic.com');
  assert.equal(r.isAI, true);
  assert.ok(r.signals.includes('authorClaude'));
});

test('detectAICommit - 普通人类 commit', () => {
  const r = detectAICommit('feat: my work', 'human@x.com', 'just normal commit body');
  assert.equal(r.isAI, false);
  assert.deepEqual(r.signals, []);
});

test('detectAICommit - 多个信号同时命中', () => {
  const r = detectAICommit(
    '🤖 Generated feat: x',
    'claude-bot@x.com',
    'Co-Authored-By: Claude\nGenerated with Claude Code'
  );
  assert.equal(r.isAI, true);
  assert.ok(r.signals.length >= 2);
});

test('computeAIContribution - 基本聚合', () => {
  const commits = [
    { isAI: true, linesAdded: 50, linesDeleted: 10 },
    { isAI: true, linesAdded: 30, linesDeleted: 5 },
    { isAI: false, linesAdded: 20, linesDeleted: 2 },
    { isAI: false, linesAdded: 10, linesDeleted: 0 },
  ];
  const r = computeAIContribution(commits);
  assert.equal(r.aiCommits, 2);
  assert.equal(r.humanCommits, 2);
  assert.equal(r.aiRatio, 0.5);
  assert.equal(r.aiLinesAdded, 80);
  assert.equal(r.aiLinesDeleted, 15);
});

test('computeAIContribution - 空数组', () => {
  const r = computeAIContribution([]);
  assert.equal(r.aiCommits, 0);
  assert.equal(r.humanCommits, 0);
  assert.equal(r.aiRatio, 0);
  assert.equal(r.aiLinesAdded, 0);
  assert.equal(r.aiLinesDeleted, 0);
});

test('detectAICommit - body 中的 Co-Authored-By 被检测', () => {
  const r = detectAICommit('feat: add x', 'human@x.com', 'Normal body\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  assert.equal(r.isAI, true);
  assert.ok(r.signals.includes('coAuthor'));
});

test('detectAICommit - body 为空 subject 无标记 → 非 AI', () => {
  const r = detectAICommit('feat: my work', 'human@x.com', '');
  assert.equal(r.isAI, false);
  assert.deepEqual(r.signals, []);
});

test('detectAICommit - Copilot Co-Authored-By', () => {
  const r = detectAICommit('feat: ai code', 'dev@x.com', 'Co-Authored-By: Copilot (<noreply@github.com>)');
  assert.equal(r.isAI, true);
  assert.ok(r.signals.includes('coAuthorCopilot'));
});

test('detectAICommit - Cursor Co-Authored-By', () => {
  const r = detectAICommit('fix: bug', 'dev@x.com', 'Co-Authored-By: Cursor');
  assert.equal(r.isAI, true);
  assert.ok(r.signals.includes('coAuthorCursor'));
});

test('computeCommitTypes - 类型计数', () => {
  const commits = [
    { type: 'feat' }, { type: 'feat' }, { type: 'fix' },
    { type: 'docs' }, { type: 'other' }, {},  // 缺字段视为 other
  ];
  const types = computeCommitTypes(commits);
  assert.equal(types.feat, 2);
  assert.equal(types.fix, 1);
  assert.equal(types.docs, 1);
  assert.equal(types.other, 2);
  assert.equal(types.refactor, 0);
});

test('computeFileHotspots - 按 touches 排序', () => {
  const commits = [
    { files: [{ path: 'a.js', added: 10, deleted: 0 }, { path: 'b.js', added: 5, deleted: 1 }] },
    { files: [{ path: 'a.js', added: 20, deleted: 2 }] },
    { files: [{ path: 'a.js', added: 5, deleted: 0 }, { path: 'c.js', added: 3, deleted: 0 }] },
  ];
  const r = computeFileHotspots(commits, 10);
  assert.equal(r.length, 3);
  assert.equal(r[0].path, 'a.js');
  assert.equal(r[0].touches, 3);
  assert.equal(r[0].added, 35);
  assert.equal(r[0].deleted, 2);
  assert.equal(r[1].path, 'b.js');
  assert.equal(r[2].path, 'c.js');
});

test('computeFileHotspots - topN 截断', () => {
  const commits = [{
    files: Array.from({ length: 20 }, (_, i) => ({ path: `f${i}.js`, added: 1, deleted: 0 })),
  }];
  const r = computeFileHotspots(commits, 5);
  assert.equal(r.length, 5);
});

test('computeFileHotspots - 空输入', () => {
  assert.deepEqual(computeFileHotspots([], 10), []);
  assert.deepEqual(computeFileHotspots(null, 10), []);
});
