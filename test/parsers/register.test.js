// test/parsers/register.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerAllParsers } from '../../lib/parsers/register.js';
import { getAllParsers } from '../../lib/parsers/index.js';

test('registerAllParsers - 注册全部 15 个 parser', () => {
  registerAllParsers();
  const names = getAllParsers().map(p => p.getInfo().name).sort();
  const expected = ['amp','claude','codebuff','codex','copilot','droid','gemini','goose','hermes','kilo','kimi','openclaw','opencode','pi','qwen'];
  assert.deepEqual(names, expected);
});
