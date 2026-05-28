export const DEFAULT_ATTRIBUTION_OPTIONS = {
  windows: {
    weakWindowMinutes: 30,
    crossDayWindowDays: 3,
  },
  confidenceThresholds: {
    high: 0.75,
    medium: 0.45,
    low: 0.20,
  },
  confidenceWeights: {
    high: 1.0,
    medium: 0.7,
    low: 0.2,
    none: 0,
  },
  scoreWeights: {
    explicitSignature: 0.85,
    explicitAuthor: 0.80,
    genericAISignature: 0.70,
    sessionStrong: 0.40,
    sessionCrossDay: 0.25,
    sessionWeak: 0.15,
    sessionCrossDayWeak: 0.10,
    fileOverlap: 0.30,
    styleBulletList: 0.15,
    styleConventionalScope: 0.05,
    styleImperativeMood: 0.10,
    styleLongStructuredBody: 0.05,
    baselineDeviationHigh: 0.15,
    baselineDeviationMedium: 0.08,
    negativeMergeCommit: -0.50,
    negativeInformal: -0.20,
    negativeSmallScope: -0.15,
    negativeWIP: -0.15,
    humanBaselineMatch: -0.10,
  },
  explicitSignalPolicy: {
    coAuthor: 'strong',
    generatedWith: 'strong',
    assistedBy: 'strong',
    robotEmoji: 'medium',
    genericAIKeywords: 'medium',
  },
};

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveNumber(value, fallback) {
  return finiteNumber(value) && value > 0 ? value : fallback;
}

function ratioNumber(value, fallback) {
  return finiteNumber(value) && value >= 0 && value <= 1 ? value : fallback;
}

function normalizeThresholds(input = {}, defaults) {
  let high = ratioNumber(input.high, defaults.high);
  let medium = ratioNumber(input.medium, defaults.medium);
  let low = ratioNumber(input.low, defaults.low);

  if (high < medium) high = defaults.high;
  if (medium < low) medium = defaults.medium;
  if (high < medium) medium = defaults.medium;
  if (medium < low) low = defaults.low;

  return { high, medium, low };
}

function normalizeWeights(input = {}, defaults) {
  return {
    high: ratioNumber(input.high, defaults.high),
    medium: ratioNumber(input.medium, defaults.medium),
    low: ratioNumber(input.low, defaults.low),
    none: ratioNumber(input.none, defaults.none),
  };
}

function scoreWeight(value, fallback) {
  return finiteNumber(value) && value >= -1 && value <= 1 ? value : fallback;
}

function normalizeScoreWeights(input = {}, defaults) {
  const result = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    result[key] = scoreWeight(input[key], fallback);
  }
  return result;
}

export function resolveAttributionOptions(input = {}) {
  const defaults = DEFAULT_ATTRIBUTION_OPTIONS;
  return {
    windows: {
      weakWindowMinutes: positiveNumber(input.windows?.weakWindowMinutes, defaults.windows.weakWindowMinutes),
      crossDayWindowDays: positiveNumber(input.windows?.crossDayWindowDays, defaults.windows.crossDayWindowDays),
    },
    confidenceThresholds: normalizeThresholds(input.confidenceThresholds, defaults.confidenceThresholds),
    confidenceWeights: normalizeWeights(input.confidenceWeights, defaults.confidenceWeights),
    scoreWeights: normalizeScoreWeights(input.scoreWeights, defaults.scoreWeights),
    explicitSignalPolicy: { ...defaults.explicitSignalPolicy, ...(input.explicitSignalPolicy || {}) },
  };
}
