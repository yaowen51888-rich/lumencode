import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../lib/config.js';

test('DEFAULT_CONFIG - 含 9 个新工具目录项且默认空', () => {
  for (const k of ['geminiDir','qwenDir','gooseDir','ampDir','hermesDir','openclawDir','kimiDir','codebuffDir','droidDir']) {
    assert.ok(k in DEFAULT_CONFIG, `缺少 ${k}`);
    assert.equal(DEFAULT_CONFIG[k], '', `${k} 应默认空字符串（自动检测）`);
  }
});
