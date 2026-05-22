import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

function createElement() {
  return {
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    querySelector() { return createElement(); },
    querySelectorAll() { return []; },
    getContext() { return {}; },
    parentElement: { style: {} },
    dataset: {},
    textContent: '',
    innerHTML: '',
    value: '',
  };
}

function loadAppComponent(fetchImpl) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const guardCode = readFileSync(join(root, 'public', 'request-guard.js'), 'utf8');
  const appCode = readFileSync(join(root, 'public', 'app.js'), 'utf8');
  let appFactory;
  const listeners = {};
  const document = {
    documentElement: { getAttribute() { return null; }, setAttribute() {}, removeAttribute() {} },
    addEventListener(type, cb) {
      listeners[type] = cb;
    },
    getElementById() {
      return createElement();
    },
    querySelector() {
      return createElement();
    },
    querySelectorAll() {
      return [];
    },
    createElement() {
      return createElement();
    },
    body: { appendChild() {}, removeChild() {} },
  };
  const context = {
    AbortController,
    Blob: class {},
    Chart: class {},
    URL,
    URLSearchParams,
    document,
    fetch: fetchImpl,
    localStorage: { getItem() { return null; }, setItem() {} },
    location: { hash: '' },
    navigator: { clipboard: { writeText() {} } },
    setTimeout() {},
    window: { addEventListener() {}, dispatchEvent() {}, open() { return { document: { write() {}, close() {} }, print() {} }; } },
    Alpine: {
      data(name, factory) {
        if (name === 'app') appFactory = factory;
      },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`${guardCode}\n${appCode}`, context);
  listeners['alpine:init']();
  return appFactory();
}

test('loadCurrentView sends abortable report requests for the current selection', async () => {
  let request;
  const app = loadAppComponent(async (url, options) => {
    request = { url, options };
    return { json: async () => ({ usageStats: { requestCount: 0, projects: {}, models: {}, scenarios: {}, tools: {}, sessionCount: 0, totalTokens: 0 }, start: '2026-05-22', end: '2026-05-22' }) };
  });

  app.activeTool = 'codex';
  app.activePeriod = 'weekly';
  app.currentDate = '2026-05-22';
  app.renderData = () => {};

  await app.loadCurrentView();

  assert.equal(request.url, '/api/report?tool=codex&period=weekly&date=2026-05-22');
  assert.equal(request.options.signal.aborted, false);
});

test('loadCurrentView aborts stale pending request before rendering cached selection', async () => {
  let firstRequest;
  const app = loadAppComponent(async (url, options) => {
    firstRequest = { url, options };
    return new Promise(() => {});
  });
  const cachedData = { cached: true };
  const rendered = [];

  app.renderData = data => rendered.push(data);
  app.activeTool = 'claude';
  app.activePeriod = 'daily';
  app.currentDate = '2026-05-22';
  app.loadCurrentView();

  app.activeTool = 'codex';
  app.cache['codex-daily-2026-05-22'] = cachedData;
  await app.loadCurrentView();

  assert.equal(firstRequest.options.signal.aborted, true);
  assert.equal(app.loading, false);
  assert.deepEqual(rendered, [cachedData]);
});
