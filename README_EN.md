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
  Supports <b>Claude Code · Codex · OpenCode</b> · 600+ model pricing · AI contribution attribution · One-click Lark/DingTalk weekly reports
</p>

<p align="center">
  <a href="README.md">中文版</a> · <a href="#cli-usage">CLI</a> · <a href="#faq">FAQ</a> · <a href="#changelog">Changelog</a>
</p>
---

## What problem does it solve?

> "How much code did AI write this week?" "Are these AI subscriptions worth it?" — Stop calculating manually. One command does it all.

| Scenario | Solved by lumencode |
|----------|--------------------------|
| **Writing weekly reports** | Pick weekly → click "Work Summary → Copy" → paste into Lark/DingTalk. **Done in 3 seconds.** |
| **Proving AI ROI** | "67% of commits had AI involvement, AI-assisted 4,200 lines added, cost $12.50." **Real numbers, real confidence.** |
| **Understanding usage habits** | Which project uses it most? Which model burns the most tokens? When's your coding peak? **All at a glance.** |
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

| Highlight | Description |
|-----------|-------------|
| 🌐 **Three-Tool Unified** | Claude Code / Codex / OpenCode data auto-aggregated, sidebar tab to switch |
| 🤖 **AI Contribution Attribution** | Detects `Co-Authored-By: Claude` signatures. Multi-layer engine measures AI's actual share in your codebase |
| 📝 **Natural Language Work Summary** | Detailed / Brief reports with insight commentary. Standard Markdown / Lark / DingTalk formats, one-click toggle |
| 💰 **Precise Cost Estimation** | 600+ model local pricing (incl. GLM/Kimi/Qwen/DeepSeek) + Portkey API fallback. Unknown models counted at $0, never guessed |
| 📦 **Zero-Config Out of the Box** | First run auto-detects tool directories and derives project paths |
| 🔍 **Data Drill-Down** | Click any chart to dive from aggregate stats to individual sessions/commits |
| 📈 **Trends & Insights** | Peak day detection, consecutive active streaks, tool usage 5-category distribution (editing/reading/execution/planning/research) |
| 🌙 **Dark Mode** | Light/dark theme toggle, all charts auto-adapt |

---

## Screenshots

### Multi-Tool Summary View

> All-tools aggregate dashboard. AI contribution ratio, Token usage, cost, activity time, model distribution, scenario breakdown — all in one screen.

![Multi-Tool Summary](doc/%E5%85%A8%E9%87%8FAi%E5%B7%A5%E5%85%B7%E6%B1%87%E6%80%BB%E6%8A%A5%E5%91%8A.png)

### Per-Tool Reports

> Click sidebar tabs to view any single tool's data.

<table>
  <tr>
    <td><img src="doc/claude_code%E5%B7%A5%E5%85%B7%E4%BD%BF%E7%94%A8%E6%8A%A5%E5%91%8A.png" alt="Claude Code" width="400"></td>
    <td><img src="doc/codex%E4%BD%BF%E7%94%A8%E6%8A%A5%E5%91%8A.png" alt="Codex" width="400"></td>
  </tr>
  <tr>
    <td align="center"><b>Claude Code</b></td>
    <td align="center"><b>OpenAI Codex</b></td>
  </tr>
  <tr>
    <td><img src="doc/opencode%E4%BD%BF%E7%94%A8%E6%8A%A5%E5%91%8A.png" alt="OpenCode" width="400"></td>
    <td></td>
  </tr>
  <tr>
    <td align="center"><b>OpenCode</b></td>
    <td></td>
  </tr>
</table>

### Scenario Analysis & Model Distribution

> Categorize by work type (coding / testing / debugging / docs / review / planning), drill down to per-model token usage.

<table>
  <tr>
    <td><img src="doc/%E5%B7%A5%E4%BD%9C%E7%B1%BB%E5%9E%8B%E5%88%86%E5%B8%83_%E5%8C%B9%E9%85%8D%E7%A4%BA%E4%BE%8B.png" alt="Scenarios" width="400"></td>
    <td><img src="doc/%E6%A8%A1%E5%9E%8B%E4%BD%BF%E7%94%A8%E5%88%86%E5%B8%83_%E5%85%B7%E4%BD%93%E7%94%A8%E9%87%8F.png" alt="Models" width="400"></td>
  </tr>
  <tr>
    <td align="center">Work Type Distribution (with matched keywords)</td>
    <td align="center">Model Distribution (with detailed token usage)</td>
  </tr>
</table>

### Work Report · One-Click Publishable Weekly Report

> Natural-language paragraph reports covering Token / cost / AI contribution / project highlights / code output, each section with insight commentary.

- **Detailed** — Full data + insights + numbered sections, ideal for weekly/monthly reports
- **Brief** — 3-5 sentence core summary, ideal for daily reports or group chat
- **Multi-Platform Format** — Standard Markdown / Lark / DingTalk, one-click toggle

<table>
  <tr>
    <td><img src="doc/%E5%B7%A5%E4%BD%9C%E6%B1%87%E6%8A%A5_%E8%AF%A6%E6%8A%A5.png" alt="Work Report - Detailed" width="400"></td>
    <td><img src="doc/%E5%B7%A5%E4%BD%9C%E6%B1%87%E6%8A%A5_%E7%AE%80%E6%8A%A5.png" alt="Work Report - Brief" width="400"></td>
  </tr>
  <tr>
    <td align="center"><b>Detailed</b></td>
    <td align="center"><b>Brief</b></td>
  </tr>
</table>

### Dark Mode

> All chart colors auto-adapt for comfortable long sessions.

![Dark Mode](doc/%E6%9A%97%E8%89%B2%E6%A8%A1%E5%BC%8F.png)

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
