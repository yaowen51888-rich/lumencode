import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSmartReportContext,
  buildSmartReportPrompt,
  buildAgentSpawnInvocation,
  buildAgentLookupInvocation,
  stripCostFromBossMarkdown,
  buildAgentFailureDetail,
  killAgentProcessTree,
  checkAgentAvailable,
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
  assert.ok(prompt.includes('## 核心功能交付'));
  assert.ok(prompt.includes('## 工作亮点'));
  assert.ok(prompt.includes('## 进展与价值'));
  assert.ok(prompt.includes('## 风险与跟进'));
  assert.ok(!prompt.includes('## 本期投入'), '管理汇报不应再含本期投入章节');
  assert.ok(!prompt.includes('## 下一步计划'));
  assert.ok(prompt.includes('bossMarkdown'));
  assert.ok(prompt.includes('Boss Source Marker'));
});

test('stripCostFromBossMarkdown removes cost section/phrase and passes through clean text', () => {
  // 无费用文本应原样透传
  assert.equal(stripCostFromBossMarkdown('# Boss Source Marker'), '# Boss Source Marker');

  const boss = [
    '# 工作周报',
    '',
    '## 工作成果概述',
    '本期完成多项功能开发。',
    '',
    '## 工作对比',
    '相比上周，工作强度提升 15%，投入随工作量同步增长。',
    '',
    '## 技术工具投入',
    '本期技术工具投入约 **$120**（日均 $30）。',
    '按工作日折算，月度工具预算约 $660。',
    '',
  ].join('\n');
  const stripped = stripCostFromBossMarkdown(boss);

  assert.ok(!stripped.includes('技术工具投入'), '应移除费用章节标题');
  assert.ok(!stripped.includes('$120'), '应移除金额');
  assert.ok(!stripped.includes('月度工具预算'), '应移除月度预算');
  assert.ok(!stripped.includes('投入随工作量同步增长'), '应移除费用环比短语');
  assert.ok(stripped.includes('## 工作成果概述'), '应保留其他章节');
  assert.ok(stripped.includes('## 工作对比'), '应保留对比章节');
  assert.ok(stripped.includes('工作强度提升 15'), '应保留对比章节中的非费用内容');
});

test('workhorse context strips cost from bossMarkdown while default retains it', () => {
  const sourceReports = {
    detailedMarkdown: '# Detailed',
    bossMarkdown: '# Boss\n\n## 技术工具投入\n投入 $120。\n\n## 工作成果\nOK',
  };
  const workhorse = buildSmartReportContext(reportData, '# Work', {
    period: 'weekly', style: 'workhorse', sourceReports,
  });
  const def = buildSmartReportContext(reportData, '# Work', {
    period: 'weekly', style: 'default', sourceReports,
  });

  assert.ok(!workhorse.sourceReports.bossMarkdown.includes('技术工具投入'), 'workhorse 应剥离费用章');
  assert.ok(!workhorse.sourceReports.bossMarkdown.includes('$120'), 'workhorse 应剥离金额');
  assert.ok(workhorse.sourceReports.bossMarkdown.includes('## 工作成果'), 'workhorse 应保留其他章');
  assert.ok(def.sourceReports.bossMarkdown.includes('技术工具投入'), 'default 应保留费用章');
  assert.ok(def.sourceReports.bossMarkdown.includes('$120'), 'default 应保留金额');
});

test('workhorse prompt bans cost and requires concrete feature extraction', () => {
  const context = buildSmartReportContext(reportData, '# Work', { period: 'weekly', style: 'workhorse' });
  const prompt = buildSmartReportPrompt(context);

  assert.ok(prompt.includes('不得体现任何费用'), '应禁止费用表达');
  assert.ok(prompt.includes('commitList'), '应引导基于 commitList 提炼');
  assert.ok(prompt.includes('具体业务功能点'), '应要求提炼具体业务功能点');
  assert.ok(prompt.includes('数据不足'), '应有数据不足兜底');
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
  // 简单参数不加引号，含空格的参数才加
  assert.equal(invocation.args[3], 'claude --version');
});

test('buildAgentSpawnInvocation quotes args with spaces on Windows', () => {
  const invocation = buildAgentSpawnInvocation(getAgentDefinition('claude'), ['--print', 'hello world'], 'win32');

  assert.equal(invocation.command, 'cmd.exe');
  assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(invocation.args[3], 'claude --print "hello world"');
});

test('codex agent skips git repo check for non-interactive generation', () => {
  // 后台 spawn 无法交互式信任目录，缺此 flag codex exec 会直接报错拒绝运行
  assert.ok(
    getAgentDefinition('codex').args.includes('--skip-git-repo-check'),
    'codex exec 必须带 --skip-git-repo-check'
  );
});

test('buildAgentSpawnInvocation keeps direct spawn on non-Windows platforms', () => {
  const invocation = buildAgentSpawnInvocation(getAgentDefinition('codex'), ['exec', '-'], 'linux');

  assert.equal(invocation.command, 'codex');
  assert.deepEqual(invocation.args, ['exec', '-']);
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

  assert.ok(markdown.startsWith('# 智能报告\n\n> 📌 **数据快照**'));
  assert.ok(markdown.includes('## 数据摘要\nOK'));
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

  assert.ok(markdown.startsWith('# AI 编码助手 工作周报 - 2026-06-01 ~ 2026-06-04\n\n> 📌 **数据快照**'));
  assert.ok(markdown.includes('## 数据摘要'));
});

test('createSmartReport warns but returns markdown that fails quality validation', async () => {
  const markdown = await createSmartReport({
    agent: 'codex',
    reportData,
    workMarkdown: '# Work report',
    options: { period: 'weekly', level: 'brief' },
    runner: async () => '# 智能简报\n\n## 数据摘要\n本期 ROI 提升。',
  });

  assert.ok(markdown.includes('本期 ROI 提升'));
  assert.ok(markdown.includes('⚠️ 报告质量提示'));
  assert.ok(markdown.includes('ROI'));
});

test('validateSmartReportMarkdown excludes negated context', () => {
  const fullSections = '\n\n## 工作亮点分析\nOK\n\n## 关键洞察\nOK\n\n## 异常与风险\nOK\n\n## 管理建议\nOK\n\n## 下一步关注点\nOK';

  // 否定语境应视为合规
  const negated = validateSmartReportMarkdown(
    '# 报告\n\n## 数据摘要\n不应计算 ROI，缺乏数据支撑。' + fullSections,
    { meta: { style: 'default', level: 'detailed' } }
  );
  assert.equal(negated.length, 0, '否定语境不应触发警告: ' + JSON.stringify(negated));

  // 肯定语境应触发警告
  const affirmative = validateSmartReportMarkdown(
    '# 报告\n\n## 数据摘要\n本期 ROI 提升 20%，节省 5 小时。' + fullSections,
    { meta: { style: 'default', level: 'detailed' } }
  );
  assert.ok(affirmative.some(w => w.includes('ROI')), '应检测到 ROI');
  assert.ok(affirmative.some(w => w.includes('节省时长')), '应检测到节省时长');
});

test('normalizeSmartReportMarkdown keeps existing h1 unchanged', () => {
  const markdown = '# 自定义智能简报\n\n## 数据摘要\nOK';

  assert.equal(normalizeSmartReportMarkdown(markdown, { workReportMarkdown: '# Source title' }), markdown);
});

test('normalizeSmartReportMarkdown injects data snapshot block after h1', () => {
  const context = buildSmartReportContext(reportData, '# Work report', {
    period: 'weekly',
    level: 'detailed',
    style: 'workhorse',
    tool: 'all',
    generatedAt: '2026-06-10T09:30:00.000Z',
  });
  const out = normalizeSmartReportMarkdown('# 智能报告\n\n## 数据摘要\nOK', context);

  assert.ok(out.includes('📌 **数据快照**'), '应注入快照块');
  assert.ok(out.includes('周期 周报'), '应含周期口径');
  assert.ok(out.includes('范围 2026-06-01 ~ 2026-06-04'), '应含数据范围');
  assert.ok(out.includes('详细/管理汇报'), '应含 level/style 口径');
  assert.ok(/生成于 2026-06-10 \d{2}:\d{2}/.test(out), '应含生成时点');
  // H1 仍在最前，快照块紧随其后
  assert.ok(out.startsWith('# 智能报告\n\n> 📌 **数据快照**'));
});

test('normalizeSmartReportMarkdown snapshot injection is idempotent', () => {
  const context = buildSmartReportContext(reportData, '# Work report', {
    period: 'weekly',
    generatedAt: '2026-06-10T09:30:00.000Z',
  });
  const once = normalizeSmartReportMarkdown('# 智能报告\n\n## 数据摘要\nOK', context);
  const twice = normalizeSmartReportMarkdown(once, context);

  assert.equal(twice, once, '重复归一化不应再次注入快照块');
  assert.equal((twice.match(/📌 \*\*数据快照\*\*/g) || []).length, 1);
});

test('normalizeSmartReportMarkdown skips snapshot without period or generatedAt', () => {
  const markdown = '## 数据摘要\nOK';
  const out = normalizeSmartReportMarkdown(markdown, { workReportMarkdown: '# Source title' });

  assert.ok(out.startsWith('# Source title\n\n## 数据摘要'));
  assert.ok(!out.includes('📌 **数据快照**'), '无周期/时点时不应注入快照块');
});

test('buildSmartReportPrompt enforces extrapolation uncertainty', () => {
  const context = buildSmartReportContext(reportData, '# Work report', { period: 'weekly', style: 'workhorse' });
  const prompt = buildSmartReportPrompt(context);

  assert.ok(prompt.includes('月化'), '应提及外推类指标');
  assert.ok(prompt.includes('不确定性说明'), '应要求标注不确定性');
  assert.ok(prompt.includes('面向领导汇报'), 'workhorse 应有领导汇报硬约束');
});

test('buildAgentFailureDetail surfaces stdout error when stderr is empty', () => {
  // claude --print 把 API 错误写到 stdout、stderr 为空时，应取 stdout，避免无信息的 "exit 1"
  assert.equal(
    buildAgentFailureDetail('', 'API Error: 529 该模型当前访问量过大', 1),
    'API Error: 529 该模型当前访问量过大',
  );
  // stderr 优先
  assert.equal(buildAgentFailureDetail('some stderr', 'stdout content', 1), 'some stderr');
  // 都为空时回退退出码
  assert.equal(buildAgentFailureDetail('', '', 1), 'exit 1');
  // stdout 很长时只取尾部 500 字符（错误信息通常在末尾）
  const longStdout = 'x'.repeat(600) + 'API Error: 529 overflow';
  const detail = buildAgentFailureDetail('', longStdout, 1);
  assert.ok(detail.endsWith('API Error: 529 overflow'), '应取 stdout 尾部');
  assert.ok(detail.length <= 500, '应截断到 500 字符内');
});

test('validateSmartReportMarkdown flags extrapolation without uncertainty hint', () => {
  const fullSections = '\n\n## 工作亮点分析\nOK\n\n## 关键洞察\nOK\n\n## 风险与建议\nOK';
  const warnings = validateSmartReportMarkdown(
    '# 报告\n\n## 数据摘要\n月度预估约 $2,139，费用高度集中。' + fullSections,
    { meta: { style: 'default', level: 'brief' } }
  );

  assert.ok(warnings.some(w => w.includes('外推')), '裸奔外推值应告警: ' + JSON.stringify(warnings));
});

test('validateSmartReportMarkdown accepts extrapolation with uncertainty hint', () => {
  const fullSections = '\n\n## 工作亮点分析\nOK\n\n## 关键洞察\nOK\n\n## 风险与建议\nOK';
  const warnings = validateSmartReportMarkdown(
    '# 报告\n\n## 数据摘要\n月度预估约 $2,139（基于 2 个活跃日外推，实际值可能有较大偏差）。' + fullSections,
    { meta: { style: 'default', level: 'brief' } }
  );

  assert.ok(!warnings.some(w => w.includes('外推')), '带依据的外推不应告警: ' + JSON.stringify(warnings));
});

test('validateSmartReportMarkdown flags bare 外推 value (no self-exemption from the word 外推)', () => {
  const fullSections = '\n\n## 工作亮点分析\nOK\n\n## 关键洞察\nOK\n\n## 风险与建议\nOK';
  // 裸奔值含"外推"二字，但无活跃日依据/偏差说明——不得因指标词本身被豁免
  const warnings = validateSmartReportMarkdown(
    '# 报告\n\n## 数据摘要\n月度外推 $2,760，成本压力显著。' + fullSections,
    { meta: { style: 'workhorse', level: 'detailed' } }
  );

  assert.ok(warnings.some(w => w.includes('外推')), '含"外推"的裸奔值仍应告警: ' + JSON.stringify(warnings));
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

test('checkAgentAvailable retries transient probe failures and returns first success', async () => {
  const calls = [];
  const result = await checkAgentAvailable(
    { name: 'claude', displayName: 'Claude Code', command: 'claude' },
    {
      retry: 2,
      retryDelay: 0,
      probe: async () => {
        calls.push(1);
        if (calls.length < 2) return { detected: false, error: 'exit 1' };
        return { detected: true, version: 'claude 1.0.0' };
      },
    },
  );

  assert.equal(result.detected, true);
  assert.equal(result.version, 'claude 1.0.0');
  assert.equal(calls.length, 2, '首次失败后应重试一次即成功');
});

test('checkAgentAvailable returns last failure and warns when all retries exhausted', async () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(msg);

  try {
    const result = await checkAgentAvailable(
      { name: 'codex', displayName: 'Codex', command: 'codex' },
      {
        retry: 1,
        retryDelay: 0,
        probe: async () => ({ detected: false, error: 'version check timeout' }),
      },
    );

    assert.equal(result.detected, false);
    assert.equal(result.error, 'version check timeout');
    assert.ok(
      warnings.some(w => String(w).includes('codex') && String(w).includes('version check timeout')),
      '最终失败应打印诊断 warn: ' + JSON.stringify(warnings),
    );
  } finally {
    console.warn = originalWarn;
  }
});

test('killAgentProcessTree kills whole process group on unix via negative pid', () => {
  const killed = [];
  killAgentProcessTree({ pid: 1234 }, 'linux', { kill: (pid, sig) => killed.push([pid, sig]) });
  // 负 pid 杀整个进程组（含 npm shim 下的孙进程）
  assert.deepEqual(killed, [[-1234, 'SIGTERM']]);
});

test('killAgentProcessTree invokes taskkill /T /F on windows', () => {
  let spawnCall = null;
  const fakeSpawn = (cmd, args) => {
    spawnCall = [cmd, args];
    return { on: () => {} };
  };
  killAgentProcessTree({ pid: 1234 }, 'win32', { spawn: fakeSpawn });
  assert.equal(spawnCall[0], 'taskkill');
  assert.deepEqual(spawnCall[1], ['/pid', '1234', '/T', '/F']);
});
