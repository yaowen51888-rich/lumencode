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

export async function fetchWorkReport(params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API.REPORT}?${qs}&format=work`);
  if (!res.ok) throw new Error('Failed to fetch work report');
  return res.text();
}
