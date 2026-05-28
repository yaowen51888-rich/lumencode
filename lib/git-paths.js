export function normalizePathForGit(value) {
  if (!value) return '';
  return String(value).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
}

export function normalizeCommitFilePath(value) {
  return normalizePathForGit(value).replace(/^\.?\//, '');
}

export function toRepoRelativePath(filePath, repoPath) {
  const file = normalizePathForGit(filePath);
  const repo = normalizePathForGit(repoPath);
  if (!file) return '';
  if (!repo || !file.includes('/')) return normalizeCommitFilePath(file.replace(/^[a-z]:\//i, ''));
  if (file === repo) return '';
  if (file.startsWith(repo + '/')) return normalizeCommitFilePath(file.slice(repo.length + 1));
  return normalizeCommitFilePath(file);
}

export function projectKey(value) {
  return normalizePathForGit(value);
}

function pathContains(parent, child) {
  return parent === child || child.startsWith(parent + '/');
}

export function projectMatches(commitRepo, sessionProject) {
  const a = projectKey(commitRepo);
  const b = projectKey(sessionProject);
  if (!a || !b) return true;
  if (pathContains(a, b) || pathContains(b, a)) return true;
  if (!a.includes('/') || !b.includes('/')) {
    return a.split('/').pop() === b.split('/').pop();
  }
  return false;
}

export function filePathMatches(a, b) {
  return normalizeCommitFilePath(a) === normalizeCommitFilePath(b);
}
