// test/git.test.js
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { parseGitLogOutput } from '../lib/git.js';

// 测试用例1: 标准输出，包含多个提交和统计
test('parseGitLogOutput - 标准输出', () => {
  const output = `2026-05-14
 3 files changed, 50 insertions(+), 10 deletions(-)
2026-05-13
 1 file changed, 20 insertions(+)
2026-05-12
 2 files changed, 30 insertions(+), 15 deletions(-)`;

  const result = parseGitLogOutput(output);

  assert.equal(result.commits, 3);
  assert.equal(result.filesChanged, 6);
  assert.equal(result.linesAdded, 100);
  assert.equal(result.linesDeleted, 25);

  assert.deepEqual(result.commitsByDate, {
    '2026-05-14': 1,
    '2026-05-13': 1,
    '2026-05-12': 1
  });

  assert.deepEqual(result.linesByDate, {
    '2026-05-14': { added: 50, deleted: 10, files: 3 },
    '2026-05-13': { added: 20, deleted: 0, files: 1 },
    '2026-05-12': { added: 30, deleted: 15, files: 2 }
  });
});

// 测试用例2: 空输出返回零值
test('parseGitLogOutput - 空输出', () => {
  const result = parseGitLogOutput('');

  assert.equal(result.commits, 0);
  assert.equal(result.filesChanged, 0);
  assert.equal(result.linesAdded, 0);
  assert.equal(result.linesDeleted, 0);
  assert.deepEqual(result.commitsByDate, {});
  assert.deepEqual(result.linesByDate, {});
});

// 测试用例3: 只有没有统计信息的提交
test('parseGitLogOutput - 只有提交，没有统计信息', () => {
  const output = `2026-05-14
2026-05-13
2026-05-12`;

  const result = parseGitLogOutput(output);

  assert.equal(result.commits, 3);
  assert.equal(result.filesChanged, 0);
  assert.equal(result.linesAdded, 0);
  assert.equal(result.linesDeleted, 0);

  assert.deepEqual(result.commitsByDate, {
    '2026-05-14': 1,
    '2026-05-13': 1,
    '2026-05-12': 1
  });

  assert.deepEqual(result.linesByDate, {
    '2026-05-14': { added: 0, deleted: 0, files: 0 },
    '2026-05-13': { added: 0, deleted: 0, files: 0 },
    '2026-05-12': { added: 0, deleted: 0, files: 0 }
  });
});

// 测试用例4: 只有删除的文件被正确解析
test('parseGitLogOutput - 只有删除的文件', () => {
  const output = `2026-05-14
 5 files changed, 0 insertions(+), 50 deletions(-)`;

  const result = parseGitLogOutput(output);

  assert.equal(result.commits, 1);
  assert.equal(result.filesChanged, 5);
  assert.equal(result.linesAdded, 0);
  assert.equal(result.linesDeleted, 50);

  assert.deepEqual(result.commitsByDate, {
    '2026-05-14': 1
  });

  assert.deepEqual(result.linesByDate, {
    '2026-05-14': { added: 0, deleted: 50, files: 5 }
  });
});

// 测试用例5: 混合情况的复杂测试
test('parseGitLogOutput - 混合复杂情况', () => {
  const output = `2026-05-14
 3 files changed, 50 insertions(+), 10 deletions(-)
2026-05-13
2026-05-12
 2 files changed, 30 insertions(+)
2026-05-11
 1 file changed, 0 insertions(+), 5 deletions(-)
2026-05-10
 4 files changed, 100 insertions(+), 20 deletions(-)`;

  const result = parseGitLogOutput(output);

  assert.equal(result.commits, 5);
  assert.equal(result.filesChanged, 10);
  assert.equal(result.linesAdded, 180);
  assert.equal(result.linesDeleted, 35);

  assert.deepEqual(result.commitsByDate, {
    '2026-05-14': 1,
    '2026-05-13': 1,
    '2026-05-12': 1,
    '2026-05-11': 1,
    '2026-05-10': 1
  });

  assert.deepEqual(result.linesByDate, {
    '2026-05-14': { added: 50, deleted: 10, files: 3 },
    '2026-05-13': { added: 0, deleted: 0, files: 0 },
    '2026-05-12': { added: 30, deleted: 0, files: 2 },
    '2026-05-11': { added: 0, deleted: 5, files: 1 },
    '2026-05-10': { added: 100, deleted: 20, files: 4 }
  });
});

// 测试用例6: 带有空格和额外文本的输入
test('parseGitLogOutput - 带有空格的输入', () => {
  const output = `
  2026-05-14
   3 files changed, 50 insertions(+), 10 deletions(-)

  2026-05-13
   1 file changed, 20 insertions(+)
  `;

  const result = parseGitLogOutput(output);

  assert.equal(result.commits, 2);
  assert.equal(result.filesChanged, 4);
  assert.equal(result.linesAdded, 70);
  assert.equal(result.linesDeleted, 10);

  assert.deepEqual(result.commitsByDate, {
    '2026-05-14': 1,
    '2026-05-13': 1
  });
});

// 测试用例7: 多行统计信息对应一个提交
test('parseGitLogOutput - 多行统计信息', () => {
  const output = `2026-05-14
 1 file changed, 10 insertions(+)
 2 files changed, 20 insertions(+), 5 deletions(-)
2026-05-13
 3 files changed, 30 insertions(+), 10 deletions(-)`;

  const result = parseGitLogOutput(output);

  assert.equal(result.commits, 2);
  assert.equal(result.filesChanged, 6);
  assert.equal(result.linesAdded, 60);
  assert.equal(result.linesDeleted, 15);

  assert.deepEqual(result.commitsByDate, {
    '2026-05-14': 1,
    '2026-05-13': 1
  });

  assert.deepEqual(result.linesByDate, {
    '2026-05-14': { added: 30, deleted: 5, files: 3 },
    '2026-05-13': { added: 30, deleted: 10, files: 3 }
  });
});