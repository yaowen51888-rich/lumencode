function normalizeClassification(value) {
  return value === 'ai' || value === 'human' ? value : 'unknown';
}

export function buildCommitAuditEvidence(commit = {}) {
  const breakdown = commit.lineBlame?.fileBreakdown || {};
  return {
    hash: commit.hash || '',
    subject: commit.subject || '',
    author: commit.author || '',
    date: commit.date || commit.timestamp || '',
    project: commit.project || commit.repo || '',
    confidence: commit.aiConfidence || 'none',
    attributionType: commit.attributionType || null,
    coverage: commit.lineBlame?.lineCoverage || 0,
    files: (commit.files || []).map(file => {
      const evidence = breakdown[file.path] || {};
      const byLine = new Map((evidence.lines || []).map(line => [line.newLine, line]));
      const contentLines = typeof file.commitContent === 'string' ? file.commitContent.replace(/\r\n?/g, '\n').split('\n') : [];
      const addedLines = Array.isArray(file.addedLines) ? file.addedLines : [];
      const lines = addedLines.map(newLine => {
        const source = byLine.get(newLine) || {};
        return {
          type: 'added', oldLine: null, newLine, content: contentLines[newLine - 1] || '',
          classification: normalizeClassification(source.classification),
          tool: source.tool || null, sessionId: source.sessionId || null, stepId: source.stepId || null,
          confidence: source.confidence || commit.aiConfidence || 'none', reason: source.reason || evidence.method || 'unavailable',
        };
      });
      for (let index = 0; index < (file.deleted || 0); index++) {
        lines.push({ type: 'deleted', oldLine: null, newLine: null, content: '', classification: 'unknown', tool: null, sessionId: null, stepId: null, confidence: 'none', reason: 'deleted_line_unavailable' });
      }
      return {
        path: file.path, added: file.added || 0, deleted: file.deleted || 0, binary: !!file.binary,
        method: evidence.method || 'unavailable', coverage: evidence.lineCoverage || 0, lines,
      };
    }),
  };
}
