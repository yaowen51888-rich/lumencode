<div align="center">
  <img src="doc/logo.png" alt="ccusage-report logo" width="160">
  <h1>ccusage-report</h1>
</div>

<p align="center">
  <a href="https://www.npmjs.com/package/ccusage-report"><img src="https://img.shields.io/npm/v/ccusage-report.svg?style=flat-square" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/ccusage-report"><img src="https://img.shields.io/npm/dm/ccusage-report.svg?style=flat-square" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/ccusage-report.svg?style=flat-square" alt="license"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg?style=flat-square" alt="Node.js"></a>
</p>

> **How much code did Claude Code write for you? One command to find out.**

Answer the boss's ultimate question — "Is this AI tool worth it?" — with real data. Token usage, cost estimates, AI contribution, code output — all auto-generated. Copy-paste into Lark or DingTalk weekly reports in seconds.

![Daily Report Screenshot](doc/%E6%97%A5%E6%8A%A5v0.2.0.png)

[中文版](README.md)

## What problem does it solve?

**Writing your weekly report** — Open ccusage-report, switch to weekly, click "Work Summary → Copy", paste into your team chat. Done.

**Proving AI ROI** — "Last week 67% of commits had AI involvement, AI-assisted 4,200 lines added, cost $12.50." Real numbers, real confidence.

**Understanding your Claude Code habits** — Which project uses it most? Which model burns the most tokens? When's your coding peak? All at a glance.

## Get Started in 3 Seconds

```bash
# Global install
npm install -g ccusage-report

# Start Web server (auto-opens browser)
ccusage-report serve
```

Zero-config startup — automatically detects `~/.claude` log directory and project paths.

```bash
# Or use without installation
npx ccusage-report serve
```

## Key Features

- **AI Contribution Analysis** — Detect AI-assisted commits via `Co-Authored-By: Claude`, `🤖 Generated` signatures. Quantify AI's actual share in your codebase.
- **Natural Language Work Summary** — No more dry tables. Auto-generate paragraph-style reports with trend analysis, project highlights, and efficiency insights. Supports Lark/DingTalk formats.
- **Zero-Config Out of the Box** — First run auto-detects log directory and project paths. No manual config file editing needed.
- **Multi-Period Reports** — Daily, weekly, monthly reports with one-click switching and period-over-period trend comparison.
- **Cost Estimation** — Automatic API cost calculation based on model pricing.
- **Data Drill-Down** — Click any chart to dive into detailed data.
- **Dark Mode** — Full-site dark theme with consistent chart color schemes.

## Feature Overview

| Feature | Description |
|---------|-------------|
| 📊 **Multi-Period Reports** | Daily / Weekly / Monthly, supports any date range |
| 🤖 **AI Contribution** | Identify AI-assisted commits, measure AI add/delete line ratios |
| 📝 **Work Summary** | Natural language summary, supports Markdown / Lark / DingTalk formats |
| 📈 **Usage Trends** | Line charts showing request count and Token consumption over time |
| 💰 **Cost Estimation** | Automatic API cost calculation based on model pricing |
| 🏷️ **Commit Type Distribution** | Auto-categorize by Conventional Commit (feat/fix/refactor etc.) |
| 🔥 **File Hotspots Top 10** | Rank files by touch frequency |
| 🎯 **Scenario Analysis** | Categorize work type: coding/testing/debugging/docs/review/planning |
| 📤 **Export** | One-click CSV / PDF / Markdown export |
| 🌙 **Dark Mode** | Light/dark theme toggle |

### Weekly Report

![Weekly Report](doc/%E5%91%A8%E6%8A%A5v0.2.0.png)

### Monthly Report

![Monthly Report](doc/%E6%9C%88%E6%8A%A5-v0.2.0.png)

### Work Summary (Natural Language + Multi-Platform)

![Work Summary](doc/%E5%B7%A5%E4%BD%9C%E6%B1%87%E6%8A%A5v0.2.0.png)

### Dark Mode

![Dark Mode](doc/%E6%9A%97%E8%89%B2%E6%A8%A1%E5%BC%8Fv0.2.0.png)

## CLI Usage

```bash
node index.js <command> [period] [date] [options]
```

| Command | Description |
|---------|-------------|
| `serve` | Start Web server (default port 4567) |
| `report` | Generate usage report (default command) |
| `init` | Initialize config file |

| Period | Description |
|--------|-------------|
| `daily` | Daily report (default) |
| `weekly` | Weekly report (auto-calculates week range) |
| `monthly` | Monthly report (auto-calculates month range) |

### Examples

```bash
# Web mode
ccusage-report serve

# CLI daily report
ccusage-report report daily
ccusage-report report daily 2026-05-15

# Weekly / Monthly
ccusage-report report weekly
ccusage-report report monthly 2026-05-01

# Specific projects only
ccusage-report report daily --projects D://fzwork,E://play/idea

# Work summary format (copy-ready for daily/weekly reports)
ccusage-report report daily --work
ccusage-report report weekly --work
```

## Requirements

- Node.js >= 18.0.0

## Configuration

v0.2.0+ auto-detects Claude log directory and project paths on first run. Usually no manual configuration needed.

For customization, click the settings button (top-right corner) in the Web UI. Settings are saved in browser localStorage.

| Setting | Description |
|---------|-------------|
| Claude Log Directory | Claude Code data directory (contains `projects/` subdirectory), auto-detects `~/.claude` by default |
| Local Project Paths | Associated Git repo paths for code commit and AI contribution stats |
| Excluded Projects | Project names to exclude |
| Scenario Keywords | Scenario classification keywords JSON |

## FAQ

| Issue | Solution |
|-------|----------|
| Browser shows "No Data" | First run will guide you through config; if skipped, click the settings button (top-right) |
| Log directory not found on Windows | Default path is `C:\Users\<username>\.claude`, ensure `projects/` subdirectory exists |
| Port 4567 in use | Set env variable: `set CCUSAGE_PORT=8080 && ccusage-report serve` |
| Git stats not found | v0.2.0+ auto-derives project path from session `cwd`. Manual override available in settings |

## Changelog

### v0.3.0 (2026-05-19)

- **Work summary platform support**: Lark and DingTalk format output with one-click switching
- **Brief/Detailed report toggle**: Compact or full report modes
- **Fix layout jumping on refresh**: Resolved cards clustering in center before data loads
- **Markdown rendering improvements**: Custom list markers, dividers, table hover effects, code styling
- **AI attribution enhancements**: Improved confidence scoring and file-level metrics
- **Dark mode refinements**: Work summary area, platform badges, and more

### v0.2.7 (2026-05-18)

- Fix package.json format, ensure zero-warnings on npm publish

### v0.2.0 (2026-05-17)

Major refactor around "AI Contribution" and "Work Summary Experience".

- **Git Deep Analysis**: AI-assisted commit detection, AI contribution metrics, Conventional Commit parsing, File Hotspots Top 10, Session ↔ Commit correlation
- **Work Summary Refactor**: Natural language summary engine, multi-platform formats (Standard/Lark/DingTalk)
- **Zero-Config Startup**: Auto-detect log directory and project paths
- **Sub-agent Stats**: Auto-parse `subagents/` directory Token consumption
- **Dark Mode**: Full chart color rewrite with monochrome grayscale palette

### v0.1.0 (2026-05-17)

Initial release with complete report generation and visualization.

## License

[MIT](LICENSE)
