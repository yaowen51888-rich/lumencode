import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDb } from '../../lib/parsers/_sqlite.js';

test('openDb - 打开合法 sqlite 返回 {db, close}', async () => {
  const SQL = await (await import('sql.js')).default();
  const db = new SQL.Database();
  db.run('CREATE TABLE t(id INTEGER, name TEXT)');
  db.run("INSERT INTO t VALUES(1,'x')");
  const path = join(tmpdir(), `lumencode-sqlite-${process.pid}.sqlite`);
  writeFileSync(path, Buffer.from(db.export()));
  db.close();

  const got = await openDb(path);
  assert.ok(got, '返回非 null');
  const rows = got.db.exec('SELECT name FROM t');
  assert.equal(rows[0].values[0][0], 'x');
  got.close();
});

test('openDb - 文件不存在返回 null', async () => {
  const got = await openDb('/nonexistent/path/x.sqlite');
  assert.equal(got, null);
});
