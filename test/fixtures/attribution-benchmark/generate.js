// 行级归因 precision/recall 基准场景生成器。
//
// 每个场景脚本化构造一份已知 ground-truth 的文件演化，跑归因数学（computeBlame 链
// + projectStepBlameToCommitPerLine），产出逐行 expected/actual 供 attribution-benchmark.js
// 计算 precision/recall。
//
// 忠实性：computeBlame / buildInitialBlameMap 即生产 recordStep（lib/step-tracker.js:196-203）
// 构建 blame_map 的同一函数；projectStepBlameToCommitPerLine 复用 drift 投影同一映射。
// 故此处直接调用 = 复刻生产归因数学，无需 git 二进制 / steps.db。
//
// 两类系统性偏差的锚点场景：
//   偏差1（低估 AI）：drift-prettier / drift-human-insert —— AI 写的行经格式化/重排后
//     行映射断裂，落 unknown，AI 贡献被压低（recall 下降）。
//   偏差2（高估 AI）：blame-break —— 旧 blame 越界/缺失行已改判 unknown（不再归 AI），
//     本场景固化该修复为回归 floor。
//
// 不含「比例降级」场景：degraded 走整文件比例法（按 aiRatio 分配），无逐行 ground truth，
// 其可信度由 lineCoverage / attributionQuality 指标（#5 第2步已透出）度量，不在此逐行 P/R 内。

import { fileURLToPath } from 'url';
import {
  computeBlame,
  buildInitialBlameMap,
  projectStepBlameToCommitPerLine,
  UNKNOWN_BLAME,
} from '../../../lib/line-blame.js';
import { computeAttributionBenchmark } from '../../../lib/attribution-benchmark.js';

// AI 步骤的 blame hash（∈ stepIds → 归 ai）；HUMAN_HASH 模拟「来自非当前 commit session
// 的行」（∉ stepIds → 归 human，即生产里 relevant-step 过滤后判 human 的同口径）。
const AI_HASH = 'step-ai-1';
const HUMAN_HASH = 'step-human';

function toText(lines) {
  return lines.length ? lines.join('\n') + '\n' : '';
}

function classifyBlameLine(blameHash, stepIds) {
  if (!blameHash || blameHash === UNKNOWN_BLAME) return 'unknown';
  return stepIds.has(blameHash) ? 'ai' : 'human';
}

// ── 场景 ──

// 1. 纯 AI 写入，commit == step（aligned happy path）。期望 ai P/R = 1.0。
function scenarioAiCleanAligned() {
  const lines = ['const a = 1;', 'const b = 2;', 'const c = 3;'];
  const stepIds = new Set([AI_HASH]);
  const blame = buildInitialBlameMap(toText(lines), AI_HASH);
  return {
    id: 'ai-clean-aligned',
    expected: lines.map(() => 'ai'),
    actual: blame.lines.map(h => classifyBlameLine(h, stepIds)),
  };
}

// 2. 整文件来自非当前 session（blame ∉ stepIds）。期望 human P/R = 1.0，无 AI 过判。
function scenarioHumanOnly() {
  const lines = ['// human wrote this', '// and this', '// and this too'];
  const stepIds = new Set([AI_HASH]);
  const blame = { lines: lines.map(() => HUMAN_HASH) };
  return {
    id: 'human-only',
    expected: lines.map(() => 'human'),
    actual: blame.lines.map(h => classifyBlameLine(h, stepIds)),
  };
}

// 3. blame 链断裂（偏差2）：旧 blame 只有 2 条但旧内容 4 行，equal 区越界 → unknown。
//    越界行诚实标 unknown（无证据），固化「不再归 AI」的修复为回归 floor。
function scenarioBlameBreak() {
  const oldLines = ['l1', 'l2', 'l3', 'l4'];
  const oldText = toText(oldLines); // newContent == oldContent（全 equal）
  const oldBlame = { lines: [AI_HASH, AI_HASH] }; // l3/l4 无历史证据
  const stepIds = new Set([AI_HASH]);
  const blame = computeBlame(oldText, oldText, oldBlame, AI_HASH);
  return {
    id: 'blame-break',
    expected: ['ai', 'ai', 'unknown', 'unknown'],
    actual: blame.lines.map(h => classifyBlameLine(h, stepIds)),
  };
}

// 4. drift — prettier 重排（偏差1，诚实低 recall）：AI 紧凑代码被格式化展开，
//    逐行映射断裂，多数 AI 行落 unknown。锚定 AI recall 的真实下界。
function scenarioDriftPrettier() {
  const stepLines = [
    '// header comment',       // prettier 原样保留 → 可映射
    'function f(){return 1;}', // 被展开为 3 行 → 不可映射
  ];
  const commitLines = [
    '// header comment',
    'function f() {',
    '  return 1;',
    '}',
  ];
  const stepIds = new Set([AI_HASH]);
  const stepBlame = buildInitialBlameMap(toText(stepLines), AI_HASH);
  const addedLines = commitLines.map((_, i) => i + 1); // 新文件，所有行 added
  const actual = projectStepBlameToCommitPerLine(
    toText(stepLines), toText(commitLines), stepBlame, addedLines, stepIds
  );
  return {
    id: 'drift-prettier',
    expected: commitLines.map(() => 'ai'), // 真实作者都是 AI
    actual,
  };
}

// 5. drift — 人工插行（混合）：AI 写 base，人工在中间插 2 行（无 step），混合 commit。
//    drift 投影无法证明人工插入行 → 落 unknown，丢失 human 信号（诚实度量该限制）。
function scenarioDriftHumanInsert() {
  const stepLines = ['const a = 1;', 'const b = 2;', 'const c = 3;'];
  const commitLines = [
    'const a = 1;',
    'const b = 2;',
    '// human inserted',
    '// human inserted 2',
    'const c = 3;',
  ];
  const stepIds = new Set([AI_HASH]);
  const stepBlame = buildInitialBlameMap(toText(stepLines), AI_HASH);
  const addedLines = commitLines.map((_, i) => i + 1);
  const actual = projectStepBlameToCommitPerLine(
    toText(stepLines), toText(commitLines), stepBlame, addedLines, stepIds
  );
  return {
    id: 'drift-human-insert',
    expected: ['ai', 'ai', 'human', 'human', 'ai'],
    actual,
  };
}

// 6. AI 重写（replace 算子）：step2 用 computeBlame 替换 step1 一行，新行归 AI。
function scenarioAiRewriteReplace() {
  const s1Lines = ['const a = 1;', 'const b = 2;', 'const c = 3;'];
  const s2Lines = ['const a = 1;', 'const B = 22;', 'const c = 3;'];
  const stepIds = new Set([AI_HASH]);
  const s1Blame = buildInitialBlameMap(toText(s1Lines), AI_HASH);
  const s2Blame = computeBlame(toText(s1Lines), toText(s2Lines), s1Blame, AI_HASH);
  return {
    id: 'ai-rewrite-replace',
    expected: ['ai', 'ai', 'ai'],
    actual: s2Blame.lines.map(h => classifyBlameLine(h, stepIds)),
  };
}

const SCENARIO_BUILDERS = [
  scenarioAiCleanAligned,
  scenarioHumanOnly,
  scenarioBlameBreak,
  scenarioDriftPrettier,
  scenarioDriftHumanInsert,
  scenarioAiRewriteReplace,
];

export function generateBenchmarkCases() {
  return {
    name: 'line-level-attribution-bias-benchmark',
    cases: SCENARIO_BUILDERS.map(build => build()),
  };
}

function fmt(x) {
  if (!Number.isFinite(x)) return '  -  ';
  return x.toFixed(2).padStart(4);
}

function main() {
  const fixture = generateBenchmarkCases();
  const overall = computeAttributionBenchmark(fixture);

  const header = ['scenario', 'lines', 'ai-P', 'ai-R', 'hum-P', 'hum-R', 'unk-P', 'unk-R', 'acc'];
  const rows = fixture.cases.map(c => {
    const r = computeAttributionBenchmark({ cases: [c] });
    return [
      c.id,
      String(r.totalLines),
      fmt(r.classes.ai.precision), fmt(r.classes.ai.recall),
      fmt(r.classes.human.precision), fmt(r.classes.human.recall),
      fmt(r.classes.unknown.precision), fmt(r.classes.unknown.recall),
      fmt(r.accuracy),
    ];
  });

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map(r => r[i].length)));

  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log('\n=== Attribution Benchmark: line-level precision/recall ===');
  console.log(line(header));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  console.log(line([
    'OVERALL',
    String(overall.totalLines),
    fmt(overall.classes.ai.precision), fmt(overall.classes.ai.recall),
    fmt(overall.classes.human.precision), fmt(overall.classes.human.recall),
    fmt(overall.classes.unknown.precision), fmt(overall.classes.unknown.recall),
    fmt(overall.accuracy),
  ]));
  console.log('');
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
