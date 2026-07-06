#!/usr/bin/env node
/**
 * scripts/sync-pricing.js
 *
 * 从 Portkey 单模型 API 刷新「实际使用过」的模型定价到 data/pricing.json 的 models 字段。
 *
 * 为什么不全量：Portkey 无免费批量端点（/v1/pricing 需 API key，configs.portkey.ai/pricing
 * S3 返回 403），且 590 个存量键的 provider 映射已丢失，逐个猜 provider 大多 404。故只刷
 * 日志里真实命中的模型——这正是计费实际依赖的切片。China 厂商（glm/kimi/minimax）Portkey
 * 多无收录，靠 overrides 手维护权威价，本脚本不动 overrides。
 *
 * 用法: npm run sync:pricing
 */
import { readFileSync, writeFileSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseAllEnabledTools } from '../lib/parsers/index.js';
import { registerAllParsers } from '../lib/parsers/register.js';
import { detectClaudeDir, deriveProjectPaths } from '../lib/parser.js';
import { loadConfig } from '../lib/config.js';
import { inferProvider, convertPortkeyPricing } from '../lib/pricing-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRICING_FILE = join(__dirname, '..', 'data', 'pricing.json');
const PORTKEY_URL = 'https://api.portkey.ai/model-configs/pricing';
const CONCURRENCY = 5;

async function fetchOne(model) {
  const provider = inferProvider(model);
  const url = `${PORTKEY_URL}/${provider}/${encodeURIComponent(model)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return convertPortkeyPricing(await res.json()); // null = 无 pay_as_you_go 数据
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function samePrice(a, b) {
  return a && b
    && a.input === b.input
    && a.output === b.output
    && (a.cacheRead || 0) === (b.cacheRead || 0)
    && (a.cacheCreate || 0) === (b.cacheCreate || 0);
}

// 扫描日志，收集真实出现过的模型名（不按项目筛，避免漏掉其他项目里的新模型）
async function collectUsedModels() {
  registerAllParsers();
  let config = loadConfig();
  if (!config.claudeDir) config.claudeDir = detectClaudeDir();
  if ((!config.repos || config.repos.length === 0) && config.claudeDir) {
    try {
      config._autoRepos = deriveProjectPaths(config.claudeDir, config.excludeProjects || []);
      config.repos = config._autoRepos;
    } catch { /* 推导失败不影响同步 */ }
  }

  const { records } = await parseAllEnabledTools(config, { excludeProjects: config.excludeProjects });
  const used = new Set();
  for (const r of records) {
    const m = r.model || r.metadata?.model || '';
    if (m && !m.startsWith('<')) used.add(m);
  }
  return used;
}

async function main() {
  const pricing = JSON.parse(readFileSync(PRICING_FILE, 'utf-8'));
  pricing.models = pricing.models || {};
  pricing.overrides = pricing.overrides || {};
  const overrideKeys = new Set(Object.keys(pricing.overrides));

  console.error('扫描日志中的模型...');
  const used = await collectUsedModels();
  console.error(`实际使用模型 (${used.size}): ${[...used].join(', ') || '(无)'}`);

  const queue = [...used];
  const c = { added: 0, updated: 0, unchanged: 0, overrideSkipped: 0, noPricing: 0 };

  async function worker() {
    while (queue.length) {
      const model = queue.shift();
      if (overrideKeys.has(model)) { c.overrideSkipped++; continue; } // override 权威，不覆盖
      const fresh = await fetchOne(model);
      if (!fresh) { c.noPricing++; continue; } // Portkey 无收录 / 网络/超时
      const existing = pricing.models[model];
      if (existing && samePrice(existing, fresh)) {
        c.unchanged++;
      } else {
        pricing.models[model] = fresh;
        if (existing) c.updated++; else c.added++;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  pricing._meta = pricing._meta || {};
  pricing._meta.syncedAt = new Date().toISOString();
  pricing._meta.modelCount = Object.keys(pricing.models).length;

  // 原子写：tmp+rename，防并发截断
  const tmp = `${PRICING_FILE}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(pricing, null, 2) + '\n', 'utf-8');
  renameSync(tmp, PRICING_FILE);

  console.log(`同步完成: 新增 ${c.added} / 更新 ${c.updated} / 无变化 ${c.unchanged} / override跳过 ${c.overrideSkipped} / Portkey无收录 ${c.noPricing} / 实际模型 ${used.size}`);
}

main().catch(err => { console.error('同步失败:', err); process.exit(1); });
