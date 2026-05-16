# ccusage-report 全面优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复安全漏洞、提升性能、增强功能（趋势图 + 成本估算 + 依赖本地化 + UX 状态）

**Architecture:** 在现有零依赖 Node.js 架构上叠加文件级缓存层和异步 Git，保持 CLI 同步路径不变，仅 server 路径异步化。前端新增趋势折线图和费用卡片，本地化所有 CDN 依赖。

**Tech Stack:** Node.js 18+ (ESM, top-level await), Chart.js 4.4.1 (本地化), Inter font (本地化)

---

## Task 1: 清理 parser.js 死代码

**Files:**
- Modify: `lib/parser.js:64-80`

删除 `decodeProjectName`（与 aggregate.js 中的同名函数逻辑冲突）和 `groupByDate`（未被任何外部代码调用）。

- [ ] **Step 1: 删除死代码**

将 `lib/parser.js` 中 `normalizeRecord` 函数后面的所有内容（第 64-80 行）删除：

```js
// 删除以下全部代码 (lines 64-80):
// function decodeProjectName(dirName) { ... }
// export function groupByDate(records) { ... }
```

删除后，`parser.js` 文件末尾是 `normalizeRecord` 的右花括号。

- [ ] **Step 2: 验证 CLI 正常**

Run: `node D:/ccusage-report/index.js help`
Expected: 正常输出帮助信息，无报错

- [ ] **Step 3: Commit**

```bash
git add lib/parser.js
git commit -m "refactor: remove dead code from parser.js"
```

---

## Task 2: 修复 server.js 安全问题

**Files:**
- Modify: `lib/server.js:1-4` (imports)
- Modify: `lib/server.js:86-93` (POST config handler)
- Modify: `lib/server.js:112-126` (static file serving)

### 2.1 路径穿越防护

- [ ] **Step 1: 添加 resolve 和 sep 到 imports**

修改 `lib/server.js` 第 3 行：

```js
// Before:
import { join, extname } from 'path';

// After:
import { join, extname, resolve, sep } from 'path';
```

- [ ] **Step 2: 替换静态文件处理逻辑**

替换 `lib/server.js` 中 `// Static files` 注释后面的所有代码（当前第 112-126 行）：

```js
// Static files
let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
const resolved = resolve(__dirname, 'public', filePath.replace(/^\//, ''));
const publicDir = resolve(__dirname, 'public');

if (!resolved.startsWith(publicDir + sep) && resolved !== publicDir) {
  res.writeHead(403);
  res.end('Forbidden');
  return;
}

if (!existsSync(resolved)) {
  res.writeHead(404);
  res.end('Not Found');
  return;
}

const content = readFileSync(resolved);
const type = MIME[extname(resolved)] || 'application/octet-stream';
res.writeHead(200, { 'Content-Type': type });
res.end(content);
```

### 2.2 消除全局可变状态

- [ ] **Step 3: 添加 computeIncludeProjects 辅助函数**

在 `startServer` 函数内部（`const PORT = ...` 之前）添加：

```js
function computeIncludeProjects(cfg) {
  if (cfg.repos && cfg.repos.length > 0) {
    return cfg.repos.map(r => normalizeProjectPath(r));
  }
  return null;
}
```

- [ ] **Step 4: 替换 API handler 中的 effectiveIncludeProjects 引用**

在 `/api/report` handler 中，将 `buildReportData(period, date, config, effectiveIncludeProjects)` 改为：

```js
const data = await buildReportData(period, date, config, computeIncludeProjects(config));
```

注意：此时 server 还不是 async，这里先加 `await` 不影响——下一步 Task 5 会做 async 化。如果当前不想提前加 await，可以先去掉 await，在 Task 5 统一处理。

- [ ] **Step 5: 修改 POST /api/config handler**

替换当前第 86-93 行（修改 effectiveIncludeProjects 的部分）：

```js
// Before:
if (newConfig.repos !== undefined) {
  config.repos = newConfig.repos;
  if (config.repos && config.repos.length > 0) {
    effectiveIncludeProjects = config.repos.map(r => normalizeProjectPath(r));
  } else {
    effectiveIncludeProjects = null;
  }
}

// After:
if (newConfig.repos !== undefined) {
  config.repos = newConfig.repos;
}
```

只修改 `config` 对象，不再修改外部闭包变量。下一次请求会通过 `computeIncludeProjects(config)` 获取最新值。

- [ ] **Step 6: 验证**

Run: `node D:/ccusage-report/index.js serve`
Expected: 浏览器正常打开，日报数据正常加载

```bash
# 验证路径穿越防护
curl http://localhost:4567/../../config.json
# Expected: 403 Forbidden (而不是返回文件内容)
```

- [ ] **Step 7: Commit**

```bash
git add lib/server.js
git commit -m "fix: path traversal vulnerability and eliminate mutable global state"
```

---

## Task 3: 创建文件缓存层

**Files:**
- Create: `lib/cache.js`
- Modify: `lib/aggregate.js:3,52-54`

- [ ] **Step 1: 创建 `lib/cache.js`**

```js
import { statSync } from 'fs';
import { parseJsonlFile } from './parser.js';

const fileCache = new Map();

export function getCachedFileRecords(filePath) {
  const { mtimeMs } = statSync(filePath);
  const cached = fileCache.get(filePath);
  if (cached && cached.mtime === mtimeMs) return cached.records;

  const records = parseJsonlFile(filePath);
  fileCache.set(filePath, { mtime: mtimeMs, records });
  return records;
}

export function invalidateFileCache() {
  fileCache.clear();
}
```

- [ ] **Step 2: 在 aggregate.js 中引入缓存**

修改 `lib/aggregate.js` 第 3 行，添加 import：

```js
// Before:
import { parseJsonlFile } from './parser.js';

// After:
import { parseJsonlFile } from './parser.js';
import { getCachedFileRecords } from './cache.js';
```

- [ ] **Step 3: 替换 parseJsonlFile 调用**

修改 `lib/aggregate.js` 中 `collectAllRecords` 函数内部的文件读取（当前第 52-54 行）：

```js
// Before:
const records = parseJsonlFile(filePath);

// After:
const records = getCachedFileRecords(filePath);
```

- [ ] **Step 4: 验证**

Run: `node D:/ccusage-report/index.js report daily`
Expected: 正常输出日报（功能不变，性能提升需多次请求才能感知）

- [ ] **Step 5: Commit**

```bash
git add lib/cache.js lib/aggregate.js
git commit -m "perf: add file-level cache for JSONL parsing"
```

---

## Task 4: 异步 Git 统计 + 命令合并 + 缓存

**Files:**
- Modify: `lib/git.js` (full rewrite)

将 3 次 git log 调用合并为 1 次，添加异步版本，添加 60s TTL 缓存。

- [ ] **Step 1: 重写 `lib/git.js`**

```js
import { execSync, exec as execCb } from 'child_process';

// ── helpers ──

function execAsync(command, options) {
  return new Promise((resolve, reject) => {
    execCb(command, options, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function getGitAuthor(repoPath) {
  try {
    return execSync('git config user.email', { cwd: repoPath, encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    try {
      return execSync('git config user.name', { cwd: repoPath, encoding: 'utf-8', stdio: 'pipe' }).trim();
    } catch {
      return null;
    }
  }
}

function emptyResult() {
  return { commits: 0, filesChanged: 0, linesAdded: 0, linesDeleted: 0, commitsByDate: {}, linesByDate: {} };
}

function parseGitLogOutput(output) {
  const result = emptyResult();
  let currentDate = '';

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      currentDate = trimmed;
      result.commits++;
      result.commitsByDate[currentDate] = (result.commitsByDate[currentDate] || 0) + 1;
      if (!result.linesByDate[currentDate]) {
        result.linesByDate[currentDate] = { added: 0, deleted: 0, files: 0 };
      }
    } else if (trimmed.includes('changed')) {
      const ins = trimmed.match(/(\d+) insertion/);
      const del = trimmed.match(/(\d+) deletion/);
      const fil = trimmed.match(/(\d+) files? changed/);
      if (ins) {
        const n = parseInt(ins[1]);
        result.linesAdded += n;
        if (currentDate) result.linesByDate[currentDate].added += n;
      }
      if (del) {
        const n = parseInt(del[1]);
        result.linesDeleted += n;
        if (currentDate) result.linesByDate[currentDate].deleted += n;
      }
      if (fil) {
        const n = parseInt(fil[1]);
        result.filesChanged += n;
        if (currentDate) result.linesByDate[currentDate].files += n;
      }
    }
  }

  return result;
}

function buildGitArgs(since, until, author) {
  const sinceFull = since.includes('T') ? since : since + 'T00:00:00';
  const authorArg = author ? ` --author="${author}"` : '';
  return `--all --format="%ad" --date=short --shortstat --since="${sinceFull}" --until="${until}"${authorArg}`;
}

function mergeGitStats(target, source) {
  target.commits += source.commits;
  target.filesChanged += source.filesChanged;
  target.linesAdded += source.linesAdded;
  target.linesDeleted += source.linesDeleted;
  for (const [d, c] of Object.entries(source.commitsByDate)) {
    target.commitsByDate[d] = (target.commitsByDate[d] || 0) + c;
  }
  if (source.linesByDate) {
    for (const [d, v] of Object.entries(source.linesByDate)) {
      if (!target.linesByDate[d]) target.linesByDate[d] = { added: 0, deleted: 0, files: 0 };
      target.linesByDate[d].added += v.added;
      target.linesByDate[d].deleted += v.deleted;
      target.linesByDate[d].files += v.files;
    }
  }
}

// ── sync versions (CLI) ──

export function getGitStats(repoPath, since, until, author = null) {
  try {
    execSync('git rev-parse --git-dir', { cwd: repoPath, stdio: 'pipe' });
  } catch {
    return emptyResult();
  }

  try {
    const output = execSync(`git log ${buildGitArgs(since, until, author)}`, {
      cwd: repoPath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024,
    }).trim();
    return parseGitLogOutput(output);
  } catch {
    return emptyResult();
  }
}

export function getGitStatsForMultipleRepos(repos, since, until) {
  const merged = emptyResult();
  for (const repo of repos) {
    const stats = getGitStats(repo, since, until, getGitAuthor(repo));
    mergeGitStats(merged, stats);
  }
  return merged;
}

// ── async versions (server) with cache ──

const gitCache = new Map();

async function getGitStatsAsync(repoPath, since, until, author = null) {
  const cacheKey = `${repoPath}|${since}|${until}`;
  const cached = gitCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 60_000) return cached.stats;

  try {
    await execAsync('git rev-parse --git-dir', { cwd: repoPath });
  } catch {
    return emptyResult();
  }

  try {
    const output = await execAsync(`git log ${buildGitArgs(since, until, author)}`, {
      cwd: repoPath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024,
    });
    const stats = parseGitLogOutput(output.trim());
    gitCache.set(cacheKey, { stats, ts: Date.now() });
    return stats;
  } catch {
    return emptyResult();
  }
}

export async function getGitStatsForMultipleReposAsync(repos, since, until) {
  const results = await Promise.all(
    repos.map(repo => getGitStatsAsync(repo, since, until, getGitAuthor(repo)))
  );
  const merged = emptyResult();
  for (const stats of results) mergeGitStats(merged, stats);
  return merged;
}

export function invalidateGitCache() {
  gitCache.clear();
}
```

- [ ] **Step 2: 验证 CLI 正常**

Run: `node D:/ccusage-report/index.js report weekly`
Expected: 正常输出周报，Git 统计区域正常显示（数值可能与之前一致）

- [ ] **Step 3: Commit**

```bash
git add lib/git.js
git commit -m "perf: merge git commands and add async versions with cache"
```

---

## Task 5: Server 异步化 + 缓存集成

**Files:**
- Modify: `lib/server.js` (async handler + import async git + cache invalidation)
- Modify: `index.js` (async buildReportData + top-level await)

### 5.1 修改 index.js

- [ ] **Step 1: 修改 buildReportData 使用异步 Git**

在 `index.js` 中，添加 import 并修改 `buildReportData`：

```js
// 在文件顶部 imports 添加:
import { getGitStatsForMultipleReposAsync } from './git.js';
import { invalidateFileCache } from './cache.js';
import { invalidateGitCache } from './git.js';

// 替换 buildReportData 函数:
async function buildReportData(period, dateArg, config, effectiveIncludeProjects) {
  const { records } = collectAllRecords(config.claudeDir, config.excludeProjects, effectiveIncludeProjects);
  if (records.length === 0) return null;

  const { filtered, start, end } = filterRecordsByPeriod(records, period, dateArg);
  const usageStats = computeUsageStats(filtered, config.scenarioKeywords);

  let gitStats = null;
  if (config.repos && config.repos.length > 0) {
    gitStats = await getGitStatsForMultipleReposAsync(config.repos, start, end + 'T23:59:59');
  }

  return { usageStats, gitStats, start, end };
}
```

- [ ] **Step 2: 删除不再需要的 import**

从 `index.js` 第 4 行移除 `getGitStatsForMultipleRepos`（保留 CLI 路径需要的其他 imports）。检查 CLI 路径是否还用同步版本——如果 CLI 也改用异步，则完全删除 `getGitStatsForMultipleRepos` import。

实际上 CLI 路径也用到了 `getGitStatsForMultipleRepos`。改为 top-level await：

```js
// 替换 CLI report 分支中的 git 调用 (当前第 121 行附近):
// Before:
gitStats = getGitStatsForMultipleRepos(config.repos, start, end + 'T23:59:59');

// After:
gitStats = await getGitStatsForMultipleReposAsync(config.repos, start, end + 'T23:59:59');
```

然后从 imports 中移除 `getGitStatsForMultipleRepos`，只保留 `getGitStatsForMultipleReposAsync`。

### 5.2 修改 server.js

- [ ] **Step 3: 导入缓存失效函数**

在 `lib/server.js` 顶部 imports 添加：

```js
import { invalidateFileCache } from './cache.js';
import { invalidateGitCache } from './git.js';
```

- [ ] **Step 4: 将 HTTP handler 改为 async**

替换 `server.js` 中 `createServer` 的回调：

```js
// Before:
const server = createServer((req, res) => {

// After:
const server = createServer(async (req, res) => {
```

并在 `/api/report` handler 中，将 `buildReportData` 调用加上 `await`：

```js
const data = await buildReportData(period, date, config, computeIncludeProjects(config));
```

- [ ] **Step 5: 在 POST /api/config 中添加缓存失效**

在 POST handler 的 `saveConfig` 调用之前添加：

```js
invalidateFileCache();
invalidateGitCache();
saveConfig(config, configPath);
```

- [ ] **Step 6: 验证**

Run: `node D:/ccusage-report/index.js serve`
Expected: 浏览器正常打开，切换日/周/月正常

Run: `node D:/ccusage-report/index.js report daily`
Expected: 正常输出日报

- [ ] **Step 7: Commit**

```bash
git add lib/server.js index.js
git commit -m "perf: async server with git cache integration"
```

---

## Task 6: 后端增强 — 成本估算 + 趋势数据

**Files:**
- Modify: `lib/aggregate.js`

### 6.1 扩展模型统计字段

- [ ] **Step 1: 扩展 models 数据结构**

修改 `lib/aggregate.js` 中 `computeUsageStats` 的模型统计部分（当前第 122-126 行）：

```js
// Before:
if (r.model) {
  if (!stats.models[r.model]) stats.models[r.model] = { count: 0, outputTokens: 0 };
  stats.models[r.model].count++;
  stats.models[r.model].outputTokens += r.tokens.output;
}

// After:
if (r.model) {
  if (!stats.models[r.model]) stats.models[r.model] = { count: 0, outputTokens: 0, inputTokens: 0, cacheRead: 0 };
  stats.models[r.model].count++;
  stats.models[r.model].outputTokens += r.tokens.output;
  stats.models[r.model].inputTokens += r.tokens.input;
  stats.models[r.model].cacheRead += r.tokens.cacheRead;
}
```

### 6.2 添加成本估算

- [ ] **Step 2: 在 computeUsageStats 末尾添加成本计算**

在 `computeUsageStats` 函数的 return 语句之前（`// Convert project session Sets` 之前）添加：

```js
// Cost estimation
const MODEL_PRICING = {
  'claude-sonnet-4-6':        { input: 3,    output: 15,   cacheRead: 0.30 },
  'claude-opus-4-6':          { input: 15,   output: 75,   cacheRead: 1.50 },
  'claude-haiku-4-5':         { input: 0.80, output: 4,    cacheRead: 0.08 },
  'claude-haiku-4-5-20251001':{ input: 0.80, output: 4,    cacheRead: 0.08 },
};
const DEFAULT_PRICING = MODEL_PRICING['claude-sonnet-4-6'];

let estimatedCost = 0;
for (const [model, data] of Object.entries(stats.models)) {
  const pricing = MODEL_PRICING[model] || DEFAULT_PRICING;
  estimatedCost += (data.inputTokens / 1_000_000) * pricing.input;
  estimatedCost += (data.outputTokens / 1_000_000) * pricing.output;
  estimatedCost += (data.cacheRead / 1_000_000) * pricing.cacheRead;
}
stats.estimatedCost = Math.round(estimatedCost * 100) / 100;
```

### 6.3 添加趋势数据函数

- [ ] **Step 3: 添加 computeTrendData 导出函数**

在 `lib/aggregate.js` 末尾（`filterRecordsByPeriod` 函数之后）添加：

```js
export function computeTrendData(allRecords, period, refDate) {
  const d = new Date(refDate);
  let trendDays;
  switch (period) {
    case 'daily': trendDays = 7; break;
    case 'weekly': trendDays = 28; break;
    case 'monthly': trendDays = 180; break;
    default: trendDays = 7;
  }

  const trendEndDate = new Date(d);
  const trendStartDate = new Date(d);
  trendStartDate.setDate(trendStartDate.getDate() - trendDays + 1);

  const trendStart = formatDate(trendStartDate);
  const trendEnd = formatDate(trendEndDate);

  const dailyStats = {};
  for (const r of allRecords) {
    if (!r.timestamp) continue;
    const date = r.timestamp.slice(0, 10);
    if (date < trendStart || date > trendEnd) continue;
    if (!dailyStats[date]) dailyStats[date] = { requests: 0, inputTokens: 0, outputTokens: 0 };
    if (r.type === 'assistant') {
      dailyStats[date].requests++;
      dailyStats[date].inputTokens += r.tokens.input;
      dailyStats[date].outputTokens += r.tokens.output;
    }
  }

  return { dailyStats, start: trendStart, end: trendEnd };
}
```

- [ ] **Step 4: 在 buildReportData 中集成趋势数据**

修改 `index.js` 中的 `buildReportData` 函数，添加 trendData：

```js
import { ..., computeTrendData } from './aggregate.js';

// 在 buildReportData 的 return 之前添加:
const trendData = computeTrendData(records, period, dateArg);

// 修改 return:
return { usageStats, gitStats, start, end, trendData };
```

- [ ] **Step 5: 验证**

Run: `node D:/ccusage-report/index.js report daily`
Expected: 正常输出，格式不变（CLI 不显示 cost 和 trend）

Run: `node D:/ccusage-report/index.js serve`
用浏览器开发者工具查看 `/api/report?period=daily` 响应：
Expected: JSON 中包含 `usageStats.estimatedCost` 和 `trendData` 字段

- [ ] **Step 6: Commit**

```bash
git add lib/aggregate.js index.js
git commit -m "feat: add cost estimation and trend data computation"
```

---

## Task 7: 本地化依赖

**Files:**
- Create: `public/vendor/chart.umd.min.js`
- Create: `public/fonts/inter-*.woff2`
- Create: `public/fonts/inter.css`
- Create: `scripts/localize-deps.mjs`
- Modify: `public/index.html:9-10`
- Modify: `public/style.css:27`

- [ ] **Step 1: 创建本地化脚本**

创建 `scripts/localize-deps.mjs`：

```js
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..');

// 1. Chart.js
console.log('Downloading Chart.js...');
const chartJs = await fetch('https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js').then(r => r.text());
mkdirSync(join(ROOT, 'public', 'vendor'), { recursive: true });
writeFileSync(join(ROOT, 'public', 'vendor', 'chart.umd.min.js'), chartJs);
console.log(`  chart.umd.min.js (${(chartJs.length / 1024).toFixed(0)} KB)`);

// 2. Inter font
console.log('Downloading Inter font...');
const fontCss = await fetch('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap', {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' },
}).then(r => r.text());

const fontUrls = [...fontCss.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map(m => m[1]);
mkdirSync(join(ROOT, 'public', 'fonts'), { recursive: true });

let localCss = fontCss;
for (let i = 0; i < fontUrls.length; i++) {
  const fontData = await fetch(fontUrls[i]).then(r => r.arrayBuffer());
  const fileName = `inter-${i}.woff2`;
  writeFileSync(join(ROOT, 'public', 'fonts', fileName), Buffer.from(fontData));
  localCss = localCss.replace(fontUrls[i], `./${fileName}`);
  console.log(`  ${fileName}`);
}

writeFileSync(join(ROOT, 'public', 'fonts', 'inter.css'), localCss);
console.log('Done!');
```

- [ ] **Step 2: 运行脚本**

Run: `node D:/ccusage-report/scripts/localize-deps.mjs`
Expected: 下载 Chart.js 和 Inter 字体文件到 public/vendor 和 public/fonts

- [ ] **Step 3: 修改 index.html 引用**

替换 `public/index.html` 第 9-10 行：

```html
<!-- Before: -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>

<!-- After: -->
<link rel="stylesheet" href="/fonts/inter.css">
<script src="/vendor/chart.umd.min.js"></script>
```

- [ ] **Step 4: 验证**

Run: `node D:/ccusage-report/index.js serve`
Expected: 浏览器正常显示，开发者工具 Network 面板中字体和 Chart.js 从本地加载

- [ ] **Step 5: Commit**

```bash
git add scripts/localize-deps.mjs public/vendor/ public/fonts/ public/index.html
git commit -m "feat: localize Chart.js and Inter font dependencies"
```

---

## Task 8: 前端增强 — 趋势图 + 费用卡片 + UX 状态

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`

### 8.1 添加趋势图区域 + 费用卡片 + Toast + Skeleton

- [ ] **Step 1: 修改 index.html**

在 `<!-- Stats Grid -->` section 中，添加第 5 个费用卡片。将 `stats-grid` div 内的 4 个 `feature-card` 后面添加：

```html
<div class="feature-card">
  <div class="card-label">预估费用</div>
  <div class="card-value" id="statCost">-</div>
</div>
```

在 `stats-grid` section 和 `charts-section` 之间插入趋势图区域：

```html
<section class="trend-section" id="trendSection" style="display:none;">
  <div class="chart-card">
    <h3 class="title-md">使用趋势</h3>
    <div class="chart-wrap chart-wrap-wide"><canvas id="trendChart"></canvas></div>
  </div>
</section>
```

在 `<body>` 开头添加 toast 容器：

```html
<div id="toast" class="toast" style="display:none;"></div>
```

- [ ] **Step 2: 修改 style.css**

将 `stats-grid` 改为自适应列数：

```css
/* Before: */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 48px;
}

/* After: */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 16px;
  margin-bottom: 48px;
}
```

在 `style.css` 末尾（`@media` 之前）添加：

```css
/* Trend chart */
.trend-section { margin-bottom: 48px; }

.chart-wrap-wide {
  height: 320px;
}

/* Toast */
.toast {
  position: fixed;
  top: 80px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--surface-dark);
  color: var(--on-dark);
  padding: 12px 24px;
  border-radius: 8px;
  font-size: 14px;
  z-index: 300;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  transition: opacity 0.3s;
}

/* Skeleton loading */
.skeleton {
  animation: skeleton-pulse 1.5s ease-in-out infinite;
  background: linear-gradient(90deg, var(--surface-card) 25%, var(--surface-soft) 50%, var(--surface-card) 75%);
  background-size: 200% 100%;
  border-radius: 6px;
}

@keyframes skeleton-pulse {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.card-value.skeleton {
  height: 36px;
  width: 80px;
}

/* Empty state */
.empty-state {
  text-align: center;
  padding: 80px 24px;
}

.empty-state p {
  font-size: 16px;
  color: var(--muted);
  margin-bottom: 24px;
}
```

### 8.2 修改 app.js

- [ ] **Step 3: 替换 app.js 中的 render 和 loadData**

替换 `public/app.js` 中的 `loadData` 函数：

```js
async function loadData() {
  showSkeleton();
  hideError();

  try {
    const res = await fetch(`/api/report?period=${currentPeriod}&date=${currentDate}`);
    if (!res.ok) {
      showError('数据加载失败: ' + res.status);
      hideSkeleton();
      return;
    }
    const data = await res.json();
    if (!data) {
      showEmpty();
      hideSkeleton();
      return;
    }
    hideEmpty();
    render(data);
  } catch (err) {
    showError('网络错误: ' + err.message);
  } finally {
    hideSkeleton();
  }
}
```

在 `render` 函数中添加费用卡片和趋势图的渲染（在现有 `// Stats cards` 部分之后）：

```js
// Cost card
const costEl = document.getElementById('statCost');
if (costEl) {
  costEl.textContent = usageStats.estimatedCost
    ? `~$${usageStats.estimatedCost.toFixed(2)}`
    : '-';
}

// Trend chart
const trendSection = document.getElementById('trendSection');
if (data.trendData && Object.keys(data.trendData.dailyStats).length > 0) {
  trendSection.style.display = 'block';
  renderTrend(data.trendData);
} else {
  trendSection.style.display = 'none';
}
```

在 `app.js` 末尾添加新函数：

```js
// ── Trend chart ──

function renderTrend(trendData) {
  const dates = Object.keys(trendData.dailyStats).sort();
  const requests = dates.map(d => trendData.dailyStats[d].requests);
  const tokens = dates.map(d => ((trendData.dailyStats[d].inputTokens || 0) + (trendData.dailyStats[d].outputTokens || 0)) / 1000);
  const labels = dates.map(d => d.slice(5));

  destroyChart('trendChart');
  const ctx = document.getElementById('trendChart');
  if (!ctx) return;
  charts['trendChart'] = new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '请求数',
          data: requests,
          borderColor: '#111111',
          backgroundColor: 'rgba(17,17,17,0.08)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          yAxisID: 'y',
        },
        {
          label: 'Token (K)',
          data: tokens,
          borderColor: '#8b5cf6',
          backgroundColor: 'rgba(139,92,246,0.08)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          yAxisID: 'y1',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { position: 'left', grid: { color: '#f3f4f6' }, ticks: { font: { family: 'Inter', size: 11 } }, title: { display: true, text: '请求数', font: { family: 'Inter', size: 12 } } },
        y1: { position: 'right', grid: { display: false }, ticks: { font: { family: 'Inter', size: 11 } }, title: { display: true, text: 'Token (K)', font: { family: 'Inter', size: 12 } } },
        x: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 11 } } },
      },
      plugins: {
        legend: { position: 'top', labels: { font: { family: 'Inter', size: 12 }, padding: 16 } },
      },
    },
  });
}

// ── UX states ──

function showSkeleton() {
  document.querySelectorAll('.card-value').forEach(el => {
    if (!el.classList.contains('skeleton')) {
      el._origText = el.textContent;
      el.textContent = '';
      el.classList.add('skeleton');
    }
  });
}

function hideSkeleton() {
  document.querySelectorAll('.card-value.skeleton').forEach(el => {
    el.classList.remove('skeleton');
  });
}

function showError(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.style.display = 'block';
  toast.style.opacity = '1';
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => { toast.style.display = 'none'; }, 300);
  }, 3000);
}

function hideError() {
  const toast = document.getElementById('toast');
  if (toast) toast.style.display = 'none';
}

function showEmpty() {
  const grid = document.getElementById('statsGrid');
  if (grid) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><p>暂无数据，请检查配置</p><button class="btn-primary" onclick="document.getElementById(\'settingsBtn\').click()">打开设置</button></div>';
  }
}

function hideEmpty() {
  // loadData 后 render 会重建内容，无需额外处理
}
```

- [ ] **Step 4: 验证全流程**

Run: `node D:/ccusage-report/index.js serve`
Expected:
1. 浏览器打开后显示 skeleton 加载动画
2. 数据加载后显示 5 个统计卡片（含预估费用）
3. 趋势折线图正常显示
4. 切换日/周/月，趋势图时间范围变化
5. 设置 → 修改配置 → 保存 → 数据刷新
6. 断开网络或关闭服务 → 显示 toast 错误提示

Run: `node D:/ccusage-report/index.js report daily --work`
Expected: 正常输出 Markdown 工作汇报

- [ ] **Step 5: Commit**

```bash
git add public/app.js public/index.html public/style.css
git commit -m "feat: add trend chart, cost estimation card, loading/error states"
```

---

## Task 9: 最终集成验证

- [ ] **Step 1: CLI 全路径验证**

```bash
node D:/ccusage-report/index.js help
node D:/ccusage-report/index.js report daily
node D:/ccusage-report/index.js report daily 2026-05-15
node D:/ccusage-report/index.js report weekly
node D:/ccusage-report/index.js report monthly
node D:/ccusage-report/index.js report daily --work
node D:/ccusage-report/index.js report weekly --work
```

Expected: 全部正常输出，无报错

- [ ] **Step 2: Web 全路径验证**

```bash
node D:/ccusage-report/index.js serve
```

手动验证：
1. 首页加载 → skeleton → 数据渲染
2. 切换日报/周报/月报 → 趋势图更新
3. 修改日期 → 数据刷新
4. 打开设置 → 修改配置 → 保存 → 缓存失效 → 新数据
5. 工作汇报按钮 → 生成 Markdown → 复制功能
6. 验证 Network 面板：无外部 CDN 请求

- [ ] **Step 3: 安全回归验证**

```bash
curl http://localhost:4567/../../config.json
# Expected: 403 Forbidden
```
