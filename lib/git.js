import { execSync, exec as execCb } from 'child_process';

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

const COMMIT_SENTINEL = '§§§';

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

const AI_PATTERNS = [
  { re: /Co-Authored-By:\s*Claude/i, signal: 'coAuthor' },
  { re: /Generated\s+with[\s\S]*Claude/i, signal: 'generatedWith' },
  { re: /🤖\s*Generated/i, signal: 'robotEmoji' },
  { re: /Assisted-By:\s*Claude/i, signal: 'assistedBy' },
];

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
  return { isAI: signals.length > 0, signals };
}

// ── 聚合函数 ──

export function computeAIContribution(commits) {
  let aiCommits = 0, aiLinesAdded = 0, aiLinesDeleted = 0;
  for (const c of commits || []) {
    if (c.isAI) {
      aiCommits++;
      aiLinesAdded += c.linesAdded || 0;
      aiLinesDeleted += c.linesDeleted || 0;
    }
  }
  const total = (commits || []).length;
  return {
    aiCommits,
    humanCommits: total - aiCommits,
    aiRatio: total > 0 ? Math.round((aiCommits / total) * 100) / 100 : 0,
    aiLinesAdded,
    aiLinesDeleted,
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

// 哨兵格式：§§§hash|isoDate|email|subject
// 后续行：numstat（added\tdeleted\tpath），其中 binary 文件为 -\t-\tpath
export function parseGitLogOutput(output, repo = '') {
  const result = emptyResult();
  const uniqueFiles = new Set();
  let current = null;

  const flush = () => {
    if (!current) return;
    const dateKey = current.date.slice(0, 10);
    // 注入 conventional 类型 + AI 信号
    const conv = parseConventional(current.subject);
    const ai = detectAICommit(current.subject, current.author);
    current.type = conv.type;
    current.scope = conv.scope;
    current.isBreaking = conv.isBreaking;
    current.isAI = ai.isAI;
    current.aiSignals = ai.signals;
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
  };

  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;

    if (line.startsWith(COMMIT_SENTINEL)) {
      flush();
      const header = line.slice(COMMIT_SENTINEL.length);
      const parts = header.split('|');
      const hash = parts[0] || '';
      const date = (parts[1] || '').slice(0, 19); // 去时区
      const author = parts[2] || '';
      const subject = parts.slice(3).join('|'); // subject 中可能含 |，重新拼回
      current = {
        repo,
        hash,
        date,
        author,
        subject,
        linesAdded: 0,
        linesDeleted: 0,
        files: [],
      };
      continue;
    }

    if (!current) continue;

    // numstat 行：added\tdeleted\tpath（binary 是 -\t-\tpath）
    const m = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
    if (m) {
      const added = m[1] === '-' ? 0 : parseInt(m[1], 10);
      const deleted = m[2] === '-' ? 0 : parseInt(m[2], 10);
      const binary = m[1] === '-' && m[2] === '-';
      const path = m[3];
      current.files.push({ path, added, deleted, binary });
      current.linesAdded += added;
      current.linesDeleted += deleted;
    }
  }
  flush();

  result.filesChanged = uniqueFiles.size;
  return result;
}

function buildGitArgs(since, until, author) {
  const sinceFull = since.includes('T') ? since : since + 'T00:00:00';
  const authorArg = author ? ` --author="${author}"` : '';
  const pretty = `--pretty=format:"${COMMIT_SENTINEL}%H|%ad|%ae|%s"`;
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
const CACHE_VERSION = 'v2';

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

// 用于 commit.repo 与 session.project 之间宽松对齐：
// decodeProjectName 历史上会把 `D--foo-bar` 错解码为 `D://foo/bar`（连字符与斜杠混乱），
// 因此把所有非字母数字压缩后比较，能正确对齐 `d:/ccusage-report` 与 `d://ccusage/report`。
function projectKey(p) {
  return normalizePath(p).replace(/[^a-z0-9]/g, '');
}

function projectMatches(commitRepoN, sessionProjectN) {
  if (!commitRepoN || !sessionProjectN) return true;
  // 严格 includes
  if (commitRepoN.includes(sessionProjectN) || sessionProjectN.includes(commitRepoN)) return true;
  // 宽松 key 对比
  const a = projectKey(commitRepoN);
  const b = projectKey(sessionProjectN);
  return a && b && (a.includes(b) || b.includes(a));
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

export function attributeCommitsToSessions(commits, sessions, { bufferMs = 5 * 60 * 1000 } = {}) {
  const result = { sessionCommitMap: {} };
  if (!commits?.length || !sessions?.length) return result;

  // 预计算每个 session 的 ms 范围 + 项目归一化 + bash commit 时间戳
  const sIndex = sessions.map(s => ({
    id: s.id,
    projectN: normalizePath(s.project || ''),
    startMs: toMs(s.startTime),
    endMs: toMs(s.endTime),
    bashTs: extractCommitBashTimestamps(s),
  }));

  for (const c of commits) {
    c.sessionId = null;
    const commitMs = toMs(c.date);
    const commitRepoN = normalizePath(c.repo || '');
    if (!Number.isFinite(commitMs)) continue;

    // 强信号：Bash git commit 落在 [bashTs-30s, bashTs+5min]
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

    // 弱信号：commit 落在 session 时间窗 ± buffer，按中点距离取近
    if (!matched) {
      let best = null;
      let bestDist = Infinity;
      for (const s of sIndex) {
        if (!Number.isFinite(s.startMs) || !Number.isFinite(s.endMs)) continue;
        if (!projectMatches(commitRepoN, s.projectN)) continue;
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
      matched = best;
    }

    if (matched) {
      c.sessionId = matched.id;
      if (!result.sessionCommitMap[matched.id]) result.sessionCommitMap[matched.id] = [];
      result.sessionCommitMap[matched.id].push(c.hash);
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
  // 时间窗推断：被归属到某个 session 的 commit 视为 AI 辅助
  for (const c of merged.commitList || []) {
    if (c.sessionId && !c.isAI) {
      c.isAI = true;
      c.aiSignals = [...(c.aiSignals || []), 'sessionAttributed'];
    }
  }
  merged.aiContribution = computeAIContribution(merged.commitList);
  merged.commitTypes = computeCommitTypes(merged.commitList);
  merged.fileHotspots = computeFileHotspots(merged.commitList, 10);
  // 反向把 commits 挂到 sessions
  attachCommitsToSessions(sessions, merged.commitList);
  return merged;
}
