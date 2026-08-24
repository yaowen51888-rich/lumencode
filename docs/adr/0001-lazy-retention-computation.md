# Lazy derivation for Human-vs-AI Retention, with attribution-only caching

Quality insight (see CONTEXT.md) needs to know whether lines added by AI survive longer than lines added by humans. We decided to compute retention lazily from git at report time, never storing survival state, because survival changes with every commit and any snapshot would drift from reality after rebase/amend.

The kernel is a pure function: (commit range) → Human-vs-AI Retention. The churn window is three weeks, matching GitClear's definition, so numbers are comparable with published industry research. Weekly reports additionally show a one-week short-term figure.

## Considered Options

- **Periodic snapshots** (rejected): storing line-survival snapshots introduces a second source of truth that rebase, cherry-pick, and amend silently invalidate.
- **Cache split by mutability** (accepted): attribution per commit hash is an immutable fact ("line n of commit X is AI-written") and may be cached freely — a changed hash after rebase naturally invalidates it. Survival is derived state and is always computed fresh.

## Consequences

- v1 ships with no cache; if report generation exceeds ~2s, add a SQLite table `commit_hash → line attribution` without touching the kernel.
- A later dashboard showing retention trends reuses the same attribution cache — it stores archived report results, not a snapshot daemon.
- Retention comparison uses only the existing three-state attribution (ai / human / unknown): lines that cannot be proven either way count as unknown and stay out of the comparison. Attribution Coverage (mapped share of lines) is shown alongside, since a low-coverage comparison is not trustworthy.
