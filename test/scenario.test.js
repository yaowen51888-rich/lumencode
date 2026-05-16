import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyRecord, aggregateScenarios, mapToDisplayScenarios } from '../lib/scenario.js';

// 测试用的场景关键词配置
const testScenarioKeywords = {
  coding: ['编码', '实现', '开发', '写代码', '功能'],
  testing: ['测试', 'qa', '用例', '自动化'],
  documentation: ['文档', '说明', 'readme', '注释'],
  planning: ['规划', '设计', '架构', '计划']
};

// 工具1：基于工具调用的分类
test('classifyRecord - Write and Edit tools → coding (tools + keywords)', (t) => {
  const record = {
    type: 'user',
    text: '请实现用户登录功能',
    toolCalls: [
      { name: 'Write' },
      { name: 'Edit' }
    ]
  };

  const result = classifyRecord(record, testScenarioKeywords);

  // 2个工具(Write/Edit) + 1个关键词(实现) = 3
  assert.deepEqual(result, { coding: 3 });
});

// 工具2：基于用户文本关键词的分类
test('classifyRecord - user text "请实现用户登录功能" → coding', (t) => {
  const record = {
    type: 'user',
    text: '请实现用户登录功能',
    toolCalls: []
  };

  const result = classifyRecord(record, testScenarioKeywords);

  // 检查是否正确匹配了"实现"关键词
  assert.deepEqual(result, { coding: 1 });
});

// 工具3：没有工具和关键词 → 空结果
test('classifyRecord - no tools and no keywords → empty result', (t) => {
  const record = {
    type: 'user',
    text: 'hello world',
    toolCalls: []
  };

  const result = classifyRecord(record, testScenarioKeywords);

  assert.deepEqual(result, {});
});

// 工具4：MCP工具前缀匹配
test('classifyRecord - MCP tool prefix matching (mcp__Playwright_navigate → testing)', (t) => {
  const record = {
    type: 'user',
    text: '自动化测试网站',
    toolCalls: [
      { name: 'mcp__Playwright_navigate' }
    ]
  };

  const result = classifyRecord(record, testScenarioKeywords);

  // 1个工具(mcp__Playwright_navigate) + 1个关键词(自动化) = 2
  assert.deepEqual(result, { testing: 2 });
});

// 工具5：不同工具映射到不同场景
test('classifyRecord - multiple tools map to different scenarios', (t) => {
  const record = {
    type: 'user',
    text: '读取配置文件并分析',
    toolCalls: [
      { name: 'Read' },
      { name: 'Glob' },
      { name: 'WebSearch' },
      { name: 'Bash' }
    ]
  };

  const result = classifyRecord(record, testScenarioKeywords);

  // 2个工具(Read/Glob→reading) + 1个工具(WebSearch→research) + 1个工具(Bash→execution) = 4
  // 无关键词匹配
  assert.deepEqual(result, { reading: 2, research: 1, execution: 1 });
});

// 工具6：混合工具和关键词
test('classifyRecord - mixed tools and keywords', (t) => {
  const record = {
    type: 'user',
    text: '请编写API接口文档',
    toolCalls: [
      { name: 'Write' }
    ]
  };

  const result = classifyRecord(record, testScenarioKeywords);

  // 工具(Write→coding) + 文档关键词("文档"→documentation)
  assert.deepEqual(result, { coding: 1, documentation: 1 });
});

// 工具7：MCP serena工具映射到coding
test('classifyRecord - MCP serena tool → coding', (t) => {
  const record = {
    type: 'user',
    text: '重构代码',
    toolCalls: [
      { name: 'mcp__serena_rename_symbol' }
    ]
  };

  const result = classifyRecord(record, testScenarioKeywords);

  assert.deepEqual(result, { coding: 1 });
});

// 工具8：WebSearch工具映射到research
test('classifyRecord - WebSearch tool → research', (t) => {
  const record = {
    type: 'user',
    text: '搜索相关资料',
    toolCalls: [
      { name: 'WebSearch' }
    ]
  };

  const result = classifyRecord(record, testScenarioKeywords);

  assert.deepEqual(result, { research: 1 });
});

// 工具9：规划相关工具映射到planning
test('classifyRecord - planning tools → planning', (t) => {
  const record = {
    type: 'user',
    text: '设计项目架构',
    toolCalls: [
      { name: 'TaskCreate' },
      { name: 'Agent' }
    ]
  };

  const result = classifyRecord(record, testScenarioKeywords);

  // 2个工具(TaskCreate/Agent→planning) + 1个关键词(设计) = 3
  assert.deepEqual(result, { planning: 3 });
});

// 工具10：非用户消息不会进行关键词匹配
test('classifyRecord - non-user messages do not match keywords', (t) => {
  const record = {
    type: 'assistant',
    text: '用户要求实现登录功能',
    toolCalls: []
  };

  const result = classifyRecord(record, testScenarioKeywords);

  assert.deepEqual(result, {});
});

// 映射函数1：内部场景映射为显示名称
test('mapToDisplayScenarios - internal scenarios to display names', (t) => {
  const internalScenarios = {
    coding: 3,
    testing: 2,
    debugging: 1,
    documentation: 1,
    reading: 2,
    research: 1,
    planning: 1,
    execution: 1,
    unknown: 1
  };

  const result = mapToDisplayScenarios(internalScenarios);

  assert.deepEqual(result, {
    '编码': 3,
    '测试/QA': 2,
    '调试/排错': 1,
    '文档': 1,
    '阅读/研究': 3, // reading + research
    '规划/设计': 1,
    '代码审查': 0,
    '其他': 2 // execution + unknown
  });
});

// 映射函数2：只包含已知场景
test('mapToDisplayScenarios - known scenarios only', (t) => {
  const internalScenarios = {
    coding: 1,
    testing: 1,
    planning: 1
  };

  const result = mapToDisplayScenarios(internalScenarios);

  assert.deepEqual(result, {
    '编码': 1,
    '测试/QA': 1,
    '调试/排错': 0,
    '文档': 0,
    '阅读/研究': 0,
    '规划/设计': 1,
    '代码审查': 0,
    '其他': 0
  });
});

// 映射函数3：空输入
test('mapToDisplayScenarios - empty input', (t) => {
  const internalScenarios = {};

  const result = mapToDisplayScenarios(internalScenarios);

  assert.deepEqual(result, {
    '编码': 0,
    '测试/QA': 0,
    '调试/排错': 0,
    '文档': 0,
    '阅读/研究': 0,
    '规划/设计': 0,
    '代码审查': 0,
    '其他': 0
  });
});

// 聚合函数1：多个记录聚合
test('aggregateScenarios - aggregate multiple records', (t) => {
  const records = [
    {
      type: 'user',
      text: '实现用户登录功能',
      toolCalls: [
        { name: 'Write' },
        { name: 'Edit' }
      ]
    },
    {
      type: 'user',
      text: '编写单元测试',
      toolCalls: [
        { name: 'mcp__Playwright_navigate' }
      ]
    },
    {
      type: 'user',
      text: '查找相关文档',
      toolCalls: [
        { name: 'Read' },
        { name: 'WebSearch' }
      ]
    }
  ];

  const result = aggregateScenarios(records, testScenarioKeywords);

  assert.deepEqual(result, {
    '编码': 3, // Write/Edit(2) + 实现(1)
    '测试/QA': 2, // mcp__Playwright_navigate(1) + 编写(1)
    '阅读/研究': 2, // Read(1) + WebSearch(1)
    '调试/排错': 0,
    '文档': 1, // 文档(关键词)
    '规划/设计': 0,
    '代码审查': 0,
    '其他': 0
  });
});

// 聚合函数2：混合不同类型的记录
test('aggregateScenarios - mixed record types', (t) => {
  const records = [
    {
      type: 'user',
      text: '创建项目规划',
      toolCalls: [
        { name: 'TaskCreate' }
      ]
    },
    {
      type: 'assistant',
      text: '我来帮你实现这个功能',
      toolCalls: [
        { name: 'Write' },
        { name: 'Bash' }
      ]
    },
    {
      type: 'user',
      text: '规划架构设计',
      toolCalls: []
    }
  ];

  const result = aggregateScenarios(records, testScenarioKeywords);

  assert.deepEqual(result, {
    '编码': 1, // Write → coding
    '测试/QA': 0,
    '调试/排错': 0,
    '文档': 0,
    '阅读/研究': 0,
    '规划/设计': 3, // TaskCreate(1) + 创建(1) + 规划(1)
    '代码审查': 0,
    '其他': 1 // Bash → execution
  });
});

// 聚合函数3：空记录列表
test('aggregateScenarios - empty records list', (t) => {
  const records = [];
  const result = aggregateScenarios(records, testScenarioKeywords);

  assert.deepEqual(result, {
    '编码': 0,
    '测试/QA': 0,
    '调试/排错': 0,
    '文档': 0,
    '阅读/研究': 0,
    '规划/设计': 0,
    '代码审查': 0,
    '其他': 0
  });
});

// 聚合函数4：未知场景映射到"其他"
test('aggregateScenarios - unknown scenarios map to "其他"', (t) => {
  const records = [
    {
      type: 'user',
      text: '执行一些操作',
      toolCalls: [
        { name: 'Bash' }
      ]
    }
  ];

  const result = aggregateScenarios(records, testScenarioKeywords);

  assert.deepEqual(result, {
    '编码': 0,
    '测试/QA': 0,
    '调试/排错': 0,
    '文档': 0,
    '阅读/研究': 0,
    '规划/设计': 0,
    '代码审查': 0,
    '其他': 1 // Bash工具
  });
});

// 边界情况：特殊字符处理
test('classifyRecord - special characters in keywords', (t) => {
  const record = {
    type: 'user',
    text: '使用 node.js 开发API接口',
    toolCalls: [
      { name: 'Write' }
    ]
  };

  const result = classifyRecord(record, testScenarioKeywords);

  // 1个工具(Write) + 1个关键词(开发) = 2
  assert.deepEqual(result, { coding: 2 });
});