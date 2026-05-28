export function scoreSessionCandidate(commit, session, context = {}) {
  const distanceMs = context.distanceMs ?? Number.MAX_SAFE_INTEGER;
  const fileOverlapRatio = context.fileOverlapRatio ?? 0;
  const matchedFiles = context.matchedFiles ?? [];
  let score = 0;
  const reasons = [];

  if (context.hasStrongBashMatch) {
    score += 100;
    reasons.push('bash_git_commit');
  }
  if (context.projectMatches) {
    score += 40;
    reasons.push('project_match');
  }
  if (fileOverlapRatio > 0) {
    score += Math.round(fileOverlapRatio * 35);
    reasons.push('file_overlap');
  }
  if (Number.isFinite(distanceMs)) {
    score += Math.max(0, 20 - Math.floor(distanceMs / 60000));
    reasons.push('time_proximity');
  }
  if (session.primaryTool) {
    score += 5;
    reasons.push('primary_tool');
  }

  return {
    sessionId: session.id,
    score,
    reasons,
    distanceMs,
    fileOverlapRatio,
    matchedFiles,
  };
}
