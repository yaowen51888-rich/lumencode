import test from 'node:test';
import { strict as assert } from 'node:assert';
import { attributeCommitsToSessions, attachCommitsToSessions, finalizeGitStats } from '../lib/git.js';

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

test('attributeCommitsToSessions - outside time window returns null', () => {
  const commits = [mkCommit({ date: '2026-05-14T20:00:00' })];
  const sessions = [mkSession()];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, null);
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
  assert.equal(commits[0].sessionId, null);
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

test('finalizeGitStats - weak session attribution stays low confidence', () => {
  const merged = {
    commits: 1, filesChanged: 0, linesAdded: 10, linesDeleted: 0,
    commitsByDate: {}, linesByDate: {}, fileHotspots: [],
    commitList: [
      mkCommit({ hash: 'hSess', aiSignals: [] }),
    ],
  };
  const sessions = [mkSession()];
  finalizeGitStats(merged, sessions);
  assert.equal(merged.commitList[0].isAI, false);
  assert.equal(merged.commitList[0].aiAssisted, true);
  assert.equal(merged.commitList[0].aiConfidence, 'low');
  assert.equal(merged.commitList[0].attributionType, 'session_weak');
  assert.ok(merged.commitList[0].aiSignals.includes('sessionAttributed'));
});

test('finalizeGitStats - weak session with file overlap upgrades to medium', () => {
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
  finalizeGitStats(merged, sessions);
  assert.equal(merged.commitList[0].isAI, true);
  assert.equal(merged.commitList[0].aiConfidence, 'medium');
  assert.equal(merged.commitList[0].attributionType, 'session_file_overlap');
  assert.ok(merged.commitList[0].aiSignals.includes('fileOverlap'));
  assert.equal(merged.commitList[0].aiEvidenceDetails.matchedFileCount, 1);
});

test('finalizeGitStats - ignores slash-like strings in non-path fields', () => {
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
  finalizeGitStats(merged, sessions);
  assert.equal(merged.commitList[0].aiConfidence, 'low');
  assert.equal(merged.commitList[0].aiEvidenceDetails.matchedFileCount, 0);
});

test('finalizeGitStats - root filename path field can match overlap', () => {
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
  finalizeGitStats(merged, sessions);
  assert.equal(merged.commitList[0].aiConfidence, 'medium');
  assert.equal(merged.commitList[0].aiEvidenceDetails.matchedFileCount, 1);
});

test('finalizeGitStats - repo tail fallback rescues absolute file path overlap after session match', () => {
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
      { name: 'Edit', input: { file_path: 'D:/actual/myrepo/src/app.js' }, timestamp: '2026-05-14T10:00:00' },
    ],
  })];
  finalizeGitStats(merged, sessions);
  assert.equal(merged.commitList[0].aiConfidence, 'medium');
  assert.equal(merged.commitList[0].aiEvidenceDetails.matchedFileCount, 1);
});

test('finalizeGitStats - strong session with file overlap upgrades to high', () => {
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
  finalizeGitStats(merged, sessions);
  assert.equal(merged.commitList[0].isAI, true);
  assert.equal(merged.commitList[0].aiConfidence, 'high');
  assert.equal(merged.commitList[0].attributionType, 'session_strong_file_overlap');
  assert.ok(merged.commitList[0].aiSignals.includes('sessionCommitBash'));
  assert.ok(merged.commitList[0].aiSignals.includes('fileOverlap'));
});

test('finalizeGitStats - explicit AI keeps explicit attribution', () => {
  const merged = {
    commits: 1, filesChanged: 0, linesAdded: 10, linesDeleted: 0,
    commitsByDate: {}, linesByDate: {}, fileHotspots: [],
    commitList: [
      mkCommit({ hash: 'hExpl', isAI: true, aiAssisted: true, aiConfidence: 'high', aiSignals: ['coAuthor'], attributionType: 'explicit' }),
    ],
  };
  const sessions = [mkSession()];
  finalizeGitStats(merged, sessions);
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

test('projectKey - hyphen matches slash (decodeProjectName compatibility)', () => {
  const commits = [mkCommit({ repo: 'D:/foo-bar' })];
  const sessions = [mkSession({ id: 'sDecoded', project: 'D:/foo/bar' })];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, 'sDecoded');
});

test('projectKey - underscore matches slash', () => {
  const commits = [mkCommit({ repo: 'D:/foo_bar' })];
  const sessions = [mkSession({ id: 'sUS', project: 'D:/foo/bar' })];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, 'sUS');
});

test('projectKey - multi-segment hyphen path matches decoded', () => {
  const commits = [mkCommit({ repo: 'D:/my-app-v2' })];
  const sessions = [mkSession({ id: 'sMulti', project: 'D:/my/app/v2' })];
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

test('weak signal - commit 31min after session end is outside buffer', () => {
  const commits = [mkCommit({ date: '2026-05-14T11:31:00' })];
  const sessions = [mkSession({ endTime: '2026-05-14T11:00:00' })];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, null);
});
