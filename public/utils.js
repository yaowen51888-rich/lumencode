// 获取今天日期字符串 YYYY-MM-DD
export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// 日期格式化 YYYY.MM.DD
export function fmtDate(d) {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

// HTML 实体转义
export function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 数字格式化
export function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + ' M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + ' K';
  return n.toLocaleString('zh-CN');
}

// 短数字格式化（图表用）
export function fmtShort(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

// Chart 实例注册表
const charts = {};

export function getChart(key) {
  return charts[key] || null;
}

export function setChart(key, instance) {
  charts[key] = instance;
}

export function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}

export function destroyAllCharts(keys) {
  keys.forEach(destroyChart);
}

// MCP server 前缀 → 友好名映射
const MCP_SERVER_NAMES = {
  'mcp__Playwright': 'Playwright',
  'mcp__context7': 'Context7',
  'mcp__serena': 'Serena',
  'mcp__open-websearch': 'WebSearch',
  'mcp__mcp-deepwiki': 'DeepWiki',
  'mcp__web_reader': 'WebReader',
  'mcp__exa': 'Exa',
  'mcp__codegraph': 'CodeGraph',
};

// 工具通俗备注映射表（全部工具 Tab 用）
export const TOOL_DISPLAY_NAMES = {
  'Bash': '执行命令',
  'Read': '读取文件',
  'Edit': '修改代码',
  'Write': '创建文件',
  'Grep': '搜索内容',
  'Glob': '查找文件',
  'shell_command': '执行命令(Codex)',
  'TaskUpdate': '更新任务',
  'TaskCreate': '创建任务',
  'Agent': '子代理',
  'TaskList': '查看任务',
  'TaskOutput': '获取结果',
  'TaskStop': '停止任务',
  'AskUserQuestion': '询问用户',
  'EnterPlanMode': '进入规划',
  'ExitPlanMode': '退出规划',
  'WebSearch': '网络搜索',
  'WebFetch': '抓取网页',
  'Skill': '技能调用',
  'CronCreate': '创建定时',
  'CronDelete': '删除定时',
  'update_plan': '更新计划',
  'write': '写入文件(OpenCode)',
  'edit': '编辑文件(OpenCode)',
  'bash': '执行命令(OpenCode)',
  'glob': '查找文件(OpenCode)',
  'question': '提问(OpenCode)',
  'todowrite': '待办(OpenCode)',
  // MCP 聚合条目
  'Playwright': '浏览器自动化',
  'Serena': '代码分析',
  'Context7': '文档检索',
  'CodeGraph': '代码图谱',
  'DeepWiki': '知识库',
  'WebReader': '网页阅读',
  'Exa': '搜索引擎',
  // 其他工具
  'PowerShell': '执行命令(PS)',
};

// 工具名友好化（非 MCP 工具直接返回原名）
export function friendlyToolName(raw) {
  for (const prefix of _sortedPrefixes) {
    if (raw.startsWith(prefix + '__')) {
      const method = raw.slice(prefix.length + 2);
      return `${MCP_SERVER_NAMES[prefix]}.${method}`;
    }
  }
  return raw;
}

// 按 MCP server 分组聚合工具调用：MCP 工具合并为一条，非 MCP 保持独立
// toolsMap 格式: { name: number } 或 { name: { calls, uses } }
// mode: 'calls' | 'uses'
const _sortedPrefixes = Object.keys(MCP_SERVER_NAMES).sort((a, b) => b.length - a.length);
export function aggregateToolsByServer(toolsMap, mode = 'calls') {
  const result = {};
  for (const [name, val] of Object.entries(toolsMap)) {
    const count = typeof val === 'number' ? val : (val[mode] || 0);
    let matched = false;
    for (const prefix of _sortedPrefixes) {
      if (name.startsWith(prefix + '__')) {
        const displayName = MCP_SERVER_NAMES[prefix];
        result[displayName] = (result[displayName] || 0) + count;
        matched = true;
        break;
      }
    }
    if (!matched) {
      result[name] = (result[name] || 0) + count;
    }
  }
  return result;
}

// 去掉 mcp__ServerName__ 前缀，只保留方法名
export function stripMcpPrefix(raw) {
  for (const prefix of _sortedPrefixes) {
    if (raw.startsWith(prefix + '__')) {
      return raw.slice(prefix.length + 2);
    }
  }
  return raw;
}

// MCP 工具按 server 分组，返回带 group header 的条目数组
// mcpToolsMap 格式: { name: { calls, uses } }
// mode: 'calls' | 'uses'
// 返回: [{ name, value, pct, isGroup?, groupTotal? }, ...]
export function groupMcpByServer(mcpToolsMap, mode = 'calls') {
  const groups = {};
  for (const [fullName, val] of Object.entries(mcpToolsMap)) {
    const count = typeof val === 'number' ? val : (val[mode] || 0);
    let server = 'Other';
    let matched = false;
    for (const prefix of _sortedPrefixes) {
      if (fullName.startsWith(prefix + '__')) {
        server = MCP_SERVER_NAMES[prefix] || prefix;
        matched = true;
        break;
      }
    }
    if (!matched) continue;
    if (!groups[server]) groups[server] = { items: [], total: 0 };
    groups[server].items.push({ name: stripMcpPrefix(fullName), value: count, fullName });
    groups[server].total += count;
  }

  const sortedGroups = Object.entries(groups).sort((a, b) => b[1].total - a[1].total);
  const allValues = sortedGroups.flatMap(([, g]) => g.items.map(i => i.value));
  const maxValue = Math.max(...allValues, 1);

  const result = [];
  for (const [server, data] of sortedGroups) {
    result.push({ name: `--- ${server} ---`, isGroup: true, groupTotal: data.total });
    for (const item of data.items.sort((a, b) => b.value - a.value)) {
      result.push({ name: item.name, value: item.value, pct: Math.round((item.value / maxValue) * 100) });
    }
  }
  return result;
}

// 趋势箭头
export function renderTrendArrow(elId, current, previous) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (previous == null || previous === undefined || previous === 0 || current == null || current === undefined) {
    el.textContent = '';
    el.className = 'card-trend';
    return;
  }
  const pct = ((current - previous) / previous * 100).toFixed(0);
  const val = Math.abs(Number(pct));
  if (pct > 0) { el.textContent = `↑${val}%`; el.className = 'card-trend up'; }
  else if (pct < 0) { el.textContent = `↓${val}%`; el.className = 'card-trend down'; }
  else { el.textContent = '—'; el.className = 'card-trend flat'; }
}

// Chart 更新或创建：若实例存在且类型匹配则 update，否则 destroy + recreate
export function getOrCreateChart(key, canvasId, factory) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const existing = getChart(key);
  if (existing) {
    try {
      return factory(existing, canvas);
    } catch {
      destroyChart(key);
    }
  }
  const instance = factory(null, canvas);
  if (instance) setChart(key, instance);
  return instance;
}
