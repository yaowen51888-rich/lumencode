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
    // --skip-git-repo-check：codex exec 默认要求 cwd 是受信任 git 仓库，
    // 非交互场景（server 后台 spawn）无法交互式信任，会直接拒绝：
    // "Not inside a trusted directory and --skip-git-repo-check was not specified"
    args: ['exec', '--skip-git-repo-check', '-'],
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
    brief: ['核心功能交付', '工作亮点', '风险与跟进'],
    detailed: ['核心功能交付', '工作亮点', '进展与价值', '风险与跟进'],
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

// 剥离 bossMarkdown 中的费用相关内容（管理汇报风格不应体现费用花销）：
// 1. 移除「## 技术工具投入」整章（$金额、日均、月度预算）
// 2. 移除「投入随工作量同步增长」费用环比短语及其相邻标点
// 3. 压缩因移除产生的多余空行
// 纯函数：对不含费用的文本透传，不改变其语义。
export function stripCostFromBossMarkdown(text) {
  const src = String(text || '');
  const withoutCostSection = src
    .split(/^(?=## )/m)
    .filter(block => !/^##\s*技术工具投入(?=\s|$)/m.test(block))
    .join('');
  const withoutPhrase = withoutCostSection
    .replace(/[，,]\s*投入随工作量同步增长[。.]?/g, '')
    .replace(/投入随工作量同步增长[。，,.]?/g, '');
  return withoutPhrase.replace(/\n{3,}/g, '\n\n').trim();
}

function compactSourceReports(sourceReports, stripCost = false) {
  const out = {};
  if (!sourceReports || typeof sourceReports !== 'object') return out;
  for (const key of ['detailedMarkdown', 'briefMarkdown', 'bossMarkdown']) {
    if (!sourceReports[key]) continue;
    let content = String(sourceReports[key]);
    if (stripCost && key === 'bossMarkdown') {
      content = stripCostFromBossMarkdown(content);
    }
    content = content.slice(0, MAX_SOURCE_REPORT_CHARS);
    out[key] = content;
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
  const definitions = Object.values(AGENTS);
  const statuses = await Promise.all(definitions.map(definition => checker(definition)));
  return definitions.map((definition, i) => {
    const status = statuses[i];
    return {
      name: definition.name,
      displayName: definition.displayName,
      command: definition.command,
      detected: status.detected,
      version: status.version || '',
      error: status.error || '',
    };
  });
}

const AGENT_LOOKUP_RETRY = 1;
const AGENT_LOOKUP_RETRY_DELAY_MS = 200;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 单次探测：解析智能体命令是否在 PATH 中（不真正运行智能体），供 checkAgentAvailable 的单次尝试。
function probeAgentOnce(definition) {
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

// 检测智能体命令是否可用；对首屏/冷启动的瞬态失败（spawn error / 非零退出）做有限重试，
// 避免单次瞬态被前端固化为"未检测到"直到手动刷新。options.probe/retry/retryDelay 供测试注入。
export async function checkAgentAvailable(definition, options = {}) {
  const retry = options.retry ?? AGENT_LOOKUP_RETRY;
  const retryDelay = options.retryDelay ?? AGENT_LOOKUP_RETRY_DELAY_MS;
  const probe = options.probe || probeAgentOnce;

  let result;
  for (let attempt = 0; attempt <= retry; attempt++) {
    result = await probe(definition);
    if (result.detected) return result;
    if (attempt < retry) await delay(retryDelay);
  }
  console.warn(`[smart-report] agent "${definition.name}" 未检测到: ${result.error}`);
  return result;
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
    sourceReports: compactSourceReports(options.sourceReports, isWorkhorse),
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
        '- 采用面向领导汇报的表达倾向，突出”做了什么业务功能、产出价值、工作亮点、风险兜底”。',
        '- 必须结合 detailedMarkdown 与 bossMarkdown；bossMarkdown 只作为领导汇报口径参考，不得突破数据边界。',
        '- 不得体现任何费用/金额/预算/成本花销（$金额、日均、月度预算、费用环比等）；工作投入只用天数/覆盖率/项目数描述。',
        '- 「核心功能交付」必须基于 context.git.commitList 的 subject/type/scope 提炼具体业务功能点（如”完成 XX 模块””实现 YY 功能”），不得只给”完成 N 项功能开发”这类空泛计数；commit 较多时按 scope 业务域归类并各举代表性功能，commit 较少时也要写出具体功能名称。',
        '- 「工作亮点」聚焦本期突出成果，用管理者视角讲”做成了什么”；必须结合 context.git.aiContribution 与 commitList 中 isAI/aiConfidence/scope 字段，指出 AI 协同完成的具体业务模块或功能点（如”AI 辅助完成 XX 模块的 YY 功能”）；数据不足时写”数据不足”，不得编造。',
        '- 「进展与价值」章节禁止使用「业务价值」「业务收益」「商业价值」「带来价值」「创造收益」等空泛词汇；必须落到具体交付的功能/模块及其支撑的业务场景，且只能引用输入数据中可验证的事实。',
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

function extractSection(text, heading) {
  const lines = text.split('\n');
  let inSection = false;
  const sectionLines = [];
  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      if (inSection) break;
      if (match[1].trim() === heading) {
        inSection = true;
        continue;
      }
    }
    if (inSection) sectionLines.push(line);
  }
  return sectionLines.join('\n').trim();
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

  // 检查「核心功能交付」是否只给出计数、缺少具体功能/模块名称
  const coreDeliverySection = extractSection(text, '核心功能交付');
  if (coreDeliverySection) {
    const hasVagueCount = /\b\d+\s*[项个条次]|完成\s*了?\s*\d+|共\s*\d+\s*[项个条次]|若干|多项/.test(coreDeliverySection);
    const hasConcreteFeature = /(?:模块|功能|组件|系统|服务|接口|页面|流程|策略|算法|表|库|框架|SDK|API|工具|脚本)/.test(coreDeliverySection);
    if (hasVagueCount && !hasConcreteFeature) {
      warnings.push('「核心功能交付」章节只给出计数，缺少具体功能/模块名称');
    }
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

// 从 stderr/stdout/退出码提取 agent 失败详情：
// stderr 优先；否则取 stdout 尾部（claude --print 等会把 API 错误写到 stdout 而非 stderr）；
// 都为空时回退退出码，避免只暴露无信息的 "exit N"。
export function buildAgentFailureDetail(stderr, stdout, code) {
  return String(stderr || '').trim() || String(stdout || '').trim().slice(-500) || `exit ${code}`;
}

// 杀 agent 子进程树：claude/codex 多为 npm shim → node → 真 CLI + MCP 子进程，
// 仅 child.kill 只杀直接子进程，孙进程会泄漏并在超时窗内持续烧 API quota。
// 超时/输出超限时调用。deps 供测试注入 spawn/kill。
export function killAgentProcessTree(child, platform = process.platform, deps = {}) {
  if (!child?.pid) return;
  const killPid = deps.kill || ((pid, sig) => process.kill(pid, sig));
  try {
    if (platform === 'win32') {
      // /T 杀整棵进程树；taskkill 是 Windows 系统命令，缺失时回退 child.kill
      const spawnFn = deps.spawn || spawn;
      spawnFn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        shell: false,
      }).on('error', () => {
        try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      });
    } else {
      // spawn(detached:true) 创建的进程组，负 pid 杀整组
      killPid(-child.pid, 'SIGTERM');
    }
  } catch {
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
  }
}

export async function runSmartReportAgent(definition, prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs || RUN_TIMEOUT_MS;
    const invocation = buildAgentSpawnInvocation(definition, definition.args);
    const spawnOpts = {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    };
    // unix 放入新进程组，便于 killAgentProcessTree 用负 pid 杀整组（含 npm shim 下的孙进程）
    if (process.platform !== 'win32') spawnOpts.detached = true;
    const child = spawn(invocation.command, invocation.args, spawnOpts);

    let stdout = '';
    let stdoutBytes = 0;
    let stderr = '';
    let finished = false;
    let truncated = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      killAgentProcessTree(child);
      reject(new Error(`${definition.displayName} 生成超时`));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      stdoutBytes += chunk.length; // Buffer.length 即 utf8 字节数，增量累加避免全量重算 O(n²)
      if (!truncated && stdoutBytes > MAX_OUTPUT_BYTES) {
        // 输出超限：标记后树杀，close 时报明确的"输出超限"，避免误判为模型失败
        truncated = true;
        killAgentProcessTree(child);
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
      if (truncated) {
        reject(new Error(`${definition.displayName} 输出超过 ${MAX_OUTPUT_BYTES} 字节限制，疑似循环输出或诊断日志混入 stdout`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${definition.displayName} 生成失败: ${buildAgentFailureDetail(stderr, stdout, code)}`));
        return;
      }
      resolve(stdout.trim());
    });

    // 子进程提前退出会使 stdin 写端 EPIPE，默认冒泡成 uncaughtException 崩进程；
    // child 的 error/close 已统一收口，此处静默 stdin 流错误
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

// 瞬态错误识别：仅认明确的限流/过载/网络错误。
// 刻意不含 timeout/超时——生成超时已让用户等满 RUN_TIMEOUT_MS，重试只会再等一轮。
const TRANSIENT_ERROR_PATTERN = /429|502|503|529|rate.?limit|too many requests|quota exceeded|econnreset|etimedout|socket hang up|network error|连接超时|网络异常/i;
export function isTransientError(err) {
  return TRANSIENT_ERROR_PATTERN.test(String(err?.message || err || ''));
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
  // 瞬态 API 错误（429/503/网络）有限重试，避免单次抖动冤枉判败；非瞬态错误立即抛出
  const retryCount = options.retryCount ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 2000;
  let markdown;
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      markdown = await runner(definition, prompt);
      break;
    } catch (err) {
      if (attempt < retryCount && isTransientError(err)) {
        await delay(retryDelayMs * 2 ** attempt); // 指数退避 2s/4s
        continue;
      }
      throw err;
    }
  }
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
