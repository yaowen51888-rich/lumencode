// UsageRecord 兼容辅助函数
// 统一处理新格式（inputTokens/outputTokens）和旧格式（tokens.input/tokens.output）

export function getInputTokens(r) {
  if (r.inputTokens !== undefined) return r.inputTokens;
  return r.tokens?.input || 0;
}

export function getOutputTokens(r) {
  if (r.outputTokens !== undefined) return r.outputTokens;
  return r.tokens?.output || 0;
}

export function getCacheRead(r) {
  if (r.cacheReadTokens !== undefined) return r.cacheReadTokens;
  return r.tokens?.cacheRead || 0;
}

export function getCacheCreate(r) {
  if (r.cacheWriteTokens !== undefined) return r.cacheWriteTokens;
  return r.tokens?.cacheCreate || 0;
}

export function getModel(r) {
  return r.model || '';
}

export function isAssistantRecord(r) {
  if (r.metadata?.type === 'assistant') return true;
  if (r.metadata?.type === 'user') return false;
  if (r.tool === 'codex') return true;
  if (r.tool === 'opencode' && r.metadata?.role !== 'user') return true;
  // 兼容 Claude Code 新版日志：type 可能统一为 'user'，用 role 区分 user/assistant
  if (!r.tool && (r.type === 'assistant' || r.role === 'assistant')) return true;
  return false;
}
