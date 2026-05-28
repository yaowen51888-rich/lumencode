import test from 'node:test';
import { strict as assert } from 'node:assert';
import { detectAICommit, detectNegativeSignals, computeAIContribution, computeCommitTypes, computeFileHotspots, finalizeGitStats } from '../lib/git.js';

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

test('detectAICommit - style heuristic detects AI-like commit (strong → medium)', () => {
  const body = [
    '- Add per-project work report generation with project selector panel',
    '- Add custom date range picker (arbitrary start/end dates)',
    '- Fix period-aware date navigation (weekly ±7d, monthly ±1mo)',
    '- Redesign sidebar: version/theme/collapse moved to footer',
    '- Rewrite README.md and README_EN.md for v1.0.0',
  ].join('\n');
  const r = detectAICommit('feat(v1.0.0): per-project reports', 'dev@example.com', body);
  assert.equal(r.isAI, true);
  assert.equal(r.aiAssisted, true);
  assert.equal(r.aiConfidence, 'medium');
  assert.equal(r.attributionType, 'style_heuristic_strong');
  assert.ok(r.signals.includes('styleBulletList'));
  assert.ok(r.signals.includes('styleConventionalScope'));
  assert.ok(r.signals.includes('styleImperativeMood'));
});

test('detectAICommit - style heuristic below threshold', () => {
  const r = detectAICommit('fix: typo', 'dev@example.com', '- fix a typo');
  assert.equal(r.aiAssisted, false);
  assert.equal(r.aiConfidence, 'none');
});

test('detectAICommit - style heuristic skipped when explicit signal present', () => {
  const body = '- Add feature A\n- Add feature B\n- Add feature C\n- Update lib/core.js';
  const r = detectAICommit('feat(core): big feature', 'dev@x.com', body + '\nCo-Authored-By: Claude');
  assert.equal(r.aiConfidence, 'high');
  assert.equal(r.attributionType, 'explicit');
  assert.ok(!r.signals.includes('styleBulletList'));
});

test('detectAICommit - style heuristic requires bullet list', () => {
  const r = detectAICommit('feat(v2): update', 'dev@x.com', 'A very long body with technical detail in lib/parser.js but no bullets at all, just plain text.');
  assert.equal(r.aiAssisted, false);
  assert.equal(r.aiConfidence, 'none');
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
  assert.equal(r.possibleAICommits, 1);
  assert.equal(r.humanCommits, 1);
  assert.equal(r.aiCommitRatio, 0.5);
  assert.equal(r.possibleAICommitRatio, 0.25);
  assert.equal(r.aiRatio, 95 / 127);
  assert.equal(r.aiLinesAdded, 80);
  assert.equal(r.aiLinesDeleted, 15);
  assert.equal(r.aiCommitLinesAdded, 80);
  assert.equal(r.aiCommitLinesDeleted, 15);
  assert.equal(r.aiFileLinesAdded, 80);
  assert.equal(r.aiFileLinesDeleted, 15);
  assert.equal(r.highConfidenceCommits, 1);
  assert.equal(r.mediumConfidenceCommits, 1);
  assert.equal(r.lowConfidenceCommits, 1);
  // 加权指标
  assert.ok(r.weightedAILinesAdded > 0);
  assert.ok(r.weightedAILinesDeleted > 0);
  assert.ok(r.weightedAILineRatio > 0);
});

test('finalizeGitStats - uses custom continuous score thresholds', async () => {
  const merged = {
    commits: 1,
    filesChanged: 1,
    linesAdded: 10,
    linesDeleted: 0,
    commitsByDate: {},
    linesByDate: {},
    fileHotspots: [],
    commitList: [{
      hash: 'hThreshold',
      repo: 'D:/myrepo',
      date: '2026-05-14T10:00:00',
      author: 'me@x',
      subject: 'feat: x',
      linesAdded: 10,
      linesDeleted: 0,
      files: [{ path: 'a.js', added: 10, deleted: 0 }],
      aiConfidence: 'none',
      aiSignals: ['coAuthor'],
      negativeSignals: [],
      attributionType: null,
    }],
  };

  await finalizeGitStats(merged, [], {
    attribution: {
      confidenceThresholds: { high: 0.90, medium: 0.60, low: 0.30 },
    },
  });

  assert.notEqual(merged.commitList[0].aiConfidence, 'high');
  assert.equal(merged.commitList[0].aiConfidence, 'medium');
});

test('computeAIContribution - uses custom confidence weights', () => {
  const r = computeAIContribution([
    {
      isAI: true,
      aiConfidence: 'medium',
      attributionType: 'session_file_overlap',
      linesAdded: 100,
      linesDeleted: 0,
      files: [{ path: 'a.js', added: 100, deleted: 0 }],
      aiEvidenceDetails: { matchedFiles: ['a.js'] },
    },
  ], null, {
    confidenceWeights: { high: 1, medium: 0.5, low: 0.1, none: 0 },
  });

  assert.equal(r.weightedAILinesChanged, 50);
});

test('computeAIContribution - aiRatio uses changed lines instead of commit count', () => {
  const commits = [
    {
      isAI: true,
      aiConfidence: 'high',
      attributionType: 'explicit',
      linesAdded: 10,
      linesDeleted: 0,
      files: [{ path: 'ai.js', added: 10, deleted: 0 }],
    },
    {
      isAI: false,
      aiConfidence: 'none',
      linesAdded: 90,
      linesDeleted: 0,
      files: [{ path: 'human.js', added: 90, deleted: 0 }],
    },
  ];
  const r = computeAIContribution(commits);
  assert.equal(r.aiCommits, 1);
  assert.equal(r.aiCommitRatio, 0.5);
  assert.equal(r.aiRatio, 0.1);
  assert.equal(r.aiLineRatio, 0.1);
  assert.equal(r.totalLinesChanged, 100);
});

test('computeAIContribution - tool filter keeps total project lines as denominator', () => {
  const commits = [
    {
      isAI: true,
      aiConfidence: 'high',
      attributionType: 'explicit',
      attributedTool: 'claude',
      linesAdded: 10,
      linesDeleted: 0,
      files: [{ path: 'claude.js', added: 10, deleted: 0 }],
    },
    {
      isAI: true,
      aiConfidence: 'high',
      attributionType: 'explicit',
      attributedTool: 'codex',
      linesAdded: 30,
      linesDeleted: 0,
      files: [{ path: 'codex.js', added: 30, deleted: 0 }],
    },
    {
      isAI: false,
      aiConfidence: 'none',
      linesAdded: 60,
      linesDeleted: 0,
      files: [{ path: 'human.js', added: 60, deleted: 0 }],
    },
  ];
  const r = computeAIContribution(commits, 'claude');
  assert.equal(r.aiCommits, 1);
  assert.equal(r.aiRatio, 0.1);
  assert.equal(r.totalLinesChanged, 100);
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

// ── Negative signal tests ──

test('detectNegativeSignals - humanInformal short non-conventional message', () => {
  const signals = detectNegativeSignals('fix typo', '', 0, 0, 0);
  assert.ok(signals.includes('humanInformal'));
});

test('detectNegativeSignals - humanMergeCommit', () => {
  const signals = detectNegativeSignals("Merge branch 'feature'", '', 10, 2, 3);
  assert.ok(signals.includes('humanMergeCommit'));
});

test('detectNegativeSignals - humanSmallScope', () => {
  const signals = detectNegativeSignals('chore: lint', '', 1, 1, 1);
  assert.ok(signals.includes('humanSmallScope'));
});

test('detectNegativeSignals - humanWIP', () => {
  const signals = detectNegativeSignals('WIP: new feature', '', 50, 0, 5);
  assert.ok(signals.includes('humanWIP'));
});

test('detectNegativeSignals - no signals for normal commit', () => {
  const signals = detectNegativeSignals('feat: add user model', 'Add User model with validation', 120, 5, 8);
  assert.deepEqual(signals, []);
});

test('detectAICommit - negative signals block style heuristic for short informal message', () => {
  const r = detectAICommit('wip stuff', 'dev@x.com', '');
  assert.equal(r.aiConfidence, 'none');
  assert.ok((r.negativeSignals || []).includes('humanInformal'));
});

test('detectAICommit - negative signals do not block explicit signature', () => {
  const r = detectAICommit('WIP: feature', 'dev@x.com', 'Co-Authored-By: Claude <noreply@anthropic.com>');
  assert.equal(r.aiConfidence, 'high');
  assert.equal(r.attributionType, 'explicit');
});

// ── Timezone handling tests ──

test('date preservation - full ISO with timezone offset parses correctly', () => {
  // Verify Date.parse handles timezone-offset dates
  const withOffset = '2026-05-25T10:30:00+08:00';
  const withZ = '2026-05-25T02:30:00Z';
  assert.equal(Date.parse(withOffset), Date.parse(withZ));
});

test('date preservation - slice(0,10) extracts date key from offset format', () => {
  const date = '2026-05-25T10:30:00+08:00';
  assert.equal(date.slice(0, 10), '2026-05-25');
});

// ── Continuous score integration tests (via computeAIContribution) ──

test('computeAIContribution - explicit AI commit has aiScore >= 0.75', () => {
  const commits = [
    {
      isAI: true,
      aiConfidence: 'high',
      attributionType: 'explicit',
      detectedTool: 'claude',
      linesAdded: 50,
      linesDeleted: 10,
      files: [{ path: 'a.js', added: 50, deleted: 10 }],
      aiSignals: ['coAuthor'],
      negativeSignals: [],
      aiEvidenceDetails: {},
    },
    { isAI: false, aiConfidence: 'none', linesAdded: 10, linesDeleted: 0, files: [], aiSignals: [], negativeSignals: [], aiEvidenceDetails: {} },
  ];
  const r = computeAIContribution(commits);
  assert.equal(r.aiCommits, 1);
  assert.equal(r.aiRatio, 60 / 70);
});

test('computeAIContribution - negative signals reduce weighted ratio', () => {
  const commits = [
    {
      isAI: true,
      aiConfidence: 'medium',
      attributionType: 'session_strong',
      linesAdded: 100,
      linesDeleted: 20,
      files: [{ path: 'a.js', added: 100, deleted: 20 }],
      aiSignals: ['sessionCommitBash', 'fileOverlap'],
      negativeSignals: ['humanSmallScope'],
      aiEvidenceDetails: { fileOverlapRatio: 0.8 },
    },
  ];
  const r = computeAIContribution(commits);
  assert.equal(r.aiCommits, 1);
  // Weighted should reflect MEDIUM (0.7) weight
  assert.ok(r.weightedAILineRatio > 0);
});

test('computeAIContribution - merge commit excluded from AI', () => {
  const commits = [
    {
      isAI: false,
      aiConfidence: 'none',
      attributionType: 'human_merge',
      linesAdded: 5,
      linesDeleted: 0,
      files: [{ path: 'a.js', added: 5, deleted: 0 }],
      aiSignals: [],
      negativeSignals: ['humanMergeCommit'],
    },
  ];
  const r = computeAIContribution(commits);
  assert.equal(r.aiCommits, 0);
  assert.equal(r.humanCommits, 1);
});
