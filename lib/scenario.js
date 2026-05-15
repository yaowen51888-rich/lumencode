// 基于工具调用 + 用户文本关键词的使用场景分类引擎

const TOOL_SCENARIO_MAP = {
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
  const tools = record.toolCalls.map(t => t.name);

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

  for (const s of toolScenarios) {
    scenarios[s] = (scenarios[s] || 0) + 1;
  }

  // 基于用户文本的关键词分类（仅对 user 消息）
  if (record.type === 'user' && record.text && scenarioKeywords) {
    const lowerText = record.text.toLowerCase();
    for (const [scenario, keywords] of Object.entries(scenarioKeywords)) {
      for (const kw of keywords) {
        const lowerKw = kw.toLowerCase();
        // 用单词边界匹配，避免子串误命中
        const regex = new RegExp('(?:^|[\\s\\b_\\-/.])' + lowerKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|[\\s\\b_\\-/.])');
        if (regex.test(lowerText)) {
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
      case 'execution':
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
