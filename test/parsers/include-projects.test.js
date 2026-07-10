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

// 假 parser：同一仓库的多种 project 形态（basename / git 根 / 子目录 / 未配置仓库），验证归一
class FakeCanonicalParser extends BaseParser {
  getInfo() {
    return { name: 'fake-canon-test', displayName: 'FakeCanon', defaultDir: '/tmp', envVar: 'FAKE_CANON_TEST' };
  }
  async detect() { return true; }
  async parse() {
    return [
      { timestamp: '2026-07-07T10:00:00Z', tool: 'fake-canon-test', sessionId: 's-base', project: 'lumencode', inputTokens: 1, outputTokens: 1, metadata: { type: 'assistant' } },
      { timestamp: '2026-07-07T11:00:00Z', tool: 'fake-canon-test', sessionId: 's-root', project: 'D:/lumencode', inputTokens: 1, outputTokens: 1, metadata: { type: 'assistant' } },
      { timestamp: '2026-07-07T12:00:00Z', tool: 'fake-canon-test', sessionId: 's-sub', project: 'D:/lumencode/packages/x', inputTokens: 1, outputTokens: 1, metadata: { type: 'assistant' } },
      { timestamp: '2026-07-07T13:00:00Z', tool: 'fake-canon-test', sessionId: 's-unknown', project: 'D:/other-repo', inputTokens: 1, outputTokens: 1, metadata: { type: 'assistant' } },
    ];
  }
}

test('canonicalizeProjectPaths 按 basename 归一到 config.repos 规范路径', async () => {
  registerParser(FakeCanonicalParser);
  const config = { enabledTools: ['fake-canon-test'], repos: ['D:/lumencode'] };
  const { records } = await parseAllEnabledTools(config);

  const bySid = Object.fromEntries(records.map(r => [r.sessionId, r.project]));
  assert.equal(bySid['s-base'], 'D:/lumencode', 'basename 形态归一到 repo 规范路径');
  assert.equal(bySid['s-root'], 'D:/lumencode', 'git 根形态归一（消除盘符/大小写差异）');
  assert.equal(bySid['s-unknown'], 'D:/other-repo', '未命中 repo 的 project 原样保留');
  // 子目录 basename(x) ≠ repo basename(lumencode) → 不强制归一，保留原值（匹配层 pathContains 仍生效）
  assert.equal(bySid['s-sub'], 'D:/lumencode/packages/x', '子目录 basename 不同不强制归一');
});

test('canonicalizeProjectPaths basename 冲突时跳过归一（不误合并独立仓库）', async () => {
  registerParser(FakeCanonicalParser);
  const config = { enabledTools: ['fake-canon-test'], repos: ['D:/a/lumencode', 'D:/b/lumencode'] };
  const { records } = await parseAllEnabledTools(config);
  const baseValues = records.map(r => r.project);
  // 两个同名 repo → basename 冲突 → 不归一，保留原始 basename 值
  assert.ok(baseValues.includes('lumencode'), '冲突 basename 不归一，保留原 basename');
});
