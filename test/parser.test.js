import { test } from 'node:test';
import { strictEqual, deepStrictEqual, throws } from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { parseJsonlFile } from '../lib/parser.js';

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
    },
  ]);

  cleanupTestDir();
});