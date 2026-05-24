# Custom Date Range & Per-Project Report Design

## Overview

Two enhancements to LumenCode's reporting system:
1. **Custom time range** — beyond daily/weekly/monthly, support arbitrary start/end dates
2. **Per-project chaptered report** — break down work report by project with full data + narrative

Both features affect the data analysis page and work report page.

## Feature 1: Custom Date Range

### API Changes

**Endpoint**: `/api/report` (and all other API endpoints)

New query parameters:
- `period=custom` — activates custom mode
- `start=YYYY-MM-DD` — range start (inclusive)
- `end=YYYY-MM-DD` — range end (inclusive)

Validation:
- `start` must be ≤ `end`
- Maximum span: 90 days
- Both required when `period=custom`

### Backend Changes

**`lib/aggregate.js` — `filterRecordsByPeriod`**:
- Add `period === 'custom'` branch
- Accept `customStart`/`customEnd` from options parameter
- Filter: `r.timestamp >= customStart && r.timestamp <= customEnd + 'T23:59:59'`

**`lib/aggregate.js` — `computePrevPeriodRange`**:
- Add `period === 'custom'` branch
- Previous range = shift start/end backward by (end - start) days + 1 day gap

**`lib/server.js`**:
- Parse `start`/`end` params when `period=custom`
- Validate date format and span
- Pass to `buildReportData` via new options

**`index.js` — `buildReportData`**:
- Accept `customStart`/`customEnd` parameters
- Forward to `filterRecordsByPeriod` and `computePrevPeriodRange`
- `trendData` for custom period: use daily granularity across the range

### Frontend Changes

**`public/app.js`**:
- State: add `customStart: ''`, `customEnd: ''`
- `setPeriod('custom')` triggers date range mode
- `periodMeta` custom: `{ cn: '自定义周期', en: 'CUSTOM' }`
- Date inputs clear when switching back to daily/weekly/monthly

**`public/index.html`**:
- Add "自定义" button to period switcher group
- Inline dual date picker (hidden by default, shown when custom selected)
- Auto-trigger load on both dates filled

### Data Flow

```
User selects custom → setPeriod('custom') → date pickers appear
→ user picks start + end → loadCurrentView()
→ API: /api/report?period=custom&start=...&end=...
→ buildReportData(period='custom', ..., customStart, customEnd)
→ filterRecordsByPeriod('custom', date, { customStart, customEnd })
→ records filtered by custom range
```

## Feature 2: Per-Project Chaptered Report

### Data Enrichment

**`lib/aggregate.js` — `computeUsageStats`**:
- Extend `stats.projects[project]` to include token-level data:
```js
stats.projects[project] = {
  requests: number,
  sessions: Set,       // → .size after finalization
  inputTokens: number,
  outputTokens: number,
  cacheRead: number,
  cacheCreate: number,
  estimatedCost: number,
  models: { [modelName]: { count, inputTokens, outputTokens } },
}
```
- Accumulate tokens and cost per project alongside the existing request counter.

**`lib/git.js` — `getPerRepoGitStats`** (new function):
- Input: array of repo paths, since, until
- For each repo: call existing `getGitStatsAsync(repo, since, until)`
- Returns `Map<repoPath, gitStats>` (leverages existing gitCache)
- Each gitStats includes: commits, linesAdded, linesDeleted, filesChanged, commitList (top items), fileHotspots

**`index.js` — `buildReportData`**:
- After filtering records, group by project basename
- For each project with git data: call `getPerRepoGitStats` for that single repo
- Build `projectDetails` map: `{ projectName: { usage, git, topCommits } }`
- Include in return value

### Report Generation

**`lib/report.js` — `generateWorkReport`**:
- New section "项目详情" after the existing project progress table
- For each project (sorted by request count desc):
  - Sub-heading with project name
  - AI interaction summary: requests, tokens, sessions, cost
  - Git output: commits, +lines/-lines, top 3 hot files
  - Model distribution: top 2 models with usage percentage
  - Representative commits: top 3 feat/fix subjects
- Format adapts to platform (default/feishu/dingtalk)

### Frontend Changes

**`public/app.js`**:
- Read `projectDetails` from API response
- Render project sections in work report view

**`public/index.html`**:
- Project detail sections in report view, each as a collapsible block
- First project expanded by default, rest collapsed
- Collapsible via Alpine `x-show` toggle

### Project-to-Repo Matching

- Match by basename: `project.replace(/\\/g,'/').split('/').pop()` ↔ repo basename
- If a project has no matching repo, git section shows "暂无 Git 数据"
- If a repo has no matching project records, skip it

## Error Handling

- Custom range: 400 error if start > end, span > 90 days, or invalid date format
- Per-project: graceful fallback if git stats fail for a single repo
- Frontend: loading state per project section

## Performance Considerations

- `getPerRepoGitStats` calls are parallelized via `Promise.all`
- Per-repo results cached in existing gitCache (60s TTL)
- `parseAllEnabledTools` result shared via server-level cache (already implemented)
- Maximum 90-day span limits data volume

## Files Modified

| File | Change |
|------|--------|
| `lib/aggregate.js` | Custom period branch, per-project tokens |
| `lib/git.js` | New `getPerRepoGitStats` function |
| `lib/report.js` | Per-project chapter generation |
| `lib/server.js` | Parse start/end params, return projectDetails |
| `index.js` | buildReportData custom range + per-project data |
| `public/app.js` | Custom period state, project details rendering |
| `public/index.html` | Custom date picker UI, project section template |
| `public/style.css` | Collapsible section styles |
