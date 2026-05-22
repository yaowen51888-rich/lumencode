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
   * @returns {{name: string, displayName: string, defaultDir: string, envVar: string}}
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

  /**
   * 获取该工具的数据目录路径（从配置或环境变量）
   * @param {Object} config
   * @returns {string|null}
   */
  getDataDir(config) {
    const info = this.getInfo();
    const configKey = `${info.name}Dir`;
    if (config[configKey] && config[configKey] !== '') {
      return config[configKey];
    }
    const envVal = process.env[info.envVar];
    if (envVal) return envVal;
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) {
      return home + info.defaultDir.replace(/^~/, '');
    }
    return null;
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
