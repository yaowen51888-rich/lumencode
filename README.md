# ccusage-report 操作说明

## 功能简介

从 Claude Code JSONL 日志和 Git 仓库提取效率与使用指标，生成日报、周报、月报。

## 环境要求

- Node.js >= 18.0.0

## 快速开始

### 1. 进入项目目录

```bash
cd E:/ccusage-report
```

### 2. 生成报告

```bash
node index.js report daily
```

## 命令用法

```
node index.js <命令> [周期] [日期]
```

| 命令 | 说明 |
|------|------|
| `report` | 生成使用报告（默认命令） |
| `init` | 初始化配置文件 |
| `help` | 显示帮助信息 |

| 周期 | 说明 |
|------|------|
| `daily` | 日报（默认） |
| `weekly` | 周报 |
| `monthly` | 月报 |

| 日期 | 说明 |
|------|------|
| `YYYY-MM-DD` | 参考日期，默认今天。周报/月报会自动计算起止范围 |

### 常用示例

```bash
# 日报
node index.js report daily
node index.js report daily 2026-05-15

# 周报
node index.js report weekly
node index.js report weekly 2026-05-15

# 月报
node index.js report monthly
node index.js report monthly 2026-05-01

# 初始化配置文件
node index.js init
```

## 配置文件

文件路径：`config.json`

```json
{
  "claudeDir": "C:\\Users\\宋卫奇\\.claude",
  "repos": ["D:\\fzwork"],
  "excludeProjects": [],
  "scenarioKeywords": {
    "coding": ["实现", "功能", "开发", "implement", "feature", "add", "refactor", "重构", "组件"],
    "testing": ["测试", "test", "覆盖率", "coverage", "单元测试", "jest", "vitest"],
    "debugging": ["修复", "bug", "debug", "fix", "报错", "错误", "异常", "error", "排查"],
    "documentation": ["文档", "doc", "readme", "注释", "说明", "指南", "guide"],
    "review": ["review", "审查", "代码审查", "/review"],
    "planning": ["计划", "plan", "设计", "架构", "方案", "design", "architect"]
  }
}
```

| 配置项 | 说明 |
|--------|------|
| `claudeDir` | Claude Code 日志目录路径 |
| `repos` | 关联的 Git 仓库路径数组 |
| `excludeProjects` | 要排除的项目名称数组 |
| `scenarioKeywords` | 场景分类关键词，用于统计各类工作占比 |

## 输出内容

报告包含以下指标：

- **会话统计**：会话数、消息数、平均消息数
- **工作场景分布**：编码、测试、调试、文档、审查、计划的占比
- **项目分布**：各项目的使用频率
- **Git 指标**：代码提交数、新增行数、删除行数（需配置 `repos`）

## 注意事项

1. 确保 `claudeDir` 指向的目录包含 Claude Code 的 JSONL 日志文件
2. Git 仓库路径需指向本地已克隆的仓库根目录
3. 如果日志目录被其他进程占用，可能无法读取最新数据
