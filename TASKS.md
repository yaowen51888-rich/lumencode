# LumenCode 待办任务清单

> 来源：2026-07-08 核心能力审计（归因/解析/定价/报告/工程健康 + 竞品调研）。
> 优先级：**P0** 可信度地基 → **P1** 核心体验 → **P2** 工程长期健康 → **P3** 战略方向。
> 产品的全部价值建立在「数字准」上，因此按「对数据可信度的伤害程度」排序。

## 已完成

| # | 任务 | 完成情况 |
|---|------|---------|
| 1 | 添加 GitHub Actions CI | `.github/workflows/ci.yml`：push/PR 到 master/dev 时在 Ubuntu + Windows × Node 18/20/22 六个矩阵组合运行 `npm ci && npm test` |
| 2 | 修正 README 无依据话术 | 中英 README 的「节省约 8 小时 / saved ~8 hours」改为可兑现口径（「3,180 行代码归因到 AI」），与 `smart-report.js` 禁止编造节省工时的守卫规则对齐 |
| 3 | 修复定价 fuzzy 版本错配 | `pricing-loader.js` 改为版本感知打分（数字串 LCS + 变体词边界隔离）；fuzzy 结果带 `fuzzy/fuzzyKey` 标记并有 `getFuzzyPricingMatches()` 登记表；报告「费用构成」板块行内标注「估算价」附转精确计费指引；新增 6 个测试 |

---

## P0 — 可信度地基

### #4 重构 steps.db 持久化（原子写 + 并发安全）

#### 现状架构

行级归因的每一次 hook 触发（Claude Code `PostToolBatch` / Codex `PostToolUse` / OpenCode 插件）都是一个**独立短命进程**，生命周期为：

```
hook 进程启动
  → StepDatabase.open()        读整个 steps.db 文件进内存（lib/step-schema.js:59-61）
  → insertStep / upsertStepFile 在内存中写 steps / step_files / sessions 三张表
  → save()                     db.export() 全库序列化 → writeFileSync 整文件覆写（step-schema.js:84-90）
  → close()                    再 export + 覆写一次（step-schema.js:74-82）
进程退出
```

其中 `step_files.content_blob` 存**完整文件快照**（归因投影需要），`blame_map` 存逐行归属 JSON。三个 `PRAGMA journal_mode = WAL`（step-schema.js:66）在 sql.js 下**是空操作**——sql.js 是内存数据库，根本没有文件级 journal，这行代码给人「已有 WAL 保护」的错觉。

调用点：`lib/step-tracker.js:96-97/217/405`（hook 写入与归因读取）、`lib/capture-recorder.js:81/137`、`lib/server.js:1264`（Web 端读取）。

#### 四个失败模式（按概率排序）

| 失败模式 | 触发条件 | 后果 | 概率 |
|---------|---------|------|------|
| **并发丢写** | 两个 hook 进程时间窗重叠：A 读库 → B 读库 → A 写 → B 写（B 的基线不含 A 的写入） | A 本次记录的步骤被整体抹掉，无任何报错。Claude Code 并行 subagent、或 Claude+Codex 同项目混用时窗口很大 | **高**，日常即可触发 |
| **写坏库** | `writeFileSync` 覆写数兆文件中途进程被 kill / 断电 / 磁盘满 | steps.db 半截文件，下次 `new Sql.Database(buf)` 抛错；open 无恢复逻辑,行级归因整体失效且历史数据全丢 | 中 |
| **写放大劣化** | content_blob 累积（每步每文件一份全量快照），库到几十 MB 后每步 hook 都要「读几十 MB + 序列化几十 MB + 写几十 MB」 | hook 延迟线性增长,拖慢编辑工具本身;用户感知是「开了归因后 AI 变卡」→ 关掉功能 | 中，重度使用 1-2 月内出现 |
| **大文件静默跳过** | 单文件 >10MB（step-tracker.js:11 `MAX_FILE_SIZE`） | 该文件所有编辑不记步骤,归因缺口不可见 | 低 |

#### 实施方案（两阶段，可分开发布）

**阶段 A：不换引擎的止血修复**（半天量级，先发布）

1. **原子写**：`save()`/`close()` 改为 `writeFileSync(tmp) + renameSync`，tmp 名带 pid（照抄 `pricing-loader.js:64-71` 已验证的 `saveJsonFile` 模式）。解决「写坏库」。
2. **进程间互斥锁**：`open()` 前获取 `steps.db.lock` 目录锁（`mkdirSync` 原子性 + 锁内写 pid/时间戳；持锁进程崩溃后按「pid 不存在或锁龄 >30s」强制回收）。拿不到锁时指数退避重试 ≤2s,超时则本次 hook 静默放弃（丢一步,不阻塞用户的编辑工具——hook 绝不能卡编辑器）。解决「并发丢写」的主体。
3. **损坏自愈**：open 时 `new Sql.Database(buf)` 抛错 → 把坏文件改名为 `steps.db.corrupt.<ts>` 留证 → 建空库继续,并在 `hooks status` / 数据健康面板（#7）报告「检测到损坏,已重建」。
4. **快照瘦身**：`content_blob` 改存 gzip（`zlib.gzipSync` base64），代码文本压缩率通常 70-80%,直接缓解写放大;读取处（`getFileBlob`）解压兼容新旧两种格式（按前缀字节判断）。

**阶段 B：迁移 better-sqlite3**（1-2 天量级）

1. **抽接口**：把 `StepDatabase` 的 13 个方法定义为适配器接口,现 sql.js 实现改名 `SqlJsStepDatabase`,新增 `NativeStepDatabase`（better-sqlite3）。工厂函数按运行时探测选择。
2. **better-sqlite3 要点**：真 WAL + `busy_timeout` 解决跨进程并发（可去掉阶段 A 的目录锁）;行级写入消灭写放大;同步 API 与现有调用形态一致,迁移面小。
3. **依赖策略**：`optionalDependencies` + 运行时 `try import`。装不上（无预编译二进制的平台/Node 版本）自动回退 sql.js 路径（阶段 A 已把该路径修到可用）,`hooks status` 显示当前引擎与降级原因。**不能让归因功能的存在与否取决于 node-gyp 是否配好**。
4. **存量迁移**：首次以 native 引擎 open 时检测旧 sql.js 格式库（两者都是标准 SQLite 文件格式,better-sqlite3 可直接打开 sql.js 导出的库——先验证此假设,成立则零迁移成本;不成立则写一次性 `migrate()`：旧库读全表 → 新库事务写入 → 旧库改名备份）。
5. **schema 版本化**：新增 `meta(key, value)` 表记 `schema_version`,后续演进不再依赖 `ALTER TABLE ... catch`（step-schema.js:70 的现状）。

#### 测试计划

- **并发**：spawn 两个子进程各写 200 步（真实进程级并发,不是 Promise 并发）,断言合库后 `getStepCount() === 400`。当前代码此测试必挂,作为阶段 A 的红绿基准。
- **崩溃**：子进程写入中途 `process.kill(pid, 'SIGKILL')` 循环 20 次,断言库始终可 open（或触发自愈路径且有 .corrupt 备份）。
- **性能基准**：1000 步 × 3 文件快照写入,记录 p50/p99 单步耗时,阶段 B 后断言 p99 < 50ms（hook 不可感知）。
- 存量:现有 `test/step-tracker.test.js`、`test/hooks*.test.js`、`test/capture-recorder.test.js` 全绿;准备一个真实旧版 steps.db fixture 验证迁移。

#### 验收标准

- 双进程并发写零丢失;任意时刻 kill 进程库不损坏（或自愈 + 留证）。
- 100MB 级库上单步 hook 写入 p99 < 50ms。
- 无原生模块环境下功能完整可用（降级路径）,`hooks status` 可见当前引擎。
- 老用户升级后旧 steps.db 数据无损保留。

---

### #5 归因偏差量化，coverage 置信度透出到报告

#### 现状：归因投影管线与两类反向偏差

commit 行级归因的完整链路（`lib/step-tracker.js:225-340`）：

```
对 commit 的每个文件：
  ① 时间对齐：取 commit 时刻之前该文件最近 5 个 step（step-tracker.js:245-256）
  ② CRLF 归一（step-tracker.js:296，step 存 CRLF / git show 出 LF）
  ③ commit 内容 == step 快照 → aligned：直接用 blame_map 逐行判 AI/人工
  ④ 不相等（drift）→ projectStepBlameToCommit 做行级 diff 投影，
     coverage ≥ 0.6（fuzzyCoverageThreshold）→ 仍逐行投影（fuzzyFiles++）
  ⑤ coverage < 0.6 或无快照/无新增行 → 降级比例法（degradedFiles++，
     细分 degradedDrift / degradedNoContent / degradedNoAdded）
```

**偏差 1（低估 AI）**：`lib/line-blame.js:180-189` — drift 投影中,落在 insert/replace 区间的 commit 新增行（即 step 快照里不存在的行）无法映射,**保守计 human**。典型场景:AI 写完 → 用户跑 prettier/eslint --fix → 大量行位移变形 → 明明是 AI 写的代码被计入 human。方向固定:AI 贡献率只会被压低。

**偏差 2（高估 AI）**：`lib/line-blame.js:110-117` — computeBlame 的 equal 区间里,若旧 blame map 缺失或行号越界,fallback 是 `lines.push(stepHash)`——把**没有证据的行归给当前 step（= AI）**。触发场景:blame 链断裂（hook 曾漏触发、快照被 10MB 上限跳过、库损坏重建后首个 step）。方向固定:AI 贡献率被抬高。

**现状的可观测性**：per-file 的 `coverage` 算完即弃（只做 0.6 阈值判断）;commit 级结果对象里已有 `alignedFiles / fuzzyFiles / degradedFiles / degradedDrift / degradedNoContent / degradedNoAdded` 六个诊断计数（step-tracker.js:233-242）,但**止步于内部对象,没有任何 UI/报告展示**。用户看到的只有一个光秃秃的百分比。

#### 实施方案（三步，依赖关系：1 → 2，3 独立可先行）

**第 1 步：消除高估方向（改判 unknown）**

- `computeBlame`（line-blame.js:104-130）签名增加哨兵值:equal 区间旧 blame 缺失/越界时 push `'@unknown'` 而非 `stepHash`。
- 下游消费点同步:`projectStepBlameToCommit`（line-blame.js:184 的 `stepIds.has(...)` 判定,`'@unknown'` 自然判 human——但应单独计数为 `unknownAdded` 而非并入 humanAdded）与 step-tracker.js:296-333 的 aligned 路径同样区分「有证据的 human」与「无证据的 unknown」。
- 聚合口径:unknown 行**不进 AI 也不进 human 的分子**,单独一档展示（与 `lib/attribution.js` commit 级分类已有的 unknown 档对齐,行级与 commit 级口径统一）。
- 语义变化说明:此改动会让部分用户的 AI 贡献率下降——这是修正而非退步,变更日志里要讲清楚。

**第 2 步：coverage 逐级上卷,透出到 UI 与报告**

数据流打通四层（字段命名建议 `attributionQuality`）:

| 层 | 位置 | 内容 |
|---|------|------|
| file | step-tracker.js 投影处 | `{ mode: aligned/fuzzy/proportional, coverage }`,已有数据,补记录 |
| commit | 归因结果对象 | 新增 `lineCoverage`（各文件 coverage 按新增行数加权平均）+ 已有六个诊断计数 |
| 周期聚合 | `lib/git.js:609-706`（aiLinesAdded 汇总处） | `aiContribution.attributionQuality = { lineCoverage, alignedFiles, fuzzyFiles, degradedFiles, unknownLines }` |
| 展示 | Web「AI 贡献度」卡片 + `lib/report.js` AI 贡献板块 + MCP `ai_contribution` 工具 | 见下 |

展示规则:
- 贡献率数字旁常驻小字「行级映射覆盖率 N%」;N < 60% 时加「置信度低」标识并给原因分布（drift/无快照/无新增）。
- 周报文案模板增加一句自动生成的方法论说明:「行级归因覆盖 N% 的新增行,其余按提交级启发式估算」——这句话是审计级证据链（#16）的种子。
- Web 卡片 tooltip 解释三种模式（精确对齐 / 投影 / 比例估算）各占多少文件。

**第 3 步：已知答案基准仓库,把偏差变成回归指标**

- 写 `test/fixtures/attribution-benchmark/generate.js`:脚本化构造 Git 仓库 + steps.db,按剧本执行「AI 写入(记 step)→ 人工插行(不记 step)→ prettier 全文件重排 → AI 改写(记 step)→ 混合 commit」等 6-8 个场景,每行的真实归属（ground truth）由剧本已知。
- 跑完整归因管线,计算行级 **precision / recall**（AI 行判定）,以及第 1、2 步改动前后的对比数字。
- 固化为 `test/attribution-benchmark.test.js`:断言 precision ≥ 基线、recall ≥ 基线（数字跑出来后定）,防止未来改归因逻辑时精度静默回退。
- 顺带产出:README/文档可引用的诚实数字（「基准场景下行级归因 precision X% / recall Y%」）,替代空口的「精确到每一行」。

#### 测试计划

- 单测:computeBlame 越界 → unknown 哨兵;projectStepBlameToCommit 的 unknownAdded 计数;coverage 加权上卷的数学正确性。
- 基准:上述 benchmark 测试（precision/recall 双断言）。
- 快照:report.js 新增方法论文案的模板测试;现有 `test/line-blame.test.js`、`test/step-tracker.test.js`、`test/git-attribution.test.js` 全绿（预期部分断言需按新口径更新,逐条确认是口径变化而非逻辑错误）。

#### 验收标准

- 无证据行不再归 AI:构造 blame 链断裂用例,该行落 unknown 档。
- Web、周报、MCP 三个出口的 AI 贡献率旁均可见覆盖率;低置信场景有显式标识与原因。
- benchmark 的 precision/recall 进入测试断言;改动前后偏差对比数字写入 PR 描述。
- 文档口径更新:「精确到每一行」改为附覆盖率与方法论说明的可辩护表述。

---

### #5 归因偏差量化，coverage 置信度透出到报告

**问题**：行级归因存在**方向相反的两类系统性偏差**，且已计算出的置信度指标没有展示给用户。

**证据**：
- 低估方向：`lib/line-blame.js:187` — drift 投影时未映射的新增行保守计 human。AI 写完的代码被格式化/重构后，归因覆盖率下降，AI 贡献被低估。
- 高估方向：`lib/line-blame.js:112-116` — equal 区间若旧 blame map 越界，该行直接归给当前 step（即记为 AI），旧内容缺 blame 记录时 AI 贡献被高估。
- `projectStepBlameToCommit` 已返回 `coverage`（已映射行 / 新增行），`step-tracker.js:330` 仅用它做阈值判断（≥0.6 走逐行投影），没有透出到任何报告。

**方案**：
1. 越界 fallback（line-blame.js:112-116）改判 `unknown` 而非归当前 step，消除高估方向。
2. 把 coverage 聚合到 commit 级 / 周期级，Web「AI 贡献度」卡片和周报的贡献率数字旁展示「行级映射覆盖率 N%」，低于阈值时标注「置信度低」。
3. 构造已知答案的测试仓库（脚本生成：AI 步骤 + 人工编辑 + 格式化 + 重构混合），量化两向偏差幅度，作为回归基准固化进测试。

**验收**：报告中每个 AI 贡献率数字可见对应覆盖率；基准仓库上归因误差有量化数字并纳入测试断言。

---

## P1 — 核心体验

### #6 降低行级归因激活门槛（serve 首屏一键开启）

**问题**：行级归因（产品最大卖点）需要用户在**每个项目**手动执行 `node index.js hooks enable`，且只覆盖 Claude Code / Codex / OpenCode 三家。绝大多数用户不会做这个动作 → 护城河功能在默认体验中不存在。

**方案**：
1. `serve` 启动时检测「近 7 天有 AI 会话活动、但未启用步骤追踪」的 Git 项目，首屏顶部横幅提示 + 一键批量启用（复用 `lib/hooks-manager.js` 的交互逻辑改为 API 化）。
2. 设置页「归因与追踪」卡片列出所有已识别项目的启用状态，逐项开关。
3. 评估「全局 hook + 按项目过滤」模式的可行性（Claude Code 支持全局 settings.json hook，可一次安装、运行时按 cwd 判断是否记录）。

**验收**：新用户从 `lumencode serve` 到看到行级归因数据 ≤ 3 次点击，无需命令行。

---

### #7 新增「数据健康」面板，暴露解析失败与格式漂移

**问题**：15 款解析器实现深度差 4 倍（`lib/parsers/claude.js` 324 行 vs `hermes.js`/`kilo.js`/`codebuff.js` 约 85 行），浅解析器依赖单一文件格式假设。上游工具改日志格式后**解析器不报错、数据静默消失**，用户完全不可见。

**方案**：
1. `lib/parsers/base.js` 统一采集解析统计：扫描文件数、成功解析记录数、跳过/异常数、最后成功解析时间，各解析器填充。
2. 设置页或独立「数据健康」页按工具展示；某工具「有日志文件但解析成功率骤降/为 0」时在侧栏和汇总页显著告警。
3. CLI 增加 `lumencode doctor` 输出同样的健康报告，便于 issue 反馈。

**验收**：人为破坏一个工具的日志格式后，UI 一眼可见该工具解析异常,而不是数字悄悄变小。

---

### #8 显著展示未计价 token 占比（$0 兜底透明化）

**问题**：未知模型按 $0 计费（`lib/aggregate.js:803`）虽然诚实，但总费用被系统性低估；用户拿低估的数字写周报同样是错的，且当前 UI 不提示。

**方案**：
1. 聚合层统计「unknown 定价的 token 数 / 总 token 数」与涉及的模型清单。
2. 汇总面板费用卡片角标 +周报「费用」板块提示：「本期 N% token（M 个模型）未计价：\<模型列表\>」，链接到 FAQ 的 `overrides`/`aliasOf` 配置说明。
3. 与 #3 已完成的 fuzzy「估算价」标注并列，形成三档定价可信度：精确 / 估算 / 未计价。

**验收**：构造含未知模型的测试数据，报告与 Web 汇总均显示未计价占比与模型名。

---

### #9 统一「AI 行数」口径（added+deleted → 区分展示）

**问题**：`lib/attribution.js:137` 聚合口径是 `lines = added + deleted`，即宣传语「4,200 行中 3,180 行 AI」**包含删除行**，与用户直觉（新增代码行）不符，汇报场景被较真的人一问就尴尬。

**方案**：
1. `aggregateAttribution` 分别累计 `addedLines` / `deletedLines`（保留现有合计字段做兼容）。
2. 报告与 Web 展示改为「AI 新增 X 行、删除 Y 行」或主口径用 added、tooltip 说明口径定义。
3. README 的示例数字口径同步说明。

**验收**：所有展示「AI 行数」的位置口径一致且有定义说明；`test/attribution.test.js`、`test/git-aggregates.test.js` 更新后全绿。

---

### #10 解析结果持久化 + 按文件 offset 增量解析

**问题**：`lib/cache.js` 是内存级 mtime 缓存（上限 200 文件），重启即全量重扫全部日志；JSONL 追加一行就整文件重解析。日志积累一两年后冷启动明显变慢。竞品（TokenTracker）已用 SQLite 快照聚合。

**方案**：
1. 解析结果落盘（SQLite 或分片 JSON 快照，键 = 文件路径 + mtime + size）。
2. JSONL 类日志记录「已解析到的 byte offset」，文件变大时只读增量部分追加解析；mtime 变但 size 变小（重写/轮转）时回退全量。
3. 缓存上限从 200 提到按内存预算控制，或落盘后取消内存上限依赖。
4. 与 #7 的解析统计共用存储。

**验收**：冷启动时间在大日志量（≥1GB）下相比现状明显下降（记录基准数字）；追加日志后刷新只解析增量。

---

## P2 — 工程长期健康

### #11 commit 级启发式建中文验证集并校准权重

**问题**：非 hook 工具走 commit 级归因启发式，`lib/git-attribution-options.js:17-37` 的 `scoreWeights` 依赖英文提交信息风格特征（bullet list、imperative mood、conventional scope）。中文提交、或人类本来就写规范 commit message 的团队会被误判；阈值（0.75/0.45/0.20）纯手调，没有验证集。同时归因参数在 UI 只读，用户看不懂 confirmed/probable/possible 的判据。

**方案**：
1. 收集标注样本集：已知 AI 生成与纯人工的中英文提交各若干（可从本仓库 + 志愿项目导出），格式化为测试 fixture。
2. 回测各特征的区分度，调整权重与阈值；中文场景单独验证 style 类特征是否失效,失效则降权或加中文特征。
3. UI 归因参数卡片增加判据解释文案；报告中 possible/probable 附一句「判定依据：\<reason\>」（`classifyAttribution` 已返回 reason 字段，直接透出）。

**验收**：验证集上的准确率/召回有量化数字并写入测试；UI 能解释每个分类的依据。

---

### #12 评估定价源迁移/双源（Portkey → LiteLLM）

**问题**：当前本地表 590 模型来自 Portkey + 28 条手工别名 overrides，维护成本高；竞品普遍用 LiteLLM（2,200+ 模型、每日刷新、含缓存折扣与分层价）。Portkey 单模型 API 兜底还依赖 `inferProvider` 猜厂商（`lib/pricing-loader.js`），猜错即 404 进黑名单。

**方案**：
1. `scripts/sync-pricing.js` 增加 LiteLLM `model_prices_and_context_window.json` 为主源或交叉校验源，字段映射到内部格式（input/output/cacheRead/cacheCreate/tier）。
2. 保留 overrides + `aliasOf` 机制处理国产中转别名（glm-x / kimi-for-coding 等）——这是差异化能力，不能丢。
3. 双源冲突时的优先级规则：overrides > 较新的源 > 较旧的源，冲突清单输出到同步日志人工复核。

**验收**：同步脚本产出的模型数 ≥ 2,000;现有 `test/pricing-loader.test.js` 全绿;抽查 10 个主流模型价格与官方一致。

---

### #13 拆分巨型模块并引入 JSDoc 类型检查

**问题**：`lib/report.js` 2,424 行、`lib/git.js` 1,711 行、`lib/server.js` 1,387 行；前端手写 vanilla JS 约 7,000 行（`public/app.js` 1,803 行），无构建、无类型。按当前迭代速度（7 周 225 commits）,6 个月后将成为主要迭代瓶颈。

**方案**：
1. `report.js` 按板块拆分：用量统计 / 成本分析 / 归因板块 / 工作汇报文案 / 洞察生成，各为独立模块由入口编排。
2. `git.js` 拆出「归因评分」「commit 采集」「基线统计」子模块。
3. lib 层文件头加 `// @ts-check` + 关键函数 JSDoc 类型注解，CI 增加 `tsc --noEmit` 步骤兜底（不引入构建产物,保持零依赖交付）。
4. 前端暂不上框架，但把 `app.js` 按页面域拆分（已有 charts/export/work-report 等分文件基础，继续拆主文件）。

**验收**：单文件不超过 ~800 行；CI 含类型检查步骤且通过；行为无变化（现有测试全绿）。

---

### #14 smart-report 子进程调用去 shell 化

**问题**：`lib/smart-report.js` 的 `buildAgentSpawnInvocation` 在 Windows 下用 `cmd.exe /d /s /c` + 字符串拼接调用本地 agent CLI，`quoteCmdArg` 手工转义。cmd 的转义规则边界极多（`%`、`^`、`&`、嵌套引号），存在畸形参数注入/断裂风险。

**方案**：改用 `spawn(command, args, { shell: false })` 直接调用；Windows 下解析 `.cmd`/`.ps1` shim 的真实入口（npm 全局安装的 CLI 多为 `.cmd`，可用 `where` 结果 + 显式 `cmd /c` 仅包裹可执行文件路径本身,参数走数组）。补充含空格、引号、`%VAR%`、`&` 的参数测试。

**验收**：三个 agent（Claude Code / Codex / OpenCode）在 Windows/macOS 都能正常调起；恶意/畸形参数不产生命令拼接效果。

---

### #15 仓库卫生清理

**问题与动作**（三件小事）：
1. `docs/` 混入 `Redesign project page layout (2).zip` 与设计稿目录——移出仓库或入 `.gitignore`,设计资产放独立分支/网盘。
2. 根目录 `config.json`（个人本机配置）在仓库中——从 git 移除并 ignore，保留 `config.example.json`。
3. 场景分类（`lib/scenario.js` 工具名映射 + 关键词匹配）准确率天花板明显——UI 上把「工作类型分布」标注为参考性统计，避免被当成精确指标（一次会话实际混合编码/调试/测试）。

**验收**：`git status` 干净、新 clone 不含个人配置与二进制杂物；场景分析页有口径说明。

---

## P3 — 战略方向（价值跃迁）

> 背景：本地 token/成本仪表盘赛道已严重同质化（tokscale、TokenTelemetry、TokenTracker、TokenLens、aiusage、TokenBBQ 均覆盖多工具统计+热力图,部分已有菜单栏 App、排行榜、多机同步）。继续堆「看用量」功能无价值增量。LumenCode 的稀缺资产 = **行级归因** + **中文可发布周报**。

### #16 行级归因升级为「审计级证据链」 ⛔ 依赖 #4、#5、#6

**目标**：把「AI 贡献率」从一个数字变成可下钻、可验证的证据链，面向企业 AI ROI 度量——这是竞品没有、且付费意愿最高的方向。

**内容**：
1. 每个 AI 贡献率数字可下钻：周期 → commit 列表 → 单 commit 行级归因视图（哪些行 AI/人工/未知）→ 对应 session 与工具证据 + 置信度。
2. 导出「审计报告」：含方法论说明（归因规则、覆盖率、已知偏差）、原始证据引用,经得起 CTO/审计追问。
3. 前置依赖：#4（数据可靠性）、#5（偏差量化与置信度）、#6（激活率），地基不牢先不做上层。

### #17 团队聚合视图（匿名汇总导出 + 合并查看）

**目标**：个人本地工具没有付费空间；付费点在团队看板——成员工具使用分布、每项目 AI 贡献率、订阅利用率（竞品 aiusage 已有 S3/GitHub 多机同步,需差异化）。

**内容**：
1. 轻量第一步：`lumencode export --team` 导出匿名化汇总 JSON（无 prompt/代码内容,仅统计量）;Web 端「团队视图」支持导入多份合并展示。
2. 第二步再考虑同步后端（S3/R2/自建），并评估隐私边界与企业合规诉求。

### #18 飞书/钉钉机器人自动推送周报

**目标**：把「复制粘贴周报」升级为「到点自动出现在群里」，强化中文企业场景差异化（海外竞品覆盖不到）。

**内容**：
1. 设置页配置飞书/钉钉群机器人 webhook + 推送周期（如每周一 10:00）;serve 常驻时定时生成并推送。
2. 推送内容复用现有周报生成（详报/简报/按项目），格式用已有的飞书/钉钉适配。
3. 同期深化国产模型计价：中转站计价、套餐/充值折算——与 #12 联动。

---

## 建议执行顺序

```
#4 → #5 ─┬→ #16（审计级证据链）
#6 ──────┘
#7、#8、#9 可穿插并行（改动面小、独立）
#10 在 #7 之后（共用解析统计存储）
#12 与 #8 联动（定价可信度三档展示）
#17、#18 在 P0/P1 收尾后启动
```
