# ccusage-report

> 起因很简单：领导要看 AI 编程工具的使用数据和效率报告，手动统计太痛苦了，于是花了一个下午撸了这个小工具。没想到越用越顺手，干脆开源出来。

Claude Code 使用报告工具 — 从 JSONL 日志和 Git 仓库提取效率、AI 贡献度与使用指标，支持 Web 可视化和命令行两种模式。

## 环境要求

- Node.js >= 18.0.0

## 常见问题

| 问题 | 解决方案 |
|------|----------|
| 浏览器显示"暂无数据" | 首次启动会引导配置；如已跳过，可点击右上角设置按钮 |
| Windows 下日志目录不存在 | 默认路径为 `C:\Users\<用户名>\.claude`，确认该目录下有 `projects/` 子目录 |
| 端口 4567 被占用 | 设置环境变量：`set CCUSAGE_PORT=8080 && node index.js serve` |
| 找不到 Git 统计数据 | v0.2.0 已自动从会话 `cwd` 推导项目路径，仍未识别时可在设置中手动指定 |
| 暗色模式按钮在哪 | 标题栏右上角月亮/太阳图标一键切换 |

## 快速开始

### 方式一：npm 安装（推荐）

```bash
npm install -g ccusage-report
ccusage-report serve
```

v0.2.0 起首次运行**自动检测** Claude 日志目录和项目路径，无需手动配置即可看到完整报告。

或零安装使用：

```bash
npx ccusage-report serve
```

### 方式二：直接运行

```bash
# 无依赖，直接运行
git clone https://github.com/yaowen51888-rich/ccusage-report.git
cd ccusage-report

# 启动 Web 服务（自动打开浏览器）
node index.js serve

# 或直接生成命令行报告
node index.js report daily
```

> **v0.2.0 零配置启动**：首次运行自动检测 `~/.claude` 目录并从会话 `cwd` 字段推导项目路径，无需手动编辑配置文件即可看到完整报告。

Web 服务默认端口 `4567`，可通过环境变量修改：`set CCUSAGE_PORT=8080 && node index.js serve`

## 功能截图

### 日报

![日报](doc/日报v0.2.0.png)

顶部统计卡片：会话数、交互轮次、覆盖项目、Token 消耗（含输入/输出/缓存明细）、预估费用（含主力模型）。中部 **Git 代码产出** 区域展示提交次数、新增/删除行数、变更文件数，并新增 **AI 辅助提交占比**（含 AI 新增行 / AI 删除行）。下方 **提交类型分布** 条形图按 Conventional Commit 规范（feat/fix/test/docs/chore/perf/refactor 等）自动分类，**文件热点 Top 10** 表格按触碰次数排行变更最频繁的文件。最下方为数据分析区：工作类型环形图、模型使用、使用趋势双 Y 轴折线。

### 周报

![周报](doc/周报v0.2.0.png)

按周汇总所有指标，自动计算周一至周日的时间范围。统计卡片带 **环比变化箭头**（↑/↓ 百分比），可直观看出与上周相比的交互量、Token 消耗、费用变化。Git 区块同样展示 AI 辅助提交、类型分布、文件热点，方便代码 review 与回顾。

### 月报

![月报](doc/月报-v0.2.0.png)

按月汇总，自动计算当月起止日期，适合月度效率复盘和向上汇报。所有指标支持环比对比，趋势曲线展示当月每日的请求数和 Token 消耗。

### 工作汇报（自然语言摘要 + 多平台格式）

![工作汇报](doc/工作汇报v0.2.0.png)

v0.2.0 重构工作汇报：从「冷冰冰的表格」升级为 **自然语言段落**，自动生成包含核心指标、环比变化、项目亮点、场景分布、缓存效率、代码产出的完整文档。右上角 **平台切换标签** 支持「标准 / 飞书 / 钉钉」三种格式，一键复制即可粘贴到对应工具，也可下载 `.md` 文件归档。

### 暗色模式

![暗色模式](doc/暗色模式v0.2.0.png)

全站暗色主题，符合 DESIGN.md 中的 monochrome 灰阶色板规范。所有图表（环形图、条形图、折线图、表格）配色在亮/暗主题下保持一致体验，偏好自动记忆。

## 功能特性

| 类别 | 特性 | 说明 |
|------|------|------|
| 报告 | 多周期报告 | 日报、周报、月报，支持指定任意日期 |
| 报告 | 使用趋势图 | 折线图展示请求数和 Token 消耗的时序变化 |
| 报告 | 环比趋势箭头 | 统计卡片展示与上一周期的环比变化百分比 |
| 报告 | 费用估算 | 基于模型定价自动计算预估 API 费用 |
| 报告 | Token 明细 | 统计卡片展示输入/输出/缓存的 Token 构成 |
| 报告 | 场景分析 | 按编码/测试/调试/文档/审查/规划分类工作类型 |
| Git | AI 贡献度 | 通过 `Co-Authored-By: Claude`、`🤖 Generated` 等签名识别 AI 辅助提交，统计 AI 新增/删除行数占比 |
| Git | 提交类型分布 | 按 Conventional Commit 规范自动分类（feat/fix/refactor/docs/test/chore/perf 等）|
| Git | 文件热点 Top 10 | 按触碰次数排行变更最频繁的文件，含 +/- 行数 |
| Git | Session ↔ Commit 关联 | 按时间窗口 + 项目路径自动归属，会话钻取可看到关联提交清单 |
| 工作汇报 | 自然语言摘要 | 自动生成包含环比、亮点、效率分析的段落式汇报，不再是干巴巴的表格 |
| 工作汇报 | 多平台格式 | 标准 Markdown / 飞书 / 钉钉，一键切换格式并复制 |
| 体验 | 零配置启动 | 自动检测 `~/.claude` 目录，从 JSONL `cwd` 字段推导项目路径 |
| 体验 | 引导式欢迎页 | 首次启动展示功能介绍 + 两步配置引导 |
| 体验 | 子 agent 统计 | 自动解析 `subagents/` 目录，CLI 启动打印占比，CSV 导出独立列 |
| 体验 | 数据钻取 | 点击图表可下钻查看明细（模型按日分布、项目会话、场景匹配示例、关联提交）|
| 体验 | 暗色模式 | 亮色/暗色一键切换，配色遵循 DESIGN.md monochrome 灰阶 |
| 体验 | URL 状态持久化 | 周期和日期保存在 URL hash 中，刷新不丢失 |
| 体验 | 浏览器配置 | 设置保存到 localStorage，跨会话持久化 |
| 体验 | 离线可用 | Chart.js 和字体文件本地化，无需外部 CDN |
| 导出 | CSV / PDF | 一键导出 CSV 数据文件或打印为 PDF |
| 导出 | Markdown 下载 | 工作汇报支持下载 `.md` 文件 |

## 更新日志

### v0.2.0 (2026-05-17)

围绕「AI 贡献度」与「工作汇报体验」两条主线进行重构升级。

#### Git 深度分析（核心新增）
- 改用 `git log --numstat` 解析，记录每个提交的完整元数据（hash、date、author、subject、文件清单 + 行数变更）
- **AI 辅助提交检测**：通过 `Co-Authored-By: Claude`、`🤖 Generated with Claude`、`Assisted-By: Claude`、`noreply@anthropic` 等多重签名识别 AI 提交
- **AI 贡献度指标**：日报/周报/月报统一展示 AI 辅助提交占比、AI 新增 / AI 删除行数
- **Conventional Commit 解析**：自动识别 feat/fix/refactor/docs/test/chore/perf/style/ci/build/revert 类型并以条形图可视化
- **文件热点 Top 10**：按触碰次数排行，热度条 + 累计 +/- 行数一目了然
- **Session ↔ Commit 归属**：用 Bash `git commit` 时间戳 + 项目路径双重对齐，会话钻取展示关联的提交清单（含 hash / type / subject / 行数 / AI 标记）

#### 工作汇报重构
- 新增 `generateAutoSummary` 自然语言摘要引擎：自动生成核心叙述、环比变化、项目亮点、场景模型、缓存效率、Git 产出六段
- **多平台格式**：标准 Markdown / 飞书 / 钉钉，UI 一键切换并复制

#### 零配置启动
- 自动检测 `~/.claude` 与 `~/.config/claude` 目录
- 自动从 JSONL 的 `cwd` 字段推导本地项目路径，免去手动配置 `repos`
- 未配置时展示**欢迎引导页**（功能介绍 + 两步配置）替代原"暂无数据"空状态

#### 其他改进
- **子 agent 日志解析**：自动解析 `subagents/` 目录的 JSONL，CLI 启动时打印「子 agent Token 消耗及占比」，CSV 导出含独立列，占比 > 40% 时触发优化建议
- **暗色模式**：全图表配色重写为 DESIGN.md monochrome 灰阶色板，亮/暗体验一致
- **API 性能**：`/api/sessions` 响应字段精简，去掉 `toolSequence` / `sampleTexts` 等大字段；Git 缓存增加版本号
- **测试覆盖**：新增 `git-aggregates` / `git-ai-detect` / `git-attribution` / `git-conventional` 四组测试

### v0.1.0 (2026-05-17)

首个正式发布版本，包含完整的报告生成和可视化功能：

- **基础功能**：日报/周报/月报多周期统计，命令行和 Web 双模式
- **数据可视化**：趋势折线图、场景环形图、模型/项目/工具柱状图
- **数据钻取**：点击图表下钻查看明细数据
- **环比趋势**：统计卡片显示环比变化箭头
- **导出能力**：CSV 导出、打印/PDF、Markdown 工作汇报下载
- **暗色模式**：亮色/暗色主题一键切换
- **URL 持久化**：周期和日期保存在 URL hash 中
- **Git 集成**：代码提交统计，未配置时显示引导提示
- **开箱体验**：加载骨架屏动画、空状态 SVG 插图、卡片悬停反馈

## 命令用法

```
node index.js <命令> [周期] [日期] [选项]
```

### 命令

| 命令 | 说明 |
|------|------|
| `serve` | 启动 Web 服务（默认端口 4567） |
| `report` | 生成使用报告（默认命令） |
| `init` | 初始化配置文件 |
| `help` | 显示帮助信息 |

### 周期

| 周期 | 说明 |
|------|------|
| `daily` | 日报（默认） |
| `weekly` | 周报（自动计算所在周） |
| `monthly` | 月报（自动计算所在月） |

### 选项

| 选项 | 说明 |
|------|------|
| `--projects <路径>` | 只统计指定项目，逗号分隔 |
| `--work` | 输出 Markdown 工作汇报格式 |

### 示例

```bash
# Web 模式（v0.2.0 零配置启动）
node index.js serve

# 命令行日报
node index.js report daily
node index.js report daily 2026-05-15

# 周报 / 月报
node index.js report weekly
node index.js report monthly 2026-05-01

# 只看指定项目
node index.js report daily --projects D://fzwork,E://play/idea

# 工作汇报格式（可直接复制用于日报/周报）
node index.js report daily --work
node index.js report weekly --work

# 初始化配置文件（可选，v0.2.0 起非必需）
node index.js init
```

## 配置

v0.2.0 起首次运行**自动检测** Claude 日志目录与项目路径，通常无需手动配置。
如需自定义，可点击 Web 页面右上角设置按钮在线修改，配置保存在浏览器本地（localStorage）。

配置项说明：

| 配置项 | 说明 |
|--------|------|
| Claude 日志目录 | Claude Code 数据目录（含 `projects/` 子目录），默认自动检测 `~/.claude` |
| 本地项目路径 | 关联的 Git 仓库路径，用于统计代码提交、AI 贡献度；默认从会话 `cwd` 自动推导 |
| 排除项目 | 要排除的项目名称 |
| 场景关键词 | 场景分类关键词 JSON，按用户消息内容匹配工作类型占比 |

## 报告指标

| 类别 | 指标 |
|------|------|
| 使用概览 | 会话数、用户消息数、总请求数、活跃天数、子 agent Token 占比 |
| Token | 输入/输出/缓存命中/缓存创建/总消耗 |
| 费用估算 | 按模型定价计算的预估 API 费用 |
| 场景分布 | 编码、测试、调试、文档、审查、规划的占比 |
| 模型统计 | 各模型的请求次数和输出 Token |
| 项目排名 | 各项目的会话数和请求数 |
| 工具调用 | 最常用的工具及调用次数 |
| Git 指标 | 提交次数、新增/删除行数、变更文件数 |
| AI 贡献度 | AI 辅助提交数 / 总提交数、AI 新增行、AI 删除行 |
| 提交类型 | feat / fix / refactor / docs / test / chore / perf 等分布 |
| 文件热点 | Top 10 触碰次数最多的文件 |
| 使用趋势 | 按天的请求数和 Token 消耗变化曲线 |
