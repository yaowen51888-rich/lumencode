import DiffMatchPatch from 'diff-match-patch';

const dmp = new DiffMatchPatch();
export const UNKNOWN_BLAME = '@unknown';

// ── Line-level diff ──

function splitLines(content) {
  if (!content || content.length === 0) return [];
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function joinLines(lines) {
  if (!lines || lines.length === 0) return '';
  return lines.join('\n') + '\n';
}

/**
 * Myers diff in line mode.
 * Returns array of { tag, oldStart, oldEnd, newStart, newEnd }
 * where tag is 'equal', 'insert', 'delete', or 'replace'.
 */
export function lineDiff(oldContent, newContent) {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);

  const oldText = joinLines(oldLines);
  const newText = joinLines(newLines);

  // Line-mode trick: encode each unique line as a single character
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(oldText, newText);
  const diffs = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines_(diffs, lineArray);

  return diffsToOpcodes(diffs, oldLines, newLines);
}

function diffsToOpcodes(diffs, oldLines, newLines) {
  const opcodes = [];
  let i1 = 0, i2 = 0; // indices in old
  let j1 = 0, j2 = 0; // indices in new

  for (const diff of diffs) {
    const lineCount = countNewlines(diff[1]);
    switch (diff[0]) {
      case DiffMatchPatch.DIFF_EQUAL:
        i1 = i2; i2 += lineCount;
        j1 = j2; j2 += lineCount;
        opcodes.push({ tag: 'equal', oldStart: i1, oldEnd: i2, newStart: j1, newEnd: j2 });
        break;
      case DiffMatchPatch.DIFF_DELETE:
        i1 = i2; i2 += lineCount;
        opcodes.push({ tag: 'delete', oldStart: i1, oldEnd: i2, newStart: j2, newEnd: j2 });
        break;
      case DiffMatchPatch.DIFF_INSERT:
        j1 = j2; j2 += lineCount;
        opcodes.push({ tag: 'insert', oldStart: i2, oldEnd: i2, newStart: j1, newEnd: j2 });
        break;
    }
  }

  return mergeReplaces(opcodes);
}

function countNewlines(text) {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') count++;
  }
  return count;
}

function mergeReplaces(opcodes) {
  if (opcodes.length === 0) return opcodes;
  const result = [];
  let i = 0;
  while (i < opcodes.length) {
    const op = opcodes[i];
    if (i + 1 < opcodes.length && op.tag === 'delete' && opcodes[i + 1].tag === 'insert') {
      const next = opcodes[i + 1];
      result.push({ tag: 'replace', oldStart: op.oldStart, oldEnd: op.oldEnd, newStart: next.newStart, newEnd: next.newEnd });
      i += 2;
    } else {
      result.push(op);
      i++;
    }
  }
  return result;
}

// ── Blame computation ──

/**
 * Compute per-line blame map.
 * Ported from re_gent's ComputeBlame algorithm.
 *
 * @param {string|null} oldContent - Previous file content
 * @param {string} newContent - Current file content
 * @param {{ lines: string[] }|null} oldBlameMap - Previous blame map
 * @param {string} stepHash - Current step identifier
 * @returns {{ lines: string[] }} New blame map
 */
export function computeBlame(oldContent, newContent, oldBlameMap, stepHash) {
  const ops = lineDiff(oldContent || '', newContent || '');
  const lines = [];

  for (const op of ops) {
    switch (op.tag) {
      case 'equal':
        for (let i = op.oldStart; i < op.oldEnd; i++) {
          if (oldBlameMap && i < oldBlameMap.lines.length) {
            lines.push(oldBlameMap.lines[i]);
          } else {
            lines.push(UNKNOWN_BLAME);
          }
        }
        break;
      case 'insert':
      case 'replace':
        for (let j = op.newStart; j < op.newEnd; j++) {
          lines.push(stepHash);
        }
        break;
      // 'delete' produces no lines in new blame
    }
  }

  return { lines };
}

/**
 * Build initial blame map for a file with no prior history.
 * All lines are attributed to the given step.
 */
export function buildInitialBlameMap(content, stepHash) {
  if (!content || content.length === 0) return { lines: [] };
  const lineCount = splitLines(content).length;
  return { lines: Array(lineCount).fill(stepHash) };
}

/**
 * 把 step 的逐行 blame 通过行级 diff 投影到 commit 的 added 行（drift 场景用）。
 *
 * commit 内容 ≠ step 快照（drift）时，精确相等判 aligned 失效。本函数复用 lineDiff
 * 的 equal 区间做 commit↔step 行映射：added 行落在 equal 区间 → 查对应 step 行的
 * blame 归属；落在 insert/replace 区间（step 没有的 commit 新行）→ 无法证明 AI，保守计 human。
 *
 * @param {string} stepContent - step 快照文件内容（lineDiff 的 old 端）
 * @param {string} commitContent - commit 时刻文件内容（lineDiff 的 new 端）
 * @param {{lines: string[]}|null} stepBlameMap - step 逐行 blame（lines 为 0-based 索引数组）
 * @param {number[]} addedLines - commit 相对父的 1-based 新增行号
 * @param {Set<string>} stepIds - 相关 step id 集合，blame 命中即判 AI
 * @returns {{aiAdded: number, humanAdded: number, coverage: number}}
 *   coverage = 已映射 addedLine 数 / addedLine 总数；保证 aiAdded + humanAdded = addedLines.length
 */
// commit 1-based 行号 → step 0-based 行索引（仅 equal 区间可映射）；无可映射返回 null。
function buildCommitToStepMap(stepContent, commitContent) {
  if (!stepContent || !commitContent) return null;
  const opcodes = lineDiff(stepContent, commitContent);
  if (!opcodes || opcodes.length === 0) return null;
  const map = new Map();
  for (const op of opcodes) {
    if (op.tag !== 'equal') continue;
    for (let j = op.newStart; j < op.newEnd; j++) {
      map.set(j + 1, op.oldStart + (j - op.newStart));
    }
  }
  return map;
}

// 单个 added 行（commit 1-based 行号）→ 归因档（ai/human/unknown）。
function classifyAddedLine(lineNo, commitToStep, stepBlameMap, stepIds) {
  const stepIdx = commitToStep.get(lineNo);
  if (stepIdx !== undefined && stepIdx >= 0 && stepIdx < stepBlameMap.lines.length) {
    const lineBlame = stepBlameMap.lines[stepIdx];
    if (!lineBlame || lineBlame === UNKNOWN_BLAME) return 'unknown';
    if (stepIds.has(lineBlame)) return 'ai';
    return 'human';
  }
  // 未映射（insert/replace 区间或越界）：保守计 unknown，避免高估 AI 或 human。
  return 'unknown';
}

export function projectStepBlameToCommit(stepContent, commitContent, stepBlameMap, addedLines, stepIds) {
  const added = Array.isArray(addedLines) ? addedLines : [];
  if (added.length === 0) return { aiAdded: 0, humanAdded: 0, unknownAdded: 0, coverage: 0 };
  if (!stepContent || !commitContent || !stepBlameMap || !stepBlameMap.lines) {
    return { aiAdded: 0, humanAdded: 0, unknownAdded: added.length, coverage: 0 };
  }
  const commitToStep = buildCommitToStepMap(stepContent, commitContent);
  if (!commitToStep) {
    return { aiAdded: 0, humanAdded: 0, unknownAdded: added.length, coverage: 0 };
  }

  let aiAdded = 0;
  let humanAdded = 0;
  let unknownAdded = 0;
  let mapped = 0;
  for (const lineNo of added) {
    const stepIdx = commitToStep.get(lineNo);
    if (stepIdx !== undefined && stepIdx >= 0 && stepIdx < stepBlameMap.lines.length) {
      mapped++;
      const lineBlame = stepBlameMap.lines[stepIdx];
      if (!lineBlame || lineBlame === UNKNOWN_BLAME) unknownAdded++;
      else if (stepIds.has(lineBlame)) aiAdded++;
      else humanAdded++;
    } else {
      // 未映射（insert/replace 区间或越界）：保守计 unknown，避免高估 AI 或 human。
      unknownAdded++;
    }
  }

  return { aiAdded, humanAdded, unknownAdded, coverage: mapped / added.length };
}

/**
 * 逐行版 drift 投影：返回每个 added 行（commit 1-based）的归因档数组。
 * 与 projectStepBlameToCommit 共用 buildCommitToStepMap / classifyAddedLine，
 * 用于行级 precision/recall 基准（test/fixtures/attribution-benchmark/generate.js），
 * 也是 #16 审计下钻的逐行原语种子。
 *
 * ponytail: count 版本未来可改为从本函数聚合，当前保持双写以隔离生产热路径回归风险。
 */
export function projectStepBlameToCommitPerLine(stepContent, commitContent, stepBlameMap, addedLines, stepIds) {
  const added = Array.isArray(addedLines) ? addedLines : [];
  if (added.length === 0) return [];
  if (!stepContent || !commitContent || !stepBlameMap || !stepBlameMap.lines) {
    return added.map(() => 'unknown');
  }
  const commitToStep = buildCommitToStepMap(stepContent, commitContent);
  if (!commitToStep) return added.map(() => 'unknown');
  return added.map(lineNo => classifyAddedLine(lineNo, commitToStep, stepBlameMap, stepIds));
}
