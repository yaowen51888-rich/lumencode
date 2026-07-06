import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { DEFAULT_ATTRIBUTION_OPTIONS } from './git-attribution-options.js';
import { parseRepoPaths } from './path-utils.js';

const CONFIG_LOCATIONS = [
  join(homedir(), '.lumencode.json'),
  join(homedir(), '.claude', 'tools', 'lumencode', 'config.json'),
  join(process.cwd(), 'config.json'),
];

export const DEFAULT_CONFIG = {
  claudeDir: join(homedir(), '.claude'),
  codexDir: '',        // 空字符串表示自动检测
  opencodeDir: '',     // 空字符串表示自动检测
  // 新增 9 工具目录（空=自动检测）
  geminiDir: '',
  qwenDir: '',
  gooseDir: '',
  ampDir: '',
  hermesDir: '',
  openclawDir: '',
  kimiDir: '',
  codebuffDir: '',
  droidDir: '',
  piDir: '',
  kiloDir: '',
  copilotDir: '',
  enabledTools: [],    // 空数组表示自动检测启用
  repos: [],
  excludeProjects: [],
  blockQuota: null, // 5h 计费窗口 token 上限（Max Pro=1000000, Max=450000 等），null=不限
  costMode: 'auto', // 'auto' | 'calculate' | 'display'
  scenarioKeywords: {
    coding: ['实现', '功能', '开发', '添加', '修改代码', 'implement', 'feature', '组件', 'component', '编写', 'write code'],
    testing: ['测试', 'test', 'spec', '覆盖率', 'coverage', '单元测试', 'unit test', 'jest', 'vitest', 'mocha', 'cypress', 'playwright'],
    debugging: ['修复', 'bug', 'debug', 'fix', '报错', '错误', '异常', 'error', '排查', '堆栈', 'trace', 'stack trace', 'crash'],
    documentation: ['文档', 'readme.md', '注释', '说明', '指南', 'guide', 'wiki', '手册', 'api doc'],
    review: ['review', '审查', '代码审查', '/review', 'pr', 'pull request', 'approve', 'approval', 'reject', '走查', '代码走查'],
    planning: ['计划', 'plan', '设计', '架构', '方案', 'design', 'architect', 'roadmap', '规划'],
    refactoring: ['重构', 'refactor', '重写', 'rewrite', '清理代码', 'clean up', '简化', 'simplify', '提取', 'extract'],
  },
  aiAttribution: DEFAULT_ATTRIBUTION_OPTIONS,
  stepTracking: {
    enabled: true,
    dbPath: '.ccusage/steps.db',
    maxFileSize: 10 * 1024 * 1024,
    ignorePatterns: ['node_modules/', '.git/', 'dist/', 'build/', '.next/', '.cache/'],
  },
};

// 深合并：对嵌套对象和数组做合并而非覆盖
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (sv && typeof sv === 'object' && !Array.isArray(sv) &&
        tv && typeof tv === 'object' && !Array.isArray(tv)) {
      result[key] = deepMerge(tv, sv);
    } else {
      result[key] = sv;
    }
  }
  return result;
}

function normalizeConfig(config) {
  // 支持 repos / excludeProjects 为字符串（逗号或换行分隔）
  if (config.repos !== undefined) {
    config.repos = parseRepoPaths(config.repos);
  }
  if (config.excludeProjects !== undefined) {
    config.excludeProjects = parseRepoPaths(config.excludeProjects);
  }
  return config;
}

export function loadConfig(configPath) {
  let config = { ...DEFAULT_CONFIG };

  // 如果传入了自定义配置路径，只检查该路径，不回退到全局配置
  if (configPath) {
    if (existsSync(configPath)) {
      try {
        const userConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
        config = deepMerge(config, userConfig);
        return normalizeConfig(config);
      } catch (e) {
        console.error(`配置文件读取失败: ${configPath}`, e.message);
        // 文件存在但解析失败，返回默认值
      }
    }
    return config;
  }

  // 未传入配置路径时，按优先级检查默认位置
  for (const p of CONFIG_LOCATIONS) {
    if (existsSync(p)) {
      try {
        const userConfig = JSON.parse(readFileSync(p, 'utf-8'));
        config = deepMerge(config, userConfig);
        return normalizeConfig(config);
      } catch (e) {
        console.error(`配置文件读取失败: ${p}`, e.message);
      }
    }
  }

  return config;
}

export function getConfigPath(configPath) {
  if (configPath && existsSync(configPath)) return configPath;
  for (const p of CONFIG_LOCATIONS) {
    if (existsSync(p)) return p;
  }
  return CONFIG_LOCATIONS[0];
}

export function saveConfig(config, configPath) {
  // 保存时固定使用用户级路径，避免写入 process.cwd() 下的 git 跟踪文件
  const target = configPath || CONFIG_LOCATIONS[0];
  const dir = dirname(target);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(target, JSON.stringify(config, null, 2), { encoding: 'utf8' });
  return target;
}

export function initConfig(configPath) {
  const target = configPath || CONFIG_LOCATIONS[0];
  if (existsSync(target)) {
    console.log(`配置文件已存在: ${target}`);
    return;
  }
  writeFileSync(target, JSON.stringify(DEFAULT_CONFIG, null, 2), { encoding: 'utf8' });
  console.log(`配置文件已创建: ${target}`);
}
