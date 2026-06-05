import { spawn } from 'child_process';

const AGENTS = {
  claude: {
    name: 'claude',
    displayName: 'Claude Code',
    command: 'claude',
    args: ['--print'],
  },
  codex: {
    name: 'codex',
    displayName: 'Codex',
    command: 'codex',
    args: ['exec', '-'],
  },
  opencode: {
    name: 'opencode',
    displayName: 'OpenCode',
    command: 'opencode',
    args: ['run', '-'],
  },
};

const RUN_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_MARKDOWN_CHARS = 60_000;
const MAX_SOURCE_REPORT_CHARS = 35_000;
export const SMART_REPORT_PROMPT_MARKER = 'LUMENCODE_SMART_REPORT_INTERNAL_TASK';

function quoteCmdArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

export function buildAgentSpawnInvocation(definition, args, platform = process.platform) {
  if (platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', [definition.command, ...args.map(quoteCmdArg)].join(' ')],
    };
  }
  return { command: definition.command, args };
}

export function buildAgentLookupInvocation(definition, platform = process.platform) {
  if (platform === 'win32') {
    return { command: 'where.exe', args: [definition.command] };
  }
  return { command: 'sh', args: ['-lc', `command -v ${definition.command}`] };
}

function pickObject(source, keys) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function mapValues(source, mapper, limit = 50) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const [key, value] of Object.entries(source).slice(0, limit)) {
    out[key] = mapper(value);
  }
  return out;
}

function compactCommit(commit) {
  return pickObject(commit, [
    'subject',
    'type',
    'scope',
    'repo',
    'date',
    'isAI',
    'aiConfidence',
    'attributionType',
    'linesAdded',
    'linesDeleted',
  ]);
}

function compactSourceReports(sourceReports) {
  const out = {};
  if (!sourceReports || typeof sourceReports !== 'object') return out;
  for (const key of ['detailedMarkdown', 'briefMarkdown', 'bossMarkdown']) {
    if (sourceReports[key]) out[key] = String(sourceReports[key]).slice(0, MAX_SOURCE_REPORT_CHARS);
  }
  return out;
}

export function getAgentDefinition(agent) {
  return AGENTS[String(agent || '').toLowerCase()] || null;
}

export function listSmartReportAgents() {
  return Object.values(AGENTS).map(({ name, displayName }) => ({ name, displayName }));
}

export async function detectSmartReportAgents(checker = checkAgentAvailable) {
  const results = [];
  for (const definition of Object.values(AGENTS)) {
    const status = await checker(definition);
    results.push({
      name: definition.name,
      displayName: definition.displayName,
      command: definition.command,
      detected: status.detected,
      version: status.version || '',
      error: status.error || '',
    });
  }
  return results;
}

export async function checkAgentAvailable(definition) {
  return new Promise(resolve => {
    const invocation = buildAgentLookupInvocation(definition);
    const child = spawn(invocation.command, invocation.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ detected: false, error: 'version check timeout' });
    }, 5_000);

    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ detected: false, error: err.message });
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ detected: true, version: stdout.trim().split('\n')[0] || '' });
      } else {
        resolve({ detected: false, error: stderr.trim() || `exit ${code}` });
      }
    });
  });
}

export function buildSmartReportContext(reportData, workMarkdown, options = {}) {
  const usage = reportData?.usageStats || {};
  const git = reportData?.gitStats || {};

  return {
    meta: {
      period: options.period || '',
      date: options.date || '',
      tool: options.tool || 'all',
      project: options.project || '',
      level: options.level || 'detailed',
      style: options.style || 'default',
      platform: options.platform || 'default',
      start: reportData?.start || '',
      end: reportData?.end || '',
    },
    usage: {
      ...pickObject(usage, [
        'requestCount',
        'sessionCount',
        'userMessageCount',
        'activeDays',
        'totalTokens',
        'inputTokens',
        'outputTokens',
        'cacheRead',
        'cacheCreate',
        'estimatedCost',
        'subagentTokens',
      ]),
      projects: mapValues(usage.projects, value => pickObject(value, ['requests', 'sessions', 'totalTokens', 'cost'])),
      models: mapValues(usage.models, value => pickObject(value, ['count', 'inputTokens', 'outputTokens', 'cost', 'costMode'])),
      scenarios: pickObject(usage.scenarios, Object.keys(usage.scenarios || {})),
      tools: mapValues(usage.tools, value => pickObject(value, ['calls', 'uses'])),
      skills: mapValues(usage.skills, value => pickObject(value, ['calls', 'uses'])),
      mcpTools: mapValues(usage.mcpTools, value => pickObject(value, ['calls', 'uses'])),
    },
    git: {
      ...pickObject(git, [
        'commits',
        'filesChanged',
        'linesAdded',
        'linesDeleted',
        'commitTypes',
        'fileHotspots',
        'aiContribution',
        'attributionSummary',
      ]),
      commitList: Array.isArray(git.commitList) ? git.commitList.slice(0, 30).map(compactCommit) : [],
    },
    trend: {
      dailyStats: reportData?.trendData?.dailyStats || {},
    },
    costBreakdown: reportData?.costBreakdown || null,
    workReportMarkdown: String(workMarkdown || '').slice(0, MAX_MARKDOWN_CHARS),
    sourceReports: compactSourceReports(options.sourceReports),
  };
}

export function buildSmartReportPrompt(context) {
  const level = context?.meta?.level || 'detailed';
  const style = context?.meta?.style || 'default';
  const levelInstruction = {
    brief: [
      '当前生成模式：AI 简报。',
      '- 必须同时参考 detailedMarkdown 和 briefMarkdown；briefMarkdown 用于把握原简报口径，detailedMarkdown 用于补充关键依据。',
      '- 输出应简短、聚焦，保留“数据摘要 / 工作亮点分析 / 关键洞察 / 风险与建议”。',
      '- 不要展开成长篇详细报告。',
    ].join('\n'),
    detailed: [
      '当前生成模式：AI 详细报告。',
      '- 以 detailedMarkdown 和结构化统计数据为主要依据。',
      '- 输出可以包含完整章节，但结论必须能被输入数据支撑。',
    ].join('\n'),
  }[level] || '当前生成模式：AI 详细报告。';
  const styleInstruction = style === 'workhorse'
    ? [
        '当前生成风格：牛马。',
        '- 采用面向领导汇报的表达倾向，突出“做了什么、产出价值、工作投入、风险兜底、下一步计划”。',
        '- 必须结合 detailedMarkdown 与 bossMarkdown；bossMarkdown 只作为领导汇报口径参考，不得突破数据边界。',
        '- 可以让语言更适合向上汇报，但不得编造业务收益、ROI、节省时长或人员评价。',
      ].join('\n')
    : [
        '当前生成风格：默认风格。',
        '- 采用专业、克制的分析报告口径，重点解释数据变化、工作亮点、风险和建议。',
      ].join('\n');
  const sections = level === 'brief'
    ? '## 数据摘要\n## 工作亮点分析\n## 关键洞察\n## 风险与建议'
    : '## 数据摘要\n## 工作亮点分析\n## 关键洞察\n## 异常与风险\n## 管理建议\n## 下一步关注点';

  return [
    SMART_REPORT_PROMPT_MARKER,
    '',
    '你是 LumenCode 的智能报告分析器。只能基于下面提供的数据和确定性工作汇报进行分析。',
    '',
    '边界要求：',
    '- 只能引用输入数据中存在的统计事实，不得编造业务成果、节省时长、ROI 或人员评价。',
    '- 不得读取源码、不得读取本地文件、不得执行命令、不得联网、不得请求更多上下文。',
    '- 如果数据无法支持结论，必须明确写“数据不足”。',
    '- 可以做趋势解释、异常识别、成本/Token/活跃度/项目分布/AI 贡献率分析。',
    '- 输出 Markdown，语言为简体中文，面向管理者和项目负责人。',
    '',
    levelInstruction,
    '',
    styleInstruction,
    '',
    '建议章节：',
    sections,
    '',
    '上下文 JSON：',
    JSON.stringify(context, null, 2),
  ].join('\n');
}

export async function runSmartReportAgent(definition, prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs || RUN_TIMEOUT_MS;
    const invocation = buildAgentSpawnInvocation(definition, definition.args);
    const child = spawn(invocation.command, invocation.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGTERM');
      reject(new Error(`${definition.displayName} 生成超时`));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) {
        child.kill('SIGTERM');
      }
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', err => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error(`无法启动 ${definition.displayName}: ${err.message}`));
    });

    child.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${definition.displayName} 生成失败: ${stderr.trim() || `exit ${code}`}`));
        return;
      }
      resolve(stdout.trim());
    });

    child.stdin.end(prompt);
  });
}

export async function createSmartReport({
  agent,
  reportData,
  workMarkdown,
  options = {},
  runner = runSmartReportAgent,
  requireAvailable = false,
  availabilityChecker = checkAgentAvailable,
}) {
  const definition = getAgentDefinition(agent);
  if (!definition) throw new Error('Unsupported smart report agent');

  if (requireAvailable) {
    const status = await availabilityChecker(definition);
    if (!status.detected) {
      throw new Error(`${definition.displayName} 未检测到，请确认已安装并且命令 ${definition.command} 在当前终端 PATH 中可用。${status.error ? `详情: ${status.error}` : ''}`);
    }
  }

  const context = buildSmartReportContext(reportData, workMarkdown, options);
  const prompt = buildSmartReportPrompt(context);
  return runner(definition, prompt);
}
