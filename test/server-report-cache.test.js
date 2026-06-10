import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startServer } from '../lib/server.js';
import { buildSourceHash, saveSmartReportRecord } from '../lib/smart-report-store.js';
import { generateWorkReport } from '../lib/report.js';

function waitForListening(server) {
  if (server.listening) return Promise.resolve();
  return new Promise(resolve => server.once('listening', resolve));
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
  });
}

function makeReportData() {
  return {
    usageStats: {
      requestCount: 2,
      sessionCount: 1,
      userMessageCount: 1,
      activeDays: 1,
      inputTokens: 100,
      outputTokens: 50,
      cacheRead: 0,
      cacheCreate: 0,
      totalTokens: 150,
      subagentTokens: 0,
      estimatedCost: 0,
      models: {},
      tools: {},
      scenarios: {},
      projects: {
        app: { sessions: 1, requests: 2, inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreate: 0, estimatedCost: 0, models: {} },
      },
      dailyStats: { '2026-05-28': { requests: 2, userMessages: 1, inputTokens: 100, outputTokens: 50 } },
      toolBreakdown: { claude: { inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreate: 0, count: 2 } },
    },
    gitStats: {
      commits: 1,
      filesChanged: 1,
      linesAdded: 10,
      linesDeleted: 2,
      commitList: [{
        hash: 'abc123',
        repo: 'D:/work/app',
        date: '2026-05-28T10:00:00',
        type: 'feat',
        subject: 'feat: speed up report endpoint',
        scope: null,
        linesAdded: 10,
        linesDeleted: 2,
        files: [{ path: 'lib/server.js', added: 10, deleted: 2 }],
        isAI: false,
        aiConfidence: 'none',
      }],
      aiContribution: {
        aiCommits: 0,
        possibleAICommits: 0,
        highConfidenceCommits: 0,
        mediumConfidenceCommits: 0,
        aiLinesChanged: 0,
        totalLinesChanged: 12,
        aiFileLinesAdded: 0,
        aiFileLinesDeleted: 0,
      },
      aiContributionByTool: {},
    },
    reposConfigured: true,
    sessions: [],
    start: '2026-05-28',
    end: '2026-05-28',
    trendData: { dailyStats: {} },
    prevStats: null,
    billingBlocks: [],
    toolBreakdown: { claude: { recordCount: 2, sessionCount: 1 } },
    projectDetails: {},
  };
}

test('api/report reuses base report cache across json and work formats', async () => {
  const oldNoOpen = process.env.LUMENCODE_NO_OPEN;
  const oldPort = process.env.LUMENCODE_PORT;
  process.env.LUMENCODE_NO_OPEN = '1';
  process.env.LUMENCODE_PORT = '0';

  const tempDir = mkdtempSync(join(tmpdir(), 'lumencode-report-cache-'));
  let calls = 0;
  const server = startServer(
    { claudeDir: tempDir, repos: ['D:/work/app'], enabledTools: [] },
    null,
    async () => {
      calls += 1;
      return makeReportData();
    },
    join(tempDir, 'config.json'),
  );

  try {
    await waitForListening(server);
    const port = server.address().port;

    const jsonRes = await fetch(`http://127.0.0.1:${port}/api/report?period=daily&date=2026-05-28`);
    assert.equal(jsonRes.status, 200);
    assert.equal(jsonRes.headers.get('x-cache'), 'MISS');
    await jsonRes.json();

    const workRes = await fetch(`http://127.0.0.1:${port}/api/report?period=daily&date=2026-05-28&format=work`);
    assert.equal(workRes.status, 200);
    const markdown = await workRes.text();

    assert.equal(calls, 1);
    assert.match(markdown, /speed up report endpoint/);
  } finally {
    await closeServer(server);
    rmSync(tempDir, { recursive: true, force: true });
    if (oldNoOpen === undefined) delete process.env.LUMENCODE_NO_OPEN;
    else process.env.LUMENCODE_NO_OPEN = oldNoOpen;
    if (oldPort === undefined) delete process.env.LUMENCODE_PORT;
    else process.env.LUMENCODE_PORT = oldPort;
  }
});

test('api/smart-report matches weekly records by range and marks stale sources', async () => {
  const oldNoOpen = process.env.LUMENCODE_NO_OPEN;
  const oldPort = process.env.LUMENCODE_PORT;
  process.env.LUMENCODE_NO_OPEN = '1';
  process.env.LUMENCODE_PORT = '0';

  const tempDir = mkdtempSync(join(tmpdir(), 'lumencode-smart-report-'));
  const configPath = join(tempDir, 'config.json');
  saveSmartReportRecord(join(tempDir, 'smart-reports'), {
    agent: 'codex',
    period: 'weekly',
    date: '',
    start: '2026-06-01',
    end: '2026-06-07',
    tool: 'all',
    project: '',
    level: 'detailed',
    platform: 'default',
    markdown: '# old smart report',
    sourceHash: 'old-source-hash',
  });

  const server = startServer(
    { claudeDir: tempDir, repos: [], enabledTools: [] },
    null,
    async () => ({
      ...makeReportData(),
      start: '2026-06-01',
      end: '2026-06-07',
      usageStats: {
        ...makeReportData().usageStats,
        requestCount: 5,
        totalTokens: 500,
      },
    }),
    configPath,
  );

  try {
    await waitForListening(server);
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/smart-report?agent=codex&period=weekly&date=2026-06-05&tool=all&level=detailed&platform=default`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.ok(body.record.markdown.startsWith('# old smart report'));
    assert.ok(body.record.markdown.includes('📌 **数据快照**'), '应注入快照口径块');
    assert.equal(body.record.start, '2026-06-01');
    assert.equal(body.record.end, '2026-06-07');
    assert.equal(body.needsUpdate, true);
    assert.equal(body.range.start, '2026-06-01');
    assert.equal(body.range.end, '2026-06-07');
  } finally {
    await closeServer(server);
    rmSync(tempDir, { recursive: true, force: true });
    if (oldNoOpen === undefined) delete process.env.LUMENCODE_NO_OPEN;
    else process.env.LUMENCODE_NO_OPEN = oldNoOpen;
    if (oldPort === undefined) delete process.env.LUMENCODE_PORT;
    else process.env.LUMENCODE_PORT = oldPort;
  }
});

test('api/smart-report starts generation as a background job', async () => {
  const oldNoOpen = process.env.LUMENCODE_NO_OPEN;
  const oldPort = process.env.LUMENCODE_PORT;
  process.env.LUMENCODE_NO_OPEN = '1';
  process.env.LUMENCODE_PORT = '0';

  const tempDir = mkdtempSync(join(tmpdir(), 'lumencode-smart-report-job-'));
  const server = startServer(
    { claudeDir: tempDir, repos: [], enabledTools: [] },
    null,
    async () => makeReportData(),
    join(tempDir, 'config.json'),
  );

  try {
    await waitForListening(server);
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/smart-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'unknown',
        period: 'daily',
        date: '2026-05-28',
        tool: 'all',
        level: 'detailed',
        platform: 'default',
      }),
    });
    assert.equal(res.status, 202);
    const body = await res.json();

    assert.equal(body.record, null);
    assert.equal(body.job.status, 'running');
    assert.equal(typeof body.job.id, 'string');
  } finally {
    await closeServer(server);
    rmSync(tempDir, { recursive: true, force: true });
    if (oldNoOpen === undefined) delete process.env.LUMENCODE_NO_OPEN;
    else process.env.LUMENCODE_NO_OPEN = oldNoOpen;
    if (oldPort === undefined) delete process.env.LUMENCODE_PORT;
    else process.env.LUMENCODE_PORT = oldPort;
  }
});

test('api/smart-report returns legacy cached markdown with display title', async () => {
  const oldNoOpen = process.env.LUMENCODE_NO_OPEN;
  const oldPort = process.env.LUMENCODE_PORT;
  process.env.LUMENCODE_NO_OPEN = '1';
  process.env.LUMENCODE_PORT = '0';

  const tempDir = mkdtempSync(join(tmpdir(), 'lumencode-smart-report-title-'));
  const configPath = join(tempDir, 'config.json');
  saveSmartReportRecord(join(tempDir, 'smart-reports'), {
    agent: 'codex',
    period: 'daily',
    date: '2026-05-28',
    start: '2026-05-28',
    end: '2026-05-28',
    tool: 'all',
    project: '',
    level: 'brief',
    platform: 'default',
    markdown: '## 数据摘要\nOK',
    sourceHash: 'old-source-hash',
  });

  const server = startServer(
    { claudeDir: tempDir, repos: [], enabledTools: [] },
    null,
    async () => makeReportData(),
    configPath,
  );

  try {
    await waitForListening(server);
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/smart-report?agent=codex&period=daily&date=2026-05-28&tool=all&level=brief&platform=default`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.match(body.record.markdown, /^# AI 编码助手 工作日报 - 2026-05-28\n\n> 📌 \*\*数据快照\*\*/);
    assert.match(body.record.markdown, /## 数据摘要/);
  } finally {
    await closeServer(server);
    rmSync(tempDir, { recursive: true, force: true });
    if (oldNoOpen === undefined) delete process.env.LUMENCODE_NO_OPEN;
    else process.env.LUMENCODE_NO_OPEN = oldNoOpen;
    if (oldPort === undefined) delete process.env.LUMENCODE_PORT;
    else process.env.LUMENCODE_PORT = oldPort;
  }
});

test('api/smart-report freshness ignores non-report source metadata changes', async () => {
  const oldNoOpen = process.env.LUMENCODE_NO_OPEN;
  const oldPort = process.env.LUMENCODE_PORT;
  process.env.LUMENCODE_NO_OPEN = '1';
  process.env.LUMENCODE_PORT = '0';

  const tempDir = mkdtempSync(join(tmpdir(), 'lumencode-smart-report-freshness-'));
  const configPath = join(tempDir, 'config.json');
  let extraDiagnostics = { parsedAt: 'first' };
  const server = startServer(
    { claudeDir: tempDir, repos: [], enabledTools: [] },
    null,
    async () => ({
      ...makeReportData(),
      _diagnostics: extraDiagnostics,
    }),
    configPath,
  );

  try {
    await waitForListening(server);
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/api/smart-report?agent=codex&period=daily&date=2026-05-28&tool=all&level=detailed&platform=default`;

    const firstRes = await fetch(url);
    assert.equal(firstRes.status, 200);
    const firstBody = await firstRes.json();
    assert.equal(firstBody.record, null);
    assert.equal(typeof firstBody.currentSourceHash, 'string');

    saveSmartReportRecord(join(tempDir, 'smart-reports'), {
      agent: 'codex',
      period: 'daily',
      date: '2026-05-28',
      start: '2026-05-28',
      end: '2026-05-28',
      tool: 'all',
      project: '',
      level: 'detailed',
      platform: 'default',
      markdown: '# smart report',
      sourceHash: firstBody.currentSourceHash,
    });

    extraDiagnostics = { parsedAt: 'second' };
    const secondRes = await fetch(url);
    assert.equal(secondRes.status, 200);
    const secondBody = await secondRes.json();

    assert.ok(secondBody.record.markdown.startsWith('# smart report'));
    assert.ok(secondBody.record.markdown.includes('📌 **数据快照**'), '应注入快照口径块');
    assert.equal(secondBody.needsUpdate, false);
  } finally {
    await closeServer(server);
    rmSync(tempDir, { recursive: true, force: true });
    if (oldNoOpen === undefined) delete process.env.LUMENCODE_NO_OPEN;
    else process.env.LUMENCODE_NO_OPEN = oldNoOpen;
    if (oldPort === undefined) delete process.env.LUMENCODE_PORT;
    else process.env.LUMENCODE_PORT = oldPort;
  }
});

test('api/smart-report treats legacy records with matching report hashes as fresh', async () => {
  const oldNoOpen = process.env.LUMENCODE_NO_OPEN;
  const oldPort = process.env.LUMENCODE_PORT;
  process.env.LUMENCODE_NO_OPEN = '1';
  process.env.LUMENCODE_PORT = '0';

  const tempDir = mkdtempSync(join(tmpdir(), 'lumencode-smart-report-legacy-fresh-'));
  const configPath = join(tempDir, 'config.json');
  const data = makeReportData();
  const detailedMarkdown = generateWorkReport(data.usageStats, data.gitStats, 'daily', data.start, data.end, data.prevStats, {
    level: 'detailed',
    platform: 'default',
    tool: 'all',
    projectName: '',
  });
  const briefMarkdown = generateWorkReport(data.usageStats, data.gitStats, 'daily', data.start, data.end, data.prevStats, {
    level: 'brief',
    platform: 'default',
    tool: 'all',
    projectName: '',
  });
  saveSmartReportRecord(join(tempDir, 'smart-reports'), {
    agent: 'codex',
    period: 'daily',
    date: '2026-05-28',
    start: '2026-05-28',
    end: '2026-05-28',
    tool: 'all',
    project: '',
    level: 'detailed',
    platform: 'default',
    markdown: '# legacy smart report',
    sourceHash: 'legacy-full-report-data-hash',
    sourceReports: {
      detailedHash: buildSourceHash(detailedMarkdown),
      briefHash: buildSourceHash(briefMarkdown),
      bossHash: '',
    },
  });

  const server = startServer(
    { claudeDir: tempDir, repos: [], enabledTools: [] },
    null,
    async () => data,
    configPath,
  );

  try {
    await waitForListening(server);
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/smart-report?agent=codex&period=daily&date=2026-05-28&tool=all&level=detailed&platform=default`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.ok(body.record.markdown.startsWith('# legacy smart report'));
    assert.ok(body.record.markdown.includes('📌 **数据快照**'), '应注入快照口径块');
    assert.equal(body.needsUpdate, false);
  } finally {
    await closeServer(server);
    rmSync(tempDir, { recursive: true, force: true });
    if (oldNoOpen === undefined) delete process.env.LUMENCODE_NO_OPEN;
    else process.env.LUMENCODE_NO_OPEN = oldNoOpen;
    if (oldPort === undefined) delete process.env.LUMENCODE_PORT;
    else process.env.LUMENCODE_PORT = oldPort;
  }
});
