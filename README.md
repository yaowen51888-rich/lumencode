# ccusage-report

Claude Code 使用报告工具 — 从 JSONL 日志和 Git 仓库提取效率与使用指标，支持 Web 可视化和命令行两种模式。

## 环境要求

- Node.js >= 18.0.0

## 快速开始

```bash
# 无依赖，直接运行
cd ccusage-report

# 启动 Web 服务（自动打开浏览器）
node index.js serve

# 或直接生成命令行报告
node index.js report daily
```

Web 服务默认端口 `4567`，可通过环境变量修改：`set CCUSAGE_PORT=8080 && node index.js serve`

## 功能截图

### 日报

![日报](doc/日报.png)

顶部统计卡片展示会话数、请求数、项目数、Token 总消耗；下方图表包含场景分布（环形图）、模型使用排名、项目分布和工具调用统计。

### 周报

![周报1](doc/周报1.png)

![周报2](doc/周报2.png)

按周汇总所有指标，自动计算周一至周日的时间范围，Git 区域展示提交次数、新增/删除行数、变更文件数。

### 月报

![月报](doc/月报.png)

按月汇总，自动计算当月起止日期，适合月度效率复盘。

### 工作汇报

![周报-工作汇报1](doc/周报-工作汇报1.png)

![周报-工作汇报2](doc/周报-工作汇报2.png)

点击「生成工作汇报」按钮，自动将数据转为 Markdown 格式的汇报文档，包含使用概览表格、场景分布、项目明细和 Git 指标，一键复制即可粘贴到飞书/钉钉/邮件。

### 在线设置

![设置](doc/设置.png)

点击右上角设置按钮，可在线修改 Claude 数据目录、Git 仓库路径、排除项目和场景关键词，保存后即时生效。

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
# Web 模式
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

# 初始化配置文件
node index.js init
```

## 配置文件

文件路径：`config.json`

```json
{
  "claudeDir": "C:\\Users\\<用户名>\\.claude",
  "repos": ["D:\\work\\project1", "E:\\dev\\project2"],
  "excludeProjects": [],
  "scenarioKeywords": {
    "coding": ["实现", "功能", "开发", "implement", "feature", "refactor", "重构"],
    "testing": ["测试", "test", "覆盖率", "coverage", "jest", "vitest"],
    "debugging": ["修复", "bug", "debug", "fix", "报错", "错误", "异常", "error"],
    "documentation": ["文档", "doc", "readme", "注释", "说明", "指南"],
    "review": ["review", "审查", "代码审查", "/review"],
    "planning": ["计划", "plan", "设计", "架构", "方案", "design", "architect"]
  }
}
```

| 配置项 | 说明 |
|--------|------|
| `claudeDir` | Claude Code 数据目录（含 `projects/` 子目录） |
| `repos` | 关联的 Git 仓库路径，用于统计代码提交指标 |
| `excludeProjects` | 要排除的项目名称数组 |
| `scenarioKeywords` | 场景分类关键词，按用户消息内容匹配工作类型占比 |

## 报告指标

| 类别 | 指标 |
|------|------|
| 使用概览 | 会话数、用户消息数、总请求数、活跃天数 |
| Token | 输入/输出/缓存命中/总消耗 |
| 场景分布 | 编码、测试、调试、文档、审查、计划的占比 |
| 模型统计 | 各模型的请求次数和输出 Token |
| 项目排名 | 各项目的会话数和请求数 |
| 工具调用 | 最常用的工具及调用次数 |
| Git 指标 | 提交次数、新增行数、删除行数、变更文件数 |
