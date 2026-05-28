import DiffMatchPatch from 'diff-match-patch';

const dmp = new DiffMatchPatch();

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
            lines.push(stepHash);
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
