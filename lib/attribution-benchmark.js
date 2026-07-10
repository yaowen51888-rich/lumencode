import { readFileSync } from 'fs';

const CLASSES = ['ai', 'human', 'unknown'];

function normalizeClass(value) {
  const v = String(value || '').toLowerCase();
  return CLASSES.includes(v) ? v : 'unknown';
}

function safeRatio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

export function loadAttributionBenchmark(filePath) {
  const fixture = JSON.parse(readFileSync(filePath, 'utf-8'));
  if (!Array.isArray(fixture.cases)) {
    throw new Error('benchmark fixture must contain cases');
  }
  return fixture;
}

export function computeAttributionBenchmark(fixture) {
  const cases = Array.isArray(fixture?.cases) ? fixture.cases : [];
  const totals = Object.fromEntries(CLASSES.map(name => [
    name,
    { truePositive: 0, falsePositive: 0, falseNegative: 0 },
  ]));
  let totalLines = 0;
  let correctLines = 0;

  for (const [caseIndex, item] of cases.entries()) {
    const expected = Array.isArray(item.expected) ? item.expected.map(normalizeClass) : [];
    const actual = Array.isArray(item.actual) ? item.actual.map(normalizeClass) : [];
    if (expected.length !== actual.length) {
      const id = item.id || `case-${caseIndex}`;
      throw new Error(`line count mismatch in ${id}`);
    }

    for (let i = 0; i < expected.length; i++) {
      const exp = expected[i];
      const act = actual[i];
      totalLines++;
      if (exp === act) correctLines++;
      for (const cls of CLASSES) {
        if (act === cls && exp === cls) totals[cls].truePositive++;
        else if (act === cls && exp !== cls) totals[cls].falsePositive++;
        else if (act !== cls && exp === cls) totals[cls].falseNegative++;
      }
    }
  }

  const classes = {};
  for (const cls of CLASSES) {
    const raw = totals[cls];
    classes[cls] = {
      ...raw,
      precision: safeRatio(raw.truePositive, raw.truePositive + raw.falsePositive),
      recall: safeRatio(raw.truePositive, raw.truePositive + raw.falseNegative),
    };
  }

  return {
    totalLines,
    correctLines,
    accuracy: safeRatio(correctLines, totalLines),
    classes,
  };
}
