import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTargetFiles } from '../lib/step-tracker.js';

// bash/shell 分支文件提取：codex 等工具经 shell 改文件时的目标文件识别
const ROOT = process.cwd();
const endsWith = (arr, s) => arr.some(p => p.replace(/\\/g, '/').endsWith(s));

test('重定向 > 提取目标', () => {
  assert.ok(endsWith(extractTargetFiles('Bash', { command: 'echo x > out.txt' }, ROOT), 'out.txt'));
});

test('sed -i 提取目标文件', () => {
  assert.ok(endsWith(extractTargetFiles('bash', { command: "sed -i 's/a/b/' lib/foo.js" }, ROOT), 'lib/foo.js'));
});

test('cp 取目标(末参数)，不取源', () => {
  const f = extractTargetFiles('shell', { command: 'cp src.js dst.js' }, ROOT);
  assert.ok(endsWith(f, 'dst.js'));
  assert.ok(!endsWith(f, 'src.js'));
});

test('mv 取目标', () => {
  assert.ok(endsWith(extractTargetFiles('Bash', { command: 'mv a.js b.js' }, ROOT), 'b.js'));
});

test('tee 提取(管道内)', () => {
  assert.ok(endsWith(extractTargetFiles('Bash', { command: 'echo x | tee log.txt' }, ROOT), 'log.txt'));
});

test('codex sh -c 数组(带引号)解包', () => {
  const f = extractTargetFiles('Bash', { command: ['sh', '-c', "sed -i 's/a/b/' lib/q.js"] }, ROOT);
  assert.ok(endsWith(f, 'lib/q.js'));
});

test('codex sh -c 数组(无引号)解包', () => {
  const f = extractTargetFiles('Bash', { command: ['sh', '-c', 'tee c.txt'] }, ROOT);
  assert.ok(endsWith(f, 'c.txt'));
});

test('input 为字符串(原始 shell)', () => {
  assert.ok(endsWith(extractTargetFiles('shell', 'sed -i s/x/y/ lib/bar.js', ROOT), 'lib/bar.js'));
});

test('无文件命令返回空', () => {
  assert.equal(extractTargetFiles('Bash', { command: 'ls -la && pwd' }, ROOT).length, 0);
});
