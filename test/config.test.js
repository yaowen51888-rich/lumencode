import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, initConfig, saveConfig } from '../lib/config.js';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const testConfigDir = join(process.cwd(), 'test', '__tmp_config__');
const testConfigFile = join(testConfigDir, 'test-config.json');

function setupTest() {
  // Clean up any existing test files
  if (existsSync(testConfigFile)) {
    rmSync(testConfigFile);
  }
  if (!existsSync(testConfigDir)) {
    mkdirSync(testConfigDir);
  }
}

function cleanupTest() {
  // Clean up test files
  if (existsSync(testConfigFile)) {
    rmSync(testConfigFile);
  }
}

test('loadConfig - No config file returns defaults', () => {
  setupTest();
  try {
    const config = loadConfig(testConfigFile);

    // Verify default config structure
    assert.ok(config, 'Config should be defined');
    assert.ok(config.claudeDir, 'claudeDir should exist');
    assert.ok(Array.isArray(config.repos), 'repos should be array');
    assert.ok(Array.isArray(config.excludeProjects), 'excludeProjects should be array');
    assert.ok(config.scenarioKeywords, 'scenarioKeywords should exist');
    assert.ok(Array.isArray(config.scenarioKeywords.coding), 'coding keywords should be array');
    assert.ok(Array.isArray(config.scenarioKeywords.testing), 'testing keywords should be array');
    assert.ok(Array.isArray(config.scenarioKeywords.debugging), 'debugging keywords should be array');
    assert.ok(Array.isArray(config.scenarioKeywords.documentation), 'documentation keywords should be array');
    assert.ok(Array.isArray(config.scenarioKeywords.review), 'review keywords should be array');
    assert.ok(Array.isArray(config.scenarioKeywords.planning), 'planning keywords should be array');
  } finally {
    cleanupTest();
  }
});

test('loadConfig - Custom config file loads and merges with defaults', () => {
  setupTest();
  try {
    // Create a custom config file
    const customConfig = {
      repos: ['/path/to/repo1', '/path/to/repo2'],
      excludeProjects: ['project1', 'project2'],
      scenarioKeywords: {
        coding: ['custom-coding-keyword'],
        testing: ['custom-testing-keyword'],
        debugging: ['custom-debugging-keyword'],
        documentation: ['custom-documentation-keyword'],
        review: ['custom-review-keyword'],
        planning: ['custom-planning-keyword']
      }
    };

    writeFileSync(testConfigFile, JSON.stringify(customConfig, null, 2));

    const config = loadConfig(testConfigFile);

    // Verify that default values are preserved
    assert.ok(config.claudeDir, 'claudeDir should exist (from defaults)');
    assert.ok(config.scenarioKeywords.claudeDir === undefined, 'claudeDir should not be overridden');

    // Verify that custom values are loaded
    assert.deepStrictEqual(config.repos, ['/path/to/repo1', '/path/to/repo2'], 'repos should be loaded from file');
    assert.deepStrictEqual(config.excludeProjects, ['project1', 'project2'], 'excludeProjects should be loaded from file');
    assert.deepStrictEqual(config.scenarioKeywords.coding, ['custom-coding-keyword'], 'coding keywords should be loaded from file');
    assert.deepStrictEqual(config.scenarioKeywords.testing, ['custom-testing-keyword'], 'testing keywords should be loaded from file');
    assert.deepStrictEqual(config.scenarioKeywords.debugging, ['custom-debugging-keyword'], 'debugging keywords should be loaded from file');
    assert.deepStrictEqual(config.scenarioKeywords.documentation, ['custom-documentation-keyword'], 'documentation keywords should be loaded from file');
    assert.deepStrictEqual(config.scenarioKeywords.review, ['custom-review-keyword'], 'review keywords should be loaded from file');
    assert.deepStrictEqual(config.scenarioKeywords.planning, ['custom-planning-keyword'], 'planning keywords should be loaded from file');
  } finally {
    cleanupTest();
  }
});

test('loadConfig - Corrupt JSON file falls back to defaults', () => {
  setupTest();
  try {
    // Create a corrupt JSON file
    writeFileSync(testConfigFile, '{"invalid": json, "corrupted": true}');

    const config = loadConfig(testConfigFile);

    // Should fall back to defaults
    assert.ok(config.claudeDir, 'claudeDir should exist (from defaults)');
    assert.ok(Array.isArray(config.repos), 'repos should be array (from defaults)');
    assert.ok(Array.isArray(config.excludeProjects), 'excludeProjects should be array (from defaults)');
    assert.ok(config.scenarioKeywords, 'scenarioKeywords should exist (from defaults)');

    // Custom values from corrupt file should not be present
    assert.strictEqual(config.invalid, undefined, 'Invalid config should not be present');
  } finally {
    cleanupTest();
  }
});

test('initConfig - Creates file if it doesn\'t exist', () => {
  setupTest();
  try {
    // Ensure file doesn't exist
    if (existsSync(testConfigFile)) {
      rmSync(testConfigFile);
    }

    initConfig(testConfigFile);

    // Verify file was created
    assert.ok(existsSync(testConfigFile), 'Config file should be created');

    // Verify content is DEFAULT_CONFIG
    const fileContent = JSON.parse(readFileSync(testConfigFile, 'utf-8'));
    assert.deepStrictEqual(fileContent, {
      claudeDir: join(homedir(), '.claude'),
      repos: [],
      excludeProjects: [],
      scenarioKeywords: {
        coding: ['实现', '功能', '开发', '添加', '修改代码', 'implement', 'feature', 'add', 'refactor', '重构', '组件'],
        testing: ['测试', 'test', 'spec', '覆盖率', 'coverage', '单元测试', 'unit test', 'jest', 'vitest', 'mocha'],
        debugging: ['修复', 'bug', 'debug', 'fix', '报错', '错误', '异常', 'error', 'issue', '问题', '排查', '堆栈'],
        documentation: ['文档', 'doc', 'readme', 'md', '注释', 'comment', '说明', '指南', 'guide'],
        review: ['review', '审查', '检查', '代码审查', '/review'],
        planning: ['计划', 'plan', '设计', '架构', '方案', 'design', 'architect'],
      }
    }, 'Created file should contain DEFAULT_CONFIG');

    // Clean up created file for next test
    rmSync(testConfigFile);

    // Verify it doesn't overwrite existing file
    writeFileSync(testConfigFile, '{"existing": "config"}');
    initConfig(testConfigFile);

    // File should still contain original content
    const existingContent = JSON.parse(readFileSync(testConfigFile, 'utf-8'));
    assert.strictEqual(existingContent.existing, 'config', 'Existing file should not be overwritten');
  } finally {
    cleanupTest();
  }
});

test('saveConfig - Writes config correctly', () => {
  setupTest();
  try {
    const testConfig = {
      claudeDir: '/custom/path/to/claude',
      repos: ['/repo1', '/repo2'],
      excludeProjects: ['project1'],
      scenarioKeywords: {
        coding: ['custom-coding'],
        testing: ['custom-testing'],
        debugging: ['custom-debugging'],
        documentation: ['custom-docs'],
        review: ['custom-review'],
        planning: ['custom-planning']
      }
    };

    const savedPath = saveConfig(testConfig, testConfigFile);

    // Verify file was saved at the returned path
    assert.ok(existsSync(savedPath), 'Config file should be saved at returned path');

    // Verify content
    const savedContent = JSON.parse(readFileSync(savedPath, 'utf-8'));
    assert.deepStrictEqual(savedContent, testConfig, 'Saved config should match input');
  } finally {
    cleanupTest();
  }
});

// Cleanup after all tests
process.on('exit', () => {
  if (existsSync(testConfigFile)) {
    rmSync(testConfigFile);
  }
  if (existsSync(testConfigDir)) {
    rmSync(testConfigDir, { recursive: true });
  }
});