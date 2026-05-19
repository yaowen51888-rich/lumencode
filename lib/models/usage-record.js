/**
 * 统一 AI 工具使用记录格式
 * 所有解析器（Claude/Codex/OpenCode）必须输出此格式
 */
export const USAGE_RECORD_SCHEMA = {
  timestamp: '',      // ISO 8601 字符串
  tool: '',           // 'claude' | 'codex' | 'opencode'
  sessionId: '',      // 会话标识
  model: '',          // 标准化模型名
  inputTokens: 0,     // 输入 token 数
  outputTokens: 0,    // 输出 token 数
  cacheReadTokens: 0, // 缓存读取 token 数（可选）
  cacheWriteTokens: 0,// 缓存写入 token 数（可选）
  costUSD: null,      // 费用（美元），null 表示未计算
  project: '',        // 项目名称（可选）
  metadata: {},       // 工具特有原始数据透传
};

export function createUsageRecord(overrides = {}) {
  return {
    timestamp: '',
    tool: '',
    sessionId: '',
    model: '',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUSD: null,
    project: '',
    metadata: {},
    ...overrides,
  };
}

export function validateUsageRecord(record) {
  const required = ['timestamp', 'tool', 'sessionId'];
  const missing = required.filter(k => !record[k]);
  if (missing.length > 0) {
    throw new Error(`UsageRecord 缺少必填字段: ${missing.join(', ')}`);
  }
  if (!['claude', 'codex', 'opencode'].includes(record.tool)) {
    throw new Error(`UsageRecord.tool 必须是 'claude' | 'codex' | 'opencode'， got: ${record.tool}`);
  }
  return true;
}
