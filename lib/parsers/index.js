import { BaseParser } from './base.js';

// 解析器注册表 - 新增工具时在此注册
const PARSER_REGISTRY = [];

/**
 * 注册解析器类
 * @param {typeof BaseParser} ParserClass
 */
export function registerParser(ParserClass) {
  if (!(ParserClass.prototype instanceof BaseParser)) {
    throw new Error('注册的解析器必须继承 BaseParser');
  }
  PARSER_REGISTRY.push(ParserClass);
}

/**
 * 获取所有已注册的解析器实例
 * @returns {BaseParser[]}
 */
export function getAllParsers() {
  return PARSER_REGISTRY.map(P => new P());
}

/**
 * 检测哪些工具可用（数据目录存在）
 * @param {Object} config
 * @returns {Promise<Array<{name, displayName, detected, dataDir}>>}
 */
export async function detectAvailableTools(config) {
  const results = [];
  for (const P of PARSER_REGISTRY) {
    const parser = new P();
    const info = parser.getInfo();
    const dataDir = parser.getDataDir(config);
    let detected = false;
    try {
      detected = await parser.detect(config);
    } catch {
      detected = false;
    }
    results.push({
      name: info.name,
      displayName: info.displayName,
      detected,
      dataDir,
    });
  }
  return results;
}

/**
 * 获取用户启用的工具列表
 * @param {Object} config
 * @param {Array} availableTools - detectAvailableTools 的结果
 * @returns {Array<string>} 工具名称列表
 */
export function getEnabledTools(config, availableTools) {
  if (config.enabledTools && config.enabledTools.length > 0) {
    return config.enabledTools;
  }
  // 默认启用所有检测到的工具
  return availableTools.filter(t => t.detected).map(t => t.name);
}

/**
 * 解析指定工具的数据
 * @param {string} toolName
 * @param {Object} config
 * @param {Object} options
 * @returns {Promise<Array>}
 */
export async function parseTool(toolName, config, options = {}) {
  for (const P of PARSER_REGISTRY) {
    const parser = new P();
    if (parser.getInfo().name === toolName) {
      return parser.parse(config, options);
    }
  }
  throw new Error(`未找到工具解析器: ${toolName}`);
}

/**
 * 解析所有已启用工具的数据
 * @param {Object} config
 * @param {Object} options
 * @returns {Promise<{records: Array, toolBreakdown: Object}>}
 */
export async function parseAllEnabledTools(config, options = {}) {
  const available = await detectAvailableTools(config);
  const enabled = getEnabledTools(config, available);
  const allRecords = [];
  const toolBreakdown = {};

  for (const toolName of enabled) {
    try {
      const records = await parseTool(toolName, config, options);
      allRecords.push(...records);
      toolBreakdown[toolName] = {
        recordCount: records.length,
        sessionCount: new Set(records.map(r => r.sessionId)).size,
      };
    } catch (err) {
      console.warn(`解析工具 ${toolName} 失败:`, err.message);
      toolBreakdown[toolName] = { recordCount: 0, sessionCount: 0, error: err.message };
    }
  }

  // 按时间戳排序
  allRecords.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

  return { records: allRecords, toolBreakdown };
}
