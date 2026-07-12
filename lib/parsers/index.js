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
// ponytail: 工具可用性会话内静态（安装/卸载罕见），按数据目录指纹 + enabledTools 缓存 60s。
// 省掉 15 个 parser.getVersion 进程派生（实测 ~600ms）。任一 dataDir 变更即失效。
let _detectCache = null;
let _detectCacheKey = '';
let _detectCacheExpire = 0;
const DETECT_CACHE_TTL = 60_000;

export async function detectAvailableTools(config) {
  const dirFingerprint = PARSER_REGISTRY.map(P => {
    try { return new P().getDataDir(config); } catch { return ''; }
  }).join('|');
  const key = `${dirFingerprint}||${(config.enabledTools || []).join(',')}`;
  const now = Date.now();
  if (_detectCache && _detectCacheKey === key && now < _detectCacheExpire) {
    return _detectCache;
  }

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
    let version = null;
    try {
      version = await parser.getVersion(config);
    } catch (e) { /* getVersion 失败不影响主流程 */ }
    results.push({
      name: info.name,
      displayName: info.displayName,
      detected,
      dataDir,
      version,
    });
  }

  _detectCache = results;
  _detectCacheKey = key;
  _detectCacheExpire = now + DETECT_CACHE_TTL;
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

// 统一的项目名规范化：取路径最后一段作为项目名
function normalizeProjectToBase(projectPath) {
  if (!projectPath) return '';
  const normalized = projectPath.replace(/\\/g, '/').replace(/\/$/, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || '';
}

/**
 * 将 record.project 统一到 config.repos 规范路径（按 basename 匹配）。
 * 同一仓库的会话可能因 cwd 形态不同（basename / git 根 / 子目录 / rename-move 后旧盘符路径）
 * 在 session.project 原始标签上裂分。匹配层（git projectMatches）与 stats 聚合本就按
 * basename / pathContains 运作，不受影响；此处仅统一原始标签，消除会话列表、报告项目维度的展示不一致。
 *
 * basename 在 repos 中冲突（两个同名仓库）时跳过该 basename——保持原值更安全，强归一反而合并两个独立仓库。
 *
 * 局限：rename 导致 basename 变化（ccusage-report→lumencode）时旧记录 basename 不再命中任何 repo，
 * 无法自动归一。claude parser 靠 Claude 目录名（=当前规范路径）兜底恢复匹配；其余工具仅有 cwd 一个
 * 身份信号，basename 变化的 rename 无法自动恢复，需 project alias（YAGNI，暂未实现）。
 */
export function canonicalizeProjectPaths(records, repos) {
  if (!Array.isArray(records) || !repos || repos.length === 0) return records;
  const baseCount = new Map();
  for (const repo of repos) {
    const base = normalizeProjectToBase(repo);
    if (base) baseCount.set(base, (baseCount.get(base) || 0) + 1);
  }
  const baseToRepo = new Map();
  for (const repo of repos) {
    const base = normalizeProjectToBase(repo);
    if (base && baseCount.get(base) === 1) baseToRepo.set(base, repo.replace(/\\/g, '/'));
  }
  if (baseToRepo.size === 0) return records;
  for (const r of records) {
    const base = normalizeProjectToBase(r.project);
    if (base && baseToRepo.has(base)) r.project = baseToRepo.get(base);
  }
  return records;
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
  let allRecords = [];
  const toolBreakdown = {};

  for (const toolName of enabled) {
    const parser = getAllParsers().find(item => item.getInfo().name === toolName);
    const scannedFiles = parser?.countSourceFiles(config) || 0;
    try {
      const records = await parser.parse(config, options);
      const lastSuccessAt = records.reduce((latest, record) => {
        const timestamp = record.timestamp || '';
        return timestamp > latest ? timestamp : latest;
      }, '') || null;
      const silentFailure = scannedFiles > 0 && records.length === 0;
      allRecords.push(...records);
      toolBreakdown[toolName] = {
        recordCount: records.length,
        sessionCount: new Set(records.map(r => r.sessionId)).size,
        scannedFiles,
        skippedFiles: silentFailure ? scannedFiles : 0,
        successRate: scannedFiles > 0 ? (silentFailure ? 0 : 1) : null,
        status: silentFailure ? 'error' : 'ok',
        error: silentFailure ? `发现 ${scannedFiles} 个日志文件，但未解析出记录` : undefined,
        lastSuccessAt,
      };
    } catch (err) {
      console.warn(`解析工具 ${toolName} 失败:`, err.message);
      toolBreakdown[toolName] = {
        recordCount: 0, sessionCount: 0, scannedFiles, skippedFiles: scannedFiles,
        successRate: scannedFiles > 0 ? 0 : null, status: 'error', error: err.message, lastSuccessAt: null,
      };
    }
  }

  // 统一按 includeProjects 过滤（所有工具按 basename 匹配）
  // 阶段 1 已修复 Claude 项目名从 cwd 提取，basename 准确可用
  if (options.includeProjects && options.includeProjects.length > 0) {
    const allowedBases = new Set(options.includeProjects.map(p => normalizeProjectToBase(p)));
    // 严格匹配：空 project 无法确认归属，排除（与 collectAllRecords 按目录名严格匹配一致）。
    // 旧逻辑 !base || ... 放行所有空 project 记录，配 repos 时污染项目维度统计。
    allRecords = allRecords.filter(r => {
      const base = normalizeProjectToBase(r.project);
      return !!base && allowedBases.has(base);
    });
  }

  // 统一 project 标签到 config.repos 规范路径（消除同仓库多形态裂分；局限见函数注释）
  canonicalizeProjectPaths(allRecords, config.repos);

  // 过滤后重新计算 toolBreakdown，保留 0 记录的工具（诊断用）
  const toolGroups = {};
  for (const r of allRecords) {
    const t = r.tool || 'claude';
    if (!toolGroups[t]) toolGroups[t] = { recordCount: 0, sessions: new Set() };
    toolGroups[t].recordCount++;
    if (r.sessionId) toolGroups[t].sessions.add(r.sessionId);
  }
  const filteredBreakdown = {};
  // 从初始 toolBreakdown 保留所有已启用工具（即使 0 记录）
  for (const t of Object.keys(toolBreakdown)) {
    const g = toolGroups[t];
    filteredBreakdown[t] = {
      ...toolBreakdown[t],
      recordCount: g?.recordCount || 0,
      sessionCount: g?.sessions.size || 0,
    };
  }

  // 按时间戳排序
  allRecords.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

  return { records: allRecords, toolBreakdown: filteredBreakdown };
}
