import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { join } from 'path';

const index = join(process.cwd(), 'index.js');

function run(args) {
  return execFileSync(process.execPath, [index, ...args], { encoding: 'utf-8', cwd: process.cwd() });
}

test('help aliases print usage', () => {
  for (const alias of ['help', '--help', '-help', '-h']) {
    const out = run([alias]);
    assert.ok(out.includes('用法: lumencode'), `${alias} should print usage`);
    assert.ok(out.includes('report'), `${alias} should list report command`);
  }
});

test('version aliases print version', () => {
  for (const alias of ['--version', '-version', '-V', '-v']) {
    const out = run([alias]).trim();
    assert.match(out, /^\d+\.\d+\.\d+$/, `${alias} should print semver version`);
  }
});
