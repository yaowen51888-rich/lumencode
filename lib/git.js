import { execSync, exec as execCb } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// ── helpers ──

function execAsync(command, options) {
  return new Promise((resolve, reject) => {
    execCb(command, options, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
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
  // Generic AI markers
  { re: /\bAI[\s_-]?generated\b/i, signal: 'aiGenerated' },
  { re: /\bgenerated\s+by\s+(AI|Claude|GPT|LLM)\b/i, signal: 'generatedByAI' },
  { re: /\bvia\s+(Claude|GPT|AI|Copilot)\b/i, signal: 'viaAI' },
  { re: /\[AI\]/i, signal: 'aiTag' },
  { re: /\(AI\)/i, signal: 'aiTag' },
];

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

function createAIAttribution({ confidence = AI_CONFIDENCE.NONE, signals = [], attributionType = null } = {}) {
  const normalizedSignals = [...new Set(signals)];
  return {
    isAI: isCountedAIConfidence(confidence),
    aiAssisted: confidence !== AI_CONFIDENCE.NONE,
    aiConfidence: confidence,
    signals: normalizedSignals,
    aiSignals: normalizedSignals,
    aiEvidence: normalizedSignals,
    attributionType,
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

function loadCustomPatterns() {
  try {
    const configPath = join(process.cwd(), 'ai-patterns.json');
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      return raw
        .filter(p => typeof p.re === 'string' && typeof p.signal === 'string')
        .map(p => ({ re: new RegExp(p.re, p.flags || 'i'), signal: p.signal }));
    }
  } catch { /* ignore */ }
  return [];
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
  if (signals.length > 0) {
    return createAIAttribution({
      confidence: AI_CONFIDENCE.HIGH,
      signals,
      attributionType: 'explicit',
    });
  }
  return createAIAttribution();
}

// ── 聚合函数 ──

export function computeAIContribution(commits) {
  let aiCommits = 0, aiLinesAdded = 0, aiLinesDeleted = 0;
  let aiCommitLinesAdded = 0, aiCommitLinesDeleted = 0;
  let aiFileLinesAdded = 0, aiFileLinesDeleted = 0;
  let highConfidenceCommits = 0, mediumConfidenceCommits = 0, lowConfidenceCommits = 0;
  for (const c of commits || []) {
    const confidence = c.aiConfidence || (c.isAI ? AI_CONFIDENCE.HIGH : AI_CONFIDENCE.NONE);
    if (confidence === AI_CONFIDENCE.HIGH) highConfidenceCommits++;
    else if (confidence === AI_CONFIDENCE.MEDIUM) mediumConfidenceCommits++;
    else if (confidence === AI_CONFIDENCE.LOW) lowConfidenceCommits++;

    if (isCountedAIConfidence(confidence)) {
      aiCommits++;
      aiCommitLinesAdded += c.linesAdded || 0;
      aiCommitLinesDeleted += c.linesDeleted || 0;

      const matchedFiles = new Set((c.aiEvidenceDetails?.matchedFiles || []).map(normalizeCommitFilePath));
      const useMatchedFiles = matchedFiles.size > 0;
      let fileAdded = 0;
      let fileDeleted = 0;
      for (const f of c.files || []) {
        const filePath = normalizeCommitFilePath(f.path);
        if (useMatchedFiles && !matchedFiles.has(filePath)) continue;
        fileAdded += f.added || 0;
        fileDeleted += f.deleted || 0;
      }
      if (!useMatchedFiles && c.attributionType === 'explicit') {
        fileAdded = c.linesAdded || 0;
        fileDeleted = c.linesDeleted || 0;
      }
      aiFileLinesAdded += fileAdded;
      aiFileLinesDeleted += fileDeleted;
    }
  }
  aiLinesAdded = aiFileLinesAdded;
  aiLinesDeleted = aiFileLinesDeleted;
  const total = (commits || []).length;
  return {
    aiCommits,
    humanCommits: total - aiCommits,
    aiRatio: total > 0 ? aiCommits / total : 0,
    aiLinesAdded,
    aiLinesDeleted,
    aiCommitLinesAdded,
    aiCommitLinesDeleted,
    aiFileLinesAdded,
    aiFileLinesDeleted,
    highConfidenceCommits,
    mediumConfidenceCommits,
    lowConfidenceCommits,
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
    const dateKey = current.date.slice(0, 10);
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
      const date = (parts[1] || '').slice(0, 19);
      const author = parts[2] || '';
      const subject = parts.slice(3).join('|');
      current = {
        repo,
        hash,
        date,
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

function buildGitArgs(since, until, author) {
  const sinceFull = since.includes('T') ? since : since + 'T00:00:00';
  const authorArg = author ? ` --author="${author}"` : '';
  // 格式：哨兵行(subject) → body 行(可多行) → ENDBODY 行 → numstat 行
  const pretty = `--pretty=format:"${COMMIT_SENTINEL}%H|%ad|%ae|%s%n%B${BODY_END}"`;
  return `--all --no-renames ${pretty} --date=iso-strict --numstat --since="${sinceFull}" --until="${until}"${authorArg}`;
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

// ── async versions (server) with cache ──

const gitCache = new Map();
const CACHE_VERSION = 'v3';

async function getGitStatsAsync(repoPath, since, until, author = null) {
  const cacheKey = `${repoPath}|${since}|${until}|${CACHE_VERSION}`;
  const cached = gitCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 60_000) return cached.stats;

  try {
    await execAsync('git rev-parse --git-dir', { cwd: repoPath });
  } catch {
    return emptyResult();
  }

  try {
    const output = await execAsync(`git log ${buildGitArgs(since, until, author)}`, {
      cwd: repoPath, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024,
    });
    const stats = parseGitLogOutput(output, repoPath);
    gitCache.set(cacheKey, { stats, ts: Date.now() });
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

export function invalidateGitCache() {
  gitCache.clear();
}

// ── Session ↔ Commit 关联 ──

function normalizePath(p) {
  if (!p) return '';
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
}

function toRelativeRepoPath(filePath, repoPath) {
  const fileN = normalizePath(filePath);
  const repoN = normalizePath(repoPath);
  if (!fileN) return '';
  if (!repoN) return normalizeCommitFilePath(fileN.replace(/^[a-z]:\//i, ''));
  if (fileN === repoN) return '';
  if (fileN.startsWith(repoN + '/')) return fileN.slice(repoN.length + 1);
  const repoTail = repoN.split('/').filter(Boolean).pop();
  if (repoTail) {
    const marker = `/${repoTail}/`;
    const idx = fileN.indexOf(marker);
    if (idx >= 0) return fileN.slice(idx + marker.length);
  }
  return fileN;
}

function normalizeCommitFilePath(filePath) {
  return normalizePath(filePath).replace(/^\.?\//, '');
}

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
    // Write/Edit/NotebookEdit/MultiEdit 工具
    if (['Write', 'Edit', 'NotebookEdit', 'MultiEdit'].includes(tc.name)) {
      const rawPaths = collectFilePaths(tc.input);
      for (const rawPath of rawPaths) {
        const relative = normalizeCommitFilePath(toRelativeRepoPath(rawPath, repoPath));
        if (relative) files.add(relative);
      }
      continue;
    }
    // Bash 工具 — 从命令中提取文件路径
    if (tc.name === 'Bash') {
      const cmd = tc.input?.command || '';
      const rawPaths = extractFilePathsFromBashCommand(cmd);
      for (const rawPath of rawPaths) {
        const relative = normalizeCommitFilePath(toRelativeRepoPath(rawPath, repoPath));
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

// 用于 commit.repo 与 session.project 之间宽松对齐：
// decodeProjectName 把 `-` 解码为 `/`（D--foo-bar → D://foo/bar），
// 所以将 `-` 和 `_` 统一转为 `/`，再以 `/` 为分隔符保留路径语义。
// 这样 d:/foo-bar 和 d:/foo/bar 匹配（同一项目的解码差异），
// 但 d:/foobar 和 d:/foo/bar 不匹配（不同项目）。
function projectKey(p) {
  return normalizePath(p).replace(/[-_]/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').replace(/[^a-z0-9/]/g, '');
}

// 精确路径包含：parent 是 child 的前缀，且后面紧跟 '/' 或完全匹配
function pathContains(parent, child) {
  if (parent === child) return true;
  return child.startsWith(parent + '/');
}

function projectMatches(commitRepoN, sessionProjectN) {
  if (!commitRepoN || !sessionProjectN) return true;
  // 精确路径匹配（双向：commit repo 可能是 session project 的子目录或反之）
  if (pathContains(commitRepoN, sessionProjectN) || pathContains(sessionProjectN, commitRepoN)) return true;
  // 宽松 key 对比（兜底：处理路径解码差异）
  const a = projectKey(commitRepoN);
  const b = projectKey(sessionProjectN);
  return a && b && (a === b);
}

const BASH_GIT_COMMIT_RE = /\bgit\s+commit\b/i;
const STRONG_WINDOW_BEFORE_MS = 30 * 1000;       // 30s before bash invocation
const STRONG_WINDOW_AFTER_MS = 5 * 60 * 1000;    // 5min after

function toMs(iso) {
  if (!iso) return NaN;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
}

// 从 session.toolSequence 提取所有 `git commit` Bash 调用时间戳
function extractCommitBashTimestamps(session) {
  const ts = [];
  for (const tc of session.toolSequence || []) {
    if (tc.name !== 'Bash') continue;
    const cmd = tc.input?.command || '';
    if (BASH_GIT_COMMIT_RE.test(cmd)) {
      const ms = toMs(tc.timestamp);
      if (Number.isFinite(ms)) ts.push(ms);
    }
  }
  return ts;
}

export function attributeCommitsToSessions(commits, sessions, { bufferMs = 30 * 60 * 1000 } = {}) {
  const result = { sessionCommitMap: {} };
  if (!commits?.length || !sessions?.length) return result;

  // 预计算每个 session 的 ms 范围 + 项目归一化 + bash commit 时间戳
  const sIndex = sessions.map(s => ({
    id: s.id,
    projectN: normalizePath(s.project || ''),
    startMs: toMs(s.startTime),
    endMs: toMs(s.endTime),
    bashTs: extractCommitBashTimestamps(s),
    touchedFiles: extractTouchedFilesFromSession(s),
  }));

  // 阶段 1：重置 + 强信号匹配（Bash git commit）
  for (const c of commits) {
    c.sessionId = null;
    c.sessionAttribution = null;
    const commitMs = toMs(c.date);
    const commitRepoN = normalizePath(c.repo || '');
    if (!Number.isFinite(commitMs)) continue;

    let matched = null;
    for (const s of sIndex) {
      if (!s.bashTs.length) continue;
      if (!projectMatches(commitRepoN, s.projectN)) continue;
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
    const commitRepoN = normalizePath(c.repo || '');
    if (!Number.isFinite(commitMs)) continue;

    let best = null;
    let bestDist = Infinity;
    for (const s of sIndex) {
      if (!Number.isFinite(s.startMs) || !Number.isFinite(s.endMs)) continue;
      if (!projectMatches(commitRepoN, s.projectN)) continue;

      // author 一致性校验：session 有已知 author 时，commit author 必须匹配
      const knownAuthors = sessionAuthors.get(s.id);
      if (knownAuthors?.size && c.author && !knownAuthors.has(c.author.toLowerCase())) continue;

      const lo = s.startMs - bufferMs;
      const hi = s.endMs + bufferMs;
      if (commitMs < lo || commitMs > hi) continue;
      const mid = (s.startMs + s.endMs) / 2;
      const dist = Math.abs(commitMs - mid);
      if (dist < bestDist) {
        best = s;
        bestDist = dist;
      }
    }

    if (best) {
      c.sessionId = best.id;
      c.sessionAttribution = 'weak';
      if (!result.sessionCommitMap[best.id]) result.sessionCommitMap[best.id] = [];
      result.sessionCommitMap[best.id].push(c.hash);
    }
  }

  return result;
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
      linesAdded: c.linesAdded,
      linesDeleted: c.linesDeleted,
      date: c.date,
    });
  }
  return sessions;
}

// 一次性收尾：跑 attribution + 三个聚合
export function finalizeGitStats(merged, sessions = []) {
  if (!merged) return merged;
  const { sessionCommitMap } = attributeCommitsToSessions(merged.commitList, sessions);
  merged.sessionCommitMap = sessionCommitMap;
  const sessionsById = new Map((sessions || []).map(s => [s.id, s]));
  for (const s of sessions || []) {
    s.touchedFiles = extractTouchedFilesFromSession(s);
  }
  // 会话归因只降低为弱/中证据，不再直接提升为显式 AI
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
    } else if (overlap.matchedFileCount > 0) {
      confidence = AI_CONFIDENCE.MEDIUM;
      attributionType = 'session_file_overlap';
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
  merged.aiContribution = computeAIContribution(merged.commitList);
  merged.commitTypes = computeCommitTypes(merged.commitList);
  merged.fileHotspots = computeFileHotspots(merged.commitList, 10);
  // 反向把 commits 挂到 sessions
  attachCommitsToSessions(sessions, merged.commitList);
  return merged;
}
