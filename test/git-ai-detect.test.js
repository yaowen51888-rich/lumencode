import test from 'node:test';
import { strict as assert } from 'node:assert';
import { detectAICommit, computeAIContribution, computeCommitTypes, computeFileHotspots } from '../lib/git.js';

test('detectAICommit - Co-Authored-By: Claude', () => {
  const r = detectAICommit('feat: add x', 'me@x', 'Body line\nCo-Authored-By: Claude <noreply@anthropic.com>');
  assert.equal(r.isAI, true);
  assert.equal(r.aiConfidence, 'high');
  assert.ok(r.signals.includes('coAuthor'));
});

test('detectAICommit - Generated with Claude', () => {
  const r = detectAICommit('feat: x', 'me@x', 'Generated with [Claude Code](https://...)');
  assert.equal(r.isAI, true);
  assert.equal(r.aiConfidence, 'high');
  assert.ok(r.signals.includes('generatedWith'));
});

test('detectAICommit - Assisted-By: Claude', () => {
  const r = detectAICommit('refactor: split', 'me@x', 'Assisted-By: Claude Sonnet');
  assert.equal(r.isAI, true);
  assert.equal(r.aiConfidence, 'high');
  assert.ok(r.signals.includes('assistedBy'));
});

test('detectAICommit - author contains claude', () => {
  const r = detectAICommit('chore: bump', 'claude-bot@example.com');
  assert.equal(r.isAI, true);
  assert.equal(r.aiConfidence, 'high');
  assert.ok(r.signals.includes('authorClaude'));
});

test('detectAICommit - noreply@anthropic', () => {
  const r = detectAICommit('docs: update', 'noreply@anthropic.com');
  assert.equal(r.isAI, true);
  assert.equal(r.aiConfidence, 'high');
  assert.ok(r.signals.includes('authorClaude'));
});

test('detectAICommit - normal human commit', () => {
  const r = detectAICommit('feat: my work', 'human@x.com', 'just normal commit body');
  assert.equal(r.isAI, false);
  assert.equal(r.aiConfidence, 'none');
  assert.deepEqual(r.signals, []);
});

test('detectAICommit - multiple signals', () => {
  const r = detectAICommit(
    'Generated feat: x',
    'claude-bot@x.com',
    'Co-Authored-By: Claude\nGenerated with Claude Code'
  );
  assert.equal(r.isAI, true);
  assert.equal(r.aiConfidence, 'high');
  assert.ok(r.signals.length >= 2);
});

test('computeAIContribution - counted by confidence', () => {
  const commits = [
    {
      isAI: true,
      aiConfidence: 'high',
      attributionType: 'explicit',
      linesAdded: 50,
      linesDeleted: 10,
      files: [{ path: 'a.js', added: 50, deleted: 10 }],
    },
    {
      isAI: true,
      aiConfidence: 'medium',
      attributionType: 'session_file_overlap',
      linesAdded: 30,
      linesDeleted: 5,
      files: [
        { path: 'b.js', added: 30, deleted: 5 },
      ],
      aiEvidenceDetails: { matchedFiles: ['b.js'] },
    },
    { isAI: false, aiConfidence: 'low', linesAdded: 20, linesDeleted: 2 },
    { isAI: false, aiConfidence: 'none', linesAdded: 10, linesDeleted: 0 },
  ];
  const r = computeAIContribution(commits);
  assert.equal(r.aiCommits, 2);
  assert.equal(r.humanCommits, 2);
  assert.equal(r.aiRatio, 0.5);
  assert.equal(r.aiLinesAdded, 80);
  assert.equal(r.aiLinesDeleted, 15);
  assert.equal(r.aiCommitLinesAdded, 80);
  assert.equal(r.aiCommitLinesDeleted, 15);
  assert.equal(r.aiFileLinesAdded, 80);
  assert.equal(r.aiFileLinesDeleted, 15);
  assert.equal(r.highConfidenceCommits, 1);
  assert.equal(r.mediumConfidenceCommits, 1);
  assert.equal(r.lowConfidenceCommits, 1);
});

test('computeAIContribution - file-level line attribution only counts matched files', () => {
  const commits = [
    {
      isAI: true,
      aiConfidence: 'medium',
      attributionType: 'session_file_overlap',
      linesAdded: 70,
      linesDeleted: 11,
      files: [
        { path: 'src/a.js', added: 40, deleted: 6 },
        { path: 'src/b.js', added: 20, deleted: 3 },
        { path: 'README.md', added: 10, deleted: 2 },
      ],
      aiEvidenceDetails: { matchedFiles: ['src/a.js', 'README.md'] },
    },
  ];
  const r = computeAIContribution(commits);
  assert.equal(r.aiCommitLinesAdded, 70);
  assert.equal(r.aiCommitLinesDeleted, 11);
  assert.equal(r.aiFileLinesAdded, 50);
  assert.equal(r.aiFileLinesDeleted, 8);
  assert.equal(r.aiLinesAdded, 50);
  assert.equal(r.aiLinesDeleted, 8);
});

test('computeAIContribution - empty input', () => {
  const r = computeAIContribution([]);
  assert.equal(r.aiCommits, 0);
  assert.equal(r.humanCommits, 0);
  assert.equal(r.aiRatio, 0);
  assert.equal(r.aiLinesAdded, 0);
  assert.equal(r.aiLinesDeleted, 0);
  assert.equal(r.highConfidenceCommits, 0);
  assert.equal(r.mediumConfidenceCommits, 0);
  assert.equal(r.lowConfidenceCommits, 0);
});

test('detectAICommit - body Co-Authored-By', () => {
  const r = detectAICommit('feat: add x', 'human@x.com', 'Normal body\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  assert.equal(r.isAI, true);
  assert.equal(r.aiConfidence, 'high');
  assert.ok(r.signals.includes('coAuthor'));
});

test('detectAICommit - empty body no marker', () => {
  const r = detectAICommit('feat: my work', 'human@x.com', '');
  assert.equal(r.isAI, false);
  assert.equal(r.aiConfidence, 'none');
  assert.deepEqual(r.signals, []);
});

test('detectAICommit - Copilot Co-Authored-By', () => {
  const r = detectAICommit('feat: ai code', 'dev@x.com', 'Co-Authored-By: Copilot (<noreply@github.com>)');
  assert.equal(r.isAI, true);
  assert.equal(r.aiConfidence, 'high');
  assert.ok(r.signals.includes('coAuthorCopilot'));
});

test('detectAICommit - Cursor Co-Authored-By', () => {
  const r = detectAICommit('fix: bug', 'dev@x.com', 'Co-Authored-By: Cursor');
  assert.equal(r.isAI, true);
  assert.equal(r.aiConfidence, 'high');
  assert.ok(r.signals.includes('coAuthorCursor'));
});

test('computeCommitTypes - type counts', () => {
  const commits = [
    { type: 'feat' }, { type: 'feat' }, { type: 'fix' },
    { type: 'docs' }, { type: 'other' }, {},
  ];
  const types = computeCommitTypes(commits);
  assert.equal(types.feat, 2);
  assert.equal(types.fix, 1);
  assert.equal(types.docs, 1);
  assert.equal(types.other, 2);
  assert.equal(types.refactor, 0);
});

test('computeFileHotspots - sorted by touches', () => {
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

test('computeFileHotspots - topN limit', () => {
  const r = computeFileHotspots([{
    files: Array.from({ length: 20 }, (_, i) => ({ path: `f${i}.js`, added: 1, deleted: 0 })),
  }], 5);
  assert.equal(r.length, 5);
});

test('computeFileHotspots - empty input', () => {
  assert.deepEqual(computeFileHotspots([], 10), []);
  assert.deepEqual(computeFileHotspots(null, 10), []);
});

test('detectAICommit - detectedTool for Claude signals', () => {
  const r = detectAICommit('feat: x', 'me@x', 'Co-Authored-By: Claude <noreply@anthropic.com>');
  assert.equal(r.detectedTool, 'claude');
});

test('detectAICommit - detectedTool for Generated with Claude', () => {
  const r = detectAICommit('feat: x', 'me@x', 'Generated with [Claude Code](https://...)');
  assert.equal(r.detectedTool, 'claude');
});

test('detectAICommit - detectedTool for Copilot signals', () => {
  const r = detectAICommit('feat: x', 'dev@x', 'Co-Authored-By: Copilot (<noreply@github.com>)');
  assert.equal(r.detectedTool, 'copilot');
});

test('detectAICommit - detectedTool for Codex signals', () => {
  const r = detectAICommit('feat: x', 'dev@x', 'Co-Authored-By: Codex');
  assert.equal(r.detectedTool, 'codex');
});

test('detectAICommit - detectedTool for OpenCode signals', () => {
  const r = detectAICommit('feat: x', 'dev@x', 'Co-Authored-By: OpenCode');
  assert.equal(r.detectedTool, 'opencode');
});

test('detectAICommit - detectedTool for generic AI signals', () => {
  const r = detectAICommit('feat: x', 'dev@x', '[AI] auto generated');
  assert.equal(r.detectedTool, 'generic-ai');
});

test('detectAICommit - detectedTool null for human commit', () => {
  const r = detectAICommit('feat: my work', 'human@x.com', 'just normal commit body');
  assert.equal(r.detectedTool, null);
});

test('detectAICommit - detectedTool prefers explicit tool over generic', () => {
  const r = detectAICommit('feat: x', 'claude-bot@x.com', 'Co-Authored-By: Claude\n[AI] generated');
  assert.equal(r.detectedTool, 'claude');
});

test('detectAICommit - detectedTool for Cursor signals', () => {
  const r = detectAICommit('fix: bug', 'dev@x', 'Co-Authored-By: Cursor');
  assert.equal(r.detectedTool, 'cursor');
});

test('detectAICommit - detectedTool for Aider signals', () => {
  const r = detectAICommit('feat: x', 'dev@x', 'Generated with [Aider](https://...)');
  assert.equal(r.detectedTool, 'aider');
});

test('detectAICommit - detectedTool for author-based Claude detection', () => {
  const r = detectAICommit('docs: update', 'noreply@anthropic.com');
  assert.equal(r.detectedTool, 'claude');
});
