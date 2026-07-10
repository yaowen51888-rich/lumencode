import test from 'node:test';
import { strict as assert } from 'node:assert';
import { buildCommitNarrative, buildAIContributionDetail, generateWorkReport, generateBriefReport, generateFeishuCard, workReportFooter } from '../lib/report.js';

function mkCommit(over = {}) {
  return {
    type: 'feat', scope: null, subject: 'feat: default', isAI: false,
    repo: 'D:/myapp', aiConfidence: 'none', ...over,
  };
}

test('buildCommitNarrative - empty input', () => {
  assert.equal(buildCommitNarrative([]), null);
  assert.equal(buildCommitNarrative(null), null);
});

test('buildCommitNarrative - single project groups by type', () => {
  const commits = [
    mkCommit({ type: 'feat', subject: 'feat: add login' }),
    mkCommit({ type: 'feat', subject: 'feat: add logout' }),
    mkCommit({ type: 'fix', subject: 'fix: resolve crash' }),
  ];
  const result = buildCommitNarrative(commits);
  assert.ok(result);
  assert.equal(result.sections.length, 2);
  assert.equal(result.sections[0].type, 'feat');
  assert.equal(result.sections[0].count, 2);
  assert.equal(result.sections[0].items.length, 2);
  assert.equal(result.sections[1].type, 'fix');
});

test('buildCommitNarrative - projectGroup splits by repo', () => {
  const commits = [
    mkCommit({ repo: 'D:/appA', subject: 'feat: a1' }),
    mkCommit({ repo: 'D:/appB', subject: 'feat: b1' }),
  ];
  const result = buildCommitNarrative(commits, { projectGroup: true });
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 2);
});

test('buildCommitNarrative - overflow truncation', () => {
  const commits = Array.from({ length: 10 }, (_, i) => mkCommit({ subject: `feat: item ${i}` }));
  const result = buildCommitNarrative(commits, { maxItems: 3 });
  assert.equal(result.sections[0].items.length, 3);
  assert.equal(result.sections[0].overflow, 7);
});

test('buildCommitNarrative - aiCount per section', () => {
  const commits = [
    mkCommit({ type: 'feat', subject: 'feat: ai work', isAI: true }),
    mkCommit({ type: 'feat', subject: 'feat: human work', isAI: false }),
    mkCommit({ type: 'fix', subject: 'fix: ai fix', isAI: true }),
  ];
  const result = buildCommitNarrative(commits);
  assert.equal(result.sections[0].aiCount, 1); // feat: 1 AI
  assert.equal(result.sections[1].aiCount, 1); // fix: 1 AI
});

test('buildCommitNarrative - scope shown in items', () => {
  const commits = [mkCommit({ type: 'feat', scope: 'auth', subject: 'feat(auth): add OAuth' })];
  const result = buildCommitNarrative(commits);
  assert.ok(result.sections[0].items[0].includes('[auth]'));
});

test('buildCommitNarrative - cleans subject prefix and emoji', () => {
  const commits = [
    mkCommit({ type: 'feat', subject: 'feat: ✨ add sparkle' }),
    mkCommit({ type: 'fix', scope: 'core', subject: 'fix(core): resolve issue' }),
  ];
  const result = buildCommitNarrative(commits);
  assert.ok(!result.sections[0].items[0].startsWith('feat:'));
  assert.ok(!result.sections[0].items[0].includes('✨'));
  assert.ok(result.sections[1].items[0].startsWith('[core]'));
});

test('buildCommitNarrative - truncates long subjects', () => {
  const longSub = 'feat: ' + 'x'.repeat(100);
  const commits = [mkCommit({ subject: longSub })];
  const result = buildCommitNarrative(commits);
  assert.ok(result.sections[0].items[0].length <= 63); // 60 + '...'
});

test('generateWorkReport - includes narrative when commitList present', () => {
  const usageStats = {
    requestCount: 10, totalTokens: 5000, sessionCount: 2, estimatedCost: 0.5,
    inputTokens: 2000, outputTokens: 3000, cacheRead: 0, cacheCreate: 0,
    activeDays: 1, userMessageCount: 8, subagentTokens: 0,
    projects: {}, scenarios: {}, models: {}, tools: {},
  };
  const gitStats = {
    commits: 2, filesChanged: 3, linesAdded: 50, linesDeleted: 10,
    commitList: [
      mkCommit({ type: 'feat', subject: 'feat: add login page' }),
      mkCommit({ type: 'fix', subject: 'fix: resolve crash on startup' }),
    ],
  };
  const report = generateWorkReport(usageStats, gitStats, 'daily', '2026-05-14', '2026-05-14');
  assert.ok(report.includes('add login page'));
  assert.ok(report.includes('resolve crash on startup'));
  assert.ok(report.includes('新功能'));
  assert.ok(report.includes('缺陷修复'));
});

test('generateWorkReport - without gitStats still works', () => {
  const usageStats = {
    requestCount: 5, totalTokens: 2000, sessionCount: 1,
    inputTokens: 1000, outputTokens: 1000, cacheRead: 0, cacheCreate: 0,
    activeDays: 1, userMessageCount: 4, subagentTokens: 0,
    projects: {}, scenarios: {}, models: {}, tools: {},
  };
  const report = generateWorkReport(usageStats, null, 'daily', '2026-05-14', '2026-05-14');
  assert.ok(report.includes('工作概述'));
  assert.ok(!report.includes('代码产出'));
});

// ── buildAIContributionDetail ──

test('buildAIContributionDetail - categorizes by attributionType', () => {
  const commits = [
    mkCommit({ subject: 'feat: explicit ai', isAI: true, aiConfidence: 'high', attributionType: 'explicit' }),
    mkCommit({ subject: 'feat: strong', isAI: true, aiConfidence: 'high', attributionType: 'session_strong_file_overlap' }),
    mkCommit({ subject: 'feat: overlap', isAI: true, aiConfidence: 'medium', attributionType: 'session_file_overlap' }),
    mkCommit({ subject: 'feat: human', isAI: false, aiConfidence: 'none', attributionType: null }),
  ];
  const detail = buildAIContributionDetail(commits);
  assert.ok(detail);
  assert.equal(detail.explicit.length, 1);
  assert.equal(detail.sessionStrong.length, 1);
  assert.equal(detail.fileOverlap.length, 1);
});

test('buildAIContributionDetail - collects AI files from matchedFiles', () => {
  const commits = [
    mkCommit({
      subject: 'feat: ai work', isAI: true, aiConfidence: 'medium', attributionType: 'session_file_overlap',
      aiEvidenceDetails: { matchedFiles: ['src/a.js', 'src/b.js'] },
      files: [{ path: 'src/a.js', added: 10, deleted: 0 }, { path: 'src/b.js', added: 5, deleted: 2 }],
    }),
  ];
  const detail = buildAIContributionDetail(commits);
  assert.ok(detail);
  assert.ok(detail.aiFiles.includes('src/a.js'));
  assert.ok(detail.aiFiles.includes('src/b.js'));
  assert.equal(detail.totalAIFileAdded, 15);
  assert.equal(detail.totalAIFileDeleted, 2);
});

test('buildAIContributionDetail - explicit with no matchedFiles uses all files', () => {
  const commits = [
    mkCommit({
      subject: 'feat: explicit', isAI: true, aiConfidence: 'high', attributionType: 'explicit',
      files: [{ path: 'lib/core.js', added: 20, deleted: 0 }],
    }),
  ];
  const detail = buildAIContributionDetail(commits);
  assert.ok(detail.aiFiles.includes('lib/core.js'));
  assert.equal(detail.totalAIFileAdded, 20);
});

test('buildAIContributionDetail - returns null for no AI commits', () => {
  const commits = [mkCommit({ isAI: false, aiConfidence: 'none' })];
  assert.equal(buildAIContributionDetail(commits), null);
});

// ── generateBriefReport ──

test('generateBriefReport - outputs structured brief with sections', () => {
  const usageStats = {
    requestCount: 50, totalTokens: 120000, sessionCount: 5, estimatedCost: 2.5,
    inputTokens: 30000, outputTokens: 90000, cacheRead: 20000, cacheCreate: 5000,
    activeDays: 5, userMessageCount: 45, subagentTokens: 0,
    projects: {}, scenarios: {}, models: {},
  };
  const gitStats = {
    commits: 3, filesChanged: 5, linesAdded: 100, linesDeleted: 20,
    commitList: [
      mkCommit({ type: 'feat', subject: 'feat: add login' }),
      mkCommit({ type: 'fix', subject: 'fix: crash' }),
    ],
    aiContribution: { aiCommits: 1, humanCommits: 2, aiFileLinesAdded: 50, aiFileLinesDeleted: 5 },
  };
  // Default platform: markdown format with headers
  const brief = generateBriefReport(usageStats, gitStats, 'weekly', '2026-05-12', '2026-05-18');
  assert.ok(brief.includes('50 次'));
  assert.ok(brief.includes('add login'));
  assert.ok(brief.includes('## '));
  assert.ok(brief.includes('代码产出'));
  assert.ok(brief.includes('效率提示'));
});

test('generateBriefReport - no git still outputs core narrative', () => {
  const usageStats = {
    requestCount: 10, totalTokens: 5000, sessionCount: 2, estimatedCost: 0.5,
    inputTokens: 2000, outputTokens: 3000, cacheRead: 0, cacheCreate: 0,
    activeDays: 1, userMessageCount: 8, subagentTokens: 0,
    projects: {}, scenarios: {}, models: {},
  };
  const brief = generateBriefReport(usageStats, null, 'daily', '2026-05-14', '2026-05-14');
  assert.ok(brief.includes('10 次'));
  assert.ok(!brief.includes('主要工作'));
});

// ── generateWorkReport level routing ──

test('generateWorkReport - level=brief routes to brief report with markdown sections', () => {
  const usageStats = {
    requestCount: 5, totalTokens: 2000, sessionCount: 1,
    inputTokens: 1000, outputTokens: 1000, cacheRead: 0, cacheCreate: 0,
    activeDays: 1, userMessageCount: 4, subagentTokens: 0,
    projects: {}, scenarios: {}, models: {}, tools: {},
  };
  // Default platform brief uses markdown headers
  const report = generateWorkReport(usageStats, null, 'daily', '2026-05-14', '2026-05-14', null, { level: 'brief' });
  assert.ok(report.includes('# '));
  assert.ok(report.includes('## '));
  assert.ok(report.includes('核心指标'));
});

test('generateWorkReport - level=detailed (default) outputs full report', () => {
  const usageStats = {
    requestCount: 5, totalTokens: 2000, sessionCount: 1,
    inputTokens: 1000, outputTokens: 1000, cacheRead: 0, cacheCreate: 0,
    activeDays: 1, userMessageCount: 4, subagentTokens: 0,
    projects: {}, scenarios: {}, models: {}, tools: {},
  };
  const report = generateWorkReport(usageStats, null, 'daily', '2026-05-14', '2026-05-14', null);
  assert.ok(report.includes('## 一、工作概述'));
});

test('generateWorkReport - backward compatible with string platform', () => {
  const usageStats = {
    requestCount: 5, totalTokens: 2000, sessionCount: 1,
    inputTokens: 1000, outputTokens: 1000, cacheRead: 0, cacheCreate: 0,
    activeDays: 1, userMessageCount: 4, subagentTokens: 0,
    projects: {}, scenarios: {}, models: {}, tools: {},
  };
  // Old API: pass platform as string
  const report = generateWorkReport(usageStats, null, 'daily', '2026-05-14', '2026-05-14', null, 'dingtalk');
  assert.ok(report.includes('工作概述'));
  assert.ok(!report.includes('## 一'));
  assert.ok(report.includes('**一、工作概述**'));
});

// ── Platform adaptation ──

test('generateWorkReport - dingtalk strips ## headers and tables', () => {
  const usageStats = {
    requestCount: 5, totalTokens: 2000, sessionCount: 1,
    inputTokens: 1000, outputTokens: 1000, cacheRead: 0, cacheCreate: 0,
    activeDays: 1, userMessageCount: 4, subagentTokens: 0,
    projects: { 'D:/myapp': { sessions: 1, requests: 5 } }, scenarios: {}, models: {}, tools: {},
  };
  const report = generateWorkReport(usageStats, null, 'daily', '2026-05-14', '2026-05-14', null, { platform: 'dingtalk' });
  assert.ok(!report.includes('## '));
  assert.ok(report.includes('**'));
  assert.ok(!report.includes('|'));
});

test('generateWorkReport - feishu strips tables', () => {
  const usageStats = {
    requestCount: 5, totalTokens: 2000, sessionCount: 1,
    inputTokens: 1000, outputTokens: 1000, cacheRead: 0, cacheCreate: 0,
    activeDays: 1, userMessageCount: 4, subagentTokens: 0,
    projects: { 'D:/myapp': { sessions: 1, requests: 5 } }, scenarios: {}, models: {}, tools: {},
  };
  const report = generateWorkReport(usageStats, null, 'daily', '2026-05-14', '2026-05-14', null, { platform: 'feishu' });
  assert.ok(!report.includes('|'));
  assert.ok(report.includes('## '));
});

// ── Brief report platform differences ──

test('generateBriefReport - dingtalk format uses plain text with section separators', () => {
  const usageStats = {
    requestCount: 10, totalTokens: 5000, sessionCount: 2, estimatedCost: 0.5,
    inputTokens: 2000, outputTokens: 3000, cacheRead: 0, cacheCreate: 0,
    activeDays: 1, userMessageCount: 8, subagentTokens: 0,
    projects: {}, scenarios: {}, models: {},
  };
  const brief = generateBriefReport(usageStats, null, 'daily', '2026-05-14', '2026-05-14', null, 'dingtalk');
  // No markdown headers
  assert.ok(!brief.includes('# '));
  assert.ok(!brief.includes('## '));
  // Has section separators
  assert.ok(brief.includes('核心指标'));
  assert.ok(brief.includes('• '));
});

// ── generateFeishuCard ──

test('generateFeishuCard - returns valid card JSON', () => {
  const usageStats = {
    requestCount: 50, totalTokens: 120000, sessionCount: 5, estimatedCost: 2.5,
    inputTokens: 30000, outputTokens: 90000, cacheRead: 20000, cacheCreate: 5000,
    activeDays: 5, userMessageCount: 45, subagentTokens: 0,
    projects: {}, scenarios: {}, models: {},
  };
  const gitStats = { commits: 3, commitList: [mkCommit({ subject: 'feat: x' })], aiContribution: { aiCommits: 1, humanCommits: 2, aiFileLinesAdded: 50, aiFileLinesDeleted: 5 } };
  const card = generateFeishuCard(usageStats, gitStats, 'weekly', '2026-05-12', '2026-05-18');
  assert.equal(card.config.wide_screen_mode, true);
  assert.ok(card.header.title.content.includes('周报'));
  assert.ok(card.elements.length >= 3);
  // Has fields with metrics
  const fieldsEl = card.elements.find(e => e.fields);
  assert.ok(fieldsEl);
  assert.ok(fieldsEl.fields.some(f => f.text.content.includes('交互数')));
});
test('generateWorkReport - layered attribution summary is surfaced in report text', () => {
  const usageStats = {
    requestCount: 10, totalTokens: 5000, sessionCount: 2, estimatedCost: 0.5,
    inputTokens: 2000, outputTokens: 3000, cacheRead: 0, cacheCreate: 0,
    activeDays: 1, userMessageCount: 8, subagentTokens: 0,
    projects: {}, scenarios: {}, models: {}, tools: {},
  };
  const gitStats = {
    commits: 2, filesChanged: 2, linesAdded: 100, linesDeleted: 20,
    commitList: [mkCommit({ type: 'feat', subject: 'feat: add attribution summary' })],
    attributionSummary: {
      confirmedAI: 1,
      probableAI: 0,
      possibleAI: 1,
      unknown: 0,
      human: 0,
      excluded: 0,
      confirmedAILines: 70,
      possibleAILines: 50,
      totalLinesChanged: 120,
    },
  };

  const report = generateWorkReport(usageStats, gitStats, 'daily', '2026-05-20', '2026-05-20');
  assert.ok(report.includes('确认 AI'));
  assert.ok(report.includes('可能 AI'));
});

test('generateWorkReport - shows unknown attribution reasons when present', () => {
  const usageStats = {
    requestCount: 1, totalTokens: 100, sessionCount: 1,
    inputTokens: 50, outputTokens: 50, cacheRead: 0, cacheCreate: 0,
    activeDays: 1, userMessageCount: 1, subagentTokens: 0,
    projects: {}, scenarios: {}, models: {}, tools: {},
  };
  const gitStats = {
    commits: 1, filesChanged: 1, linesAdded: 2, linesDeleted: 0,
    attributionSummary: {
      confirmedAILines: 0,
      probableAILines: 0,
      possibleAILines: 0,
      unknownLines: 2,
      totalLinesChanged: 2,
      unknownReasons: ['no_session_match'],
    },
  };

  const report = generateWorkReport(usageStats, gitStats, 'daily', '2026-05-20', '2026-05-20');
  assert.ok(report.includes('no_session_match'));
});

test('generateWorkReport - shows line attribution coverage quality', () => {
  const usageStats = {
    requestCount: 1, totalTokens: 100, sessionCount: 1,
    inputTokens: 50, outputTokens: 50, cacheRead: 0, cacheCreate: 0,
    activeDays: 1, userMessageCount: 1, subagentTokens: 0,
    projects: {}, scenarios: {}, models: {}, tools: {},
  };
  const gitStats = {
    commits: 1, filesChanged: 1, linesAdded: 6, linesDeleted: 0,
    attributionQuality: {
      totalLineBlameCommits: 1,
      mappedAddedLines: 5,
      mappableAddedLines: 6,
      lineCoverage: 5 / 6,
      unknownLines: 1,
      confidence: 'medium',
    },
  };

  const report = generateWorkReport(usageStats, gitStats, 'daily', '2026-05-20', '2026-05-20');
  assert.ok(report.includes('行级映射覆盖率 83%'));
  assert.ok(report.includes('未知 1 行'));
});

test('workReportFooter - 默认带 install 命令与 github 链接', () => {
  const f = workReportFooter();
  assert.ok(f.includes('npm i -g lumencode'));
  assert.ok(f.includes('github.com/yaowen51888-rich/lumencode'));
  assert.ok(f.startsWith('\n'));
});

test('workReportFooter - platform=dingtalk 去掉 markdown 语法', () => {
  const f = workReportFooter('dingtalk');
  assert.ok(!f.includes('**'));
  assert.ok(f.includes('npm i -g lumencode'));
});
