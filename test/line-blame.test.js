import test from 'node:test';
import { strict as assert } from 'node:assert';
import { lineDiff, computeBlame, buildInitialBlameMap } from '../lib/line-blame.js';

// ── lineDiff tests ──

test('lineDiff - identical content returns single equal op', () => {
  const ops = lineDiff('line A\nline B\nline C', 'line A\nline B\nline C');
  assert.equal(ops.length, 1);
  assert.equal(ops[0].tag, 'equal');
  assert.equal(ops[0].oldStart, 0);
  assert.equal(ops[0].oldEnd, 3);
});

test('lineDiff - empty to content returns single insert', () => {
  const ops = lineDiff('', 'line A\nline B');
  assert.equal(ops.length, 1);
  assert.equal(ops[0].tag, 'insert');
  assert.equal(ops[0].newEnd, 2);
});

test('lineDiff - content to empty returns single delete', () => {
  const ops = lineDiff('line A\nline B', '');
  assert.equal(ops.length, 1);
  assert.equal(ops[0].tag, 'delete');
  assert.equal(ops[0].oldEnd, 2);
});

test('lineDiff - single line change produces replace', () => {
  const ops = lineDiff('line A\nline B\nline C', 'line A\nline X\nline C');
  // Should have: equal(A), replace(B->X), equal(C)
  assert.ok(ops.length >= 2);
  const hasReplace = ops.some(op => op.tag === 'replace' || op.tag === 'insert' || op.tag === 'delete');
  assert.ok(hasReplace);
});

test('lineDiff - insert in middle', () => {
  const ops = lineDiff('A\nC', 'A\nB\nC');
  const inserts = ops.filter(op => op.tag === 'insert');
  assert.ok(inserts.length > 0);
});

// ── computeBlame tests ──

test('computeBlame - new file attributes all lines to current step', () => {
  const result = computeBlame(null, 'line 1\nline 2\nline 3', null, 'step1');
  assert.equal(result.lines.length, 3);
  assert.deepEqual(result.lines, ['step1', 'step1', 'step1']);
});

test('computeBlame - no change preserves old attribution', () => {
  const oldBlame = { lines: ['old1', 'old2', 'old3'] };
  const result = computeBlame('A\nB\nC', 'A\nB\nC', oldBlame, 'step2');
  assert.equal(result.lines.length, 3);
  assert.deepEqual(result.lines, ['old1', 'old2', 'old3']);
});

test('computeBlame - edit middle line updates only that line', () => {
  const oldBlame = { lines: ['old1', 'old2', 'old3'] };
  const result = computeBlame('A\nB\nC', 'A\nX\nC', oldBlame, 'step2');
  assert.equal(result.lines.length, 3);
  assert.equal(result.lines[0], 'old1');    // preserved
  assert.equal(result.lines[1], 'step2');   // changed
  assert.equal(result.lines[2], 'old3');    // preserved
});

test('computeBlame - insert lines get current step', () => {
  const oldBlame = { lines: ['old1', 'old2'] };
  const result = computeBlame('A\nB', 'A\nX\nY\nB', oldBlame, 'step3');
  assert.ok(result.lines.length >= 3);
  // First line preserved, inserted lines get step3
  assert.equal(result.lines[0], 'old1');
  assert.ok(result.lines.includes('step3'));
});

test('computeBlame - delete lines removes from blame', () => {
  const oldBlame = { lines: ['old1', 'old2', 'old3'] };
  const result = computeBlame('A\nB\nC', 'A\nC', oldBlame, 'step4');
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0], 'old1');
  assert.equal(result.lines[1], 'old3');
});

test('computeBlame - empty old and new content', () => {
  const result = computeBlame('', '', null, 'step5');
  assert.equal(result.lines.length, 0);
});

test('computeBlame - multiple edits in one step', () => {
  const oldBlame = { lines: ['s0', 's0', 's0', 's0', 's0'] };
  const result = computeBlame(
    'A\nB\nC\nD\nE',
    'A\nX\nC\nY\nE',
    oldBlame,
    'step6'
  );
  assert.equal(result.lines.length, 5);
  assert.equal(result.lines[0], 's0');    // A preserved
  assert.equal(result.lines[1], 'step6'); // B→X changed
  assert.equal(result.lines[2], 's0');    // C preserved
  assert.equal(result.lines[3], 'step6'); // D→Y changed
  assert.equal(result.lines[4], 's0');    // E preserved
});

// ── buildInitialBlameMap tests ──

test('buildInitialBlameMap - assigns all lines to step', () => {
  const result = buildInitialBlameMap('a\nb\nc', 'step0');
  assert.equal(result.lines.length, 3);
  assert.deepEqual(result.lines, ['step0', 'step0', 'step0']);
});

test('buildInitialBlameMap - empty content', () => {
  const result = buildInitialBlameMap('', 'step0');
  assert.equal(result.lines.length, 0);
});

test('buildInitialBlameMap - null content', () => {
  const result = buildInitialBlameMap(null, 'step0');
  assert.equal(result.lines.length, 0);
});
