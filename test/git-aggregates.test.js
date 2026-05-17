// test/git-aggregates.test.js — finalizeGitStats 端到端
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { parseGitLogOutput, finalizeGitStats } from '../lib/git.js';

test('finalizeGitStats - 完整流程', () => {
  const output = [
    '§§§h1|2026-05-14T10:30:00|me@x|feat(api): add endpoint',
    '40\t10\tlib/api.js',
    '20\t0\ttest/api.test.js',
    '§§§h2|2026-05-14T11:00:00|me@x|fix: handle null',
    '5\t1\tlib/api.js',
    '§§§h3|2026-05-15T09:00:00|me@x|docs: update readme',
    '30\t5\tREADME.md',
  ].join('\n');

  const stats = parseGitLogOutput(output, 'D:/myrepo');

  const sessions = [
    {
      id: 'sess-a',
      project: 'D:/myrepo',
      startTime: '2026-05-14T10:00:00',
      endTime: '2026-05-14T11:30:00',
      toolSequence: [],
      commits: [],
    },
    {
      id: 'sess-b',
      project: 'D:/myrepo',
      startTime: '2026-05-15T08:30:00',
      endTime: '2026-05-15T09:30:00',
      toolSequence: [],
      commits: [],
    },
  ];

  finalizeGitStats(stats, sessions);

  // sessions 被回填 commits
  assert.equal(sessions[0].commits.length, 2);
  assert.equal(sessions[1].commits.length, 1);
  assert.equal(sessions[0].commits[0].hash, 'h1');
  assert.equal(sessions[1].commits[0].subject, 'docs: update readme');

  // aiContribution：所有 commits 都关联到 session → 全部视为 AI
  assert.equal(stats.aiContribution.aiCommits, 3);
  assert.equal(stats.aiContribution.humanCommits, 0);

  // 每个 commit 都打上 sessionAttributed 信号
  for (const c of stats.commitList) {
    assert.ok(c.isAI, `commit ${c.hash} 应被识别为 AI`);
    assert.ok(c.aiSignals.includes('sessionAttributed'));
  }

  // commitTypes
  assert.equal(stats.commitTypes.feat, 1);
  assert.equal(stats.commitTypes.fix, 1);
  assert.equal(stats.commitTypes.docs, 1);

  // fileHotspots
  assert.equal(stats.fileHotspots.length, 3);
  assert.equal(stats.fileHotspots[0].path, 'lib/api.js');
  assert.equal(stats.fileHotspots[0].touches, 2);

  // sessionCommitMap
  assert.deepEqual(stats.sessionCommitMap['sess-a'].sort(), ['h1', 'h2']);
  assert.deepEqual(stats.sessionCommitMap['sess-b'], ['h3']);
});

test('finalizeGitStats - 无 session 时 commits 仍能聚合', () => {
  const output = [
    '§§§h1|2026-05-14T10:00:00|me@x|feat: x',
    '10\t0\ta.js',
  ].join('\n');
  const stats = parseGitLogOutput(output, 'D:/myrepo');
  finalizeGitStats(stats, []);

  assert.equal(stats.commitTypes.feat, 1);
  assert.equal(stats.fileHotspots[0].path, 'a.js');
  assert.deepEqual(stats.sessionCommitMap, {});
  assert.equal(stats.commitList[0].sessionId, null);
});

test('finalizeGitStats - null gitStats 安全', () => {
  assert.equal(finalizeGitStats(null, []), null);
  assert.equal(finalizeGitStats(undefined, []), undefined);
});

test('finalizeGitStats - AI commit 被正确识别和聚合', () => {
  const output = [
    '§§§a1|2026-05-14T10:00:00|me@x|feat: human work',
    '10\t0\ta.js',
    '§§§a2|2026-05-14T11:00:00|me@x|feat: ai work',
    '50\t5\tb.js',
  ].join('\n');
  const stats = parseGitLogOutput(output, 'D:/myrepo');
  // 手工标记第二条为 AI 模拟
  stats.commitList[1].isAI = true;
  stats.commitList[1].aiSignals = ['coAuthor'];
  finalizeGitStats(stats, []);

  assert.equal(stats.aiContribution.aiCommits, 1);
  assert.equal(stats.aiContribution.humanCommits, 1);
  assert.equal(stats.aiContribution.aiRatio, 0.5);
  assert.equal(stats.aiContribution.aiLinesAdded, 50);
  assert.equal(stats.aiContribution.aiLinesDeleted, 5);
});

test('finalizeGitStats - 时间窗推断：无 message 标记但关联到 session 也算 AI', () => {
  const output = [
    '§§§w1|2026-05-14T10:30:00|human@x|feat: regular commit',
    '20\t0\tlib/a.js',
    '§§§w2|2026-05-14T20:00:00|human@x|fix: out of window',
    '5\t0\tlib/b.js',
  ].join('\n');
  const stats = parseGitLogOutput(output, 'D:/myrepo');
  const sessions = [{
    id: 's-active',
    project: 'D:/myrepo',
    startTime: '2026-05-14T10:00:00',
    endTime: '2026-05-14T11:00:00',
    toolSequence: [],
    commits: [],
  }];

  finalizeGitStats(stats, sessions);

  // 第一条在 session 时间窗内 → isAI
  assert.equal(stats.commitList[0].isAI, true);
  assert.ok(stats.commitList[0].aiSignals.includes('sessionAttributed'));
  // 第二条 20:00 远在 session 窗口外 → 不算 AI
  assert.equal(stats.commitList[1].isAI, false);
  assert.equal(stats.commitList[1].sessionId, null);
  // 汇总
  assert.equal(stats.aiContribution.aiCommits, 1);
  assert.equal(stats.aiContribution.humanCommits, 1);
});
