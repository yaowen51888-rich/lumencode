import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAuditEvidence } from '../lib/server.js';

const commit = { hash: 'abcdef1234567890', project: 'D:/repo', subject: 'feat', files: [] };

test('resolveAuditEvidence returns configured in-period commit', () => {
  const result = resolveAuditEvidence({ repos: ['D:/repo'] }, { gitStats: { commitList: [commit] } }, 'D:/repo', 'abcdef1');
  assert.equal(result.hash, commit.hash);
});

test('resolveAuditEvidence rejects invalid hash and repository', () => {
  assert.throws(() => resolveAuditEvidence({ repos: ['D:/repo'] }, { gitStats: { commitList: [commit] } }, 'D:/repo', 'bad!'), /无效的 commit/);
  assert.throws(() => resolveAuditEvidence({ repos: ['D:/repo'] }, { gitStats: { commitList: [commit] } }, 'D:/other', 'abcdef1'), /项目未配置/);
});

test('resolveAuditEvidence rejects commit outside report period', () => {
  assert.throws(() => resolveAuditEvidence({ repos: ['D:/repo'] }, { gitStats: { commitList: [] } }, 'D:/repo', 'abcdef1'), /当前报告周期/);
});
