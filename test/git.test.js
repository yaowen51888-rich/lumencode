// test/git.test.js — numstat 格式（哨兵 §§§ + tab-sep）
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { parseGitLogOutput } from '../lib/git.js';

// 用例1：标准多 commit，3 文件去重 → filesChanged = 5（lib/a, lib/b, test/a, doc/c, lib/c）
test('parseGitLogOutput - 标准多 commit', () => {
  const output = [
    '§§§abc111|2026-05-14T10:00:00|me@x|feat: add a',
    '40\t10\tlib/a.js',
    '10\t0\ttest/a.test.js',
    '§§§abc222|2026-05-13T09:00:00|me@x|fix: tweak b',
    '20\t0\tlib/b.js',
    '§§§abc333|2026-05-12T08:00:00|me@x|refactor: split',
    '15\t10\tlib/a.js',
    '5\t5\tdoc/c.md',
    '10\t0\tlib/c.js',
  ].join('\n');

  const r = parseGitLogOutput(output);

  assert.equal(r.commits, 3);
  assert.equal(r.linesAdded, 100);
  assert.equal(r.linesDeleted, 25);
  assert.equal(r.filesChanged, 5); // 跨 commit 去重：lib/a, test/a, lib/b, doc/c, lib/c

  assert.deepEqual(r.commitsByDate, {
    '2026-05-14': 1, '2026-05-13': 1, '2026-05-12': 1,
  });
  assert.deepEqual(r.linesByDate, {
    '2026-05-14': { added: 50, deleted: 10, files: 2 },
    '2026-05-13': { added: 20, deleted: 0, files: 1 },
    '2026-05-12': { added: 30, deleted: 15, files: 3 },
  });

  assert.equal(r.commitList.length, 3);
  assert.equal(r.commitList[0].hash, 'abc111');
  assert.equal(r.commitList[0].subject, 'feat: add a');
  assert.equal(r.commitList[0].author, 'me@x');
  assert.equal(r.commitList[0].date, '2026-05-14T10:00:00');
  assert.equal(r.commitList[0].files.length, 2);
  assert.equal(r.commitList[0].files[0].path, 'lib/a.js');
  assert.equal(r.commitList[0].files[0].added, 40);
  assert.equal(r.commitList[0].files[0].deleted, 10);
});

// 用例2：空输出
test('parseGitLogOutput - 空输出', () => {
  const r = parseGitLogOutput('');
  assert.equal(r.commits, 0);
  assert.equal(r.filesChanged, 0);
  assert.equal(r.linesAdded, 0);
  assert.equal(r.linesDeleted, 0);
  assert.deepEqual(r.commitsByDate, {});
  assert.deepEqual(r.linesByDate, {});
  assert.equal(r.commitList.length, 0);
});

// 用例3：只有 commit 头，没有 numstat 行（空提交 / 合并提交）
test('parseGitLogOutput - 只有提交头，无 numstat', () => {
  const output = [
    '§§§h1|2026-05-14T10:00:00|me@x|chore: tag',
    '§§§h2|2026-05-13T09:00:00|me@x|chore: merge',
    '§§§h3|2026-05-12T08:00:00|me@x|chore: noop',
  ].join('\n');

  const r = parseGitLogOutput(output);

  assert.equal(r.commits, 3);
  assert.equal(r.filesChanged, 0);
  assert.equal(r.linesAdded, 0);
  assert.equal(r.linesDeleted, 0);
  assert.deepEqual(r.commitsByDate, {
    '2026-05-14': 1, '2026-05-13': 1, '2026-05-12': 1,
  });
  assert.deepEqual(r.linesByDate, {
    '2026-05-14': { added: 0, deleted: 0, files: 0 },
    '2026-05-13': { added: 0, deleted: 0, files: 0 },
    '2026-05-12': { added: 0, deleted: 0, files: 0 },
  });
  assert.equal(r.commitList[0].files.length, 0);
});

// 用例4：纯删除
test('parseGitLogOutput - 只有删除', () => {
  const output = [
    '§§§d1|2026-05-14T10:00:00|me@x|refactor: drop legacy',
    '0\t50\tlegacy/a.js',
    '0\t30\tlegacy/b.js',
  ].join('\n');

  const r = parseGitLogOutput(output);

  assert.equal(r.commits, 1);
  assert.equal(r.linesAdded, 0);
  assert.equal(r.linesDeleted, 80);
  assert.equal(r.filesChanged, 2);
  assert.deepEqual(r.linesByDate, {
    '2026-05-14': { added: 0, deleted: 80, files: 2 },
  });
});

// 用例5：混合 — 有 commit 无 stat、纯增、纯删、增删都有
test('parseGitLogOutput - 混合情况', () => {
  const output = [
    '§§§m1|2026-05-14T10:00:00|me@x|feat: x',
    '50\t10\tlib/x.js',
    '§§§m2|2026-05-13T09:00:00|me@x|chore: noop',
    '§§§m3|2026-05-12T08:00:00|me@x|feat: y',
    '30\t0\tlib/y.js',
    '§§§m4|2026-05-11T07:00:00|me@x|fix: z',
    '0\t5\tlib/z.js',
  ].join('\n');

  const r = parseGitLogOutput(output);

  assert.equal(r.commits, 4);
  assert.equal(r.linesAdded, 80);
  assert.equal(r.linesDeleted, 15);
  assert.equal(r.filesChanged, 3); // x, y, z 唯一
  assert.deepEqual(r.linesByDate, {
    '2026-05-14': { added: 50, deleted: 10, files: 1 },
    '2026-05-13': { added: 0, deleted: 0, files: 0 },
    '2026-05-12': { added: 30, deleted: 0, files: 1 },
    '2026-05-11': { added: 0, deleted: 5, files: 1 },
  });
});

// 用例6：binary 文件（- - path）
test('parseGitLogOutput - binary 文件', () => {
  const output = [
    '§§§b1|2026-05-14T10:00:00|me@x|chore: asset',
    '-\t-\tassets/logo.png',
    '10\t0\tdocs/readme.md',
  ].join('\n');

  const r = parseGitLogOutput(output);

  assert.equal(r.commits, 1);
  assert.equal(r.linesAdded, 10);
  assert.equal(r.linesDeleted, 0);
  assert.equal(r.filesChanged, 2);

  const c = r.commitList[0];
  assert.equal(c.files.length, 2);
  assert.equal(c.files[0].path, 'assets/logo.png');
  assert.equal(c.files[0].binary, true);
  assert.equal(c.files[0].added, 0);
  assert.equal(c.files[0].deleted, 0);
  assert.equal(c.files[1].binary, false);
});

// 用例7：同日多 commit — commitsByDate 累加 + filesChanged 跨 commit 去重
test('parseGitLogOutput - 同日多 commit 去重', () => {
  const output = [
    '§§§s1|2026-05-14T15:00:00|me@x|feat: a',
    '10\t0\tlib/a.js',
    '§§§s2|2026-05-14T11:00:00|me@x|fix: a-bug',
    '5\t2\tlib/a.js', // 同一文件再改一次
    '§§§s3|2026-05-14T09:00:00|me@x|test: a',
    '20\t0\ttest/a.test.js',
  ].join('\n');

  const r = parseGitLogOutput(output);

  assert.equal(r.commits, 3);
  assert.equal(r.linesAdded, 35);
  assert.equal(r.linesDeleted, 2);
  assert.equal(r.filesChanged, 2); // lib/a.js + test/a.test.js，去重
  assert.deepEqual(r.commitsByDate, { '2026-05-14': 3 });
  // linesByDate.files 按 commit 累加（不去重），= 1+1+1 = 3
  assert.deepEqual(r.linesByDate, {
    '2026-05-14': { added: 35, deleted: 2, files: 3 },
  });
});

// 用例8：subject 中含 | 不会被切断
test('parseGitLogOutput - subject 含管道符', () => {
  const output = [
    '§§§p1|2026-05-14T10:00:00|me@x|feat: support a|b|c pipeline',
    '10\t0\tlib/p.js',
  ].join('\n');

  const r = parseGitLogOutput(output);

  assert.equal(r.commits, 1);
  assert.equal(r.commitList[0].subject, 'feat: support a|b|c pipeline');
});

// 用例9：repo 参数注入到 commitList
test('parseGitLogOutput - repo 字段透传', () => {
  const output = [
    '§§§r1|2026-05-14T10:00:00|me@x|feat: x',
    '10\t0\tlib/x.js',
  ].join('\n');

  const r = parseGitLogOutput(output, 'D:/myrepo');

  assert.equal(r.commitList[0].repo, 'D:/myrepo');
});
