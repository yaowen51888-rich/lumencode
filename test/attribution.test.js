import test from 'node:test';
import { strict as assert } from 'node:assert';
import { classifyAttribution, aggregateAttribution } from '../lib/attribution.js';

test('classifyAttribution - manual override wins over auto evidence', () => {
  const result = classifyAttribution({
    commitHash: 'abc',
    aiConfidence: 'high',
    attributionType: 'explicit',
    override: { classification: 'human', primaryTool: 'codex', tools: ['codex'] },
  });

  assert.equal(result.classification, 'human');
  assert.equal(result.primaryTool, 'codex');
  assert.equal(result.source, 'manual');
});

test('classifyAttribution - explicit signature becomes confirmed AI', () => {
  const result = classifyAttribution({
    commitHash: 'def',
    aiConfidence: 'high',
    attributionType: 'explicit',
    primaryTool: 'claude',
  });

  assert.equal(result.classification, 'confirmed_ai');
  assert.equal(result.primaryTool, 'claude');
  assert.equal(result.reason, 'explicit_signature');
});

test('classifyAttribution - weak session becomes possible AI', () => {
  const result = classifyAttribution({
    commitHash: 'ghi',
    aiConfidence: 'low',
    aiAssisted: true,
    sessionAttribution: 'weak',
    primaryTool: 'opencode',
  });

  assert.equal(result.classification, 'possible_ai');
  assert.equal(result.primaryTool, 'opencode');
  assert.equal(result.reason, 'time_window');
});

test('aggregateAttribution - splits line totals by classification', () => {
  const summary = aggregateAttribution([
    { classification: 'confirmed_ai', added: 10, deleted: 2 },
    { classification: 'probable_ai', added: 5, deleted: 1 },
    { classification: 'possible_ai', added: 3, deleted: 0 },
    { classification: 'unknown', added: 2, deleted: 2, reason: 'no_session_match' },
    { classification: 'human', added: 7, deleted: 1 },
  ]);

  assert.equal(summary.confirmedAI, 1);
  assert.equal(summary.probableAI, 1);
  assert.equal(summary.possibleAI, 1);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.human, 1);
  assert.equal(summary.confirmedAILines, 12);
  assert.equal(summary.probableAILines, 6);
  assert.equal(summary.possibleAILines, 3);
  assert.equal(summary.unknownLines, 4);
  assert.equal(summary.humanLines, 8);
  assert.equal(summary.totalLinesChanged, 33);
  assert.ok(summary.unknownReasons.includes('no_session_match'));
});
