import test from 'node:test';
import assert from 'node:assert/strict';
import { BaseParser } from '../../lib/parsers/base.js';
import { registerParser, parseAllEnabledTools } from '../../lib/parsers/index.js';

// 假 parser：返回一条空 project + 一条匹配 project 的记录，验证过滤严格性
class FakeIncludeParser extends BaseParser {
  getInfo() {
    return { name: 'fake-include-test', displayName: 'Fake', defaultDir: '/tmp', envVar: 'FAKE_INCLUDE_TEST' };
  }
  async detect() { return true; }
  async parse() {
    return [
      { timestamp: '2026-07-07T10:00:00Z', tool: 'fake-include-test', sessionId: 's-empty', project: '', inputTokens: 10, outputTokens: 5, metadata: { type: 'assistant' } },
      { timestamp: '2026-07-07T11:00:00Z', tool: 'fake-include-test', sessionId: 's-match', project: '/home/u/myproj', inputTokens: 20, outputTokens: 8, metadata: { type: 'assistant' } },
    ];
  }
}

test('includeProjects 严格排除空 project 记录', async () => {
  registerParser(FakeIncludeParser);
  const config = { enabledTools: ['fake-include-test'] };
  const { records } = await parseAllEnabledTools(config, { includeProjects: ['myproj'] });

  const projects = records.map(r => r.project);
  assert.ok(!projects.includes(''), '空 project 记录必须被排除');
  assert.equal(records.length, 1, '仅保留 basename 匹配的记录');
  assert.ok(records[0].project.includes('myproj'));
});
