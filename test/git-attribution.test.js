import test from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { attributeCommitsToSessions, attachCommitsToSessions, finalizeGitStats, parseAddedLines } from '../lib/git.js';
import { resolveAttributionOptions } from '../lib/git-attribution-options.js';
import { StepTracker } from '../lib/step-tracker.js';

// finalizeGitStats is now async
const finalize = (merged, sessions, opts) => finalizeGitStats(merged, sessions, opts);

function mkCommit(over = {}) {
  return {
    repo: 'D:/myrepo',
    hash: 'h1',
    date: '2026-05-14T10:00:00',
    author: 'me@x',
    subject: 'feat: x',
    linesAdded: 10,
    linesDeleted: 0,
    files: [],
    type: 'feat',
    isAI: false,
    aiAssisted: false,
    aiConfidence: 'none',
    aiSignals: [],
    attributionType: null,
    ...over,
  };
}

function mkSession(over = {}) {
  return {
    id: 's1',
    project: 'D:/myrepo',
    startTime: '2026-05-14T09:00:00',
    endTime: '2026-05-14T11:00:00',
    toolSequence: [],
    ...over,
  };
}

test('resolveAttributionOptions - sanitizes invalid values', () => {
  const options = resolveAttributionOptions({
    windows: { weakWindowMinutes: -5, crossDayWindowDays: 'bad' },
    confidenceThresholds: { high: 2, medium: 0.5, low: -1 },
    confidenceWeights: { high: 1, medium: 0.6, low: 0.3, none: 0 },
    scoreWeights: { explicitSignature: 'bad', negativeMergeCommit: -0.25 },
  });

  assert.equal(options.windows.weakWindowMinutes, 30);
  assert.equal(options.windows.crossDayWindowDays, 3);
  assert.equal(options.confidenceThresholds.high, 0.75);
  assert.equal(options.confidenceThresholds.medium, 0.5);
  assert.equal(options.confidenceThresholds.low, 0.20);
  assert.equal(options.confidenceWeights.medium, 0.6);
  assert.equal(options.scoreWeights.explicitSignature, 0.85);
  assert.equal(options.scoreWeights.negativeMergeCommit, -0.25);
});

test('attributeCommitsToSessions - Bash git commit strong match', () => {
  const commits = [mkCommit({ date: '2026-05-14T10:00:05' })];
  const sessions = [mkSession({
    toolSequence: [
      { name: 'Bash', input: { command: 'git commit -m "feat: x"' }, timestamp: '2026-05-14T10:00:00' },
    ],
  })];
  const r = attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, 's1');
  assert.equal(commits[0].sessionAttribution, 'strong');
  assert.deepEqual(r.sessionCommitMap, { s1: ['h1'] });
});

test('attributeCommitsToSessions - weak window fallback', () => {
  const commits = [mkCommit({ date: '2026-05-14T10:30:00' })];
  const sessions = [mkSession()];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, 's1');
  assert.equal(commits[0].sessionAttribution, 'weak');
});

test('finalizeGitStats - uses matching step tracker per repo', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'git-step-repos-'));
  try {
    const repoA = join(tempRoot, 'repo-a');
    const repoB = join(tempRoot, 'repo-b');
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });

    writeFileSync(join(repoA, 'a.js'), 'const a = 1;\n');
    writeFileSync(join(repoB, 'b.js'), 'const b = 1;\n');

    const trackerA = new StepTracker(repoA);
    await trackerA.open();
    await trackerA.recordStep({
      sessionId: 'sess-a',
      toolName: 'Write',
      toolInput: { file_path: join(repoA, 'a.js') },
      toolUseId: 'tu-a',
    });
    trackerA.close();

    const trackerB = new StepTracker(repoB);
    await trackerB.open();
    await trackerB.recordStep({
      sessionId: 'sess-b',
      toolName: 'Write',
      toolInput: { file_path: join(repoB, 'b.js') },
      toolUseId: 'tu-b',
    });
    trackerB.close();

    const stats = {
      commitList: [
        mkCommit({
          repo: repoB,
          hash: 'hb',
          sessionId: 'sess-b',
          sessionAttribution: 'strong',
          files: [{ path: 'b.js', added: 1, deleted: 0 }],
          linesAdded: 1,
        }),
      ],
    };
    const sessions = [
      mkSession({ id: 'sess-a', project: repoA }),
      mkSession({ id: 'sess-b', project: repoB }),
    ];

    await finalizeGitStats(stats, sessions);

    assert.equal(stats.commitList[0].lineBlame?.source, 'step_blame');
    assert.equal(stats.commitList[0].lineBlame?.aiLines, 1);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('finalizeGitStats - resolves origin-prefixed step sessions from raw log session ids', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'git-step-origin-session-'));
  try {
    writeFileSync(join(tempRoot, 'codex.js'), 'const codex = true;\n');

    const tracker = new StepTracker(tempRoot);
    await tracker.open();
    await tracker.recordStep({
      origin: 'codex_cli',
      sessionId: 'codex_cli:sess-codex',
      toolName: 'Write',
      toolInput: { file_path: join(tempRoot, 'codex.js') },
      toolUseId: 'tu-codex',
    });
    tracker.close();

    const stats = {
      commitList: [
        mkCommit({
          repo: tempRoot,
          hash: 'hc',
          sessionId: 'sess-codex',
          sessionAttribution: 'strong',
          files: [{ path: 'codex.js', added: 1, deleted: 0 }],
          linesAdded: 1,
        }),
      ],
    };
    const sessions = [
      mkSession({ id: 'sess-codex', project: tempRoot, primaryTool: 'codex' }),
    ];

    await finalizeGitStats(stats, sessions);

    assert.equal(stats.commitList[0].sessionId, 'sess-codex');
    assert.equal(stats.commitList[0].lineBlame?.source, 'step_blame');
    assert.equal(stats.commitList[0].lineBlame?.aiLines, 1);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('finalizeGitStats - rolls up line attribution quality from step blame', async () => {
  const merged = {
    commits: 1, filesChanged: 1, linesAdded: 6, linesDeleted: 0,
    commitsByDate: {}, linesByDate: {}, fileHotspots: [],
    commitList: [
      mkCommit({
        hash: 'hQuality',
        lineBlame: {
          source: 'step_blame',
          aiLines: 5,
          humanLines: 0,
          unknownLines: 1,
          aiDeletedLines: 0,
          humanDeletedLines: 0,
          unknownDeletedLines: 0,
          totalLines: 6,
          mappedAddedLines: 5,
          mappableAddedLines: 6,
          lineCoverage: 5 / 6,
          fileBreakdown: {},
        },
      }),
    ],
  };

  await finalizeGitStats(merged, [], { stepTracking: { enabled: false } });

  assert.equal(merged.attributionQuality.totalLineBlameCommits, 1);
  assert.equal(merged.attributionQuality.mappedAddedLines, 5);
  assert.equal(merged.attributionQuality.mappableAddedLines, 6);
  assert.equal(merged.attributionQuality.unknownLines, 1);
  assert.equal(merged.attributionQuality.lineCoverage, 5 / 6);
  assert.equal(merged.attributionQuality.confidence, 'medium');
});

test('finalizeGitStats - honors disabled step tracking option', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'git-step-disabled-'));
  try {
    writeFileSync(join(tempRoot, 'file.js'), 'const value = 1;\n');

    const tracker = new StepTracker(tempRoot);
    await tracker.open();
    await tracker.recordStep({
      sessionId: 'sess-disabled',
      toolName: 'Write',
      toolInput: { file_path: join(tempRoot, 'file.js') },
      toolUseId: 'tu-disabled',
    });
    tracker.close();

    const stats = {
      commitList: [
        mkCommit({
          repo: tempRoot,
          hash: 'hd',
          sessionId: 'sess-disabled',
          sessionAttribution: 'strong',
          files: [{ path: 'file.js', added: 1, deleted: 0 }],
          linesAdded: 1,
        }),
      ],
    };
    const sessions = [mkSession({ id: 'sess-disabled', project: tempRoot })];

    await finalizeGitStats(stats, sessions, { stepTracking: { enabled: false } });

    assert.equal(stats.commitList[0].lineBlame, undefined);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('attributeCommitsToSessions - outside time window returns cross-day-weak', () => {
  const commits = [mkCommit({ date: '2026-05-14T20:00:00' })];
  const sessions = [mkSession()];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, 's1');
  assert.equal(commits[0].sessionAttribution, 'cross-day-weak');
});

test('attributeCommitsToSessions - nearest midpoint when multiple sessions', () => {
  const commits = [mkCommit({ hash: 'hX', date: '2026-05-14T10:30:00' })];
  const sessions = [
    mkSession({ id: 's-far', startTime: '2026-05-14T08:00:00', endTime: '2026-05-14T09:00:00' }),
    mkSession({ id: 's-near', startTime: '2026-05-14T10:00:00', endTime: '2026-05-14T11:00:00' }),
  ];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, 's-near');
});

test('attributeCommitsToSessions - file overlap wins among competing weak candidates', () => {
  const commits = [mkCommit({
    hash: 'hFileWin',
    date: '2026-05-14T10:20:00',
    files: [{ path: 'lib/git.js', added: 12, deleted: 2 }],
  })];
  const sessions = [
    mkSession({
      id: 's-near',
      startTime: '2026-05-14T10:00:00',
      endTime: '2026-05-14T10:15:00',
      toolSequence: [
        { name: 'Edit', input: { file_path: 'D:/myrepo/docs/readme.md' }, timestamp: '2026-05-14T10:05:00' },
      ],
    }),
    mkSession({
      id: 's-file',
      startTime: '2026-05-14T09:45:00',
      endTime: '2026-05-14T10:00:00',
      toolSequence: [
        { name: 'Edit', input: { file_path: 'D:/myrepo/lib/git.js' }, timestamp: '2026-05-14T09:50:00' },
      ],
    }),
  ];

  attributeCommitsToSessions(commits, sessions);

  assert.equal(commits[0].sessionId, 's-file');
  assert.equal(commits[0].attributionCandidates[0].sessionId, 's-file');
  assert.ok(commits[0].attributionCandidates[0].score > commits[0].attributionCandidates[1].score);
});

test('attributeCommitsToSessions - project mismatch prevents attribution', () => {
  const commits = [mkCommit({ repo: 'D:/repoA' })];
  const sessions = [mkSession({ id: 'sB', project: 'D:/repoB' })];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, null);
});

test('attributeCommitsToSessions - path match ignores case and slashes', () => {
  const commits = [mkCommit({ repo: 'D:\\MyRepo' })];
  const sessions = [mkSession({ id: 'sLC', project: 'd:/myrepo' })];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, 'sLC');
});

test('attributeCommitsToSessions - strong signal wins over weak window', () => {
  const commits = [mkCommit({ date: '2026-05-14T10:30:00', hash: 'hPri' })];
  const sessions = [
    mkSession({ id: 's-window', startTime: '2026-05-14T10:00:00', endTime: '2026-05-14T11:00:00' }),
    mkSession({
      id: 's-bash',
      startTime: '2026-05-14T08:00:00',
      endTime: '2026-05-14T09:00:00',
      toolSequence: [
        { name: 'Bash', input: { command: 'cd repo && git commit -am "x"' }, timestamp: '2026-05-14T10:29:00' },
      ],
    }),
  ];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, 's-bash');
  assert.equal(commits[0].sessionAttribution, 'strong');
});

test('attributeCommitsToSessions - non commit Bash does not trigger strong signal', () => {
  const commits = [mkCommit({ date: '2026-05-14T16:00:00' })];
  const sessions = [mkSession({
    startTime: '2026-05-14T14:00:00',
    endTime: '2026-05-14T14:30:00',
    toolSequence: [
      { name: 'Bash', input: { command: 'git status' }, timestamp: '2026-05-14T14:15:00' },
    ],
  })];
  attributeCommitsToSessions(commits, sessions);
  // 非 git commit 的 Bash 不会触发强信号，但 commit 仍在 session 结束后 3 天内，走 cross-day-weak
  assert.equal(commits[0].sessionId, 's1');
  assert.equal(commits[0].sessionAttribution, 'cross-day-weak');
});

test('attributeCommitsToSessions - empty input', () => {
  assert.deepEqual(attributeCommitsToSessions([], []).sessionCommitMap, {});
  assert.deepEqual(attributeCommitsToSessions(null, null).sessionCommitMap, {});
});

test('attachCommitsToSessions - writes compact commit view', () => {
  const sessions = [
    { id: 's1', commits: [] },
    { id: 's2', commits: [] },
  ];
  const commitList = [
    { hash: 'a', sessionId: 's1', subject: 'feat: a', type: 'feat', isAI: false, aiAssisted: false, aiConfidence: 'none', attributionType: null, linesAdded: 10, linesDeleted: 0, date: '2026-05-14T10:00:00' },
    { hash: 'b', sessionId: 's1', subject: 'fix: b', type: 'fix', isAI: true, aiAssisted: true, aiConfidence: 'high', attributionType: 'explicit', linesAdded: 5, linesDeleted: 2, date: '2026-05-14T11:00:00' },
    { hash: 'c', sessionId: 's2', subject: 'docs: c', type: 'docs', isAI: false, aiAssisted: true, aiConfidence: 'low', attributionType: 'session_weak', linesAdded: 20, linesDeleted: 0, date: '2026-05-14T12:00:00' },
    { hash: 'd', sessionId: null, subject: 'other', type: 'other', isAI: false, aiAssisted: false, aiConfidence: 'none', attributionType: null, linesAdded: 1, linesDeleted: 0, date: '2026-05-14T13:00:00' },
  ];
  attachCommitsToSessions(sessions, commitList);
  assert.equal(sessions[0].commits.length, 2);
  assert.equal(sessions[1].commits.length, 1);
  assert.equal(sessions[0].commits[1].aiConfidence, 'high');
  assert.equal(sessions[1].commits[0].aiConfidence, 'low');
});

test('finalizeGitStats - weak session attribution stays low confidence', async () => {
  const merged = {
    commits: 1, filesChanged: 0, linesAdded: 10, linesDeleted: 0,
    commitsByDate: {}, linesByDate: {}, fileHotspots: [],
    commitList: [
      mkCommit({ hash: 'hSess', aiSignals: [] }),
    ],
  };
  const sessions = [mkSession()];
  await finalizeGitStats(merged, sessions);
  assert.equal(merged.commitList[0].isAI, false);
  assert.equal(merged.commitList[0].aiAssisted, true);
  assert.equal(merged.commitList[0].aiConfidence, 'low');
  assert.equal(merged.commitList[0].attributionType, 'session_weak');
  assert.ok(merged.commitList[0].aiSignals.includes('sessionAttributed'));
});

test('finalizeGitStats - weak session with file overlap upgrades to medium', async () => {
  const merged = {
    commits: 1, filesChanged: 0, linesAdded: 10, linesDeleted: 0,
    commitsByDate: {}, linesByDate: {}, fileHotspots: [],
    commitList: [
      mkCommit({
        hash: 'hOverlap',
        files: [{ path: 'src/app.js', added: 10, deleted: 0 }],
      }),
    ],
  };
  const sessions = [mkSession({
    toolSequence: [
      { name: 'Edit', input: { file_path: 'D:/myrepo/src/app.js' }, timestamp: '2026-05-14T10:00:00' },
    ],
  })];
  await finalizeGitStats(merged, sessions);
  assert.equal(merged.commitList[0].isAI, true);
  assert.equal(merged.commitList[0].aiConfidence, 'medium');
  assert.equal(merged.commitList[0].attributionType, 'session_file_overlap');
  assert.ok(merged.commitList[0].aiSignals.includes('fileOverlap'));
  assert.equal(merged.commitList[0].aiEvidenceDetails.matchedFileCount, 1);
});

test('finalizeGitStats - ignores slash-like strings in non-path fields', async () => {
  const merged = {
    commits: 1, filesChanged: 0, linesAdded: 10, linesDeleted: 0,
    commitsByDate: {}, linesByDate: {}, fileHotspots: [],
    commitList: [
      mkCommit({
        hash: 'hFalsePath',
        files: [{ path: 'src/app.js', added: 10, deleted: 0 }],
      }),
    ],
  };
  const sessions = [mkSession({
    toolSequence: [
      {
        name: 'Edit',
        input: {
          old_string: 'fetch("/api/users")',
          new_string: 'fetch("/api/admin/users")',
        },
        timestamp: '2026-05-14T10:00:00',
      },
    ],
  })];
  await finalizeGitStats(merged, sessions);
  assert.equal(merged.commitList[0].aiConfidence, 'low');
  assert.equal(merged.commitList[0].aiEvidenceDetails.matchedFileCount, 0);
});

test('finalizeGitStats - root filename path field can match overlap', async () => {
  const merged = {
    commits: 1, filesChanged: 0, linesAdded: 8, linesDeleted: 1,
    commitsByDate: {}, linesByDate: {}, fileHotspots: [],
    commitList: [
      mkCommit({
        hash: 'hRootFile',
        files: [{ path: 'README.md', added: 8, deleted: 1 }],
      }),
    ],
  };
  const sessions = [mkSession({
    toolSequence: [
      { name: 'Edit', input: { file_path: 'README.md' }, timestamp: '2026-05-14T10:00:00' },
    ],
  })];
  await finalizeGitStats(merged, sessions);
  assert.equal(merged.commitList[0].aiConfidence, 'medium');
  assert.equal(merged.commitList[0].aiEvidenceDetails.matchedFileCount, 1);
});

test('finalizeGitStats - same repo absolute file path overlaps after session match', async () => {
  const merged = {
    commits: 1, filesChanged: 0, linesAdded: 12, linesDeleted: 0,
    commitsByDate: {}, linesByDate: {}, fileHotspots: [],
    commitList: [
      mkCommit({
        hash: 'hTailFallback',
        repo: 'D:/decoded/myrepo',
        files: [{ path: 'src/app.js', added: 12, deleted: 0 }],
      }),
    ],
  };
  const sessions = [mkSession({
    project: 'D:/decoded/myrepo',
    toolSequence: [
      { name: 'Edit', input: { file_path: 'D:/decoded/myrepo/src/app.js' }, timestamp: '2026-05-14T10:00:00' },
    ],
  })];
  await finalizeGitStats(merged, sessions);
  assert.equal(merged.commitList[0].aiConfidence, 'medium');
  assert.equal(merged.commitList[0].aiEvidenceDetails.matchedFileCount, 1);
});

test('finalizeGitStats - strong session with file overlap upgrades to high', async () => {
  const merged = {
    commits: 1, filesChanged: 0, linesAdded: 10, linesDeleted: 0,
    commitsByDate: {}, linesByDate: {}, fileHotspots: [],
    commitList: [
      mkCommit({
        hash: 'hStrongOverlap',
        date: '2026-05-14T10:00:05',
        files: [{ path: 'src/app.js', added: 10, deleted: 0 }],
      }),
    ],
  };
  const sessions = [mkSession({
    toolSequence: [
      { name: 'Bash', input: { command: 'git commit -m "feat: x"' }, timestamp: '2026-05-14T10:00:00' },
      { name: 'Edit', input: { file_path: 'D:/myrepo/src/app.js' }, timestamp: '2026-05-14T09:59:30' },
    ],
  })];
  await finalizeGitStats(merged, sessions);
  assert.equal(merged.commitList[0].isAI, true);
  assert.equal(merged.commitList[0].aiConfidence, 'high');
  assert.equal(merged.commitList[0].attributionType, 'session_strong_file_overlap');
  assert.ok(merged.commitList[0].aiSignals.includes('sessionCommitBash'));
  assert.ok(merged.commitList[0].aiSignals.includes('fileOverlap'));
});

test('finalizeGitStats - explicit AI keeps explicit attribution', async () => {
  const merged = {
    commits: 1, filesChanged: 0, linesAdded: 10, linesDeleted: 0,
    commitsByDate: {}, linesByDate: {}, fileHotspots: [],
    commitList: [
      mkCommit({ hash: 'hExpl', isAI: true, aiAssisted: true, aiConfidence: 'high', aiSignals: ['coAuthor'], attributionType: 'explicit' }),
    ],
  };
  const sessions = [mkSession()];
  await finalizeGitStats(merged, sessions);
  assert.equal(merged.commitList[0].attributionType, 'explicit');
  assert.equal(merged.commitList[0].aiConfidence, 'high');
});

test('project mismatch - d:/repo does not match d:/repo-api', () => {
  const commits = [mkCommit({ repo: 'D:/repo' })];
  const sessions = [mkSession({ id: 'sOther', project: 'D:/repo-api' })];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, null);
});

test('projectKey - hyphen vs no-separator are distinct (no collision)', () => {
  const commits = [mkCommit({ repo: 'D:/foo-bar' })];
  const sessions = [mkSession({ id: 'sNoBar', project: 'D:/foobar' })];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, null);
});

test('projectKey - hyphen preserved, different projects do not match', () => {
  const commits = [mkCommit({ repo: 'D:/foo-bar' })];
  const sessions = [mkSession({ id: 'sDecoded', project: 'D:/foo/bar' })];
  attributeCommitsToSessions(commits, sessions);
  // foo-bar 和 foo/bar 是不同项目，阶段 1 修复后 projectKey 保留语义字符
  assert.equal(commits[0].sessionId, null);
});

test('projectKey - underscore preserved, different projects do not match', () => {
  const commits = [mkCommit({ repo: 'D:/foo_bar' })];
  const sessions = [mkSession({ id: 'sUS', project: 'D:/foo/bar' })];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, null);
});

test('projectKey - same project with hyphen matches exactly', () => {
  const commits = [mkCommit({ repo: 'D:/my-app-v2' })];
  const sessions = [mkSession({ id: 'sMulti', project: 'D:/my-app-v2' })];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, 'sMulti');
});

test('weak signal - different author rejected when session has known author', () => {
  const commits = [
    mkCommit({ hash: 'hAlice', date: '2026-05-14T10:00:05', author: 'alice@company.com' }),
    mkCommit({ hash: 'hBob', date: '2026-05-14T10:30:00', author: 'bob@company.com' }),
  ];
  const sessions = [mkSession({
    toolSequence: [
      { name: 'Bash', input: { command: 'git commit -m "feat: alice work"' }, timestamp: '2026-05-14T10:00:00' },
    ],
  })];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, 's1');
  assert.equal(commits[0].sessionAttribution, 'strong');
  assert.equal(commits[1].sessionId, null);
});

test('weak signal - same author accepted when session has known author', () => {
  const commits = [
    mkCommit({ hash: 'hStrong', date: '2026-05-14T10:00:05', author: 'alice@company.com' }),
    mkCommit({ hash: 'hWeak', date: '2026-05-14T10:30:00', author: 'alice@company.com' }),
  ];
  const sessions = [mkSession({
    toolSequence: [
      { name: 'Bash', input: { command: 'git commit -m "feat: x"' }, timestamp: '2026-05-14T10:00:00' },
    ],
  })];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionAttribution, 'strong');
  assert.equal(commits[1].sessionId, 's1');
  assert.equal(commits[1].sessionAttribution, 'weak');
});

test('weak signal - no strong match still allows any author', () => {
  const commits = [mkCommit({ date: '2026-05-14T10:30:00', author: 'anyone@company.com' })];
  const sessions = [mkSession()];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, 's1');
  assert.equal(commits[0].sessionAttribution, 'weak');
});

test('weak signal - delayed commit 20min after session end is caught', () => {
  const commits = [mkCommit({ date: '2026-05-14T11:20:00' })];
  const sessions = [mkSession({ endTime: '2026-05-14T11:00:00' })];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, 's1');
  assert.equal(commits[0].sessionAttribution, 'weak');
});

test('weak signal - commit 31min after session end falls to cross-day-weak', () => {
  const commits = [mkCommit({ date: '2026-05-14T11:31:00' })];
  const sessions = [mkSession({ endTime: '2026-05-14T11:00:00' })];
  attributeCommitsToSessions(commits, sessions);
  // 31 分钟超出 weak buffer(30min)，但在 cross-day-weak 的 3 天范围内
  assert.equal(commits[0].sessionId, 's1');
  assert.equal(commits[0].sessionAttribution, 'cross-day-weak');
});

test('attributeCommitsToSessions - supports configurable weak and cross-day windows', () => {
  const commits = [
    mkCommit({ hash: 'h11m', date: '2026-05-14T11:11:00' }),
    mkCommit({ hash: 'h5d', date: '2026-05-19T11:00:00' }),
    mkCommit({ hash: 'h8d', date: '2026-05-22T11:00:00' }),
  ];
  const sessions = [mkSession({ endTime: '2026-05-14T11:00:00' })];

  attributeCommitsToSessions(commits, sessions, {
    attribution: { windows: { weakWindowMinutes: 10, crossDayWindowDays: 7 } },
  });

  assert.equal(commits[0].sessionId, 's1');
  assert.equal(commits[0].sessionAttribution, 'cross-day-weak');
  assert.equal(commits[1].sessionId, 's1');
  assert.equal(commits[1].sessionAttribution, 'cross-day-weak');
  assert.equal(commits[2].sessionId, null);
});

test('finalizeGitStats - manual commit override controls layered attribution', async () => {
  const merged = {
    commits: 1, filesChanged: 1, linesAdded: 10, linesDeleted: 2,
    commitsByDate: {}, linesByDate: {}, fileHotspots: [],
    commitList: [
      mkCommit({
        hash: 'hManual',
        linesAdded: 10,
        linesDeleted: 2,
        files: [{ path: 'lib/a.js', added: 10, deleted: 2 }],
      }),
    ],
  };

  await finalizeGitStats(merged, [], {
    overrides: {
      commits: {
        hManual: { classification: 'confirmed_ai', primaryTool: 'codex', tools: ['codex'] },
      },
    },
  });

  assert.equal(merged.attributionSummary.confirmedAI, 1);
  assert.equal(merged.attributionSummary.confirmedAILines, 12);
});

test('finalizeGitStats - file override beats commit override', async () => {
  const merged = {
    commits: 1, filesChanged: 1, linesAdded: 10, linesDeleted: 2,
    commitsByDate: {}, linesByDate: {}, fileHotspots: [],
    commitList: [
      mkCommit({
        hash: 'hFileManual',
        linesAdded: 10,
        linesDeleted: 2,
        files: [{ path: 'lib/a.js', added: 10, deleted: 2 }],
      }),
    ],
  };

  await finalizeGitStats(merged, [], {
    overrides: {
      commits: {
        hFileManual: { classification: 'confirmed_ai', primaryTool: 'codex', tools: ['codex'] },
      },
      files: {
        'hFileManual:lib/a.js': { classification: 'human' },
      },
    },
  });

  assert.equal(merged.attributionSummary.confirmedAI, 0);
  assert.equal(merged.attributionSummary.human, 1);
  assert.equal(merged.attributionSummary.humanLines, 12);
});

test('finalizeGitStats - resolves opencode origin-prefixed step session (D1)', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'git-step-opencode-origin-'));
  try {
    writeFileSync(join(tempRoot, 'oc.js'), 'const oc = true;\n');

    const tracker = new StepTracker(tempRoot);
    await tracker.open();
    await tracker.recordStep({
      origin: 'opencode',
      sessionId: 'opencode:sess-oc',
      toolName: 'Write',
      toolInput: { file_path: join(tempRoot, 'oc.js') },
      toolUseId: 'tu-oc',
    });
    tracker.close();

    const stats = {
      commitList: [
        mkCommit({
          repo: tempRoot,
          hash: 'hoc',
          sessionId: 'sess-oc',
          sessionAttribution: 'strong',
          files: [{ path: 'oc.js', added: 1, deleted: 0 }],
          linesAdded: 1,
        }),
      ],
    };
    const sessions = [
      mkSession({ id: 'sess-oc', project: tempRoot, primaryTool: 'opencode' }),
    ];

    await finalizeGitStats(stats, sessions);

    assert.equal(stats.commitList[0].sessionId, 'sess-oc');
    assert.equal(stats.commitList[0].lineBlame?.source, 'step_blame');
    assert.equal(stats.commitList[0].lineBlame?.aiLines, 1);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('finalizeGitStats - merge commit stays human despite strong session + file overlap (D4)', async () => {
  const merged = {
    commits: 1, filesChanged: 1, linesAdded: 5, linesDeleted: 0,
    commitsByDate: {}, linesByDate: {}, fileHotspots: [],
    commitList: [
      mkCommit({
        hash: 'hMerge',
        date: '2026-05-14T10:00:05',
        subject: "Merge branch 'feature/x' into main",
        files: [{ path: 'src/app.js', added: 5, deleted: 0 }],
      }),
    ],
  };
  const sessions = [mkSession({
    toolSequence: [
      { name: 'Bash', input: { command: 'git commit -m "merge"' }, timestamp: '2026-05-14T10:00:00' },
      { name: 'Edit', input: { file_path: 'D:/myrepo/src/app.js' }, timestamp: '2026-05-14T09:59:30' },
    ],
  })];
  await finalizeGitStats(merged, sessions);
  // human_merge 是硬负信号：连续评分不得把 NONE 升回，否则 merge 被误计入 AI 占比
  assert.equal(merged.commitList[0].attributionType, 'human_merge');
  assert.equal(merged.commitList[0].aiConfidence, 'none');
  assert.equal(merged.commitList[0].isAI, false);
});

// ── P0 档②：unified diff hunk 解析（逐行投影的 added 行号来源）──

test('parseAddedLines - 单 hunk 提取新增行号', () => {
  const diff = [
    'diff --git a/f b/f',
    'index 123..456 100644',
    '--- a/f',
    '+++ b/f',
    '@@ -1,3 +1,5 @@',
    ' ctx1',
    '+new1',
    '+new2',
    ' ctx2',
    ' ctx3',
  ].join('\n');
  assert.deepEqual(parseAddedLines(diff), [2, 3]);
});

test('parseAddedLines - 多 hunk 且删除行不占 new 行号', () => {
  const diff = [
    '@@ -1,2 +1,1 @@',
    '-old',
    ' keep',
    '@@ -5,1 +6,2 @@',
    ' keep2',
    '+ins',
  ].join('\n');
  assert.deepEqual(parseAddedLines(diff), [7]);
});
