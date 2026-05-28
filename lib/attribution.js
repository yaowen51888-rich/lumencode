function normalizeClassification(value) {
  const v = String(value || '').toLowerCase();
  if (['confirmed_ai', 'confirmed', 'ai', 'high'].includes(v)) return 'confirmed_ai';
  if (['probable_ai', 'probable', 'medium'].includes(v)) return 'probable_ai';
  if (['possible_ai', 'possible', 'low'].includes(v)) return 'possible_ai';
  if (['human', 'excluded', 'unknown'].includes(v)) return v;
  return 'unknown';
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

export function classifyAttribution(input = {}) {
  const override = input.override || null;
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  const tools = unique([
    ...(Array.isArray(input.tools) ? input.tools : []),
    ...(input.primaryTool ? [input.primaryTool] : []),
    ...(input.tool ? [input.tool] : []),
    ...(input.detectedTool ? [input.detectedTool] : []),
    ...evidence.map(e => e.tool),
  ]);

  // Step blame: confirmed by line-level tracking
  if (input.lineBlame?.source === 'step_blame') {
    return {
      commitHash: input.commitHash || null,
      classification: 'confirmed_ai',
      primaryTool: input.primaryTool || null,
      tools: unique([...(Array.isArray(input.tools) ? input.tools : []), input.primaryTool].filter(Boolean)),
      evidence: [...(input.evidence || []), 'step_blame'],
      source: 'auto',
      reason: 'step_blame',
    };
  }

  if (override?.classification) {
    const classification = normalizeClassification(override.classification);
    return {
      commitHash: input.commitHash || null,
      classification,
      primaryTool: override.primaryTool || input.primaryTool || tools[0] || null,
      tools: unique([...(Array.isArray(override.tools) ? override.tools : []), ...tools]),
      evidence,
      source: 'manual',
      reason: 'manual_override',
    };
  }

  const attributionType = String(input.attributionType || '').toLowerCase();
  const confidence = String(input.aiConfidence || '').toLowerCase();
  const aiAssisted = input.aiAssisted === true || confidence !== 'none';
  let classification = 'unknown';
  let reason = 'no_evidence';

  if (attributionType === 'explicit' || confidence === 'high') {
    classification = 'confirmed_ai';
    reason = attributionType === 'explicit' ? 'explicit_signature' : 'high_confidence';
  } else if (attributionType.startsWith('session_strong')) {
    classification = 'probable_ai';
    reason = 'session_commit';
  } else if (attributionType.startsWith('session_file_overlap')) {
    classification = confidence === 'high' ? 'confirmed_ai' : 'probable_ai';
    reason = 'file_overlap';
  } else if (input.sessionAttribution === 'strong') {
    classification = confidence === 'high' ? 'confirmed_ai' : 'probable_ai';
    reason = 'session_commit';
  } else if (input.sessionAttribution === 'weak' && aiAssisted) {
    classification = 'possible_ai';
    reason = 'time_window';
  } else if (confidence === 'medium') {
    classification = 'probable_ai';
    reason = 'medium_confidence';
  } else if (confidence === 'low' && aiAssisted) {
    classification = 'possible_ai';
    reason = 'low_confidence';
  } else if (!aiAssisted || input.isAI === false) {
    classification = 'human';
    reason = 'human_default';
  }

  return {
    commitHash: input.commitHash || null,
    classification,
    primaryTool: input.primaryTool || input.detectedTool || tools[0] || null,
    tools,
    evidence,
    source: 'auto',
    reason,
  };
}

export function aggregateAttribution(items = []) {
  const summary = {
    confirmedAI: 0,
    probableAI: 0,
    possibleAI: 0,
    unknown: 0,
    human: 0,
    excluded: 0,
    confirmedAILines: 0,
    probableAILines: 0,
    possibleAILines: 0,
    unknownLines: 0,
    humanLines: 0,
    excludedLines: 0,
    totalLinesChanged: 0,
    totalItems: 0,
    unknownReasons: [],
  };

  for (const item of items || []) {
    const classified = item?.classification ? item : classifyAttribution(item);
    const lines = (item?.added || item?.linesAdded || 0) + (item?.deleted || item?.linesDeleted || 0);
    summary.totalItems++;
    summary.totalLinesChanged += lines;

    switch (classified.classification) {
      case 'confirmed_ai':
        summary.confirmedAI++;
        summary.confirmedAILines += lines;
        break;
      case 'probable_ai':
        summary.probableAI++;
        summary.probableAILines += lines;
        break;
      case 'possible_ai':
        summary.possibleAI++;
        summary.possibleAILines += lines;
        break;
      case 'human':
        summary.human++;
        summary.humanLines += lines;
        break;
      case 'excluded':
        summary.excluded++;
        summary.excludedLines += lines;
        break;
      default:
        summary.unknown++;
        summary.unknownLines += lines;
        if (classified.reason) summary.unknownReasons.push(classified.reason);
        break;
    }
  }

  summary.unknownReasons = unique(summary.unknownReasons);
  return summary;
}
