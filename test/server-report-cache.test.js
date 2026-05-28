import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startServer } from '../lib/server.js';

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
