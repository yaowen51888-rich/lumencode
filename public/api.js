import { API } from './config.js';

// ── Request Guard ──
export function createLatestRequestGuard() {
  let currentId = 0;
  let currentController = null;

  return {
    next() {
      currentId += 1;
      if (currentController) currentController.abort();

      const id = currentId;
      currentController = new AbortController();

      return {
        signal: currentController.signal,
        isCurrent() {
          return id === currentId;
        },
      };
    },
  };
}

// ── Cached Fetch ──
const cache = new Map();
const pending = new Map();
const DEFAULT_TTL = 30_000;
const CACHE_MAX_SIZE = 50;

export function clearApiCache() {
  cache.clear();
  pending.clear();
}

export async function cachedFetch(url, options = {}, ttl = DEFAULT_TTL) {
  const key = `${url}`;

  // 去重：同一 URL 100ms 内返回同一 Promise
  if (pending.has(key)) return pending.get(key);

  // 缓存命中
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expire) return cached.data;

  const promise = (async () => {
    try {
      const res = await fetch(url, options);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      cache.set(key, { data, expire: Date.now() + ttl });
      // LRU eviction
      while (cache.size > CACHE_MAX_SIZE) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
      }
      return data;
    } finally {
      pending.delete(key);
    }
  })();

  pending.set(key, promise);
  return promise;
}

// ── API Functions ──

export async function fetchTools() {
  const res = await fetch(API.TOOLS);
  return res.json();
}

export async function fetchReport(params, signal) {
  const url = `${API.REPORT}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, { signal });
  return res.json();
}

export async function fetchConfig() {
  const res = await fetch(API.CONFIG);
  if (!res.ok) throw new Error('Failed to fetch config');
  return res.json();
}

export async function saveConfig(cfg) {
  const res = await fetch(API.CONFIG, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || '保存失败');
  }
  return res.json();
}

export async function fetchDetails(params) {
  const qs = new URLSearchParams(params).toString();
  return cachedFetch(`${API.DETAILS}?${qs}`);
}

export async function fetchSessions(params) {
  const qs = new URLSearchParams(params).toString();
  return cachedFetch(`${API.SESSIONS}?${qs}`);
}

export async function fetchStepStats() {
  return cachedFetch(API.STEP_STATS, {}, 10_000);
}

export async function fetchHooksStatus() {
  const res = await fetch(API.HOOKS);
  if (!res.ok) throw new Error('获取 hooks 状态失败');
  return res.json();
}

export async function updateHooks(action, tools = ['claude', 'codex', 'opencode']) {
  const res = await fetch(API.HOOKS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, tools: tools.join(',') }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '更新 hooks 失败');
  return data;
}

export async function fetchSmartReportTools() {
  const res = await fetch(API.SMART_REPORT_TOOLS);
  if (!res.ok) throw new Error('获取智能体工具失败');
  return res.json();
}

export async function fetchSmartReportRecord(params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API.SMART_REPORT}?${qs}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '获取智能报告记录失败');
  return data;
}

export async function generateSmartReport(payload) {
  const res = await fetch(API.SMART_REPORT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '智能报告生成失败');
  return data;
}

export async function fetchWorkReport(params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API.REPORT}?${qs}&format=work`);
  if (!res.ok) throw new Error('Failed to fetch work report');
  return res.text();
}
