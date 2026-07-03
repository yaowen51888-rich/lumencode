#!/usr/bin/env node

/**
 * LumenCode MCP Server
 *
 * 将 LumenCode 的 AI 编码助手分析能力暴露为 MCP tools，
 * 供 Claude Code / Cursor / Windsurf 等工具直接调用。
 *
 * 启动方式: node src/mcp/server.js
 * 配置方式: 在 Claude Code 的 settings.json 中添加:
 *   { "mcpServers": { "lumencode": { "command": "node", "args": ["src/mcp/server.js"] } } }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../../lib/config.js';
import { detectClaudeDir, deriveProjectPaths } from '../../lib/parser.js';
import { parseAllEnabledTools, registerParser, detectAvailableTools } from '../../lib/parsers/index.js';
import { ClaudeParser } from '../../lib/parsers/claude.js';
import { CodexParser } from '../../lib/parsers/codex.js';
import { OpencodeParser } from '../../lib/parsers/opencode.js';
import { preloadUnknownPricing } from '../../lib/pricing-loader.js';
import { normalizeProjectPath } from '../../lib/aggregate.js';
import { toolSchemas, toolHandlers } from './tools.js';

// 注册解析器
registerParser(ClaudeParser);
registerParser(CodexParser);
registerParser(OpencodeParser);

// ── 数据缓存 ──

let cachedRecords = null;
let cachedToolBreakdown = null;
let cachedConfig = null;
let pendingRecords = null;

/**
 * 加载并缓存配置
 */
function loadMcpConfig() {
  if (cachedConfig) return cachedConfig;

  let config = loadConfig();

  // 零配置：自动检测 claudeDir
  if (!config.claudeDir || config.claudeDir === '') {
    config.claudeDir = detectClaudeDir() || config.claudeDir;
  }

  // 零配置：自动推导项目路径
  if ((!config.repos || config.repos.length === 0) && config.claudeDir) {
    try {
      const derived = deriveProjectPaths(config.claudeDir, config.excludeProjects || []);
      if (derived.length > 0) {
        config._autoRepos = derived;
        config.repos = derived;
      }
    } catch { /* 推导失败不影响启动 */ }
  }

  cachedConfig = config;
  return config;
}

/**
 * 首次调用时解析 records 并缓存，后续复用
 */
async function ensureRecords() {
  if (cachedRecords) {
    return { records: cachedRecords, toolBreakdown: cachedToolBreakdown };
  }
  // 并发去重：MCP 客户端可通过 stdio 并发发请求，
  // 首次加载时复用同一个 in-flight promise，避免重复触发昂贵的解析。
  if (pendingRecords) return pendingRecords;

  pendingRecords = (async () => {
    const config = loadMcpConfig();
    const includeProjects = config.repos && config.repos.length > 0
      ? config.repos.map(r => normalizeProjectPath(r))
      : config._autoRepos
        ? config._autoRepos.map(r => normalizeProjectPath(r))
        : null;

    console.error('[LumenCode MCP] 正在扫描 AI 编码助手日志...');

    const { records, toolBreakdown } = await parseAllEnabledTools(config, {
      excludeProjects: config.excludeProjects,
      includeProjects,
    });

    if (records.length > 0) {
      await preloadUnknownPricing(records);
    }

    cachedRecords = records;
    cachedToolBreakdown = toolBreakdown;

    console.error(`[LumenCode MCP] 已加载 ${records.length} 条记录，工具: ${Object.keys(toolBreakdown).join(', ')}`);

    return { records, toolBreakdown };
  })();

  try {
    return await pendingRecords;
  } catch (err) {
    pendingRecords = null; // 解析失败：清空以便下次重试，而非永久卡在 rejected promise
    throw err;
  }
}

// ── 创建 MCP Server ──

const server = new McpServer({
  name: 'lumencode',
  version: '1.3.8',
});

// 注册所有 tools
for (const [name, schema] of Object.entries(toolSchemas)) {
  server.registerTool(name, schema, async (args) => {
    try {
      const { records } = await ensureRecords();
      const config = loadMcpConfig();
      const handler = toolHandlers[name];
      if (!handler) {
        return { content: [{ type: 'text', text: `未知 tool: ${name}` }], isError: true };
      }
      return await handler(args, { records, config });
    } catch (err) {
      return {
        content: [{ type: 'text', text: `执行失败: ${err.message}` }],
        isError: true,
      };
    }
  });
}

// ── 启动 ──

async function main() {
  // 预加载配置（不阻塞启动）
  loadMcpConfig();

  console.error('[LumenCode MCP] Server 启动中...');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[LumenCode MCP] Server 已就绪 (stdio)');
}

main().catch(err => {
  console.error('[LumenCode MCP] 启动失败:', err);
  process.exit(1);
});
