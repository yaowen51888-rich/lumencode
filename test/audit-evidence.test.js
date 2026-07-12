import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommitAuditEvidence } from '../lib/audit-evidence.js';

test('buildCommitAuditEvidence returns privacy-safe line evidence', () => {
  const commit = {
    hash: 'abcdef1234567890', subject: 'feat: audit', author: 'Dev', date: '2026-07-12T10:00:00Z',
    project: 'D:/repo', aiConfidence: 'high', attributionType: 'session_strong_file_overlap',
    prompt: 'secret prompt', response: 'secret response',
    files: [{ path: 'src/a.js', added: 2, deleted: 1, commitContent: 'const a = 1;\nconst b = 2;\n', addedLines: [1, 2] }],
    lineBlame: {
      lineCoverage: 1,
      fileBreakdown: {
        'src/a.js': {
          method: 'aligned', lineCoverage: 1,
          lines: [
            { newLine: 1, classification: 'ai', stepId: 'step-1', sessionId: 'session-1', tool: 'codex', confidence: 'high', reason: 'step_blame' },
            { newLine: 2, classification: 'human', stepId: 'step-2', sessionId: 'session-2', tool: 'claude', confidence: 'high', reason: 'other_step' },
          ],
        },
      },
    },
  };

  const result = buildCommitAuditEvidence(commit);

  assert.equal(result.hash, commit.hash);
  assert.equal(result.files[0].lines[0].content, 'const a = 1;');
  assert.equal(result.files[0].lines[0].classification, 'ai');
  assert.equal(result.files[0].lines[1].classification, 'human');
  assert.equal(result.files[0].lines[2].type, 'deleted');
  assert.equal(result.files[0].lines[2].classification, 'unknown');
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('secret prompt'));
  assert.ok(!serialized.includes('secret response'));
  assert.ok(!serialized.includes('content_blob'));
});

test('buildCommitAuditEvidence falls back to unknown without line blame', () => {
  const result = buildCommitAuditEvidence({
    hash: '1234567', subject: 'fix', files: [{ path: 'a.js', added: 1, deleted: 0, commitContent: 'x\n', addedLines: [1] }],
  });

  assert.equal(result.files[0].method, 'unavailable');
  assert.deepEqual(result.files[0].lines.map(line => line.classification), ['unknown']);
});
