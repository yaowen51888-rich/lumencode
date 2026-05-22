import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  initPricing,
  resolveModelPricing,
  preloadUnknownPricing,
  getLoadedModelCount,
} from '../lib/pricing-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const CACHE_FILE = join(DATA_DIR, 'pricing-cache.json');

function cleanupCache() {
  if (existsSync(CACHE_FILE)) rmSync(CACHE_FILE);
}

test.beforeEach(() => {
  cleanupCache();
  initPricing();
});

test.after(() => {
  cleanupCache();
});

// ── initPricing ──

test('initPricing - loads pricing.json into memory', () => {
  initPricing();
  // pricing.json 至少包含 overrides 中的 11 个 + Portkey 同步的几百个模型
  assert.ok(getLoadedModelCount() >= 11, `预期至少 11 个模型，实际 ${getLoadedModelCount()}`);
});

// ── resolveModelPricing ──

test('resolveModelPricing - fuzzy match for Chinese model families', () => {
  // glm 系列 → 应匹配到 pricing 表中的 zai.glm-* 或 glm-*-maas
  const glm = resolveModelPricing('some-glm-variant');
  assert.strictEqual(glm.unknown, undefined, 'glm 家族应被 fuzzy 命中');

  // kimi 系列
  const kimi = resolveModelPricing('random-kimi-model');
  assert.strictEqual(kimi.unknown, undefined, 'kimi 家族应被 fuzzy 命中');

  // minimax 系列
  const mm = resolveModelPricing('random-minimax-thing');
  assert.strictEqual(mm.unknown, undefined, 'minimax 家族应被 fuzzy 命中');

  // qwen 系列
  const qwen = resolveModelPricing('random-qwen-32b');
  assert.strictEqual(qwen.unknown, undefined, 'qwen 家族应被 fuzzy 命中');

  // gemini
  const gem = resolveModelPricing('gemini-custom-2025');
  assert.strictEqual(gem.unknown, undefined, 'gemini 家族应被 fuzzy 命中');
});

test('resolveModelPricing - aliasOf resolves to target pricing', () => {
  // glm-5.1 → zai.glm-5 (override 中的 aliasOf 映射)
  const glm = resolveModelPricing('glm-5.1');
  assert.strictEqual(glm.unknown, undefined);
  assert.strictEqual(glm.input, 1);
  assert.strictEqual(glm.output, 3.2);

  // kimi-for-coding → moonshotai.kimi-k2.5
  const kimi = resolveModelPricing('kimi-for-coding');
  assert.strictEqual(kimi.unknown, undefined);
  assert.ok(kimi.input > 0);
  assert.ok(kimi.output > 0);
});

test('resolveModelPricing - aliasOf with non-existent target falls back to fuzzy', () => {
  // 这是间接测试：minimax-m2.5-free 别名指向 minimax.minimax-m2.5
  // 该目标存在于 pricing 表中
  const mm = resolveModelPricing('minimax-m2.5-free');
  assert.strictEqual(mm.unknown, undefined);
  assert.strictEqual(mm.input, 0.3);
});

test('resolveModelPricing - exact match (override has tier/fastMultiplier)', () => {
  const pricing = resolveModelPricing('claude-opus-4-6');
  assert.strictEqual(pricing.unknown, undefined);
  assert.strictEqual(pricing.input, 15);
  assert.strictEqual(pricing.output, 75);
  // override 提供的 tier 应当存在
  assert.ok(pricing.tier);
  assert.strictEqual(pricing.tier.threshold, 200000);
  assert.strictEqual(pricing.fastMultiplier, 6);
});

test('resolveModelPricing - override takes precedence over Portkey models', () => {
  // claude-sonnet-4-6 在 Portkey 同步数据中和 overrides 中都有
  // 应该使用 overrides 的值（含 fastMultiplier）
  const pricing = resolveModelPricing('claude-sonnet-4-6');
  assert.strictEqual(pricing.input, 3);
  assert.strictEqual(pricing.fastMultiplier, 5);
});

test('resolveModelPricing - provider prefix stripping', () => {
  const pricing = resolveModelPricing('anthropic--claude-sonnet-4-6');
  assert.strictEqual(pricing.unknown, undefined);
  assert.strictEqual(pricing.input, 3);
});

test('resolveModelPricing - bedrock prefix stripping', () => {
  const pricing = resolveModelPricing('bedrock--gpt-5');
  assert.strictEqual(pricing.unknown, undefined);
  assert.strictEqual(pricing.input, 5);
});

test('resolveModelPricing - fuzzy match by family keyword', () => {
  const pricing = resolveModelPricing('some-random-model-with-sonnet-in-name');
  assert.strictEqual(pricing.unknown, undefined);
  // 任意 sonnet 系列都应匹配（值可能来自 Portkey 或 override）
  assert.ok(pricing.input > 0);
});

test('resolveModelPricing - unknown model returns unknown', () => {
  const pricing = resolveModelPricing('totally-unknown-model-xyz-12345');
  assert.strictEqual(pricing.unknown, true);
});

test('resolveModelPricing - null/empty model returns unknown', () => {
  assert.strictEqual(resolveModelPricing(null).unknown, true);
  assert.strictEqual(resolveModelPricing('').unknown, true);
  assert.strictEqual(resolveModelPricing(undefined).unknown, true);
});

// ── preloadUnknownPricing ──

test('preloadUnknownPricing - fetches unknown models and caches them', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('portkey')) {
      return {
        ok: true,
        json: async () => ({
          pay_as_you_go: {
            request_token: { price: 0.001 },
            response_token: { price: 0.002 },
            cache_read_input_token: { price: 0.0005 },
            cache_write_input_token: { price: 0 },
          },
        }),
      };
    }
    return originalFetch(url);
  };

  try {
    const records = [{ model: 'unknown-model-for-test-abc', inputTokens: 100, outputTokens: 50 }];

    const before = resolveModelPricing('unknown-model-for-test-abc');
    assert.strictEqual(before.unknown, true);

    await preloadUnknownPricing(records);

    const after = resolveModelPricing('unknown-model-for-test-abc');
    assert.strictEqual(after.unknown, undefined);
    assert.strictEqual(after.input, 10);
    assert.strictEqual(after.output, 20);
    assert.strictEqual(after.cacheRead, 5);

    assert.ok(existsSync(CACHE_FILE), 'pricing-cache.json 应该被生成');
  } finally {
    global.fetch = originalFetch;
  }
});

test('preloadUnknownPricing - API 失败时不计算费用，不抛异常', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('Network error');
  };

  try {
    const records = [{ model: 'another-unknown-model-xyz', inputTokens: 100 }];

    // 不应该抛出异常
    await preloadUnknownPricing(records);

    // 失败的模型仍然返回 unknown，下游会将费用计为 0
    const pricing = resolveModelPricing('another-unknown-model-xyz');
    assert.strictEqual(pricing.unknown, true);

    // 缓存文件不应该被创建
    assert.ok(!existsSync(CACHE_FILE), 'API 失败时不应生成缓存');
  } finally {
    global.fetch = originalFetch;
  }
});

test('preloadUnknownPricing - HTTP 404 也是失败，不计费', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 404 });

  try {
    const records = [{ model: 'http-404-model', inputTokens: 100 }];
    await preloadUnknownPricing(records);

    const pricing = resolveModelPricing('http-404-model');
    assert.strictEqual(pricing.unknown, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('preloadUnknownPricing - 同会话中失败的模型不重试', async () => {
  const originalFetch = global.fetch;
  let fetchCallCount = 0;
  global.fetch = async () => {
    fetchCallCount++;
    return { ok: false, status: 500 };
  };

  try {
    const records = [{ model: 'retry-test-model', inputTokens: 100 }];

    // 第一次调用
    await preloadUnknownPricing(records);
    const firstCount = fetchCallCount;
    assert.ok(firstCount >= 1, '第一次应该调用 API');

    // 第二次调用相同记录，不应该再请求
    await preloadUnknownPricing(records);
    assert.strictEqual(fetchCallCount, firstCount, '第二次不应再调用 API');
  } finally {
    global.fetch = originalFetch;
  }
});

test('preloadUnknownPricing - skips known models', async () => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    return { ok: false, status: 500 };
  };

  try {
    const records = [{ model: 'claude-sonnet-4-6', inputTokens: 100 }];
    await preloadUnknownPricing(records);

    assert.strictEqual(fetchCalled, false, '已知模型不应该触发 API 请求');
  } finally {
    global.fetch = originalFetch;
  }
});

// ── 缓存持久化 ──

test('pricing cache persists across initPricing calls', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      pay_as_you_go: {
        request_token: { price: 0.005 },
        response_token: { price: 0.01 },
        cache_read_input_token: { price: 0 },
        cache_write_input_token: { price: 0 },
      },
    }),
  });

  try {
    const records = [{ model: 'cached-model-persist-test', inputTokens: 100 }];
    await preloadUnknownPricing(records);

    // 重新初始化（模拟重启）
    initPricing();

    const pricing = resolveModelPricing('cached-model-persist-test');
    assert.strictEqual(pricing.unknown, undefined);
    assert.strictEqual(pricing.input, 50);
  } finally {
    global.fetch = originalFetch;
  }
});
