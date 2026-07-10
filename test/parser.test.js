import { test } from 'node:test';
import { strictEqual, deepStrictEqual, throws } from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { parseJsonlFile, deriveProjectPaths } from '../lib/parser.js';
import { ClaudeParser } from '../lib/parsers/claude.js';

const testDir = join(process.cwd(), 'test', '__tmp_parser__');

function setupTestDir() {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch (e) {
    // Directory might not exist
  }
  mkdirSync(testDir, { recursive: true });
}

function cleanupTestDir() {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch (e) {
    // Ignore cleanup errors
  }
}

function createTestFile(filename, content) {
  const filePath = join(testDir, filename);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function normalizePath(value) {
  return value.replace(/\\/g, '/').replace(/\/$/, '');
}

function expectedRecord(overrides = {}) {
  return {
    type: '',
    role: '',
    timestamp: '',
    model: '',
    text: '',
    toolCalls: [],
    sessionId: '',
    cwd: '',
    gitBranch: '',
    project: '',
    tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    isSidechain: false,
    isSubagent: false,
    messageId: '',
    requestId: '',
    costUSD: null,
    isApiError: false,
    speed: 'standard',
    ...overrides,
  };
}

test('parseJsonlFile - 解析用户和助手消息', () => {
  setupTestDir();

  const testData = `{"type": "user", "message": {"role": "user", "content": "Hello there", "model": "gpt-4"}, "timestamp": "2024-01-01T00:00:00Z", "sessionId": "session1", "usage": {"input_tokens": 10, "output_tokens": 5}}
{"type": "assistant", "message": {"role": "assistant", "content": "Hello! How can I help you?", "model": "gpt-4"}, "timestamp": "2024-01-01T00:00:01Z", "sessionId": "session1", "usage": {"input_tokens": 5, "output_tokens": 10}}
`;

  const filePath = createTestFile('test.jsonl', testData);
  const result = parseJsonlFile(filePath);

  deepStrictEqual(result, [
    {
      type: 'user',
      role: 'user',
      timestamp: '2024-01-01T00:00:00Z',
      model: 'gpt-4',
      text: 'Hello there',
      toolCalls: [],
      sessionId: 'session1',
      cwd: '',
      gitBranch: '',
      project: '',
      tokens: {
        input: 10,
        output: 5,
        cacheCreate: 0,
        cacheRead: 0,
      },
      isSidechain: false,
      isSubagent: false,
      messageId: '',
      requestId: '',
      costUSD: null,
      isApiError: false,
      speed: 'standard',
    },
    {
      type: 'assistant',
      role: 'assistant',
      timestamp: '2024-01-01T00:00:01Z',
      model: 'gpt-4',
      text: 'Hello! How can I help you?',
      toolCalls: [],
      sessionId: 'session1',
      cwd: '',
      gitBranch: '',
      project: '',
      tokens: {
        input: 5,
        output: 10,
        cacheCreate: 0,
        cacheRead: 0,
      },
      isSidechain: false,
      isSubagent: false,
      messageId: '',
      requestId: '',
      costUSD: null,
      isApiError: false,
      speed: 'standard',
    },
  ]);

  cleanupTestDir();
});

test('parseJsonlFile - 空文件返回空数组', () => {
  setupTestDir();

  const filePath = createTestFile('empty.jsonl', '');
  const result = parseJsonlFile(filePath);

  strictEqual(result.length, 0);

  cleanupTestDir();
});

test('parseJsonlFile - 损坏JSON行被跳过', () => {
  setupTestDir();

  const testData = `{"type": "user", "message": {"content": "valid"}}
{"type": "invalid json line"
{"type": "assistant", "message": {"content": "another valid"}}
{"type": "user", "message": {"content": "also valid"}}
`;

  const filePath = createTestFile('corrupt.jsonl', testData);
  const result = parseJsonlFile(filePath);

  deepStrictEqual(result, [
    {
      type: 'user',
      role: '',
      timestamp: '',
      model: '',
      text: 'valid',
      toolCalls: [],
      sessionId: '',
      cwd: '',
      gitBranch: '',
      project: '',
      tokens: {
        input: 0,
        output: 0,
        cacheCreate: 0,
        cacheRead: 0,
      },
      isSidechain: false,
      isSubagent: false,
      messageId: '',
      requestId: '',
      costUSD: null,
      isApiError: false,
      speed: 'standard',
    },
    {
      type: 'assistant',
      role: '',
      timestamp: '',
      model: '',
      text: 'another valid',
      toolCalls: [],
      sessionId: '',
      cwd: '',
      gitBranch: '',
      project: '',
      tokens: {
        input: 0,
        output: 0,
        cacheCreate: 0,
        cacheRead: 0,
      },
      isSidechain: false,
      isSubagent: false,
      messageId: '',
      requestId: '',
      costUSD: null,
      isApiError: false,
      speed: 'standard',
    },
    {
      type: 'user',
      role: '',
      timestamp: '',
      model: '',
      text: 'also valid',
      toolCalls: [],
      sessionId: '',
      cwd: '',
      gitBranch: '',
      project: '',
      tokens: {
        input: 0,
        output: 0,
        cacheCreate: 0,
        cacheRead: 0,
      },
      isSidechain: false,
      isSubagent: false,
      messageId: '',
      requestId: '',
      costUSD: null,
      isApiError: false,
      speed: 'standard',
    },
  ]);

  cleanupTestDir();
});

test('parseJsonlFile - Content数组带tool_use被正确解析', () => {
  setupTestDir();

  const testData = `{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Let me help you with that"}, {"type": "tool_use", "name": "calculator", "input": {"expression": "2+2"}}], "model": "gpt-4"}, "sessionId": "session1", "usage": {"input_tokens": 15, "output_tokens": 20}}
`;

  const filePath = createTestFile('tool_calls.jsonl', testData);
  const result = parseJsonlFile(filePath);

  deepStrictEqual(result, [
    {
      type: 'assistant',
      role: 'assistant',
      timestamp: '',
      model: 'gpt-4',
      text: 'Let me help you with that',
      toolCalls: [
        {
          name: 'calculator',
          input: { expression: '2+2' }
        }
      ],
      sessionId: 'session1',
      cwd: '',
      gitBranch: '',
      project: '',
      tokens: {
        input: 15,
        output: 20,
        cacheCreate: 0,
        cacheRead: 0,
      },
      isSidechain: false,
      isSubagent: false,
      messageId: '',
      requestId: '',
      costUSD: null,
      isApiError: false,
      speed: 'standard',
    },
  ]);

  cleanupTestDir();
});

test('parseJsonlFile - 系统类型消息被忽略', () => {
  setupTestDir();

  const testData = `{"type": "system", "message": {"content": "System message", "role": "system"}, "usage": {"input_tokens": 5, "output_tokens": 0}}
{"type": "user", "message": {"content": "User message"}, "usage": {"input_tokens": 10, "output_tokens": 5}}
{"type": "system", "message": {"content": "Another system"}, "usage": {"input_tokens": 3, "output_tokens": 2}}
{"type": "assistant", "message": {"content": "Assistant response"}, "usage": {"input_tokens": 8, "output_tokens": 12}}
`;

  const filePath = createTestFile('system_messages.jsonl', testData);
  const result = parseJsonlFile(filePath);

  deepStrictEqual(result, [
    {
      type: 'user',
      role: '',
      timestamp: '',
      model: '',
      text: 'User message',
      toolCalls: [],
      sessionId: '',
      cwd: '',
      gitBranch: '',
      project: '',
      tokens: {
        input: 10,
        output: 5,
        cacheCreate: 0,
        cacheRead: 0,
      },
      isSidechain: false,
      isSubagent: false,
      messageId: '',
      requestId: '',
      costUSD: null,
      isApiError: false,
      speed: 'standard',
    },
    {
      type: 'assistant',
      role: '',
      timestamp: '',
      model: '',
      text: 'Assistant response',
      toolCalls: [],
      sessionId: '',
      cwd: '',
      gitBranch: '',
      project: '',
      tokens: {
        input: 8,
        output: 12,
        cacheCreate: 0,
        cacheRead: 0,
      },
      isSidechain: false,
      isSubagent: false,
      messageId: '',
      requestId: '',
      costUSD: null,
      isApiError: false,
      speed: 'standard',
    },
  ]);

  cleanupTestDir();
});

test('deriveProjectPaths - 同一 Git 仓库下的子目录只识别为一个项目', () => {
  setupTestDir();
  try {
    const claudeDir = join(testDir, 'claude');
    const projectLogDir = join(claudeDir, 'projects', 'repo-log');
    const repoDir = join(testDir, 'repo');
    const appDir = join(repoDir, 'apps', 'web');
    const libDir = join(repoDir, 'packages', 'core');

    mkdirSync(projectLogDir, { recursive: true });
    mkdirSync(appDir, { recursive: true });
    mkdirSync(libDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });

    writeFileSync(join(projectLogDir, 'session.jsonl'), [
      JSON.stringify({ type: 'user', cwd: appDir, message: { content: 'work in app' } }),
      JSON.stringify({ type: 'assistant', cwd: libDir, message: { content: 'work in lib' } }),
    ].join('\n'), 'utf8');

    deepStrictEqual(deriveProjectPaths(claudeDir), [normalizePath(repoDir)]);
  } finally {
    cleanupTestDir();
  }
});

test('ClaudeParser - record.project 归一到 Git 仓库根目录', async () => {
  setupTestDir();
  try {
    const claudeDir = join(testDir, 'claude');
    const projectLogDir = join(claudeDir, 'projects', 'repo-log');
    const repoDir = join(testDir, 'repo');
    const appDir = join(repoDir, 'apps', 'web');

    mkdirSync(projectLogDir, { recursive: true });
    mkdirSync(appDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });

    writeFileSync(join(projectLogDir, 'session.jsonl'), [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-05-14T10:00:00Z',
        cwd: appDir,
        sessionId: 'session-repo-root',
        message: { role: 'user', content: 'work in app' },
      }),
    ].join('\n'), 'utf8');

    const records = await new ClaudeParser().parse({ claudeDir });
    strictEqual(records.length, 1);
    strictEqual(records[0].project, normalizePath(repoDir));
  } finally {
    cleanupTestDir();
  }
});

test('_convertToUsageRecord - 项目 rename 后旧 cwd 失效时回退 Claude 目录名', () => {
  const p = new ClaudeParser();
  // 旧 cwd 指向已被 rename/move 的路径（磁盘不存在）→ 不应采用，回退 projectDir
  const r1 = p._convertToUsageRecord(
    { cwd: 'D:/__renamed_away__', timestamp: '2026-07-08T10:00:00Z', sessionId: 's-old' },
    'lumencode', 's-old',
  );
  strictEqual(r1.project, 'lumencode', '旧 cwd 失效时应回退目录名而非残留旧路径');

  // 现存 cwd → 正常解析为 git 根（真实路径），不走回退
  const r2 = p._convertToUsageRecord(
    { cwd: process.cwd(), timestamp: '2026-07-10T10:00:00Z', sessionId: 's-new' },
    'lumencode', 's-new',
  );
  if (!r2.project.includes('lumencode') || r2.project === 'lumencode') {
    throw new Error(`现存 cwd 应解析为 git 根，实际: ${r2.project}`);
  }
});
