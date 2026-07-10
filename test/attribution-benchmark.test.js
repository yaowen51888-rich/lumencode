import test from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'path';
import { loadAttributionBenchmark, computeAttributionBenchmark } from '../lib/attribution-benchmark.js';

test('loadAttributionBenchmark reads benchmark fixtures', () => {
  const fixturePath = join('test', 'fixtures', 'attribution-benchmark.json');
  const fixture = loadAttributionBenchmark(fixturePath);

  assert.equal(fixture.name, 'mixed-ai-human-unknown-lines');
  assert.equal(fixture.cases.length, 1);
  assert.deepEqual(fixture.cases[0].expected, ['ai', 'ai', 'human', 'unknown', 'ai']);
});

test('computeAttributionBenchmark reports precision and recall per class', () => {
  const result = computeAttributionBenchmark({
    cases: [
      {
        expected: ['ai', 'ai', 'human', 'unknown', 'ai'],
        actual: ['ai', 'human', 'human', 'unknown', 'ai'],
      },
    ],
  });

  assert.equal(result.totalLines, 5);
  assert.equal(result.correctLines, 4);
  assert.equal(result.accuracy, 0.8);
  assert.equal(result.classes.ai.truePositive, 2);
  assert.equal(result.classes.ai.falsePositive, 0);
  assert.equal(result.classes.ai.falseNegative, 1);
  assert.equal(result.classes.ai.precision, 1);
  assert.equal(result.classes.ai.recall, 2 / 3);
  assert.equal(result.classes.human.precision, 0.5);
  assert.equal(result.classes.human.recall, 1);
  assert.equal(result.classes.unknown.precision, 1);
  assert.equal(result.classes.unknown.recall, 1);
});

test('computeAttributionBenchmark rejects mismatched line counts', () => {
  assert.throws(
    () => computeAttributionBenchmark({
      cases: [{ expected: ['ai'], actual: ['ai', 'human'] }],
    }),
    /line count mismatch/
  );
});
