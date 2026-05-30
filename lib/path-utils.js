/**
 * 解析仓库路径字符串，支持多种分隔符：
 * - 英文逗号 ,
 * - 中文逗号 ，
 * - 换行 \n / \r\n
 * - 多余空白自动 trim
 *
 * @param {string|Array} input - 路径字符串或已解析的数组
 * @returns {string[]} 解析后的路径数组
 */
export function parseRepoPaths(input) {
  if (Array.isArray(input)) return input.map(s => String(s || '').trim()).filter(Boolean);
  if (typeof input !== 'string') return [];
  return input
    .split(/[,，\n\r]+/)
    .map(s => s.trim())
    .filter(Boolean);
}
