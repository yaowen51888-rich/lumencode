import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const PRICING_FILE = join(DATA_DIR, 'pricing.json');
const CACHE_FILE = join(DATA_DIR, 'pricing-cache.json');

const PROVIDER_PREFIXES = ['anthropic--', 'bedrock--', 'vertex--'];

// Portkey API 端点
const PORTKEY_SINGLE_MODEL_URL = 'https://api.portkey.ai/model-configs/pricing';

// 内存中的合并定价表
let pricingTable = new Map();
// 记录已尝试过 API 查询但失败的模型，避免重复请求
const apiFailedModels = new Set();
// ponytail: resolve 结果缓存，避免热循环（computeCostFromRecords 等）对同一未知模型
// 反复走 O(n) fuzzy 扫表。table 变更（init / preload 新条目）时整体清空，杜绝脏读。
const resolveCache = new Map();
// fuzzy 命中登记：model → 实际计价用的表内 key，供 UI/报告标注「估算价」。
// 与 resolveCache 同生命周期清空（table 变更后模型可能改走精确匹配）。
const fuzzyMatches = new Map();
// 失败模型持久化 TTL：超过则允许重新尝试 API（Portkey 可能新增该模型）
const FAILED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// 失败时间戳（model → ms），与 pricing-cache.json 的 _meta.failedModels 对应
let failedTimestamps = {};
// 本轮 preload 是否产生新的失败记录，决定是否回写 cache 文件
let failedDirty = false;

// 模型家族关键词 → 用于 fuzzy match 的子串匹配规则
// 顺序：更具体的关键词放前面（如 gpt-4.1-mini 在 gpt-4.1 之前），避免被通用关键词截胡
const FUZZY_KEYWORDS = [
  // Claude
  'opus', 'sonnet', 'haiku',
  // OpenAI
  'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4.1', 'gpt-5', 'gpt-4o', 'gpt-4',
  'o4-mini', 'o3-pro', 'o3', 'o1',
  // Google
  'gemini',
  // 中国厂商
  'glm', 'kimi', 'minimax', 'qwen', 'deepseek', 'doubao', 'baichuan',
  'yi-', 'grok', 'llama',
  // Mistral
  'mistral', 'codestral',
];

// ── 内部工具 ──

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadJsonFile(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveJsonFile(filePath, data) {
  ensureDataDir();
  // ponytail: tmp+rename 原子写，防 web+MCP 并发截断致 JSON 解析失败、整份 cache 失效。
  // tmp 带 pid 避免多进程同瞬覆写同一临时文件；同目录保证 rename 不跨卷。
  const tmp = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, filePath);
}

function mergeIntoTable(source) {
  if (!source || typeof source !== 'object') return;
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('_')) continue;
    // 允许两种形式：{ input, output, ... } 或 { aliasOf: "target-name" }
    if (value && typeof value === 'object' && !value.unknown) {
      pricingTable.set(key, value);
    }
  }
}

// 解析 aliasOf 链：若 entry 是 { aliasOf: "..." }，递归查找最终定价
function resolveAlias(entry, depth = 0) {
  if (!entry || depth >= 5) return entry;
  if (entry.aliasOf && typeof entry.aliasOf === 'string') {
    const target = pricingTable.get(entry.aliasOf);
    if (target) return resolveAlias(target, depth + 1);
    // 别名指向的目标不存在：尝试 fuzzy 查找一次（覆盖 Portkey 同步键）
    const fuzzy = fuzzyLookup(entry.aliasOf.toLowerCase());
    if (fuzzy) return resolveAlias(fuzzy.pricing, depth + 1);
    return { unknown: true };
  }
  return entry;
}

// 变体后缀词：模型与候选 key 的变体不一致（如 o3 vs o3-pro、gpt-4.1 vs gpt-4.1-mini）
// 意味着定价档位完全不同，重罚使其实质性出局。
// 按词边界匹配（非字母作边界），避免 'proxy' 误触 'pro'、'flashlight' 误触 'flash' 之类子串误判
const VARIANT_TERMS = ['mini', 'nano', 'pro', 'flash', 'lite', 'turbo', 'air', 'thinking', 'free', 'preview', 'research']
  .map(term => ({ term, re: new RegExp(`(?:^|[^a-z])${term}(?:[^a-z]|$)`) }));

function digitRuns(s) {
  return s.match(/\d+/g) || [];
}

// 最长公共子序列长度（版本号序列很短，O(n*m) 足够）
function lcsLength(a, b) {
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

// 版本感知打分：共享版本号（4-8 / 4.8 / 20250514 统一按数字串序列比较）加分，
// 多余版本号轻罚，变体后缀不一致重罚；同分时更短的 key（更少杂质）胜出
function scoreFuzzyCandidate(modelLower, keyLower) {
  const mv = digitRuns(modelLower);
  const kv = digitRuns(keyLower);
  const lcs = lcsLength(mv, kv);
  let score = 10 * lcs - 2 * (mv.length - lcs) - 2 * (kv.length - lcs);
  for (const { re } of VARIANT_TERMS) {
    const inModel = re.test(modelLower);
    const inKey = re.test(keyLower);
    if (inModel && inKey) score += 5;
    else if (inModel !== inKey) score -= 25;
  }
  return score - keyLower.length * 0.01;
}

// 在表中按 fuzzy 关键词查找匹配项：候选取全体含关键词的 key，按版本感知评分选最优。
// 返回 { key, pricing } 或 null。
function fuzzyLookup(modelLower) {
  let matchedKeyword = null;
  for (const kw of FUZZY_KEYWORDS) {
    if (modelLower.includes(kw)) {
      matchedKeyword = kw;
      break;
    }
  }
  if (!matchedKeyword) return null;

  let best = null;
  let bestScore = -Infinity;
  for (const [key, pricing] of pricingTable) {
    const keyLower = key.toLowerCase();
    if (!keyLower.includes(matchedKeyword)) continue;
    const score = scoreFuzzyCandidate(modelLower, keyLower);
    if (score > bestScore) {
      bestScore = score;
      best = { key, pricing };
    }
  }
  return best;
}

export function inferProvider(modelName) {
  const lower = (modelName || '').toLowerCase();
  if (lower.includes('claude')) return 'anthropic';
  if (lower.includes('gemini') || lower.includes('palm')) return 'google';
  if (lower.includes('gpt') || lower.includes('o1') || lower.includes('o3') || lower.includes('o4')) return 'openai';
  if (lower.includes('deepseek')) return 'deepseek';
  if (lower.includes('mistral')) return 'mistral-ai';
  if (lower.includes('grok')) return 'xai';
  return 'openai';
}

// Portkey 格式 (cents/token) → 内部格式 ($/1M tokens)
export function convertPortkeyPricing(portkeyData) {
  if (!portkeyData || !portkeyData.pay_as_you_go) return null;

  const payg = portkeyData.pay_as_you_go;
  const getPrice = (field) => {
    const val = payg[field];
    if (val && typeof val.price === 'number') {
      return val.price * 10000;
    }
    return 0;
  };

  const result = {
    input: getPrice('request_token'),
    output: getPrice('response_token'),
    cacheRead: getPrice('cache_read_input_token'),
    cacheCreate: getPrice('cache_write_input_token'),
  };

  if (result.input === 0 && result.output === 0) return null;
  return result;
}

// ── 公共接口 ──

/**
 * 同步初始化定价模块。
 * 加载顺序（后加载的覆盖先加载的）：
 *   1. data/pricing.json 中的 models（Portkey 批量同步的数据）
 *   2. data/pricing-cache.json（运行时 API 查询缓存）
 *   3. data/pricing.json 中的 overrides（权威覆盖 + 别名映射）
 */
export function initPricing() {
  pricingTable.clear();
  apiFailedModels.clear();
  resolveCache.clear();
  fuzzyMatches.clear();

  const pricingData = loadJsonFile(PRICING_FILE);
  if (pricingData && pricingData.models) {
    mergeIntoTable(pricingData.models);
  }

  const cacheData = loadJsonFile(CACHE_FILE);
  if (cacheData && cacheData.models) {
    mergeIntoTable(cacheData.models);
  }

  // 恢复失败模型记忆：TTL 内的跳过 API 重试，超期的允许重试
  failedTimestamps = {};
  failedDirty = false;
  if (cacheData && cacheData._meta && cacheData._meta.failedModels) {
    const now = Date.now();
    for (const [m, ts] of Object.entries(cacheData._meta.failedModels)) {
      if (typeof ts === 'number' && now - ts < FAILED_TTL_MS) {
        apiFailedModels.add(m);
        failedTimestamps[m] = ts;
      }
    }
  }

  // overrides 最后加载，优先级最高
  if (pricingData && pricingData.overrides) {
    mergeIntoTable(pricingData.overrides);
  }
}

/**
 * 解析模型定价。
 * 四层回退：精确匹配 → 去 provider 前缀 → 家族关键词 fuzzy match → unknown。
 * 支持 aliasOf 别名映射（在 overrides 中可用 { aliasOf: "target" } 形式）。
 */
export function resolveModelPricing(model) {
  if (!model) return { unknown: true };

  if (pricingTable.size === 0) {
    initPricing();
  }

  const cached = resolveCache.get(model);
  if (cached) return cached;

  const result = resolveUncached(model);
  resolveCache.set(model, result);
  return result;
}

// 真正的四层回退解析；resolveModelPricing 负责缓存。
function resolveUncached(model) {
  // Tier 1: 精确匹配
  if (pricingTable.has(model)) {
    return resolveAlias(pricingTable.get(model));
  }

  // Tier 2: 去掉 provider 前缀
  let stripped = model;
  for (const prefix of PROVIDER_PREFIXES) {
    if (model.startsWith(prefix)) {
      stripped = model.slice(prefix.length);
      break;
    }
  }
  if (pricingTable.has(stripped)) {
    return resolveAlias(pricingTable.get(stripped));
  }

  // Tier 3: 按家族关键词 fuzzy 匹配。命中的是「相近模型」而非该模型本身，
  // 结果带 fuzzy 标记（浅拷贝，不污染表内共享对象），供下游标注「估算价」。
  const lower = stripped.toLowerCase();
  const hit = fuzzyLookup(lower);
  if (hit) {
    const resolved = resolveAlias(hit.pricing);
    if (!resolved || resolved.unknown) return { unknown: true };
    fuzzyMatches.set(model, hit.key);
    return { ...resolved, fuzzy: true, fuzzyKey: hit.key };
  }

  return { unknown: true };
}

/**
 * 返回本轮已发生的 fuzzy 定价命中：{ 模型名: 实际计价的表内 key }。
 * 用于在报告/UI 中标注哪些模型的费用是按相近模型估算的。
 */
export function getFuzzyPricingMatches() {
  return Object.fromEntries(fuzzyMatches);
}

function getModel(record) {
  return record.model || record.metadata?.model || '';
}

/**
 * 异步预加载所有未知模型的定价。
 * 扫描 records，对本地没有的模型调用 Portkey API。
 * - 成功：写入 pricing-cache.json，下次启动自动加载
 * - 失败：标记为已失败，本次会话不再重试；该模型定价为 unknown（不计算费用）
 */
// 标记模型查询失败：permanent=true 进 TTL 黑名单持久化；false 仅本会话去重（瞬时错误下次重启可重试）
function markFailed(model, permanent = true) {
  apiFailedModels.add(model);
  if (permanent) {
    failedTimestamps[model] = Date.now();
    failedDirty = true;
  }
}

export async function preloadUnknownPricing(records) {
  if (!records || records.length === 0) return;

  const unknownModels = new Set();
  for (const r of records) {
    const model = getModel(r);
    if (!model || apiFailedModels.has(model)) continue;
    const pricing = resolveModelPricing(model);
    if (pricing.unknown) {
      unknownModels.add(model);
    }
  }

  if (unknownModels.size === 0) return;

  const CONCURRENCY = 5;
  const models = [...unknownModels];
  const newCache = {};

  for (let i = 0; i < models.length; i += CONCURRENCY) {
    const batch = models.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (model) => {
        try {
          const provider = inferProvider(model);
          const url = `${PORTKEY_SINGLE_MODEL_URL}/${provider}/${encodeURIComponent(model)}`;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);

          const res = await fetch(url, { signal: controller.signal });
          clearTimeout(timeout);

          if (!res.ok) {
            // ponytail: 4xx（非 429）= 请求本身有问题（模型名/鉴权），重试无益 → 永久黑名单。
            // 5xx/429/网络错误是瞬时的，只做本会话去重不持久化，避免一次抖动让费用漏计 7 天。
            const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
            markFailed(model, permanent);
            return null;
          }

          const data = await res.json();
          const pricing = convertPortkeyPricing(data);
          if (pricing) {
            return { model, pricing };
          }
          markFailed(model); // 模型存在但无定价数据：永久
        } catch {
          markFailed(model, false); // 网络/超时/abort：瞬时
        }
        return null;
      })
    );

    for (const result of results) {
      if (result) {
        pricingTable.set(result.model, result.pricing);
        newCache[result.model] = result.pricing;
      }
    }
  }

  const hasNewModels = Object.keys(newCache).length > 0;
  if (hasNewModels || failedDirty) {
    if (hasNewModels) {
      resolveCache.clear(); // table 新增条目，旧 unknown 缓存失效
      fuzzyMatches.clear(); // 原 fuzzy 命中的模型现在可能有精确定价，重新登记
    }
    const existing = loadJsonFile(CACHE_FILE) || { _meta: { source: 'portkey-api-cache' }, models: {} };
    if (hasNewModels) {
      existing.models = { ...existing.models, ...newCache };
    }
    existing._meta.failedModels = failedTimestamps;
    existing._meta.updatedAt = new Date().toISOString();
    saveJsonFile(CACHE_FILE, existing);
    failedDirty = false;
  }
}

export function getLoadedModelCount() {
  return pricingTable.size;
}
