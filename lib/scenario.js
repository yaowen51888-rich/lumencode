// 基于工具调用 + 用户文本关键词的使用场景分类引擎

export function escapeRegExp(string) {
  return string.replace(/[-.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchesKeyword(text, keyword) {
  if (!text || !keyword) return false;
  const t = text.toLowerCase();
  const k = keyword.trim().toLowerCase();
  if (!k) return false;

  // 中文关键词：使用包含匹配（中文无词分隔符，边界匹配会误杀正常匹配）
  if (/\p{Script=Han}/u.test(k)) {
    return t.includes(k);
  }

  // 英文关键词：词边界匹配
  // 处理以非单词字符开头/结尾的关键词（如 /review）
  const escaped = escapeRegExp(k);
  const prefix = /^\w/.test(k) ? '\\b' : '(?:^|\\s)';
  const suffix = /\w$/.test(k) ? '\\b' : '(?:$|\\s)';
  const regex = new RegExp(`${prefix}${escaped}${suffix}`);
  return regex.test(t);
}

const TOOL_SCENARIO_MAP = {
  // Claude Code
  Write: 'coding',
  Edit: 'coding',
  NotebookEdit: 'coding',
  Bash: 'execution',
  Read: 'reading',
  Glob: 'reading',
  Grep: 'reading',
  TaskCreate: 'planning',
  TaskUpdate: 'planning',
  TaskList: 'planning',
  TaskGet: 'planning',
  Agent: 'planning',
  EnterPlanMode: 'planning',
  ExitPlanMode: 'planning',
  AskUserQuestion: 'interaction',
  Skill: 'skill',
  WebSearch: 'research',
  WebFetch: 'research',
  CronCreate: 'automation',
  CronDelete: 'automation',
  // Codex
  shell_command: 'execution',
  update_plan: 'planning',
  view_image: 'reading',
  browser_navigate: 'testing',
  browser_run_code_unsafe: 'testing',
  browser_console_messages: 'testing',
  // OpenCode
  write: 'coding',
  edit: 'coding',
  bash: 'execution',
  glob: 'reading',
  question: 'interaction',
  todowrite: 'planning',
  // Codex (serena MCP)
  activate_project: 'coding',
  initial_instructions: 'reading',
  check_onboarding_performed: 'reading',
  onboarding: 'reading',
  find_symbol: 'reading',
  find_declaration: 'reading',
  find_referencing_symbols: 'reading',
  find_implementations: 'reading',
  get_symbols_overview: 'reading',
  replace_symbol_body: 'coding',
  replace_content: 'coding',
  insert_before_symbol: 'coding',
  insert_after_symbol: 'coding',
  get_diagnostics_for_file: 'testing',
};

const MCP_TOOL_SCENARIOS = {
  'mcp__Playwright': 'testing',
  'mcp__context7': 'research',
  'mcp__open-websearch': 'research',
  'mcp__serena': 'coding',
  'mcp__mcp-deepwiki': 'research',
  'mcp__web_reader': 'research',
};

export function classifyRecord(record, scenarioKeywords) {
  const scenarios = {};
  // 兼容 UsageRecord 格式（metadata.toolCalls）和原始格式（toolCalls）
  const toolCalls = record.metadata?.toolCalls || record.toolCalls || [];
  const tools = toolCalls.map(t => t.name);

  // 基于工具调用的分类
  const toolScenarios = new Set();
  for (const tool of tools) {
    if (TOOL_SCENARIO_MAP[tool]) {
      toolScenarios.add(TOOL_SCENARIO_MAP[tool]);
    }
    // MCP 工具前缀匹配
    for (const [prefix, scenario] of Object.entries(MCP_TOOL_SCENARIOS)) {
      if (tool.startsWith(prefix)) {
        toolScenarios.add(scenario);
      }
    }
  }

  // 重新构建工具场景计数，确保每个工具都被计数
  for (const tool of tools) {
    if (TOOL_SCENARIO_MAP[tool]) {
      scenarios[TOOL_SCENARIO_MAP[tool]] = (scenarios[TOOL_SCENARIO_MAP[tool]] || 0) + 1;
    }
    // MCP 工具前缀匹配
    for (const [prefix, scenario] of Object.entries(MCP_TOOL_SCENARIOS)) {
      if (tool.startsWith(prefix)) {
        scenarios[scenario] = (scenarios[scenario] || 0) + 1;
        break; // 只匹配第一个前缀，避免重复计数
      }
    }
  }

  // 基于用户文本的关键词分类（仅对 user 消息）
  // 兼容 UsageRecord 格式（metadata.type/text）和原始格式（type/text）
  const recordType = record.metadata?.type || record.type;
  const recordText = record.metadata?.text || record.text;
  if (recordType === 'user' && recordText && scenarioKeywords) {
    for (const [scenario, keywords] of Object.entries(scenarioKeywords)) {
      for (const kw of keywords) {
        if (matchesKeyword(recordText, kw)) {
          scenarios[scenario] = (scenarios[scenario] || 0) + 1;
          break;
        }
      }
    }
  }

  return scenarios;
}

// 将内部场景映射为用户友好的分类
export function mapToDisplayScenarios(internalScenarios) {
  const display = {
    '编码': 0,
    '测试/QA': 0,
    '调试/排错': 0,
    '文档': 0,
    '阅读/研究': 0,
    '规划/设计': 0,
    '代码审查': 0,
    '重构': 0,
    '其他': 0,
  };

  for (const [key, count] of Object.entries(internalScenarios)) {
    switch (key) {
      case 'coding':
        display['编码'] += count;
        break;
      case 'testing':
        display['测试/QA'] += count;
        break;
      case 'debugging':
        display['调试/排错'] += count;
        break;
      case 'documentation':
        display['文档'] += count;
        break;
      case 'reading':
      case 'research':
        display['阅读/研究'] += count;
        break;
      case 'planning':
        display['规划/设计'] += count;
        break;
      case 'review':
        display['代码审查'] += count;
        break;
      case 'refactoring':
        display['重构'] += count;
        break;
      case 'execution':
        display['编码'] += count;
        break;
      case 'interaction':
      case 'skill':
      case 'automation':
      default:
        display['其他'] += count;
        break;
    }
  }

  return display;
}

export function aggregateScenarios(records, scenarioKeywords) {
  const total = {};

  for (const record of records) {
    const scenarios = classifyRecord(record, scenarioKeywords);
    for (const [key, count] of Object.entries(scenarios)) {
      total[key] = (total[key] || 0) + count;
    }
  }

  return mapToDisplayScenarios(total);
}
