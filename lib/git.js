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
  return { commits: 0, filesChanged: 0, linesAdded: 0, linesDeleted: 0, commitsByDate: {}, linesByDate: {} };
}

export function parseGitLogOutput(output) {
  const result = emptyResult();
  let currentDate = '';

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      currentDate = trimmed;
      result.commits++;
      result.commitsByDate[currentDate] = (result.commitsByDate[currentDate] || 0) + 1;
      if (!result.linesByDate[currentDate]) {
        result.linesByDate[currentDate] = { added: 0, deleted: 0, files: 0 };
      }
    } else if (trimmed.includes('changed')) {
      const ins = trimmed.match(/(\d+) insertion/);
      const del = trimmed.match(/(\d+) deletion/);
      const fil = trimmed.match(/(\d+) files? changed/);
      if (ins) {
        const n = parseInt(ins[1]);
        result.linesAdded += n;
        if (currentDate) result.linesByDate[currentDate].added += n;
      }
      if (del) {
        const n = parseInt(del[1]);
        result.linesDeleted += n;
        if (currentDate) result.linesByDate[currentDate].deleted += n;
      }
      if (fil) {
        const n = parseInt(fil[1]);
        result.filesChanged += n;
        if (currentDate) result.linesByDate[currentDate].files += n;
      }
    }
  }

  return result;
}

function buildGitArgs(since, until, author) {
  const sinceFull = since.includes('T') ? since : since + 'T00:00:00';
  const authorArg = author ? ` --author="${author}"` : '';
  return `--all --format="%ad" --date=short --shortstat --since="${sinceFull}" --until="${until}"${authorArg}`;
}

function mergeGitStats(target, source) {
  target.commits += source.commits;
  target.filesChanged += source.filesChanged;
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
}

// ── sync versions (CLI) ──

export function getGitStats(repoPath, since, until, author = null) {
  try {
    execSync('git rev-parse --git-dir', { cwd: repoPath, stdio: 'pipe' });
  } catch {
    return emptyResult();
  }

  try {
    const output = execSync(`git log ${buildGitArgs(since, until, author)}`, {
      cwd: repoPath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024,
    }).trim();
    return parseGitLogOutput(output);
  } catch {
    return emptyResult();
  }
}

export function getGitStatsForMultipleRepos(repos, since, until) {
  const merged = emptyResult();
  for (const repo of repos) {
    const stats = getGitStats(repo, since, until, getGitAuthor(repo));
    mergeGitStats(merged, stats);
  }
  return merged;
}

// ── async versions (server) with cache ──

const gitCache = new Map();

async function getGitStatsAsync(repoPath, since, until, author = null) {
  const cacheKey = `${repoPath}|${since}|${until}`;
  const cached = gitCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 60_000) return cached.stats;

  try {
    await execAsync('git rev-parse --git-dir', { cwd: repoPath });
  } catch {
    return emptyResult();
  }

  try {
    const output = await execAsync(`git log ${buildGitArgs(since, until, author)}`, {
      cwd: repoPath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024,
    });
    const stats = parseGitLogOutput(output.trim());
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
  return merged;
}

export function invalidateGitCache() {
  gitCache.clear();
}
