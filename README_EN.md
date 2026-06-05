<div align="center">
  <img src="doc/logo.png" alt="LumenCode" width="520">
</div>


<p align="center">
  <a href="https://www.npmjs.com/package/lumencode"><img src="https://img.shields.io/npm/v/lumencode.svg?style=flat-square&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/lumencode"><img src="https://img.shields.io/npm/dm/lumencode.svg?style=flat-square&color=cb3837" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/lumencode.svg?style=flat-square&color=blue" alt="license"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg?style=flat-square" alt="Node.js"></a>
</p>

<p align="center">
  <b>AI Coding Assistant Analytics</b> — Line-Level AI Attribution · Three-Tool Unified · Smart Weekly Reports
</p>

<p align="center">
  <a href="README.md">中文版</a> · <a href="#cli-usage">CLI</a> · <a href="#faq">FAQ</a> · <a href="#changelog">Changelog</a>
</p>
<div align="center">
  <img src="doc/数据分析页面.png" alt="LumenCode Dashboard" width="800">
</div>

---


## What problem does it solve?

> "How much code did AI write?" "Are these AI subscriptions worth it?" — Stop calculating manually. One command does it all.

| Scenario | Solved by lumencode |
|----------|--------------------------|
| **Precise AI Contribution** | Not vague "AI helped a lot" — "3,180 out of 4,200 lines were AI-assisted." **Every line accounted for.** |
| **Proving AI ROI** | Auto-generated weekly report: "This week AI assisted 12 commits, saved ~8 hours, cost $18.50." **Management gets it instantly.** |
| **Writing weekly reports** | Pick period → click "Work Summary → Copy" → paste into Lark/DingTalk. **Done in 3 seconds.** |
| **Per-project reporting** | Configure multiple projects, then select one to generate an independent work report for each project lead |
| **Sprint cycle alignment** | Beyond daily/weekly/monthly — pick any start/end date, no longer limited to fixed periods |
| **Tracking AI costs** | Built-in **600+ model pricing** (incl. GLM, Kimi, Qwen, DeepSeek), auto-calculates equivalent API cost |

---

## Get Started in 3 Seconds

```bash
# Global install
npm install -g lumencode
lumencode serve            # Start Web server, auto-opens browser

# Or run without installing
npx lumencode serve
```

**Zero-config startup** — Auto-detects `~/.claude`, `~/.codex`, OpenCode log directories. Derives project paths from session metadata.

---

## Highlights

<div align="center">
  <img src="doc/核心能力-en.png" alt="LumenCode Core Capabilities" width="720">
</div>


| Highlight | Description |
|-----------|-------------|
| 🎯 **Line-Level AI Attribution** | Hook-based step tracking identifies AI participation for each line of code. Not "AI helped with this commit" — "This line was written by AI" |
| 🌐 **Three-Tool Unified** | Claude Code / Codex / OpenCode data auto-aggregated, sidebar tab to switch |
| 📝 **Natural Language Work Summary** | Detailed / Brief reports with insight commentary. Standard Markdown / Lark / DingTalk formats, one-click toggle |
| 🤖 **Smart Report Generation** | Connects to the local OpenCode CLI to analyze bounded statistics and source work reports, with Default and leadership-oriented "Workhorse" styles |
| 📂 **Per-Project Reports** | Select a project from the right panel to generate an independent report (commits + AI interaction volume + hotspot files) |
| 📅 **Custom Date Ranges** | Beyond daily/weekly/monthly — pick any start and end date, perfect for aligning with Sprint cycles |
| 💰 **Precise Cost Estimation** | 600+ model local pricing (incl. GLM/Kimi/Qwen/DeepSeek) + Portkey API fallback. Unknown models counted at $0, never guessed |
| 📦 **Zero-Config Out of the Box** | First run auto-detects tool directories and derives project paths |
| 🔍 **Data Drill-Down** | Click any chart to dive from aggregate stats to individual sessions/commits |
| 📈 **Trends & Insights** | Peak day detection, consecutive active streaks, tool usage 5-category distribution (editing/reading/execution/planning/research) |
| 🌙 **Light / Dark Theme** | Light/dark theme toggle, all charts auto-adapt |

---

## Screenshots

### Data Analysis Overview

> Switch tools from the left sidebar. Main area shows Token usage, cost, model distribution, and AI contribution attribution.

<table>
  <tr>
    <td><img src="doc/数据分析页面.png" alt="Summary & Trends" width="400"></td>
    <td><img src="doc/数据分析页面2.png" alt="Project & Hourly Distribution" width="400"></td>
  </tr>
  <tr>
    <td align="center">Summary + Token Trends</td>
    <td align="center">Project Distribution + Hourly Activity + Session List</td>
  </tr>
</table>

![AI Contribution & Commit Analysis](doc/数据分析页面3.png)

### Multi-Tool Dimension

> Switch to "All Tools" view for cross-tool aggregate data and comparative analysis.

![Multi-Tool Dimension](doc/多工具维度.png)

### Project Distribution & Sessions

> Per-project Token, cost, and session count stats. Click to drill down into individual session details.

![Project Distribution & Sessions](doc/项目分布-会话记录.png)

### Scenario Analysis

> Categorize by work type (coding / testing / debugging / docs / review / planning), with matched keyword examples.

![Scenario Analysis](doc/工作类型分布_匹配示例.png)

### Work Report · One-Click Publishable Weekly Report

> Natural-language paragraph reports covering Token / cost / AI contribution / project highlights / code output, each section with insight commentary.

- **Detailed** — Full data + insights + numbered sections, ideal for weekly/monthly reports
- **Brief** — 3-5 sentence core summary, ideal for daily reports or group chat
- **Smart Report** — Calls the local OpenCode CLI from the page to generate AI analysis with data summary, work highlights, key insights, risks, and recommendations
- **Style Selection** — Choose Default style, or "Workhorse" for a leadership-reporting tone before generation
- **Persistence & Freshness Hints** — Smart reports are saved by period, project, report level, and style; stale source data prompts regeneration
- **Multi-Platform Format** — Standard Markdown / Lark / DingTalk, one-click toggle
- **Per-Project** — Select a project from the right panel to generate a project-specific report

<table>
  <tr>
    <td><img src="doc/工作汇报_详报.png" alt="Work Report - Detailed" width="400"></td>
    <td><img src="doc/工作汇报_简报.png" alt="Work Report - Brief" width="400"></td>
  </tr>
  <tr>
    <td align="center"><b>Detailed</b></td>
    <td align="center"><b>Brief</b></td>
  </tr>
</table>

### Light / Dark Theme

> All chart colors auto-adapt for comfortable long sessions.

![Light Mode](doc/浅色模式.png)

> Dark mode is the default theme — the screenshots above were taken in dark mode.

---

## CLI Usage

```bash
lumencode <command> [period] [date] [options]
```

| Command | Description |
|---------|-------------|
| `serve` | Start Web server (default port 4567) |
| `report` | Generate CLI report (default command) |
| `init` | Initialize config file |

| Period | Description |
|--------|-------------|
| `daily` | Daily report (default) |
| `weekly` | Weekly report (auto-calculates week range) |
| `monthly` | Monthly report (auto-calculates month range) |

### Examples

```bash
# Web mode (recommended)
lumencode serve

# CLI daily report
lumencode report daily
lumencode report daily 2026-05-15

# Weekly / Monthly
lumencode report weekly
lumencode report monthly 2026-05-01

# Specific projects only
lumencode report daily --projects D:/fzwork,E:/play/idea

# One-click publishable work summary
lumencode report daily --work          # Detailed
lumencode report daily --work --brief  # Brief
lumencode report weekly --work
```

---

## Configuration

v0.4.0+ supports Claude Code, Codex, and OpenCode. **Auto-detects** installed tools' log directories and project paths on first run.

For customization, click the settings button (top-right corner) in the Web UI.

| Setting | Description |
|---------|-------------|
| Claude Log Directory | Claude Code data directory (contains `projects/`), defaults to `~/.claude` |
| Codex Log Directory | Codex data directory (contains `sessions/`), auto-detected |
| OpenCode Log Directory | OpenCode data directory, auto-detected |
| Enabled Tools | Specify which tools to enable, defaults to all detected |
| Local Project Paths | Git repo paths for code commit stats and AI attribution |
| Excluded Projects | Project names to exclude |
| Scenario Keywords | Work type classification keyword JSON |

### Model Pricing Data

- **Local table** — 590 models pre-synced from [Portkey-AI/models](https://github.com/Portkey-AI/models) with vendor canonical names
- **Alias mapping** — 28 authoritative overrides mapping aggregator aliases (`glm-5.1`, `kimi-for-coding`) to correct pricing
- **API fallback** — Unknown models auto-queried via Portkey's free API, results cached to `data/pricing-cache.json`
- **Graceful degradation** — When API is unavailable, the model is counted at $0 (won't be guessed), other models unaffected

---

## FAQ

| Issue | Solution |
|-------|----------|
| Browser shows "No Data" | First run will guide you through config; if skipped, click settings button (top-right) |
| Log directory not found on Windows | Default path is `C:\Users\<username>\.claude`, ensure `projects/` subdirectory exists |
| Port 4567 in use | Set env variable: `set LUMENCODE_PORT=8080 && lumencode serve` |
| Git stats not found | v0.2.0+ auto-derives project path from session `cwd`. Manual override available in settings |
| Cost showing $0 | Model not in pricing table — try with network connection to let API fallback resolve, or add an `aliasOf` entry in `data/pricing.json` overrides |

---

## Requirements

- Node.js >= 18.0.0
- At least one of Claude Code / Codex / OpenCode installed with existing session logs

---

## Changelog

### v1.3.4 (2026-06-05) — Smart Report Styles & Work Highlights

- **Smart Report Style Selection** — Pick "Default" or "Workhorse" before generation. Workhorse uses a leadership-reporting tone focused on effort, output value, risk handling, and next steps
- **Work Highlights Analysis** — AI smart reports now require a dedicated work highlights section, turning raw stats into reportable highlights with evidence
- **Boss Report Migration** — Removed the separate "Boss Report" level from the standard work report and moved that capability into smart report styles
- **Persistent Smart Reports** — Smart reports are stored separately by style, with default style remaining compatible with existing records
- **Background Generation UX** — Smart report generation runs as a background job, restores progress after refresh, and shows a gradually advancing progress bar while waiting

### v1.3.0 (2026-05-28) — Line-Level AI Attribution & Interactive Hooks Management

- **Line-Level AI Attribution** — Step tracking via hooks, refining attribution granularity from commit-level to line-level for precise AI participation measurement
- **Interactive Hooks Management** — Bottom-left status indicator in Web UI with one-click enable/disable and automatic config backup
- **Codex Unified Hook Capture** — Supports Codex `PostToolUse` hook for real-time file edit step recording
- **Claude Batch Hook Mode** — Supports `PostToolBatch` batch hook for reduced performance overhead
- **OpenCode Plugin Support** — Added OpenCode `lumencode-step-tracker.js` plugin, covering all three tools
- **Report Diagnostics Improved** — Better CLI defaults and friendlier error messages
- **Parser Stability Enhanced** — Hardened Git metric parsing, tool parser stability, and cross-parser project filtering

### v1.2.0 (2026-05-26) — AI Confidence Accuracy Overhaul

- **Baseline Calibration** — Establishes personal coding baselines from project history to distinguish "your normal style" from "AI-assisted style"
- **Negative Signal Detection** — Identifies reverse indicators of purely human commits (e.g., weekend commits, short editing sessions), reducing false positives
- **Continuous Scoring** — Upgrades from binary (yes/no) to 0-100% continuous confidence for finer-grained attribution results
- **Improved Attribution Ownership** — Better AI contribution assignment logic in multi-collaborator scenarios

### v1.1.0 (2026-05-25) — Concurrent Pipeline & Layered Attribution

- **Concurrent Pipeline Processing** — Data parsing and Git stats run in parallel, significantly speeding up large repo analysis
- **Eliminated Redundant Git Calls** — Caches repeated queries, reducing I/O overhead
- **Layered AI Attribution** — Three-layer confidence model (explicit signature / session strong correlation / file overlap) for more accurate attribution

### v1.0.0 (2026-05-24) — Per-Project Reports & Custom Date Ranges

- **Per-Project Reports** — Added project selector in the work report right panel. Select a project to auto-filter data and generate an independent report (commits + AI interaction volume + hotspot files)
- **Custom Date Ranges** — New "Custom" period option supporting arbitrary start/end dates, ideal for Sprint cycle alignment
- **Smart Date Navigation** — Arrow buttons auto-adjust step size based on period: daily ±1 day, weekly ±7 days, monthly ±1 month
- **Sidebar Redesign** — Version info, theme toggle, and collapse button moved to footer. Header keeps only title and link, for a more compact layout
- **UI Redesign** — New visual design with a more compact layout and intuitive data presentation

### v0.4.0 (2026-05-22) — Multi-Tool Unified Platform

Upgraded from Claude Code single-tool report to AI Coding Full-Stack Analysis Platform.

- **Multi-Tool Support** — Added OpenAI Codex CLI and OpenCode parsers, three-tool data auto-aggregated
- **Tool Version Detection** — Auto-reads each tool's version number and displays in sidebar
- **AI Attribution Engine** — Multi-layer confidence (explicit signature / session strong / file overlap), cross-day commit matching, per-tool filtering
- **600+ Model Pricing** — Integrated [Portkey-AI/models](https://github.com/Portkey-AI/models) database covering OpenAI/Anthropic/Google + Chinese vendors. API fallback for unknown models; graceful $0 on API failure (no guessing)
- **Work Report Insights** — Each section now includes diagnostic commentary, not just data
- **Tool Usage Patterns** — Tool calls reclassified into 5 categories (editing/reading/execution/planning/research)
- **Time Trends** — Weekly/monthly reports add daily activity trend analysis (peak day, consecutive active days, trend direction)
- **Dynamic Numbering** — Report sections numbered dynamically based on available data, no more gaps
- **Scenario Classification Expansion** — Added Codex/OpenCode/Serena MCP tool scenario mappings
- **UI Polish** — Redesigned AI attribution section, tool theme colors (Claude orange, Codex green, OpenCode purple), dark mode refinements
- **Work Report Fix** — Dark mode toggle no longer accidentally switches back to main report

### v0.3.0 (2026-05-19)

- Added Lark and DingTalk format support for work summaries, with Detailed/Brief toggle
- Fixed layout jumping on refresh, improved Markdown rendering and dark mode
- Enhanced AI attribution confidence scoring and file-level metrics

### v0.2.0 (2026-05-17) — Git Deep Analysis

Added AI-assisted commit detection, contribution metrics, Conventional Commit parsing, File Hotspots Top 10, Session ↔ Commit correlation, and zero-config startup.

### v0.1.0 (2026-05-17)

Initial release.

---

## Support This Project

If this tool helps you:

- **Star this repo** — Help others discover it
- **File an issue** — Report bugs or request features
- **Open a PR** — Contributions welcome for model pricing, scenario keywords, or new tool adapters

---

## License

[MIT](LICENSE) © [zhangyaowen](https://github.com/yaowen51888-rich)
