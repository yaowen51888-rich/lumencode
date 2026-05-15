# ccusage-report

Claude Code 使用报告工具 — 从 JSONL 日志和 Git 仓库提取效率与使用指标，支持 Web 可视化和命令行两种模式。

## 环境要求

- Node.js >= 18.0.0

## 快速开始

```bash
# 安装（无依赖，直接运行）
cd ccusage-report

# 启动 Web 服务（自动打开浏览器）
node index.js serve

# 或直接生成命令行报告
node index.js report daily
```

Web 服务默认端口 `4567`，可通过环境变量修改：`set CCUSAGE_PORT=8080 && node index.js serve`

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

## Web 功能

启动 `serve` 后，浏览器中可进行：

- **切换周期**：日报 / 周报 / 月报，支持选择日期
- **可视化图表**：场景分布、模型使用、项目排名、工具调用统计
- **Git 指标**：提交次数、代码行数变更（需配置 `repos`）
- **工作汇报**：一键生成 Markdown 格式的工作汇报并复制
- **在线配置**：点击设置按钮修改 `claudeDir`、`repos` 等配置

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
