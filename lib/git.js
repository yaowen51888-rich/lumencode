import { execSync, execFileSync, spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { aggregateAttribution, classifyAttribution } from './attribution.js';
import {
  normalizeCommitFilePath,
  normalizePathForGit,
  projectMatches as projectMatchesFromGitPaths,
  toRepoRelativePath,
} from './git-paths.js';
import { resolveAttributionOptions } from './git-attribution-options.js';
import { scoreSessionCandidate } from './git-attribution-candidates.js';

// ── 生成/第三方文件排除 ──
// 整包粘贴的 vendor 库、构建产物、lockfile 非 AI 编写，计入行分母会压制 AI% 占比。
// config.excludeFilePatterns 可追加（与默认合并）；默认名单覆盖常见噪声。
export const DEFAULT_EXCLUDE_FILE_PATTERNS = Object.freeze([
  '**/vendor/**',
  '**/third_party/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.cache/**',
  '**/*.min.js',
  '**/*.min.css',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/*.lock',
]);

// 简易 glob 匹配（仅支持默认名单所需：**/dir/**、**/*.ext、**/file、plain 子串）。
// ponytail: 不引依赖；自定义复杂 glob 再换 minimatch。
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function matchFilePattern(normPath, pattern) {
  const p = String(pattern || '').trim();
  if (!p) return false;
  const dirSeg = p.match(/^\*\*\/([^/*]+)\/\*\*$/);
  if (dirSeg) return new RegExp(`(^|/)${escapeRe(dirSeg[1])}(/|$)`).test(normPath);
  const suf = p.match(/^\*\*\/\*(\.[^/*]+)$/);
  if (suf) return normPath.endsWith(suf[1]);
  const base = p.match(/^\*\*\/([^/*]+)$/);
  if (base) return normPath.split('/').pop() === base[1];
  return normPath.includes(p.replace(/\*\*/g, ''));
}

// 合并默认 + 用户模式；输入非法时回退默认。
function resolveExcludeFilePatterns(input) {
  const extra = Array.isArray(input) ? input.filter(x => typeof x === 'string' && x.trim()) : [];
  return [...DEFAULT_EXCLUDE_FILE_PATTERNS, ...extra];
}

// 判断文件路径是否命中排除模式（路径先归一为正斜杠小写）。
function isExcludedFile(filePath, patterns) {
  if (!patterns?.length || !filePath) return false;
  const norm = String(filePath).replace(/\\/g, '/').toLowerCase();
  for (const p of patterns) {
    if (matchFilePattern(norm, String(p).toLowerCase())) return true;
  }
  return false;
}

// ── helpers ──

// 异步 git：spawn argv 不经 shell，since/until/路径原样传递，无注入面；
// 流式收集 stdout 并设 50MB 上限（与原 exec maxBuffer 语义一致，防超大仓库 OOM）。
const SPAWN_MAX_BUFFER = 50 * 1024 * 1024;
function spawnGit(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    let stderr = '';
    child.stdout.on('data', c => {
      size += c.length;
      if (size > SPAWN_MAX_BUFFER) { child.kill('SIGTERM'); return; }
      chunks.push(c);
    });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0 && size <= SPAWN_MAX_BUFFER) {
        resolve(Buffer.concat(chunks).toString(options.encoding || 'utf8'));
      } else {
        reject(new Error(`git ${args[0]} exit ${code}${size > SPAWN_MAX_BUFFER ? ' (output exceeded buffer)' : ''}${stderr ? ': ' + stderr.slice(0, 200) : ''}`));
      }
    });
  });
}

function getGitAuthor(repoPath) {
  try {
    return execSync('git config user.email', { cwd: repoPath, encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    try {
      return execSync('git config user.name', { cwd: repoPath, encoding: 'utf-8', stdio: 'pipe' }).trim();
    } catch {
      return null;
    }
  }
}

function emptyResult() {
  return {
    commits: 0,
    filesChanged: 0,
    linesAdded: 0,
    linesDeleted: 0,
    commitsByDate: {},
    linesByDate: {},
    commitList: [],
  };
}

export const COMMIT_SENTINEL = '§§§';

// ── Conventional Commit 解析 ──

const CONVENTIONAL_TYPES = [
  'feat', 'fix', 'refactor', 'docs', 'test', 'chore',
  'perf', 'style', 'ci', 'build', 'revert',
];
const CONVENTIONAL_RE = /^(feat|fix|refactor|docs|test|chore|perf|style|ci|build|revert)(?:\(([^)]+)\))?(!)?:\s*(.+)$/i;

export function parseConventional(subject) {
  if (!subject) return { type: 'other', scope: null, isBreaking: false };
  const m = subject.match(CONVENTIONAL_RE);
  if (m) {
    return {
      type: m[1].toLowerCase(),
      scope: m[2] || null,
      isBreaking: m[3] === '!' || /BREAKING\s+CHANGE/i.test(subject),
    };
  }
  return {
    type: 'other',
    scope: null,
    isBreaking: /BREAKING\s+CHANGE/i.test(subject),
  };
}

// ── 行级归因：commit 文件输入（档②逐行投影用）──

// commit 时刻某文件的完整内容；binary / 不存在 / 越界 → null
function getCommitFileContent(repo, hash, path) {
  try {
    // ponytail: execFileSync 走 argv 不经 shell，规避 win cmd.exe / bash 引号差异与元字符注入
    return execFileSync('git', ['show', `${hash}:${path}`], {
      cwd: repo, encoding: 'utf-8', stdio: 'pipe', maxBuffer: 20 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

// 解析 unified diff，提取 commit 后文件中新增（+）行的 1-based 行号
export function parseAddedLines(diff) {
  const added = [];
  let newLine = 0;
  let inHunk = false;
  for (const ln of String(diff || '').split('\n')) {
    const h = ln.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      newLine = parseInt(h[1], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (ln.startsWith('+++')) continue; // 文件头 +++ b/path，非新增行
    if (ln.startsWith('+')) {
      added.push(newLine);
      newLine++;
    } else if (ln.startsWith('-')) {
      // removed 行不占 new 行号
    } else if (ln.startsWith(' ')) {
      newLine++;
    }
    // '\' (No newline at end of file) 等忽略
  }
  return added;
}

// commit 文件相对其 parent 的 patch（仅该文件）；失败 / 无 parent → ''
function getCommitFileDiff(repo, hash, path) {
  try {
    return execFileSync('git', ['show', hash, '--format=', '--no-color', '-p', '--', path], {
      cwd: repo, encoding: 'utf-8', stdio: 'pipe', maxBuffer: 20 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

// 一次凑齐某 commit×file 逐行投影所需输入：commit 内容 + added 行号
// 失败 / binary → { null, null }，上层降级比例法
export function getCommitFileBlameInputs(repo, hash, path) {
  if (!repo || !hash || !path) return { commitContent: null, addedLines: null };
  const commitContent = getCommitFileContent(repo, hash, path);
  if (commitContent === null) return { commitContent: null, addedLines: null };
  const addedLines = parseAddedLines(getCommitFileDiff(repo, hash, path));
  return { commitContent, addedLines };
}

// ponytail: 批量版——per-commit 仅 2 次 exec 取代 per-file 2×N 次。
// 上限：依赖 git cat-file --batch 的 size 切分；path 含极端字符时回退 per-file（getCommitFileBlameInputs）。

// 批量取多个 blob content：git cat-file --batch 一次喂 N 个 "hash:path"
// keys: ["hash:path", ...] -> Map key -> content(string) | null（missing/binary 取不到）
function gitCatFileBatch(repo, keys) {
  const result = new Map();
  if (!repo || !keys?.length) return result;
  const input = Buffer.from(keys.join('\n') + '\n');
  let out;
  try {
    out = execFileSync('git', ['cat-file', '--batch'], {
      cwd: repo, input, encoding: 'buffer', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 200 * 1024 * 1024,
    });
  } catch { return result; }
  let off = 0;
  for (const key of keys) {
    if (off >= out.length) break;
    const nl = out.indexOf(0x0a, off);
    if (nl < 0) break;
    const header = out.slice(off, nl).toString('utf-8');
    off = nl + 1;
    if (header.endsWith(' missing')) { result.set(key, null); continue; }
    // header: "<key> <type> <size>" —— 从右取 size 与 type，兼容 key 内含空格
    const spSize = header.lastIndexOf(' ');
    const size = parseInt(header.slice(spSize + 1), 10);
    const spType = header.lastIndexOf(' ', spSize - 1);
    const typ = spType >= 0 ? header.slice(spType + 1, spSize) : '';
    if (typ !== 'blob' || !Number.isFinite(size)) { result.set(key, null); continue; }
    result.set(key, out.slice(off, off + size).toString('utf-8'));
    off += size + 1; // content 后一个 \n
  }
  return result;
}

// 整 commit diff 一次（git show <hash> -p），按文件切段提取 addedLines -> Map path -> number[]
function parseCommitDiffByFile(diff) {
  const map = new Map();
  const segs = String(diff || '').split(/(?=^diff --git )/m);
  for (const seg of segs) {
    if (!seg.startsWith('diff --git')) continue;
    const m = seg.match(/^\+\+\+ b\/(.+?)$/m);
    const path = m ? m[1].trim() : '';
    if (!path || path === '/dev/null') continue;
    map.set(path, parseAddedLines(seg));
  }
  return map;
}
function getCommitAddedLinesAll(repo, hash) {
  if (!repo || !hash) return new Map();
  let out;
  try {
    out = execFileSync('git', ['show', hash, '--format=', '--no-color', '-p'], {
      cwd: repo, encoding: 'utf-8', stdio: 'pipe', maxBuffer: 100 * 1024 * 1024,
    });
  } catch { return new Map(); }
  return parseCommitDiffByFile(out);
}

// per-commit 批量取多文件 content + addedLines（2 次 exec）。paths 不含 binary（调用方过滤）。
export function getCommitBlameInputsBatch(repo, hash, paths) {
  const result = new Map();
  if (!repo || !hash || !paths?.length) return result;
  for (const p of paths) result.set(p, { commitContent: null, addedLines: null });
  const contents = gitCatFileBatch(repo, paths.map(p => `${hash}:${p}`));
  const addedByPath = getCommitAddedLinesAll(repo, hash);
  for (const p of paths) {
    const content = contents.get(`${hash}:${p}`);
    if (content === null || content === undefined) continue; // 取不到保持 null → 上层降级
    result.set(p, { commitContent: content, addedLines: addedByPath.get(p) || [] });
  }
  return result;
}

// ── AI commit 检测 ──

const BODY_END = '@@ENDBODY@@';

const DEFAULT_AI_PATTERNS = [
  // Claude
  { re: /Co-Authored-By:\s*Claude/i, signal: 'coAuthor' },
  { re: /Generated\s+with[\s\S]*Claude/i, signal: 'generatedWith' },
  { re: /🤖\s*Generated/i, signal: 'robotEmoji' },
  { re: /Assisted-By:\s*Claude/i, signal: 'assistedBy' },
  // GitHub Copilot
  { re: /Co-Authored-By:\s*Copilot/i, signal: 'coAuthorCopilot' },
  { re: /Co-Authored-By:\s*GitHub Copilot/i, signal: 'coAuthorCopilot' },
  // Cursor
  { re: /Co-Authored-By:\s*Cursor/i, signal: 'coAuthorCursor' },
  // Aider
  { re: /Generated\s+with[\s\S]*Aider/i, signal: 'generatedWithAider' },
  { re: /\(aider\)/i, signal: 'aiderTag' },
  { re: /\[Aider\]/i, signal: 'aiderTag' },
  // Codex
  { re: /Co-Authored-By:\s*Codex/i, signal: 'coAuthorCodex' },
  { re: /Generated\s+with[\s\S]*Codex/i, signal: 'generatedWithCodex' },
  // OpenCode
  { re: /Co-Authored-By:\s*OpenCode/i, signal: 'coAuthorOpencode' },
  // Windsurf
  { re: /Co-Authored-By:\s*Windsurf/i, signal: 'coAuthorWindsurf' },
  // Augment
  { re: /Co-Authored-By:\s*Augment/i, signal: 'coAuthorAugment' },
  // Cline / Roo Code
  { re: /Co-Authored-By:\s*Cline/i, signal: 'coAuthorCline' },
  { re: /Co-Authored-By:\s*Roo\s*Code/i, signal: 'coAuthorRooCode' },
  { re: /\(cline\)/i, signal: 'clineTag' },
  { re: /\[cline\]/i, signal: 'clineTag' },
  // JetBrains AI
  { re: /Co-Authored-By:\s*JetBrains\s*AI/i, signal: 'coAuthorJetbrains' },
  // Generic AI markers
  { re: /\bAI[\s_-]?generated\b/i, signal: 'aiGenerated' },
  { re: /\bgenerated\s+by\s+(AI|Claude|GPT|LLM)\b/i, signal: 'generatedByAI' },
  { re: /\bvia\s+(Claude|GPT|AI|Copilot)\b/i, signal: 'viaAI' },
  { re: /\[AI\]/i, signal: 'aiTag' },
  { re: /\(AI\)/i, signal: 'aiTag' },
  // AI-Metrics trailer（含 total-lines/total-files）：任何工具都可能通过 skill/hook 注入，
  // 归为 generic-ai 泛类（非具体工具）；具体工具由 session 等证据决定
  { re: /^AI-Metrics:$/m, signal: 'aiMetrics' },
];

// 信号 → 工具归属映射
const SIGNAL_TO_TOOL = {
  // Claude
  coAuthor: 'claude',
  generatedWith: 'claude',
  robotEmoji: 'claude',
  assistedBy: 'claude',
  authorClaude: 'claude',
  // Copilot
  coAuthorCopilot: 'copilot',
  authorCopilot: 'copilot',
  // Cursor
  coAuthorCursor: 'cursor',
  // Codex
  coAuthorCodex: 'codex',
  generatedWithCodex: 'codex',
  // OpenCode
  coAuthorOpencode: 'opencode',
  // Aider
  generatedWithAider: 'aider',
  aiderTag: 'aider',
  authorAider: 'aider',
  // Windsurf
  coAuthorWindsurf: 'windsurf',
  // Augment
  coAuthorAugment: 'augment',
  // Cline / Roo Code
  coAuthorCline: 'cline',
  coAuthorRooCode: 'roo-code',
  clineTag: 'cline',
  // JetBrains AI
  coAuthorJetbrains: 'jetbrains-ai',
  // Generic AI
  aiGenerated: 'generic-ai',
  generatedByAI: 'generic-ai',
  viaAI: 'generic-ai',
  aiTag: 'generic-ai',
  authorAI: 'generic-ai',
  aiMetrics: 'generic-ai',
};

const AI_PATTERNS = [...DEFAULT_AI_PATTERNS, ...loadCustomPatterns()];

const AI_CONFIDENCE = {
  NONE: 'none',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
};

function isCountedAIConfidence(confidence) {
  return confidence === AI_CONFIDENCE.HIGH || confidence === AI_CONFIDENCE.MEDIUM;
}

// 从信号列表推导工具归属：优先具体工具，其次 generic-ai
function resolveToolFromSignals(signals) {
  for (const sig of signals) {
    const tool = SIGNAL_TO_TOOL[sig];
    if (tool && tool !== 'generic-ai') return tool;
  }
  for (const sig of signals) {
    if (SIGNAL_TO_TOOL[sig]) return SIGNAL_TO_TOOL[sig];
  }
  return null;
}

function createAIAttribution({ confidence = AI_CONFIDENCE.NONE, signals = [], attributionType = null, detectedTool = null, negativeSignals = [] } = {}) {
  const normalizedSignals = [...new Set(signals)];
  return {
    isAI: isCountedAIConfidence(confidence),
    aiAssisted: confidence !== AI_CONFIDENCE.NONE,
    aiConfidence: confidence,
    signals: normalizedSignals,
    aiSignals: normalizedSignals,
    aiEvidence: normalizedSignals,
    attributionType,
    detectedTool,
    negativeSignals,
  };
}

function pickHigherConfidence(a, b) {
  const order = {
    [AI_CONFIDENCE.NONE]: 0,
    [AI_CONFIDENCE.LOW]: 1,
    [AI_CONFIDENCE.MEDIUM]: 2,
    [AI_CONFIDENCE.HIGH]: 3,
  };
  return (order[b] || 0) > (order[a] || 0) ? b : a;
}

function buildEvidenceDetails({
  matchedFiles = [],
  touchedFiles = [],
  fileOverlapRatio = 0,
  commitFileCount = 0,
  touchedFileCount = 0,
} = {}) {
  return {
    matchedFiles,
    matchedFileCount: matchedFiles.length,
    touchedFileCount,
    commitFileCount,
    fileOverlapRatio,
    touchedFiles,
  };
}

// 检测正则中可能导致回溯爆炸的危险模式
function isSafeRegex(pattern) {
  // 限制最大长度
  if (pattern.length > 200) return false;
  // 嵌套量词：如 (a+)+, (a*){2,}, (a{1,3})+
  if (/\([^)]*[+*{][^)]*\)[+*{]/.test(pattern)) return false;
  // 交替+量词：如 (a|b)*, (foo|bar)+
  if (/\([^)]*\|[^)]*\)[+*{]/.test(pattern)) return false;
  // 字符类后跟量词且字符类内含量词：如 [\w+]* — 模糊但潜在危险
  if (/\[[^\]]+\][+*{]/.test(pattern) && /\[[^\]]*[*+]/.test(pattern)) return false;
  // 重复量词：如 a** 或 a++ (有些引擎报错但不应依赖)
  if (/[+*{]\s*[+*{]/.test(pattern)) return false;
  return true;
}

function loadCustomPatterns() {
  try {
    const configPath = join(process.cwd(), 'ai-patterns.json');
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      return raw
        .filter(p => typeof p.re === 'string' && typeof p.signal === 'string')
        .filter(p => {
          if (!isSafeRegex(p.re)) {
            console.warn(`[git] 跳过不安全正则: ${p.re.slice(0, 50)}`);
            return false;
          }
          return true;
        })
        .map(p => ({ re: new RegExp(p.re, p.flags || 'i'), signal: p.signal }));
    }
  } catch { /* ignore */ }
  return [];
}

function loadAttributionOverrides() {
  // .lumencode 为新品牌路径；.ccusage 回退兼容老用户已存在的 override 文件
  const candidates = [
    join(process.cwd(), '.lumencode', 'attribution-overrides.json'),
    join(process.cwd(), '.ccusage', 'attribution-overrides.json'),
  ];
  const overridePath = candidates.find(existsSync);
  if (!overridePath) return { commits: {}, files: {} };
  try {
    const raw = JSON.parse(readFileSync(overridePath, 'utf-8'));
    return {
      commits: raw.commits && typeof raw.commits === 'object' ? raw.commits : {},
      files: raw.files && typeof raw.files === 'object' ? raw.files : {},
    };
  } catch {
    return { commits: {}, files: {} };
  }
}

// ── Style-based heuristic detection (fallback when no explicit signals) ──

const IMPERATIVE_VERBS = /^(?:add|fix|update|remove|refactor|implement|create|delete|replace|rename|move|extract|improve|optimize|simplify|restructure|rewrite|migrate|upgrade|downgrade|revert|bump|clean|format|lint|docs?|test|build|ci|chore|perf|style|init|setup|config|configure|enable|disable|support|handle|ensure|validate|verify|check|detect|parse|compute|merge|split|group|sort|filter|map|reduce|export|import|load|save|read|write|reset|toggle|switch|convert|transform|wrap|unwrap|escape|unescape|encode|decode|serialize|deserialize|compress|decompress|encrypt|decrypt|hash|sign|verify|auth|login|logout|register|unregister|subscribe|unsubscribe|connect|disconnect|bind|unbind|attach|detach|mount|unmount|open|close|show|hide|display|render|draw|paint|print|log|trace|debug|info|warn|error|fatal|throw|catch|retry|abort|cancel|timeout|expire|flush|clear|reset|restore|backup|archive|deploy|release|publish|install|uninstall)\b/i;

function detectStyleSignals(subject, body) {
  const signals = [];
  let score = 0;

  // Bullet list: 3+ lines starting with "- " or "* "
  const bulletLines = (body || '').split('\n').filter(l => /^\s*[-*]\s+\S/.test(l));
  if (bulletLines.length >= 3) {
    signals.push('styleBulletList');
    score += 2;
  }

  // Conventional commit with scope: type(scope): subject
  if (CONVENTIONAL_RE.test(subject)) {
    const m = subject.match(CONVENTIONAL_RE);
    if (m && m[2]) {
      signals.push('styleConventionalScope');
      score += 1;
    }
  }

  // Long structured body: >150 chars with 3+ non-empty lines
  const bodyLines = (body || '').split('\n').filter(l => l.trim());
  if ((body || '').length > 150 && bodyLines.length >= 3) {
    signals.push('styleLongStructuredBody');
    score += 1;
  }

  // Technical detail: body contains file paths or parenthetical notes
  if (/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.[a-z]{1,4}/.test(body) || /\([^)]{10,}\)/.test(body)) {
    signals.push('styleTechnicalDetail');
    score += 1;
  }

  // Imperative mood: 3+ body lines start with imperative verbs (strip bullet prefix first)
  const imperativeCount = bodyLines.filter(l => IMPERATIVE_VERBS.test(l.trim().replace(/^[-*]\s+/, ''))).length;
  if (imperativeCount >= 3) {
    signals.push('styleImperativeMood');
    score += 1;
  }

  return { signals, score };
}

// ── Negative signals (reduce false positives) ──

const WIP_RE = /\b(?:wip|draft|todo|temp|tmp|hack|quick)\b/i;
const MERGE_RE = /^Merge\s+(?:branch|pull|remote|tag)/i;

export function detectNegativeSignals(subject, body, linesAdded, linesDeleted, fileCount) {
  const signals = [];
  const trimmedBody = (body || '').trim();
  const trimmedSubject = (subject || '').trim();
  const totalLines = (linesAdded || 0) + (linesDeleted || 0);
  const files = fileCount || 0;

  // Informal: very short subject AND body, no conventional commit prefix
  const isConventional = CONVENTIONAL_RE.test(trimmedSubject);
  if (trimmedSubject.length <= 10 && trimmedBody.length <= 10 && !/\n/.test(trimmedBody) && !isConventional) {
    signals.push('humanInformal');
  }
  if (MERGE_RE.test(trimmedSubject)) {
    signals.push('humanMergeCommit');
  }
  if (totalLines <= 2 && files <= 1) {
    signals.push('humanSmallScope');
  }
  if (WIP_RE.test(trimmedSubject)) {
    signals.push('humanWIP');
  }
  return signals;
}

// ── Developer behavioral baseline ──

function computeAuthorBaseline(commitList) {
  const authorStats = new Map();
  for (const c of commitList || []) {
    const email = c.author || 'unknown';
    if (!authorStats.has(email)) {
      authorStats.set(email, {
        count: 0, totalSubjectLen: 0, totalBodyLen: 0,
        bulletCount: 0, convCount: 0, totalFiles: 0, totalLines: 0,
      });
    }
    const s = authorStats.get(email);
    s.count++;
    s.totalSubjectLen += (c.subject || '').length;
    s.totalBodyLen += (c.body || '').length;
    s.totalFiles += (c.files || []).length;
    s.totalLines += (c.linesAdded || 0) + (c.linesDeleted || 0);
    if (/^\s*[-*]\s+\S/m.test(c.body || '')) s.bulletCount++;
    if (CONVENTIONAL_RE.test(c.subject)) s.convCount++;
  }
  const baselines = new Map();
  for (const [email, s] of authorStats) {
    if (s.count < 3) { baselines.set(email, null); continue; }
    baselines.set(email, {
      avgSubjectLen: s.totalSubjectLen / s.count,
      avgBodyLen: s.totalBodyLen / s.count,
      bulletRatio: s.bulletCount / s.count,
      convRatio: s.convCount / s.count,
      avgFiles: s.totalFiles / s.count,
      avgLines: s.totalLines / s.count,
    });
  }
  return baselines;
}

function computeBaselineDeviation(commit, baseline) {
  if (!baseline) return 0;
  let deviation = 0;
  let factors = 0;
  const body = commit.body || '';

  if (baseline.avgBodyLen > 0) {
    const ratio = body.length / baseline.avgBodyLen;
    deviation += ratio > 2 ? 0.3 : (ratio > 1.5 ? 0.15 : 0);
    factors++;
  }
  const hasBullets = /^\s*[-*]\s+\S/m.test(body);
  if (baseline.bulletRatio < 0.1 && hasBullets) { deviation += 0.3; factors++; }
  const fileCount = (commit.files || []).length;
  if (baseline.avgFiles > 0) {
    const ratio = fileCount / baseline.avgFiles;
    deviation += ratio > 3 ? 0.2 : (ratio > 2 ? 0.1 : 0);
    factors++;
  }
  const lineCount = (commit.linesAdded || 0) + (commit.linesDeleted || 0);
  if (baseline.avgLines > 0) {
    const ratio = lineCount / baseline.avgLines;
    deviation += ratio > 3 ? 0.2 : (ratio > 2 ? 0.1 : 0);
    factors++;
  }

  return factors > 0 ? Math.min(deviation / factors, 1) : 0;
}

// ── Composite continuous scoring ──

function computeContinuousScore(commit, attributionOptions) {
  let score = 0;
  const signals = new Set(commit.aiSignals || []);
  const weights = attributionOptions.scoreWeights;

  // Explicit signatures
  if (signals.has('coAuthor') || signals.has('generatedWith') || signals.has('assistedBy')) score += weights.explicitSignature;
  if (signals.has('coAuthorCopilot') || signals.has('coAuthorCursor') || signals.has('coAuthorCodex')) score += weights.explicitSignature;
  if (signals.has('robotEmoji') || signals.has('coAuthorOpencode')) score += weights.explicitSignature;
  if (signals.has('authorClaude') || signals.has('authorBot')) score += weights.explicitAuthor;
  if (signals.has('generatedWithAider') || signals.has('aiderTag')) score += weights.explicitSignature;
  if (signals.has('generatedWithCodex') || signals.has('coAuthorCodex')) score += weights.explicitSignature;
  if (signals.has('coAuthorWindsurf') || signals.has('coAuthorAugment') || signals.has('coAuthorCline')) score += weights.explicitSignature;
  if (signals.has('aiGenerated') || signals.has('generatedByAI') || signals.has('viaAI') || signals.has('aiTag') || signals.has('aiMetrics')) score += weights.genericAISignature;

  // Session signals
  if (commit.sessionAttribution === 'strong') score += weights.sessionStrong;
  else if (commit.sessionAttribution === 'cross-day') score += weights.sessionCrossDay;
  else if (commit.sessionAttribution === 'weak') score += weights.sessionWeak;
  else if (commit.sessionAttribution === 'cross-day-weak') score += weights.sessionCrossDayWeak;

  // File overlap
  const overlap = commit.aiEvidenceDetails?.fileOverlapRatio || 0;
  score += overlap * weights.fileOverlap;

  // Style heuristic
  if (signals.has('styleBulletList')) score += weights.styleBulletList;
  if (signals.has('styleConventionalScope')) score += weights.styleConventionalScope;
  if (signals.has('styleImperativeMood')) score += weights.styleImperativeMood;
  if (signals.has('styleLongStructuredBody')) score += weights.styleLongStructuredBody;

  // Baseline deviation
  if (signals.has('baselineDeviationHigh')) score += weights.baselineDeviationHigh;
  else if (signals.has('baselineDeviationMedium')) score += weights.baselineDeviationMedium;

  // Negative signals
  const negSignals = new Set(commit.negativeSignals || []);
  if (negSignals.has('humanMergeCommit')) score += weights.negativeMergeCommit;
  if (negSignals.has('humanInformal')) score += weights.negativeInformal;
  if (negSignals.has('humanSmallScope')) score += weights.negativeSmallScope;
  if (negSignals.has('humanWIP')) score += weights.negativeWIP;

  // Baseline match (human pattern)
  if (signals.has('humanBaselineMatch')) score += weights.humanBaselineMatch;

  return Math.max(0, Math.min(1, score));
}

function scoreToConfidence(score, attributionOptions) {
  const thresholds = attributionOptions.confidenceThresholds;
  if (score >= thresholds.high) return AI_CONFIDENCE.HIGH;
  if (score >= thresholds.medium) return AI_CONFIDENCE.MEDIUM;
  if (score >= thresholds.low) return AI_CONFIDENCE.LOW;
  return AI_CONFIDENCE.NONE;
}

export function detectAICommit(subject = '', author = '', body = '') {
  const haystack = `${subject}\n${body}`;
  const signals = [];
  for (const { re, signal } of AI_PATTERNS) {
    if (re.test(haystack)) signals.push(signal);
  }
  const authorLower = (author || '').toLowerCase();
  if (authorLower.includes('claude') || authorLower.includes('noreply@anthropic')) {
    signals.push('authorClaude');
  }
  if (authorLower.includes('copilot')) {
    signals.push('authorCopilot');
  }
  if (authorLower.includes('github-actions') || authorLower.includes('dependabot')) {
    signals.push('authorBot');
  }
  if (authorLower.includes('aider')) {
    signals.push('authorAider');
  }
  if (authorLower.includes('codeium') || authorLower.includes('tabnine')) {
    signals.push('authorAI');
  }
  if (authorLower.includes('augment')) {
    signals.push('coAuthorAugment');
  }
  if (authorLower.includes('cline')) {
    signals.push('coAuthorCline');
  }
  if (signals.length > 0) {
    const detectedTool = resolveToolFromSignals(signals);
    return createAIAttribution({
      confidence: AI_CONFIDENCE.HIGH,
      signals,
      attributionType: 'explicit',
      detectedTool,
    });
  }

  // Negative signals: skip style heuristic for obvious human patterns
  // Only check message-level signals here (line/file counts not available)
  const subjectNeg = (subject || '').trim();
  const bodyNeg = (body || '').trim();
  const negSignals = [];
  const isConvSubject = CONVENTIONAL_RE.test(subjectNeg);
  if (subjectNeg.length <= 10 && bodyNeg.length <= 10 && !/\n/.test(bodyNeg) && !isConvSubject) negSignals.push('humanInformal');
  if (/^Merge\s+(?:branch|pull|remote|tag)/i.test(subjectNeg)) negSignals.push('humanMergeCommit');
  if (/\b(?:wip|draft|todo|temp|tmp|hack|quick)\b/i.test(subjectNeg)) negSignals.push('humanWIP');
  if (negSignals.length > 0) {
    return createAIAttribution({ negativeSignals: negSignals });
  }

  // Fallback: style-based heuristic detection
  const { signals: styleSignals, score } = detectStyleSignals(subject, body);
  if (styleSignals.length > 0 && score >= 4) {
    const confidence = score >= 6 ? AI_CONFIDENCE.MEDIUM : AI_CONFIDENCE.LOW;
    return createAIAttribution({
      confidence,
      signals: styleSignals,
      attributionType: score >= 6 ? 'style_heuristic_strong' : 'style_heuristic',
      detectedTool: null,
    });
  }

  return createAIAttribution();
}

// ── 聚合函数 ──

export function computeAIContribution(commits, toolFilter = null, options = {}) {
  let aiCommits = 0, aiLinesAdded = 0, aiLinesDeleted = 0;
  let possibleAICommits = 0, possibleAILinesAdded = 0, possibleAILinesDeleted = 0;
  let weightedAILinesAdded = 0, weightedAILinesDeleted = 0;
  let aiCommitLinesAdded = 0, aiCommitLinesDeleted = 0;
  let aiFileLinesAdded = 0, aiFileLinesDeleted = 0;
  let highConfidenceCommits = 0, mediumConfidenceCommits = 0, lowConfidenceCommits = 0;
  let totalLinesAdded = 0, totalLinesDeleted = 0;
  const attributionOptions = resolveAttributionOptions(options.attribution || options);
  const confidenceWeights = attributionOptions.confidenceWeights;
  const allCommits = commits || [];
  const isMergeCommit = c => c.attributionType === 'human_merge';
  for (const c of allCommits) {
    // 合并提交不计入总行数分母，避免稀释 AI 占比
    if (isMergeCommit(c)) continue;
    // 分母用 effective 行数（排除 vendor/lockfile 等噪声文件），缺省回退 raw
    totalLinesAdded += c.effectiveLinesAdded ?? (c.linesAdded || 0);
    totalLinesDeleted += c.effectiveLinesDeleted ?? (c.linesDeleted || 0);
  }
  const filteredCommits = toolFilter
    ? allCommits.filter(c => c.attributedTool === toolFilter)
    : allCommits;
  for (const c of filteredCommits) {
    const confidence = c.aiConfidence || (c.isAI ? AI_CONFIDENCE.HIGH : AI_CONFIDENCE.NONE);
    if (confidence === AI_CONFIDENCE.HIGH) highConfidenceCommits++;
    else if (confidence === AI_CONFIDENCE.MEDIUM) mediumConfidenceCommits++;
    else if (confidence === AI_CONFIDENCE.LOW) lowConfidenceCommits++;

    // 计算文件级行数（用于 HIGH/MEDIUM/LOW 各自统计）；遍历 effective 文件（已排除 vendor）
    const matchedFiles = new Set((c.aiEvidenceDetails?.matchedFiles || []).map(normalizeCommitFilePath));
    const useMatchedFiles = matchedFiles.size > 0;
    const sourceFiles = c.effectiveFiles || c.files || [];
    let fileAdded = 0;
    let fileDeleted = 0;
    for (const f of sourceFiles) {
      const filePath = normalizeCommitFilePath(f.path);
      if (useMatchedFiles && !matchedFiles.has(filePath)) continue;
      fileAdded += f.added || 0;
      fileDeleted += f.deleted || 0;
    }
    if (!useMatchedFiles && (c.attributionType === 'explicit' || c.attributionType?.startsWith('session_'))) {
      fileAdded = c.effectiveLinesAdded ?? (c.linesAdded || 0);
      fileDeleted = c.effectiveLinesDeleted ?? (c.linesDeleted || 0);
    }

    // Step blame refines file evidence. Keep precise line attribution for
    // covered files, then add matched files that step tracking did not cover.
    if (c.lineBlame) {
      const blamedFiles = new Set(Object.keys(c.lineBlame.fileBreakdown || {}).map(normalizeCommitFilePath));
      fileAdded = c.lineBlame.aiLines || 0;
      fileDeleted = c.lineBlame.aiDeletedLines || 0;
      if (useMatchedFiles) {
        for (const f of sourceFiles) {
          const filePath = normalizeCommitFilePath(f.path);
          if (!matchedFiles.has(filePath) || blamedFiles.has(filePath)) continue;
          fileAdded += f.added || 0;
          fileDeleted += f.deleted || 0;
        }
      }
    }

    if (isCountedAIConfidence(confidence)) {
      aiCommits++;
      aiCommitLinesAdded += c.effectiveLinesAdded ?? (c.linesAdded || 0);
      aiCommitLinesDeleted += c.effectiveLinesDeleted ?? (c.linesDeleted || 0);
      aiFileLinesAdded += fileAdded;
      aiFileLinesDeleted += fileDeleted;
    } else if (confidence === AI_CONFIDENCE.LOW) {
      possibleAICommits++;
      possibleAILinesAdded += fileAdded;
      possibleAILinesDeleted += fileDeleted;
    }

    // 加权计算：所有归因的 commit 都参与（包括 LOW）
    const weight = confidenceWeights[confidence] || 0;
    if (weight > 0) {
      weightedAILinesAdded += fileAdded * weight;
      weightedAILinesDeleted += fileDeleted * weight;
    }
  }
  aiLinesAdded = aiFileLinesAdded;
  aiLinesDeleted = aiFileLinesDeleted;
  // merge 提交不计入 commit 维度分母（与行维度 totalLinesChanged 口径一致）
  const total = allCommits.filter(c => !isMergeCommit(c)).length;
  const totalLinesChanged = totalLinesAdded + totalLinesDeleted;
  const aiLinesChanged = aiLinesAdded + aiLinesDeleted;
  const possibleAILinesChanged = possibleAILinesAdded + possibleAILinesDeleted;
  const weightedAILinesChanged = Math.round(weightedAILinesAdded + weightedAILinesDeleted);
  return {
    aiCommits,
    possibleAICommits,
    nonToolCommits: total - aiCommits - possibleAICommits,
    humanCommits: total - aiCommits - possibleAICommits,
    aiCommitRatio: total > 0 ? aiCommits / total : 0,
    possibleAICommitRatio: total > 0 ? possibleAICommits / total : 0,
    aiRatio: totalLinesChanged > 0 ? aiLinesChanged / totalLinesChanged : 0,
    aiLineRatio: totalLinesChanged > 0 ? aiLinesChanged / totalLinesChanged : 0,
    possibleAILineRatio: totalLinesChanged > 0 ? possibleAILinesChanged / totalLinesChanged : 0,
    weightedAILineRatio: totalLinesChanged > 0 ? weightedAILinesChanged / totalLinesChanged : 0,
    toolFilter: toolFilter || null,
    aiLinesAdded,
    aiLinesDeleted,
    aiLinesChanged,
    possibleAILinesAdded,
    possibleAILinesDeleted,
    possibleAILinesChanged,
    weightedAILinesAdded: Math.round(weightedAILinesAdded),
    weightedAILinesDeleted: Math.round(weightedAILinesDeleted),
    weightedAILinesChanged,
    totalLinesAdded,
    totalLinesDeleted,
    totalLinesChanged,
    aiCommitLinesAdded,
    aiCommitLinesDeleted,
    aiFileLinesAdded,
    aiFileLinesDeleted,
    highConfidenceCommits,
    mediumConfidenceCommits,
    lowConfidenceCommits,
  };
}

export function computeAttributionQuality(commits = []) {
  const blamed = (commits || []).filter(c => c.lineBlame?.source === 'step_blame');
  if (blamed.length === 0) return null;

  let mappedAddedLines = 0;
  let mappableAddedLines = 0;
  let unknownLines = 0;
  let unknownDeletedLines = 0;
  let totalLines = 0;
  let alignedFiles = 0;
  let fuzzyFiles = 0;
  let degradedFiles = 0;

  for (const c of blamed) {
    const lb = c.lineBlame || {};
    mappedAddedLines += lb.mappedAddedLines || 0;
    mappableAddedLines += lb.mappableAddedLines || 0;
    unknownLines += lb.unknownLines || 0;
    unknownDeletedLines += lb.unknownDeletedLines || 0;
    totalLines += lb.totalLines || 0;
    alignedFiles += lb.alignedFiles || 0;
    fuzzyFiles += lb.fuzzyFiles || 0;
    degradedFiles += lb.degradedFiles || 0;
  }

  const lineCoverage = mappableAddedLines > 0 ? mappedAddedLines / mappableAddedLines : 0;
  const confidence = lineCoverage >= 0.9
    ? 'high'
    : lineCoverage >= 0.6
      ? 'medium'
      : lineCoverage > 0
        ? 'low'
        : 'none';

  return {
    totalLineBlameCommits: blamed.length,
    mappedAddedLines,
    mappableAddedLines,
    unknownLines,
    unknownDeletedLines,
    totalLines,
    lineCoverage,
    confidence,
    alignedFiles,
    fuzzyFiles,
    degradedFiles,
  };
}

export function computeCommitTypes(commits) {
  const types = {};
  for (const t of CONVENTIONAL_TYPES) types[t] = 0;
  types.other = 0;
  for (const c of commits || []) {
    const t = c.type || 'other';
    types[t] = (types[t] || 0) + 1;
  }
  return types;
}

export function computeFileHotspots(commits, topN = 10) {
  const map = new Map();
  for (const c of commits || []) {
    for (const f of c.files || []) {
      if (!map.has(f.path)) {
        map.set(f.path, { path: f.path, touches: 0, added: 0, deleted: 0 });
      }
      const e = map.get(f.path);
      e.touches++;
      e.added += f.added || 0;
      e.deleted += f.deleted || 0;
    }
  }
  return [...map.values()]
    .sort((a, b) => b.touches - a.touches || (b.added + b.deleted) - (a.added + a.deleted))
    .slice(0, topN);
}

// 哨兵格式（v2 含 body）：§§§hash|isoDate|email|subject → body 行 → @@ENDBODY@@ → numstat 行
// 哨兵格式（v1 无 body）：§§§hash|isoDate|email|subject → numstat 行
// numstat（added\tdeleted\tpath），其中 binary 文件为 -\t-\tpath
export function parseGitLogOutput(output, repo = '') {
  const result = emptyResult();
  const uniqueFiles = new Set();
  let current = null;
  let inBody = false;

  const flush = () => {
    if (!current) return;
    // 使用本地日期做 daily stats key（用户期望看到的日期），
    // UTC 日期（current.date）仅用于与 session 时间戳比较
    const dateKey = current.dateLocal || current.date.slice(0, 10);
    // 注入 conventional 类型 + AI 信号
    const conv = parseConventional(current.subject);
    const ai = detectAICommit(current.subject, current.author, current.body || '');
    current.type = conv.type;
    current.scope = conv.scope;
    current.isBreaking = conv.isBreaking;
    current.isAI = ai.isAI;
    current.aiAssisted = ai.aiAssisted;
    current.aiConfidence = ai.aiConfidence;
    current.aiSignals = ai.signals;
    current.aiEvidence = ai.aiEvidence;
    current.attributionType = ai.attributionType;
    current.detectedTool = ai.detectedTool || null;
    current.negativeSignals = ai.negativeSignals || [];
    current.sessionId = null; // 由 finalize 阶段填充

    result.commits++;
    result.commitsByDate[dateKey] = (result.commitsByDate[dateKey] || 0) + 1;
    if (!result.linesByDate[dateKey]) {
      result.linesByDate[dateKey] = { added: 0, deleted: 0, files: 0 };
    }
    result.linesByDate[dateKey].added += current.linesAdded;
    result.linesByDate[dateKey].deleted += current.linesDeleted;
    result.linesByDate[dateKey].files += current.files.length;
    result.linesAdded += current.linesAdded;
    result.linesDeleted += current.linesDeleted;
    for (const f of current.files) uniqueFiles.add(f.path);
    result.commitList.push(current);
    current = null;
    inBody = false;
  };

  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '');

    // body 结束标记
    if (line.trim() === BODY_END) {
      inBody = false;
      continue;
    }

    if (line.startsWith(COMMIT_SENTINEL)) {
      flush();
      const header = line.slice(COMMIT_SENTINEL.length);
      const parts = header.split('|');
      const hash = parts[0] || '';
      const dateRaw = (parts[1] || '');
      // 保留本地日期用于 commitsByDate（用户看到的日期）
      const dateLocal = dateRaw.slice(0, 10) || '';
      // Normalize to UTC ISO for consistent comparison with session timestamps
      const dateMs = Date.parse(dateRaw);
      const date = Number.isFinite(dateMs)
        ? new Date(dateMs).toISOString().slice(0, 19) + 'Z'
        : dateRaw.slice(0, 19);
      const author = parts[2] || '';
      const subject = parts.slice(3).join('|');
      current = {
        repo,
        hash,
        date,
        dateLocal,
        author,
        subject,
        body: '',
        linesAdded: 0,
        linesDeleted: 0,
        files: [],
      };
      // v2 格式：body 段会由 BODY_END 标记结束
      // v1 格式：没有 BODY_END，inBody 保持 false，numstat 直接解析
      inBody = false;
      continue;
    }

    if (!current) continue;

    // numstat 行
    const m = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
    if (m) {
      // 如果之前没有见过 BODY_END，说明是 v1 格式（无 body），直接解析 numstat
      // 如果已经过了 BODY_END（inBody=false），也直接解析
      if (!inBody) {
        const added = m[1] === '-' ? 0 : parseInt(m[1], 10);
        const deleted = m[2] === '-' ? 0 : parseInt(m[2], 10);
        const binary = m[1] === '-' && m[2] === '-';
        const path = m[3];
        current.files.push({ path, added, deleted, binary });
        current.linesAdded += added;
        current.linesDeleted += deleted;
      } else {
        // numstat 格式的行出现在 body 段内（不太可能，但安全处理）
        if (line.trim()) {
          current.body += (current.body ? '\n' : '') + line;
        }
      }
    } else if (inBody) {
      // body 内容
      if (line.trim()) {
        current.body += (current.body ? '\n' : '') + line;
      }
    } else {
      // v2 格式：非 numstat、非哨兵、非 BODY_END → 进入 body 段
      if (line.trim()) {
        current.body += (current.body ? '\n' : '') + line;
        inBody = true;
      }
    }
  }
  flush();

  result.filesChanged = uniqueFiles.size;
  return result;
}

// argv 形式：每个参数独立元素，不过 shell，since/until 原样传递无需转义。
// 格式：哨兵行(subject) → body 行(可多行) → ENDBODY 行 → numstat 行
function buildGitArgs(since, until) {
  const sinceFull = since.includes('T') ? since : since + 'T00:00:00';
  return [
    'log', '--all', '--no-renames',
    `--pretty=format:${COMMIT_SENTINEL}%H|%ad|%ae|%s%n%B${BODY_END}`,
    '--date=iso-strict', '--numstat',
    `--since=${sinceFull}`, `--until=${until}`,
  ];
}

function mergeGitStats(target, source) {
  target.commits += source.commits;
  target.linesAdded += source.linesAdded;
  target.linesDeleted += source.linesDeleted;
  for (const [d, c] of Object.entries(source.commitsByDate)) {
    target.commitsByDate[d] = (target.commitsByDate[d] || 0) + c;
  }
  if (source.linesByDate) {
    for (const [d, v] of Object.entries(source.linesByDate)) {
      if (!target.linesByDate[d]) target.linesByDate[d] = { added: 0, deleted: 0, files: 0 };
      target.linesByDate[d].added += v.added;
      target.linesByDate[d].deleted += v.deleted;
      target.linesByDate[d].files += v.files;
    }
  }
  if (source.commitList?.length) {
    target.commitList.push(...source.commitList);
  }
  // filesChanged 在 merge 完后由 finalize 重新计算（跨 repo 去重）
}

function recomputeFilesChanged(stats) {
  const set = new Set();
  for (const c of stats.commitList || []) {
    for (const f of c.files || []) set.add((c.repo || '') + '::' + f.path);
  }
  stats.filesChanged = set.size;
}

function recomputeStatsFromCommitList(stats) {
  stats.commits = 0;
  stats.filesChanged = 0;
  stats.linesAdded = 0;
  stats.linesDeleted = 0;
  stats.commitsByDate = {};
  stats.linesByDate = {};

  for (const c of stats.commitList || []) {
    const dateKey = c.dateLocal || (c.date || '').slice(0, 10);
    stats.commits++;
    stats.commitsByDate[dateKey] = (stats.commitsByDate[dateKey] || 0) + 1;
    if (!stats.linesByDate[dateKey]) stats.linesByDate[dateKey] = { added: 0, deleted: 0, files: 0 };
    stats.linesByDate[dateKey].added += c.linesAdded || 0;
    stats.linesByDate[dateKey].deleted += c.linesDeleted || 0;
    stats.linesByDate[dateKey].files += (c.files || []).length;
    stats.linesAdded += c.linesAdded || 0;
    stats.linesDeleted += c.linesDeleted || 0;
  }
  recomputeFilesChanged(stats);
}

function markAuthorOwnership(stats, expectedAuthor) {
  const normalizedExpected = (expectedAuthor || '').toLowerCase();
  for (const c of stats.commitList || []) {
    c.expectedAuthor = expectedAuthor || null;
    c.authorMatchesConfig = normalizedExpected
      ? (c.author || '').toLowerCase() === normalizedExpected
      : null;
  }
}

function hasLocalSessionEvidence(commit) {
  if (!commit.sessionId) return false;
  if (commit.sessionAttribution === 'strong') return true;
  return (commit.aiEvidenceDetails?.matchedFileCount || 0) > 0;
}

function filterCommitsForUser(stats) {
  const commits = stats.commitList || [];
  const hasAuthorOwnershipMetadata = commits.some(c => c.expectedAuthor || c.authorMatchesConfig !== undefined);

  for (const c of commits) {
    c.countedForUser = !hasAuthorOwnershipMetadata
      || c.authorMatchesConfig === true
      || hasLocalSessionEvidence(c);
  }

  if (!hasAuthorOwnershipMetadata) return;
  stats.commitList = commits.filter(c => c.countedForUser);
  recomputeStatsFromCommitList(stats);
}

// ── async versions (server) with cache ──

const gitCache = new Map();
const GIT_CACHE_MAX = 500;
const GIT_CACHE_TTL = 60_000;
const CACHE_VERSION = 'v3';

function evictGitCache() {
  const now = Date.now();
  for (const [key, val] of gitCache) {
    if (now - val.ts > GIT_CACHE_TTL) gitCache.delete(key);
  }
  while (gitCache.size > GIT_CACHE_MAX) {
    const oldest = gitCache.keys().next().value;
    gitCache.delete(oldest);
  }
}

// ponytail: 行级归因结果缓存。commit 落盘后其时刻之前的 step 集合稳定，lineBlame 不变；
// 新 step 只影响未来 commit，故按 repo|hash 缓存安全。TTL 5min 兜底罕见的补录历史 step。
// 上限：若 steps.db 内容变化需强制失效，调 invalidateLineBlameCache()。
const lineBlameCache = new Map();
const LINE_BLAME_CACHE_TTL = 300_000;
const LINE_BLAME_CACHE_MAX = 500;
function evictLineBlameCache() {
  const now = Date.now();
  for (const [k, v] of lineBlameCache) {
    if (now - v.ts > LINE_BLAME_CACHE_TTL) lineBlameCache.delete(k);
  }
  while (lineBlameCache.size > LINE_BLAME_CACHE_MAX) {
    lineBlameCache.delete(lineBlameCache.keys().next().value);
  }
}
export function invalidateLineBlameCache() {
  lineBlameCache.clear();
}

async function getGitStatsAsync(repoPath, since, until, author = null) {
  const cacheKey = `${repoPath}|${since}|${until}|${CACHE_VERSION}`;
  const cached = gitCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < GIT_CACHE_TTL) return cached.stats;

  try {
    await spawnGit(['rev-parse', '--git-dir'], { cwd: repoPath });
  } catch {
    return emptyResult();
  }

  try {
    const output = await spawnGit(buildGitArgs(since, until), {
      cwd: repoPath, encoding: 'utf-8',
    });
    const stats = parseGitLogOutput(output, repoPath);
    markAuthorOwnership(stats, author);
    gitCache.set(cacheKey, { stats, ts: Date.now() });
    evictGitCache();
    return stats;
  } catch {
    return emptyResult();
  }
}

export async function getGitStatsForMultipleReposAsync(repos, since, until) {
  const results = await Promise.all(
    repos.map(repo => getGitStatsAsync(repo, since, until, getGitAuthor(repo)))
  );
  const merged = emptyResult();
  for (const stats of results) mergeGitStats(merged, stats);
  recomputeFilesChanged(merged);
  return merged;
}

// Per-repo git stats (unmerged), returns Map<repoPath, stats>
export async function getPerRepoGitStats(repos, since, until) {
  const results = await Promise.all(
    repos.map(async repo => {
      try {
        const stats = await getGitStatsAsync(repo, since, until, getGitAuthor(repo));
        return [repo, stats];
      } catch {
        return [repo, emptyResult()];
      }
    })
  );
  return new Map(results);
}

export function invalidateGitCache() {
  gitCache.clear();
}

// ── Session ↔ Commit 关联 ──

function looksLikeFilePath(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v || v.length < 3) return false;
  if (/\s{2,}/.test(v)) return false;
  if (/^(https?:|file:|data:)/i.test(v)) return false;
  return /^[a-zA-Z]:[\\/]/.test(v)
    || v.startsWith('/')
    || v.startsWith('./')
    || v.startsWith('../')
    || /[\\/]/.test(v)
    || /^[^\\/\s]+\.[a-z0-9]+$/i.test(v)
    || /^(dockerfile|makefile|license|readme(?:\.[a-z0-9]+)?)$/i.test(v);
}

function collectFilePaths(value, out = new Set(), seen = new Set(), parentKey = '') {
  if (value == null) return out;
  if (typeof value === 'string') {
    if (/(?:^|_)(?:file|path|paths|filename|filepath)s?$/i.test(parentKey) && looksLikeFilePath(value)) {
      out.add(value.trim());
    }
    return out;
  }
  if (typeof value !== 'object') return out;
  if (seen.has(value)) return out;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectFilePaths(item, out, seen, parentKey);
    return out;
  }

  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'string' && /(?:^|_)(?:file|path|paths|filename|filepath)s?$/i.test(key) && looksLikeFilePath(val)) {
      out.add(val.trim());
      continue;
    }
    collectFilePaths(val, out, seen, key);
  }
  return out;
}

// 从 Bash 命令中提取可能操作的文件路径
const BASH_FILE_COMMANDS = /\b(?:echo|cat|cp|mv|rm|touch|mkdir|sed|awk|grep|head|tail|tee|>|>>)\b/i;

function extractFilePathsFromBashCommand(command) {
  if (!command || typeof command !== 'string') return [];
  const paths = new Set();

  // 匹配重定向操作符后的文件路径: > file, >> file
  const redirectRe = /[12]?>>?\s+(['"]?)([^&|;\s<>$`'"\n]+)\1/g;
  let m;
  while ((m = redirectRe.exec(command)) !== null) {
    const p = m[2].trim();
    if (looksLikeFilePath(p)) paths.add(p);
  }

  // 匹配常见命令后的文件参数
  // cp/mv/touch/rm/mkdir/sed/awk 后的参数
  const words = command.split(/\s+/);
  let skipFlags = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // 跳过选项 (-flag, --flag)
    if (skipFlags || w.startsWith('-')) {
      if (/;|\||&&/.test(w)) skipFlags = false;
      continue;
    }
    // 遇到命令分隔符重置
    if (/^[;&|]$/.test(w) || w.endsWith(';')) {
      skipFlags = false;
      continue;
    }
    // 如果是命令名，跳过下一个词（通常是目标）之前的都是选项
    // 简单启发式：如果当前词是已知命令，则后面的非选项词可能是文件
    const cmdWords = ['cp', 'mv', 'touch', 'rm', 'mkdir', 'sed', 'awk', 'cat', 'tee', 'head', 'tail'];
    if (cmdWords.includes(w.toLowerCase())) {
      skipFlags = true;
      continue;
    }
    if (looksLikeFilePath(w)) {
      paths.add(w);
    }
  }

  return [...paths];
}

function extractTouchedFilesFromSession(session) {
  const repoPath = session.project || '';
  const files = new Set();
  for (const tc of session.toolSequence || []) {
    const name = tc.name || '';
    const input = tc.input || {};

    // Claude 内置工具：Write/Edit/NotebookEdit/MultiEdit
    if (name === 'Write' || name === 'Edit' || name === 'NotebookEdit' || name === 'MultiEdit') {
      const rawPaths = collectFilePaths(input);
      for (const rawPath of rawPaths) {
        const relative = normalizeCommitFilePath(toRepoRelativePath(rawPath, repoPath));
        if (relative) files.add(relative);
      }
      continue;
    }

    // MCP Serena 工具：replace_content, replace_symbol_body, insert_before/after_symbol 等
    // 以及其他带 relative_path/file_path 的 MCP 工具
    if (name.startsWith('mcp__serena') || name.startsWith('mcp__')) {
      // Serena 使用 relative_path，其他 MCP 工具可能使用 file_path/path
      const filePath = input.relative_path || input.file_path || input.path || '';
      if (filePath && typeof filePath === 'string') {
        const relative = normalizeCommitFilePath(toRepoRelativePath(filePath, repoPath));
        if (relative) files.add(relative);
      }
      // 部分 MCP 工具在 input 中嵌套了目标文件
      const rawPaths = collectFilePaths(input);
      for (const rawPath of rawPaths) {
        const relative = normalizeCommitFilePath(toRepoRelativePath(rawPath, repoPath));
        if (relative) files.add(relative);
      }
      continue;
    }

    // Bash 工具 — 从命令中提取文件路径
    if (name === 'Bash') {
      const cmd = input.command || '';
      const rawPaths = extractFilePathsFromBashCommand(cmd);
      for (const rawPath of rawPaths) {
        const relative = normalizeCommitFilePath(toRepoRelativePath(rawPath, repoPath));
        if (relative) files.add(relative);
      }
    }
  }
  return [...files].sort();
}

function computeFileOverlap(sessionTouchedFiles, commitFiles) {
  const touched = new Set((sessionTouchedFiles || []).map(normalizeCommitFilePath).filter(Boolean));
  const commitPaths = (commitFiles || []).map(f => normalizeCommitFilePath(f.path)).filter(Boolean);
  const matchedFiles = [...new Set(commitPaths.filter(p => touched.has(p)))];
  const commitFileCount = commitPaths.length;
  const touchedFileCount = touched.size;
  const fileOverlapRatio = commitFileCount > 0 ? matchedFiles.length / commitFileCount : 0;
  return buildEvidenceDetails({
    matchedFiles,
    touchedFiles: [...touched],
    fileOverlapRatio,
    commitFileCount,
    touchedFileCount,
  });
}

function sortAttributionCandidates(candidates) {
  return candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.distanceMs - b.distanceMs;
  });
}

function candidateFromSession(commit, session, distanceMs) {
  const overlap = computeFileOverlap(session.touchedFiles || [], commit.files || []);
  return scoreSessionCandidate(commit, session, {
    distanceMs,
    fileOverlapRatio: overlap.fileOverlapRatio,
    matchedFiles: overlap.matchedFiles,
    projectMatches: true,
  });
}

function getStepSessionIdCandidates(sessionId, session) {
  if (!sessionId) return [];
  const candidates = [sessionId];
  if (sessionId.includes(':')) return candidates;

  const originByTool = {
    claude: 'claude_code',
    codex: 'codex_cli',
    opencode: 'opencode',
    gemini: 'gemini',
  };
  const origin = originByTool[session?.primaryTool];
  if (origin) {
    candidates.push(`${origin}:${sessionId}`);
  } else {
    // primaryTool 未知时回退尝试全部已知 origin，含 opencode
    candidates.push(`claude_code:${sessionId}`, `codex_cli:${sessionId}`, `opencode:${sessionId}`);
  }

  return [...new Set(candidates)];
}

const BASH_GIT_COMMIT_RE = /\bgit\s+commit\b/i;
const STRONG_WINDOW_BEFORE_MS = 30 * 1000;       // 30s before bash invocation
const STRONG_WINDOW_AFTER_MS = 5 * 60 * 1000;    // 5min after

function toMs(iso) {
  if (!iso) return NaN;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
}

// 从 session.toolSequence 提取所有 `git commit` Bash/shell 调用时间戳
function extractCommitBashTimestamps(session) {
  const ts = [];
  for (const tc of session.toolSequence || []) {
    // Claude Code 使用 'Bash'，Codex 使用 'shell'
    if (tc.name !== 'Bash' && tc.name !== 'shell') continue;
    const cmd = tc.input?.command || tc.input?.cmd || '';
    if (BASH_GIT_COMMIT_RE.test(cmd)) {
      const ms = toMs(tc.timestamp);
      if (Number.isFinite(ms)) ts.push(ms);
    }
  }
  return ts;
}

export function attributeCommitsToSessions(commits, sessions, options = {}) {
  const result = { sessionCommitMap: {} };
  if (!commits?.length || !sessions?.length) return result;
  const attributionOptions = resolveAttributionOptions(options.attribution || options);
  const bufferMs = options.bufferMs ?? attributionOptions.windows.weakWindowMinutes * 60 * 1000;
  const crossDayMs = attributionOptions.windows.crossDayWindowDays * 24 * 3600 * 1000;

  // 预计算每个 session 的 ms 范围 + 项目归一化 + bash commit 时间戳
  const sIndex = sessions.map(s => ({
    id: s.id,
    projectN: normalizePathForGit(s.project || ''),
    startMs: toMs(s.startTime),
    endMs: toMs(s.endTime),
    bashTs: extractCommitBashTimestamps(s),
    touchedFiles: extractTouchedFilesFromSession(s),
    primaryTool: s.primaryTool,
  }));

  // 阶段 1：重置 + 强信号匹配（Bash git commit）
  for (const c of commits) {
    c.sessionId = null;
    c.sessionAttribution = null;
    const commitMs = toMs(c.date);
    const commitRepoN = normalizePathForGit(c.repo || '');
    if (!Number.isFinite(commitMs)) continue;

    let matched = null;
    for (const s of sIndex) {
      if (!s.bashTs.length) continue;
      if (!projectMatchesFromGitPaths(commitRepoN, s.projectN)) continue;
      for (const bts of s.bashTs) {
        if (commitMs >= bts - STRONG_WINDOW_BEFORE_MS && commitMs <= bts + STRONG_WINDOW_AFTER_MS) {
          matched = s;
          break;
        }
      }
      if (matched) break;
    }

    if (matched) {
      c.sessionId = matched.id;
      c.sessionAttribution = 'strong';
      if (!result.sessionCommitMap[matched.id]) result.sessionCommitMap[matched.id] = [];
      result.sessionCommitMap[matched.id].push(c.hash);
    }
  }

  // 从强信号匹配中收集每个 session 的已知 author 集合
  const sessionAuthors = new Map();
  for (const c of commits) {
    if (c.sessionAttribution === 'strong' && c.author) {
      const key = c.sessionId;
      if (!sessionAuthors.has(key)) sessionAuthors.set(key, new Set());
      sessionAuthors.get(key).add(c.author.toLowerCase());
    }
  }

  // 阶段 2：弱信号匹配 — commit 落在 session 时间窗 ± buffer，按中点距离取近
  // 如果 session 有已知 author（来自强信号匹配），则 commit author 必须一致
  for (const c of commits) {
    if (c.sessionAttribution) continue;
    const commitMs = toMs(c.date);
    const commitRepoN = normalizePathForGit(c.repo || '');
    if (!Number.isFinite(commitMs)) continue;

    const candidates = [];
    for (const s of sIndex) {
      if (!Number.isFinite(s.startMs) || !Number.isFinite(s.endMs)) continue;
      if (!projectMatchesFromGitPaths(commitRepoN, s.projectN)) continue;

      // author 一致性校验：session 有已知 author 时，commit author 必须匹配
      const knownAuthors = sessionAuthors.get(s.id);
      if (knownAuthors?.size && c.author && !knownAuthors.has(c.author.toLowerCase())) continue;

      const lo = s.startMs - bufferMs;
      const hi = s.endMs + bufferMs;
      if (commitMs < lo || commitMs > hi) continue;
      const mid = (s.startMs + s.endMs) / 2;
      const dist = Math.abs(commitMs - mid);
      candidates.push(candidateFromSession(c, s, dist));
    }

    if (candidates.length) {
      const ranked = sortAttributionCandidates(candidates);
      const best = sIndex.find(s => s.id === ranked[0].sessionId);
      c.attributionCandidates = ranked.slice(0, 3);
      c.sessionId = best.id;
      c.sessionAttribution = 'weak';
      if (!result.sessionCommitMap[best.id]) result.sessionCommitMap[best.id] = [];
      result.sessionCommitMap[best.id].push(c.hash);
    }
  }

  // 阶段 3：跨天项目匹配 — 未匹配的 commit 关联到同项目最近的 session
  // 场景：AI session 在 Day1，git commit 在 Day2+，时间窗无法覆盖
  for (const c of commits) {
    if (c.sessionAttribution) continue;
    const commitMs = toMs(c.date);
    const commitRepoN = normalizePathForGit(c.repo || '');
    if (!Number.isFinite(commitMs)) continue;

    const candidates = [];
    for (const s of sIndex) {
      if (!projectMatchesFromGitPaths(commitRepoN, s.projectN)) continue;
      if (!Number.isFinite(s.endMs)) continue;
      // commit 必须在 session 结束之后（不能是之前漏掉的）
      if (commitMs < s.endMs) continue;
      const dist = commitMs - s.endMs;
      // 最多跨 3 天
      if (dist > crossDayMs) continue;
      // author 校验：session 有已知 author 时，commit author 必须匹配
      const knownAuthors = sessionAuthors.get(s.id);
      if (knownAuthors?.size && c.author && !knownAuthors.has(c.author.toLowerCase())) continue;
      candidates.push(candidateFromSession(c, s, dist));
    }

    if (candidates.length) {
      const ranked = sortAttributionCandidates(candidates);
      const best = sIndex.find(s => s.id === ranked[0].sessionId);
      c.attributionCandidates = ranked.slice(0, 3);
      // 文件交集前置检查：无交集时标记为 cross-day-weak
      const commitFiles = (c.files || []).map(f => (f.path || '').replace(/\\/g, '/'));
      const sessionFiles = best.touchedFiles || [];
      const hasOverlap = sessionFiles.some(sf => commitFiles.some(cf => cf.endsWith(sf) || sf.endsWith(cf)));
      c.sessionId = best.id;
      c.sessionAttribution = hasOverlap ? 'cross-day' : 'cross-day-weak';
      if (!result.sessionCommitMap[best.id]) result.sessionCommitMap[best.id] = [];
      result.sessionCommitMap[best.id].push(c.hash);
    }
  }

  return result;
}

// 合并本周期 session 与跨天上下文 session，按 id 去重（本周期优先）。
// 上下文 session 仅扩 matcher 候选池，attachCommitsToSessions 仍只挂本周期 session。
function mergeSessionPool(primary, extra) {
  const pool = [...(primary || [])];
  const seen = new Set(pool.map(s => s?.id));
  for (const s of extra || []) {
    if (s && !seen.has(s.id)) { seen.add(s.id); pool.push(s); }
  }
  return pool;
}

// 把 commit 投射到 session.commits（精简字段）
export function attachCommitsToSessions(sessions, commitList) {
  if (!sessions?.length) return sessions || [];
  const byId = new Map(sessions.map(s => [s.id, s]));
  for (const s of sessions) s.commits = [];
  for (const c of commitList || []) {
    if (!c.sessionId) continue;
    const s = byId.get(c.sessionId);
    if (!s) continue;
    s.commits.push({
      hash: c.hash,
      subject: c.subject,
      type: c.type,
      isAI: c.isAI,
      aiAssisted: c.aiAssisted,
      aiConfidence: c.aiConfidence || AI_CONFIDENCE.NONE,
      attributionType: c.attributionType || null,
      aiEvidenceDetails: c.aiEvidenceDetails || null,
      attributedTool: c.attributedTool || null,
      linesAdded: c.linesAdded,
      linesDeleted: c.linesDeleted,
      date: c.date,
    });
  }
  return sessions;
}

// 一次性收尾：跑 attribution + 三个聚合
export async function finalizeGitStats(merged, sessions = [], options = {}) {
  if (!merged) return merged;
  const attributionOptions = resolveAttributionOptions(options.attribution || options);
  const stepTrackingOptions = options.stepTracking || {};
  const fileOverrides = loadAttributionOverrides();
  const inputOverrides = options.overrides || {};
  const mergedOverrides = {
    commits: { ...fileOverrides.commits, ...(inputOverrides.commits || {}) },
    files: { ...fileOverrides.files, ...(inputOverrides.files || {}) },
  };
  // 生成/第三方文件排除：预算每 commit 的 effective 行数（排除 vendor/lockfile 等噪声），
  // 供 computeAIContribution 分母与无 lineBlame 回退分子使用，避免整包粘贴压制 AI%。
  const excludePatterns = resolveExcludeFilePatterns(options.excludeFilePatterns);
  for (const c of merged.commitList || []) {
    if (!c.files?.length) {
      c.effectiveLinesAdded = c.linesAdded || 0;
      c.effectiveLinesDeleted = c.linesDeleted || 0;
      c.effectiveFiles = c.files || [];
      continue;
    }
    let added = 0, deleted = 0;
    const kept = [];
    for (const f of c.files) {
      if (isExcludedFile(f.path, excludePatterns)) continue;
      added += f.added || 0;
      deleted += f.deleted || 0;
      kept.push(f);
    }
    c.effectiveLinesAdded = added;
    c.effectiveLinesDeleted = deleted;
    c.effectiveFiles = kept;
  }
  // 归因匹配候选池：本周期 sessions + 跨天上下文 session（报告期开始前 N 天撰写）。
  // 上下文 session 仅参与匹配与信心度查找；attachCommitsToSessions 仍只挂本周期 session。
  const attributionSessions = options.attributionSessions?.length
    ? mergeSessionPool(sessions, options.attributionSessions)
    : (sessions || []);
  const { sessionCommitMap } = attributeCommitsToSessions(merged.commitList, attributionSessions, { attribution: attributionOptions });
  merged.sessionCommitMap = sessionCommitMap;
  const sessionsById = new Map(attributionSessions.map(s => [s.id, s]));
  for (const s of sessions || []) {
    s.touchedFiles = extractTouchedFilesFromSession(s);
  }

  // Step 1: 为每个 commit 标注 attributedTool
  // 优先级：显式签名(detectedTool) > session primaryTool > null
  // 注意：session 归属的 commit 即使是低置信度也会获得 attributedTool，
  // 这是预期行为——低置信度意味着"不能确定是 AI"，但工具归属仍然有价值
  for (const c of merged.commitList || []) {
    if (c.detectedTool) {
      c.attributedTool = c.detectedTool;
    } else if (c.sessionId) {
      const session = sessionsById.get(c.sessionId);
      c.attributedTool = session?.primaryTool || null;
    } else {
      c.attributedTool = null;
    }
  }

  // Step 1.5: Enrich commits with line-level step blame when available
  const stepTrackers = new Map();
  if (stepTrackingOptions.enabled !== false) try {
    const { StepTracker } = await import('./step-tracker.js');
    const projectRoots = [...new Set((sessions || []).map(s => s.project).filter(Boolean))];
    // Also check repo paths from commits
    for (const c of merged.commitList || []) {
      if (c.repo) projectRoots.push(c.repo);
    }
    // ponytail: StepTracker 需真实文件系统路径 open db；normalizePathForGit 会 toLowerCase，
    // 在区分大小写的文件系统（Linux ext4）上把含大写的 mkdtemp 目录改写后无法命中真实路径，
    // 导致 stepTrackers 为空、lineBlame 全 null。故仅以 lower 形式做 Map 键去重/匹配，原始路径传入。
    const seenRootKeys = new Set();
    for (const rawRoot of projectRoots) {
      if (!rawRoot) continue;
      const key = normalizePathForGit(rawRoot);
      if (seenRootKeys.has(key)) continue;
      seenRootKeys.add(key);
      const tracker = new StepTracker(rawRoot, {
        dbPath: stepTrackingOptions.dbPath,
        maxFileSize: stepTrackingOptions.maxFileSize,
      });
      if (await tracker.isAvailableAsync()) {
        await tracker.open();
        stepTrackers.set(key, tracker);
      }
    }
  } catch {
    for (const tracker of stepTrackers.values()) tracker.close();
    stepTrackers.clear();
  }

  if (stepTrackers.size > 0) {
    for (const c of merged.commitList || []) {
      if (!c.sessionId) continue;
      const candidateRoots = [
        c.repo,
        sessionsById.get(c.sessionId)?.project,
      ].filter(Boolean);
      let stepTracker = null;
      for (const candidateRoot of candidateRoots) {
        const normalizedCandidate = normalizePathForGit(candidateRoot);
        for (const [root, tracker] of stepTrackers.entries()) {
          if (projectMatchesFromGitPaths(root, normalizedCandidate)) {
            stepTracker = tracker;
            break;
          }
        }
        if (stepTracker) break;
      }
      if (!stepTracker && stepTrackers.size === 1) {
        stepTracker = stepTrackers.values().next().value;
      }
      if (!stepTracker) continue;
      try {
        const session = sessionsById.get(c.sessionId);
        const commitMs = toMs(c.date);
        const canEnrich = !!c.repo && !!c.hash && Number.isFinite(commitMs);
        // 行级归因按 commit hash 缓存：命中则跳过逐文件 git show/diff exec（行级归因的主成本）。
        const __lbKey = canEnrich ? `${c.repo}|${c.hash}` : null;
        const __lbCached = __lbKey ? lineBlameCache.get(__lbKey) : null;
        if (__lbCached && Date.now() - __lbCached.ts < LINE_BLAME_CACHE_TTL) {
          c.lineBlame = __lbCached.blame;
          continue;
        }
        // ponytail: enrich 逐文件拉 commit 内容 + added 行号，候选 session 间复用，避免重复 exec。
        // 仅 enrich 非 vendor 文件（c.effectiveFiles），使 lineBlame 的 aiLines/totalLines 不含噪声。
        let enrichedFiles = null;
        const blameSourceFiles = c.effectiveFiles || c.files || [];
        for (const stepSessionId of getStepSessionIdCandidates(c.sessionId, session)) {
          if (canEnrich && !enrichedFiles) {
            // ponytail: per-commit 批量取 content(cat-file --batch) + addedLines(git show -p 一次)，
            // 替代 per-file 2×N 次 exec。binary 文件仍逐个跳过（content null → 降级比例法）。
            const nonBinaryPaths = blameSourceFiles.filter(f => !f.binary).map(f => f.path);
            const inputsByPath = getCommitBlameInputsBatch(c.repo, c.hash, nonBinaryPaths);
            enrichedFiles = blameSourceFiles.map(f => {
              if (f.binary) return { ...f, commitContent: null, addedLines: null };
              const inputs = inputsByPath.get(f.path) || { commitContent: null, addedLines: null };
              return { ...f, ...inputs };
            });
          }
          const lineBlame = stepTracker.getLineAttributionForCommit({
            ...c,
            sessionId: stepSessionId,
            commitMs: Number.isFinite(commitMs) ? commitMs : null,
            files: enrichedFiles || blameSourceFiles,
          });
          if (lineBlame) {
            c.lineBlame = lineBlame;
            if (__lbKey) {
              lineBlameCache.set(__lbKey, { blame: lineBlame, ts: Date.now() });
              evictLineBlameCache();
            }
            break;
          }
        }
      } catch { /* best effort */ }
    }
    for (const tracker of stepTrackers.values()) tracker.close();
  }

  // Step 1.6: compute developer behavioral baselines
  const authorBaselines = computeAuthorBaseline(merged.commitList);

  // Step 2: 信心度评估（保持现有逻辑）
  for (const c of merged.commitList || []) {
    if (!c.sessionId || c.attributionType === 'explicit') continue;
    const session = sessionsById.get(c.sessionId);
    const overlap = computeFileOverlap(session?.touchedFiles || [], c.files || []);
    const nextSignals = [...(c.aiSignals || [])];
    let confidence = AI_CONFIDENCE.LOW;
    let attributionType = 'session_weak';
    const signals = [...nextSignals];

    c.aiEvidenceDetails = overlap;

    if (overlap.matchedFileCount > 0) {
      signals.push('fileOverlap');
      if (overlap.fileOverlapRatio >= 0.5 || overlap.commitFileCount === 1) {
        signals.push('fileOverlapHigh');
      }
    }

    if (c.sessionAttribution === 'strong') {
      confidence = AI_CONFIDENCE.MEDIUM;
      attributionType = 'session_strong';
      signals.push('sessionCommitBash');
      if (overlap.matchedFileCount > 0) {
        confidence = pickHigherConfidence(confidence, AI_CONFIDENCE.HIGH);
        attributionType = 'session_strong_file_overlap';
      }
    } else if (c.sessionAttribution === 'cross-day') {
      confidence = AI_CONFIDENCE.MEDIUM;
      attributionType = 'session_cross_day';
      signals.push('crossDayProjectMatch');
      if (overlap.matchedFileCount > 0) {
        confidence = pickHigherConfidence(confidence, AI_CONFIDENCE.HIGH);
        attributionType = 'session_cross_day_file_overlap';
      }
    } else if (c.sessionAttribution === 'cross-day-weak') {
      confidence = AI_CONFIDENCE.LOW;
      attributionType = 'session_cross_day_weak';
      signals.push('crossDayProjectMatch');
      if (overlap.matchedFileCount > 0) {
        confidence = AI_CONFIDENCE.MEDIUM;
        attributionType = 'session_cross_day_weak_file_overlap';
      }
    } else if (overlap.matchedFileCount > 0) {
      confidence = AI_CONFIDENCE.MEDIUM;
      attributionType = 'session_file_overlap';
    } else if (session?.primaryTool) {
      // session 有明确工具归属但无 file overlap（如 Codex 无 toolSequence 记录）
      confidence = AI_CONFIDENCE.MEDIUM;
      attributionType = 'session_tool_attributed';
      signals.push('sessionToolAttributed');
    } else {
      signals.push('sessionAttributed');
    }

    if (confidence === AI_CONFIDENCE.MEDIUM && overlap.fileOverlapRatio >= 0.75 && overlap.commitFileCount > 1) {
      confidence = AI_CONFIDENCE.HIGH;
      signals.push('fileOverlapDominant');
      if (attributionType === 'session_file_overlap') attributionType = 'session_file_overlap_dominant';
    }

    if (c.sessionAttribution === 'strong' && overlap.matchedFileCount === 0 && overlap.touchedFileCount > 0) {
      signals.push('strongWithoutFileOverlap');
    }

    // Developer baseline deviation
    const baseline = authorBaselines.get(c.author);
    const deviation = computeBaselineDeviation(c, baseline);
    if (deviation >= 0.4) {
      signals.push('baselineDeviationHigh');
      if (confidence === AI_CONFIDENCE.MEDIUM) confidence = pickHigherConfidence(confidence, AI_CONFIDENCE.HIGH);
    } else if (deviation >= 0.2) {
      signals.push('baselineDeviationMedium');
    } else if (deviation <= 0.05 && baseline && c.attributionType !== 'explicit') {
      signals.push('humanBaselineMatch');
    }

    // Negative signals: downgrade confidence
    const negSignals = detectNegativeSignals(c.subject, c.body, c.linesAdded, c.linesDeleted, (c.files || []).length);
    if (negSignals.includes('humanMergeCommit')) {
      confidence = AI_CONFIDENCE.NONE;
      attributionType = 'human_merge';
    } else if (negSignals.length > 0) {
      if (confidence === AI_CONFIDENCE.HIGH) confidence = AI_CONFIDENCE.MEDIUM;
      else if (confidence === AI_CONFIDENCE.MEDIUM) confidence = AI_CONFIDENCE.LOW;
      else if (confidence === AI_CONFIDENCE.LOW) confidence = AI_CONFIDENCE.NONE;
      c.negativeSignals = negSignals;
    }

    const ai = createAIAttribution({
      confidence,
      signals,
      attributionType,
    });
    c.isAI = ai.isAI;
    c.aiAssisted = ai.aiAssisted;
    c.aiConfidence = ai.aiConfidence;
    c.aiSignals = ai.aiSignals;
    c.aiEvidence = ai.aiEvidence;
    c.attributionType = ai.attributionType;
  }

  // Step 2.5: composite continuous scoring for all commits
  for (const c of merged.commitList || []) {
    c.aiScore = computeContinuousScore(c, attributionOptions);
    const mappedConfidence = scoreToConfidence(c.aiScore, attributionOptions);
    // Only override if no explicit signature and continuous score disagrees.
    // human_merge 是硬负信号（confidence 已置 NONE），连续评分不得将其升回，否则 merge 会被计入 AI 占比
    if (c.attributionType !== 'explicit' && c.attributionType !== 'human_merge') {
      c.aiConfidence = pickHigherConfidence(c.aiConfidence, mappedConfidence);
      c.isAI = isCountedAIConfidence(c.aiConfidence);
      c.aiAssisted = c.aiConfidence !== AI_CONFIDENCE.NONE;
    }
  }

  filterCommitsForUser(merged);

  const attributionItems = [];
  for (const c of merged.commitList || []) {
    const commitOverride = mergedOverrides.commits[c.hash] || null;
    const fileOverride = (c.files || []).find(f => mergedOverrides.files[`${c.hash}:${f.path}`]);
    const fileOverrideValue = fileOverride ? mergedOverrides.files[`${c.hash}:${fileOverride.path}`] : null;
    const classified = classifyAttribution({
      commitHash: c.hash,
      primaryTool: c.attributedTool || null,
      tools: c.attributedTool ? [c.attributedTool] : [],
      aiConfidence: c.aiConfidence,
      aiAssisted: c.aiAssisted,
      lineBlame: c.lineBlame, // 行级 step_blame 证据：source==='step_blame' 时 classifyAttribution 判 confirmed_ai（修复此前入参漏传导致 confirmed_ai 分支成死代码）
      attributionType: c.attributionType,
      sessionAttribution: c.sessionAttribution,
      isAI: c.isAI,
      evidence: c.aiEvidenceDetails?.matchedFiles || [],
      override: fileOverrideValue || commitOverride || null,
    });
    attributionItems.push({
      commitHash: c.hash,
      classification: classified.classification,
      primaryTool: classified.primaryTool,
      tools: classified.tools,
      evidence: classified.evidence,
      source: classified.source,
      reason: classified.reason,
      added: c.linesAdded || 0,
      deleted: c.linesDeleted || 0,
    });
  }

  // Step 3: 全局 + 按工具聚合
  merged.aiContribution = computeAIContribution(merged.commitList, null, attributionOptions);
  merged.attributionQuality = computeAttributionQuality(merged.commitList);
  // 动态收集所有出现的 attributedTool，确保新工具自动覆盖
  const toolSet = new Set();
  for (const c of merged.commitList || []) {
    if (c.attributedTool) toolSet.add(c.attributedTool);
  }
  // 始终包含基础三工具 + generic-ai，即使无数据
  for (const t of ['claude', 'codex', 'opencode', 'generic-ai']) toolSet.add(t);
  merged.aiContributionByTool = {};
  for (const tool of toolSet) {
    merged.aiContributionByTool[tool] = computeAIContribution(merged.commitList, tool, attributionOptions);
  }
  merged.attributionSummary = aggregateAttribution(attributionItems);
  merged.commitTypes = computeCommitTypes(merged.commitList);
  merged.fileHotspots = computeFileHotspots(merged.commitList, 10);
  // 反向把 commits 挂到 sessions
  attachCommitsToSessions(sessions, merged.commitList);
  return merged;
}
