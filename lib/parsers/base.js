import { homedir } from 'os';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';

/** 安全转数字：失败或 NaN 返回 0。各 parser 共用，避免每文件重复定义。 */
export const num = v => Number(v) || 0;

/**
 * epoch 秒/毫秒自适应转 ISO 8601（>1e12 视为毫秒，否则秒）。
 * 各 sqlite parser（goose/hermes/kilo）的 msToIso/normalizeTimestampMs 统一于此。
 * 非法、非正、非有限输入返回 ''。
 */
export function epochMsToISO(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

/**
 * 递归收集 root 下满足 predicate(fullPath, stat, basename) 的文件路径。
 * 替代各 parser 重复的 _findXxx 深度遍历。目录读取失败静默跳过。
 */
export function walkFiles(root, predicate) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      const full = join(d, e);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full); continue; }
      if (predicate(full, st, e)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * AI 工具日志解析器基类
 * 所有具体解析器必须继承此类并实现抽象方法
 */
export class BaseParser {
  constructor() {
    if (this.constructor === BaseParser) {
      throw new Error('BaseParser 是抽象类，不能直接实例化');
    }
  }

  /**
   * 返回工具元信息
   * @returns {{name: string, displayName: string, defaultDir: string, envVar: string|string[]}}
   */
  getInfo() {
    throw new Error(`${this.constructor.name}.getInfo() 未实现`);
  }

  /**
   * 检测该工具的数据目录是否存在且有有效数据
   * @param {Object} config - 完整配置对象
   * @returns {Promise<boolean>}
   */
  async detect(config) {
    throw new Error(`${this.constructor.name}.detect() 未实现`);
  }

  /**
   * 解析日志文件，返回 UsageRecord[]
   * @param {Object} config - 完整配置对象
   * @param {Object} options - 解析选项
   * @returns {Promise<Array>}
   */
  async parse(config, options = {}) {
    throw new Error(`${this.constructor.name}.parse() 未实现`);
  }

  countSourceFiles(config) {
    return this.getDataDirs(config).reduce((count, dir) => count + walkFiles(dir, () => true).length, 0);
  }

  /**
   * 获取该工具的数据目录路径（从配置或环境变量）
   * envVar 支持字符串或数组：数组时按顺序查首个已设置的变量（多别名兼容迁移）。
   * 注意：仅返回单一目录；若需支持逗号分隔多目录（多账号），见 getDataDirs()。
   * @param {Object} config
   * @returns {string|null}
   */
  getDataDir(config) {
    const dirs = this.getDataDirs(config);
    return dirs.length ? dirs[0] : null;
  }

  /**
   * 获取该工具的全部数据目录（配置值可逗号分隔多个，env 亦可逗号分隔）。
   * 用于多账号场景。单目录工具调用 getDataDir() 即可。
   * @param {Object} config
   * @returns {string[]}
   */
  getDataDirs(config) {
    const info = this.getInfo();
    const configKey = `${info.name}Dir`;
    const fromConfig = config[configKey] && config[configKey] !== '' ? config[configKey] : '';
    if (fromConfig) return splitMulti(fromConfig);
    const envVars = Array.isArray(info.envVar) ? info.envVar : (info.envVar ? [info.envVar] : []);
    for (const v of envVars) {
      if (v && process.env[v]) return splitMulti(process.env[v]);
    }
    const home = homedir();
    if (home) {
      const p = home + info.defaultDir.replace(/^~/, '');
      return [p];
    }
    return [];
  }

  /**
   * 获取工具版本号（子类可覆写）
   * @param {Object} config
   * @returns {Promise<string|null>}
   */
  async getVersion(config) {
    return null;
  }
}

/** 拆分逗号分隔的多目录字符串，trim 后保留非空项。各 parser 经 splitMulti as splitPaths 复用。 */
export function splitMulti(raw) {
  return String(raw).split(',').map(s => s.trim()).filter(s => s !== '');
}
