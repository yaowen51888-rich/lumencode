import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAuditCommitList, renderAuditEvidence } from '../public/git-insights.js';

test('renderAuditCommitList renders audit metadata', () => {
  const html = renderAuditCommitList([{ hash: 'abcdef123', subject: 'feat: audit', date: '2026-07-12', project: 'D:/repo', lineBlame: { aiLines: 3, aiDeletedLines: 1, lineCoverage: 0.75, alignedFiles: 1 } }]);
  assert.ok(html.includes('feat: audit'));
  assert.ok(html.includes('+3 / −1'));
  assert.ok(html.includes('75%'));
});

test('renderAuditEvidence renders classifications and metadata', () => {
  const html = renderAuditEvidence({ files: [{ path: 'a.js', method: 'aligned', coverage: 1, lines: [
    { type: 'added', newLine: 1, content: 'const a = 1;', classification: 'ai', tool: 'codex', sessionId: 's1', stepId: 'st1', confidence: 'high', reason: 'step_blame' },
    { type: 'added', newLine: 2, content: 'const b = 2;', classification: 'human', confidence: 'high' },
    { type: 'deleted', content: '', classification: 'unknown', reason: 'deleted_line_unavailable' },
  ] }] });
  assert.ok(html.includes('audit-line-ai'));
  assert.ok(html.includes('audit-line-human'));
  assert.ok(html.includes('audit-line-unknown'));
  assert.ok(html.includes('codex'));
  assert.ok(html.includes('s1'));
  assert.ok(html.includes('st1'));
});
