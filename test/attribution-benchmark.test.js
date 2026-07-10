import test from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'path';
import { loadAttributionBenchmark, computeAttributionBenchmark } from '../lib/attribution-benchmark.js';
import { generateBenchmarkCases } from './fixtures/attribution-benchmark/generate.js';

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

// ── 真实场景回归 floor：行级归因精度不得静默回退 ──
// 数字来自 generate.js 首跑（2026-07-10）。floor 仅在有意提升精度时上调。
// 跑 `node test/fixtures/attribution-benchmark/generate.js` 看逐场景明细，贴 PR/README。

test('attribution benchmark scenarios meet regression floor', () => {
  const { cases } = generateBenchmarkCases();
  const perScenario = new Map(cases.map(c => [c.id, computeAttributionBenchmark({ cases: [c] })]));
  const overall = computeAttributionBenchmark({ cases });

  // 偏差2（高估 AI）硬守卫：任何场景都不得把无证据行误判为 AI → ai falsePositive 恒为 0。
  // 若 unknown fallback 修复被回滚，blame-break 越界行会归 AI，FP > 0，此处即失败。
  for (const [id, r] of perScenario) {
    assert.equal(r.classes.ai.falsePositive, 0, `${id}: ai falsePositive must be 0 (no false AI claim)`);
  }

  // 整体回归 floor
  assert.equal(overall.classes.ai.precision, 1, 'overall ai precision must stay 1.0');
  assert.ok(overall.accuracy >= 0.77 - 1e-9, `overall accuracy ${overall.accuracy} >= 0.77`);
  assert.ok(overall.classes.ai.recall >= 0.80 - 1e-9, `overall ai recall ${overall.classes.ai.recall} >= 0.80`);

  // 偏差1（低估 AI）诚实度量：drift-prettier 下格式化致行映射断裂，AI recall 显著 < 1.0，
  // 且不低于已观测 floor。证明低估偏差被量化而非隐藏。
  const drift = perScenario.get('drift-prettier');
  assert.ok(drift.classes.ai.recall < 1 - 1e-9, 'drift-prettier ai recall must be < 1.0 (bias measured)');
  assert.ok(drift.classes.ai.recall >= 0.25 - 1e-9,
    `drift-prettier ai recall ${drift.classes.ai.recall} >= 0.25 floor`);
});
