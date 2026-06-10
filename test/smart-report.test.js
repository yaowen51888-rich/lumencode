import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSmartReportContext,
  buildSmartReportPrompt,
  buildAgentSpawnInvocation,
  buildAgentLookupInvocation,
  createSmartReport,
  getAgentDefinition,
  normalizeSmartReportMarkdown,
  validateSmartReportMarkdown,
  SMART_REPORT_PROMPT_MARKER,
} from '../lib/smart-report.js';

const reportData = {
  start: '2026-06-01',
  end: '2026-06-04',
  usageStats: {
    requestCount: 42,
    totalTokens: 123456,
    estimatedCost: 3.21,
    projects: {
      'D:/work/app': { requests: 30, sessions: 4, secret: 'remove-me' },
    },
    models: {
      'claude-sonnet-4': { count: 20, inputTokens: 1000, outputTokens: 2000, privateLog: 'remove-me' },
    },
    scenarios: { coding: 10, debugging: 5 },
    tools: { Edit: { calls: 5, uses: 3 } },
    rawRecords: [{ text: 'remove-me' }],
  },
  gitStats: {
    commits: 3,
    linesAdded: 120,
    linesDeleted: 25,
    filesChanged: 8,
    aiContribution: {
      aiLinesChanged: 60,
      totalLinesChanged: 145,
      weightedAILineRatio: 0.42,
    },
    commitList: [
      {
        subject: 'feat: add dashboard',
        repo: 'D:/work/app',
        files: [
          { path: 'src/app.js', added: 80, deleted: 10, patch: 'remove-me' },
        ],
        body: 'remove-me',
      },
    ],
  },
  trendData: {
    dailyStats: {
      '2026-06-01': { requests: 10, totalTokens: 20000 },
    },
  },
  costBreakdown: {
    total: 3.21,
    cacheSaving: 0.4,
    models: [{ name: 'claude-sonnet-4', cost: 2.5, requests: 20 }],
  },
  privateRecords: [{ text: 'remove-me' }],
};

test('buildSmartReportContext keeps only bounded report dimensions', () => {
  const context = buildSmartReportContext(reportData, '# Work report', {
    period: 'weekly',
    date: '2026-06-04',
    tool: 'all',
    project: '',
    level: 'detailed',
    platform: 'default',
  });

  assert.equal(context.meta.period, 'weekly');
  assert.equal(context.meta.start, '2026-06-01');
  assert.equal(context.meta.end, '2026-06-04');
  assert.equal(context.workReportMarkdown, '# Work report');
  assert.deepEqual(context.usage.projects, {
    'D:/work/app': { requests: 30, sessions: 4 },
  });
  assert.deepEqual(context.usage.models, {
    'claude-sonnet-4': { count: 20, inputTokens: 1000, outputTokens: 2000 },
  });
  assert.equal(context.git.commitList[0].subject, 'feat: add dashboard');

  const serialized = JSON.stringify(context);
  assert.ok(!serialized.includes('remove-me'));
  assert.ok(!serialized.includes('patch'));
  assert.ok(!serialized.includes('rawRecords'));
});

test('buildSmartReportPrompt restricts AI to provided data analysis', () => {
  const context = buildSmartReportContext(reportData, '# Work report', { period: 'weekly' });
  const prompt = buildSmartReportPrompt(context);

  assert.ok(prompt.startsWith(SMART_REPORT_PROMPT_MARKER));
  assert.ok(prompt.includes('只能基于下面提供的数据'));
  assert.ok(prompt.includes('不得读取源码'));
  assert.ok(prompt.includes('不得联网'));
  assert.ok(prompt.includes('数据不足'));
  assert.ok(prompt.includes('关键洞察'));
  assert.ok(prompt.includes('工作亮点分析'));
  assert.ok(prompt.includes('"requestCount": 42'));
});

test('workhorse style excludes cost fields from context', () => {
  const context = buildSmartReportContext(reportData, '# Work report', { period: 'weekly', style: 'workhorse' });
  const serialized = JSON.stringify(context);

  assert.equal(context.usage.estimatedCost, undefined);
  assert.equal(context.costBreakdown, null);
  assert.ok(!serialized.includes('"cost":'));
  assert.ok(!serialized.includes('"costMode":'));
});

test('default style keeps cost fields in context', () => {
  const context = buildSmartReportContext(reportData, '# Work report', { period: 'weekly', style: 'default' });

  assert.equal(context.usage.estimatedCost, 3.21);
  assert.ok(JSON.stringify(context).includes('"cost":'));
});

test('brief smart report prompt includes detailed and brief source reports', () => {
  const context = buildSmartReportContext(reportData, '# Brief selected', {
    period: 'weekly',
    level: 'brief',
    sourceReports: {
      detailedMarkdown: '# Detailed Source Marker',
      briefMarkdown: '# Brief Source Marker',
    },
  });
  const prompt = buildSmartReportPrompt(context);

  assert.equal(context.meta.level, 'brief');
  assert.equal(context.sourceReports.detailedMarkdown, '# Detailed Source Marker');
  assert.equal(context.sourceReports.briefMarkdown, '# Brief Source Marker');
  assert.ok(prompt.includes('detailedMarkdown'));
  assert.ok(prompt.includes('briefMarkdown'));
  assert.ok(prompt.includes('Detailed Source Marker'));
  assert.ok(prompt.includes('Brief Source Marker'));
  assert.ok(prompt.includes('工作亮点分析'));
  assert.ok(prompt.includes('必须以一级标题'));
});

test('workhorse smart report prompt uses boss source as leadership report style', () => {
  const context = buildSmartReportContext(reportData, '# Detailed selected', {
    period: 'weekly',
    level: 'detailed',
    style: 'workhorse',
    sourceReports: {
      detailedMarkdown: '# Detailed Source Marker',
      briefMarkdown: '# Brief Source Marker',
      bossMarkdown: '# Boss Source Marker',
    },
  });
  const prompt = buildSmartReportPrompt(context);

  assert.equal(context.meta.style, 'workhorse');
  assert.equal(context.sourceReports.bossMarkdown, '# Boss Source Marker');
  assert.ok(prompt.includes('管理汇报'));
  assert.ok(prompt.includes('面向领导汇报'));
  assert.ok(prompt.includes('必须使用以下章节'));
  assert.ok(prompt.includes('## 本期投入'));
  assert.ok(prompt.includes('## 核心产出'));
  assert.ok(prompt.includes('## 进展价值'));
  assert.ok(prompt.includes('## 风险处理'));
  assert.ok(prompt.includes('## 下一步计划'));
  assert.ok(prompt.includes('bossMarkdown'));
  assert.ok(prompt.includes('Boss Source Marker'));
});

test('validateSmartReportMarkdown flags missing required sections', () => {
  const context = buildSmartReportContext(reportData, '# Work report', { level: 'brief', style: 'default' });
  const warnings = validateSmartReportMarkdown('# 智能简报\n\n## 数据摘要\nOK', context);

  assert.deepEqual(warnings, [
    '缺少必需章节：工作亮点分析、关键洞察、风险与建议',
  ]);
});

test('validateSmartReportMarkdown flags unsupported inflated claims', () => {
  const context = buildSmartReportContext(reportData, '# Work report', { level: 'brief', style: 'default' });
  const warnings = validateSmartReportMarkdown([
    '# 智能简报',
    '',
    '## 数据摘要',
    '本期 ROI 显著提升。',
    '',
    '## 工作亮点分析',
    'OK',
    '',
    '## 关键洞察',
    'OK',
    '',
    '## 风险与建议',
    'OK',
  ].join('\n'), context);

  assert.deepEqual(warnings, [
    '包含无数据支撑的夸大表达：ROI',
  ]);
});

test('getAgentDefinition only accepts known local agents', () => {
  assert.equal(getAgentDefinition('claude').command, 'claude');
  assert.equal(getAgentDefinition('codex').command, 'codex');
  assert.equal(getAgentDefinition('opencode').command, 'opencode');
  assert.equal(getAgentDefinition('rm -rf /'), null);
});

test('buildAgentSpawnInvocation uses cmd.exe on Windows for npm command shims', () => {
  const invocation = buildAgentSpawnInvocation(getAgentDefinition('claude'), ['--version'], 'win32');

  assert.equal(invocation.command, 'cmd.exe');
  assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(invocation.args[3], 'claude "--version"');
});

test('buildAgentSpawnInvocation keeps direct spawn on non-Windows platforms', () => {
  const invocation = buildAgentSpawnInvocation(getAgentDefinition('codex'), ['--version'], 'linux');

  assert.equal(invocation.command, 'codex');
  assert.deepEqual(invocation.args, ['--version']);
});

test('Codex passes prompt as argument instead of stdin', () => {
  const def = getAgentDefinition('codex');
  assert.equal(def.promptAsArg, true);
  const invocation = buildAgentSpawnInvocation(def, [...def.args, 'test prompt'], 'linux');
  assert.equal(invocation.command, 'codex');
  assert.deepEqual(invocation.args, ['test prompt']);
});

test('buildAgentLookupInvocation checks command resolution without running the agent on Windows', () => {
  const invocation = buildAgentLookupInvocation(getAgentDefinition('claude'), 'win32');

  assert.equal(invocation.command, 'where.exe');
  assert.deepEqual(invocation.args, ['claude']);
});

test('buildAgentLookupInvocation checks command resolution without running the agent on Unix', () => {
  const invocation = buildAgentLookupInvocation(getAgentDefinition('codex'), 'linux');

  assert.equal(invocation.command, 'sh');
  assert.deepEqual(invocation.args, ['-lc', 'command -v codex']);
});

test('createSmartReport passes bounded prompt to selected runner', async () => {
  let captured = null;
  const markdown = await createSmartReport({
    agent: 'codex',
    reportData,
    workMarkdown: '# Work report',
    options: { period: 'weekly' },
    runner: async (definition, prompt) => {
      captured = { definition, prompt };
      return [
        '# 智能报告',
        '',
        '## 数据摘要',
        'OK',
        '',
        '## 工作亮点分析',
        'OK',
        '',
        '## 关键洞察',
        'OK',
        '',
        '## 异常与风险',
        'OK',
        '',
        '## 管理建议',
        'OK',
        '',
        '## 下一步关注点',
        'OK',
      ].join('\n');
    },
  });

  assert.ok(markdown.startsWith('# 智能报告\n\n## 数据摘要\nOK'));
  assert.equal(captured.definition.name, 'codex');
  assert.ok(captured.prompt.includes('"requestCount": 42'));
  assert.ok(!captured.prompt.includes('remove-me'));
});

test('createSmartReport prepends source report title when agent omits h1', async () => {
  const markdown = await createSmartReport({
    agent: 'codex',
    reportData,
    workMarkdown: '# AI 编码助手 工作周报 - 2026-06-01 ~ 2026-06-04\n\n## 核心指标\nOK',
    options: { period: 'weekly', level: 'brief' },
    runner: async () => [
      '## 数据摘要',
      'OK',
      '',
      '## 工作亮点分析',
      'OK',
      '',
      '## 关键洞察',
      'OK',
      '',
      '## 风险与建议',
      'OK',
    ].join('\n'),
  });

  assert.ok(markdown.startsWith('# AI 编码助手 工作周报 - 2026-06-01 ~ 2026-06-04\n\n## 数据摘要'));
});

test('createSmartReport rejects markdown that fails quality validation', async () => {
  await assert.rejects(
    createSmartReport({
      agent: 'codex',
      reportData,
      workMarkdown: '# Work report',
      options: { period: 'weekly', level: 'brief' },
      runner: async () => '# 智能简报\n\n## 数据摘要\n本期 ROI 提升。',
    }),
    /智能报告质量校验未通过/,
  );
});

test('normalizeSmartReportMarkdown keeps existing h1 unchanged', () => {
  const markdown = '# 自定义智能简报\n\n## 数据摘要\nOK';

  assert.equal(normalizeSmartReportMarkdown(markdown, { workReportMarkdown: '# Source title' }), markdown);
});

test('createSmartReport rejects unsupported agents before running CLI', async () => {
  let called = false;

  await assert.rejects(
    createSmartReport({
      agent: 'unknown',
      reportData,
      workMarkdown: '# Work report',
      runner: async () => {
        called = true;
        return '';
      },
    }),
    /Unsupported smart report agent/,
  );

  assert.equal(called, false);
});

test('createSmartReport rejects unavailable agents before running CLI when required', async () => {
  let called = false;

  await assert.rejects(
    createSmartReport({
      agent: 'claude',
      reportData,
      workMarkdown: '# Work report',
      requireAvailable: true,
      availabilityChecker: async () => ({ detected: false, error: 'spawn claude ENOENT' }),
      runner: async () => {
        called = true;
        return '';
      },
    }),
    /Claude Code 未检测到/,
  );

  assert.equal(called, false);
});
