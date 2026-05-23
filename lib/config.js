import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

const CONFIG_LOCATIONS = [
  join(homedir(), '.lumencode.json'),
  join(homedir(), '.claude', 'tools', 'lumencode', 'config.json'),
  join(process.cwd(), 'config.json'),
];

const DEFAULT_CONFIG = {
  claudeDir: join(homedir(), '.claude'),
  codexDir: '',        // 空字符串表示自动检测
  opencodeDir: '',     // 空字符串表示自动检测
  enabledTools: [],    // 空数组表示自动检测启用
  repos: [],
  excludeProjects: [],
  blockQuota: null, // 5h 计费窗口 token 上限（Max Pro=1000000, Max=450000 等），null=不限
  costMode: 'auto', // 'auto' | 'calculate' | 'display'
  scenarioKeywords: {
    coding: ['实现', '功能', '开发', '添加', '修改代码', 'implement', 'feature', 'add', 'refactor', '重构', '组件'],
    testing: ['测试', 'test', 'spec', '覆盖率', 'coverage', '单元测试', 'unit test', 'jest', 'vitest', 'mocha'],
    debugging: ['修复', 'bug', 'debug', 'fix', '报错', '错误', '异常', 'error', 'issue', '问题', '排查', '堆栈'],
    documentation: ['文档', 'doc', 'readme', 'md', '注释', 'comment', '说明', '指南', 'guide'],
    review: ['review', '审查', '检查', '代码审查', '/review'],
    planning: ['计划', 'plan', '设计', '架构', '方案', 'design', 'architect'],
  },
};

export function loadConfig(configPath) {
  let config = { ...DEFAULT_CONFIG };

  // 如果传入了自定义配置路径，只检查该路径，不回退到全局配置
  if (configPath) {
    if (existsSync(configPath)) {
      try {
        const userConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
        config = { ...config, ...userConfig };
        return config;
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
        config = { ...config, ...userConfig };
        return config;
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
