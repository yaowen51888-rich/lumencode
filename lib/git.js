import { execSync } from 'child_process';

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

export function getGitStats(repoPath, since, until, author = null) {
  const result = {
    commits: 0,
    filesChanged: 0,
    linesAdded: 0,
    linesDeleted: 0,
    commitsByDate: {},
  };

  // Git 对纯日期 + --author 组合解析有偏差，补全时间格式
  const sinceFull = since.includes('T') ? since : since + 'T00:00:00';
  const sinceArg = `--since="${sinceFull}"`;
  const untilArg = `--until="${until}"`;
  const authorArg = author ? `--author="${author}"` : '';

  // 检查是否是 git 仓库
  try {
    execSync('git rev-parse --git-dir', { cwd: repoPath, stdio: 'pipe' });
  } catch {
    return result;
  }

  // 每日提交统计
  try {
    const log = execSync(
      `git log --all --format="%ad" --date=short ${sinceArg} ${untilArg} ${authorArg}`,
      { cwd: repoPath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    ).trim();

    if (log) {
      const dates = log.split('\n');
      result.commits = dates.length;
      for (const d of dates) {
        result.commitsByDate[d.trim()] = (result.commitsByDate[d.trim()] || 0) + 1;
      }
    }
  } catch {}

  // 代码行数变化
  try {
    const stat = execSync(
      `git log --all --shortstat ${sinceArg} ${untilArg} ${authorArg}`,
      { cwd: repoPath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    ).trim();

    const insertMatch = stat.match(/(\d+) insertion/g);
    const deleteMatch = stat.match(/(\d+) deletion/g);
    const filesMatch = stat.match(/(\d+) files? changed/g);

    if (insertMatch) result.linesAdded = insertMatch.reduce((sum, m) => sum + parseInt(m), 0);
    if (deleteMatch) result.linesDeleted = deleteMatch.reduce((sum, m) => sum + parseInt(m), 0);
    if (filesMatch) result.filesChanged = filesMatch.reduce((sum, m) => sum + parseInt(m), 0);
  } catch {}

  // 按日统计行数变化
  try {
    const dailyStat = execSync(
      `git log --all --format="%ad" --date=short --shortstat ${sinceArg} ${untilArg} ${authorArg}`,
      { cwd: repoPath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    ).trim();

    const linesByDate = {};
    let currentDate = '';
    for (const line of dailyStat.split('\n')) {
      const trimmed = line.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        currentDate = trimmed;
        if (!linesByDate[currentDate]) {
          linesByDate[currentDate] = { added: 0, deleted: 0, files: 0 };
        }
      } else if (currentDate && trimmed.includes('changed')) {
        const ins = trimmed.match(/(\d+) insertion/);
        const del = trimmed.match(/(\d+) deletion/);
        const fil = trimmed.match(/(\d+) files? changed/);
        if (ins) linesByDate[currentDate].added += parseInt(ins[1]);
        if (del) linesByDate[currentDate].deleted += parseInt(del[1]);
        if (fil) linesByDate[currentDate].files += parseInt(fil[1]);
      }
    }
    result.linesByDate = linesByDate;
  } catch {}

  return result;
}

export function getGitStatsForMultipleRepos(repos, since, until) {
  const merged = {
    commits: 0,
    filesChanged: 0,
    linesAdded: 0,
    linesDeleted: 0,
    commitsByDate: {},
    linesByDate: {},
  };

  for (const repo of repos) {
    const author = getGitAuthor(repo);
    const stats = getGitStats(repo, since, until, author);
    merged.commits += stats.commits;
    merged.filesChanged += stats.filesChanged;
    merged.linesAdded += stats.linesAdded;
    merged.linesDeleted += stats.linesDeleted;

    for (const [d, c] of Object.entries(stats.commitsByDate)) {
      merged.commitsByDate[d] = (merged.commitsByDate[d] || 0) + c;
    }
    if (stats.linesByDate) {
      for (const [d, v] of Object.entries(stats.linesByDate)) {
        if (!merged.linesByDate[d]) merged.linesByDate[d] = { added: 0, deleted: 0, files: 0 };
        merged.linesByDate[d].added += v.added;
        merged.linesByDate[d].deleted += v.deleted;
        merged.linesByDate[d].files += v.files;
      }
    }
  }

  return merged;
}
