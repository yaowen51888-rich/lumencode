import test from 'node:test';
import { strict as assert } from 'node:assert';
import { COMMIT_SENTINEL, parseGitLogOutput, finalizeGitStats } from '../lib/git.js';

test('finalizeGitStats - complete flow with weak session attribution', () => {
  const output = [
    `${COMMIT_SENTINEL}h1|2026-05-14T10:30:00|me@x|feat(api): add endpoint`,
    '40\t10\tlib/api.js',
    '20\t0\ttest/api.test.js',
    `${COMMIT_SENTINEL}h2|2026-05-14T11:00:00|me@x|fix: handle null`,
    '5\t1\tlib/api.js',
    `${COMMIT_SENTINEL}h3|2026-05-15T09:00:00|me@x|docs: update readme`,
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

  assert.equal(sessions[0].commits.length, 2);
  assert.equal(sessions[1].commits.length, 1);
  assert.equal(sessions[0].commits[0].hash, 'h1');
  assert.equal(sessions[1].commits[0].subject, 'docs: update readme');

  assert.equal(stats.aiContribution.aiCommits, 0);
  assert.equal(stats.aiContribution.humanCommits, 3);
  assert.equal(stats.aiContribution.lowConfidenceCommits, 3);

  for (const c of stats.commitList) {
    assert.equal(c.isAI, false, `commit ${c.hash} should not be counted as AI`);
    assert.equal(c.aiConfidence, 'low');
    assert.ok(c.aiSignals.includes('sessionAttributed'));
  }

  assert.equal(stats.commitTypes.feat, 1);
  assert.equal(stats.commitTypes.fix, 1);
  assert.equal(stats.commitTypes.docs, 1);
  assert.equal(stats.fileHotspots.length, 3);
  assert.equal(stats.fileHotspots[0].path, 'lib/api.js');
  assert.equal(stats.fileHotspots[0].touches, 2);
  assert.deepEqual(stats.sessionCommitMap['sess-a'].sort(), ['h1', 'h2']);
  assert.deepEqual(stats.sessionCommitMap['sess-b'], ['h3']);
});

test('finalizeGitStats - no sessions still aggregates', () => {
  const output = [
    `${COMMIT_SENTINEL}h1|2026-05-14T10:00:00|me@x|feat: x`,
    '10\t0\ta.js',
  ].join('\n');
  const stats = parseGitLogOutput(output, 'D:/myrepo');
  finalizeGitStats(stats, []);

  assert.equal(stats.commitTypes.feat, 1);
  assert.equal(stats.fileHotspots[0].path, 'a.js');
  assert.deepEqual(stats.sessionCommitMap, {});
  assert.equal(stats.commitList[0].sessionId, null);
});

test('finalizeGitStats - null safety', () => {
  assert.equal(finalizeGitStats(null, []), null);
  assert.equal(finalizeGitStats(undefined, []), undefined);
});

test('finalizeGitStats - explicit AI commit contributes to metrics', () => {
  const output = [
    `${COMMIT_SENTINEL}a1|2026-05-14T10:00:00|me@x|feat: human work`,
    '10\t0\ta.js',
    `${COMMIT_SENTINEL}a2|2026-05-14T11:00:00|me@x|feat: ai work`,
    '50\t5\tb.js',
  ].join('\n');
  const stats = parseGitLogOutput(output, 'D:/myrepo');
  stats.commitList[1].isAI = true;
  stats.commitList[1].aiAssisted = true;
  stats.commitList[1].aiConfidence = 'high';
  stats.commitList[1].aiSignals = ['coAuthor'];
  stats.commitList[1].attributionType = 'explicit';
  finalizeGitStats(stats, []);

  assert.equal(stats.aiContribution.aiCommits, 1);
  assert.equal(stats.aiContribution.humanCommits, 1);
  assert.equal(stats.aiContribution.aiCommitRatio, 0.5);
  assert.equal(stats.aiContribution.aiRatio, 55 / 65);
  assert.equal(stats.aiContribution.aiLineRatio, 55 / 65);
  assert.equal(stats.aiContribution.aiLinesAdded, 50);
  assert.equal(stats.aiContribution.aiLinesDeleted, 5);
});

test('finalizeGitStats - weak session attribution is not counted as AI', () => {
  const output = [
    `${COMMIT_SENTINEL}w1|2026-05-14T10:30:00|human@x|feat: regular commit`,
    '20\t0\tlib/a.js',
    `${COMMIT_SENTINEL}w2|2026-05-14T20:00:00|human@x|fix: out of window`,
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

  assert.equal(stats.commitList[0].isAI, false);
  assert.equal(stats.commitList[0].aiConfidence, 'low');
  assert.ok(stats.commitList[0].aiSignals.includes('sessionAttributed'));
  assert.equal(stats.commitList[1].isAI, false);
  assert.equal(stats.commitList[1].sessionId, null);
  assert.equal(stats.aiContribution.aiCommits, 0);
  assert.equal(stats.aiContribution.humanCommits, 2);
  assert.equal(stats.aiContribution.lowConfidenceCommits, 1);
});

test('finalizeGitStats - strong session attribution counts as medium confidence AI', () => {
  const output = [
    `${COMMIT_SENTINEL}s1|2026-05-14T10:00:05|human@x|feat: commit via bash`,
    '12\t1\tlib/a.js',
  ].join('\n');
  const stats = parseGitLogOutput(output, 'D:/myrepo');
  const sessions = [{
    id: 's-strong',
    project: 'D:/myrepo',
    startTime: '2026-05-14T09:30:00',
    endTime: '2026-05-14T10:10:00',
    toolSequence: [
      { name: 'Bash', input: { command: 'git commit -m "feat: commit via bash"' }, timestamp: '2026-05-14T10:00:00' },
    ],
    commits: [],
  }];

  finalizeGitStats(stats, sessions);

  assert.equal(stats.commitList[0].isAI, true);
  assert.equal(stats.commitList[0].aiConfidence, 'medium');
  assert.equal(stats.commitList[0].attributionType, 'session_strong');
  assert.ok(stats.commitList[0].aiSignals.includes('sessionCommitBash'));
  assert.equal(stats.aiContribution.aiCommits, 1);
  assert.equal(stats.aiContribution.mediumConfidenceCommits, 1);
});

test('finalizeGitStats - file overlap lifts weak session into counted AI', () => {
  const output = [
    `${COMMIT_SENTINEL}o1|2026-05-14T10:30:00|human@x|feat: overlap change`,
    '12\t1\tsrc/app.js',
  ].join('\n');
  const stats = parseGitLogOutput(output, 'D:/myrepo');
  const sessions = [{
    id: 's-overlap',
    project: 'D:/myrepo',
    startTime: '2026-05-14T10:00:00',
    endTime: '2026-05-14T11:00:00',
    toolSequence: [
      { name: 'Edit', input: { file_path: 'D:/myrepo/src/app.js' }, timestamp: '2026-05-14T10:05:00' },
    ],
    commits: [],
  }];

  finalizeGitStats(stats, sessions);

  assert.equal(stats.commitList[0].aiConfidence, 'medium');
  assert.equal(stats.commitList[0].attributionType, 'session_file_overlap');
  assert.equal(stats.commitList[0].aiEvidenceDetails.matchedFileCount, 1);
  assert.equal(stats.aiContribution.aiCommits, 1);
  assert.equal(stats.aiContribution.mediumConfidenceCommits, 1);
  assert.equal(stats.aiContribution.aiFileLinesAdded, 12);
  assert.equal(stats.aiContribution.aiFileLinesDeleted, 1);
});

test('finalizeGitStats - attributedTool from explicit AI signature', () => {
  const output = [
    `${COMMIT_SENTINEL}c1|2026-05-14T10:00:00|me@x|feat: ai work`,
    '@@ENDBODY@@',
    'Co-Authored-By: Claude <noreply@anthropic.com>',
    '10\t0\ta.js',
  ].join('\n');
  const stats = parseGitLogOutput(output, 'D:/myrepo');
  finalizeGitStats(stats, []);

  assert.equal(stats.commitList[0].attributedTool, 'claude');
  assert.ok(stats.aiContributionByTool);
  assert.equal(stats.aiContributionByTool.claude.aiCommits, 1);
  assert.equal(stats.aiContributionByTool['generic-ai'].aiCommits, 0);
});

test('finalizeGitStats - attributedTool from session primaryTool', () => {
  const output = [
    `${COMMIT_SENTINEL}s1|2026-05-14T10:30:00|human@x|feat: session work`,
    '15\t2\tsrc/app.js',
  ].join('\n');
  const stats = parseGitLogOutput(output, 'D:/myrepo');
  const sessions = [{
    id: 's-codex',
    project: 'D:/myrepo',
    startTime: '2026-05-14T10:00:00',
    endTime: '2026-05-14T11:00:00',
    primaryTool: 'codex',
    toolSequence: [
      { name: 'Bash', input: { command: 'git commit -m "feat: session work"' }, timestamp: '2026-05-14T10:30:00' },
    ],
    commits: [],
  }];
  finalizeGitStats(stats, sessions);

  assert.equal(stats.commitList[0].attributedTool, 'codex');
  assert.ok(stats.aiContributionByTool);
  assert.equal(stats.aiContributionByTool.codex.aiCommits, 1);
});

test('finalizeGitStats - attributedTool generic-ai for unspecific AI signals', () => {
  const output = [
    `${COMMIT_SENTINEL}g1|2026-05-14T10:00:00|me@x|feat: ai work`,
    '@@ENDBODY@@',
    '[AI] auto generated code',
    '10\t0\ta.js',
  ].join('\n');
  const stats = parseGitLogOutput(output, 'D:/myrepo');
  finalizeGitStats(stats, []);

  assert.equal(stats.commitList[0].attributedTool, 'generic-ai');
  assert.equal(stats.aiContributionByTool['generic-ai'].aiCommits, 1);
});

test('finalizeGitStats - attributedTool null for human commit', () => {
  const output = [
    `${COMMIT_SENTINEL}h1|2026-05-14T10:00:00|human@x|feat: my work`,
    '10\t0\ta.js',
  ].join('\n');
  const stats = parseGitLogOutput(output, 'D:/myrepo');
  finalizeGitStats(stats, []);

  assert.equal(stats.commitList[0].attributedTool, null);
});

test('finalizeGitStats - aiContributionByTool contains all tool keys', () => {
  const output = [
    `${COMMIT_SENTINEL}c1|2026-05-14T10:00:00|me@x|feat: claude work`,
    '@@ENDBODY@@',
    'Co-Authored-By: Claude',
    '10\t0\ta.js',
    `${COMMIT_SENTINEL}x1|2026-05-14T11:00:00|me@x|feat: human work`,
    '5\t0\tb.js',
  ].join('\n');
  const stats = parseGitLogOutput(output, 'D:/myrepo');
  finalizeGitStats(stats, []);

  assert.ok(stats.aiContributionByTool);
  assert.equal(typeof stats.aiContributionByTool.claude, 'object');
  assert.equal(typeof stats.aiContributionByTool.codex, 'object');
  assert.equal(typeof stats.aiContributionByTool.opencode, 'object');
  assert.equal(typeof stats.aiContributionByTool['generic-ai'], 'object');
  // Global still works
  assert.equal(stats.aiContribution.aiCommits, 1);
});

test('finalizeGitStats - file-level AI lines only count matched files in mixed commit', () => {
  const output = [
    `${COMMIT_SENTINEL}m1|2026-05-14T10:30:00|human@x|feat: mixed overlap`,
    '40\t5\tsrc/app.js',
    '20\t3\tsrc/other.js',
  ].join('\n');
  const stats = parseGitLogOutput(output, 'D:/myrepo');
  const sessions = [{
    id: 's-mixed',
    project: 'D:/myrepo',
    startTime: '2026-05-14T10:00:00',
    endTime: '2026-05-14T11:00:00',
    toolSequence: [
      { name: 'Edit', input: { file_path: 'D:/myrepo/src/app.js' }, timestamp: '2026-05-14T10:05:00' },
    ],
    commits: [],
  }];

  finalizeGitStats(stats, sessions);

  assert.equal(stats.commitList[0].aiConfidence, 'medium');
  assert.equal(stats.commitList[0].aiEvidenceDetails.matchedFileCount, 1);
  assert.equal(stats.aiContribution.aiCommitLinesAdded, 60);
  assert.equal(stats.aiContribution.aiCommitLinesDeleted, 8);
  assert.equal(stats.aiContribution.aiFileLinesAdded, 40);
  assert.equal(stats.aiContribution.aiFileLinesDeleted, 5);
  assert.equal(stats.aiContribution.aiLinesAdded, 40);
  assert.equal(stats.aiContribution.aiLinesDeleted, 5);
});

test('finalizeGitStats - exposes layered attribution summary fields', () => {
  const output = [
    `${COMMIT_SENTINEL}l1|2026-05-14T10:00:00|me@x|feat: layered summary`,
    '18\t4\tlib/git.js',
  ].join('\n');
  const stats = parseGitLogOutput(output, 'D:/myrepo');
  finalizeGitStats(stats, []);

  assert.ok(stats.attributionSummary);
  assert.equal(stats.attributionSummary.confirmedAI, 0);
  assert.equal(stats.attributionSummary.probableAI, 0);
  assert.equal(stats.attributionSummary.possibleAI, 0);
  assert.equal(stats.attributionSummary.unknown, 0);
  assert.equal(stats.attributionSummary.human, 1);
});
