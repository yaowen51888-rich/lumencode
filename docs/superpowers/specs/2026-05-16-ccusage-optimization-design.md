# ccusage-report 全面优化设计

> 日期: 2026-05-16
> 范围: P0 安全修复 + P1 性能优化 + P2 功能增强

## 1. 安全修复

### 1.1 路径穿越防护

**文件**: `lib/server.js`

当前静态文件处理直接拼接 URL path 到文件系统，存在路径穿越风险。

修复方案:
1. 对 `url.pathname` 做规范化处理，移除 `..` 片段
2. 使用 `path.resolve` 后验证结果路径在 `public/` 目录内
3. 不匹配时返回 403

```js
// 替换当前静态文件处理逻辑
let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
const resolved = resolve(__dirname, 'public', filePath.replace(/^\//, ''));
const publicDir = resolve(__dirname, 'public');
if (!resolved.startsWith(publicDir + sep) && resolved !== publicDir) {
  res.writeHead(403);
  res.end('Forbidden');
  return;
}
```

### 1.2 消除全局可变状态

**文件**: `lib/server.js`

当前 `effectiveIncludeProjects` 作为闭包外变量在 POST `/api/config` 中被直接修改，并发请求会互相影响。

修复方案:
- 将 `effectiveIncludeProjects` 的计算逻辑提取为函数 `computeIncludeProjects(config)`
- 每次 API 请求时从 `config` 对象重新计算
- config 更新时只修改 `config` 对象本身，不修改外部变量

### 1.3 清理死代码

**文件**: `lib/parser.js`

`decodeProjectName` 和 `groupByDate` 在 parser.js 中定义但从未被外部调用（aggregate.js 有自己的同名函数）。删除这两个函数以消除混淆。

## 2. 性能优化

### 2.1 数据缓存层

**新文件**: `lib/cache.js`

核心机制:
- 按 `(项目目录, 文件名, mtime)` 构建 cache key
- 文件 mtime 未变化时跳过重新解析
- 内存中保存完整的 records 数组 + 按日期索引
- 切换日期范围时仅做内存过滤，不触发 IO

数据流:
```
首次请求: stat files → parse changed → cache all → filter → stats
后续请求: stat files → diff mtime → (skip unchanged) → filter → stats
切换日期: memory filter → stats (零 IO)
```

缓存结构:
```js
{
  fileCache: Map<filePath, { mtime, records }>,
  allRecords: [],       // 全部解析后的记录
  indexedAt: Date,      // 上次全量索引时间
}
```

暴露 API:
- `getCachedRecords(claudeDir, excludeProjects, includeProjects)` — 返回缓存的 records
- `invalidateCache()` — 手动清除缓存（config 变更时调用）
- `getCachedGitStats(repos, since, until)` — 缓存 Git 统计结果

### 2.2 异步 Git 统计

**文件**: `lib/git.js`

改造:
1. `execSync` → `execFile` (基于 `child_process` 的异步版本)
2. 合并 git 命令调用：将 commit log + shortstat 合并为一次 git log 调用
3. 多仓库并行执行：`Promise.all(repos.map(...))`
4. `server.js` 中的路由处理改为 async

Git 命令从 6 次/仓库 减少到 2 次/仓库：
- 命令 1: `git log --format="%ad" --date=short --shortstat` (commit 日期 + 行数统计)
- 命令 2: 仅在需要 daily breakdown 时执行

### 2.3 server.js 异步化

将 HTTP handler 从同步回调改为支持 async:
```js
const server = createServer(async (req, res) => {
  // ... async handlers
});
```

## 3. 功能增强

### 3.1 趋势图

**文件**: `public/app.js`, `public/index.html`

利用后端已有的 `dailyStats` 数据，新增趋势折线图:

- 在统计卡片和饼图之间插入一个全宽的折线图区域
- 双 Y 轴: 左侧请求数，右侧 Token 消耗
- 时间范围:
  - 日报: 近 7 天
  - 周报: 近 4 周
  - 月报: 近 6 个月
- Chart.js line chart，填充面积区域，简洁配色

API 需新增字段:
```json
{
  "usageStats": {
    "dailyStats": { "2026-05-10": { ... }, ... },
    "trendRange": { "start": "2026-05-09", "end": "2026-05-16" }
  }
}
```

当前 `dailyStats` 已在 `computeUsageStats` 中计算，只需确保它在 API 响应中返回。前端新增 `renderTrend()` 函数。

### 3.2 成本估算

**文件**: `lib/aggregate.js`, `public/app.js`, `public/index.html`

在统计卡片区域新增「预估费用」卡片。

定价数据（按 MTok，美元）:
```js
const MODEL_PRICING = {
  'claude-sonnet-4-6':  { input: 3,    output: 15,   cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-opus-4-6':    { input: 15,   output: 75,   cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-haiku-4-5':   { input: 0.80, output: 4,    cacheRead: 0.08, cacheWrite: 1.00 },
};
```

实现:
1. `aggregate.js` 中 `computeUsageStats` 新增 `estimatedCost` 字段
2. 按模型分类累加: `inputTokens/1M * inputPrice + outputTokens/1M * outputPrice + cacheRead/1M * cacheReadPrice`
3. 未匹配模型使用 sonnet 定价作为默认
4. 前端新增费用卡片，显示 `~$X.XX` 并标注"预估值"
5. 支持可配置的汇率（人民币/美元）

### 3.3 依赖本地化

**操作**:
1. 下载 Chart.js 4.4.1 UMD 到 `public/vendor/chart.umd.min.js`
2. 下载 Inter 字体 (400, 500, 600, 700 weight) 的 woff2 文件到 `public/fonts/`
3. `index.html` 中:
   - 删除 Google Fonts `<link>` 标签
   - `<script src>` 改为引用 `vendor/chart.umd.min.js`
4. `style.css` 中添加 `@font-face` 声明

### 3.4 加载与错误状态

**文件**: `public/app.js`, `public/index.html`, `public/style.css`

加载状态:
- 统计卡片区域在数据加载时显示脉冲动画（CSS skeleton）
- 图表区域显示 "加载中..." 占位文字

错误状态:
- 页面顶部 toast 组件，API 失败时显示错误消息
- 3 秒后自动消失

空状态:
- 无记录时显示居中的空状态提示："暂无数据，请检查配置"
- 附带"打开设置"按钮

## 4. 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `lib/server.js` | 修改 | 安全修复 + 异步化 + 缓存集成 |
| `lib/git.js` | 修改 | 异步化 + 命令合并 |
| `lib/aggregate.js` | 修改 | 新增成本估算字段 |
| `lib/parser.js` | 修改 | 删除死代码 |
| `lib/cache.js` | 新增 | 缓存层 |
| `public/app.js` | 修改 | 趋势图 + 费用卡片 + 加载/错误状态 |
| `public/index.html` | 修改 | 趋势图区域 + 费用卡片 + skeleton + toast |
| `public/style.css` | 修改 | skeleton 动画 + toast 样式 + 趋势图样式 |
| `public/vendor/` | 新增 | Chart.js 本地文件 |
| `public/fonts/` | 新增 | Inter 字体文件 |

## 5. 不做的事 (YAGNI)

- 不引入构建工具/打包器（保持零依赖理念）
- 不引入 TypeScript
- 不做国际化（当前仅中文场景）
- 不做数据库持久化（文件缓存足够）
- 不做 PWA/离线 manifest
- 不做测试框架引入（作为独立后续任务）
