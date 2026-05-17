// test/git-attribution.test.js — session ↔ commit 关联
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { attributeCommitsToSessions, attachCommitsToSessions } from '../lib/git.js';

function mkCommit(over) {
  return {
    repo: 'D:/myrepo', hash: 'h1', date: '2026-05-14T10:00:00',
    author: 'me@x', subject: 'feat: x', linesAdded: 10, linesDeleted: 0,
    files: [], type: 'feat', isAI: false, ...over,
  };
}
function mkSession(over) {
  return {
    id: 's1', project: 'D:/myrepo',
    startTime: '2026-05-14T09:00:00', endTime: '2026-05-14T11:00:00',
    toolSequence: [], ...over,
  };
}

test('attributeCommitsToSessions - Bash git commit 强信号命中', () => {
  const commits = [mkCommit({ date: '2026-05-14T10:00:05' })];
  const sessions = [mkSession({
    toolSequence: [
      { name: 'Bash', input: { command: 'git commit -m "feat: x"' }, timestamp: '2026-05-14T10:00:00' },
    ],
  })];
  const r = attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, 's1');
  assert.deepEqual(r.sessionCommitMap, { s1: ['h1'] });
});

test('attributeCommitsToSessions - 时间窗弱信号兜底', () => {
  const commits = [mkCommit({ date: '2026-05-14T10:30:00' })];
  const sessions = [mkSession({ toolSequence: [] })];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, 's1');
});

test('attributeCommitsToSessions - 超出时间窗 + buffer → null', () => {
  const commits = [mkCommit({ date: '2026-05-14T20:00:00' })];
  const sessions = [mkSession({ toolSequence: [] })];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, null);
});

test('attributeCommitsToSessions - 多 session 取中点最近的', () => {
  const commits = [mkCommit({ hash: 'hX', date: '2026-05-14T10:30:00' })];
  const sessions = [
    mkSession({ id: 's-far', startTime: '2026-05-14T08:00:00', endTime: '2026-05-14T09:00:00' }),
    mkSession({ id: 's-near', startTime: '2026-05-14T10:00:00', endTime: '2026-05-14T11:00:00' }),
  ];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, 's-near');
});

test('attributeCommitsToSessions - 多项目隔离（项目路径不匹配则不归属）', () => {
  const commits = [mkCommit({ repo: 'D:/repoA' })];
  const sessions = [mkSession({ id: 'sB', project: 'D:/repoB' })];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, null);
});

test('attributeCommitsToSessions - 项目路径大小写不敏感 + 反斜杠归一', () => {
  const commits = [mkCommit({ repo: 'D:\\MyRepo' })];
  const sessions = [mkSession({ id: 'sLC', project: 'd:/myrepo' })];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, 'sLC');
});

test('attributeCommitsToSessions - 强信号优先于时间窗', () => {
  const commits = [mkCommit({ date: '2026-05-14T10:30:00', hash: 'hPri' })];
  const sessions = [
    mkSession({ id: 's-window', startTime: '2026-05-14T10:00:00', endTime: '2026-05-14T11:00:00' }),
    mkSession({
      id: 's-bash',
      startTime: '2026-05-14T08:00:00', endTime: '2026-05-14T09:00:00',
      toolSequence: [
        { name: 'Bash', input: { command: 'cd repo && git commit -am "x"' }, timestamp: '2026-05-14T10:29:00' },
      ],
    }),
  ];
  attributeCommitsToSessions(commits, sessions);
  // s-bash 的 git commit 在 10:29 → 窗口 10:28:30 - 10:34:00，commit 10:30 命中
  assert.equal(commits[0].sessionId, 's-bash');
});

test('attributeCommitsToSessions - Bash 非 git commit 不触发', () => {
  const commits = [mkCommit({ date: '2026-05-14T15:00:00' })];
  const sessions = [mkSession({
    startTime: '2026-05-14T14:00:00', endTime: '2026-05-14T14:30:00',
    toolSequence: [
      { name: 'Bash', input: { command: 'git status' }, timestamp: '2026-05-14T15:00:00' },
    ],
  })];
  attributeCommitsToSessions(commits, sessions);
  assert.equal(commits[0].sessionId, null); // 时间窗外（15:00 vs 14:00-14:30 + 5min buffer 仍超），且无 commit Bash 强信号
});

test('attributeCommitsToSessions - 空输入', () => {
  assert.deepEqual(attributeCommitsToSessions([], []).sessionCommitMap, {});
  assert.deepEqual(attributeCommitsToSessions(null, null).sessionCommitMap, {});
});

test('attachCommitsToSessions - 回填 session.commits', () => {
  const sessions = [
    { id: 's1', commits: [] },
    { id: 's2', commits: [] },
  ];
  const commitList = [
    { hash: 'a', sessionId: 's1', subject: 'feat: a', type: 'feat', isAI: false, linesAdded: 10, linesDeleted: 0, date: '2026-05-14T10:00:00' },
    { hash: 'b', sessionId: 's1', subject: 'fix: b', type: 'fix', isAI: true, linesAdded: 5, linesDeleted: 2, date: '2026-05-14T11:00:00' },
    { hash: 'c', sessionId: 's2', subject: 'docs: c', type: 'docs', isAI: false, linesAdded: 20, linesDeleted: 0, date: '2026-05-14T12:00:00' },
    { hash: 'd', sessionId: null, subject: 'other', type: 'other', isAI: false, linesAdded: 1, linesDeleted: 0, date: '2026-05-14T13:00:00' },
  ];
  attachCommitsToSessions(sessions, commitList);
  assert.equal(sessions[0].commits.length, 2);
  assert.equal(sessions[1].commits.length, 1);
  assert.equal(sessions[0].commits[0].hash, 'a');
  assert.equal(sessions[0].commits[1].isAI, true);
});
