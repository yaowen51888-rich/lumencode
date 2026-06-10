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

const REQUIRED_SECTIONS = {
  default: {
    brief: ['数据摘要', '工作亮点分析', '关键洞察', '风险与建议'],
    detailed: ['数据摘要', '工作亮点分析', '关键洞察', '异常与风险', '管理建议', '下一步关注点'],
  },
  workhorse: {
    brief: ['本期投入', '核心产出', '进展价值', '风险处理'],
    detailed: ['本期投入', '核心产出', '进展价值', '风险处理'],
  },
};

// 否定语境前缀：匹配到这些前缀时，视为合规表达（如"不应计算 ROI"）
const NEGATION_PREFIX = /(不[应该能可会]|无法|缺乏|没有|未|禁止|避免|不宜|无须|无需|不[要需必]|不[宜适]|难以)/i;

function isNegatedContext(text, matchIndex) {
  const prefix = text.slice(Math.max(0, matchIndex - 15), matchIndex);
  return NEGATION_PREFIX.test(prefix);
}

const UNSUPPORTED_CLAIM_PATTERNS = [
  {
    label: 'ROI',
    pattern: /\bROI\b|投资回报/i,
  },
  {
    label: '节省时长',
    pattern: /节省.{0,8}(小时|工时|人天|人力|时长)/,
  },
  {
    label: '业务收益',
    pattern: /业务收益|营收|收入增长|商业价值提升/,
  },
  {
    label: '节省成本',
    pattern: /节省.{0,8}成本|降本增效/,
  },
];

function quoteCmdArg(value) {
  const s = String(value);
  // 只给包含空格或特殊字符的参数加引号
  if (!/^[\w\-.@/:=]+$/.test(s)) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
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
  const style = options.style || 'default';
  const isWorkhorse = style === 'workhorse';

  const usageBase = pickObject(usage, [
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
  ]);
  if (isWorkhorse) {
    delete usageBase.estimatedCost;
  }

  return {
    meta: {
      period: options.period || '',
      date: options.date || '',
      tool: options.tool || 'all',
      project: options.project || '',
      level: options.level || 'detailed',
      style,
      platform: options.platform || 'default',
      start: reportData?.start || '',
      end: reportData?.end || '',
      // 生成时点：仅在 createSmartReport / 重归一化时传入，参与缓存哈希计算的调用不传，避免缓存失效
      generatedAt: options.generatedAt || '',
    },
    usage: {
      ...usageBase,
      projects: mapValues(usage.projects, value =>
        pickObject(value, isWorkhorse
          ? ['requests', 'sessions', 'totalTokens']
          : ['requests', 'sessions', 'totalTokens', 'cost'])),
      models: mapValues(usage.models, value =>
        pickObject(value, isWorkhorse
          ? ['count', 'inputTokens', 'outputTokens']
          : ['count', 'inputTokens', 'outputTokens', 'cost', 'costMode'])),
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
    costBreakdown: isWorkhorse ? null : (reportData?.costBreakdown || null),
    workReportMarkdown: String(workMarkdown || '').slice(0, MAX_MARKDOWN_CHARS),
    sourceReports: compactSourceReports(options.sourceReports),
  };
}

export function buildSmartReportPrompt(context) {
  const level = context?.meta?.level || 'detailed';
  const style = context?.meta?.style || 'default';
  const requiredSections = getRequiredSections(level, style);
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
        '当前生成风格：管理汇报。',
        '- 采用面向领导汇报的表达倾向，突出”做了什么、产出价值、工作投入、风险兜底”。',
        '- 必须结合 detailedMarkdown 与 bossMarkdown；bossMarkdown 只作为领导汇报口径参考，不得突破数据边界。',
        '- 可以让语言更适合向上汇报，但不得编造业务收益、ROI、节省时长或人员评价。',
      ].join('\n')
    : [
        '当前生成风格：默认风格。',
        '- 采用专业、克制的分析报告口径，重点解释数据变化、工作亮点、风险和建议。',
      ].join('\n');
  const sections = requiredSections.map(title => `## ${title}`).join('\n');

  return [
    SMART_REPORT_PROMPT_MARKER,
    '',
    '你是 LumenCode 的智能报告分析器。只能基于下面提供的数据和确定性工作汇报进行分析。',
    '',
    '边界要求：',
    '- 只能引用输入数据中存在的统计事实，不得编造业务成果、节省时长、ROI 或人员评价。',
    '- 不得读取源码、不得读取本地文件、不得执行命令、不得联网、不得请求更多上下文。',
    '- 如果数据无法支持结论，必须明确写“数据不足”。',
    style === 'workhorse'
      ? '- 可以做趋势解释、异常识别、Token/活跃度/项目分布/AI 贡献率分析。'
      : '- 可以做趋势解释、异常识别、成本/Token/活跃度/项目分布/AI 贡献率分析。',
    '- 输出 Markdown，语言为简体中文，面向管理者和项目负责人。',
    '- 必须以一级标题（# 标题）作为第一段有效内容，标题应包含报告类型和周期。',
    extrapolationInstruction(style, context),
    '',
    levelInstruction,
    '',
    styleInstruction,
    '',
    '必须使用以下章节，章节标题需逐项保留，不要新增无数据支撑章节：',
    sections,
    '',
    '上下文 JSON：',
    JSON.stringify(context, null, 2),
  ].join('\n');
}

function getRequiredSections(level, style) {
  const normalizedStyle = style === 'workhorse' ? 'workhorse' : 'default';
  const normalizedLevel = level === 'brief' ? 'brief' : 'detailed';
  return REQUIRED_SECTIONS[normalizedStyle][normalizedLevel];
}

// 外推/衍生指标识别：月化、月度预估、外推、每行/每次成本等基于少量活跃日推算的指标
const EXTRAPOLATION_PATTERN = /月化|月度?(?:预估|外推)|外推|每行(?:代码)?成本|每次(?:调用|交互)成本/;
// 不确定性兜底词：出现其一即视为已标注依据或偏差。
// 注意：不含"外推"——它同时是 EXTRAPOLATION_PATTERN 的指标词，纳入会让裸奔的"月度外推 $X"自我豁免。
const UNCERTAINTY_HINT = /偏差|波动|假设|活跃日|活跃天|仅供参考|不确定|可能(?:偏高|偏低|存在)|基于\s*\d+\s*[天个]/;

function extrapolationInstruction(style, context) {
  const activeDays = context?.usage?.activeDays;
  const daysHint = Number.isFinite(activeDays)
    ? `（本期仅 ${activeDays} 个活跃日，外推偏差可能很大）`
    : '';
  const base = [
    '- 凡涉及月化、月度预估、外推或每行/每次成本等衍生指标，必须在同一处显式标注「基于 N 个活跃日外推、实际值可能有较大偏差」之类的不确定性说明，不得给出不带依据的精确外推值。',
  ];
  if (style === 'workhorse') {
    base.push(`- 本报告面向领导汇报，外推类数字尤其不得裸奔${daysHint}：要么给出区间，要么明确这是基于有限活跃日的粗略外推。`);
  } else if (daysHint) {
    base.push(`- 注意当前活跃日较少${daysHint}，外推结论需克制。`);
  }
  return base.join('\n');
}

export function validateSmartReportMarkdown(markdown, context = {}) {
  const text = String(markdown || '');
  const level = context?.meta?.level || 'detailed';
  const style = context?.meta?.style || 'default';
  const requiredSections = getRequiredSections(level, style);
  const headings = text.split('\n')
    .map(line => line.match(/^##\s+(.+?)\s*$/)?.[1]?.trim())
    .filter(Boolean);

  const warnings = [];
  const missing = requiredSections.filter(section => !headings.some(heading => heading.includes(section)));
  if (missing.length > 0) {
    warnings.push(`缺少必需章节：${missing.join('、')}`);
  }

  // 检查夸大表达，但排除否定语境（如"不应计算 ROI"、"缺乏节省时长的数据"）
  const unsupported = [];
  for (const { label, pattern } of UNSUPPORTED_CLAIM_PATTERNS) {
    const matches = text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'));
    for (const match of matches) {
      if (!isNegatedContext(text, match.index)) {
        unsupported.push(label);
        break;
      }
    }
  }
  if (unsupported.length > 0) {
    warnings.push(`包含无数据支撑的夸大表达：${unsupported.join('、')}`);
  }

  // 检查外推/衍生指标是否带不确定性说明（同一行或相邻行需出现依据/偏差提示）
  const lines = text.split('\n');
  const extrapolationUnguarded = lines.some((line, idx) => {
    if (!EXTRAPOLATION_PATTERN.test(line)) return false;
    const window = [lines[idx - 1] || '', line, lines[idx + 1] || ''].join('\n');
    return !UNCERTAINTY_HINT.test(window);
  });
  if (extrapolationUnguarded) {
    warnings.push('外推/衍生指标缺少不确定性说明（应标注基于多少活跃日外推及可能偏差）');
  }

  return warnings;
}

function firstMarkdownH1(markdown) {
  const line = String(markdown || '').split('\n').find(l => /^#\s+\S/.test(l.trim()));
  return line ? line.trim() : '';
}

function fallbackSmartReportTitle(context = {}) {
  const meta = context.meta || {};
  const levelLabel = meta.level === 'brief' ? '智能简报' : '智能报告';
  const periodLabel = meta.period === 'daily' ? '日报'
    : meta.period === 'weekly' ? '周报'
      : meta.period === 'monthly' ? '月报'
        : '自定义报告';
  const dateLabel = meta.period === 'monthly' && meta.start ? meta.start.slice(0, 7)
    : meta.start && meta.end && meta.start !== meta.end ? `${meta.start} ~ ${meta.end}`
      : meta.start || meta.date || '';
  return `# AI 编码助手 ${levelLabel}${periodLabel}${dateLabel ? ` - ${dateLabel}` : ''}`;
}

const SNAPSHOT_MARKER = '📌 **数据快照**';

function formatGeneratedAt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildSnapshotBlock(context = {}) {
  const meta = context.meta || {};
  // 仅在具备周期或生成时点信息时注入，避免污染无上下文的纯归一化场景
  if (!meta.period && !meta.generatedAt) return '';

  const periodLabel = { daily: '日报', weekly: '周报', monthly: '月报' }[meta.period] || '自定义周期';
  const levelLabel = meta.level === 'brief' ? '简报' : '详细';
  const styleLabel = meta.style === 'workhorse' ? '管理汇报' : '默认分析';
  const range = meta.start && meta.end && meta.start !== meta.end
    ? `${meta.start} ~ ${meta.end}`
    : meta.start || meta.date || '';
  const toolLabel = meta.tool && meta.tool !== 'all' ? meta.tool : '全部工具';
  const projectLabel = meta.project || '全部项目';
  const genLabel = formatGeneratedAt(meta.generatedAt);

  const parts = [
    `周期 ${periodLabel}`,
    range ? `范围 ${range}` : '',
    `口径 ${levelLabel}/${styleLabel}`,
    `${toolLabel} · ${projectLabel}`,
  ].filter(Boolean);

  const lines = [`> ${SNAPSHOT_MARKER}：${parts.join(' ｜ ')}`];
  lines.push(genLabel
    ? `> 生成于 ${genLabel}；同周期报告若生成时点不同，统计口径与数值会因数据累积而变化，请以本快照时点为准。`
    : '> 同周期报告若生成时点不同，统计口径与数值会因数据累积而变化，请以本快照时点为准。');
  return lines.join('\n');
}

function injectAfterH1(text, block) {
  const lines = text.split('\n');
  const h1Index = lines.findIndex(l => /^#\s+\S/.test(l.trim()));
  if (h1Index < 0) return `${block}\n\n${text}`;
  const head = lines.slice(0, h1Index + 1).join('\n');
  const rest = lines.slice(h1Index + 1).join('\n').replace(/^\n+/, '');
  return rest ? `${head}\n\n${block}\n\n${rest}` : `${head}\n\n${block}`;
}

export function normalizeSmartReportMarkdown(markdown, context = {}) {
  let text = String(markdown || '').trim();
  if (!text) return text;

  // 1. 确保存在 H1 标题
  if (!firstMarkdownH1(text)) {
    const sourceTitle = firstMarkdownH1(context.workReportMarkdown);
    const title = sourceTitle || fallbackSmartReportTitle(context);
    text = `${title}\n\n${text}`;
  }

  // 2. 在 H1 后确定性注入数据快照口径块（幂等：已存在则跳过）
  const snapshot = buildSnapshotBlock(context);
  if (snapshot && !text.includes(SNAPSHOT_MARKER)) {
    text = injectAfterH1(text, snapshot);
  }

  return text;
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

  const context = buildSmartReportContext(reportData, workMarkdown, {
    ...options,
    // 生成时点：用于快照口径块；不参与 server 端缓存哈希（哈希计算处不传此字段）
    generatedAt: options.generatedAt || new Date().toISOString(),
  });
  const prompt = buildSmartReportPrompt(context);
  const markdown = await runner(definition, prompt);
  const normalized = normalizeSmartReportMarkdown(markdown, context);
  const qualityWarnings = validateSmartReportMarkdown(normalized, context);
  if (qualityWarnings.length > 0) {
    // 质量校验不通过时，将警告附加到报告末尾，不阻止生成
    const warningBlock = [
      '',
      '---',
      '> **⚠️ 报告质量提示**：' + qualityWarnings.join('；'),
      '',
      '> 以上内容由 AI 自动生成，可能存在数据边界偏差，建议结合原始报告核实关键结论。',
    ].join('\n');
    return normalized + warningBlock;
  }
  return normalized;
}
