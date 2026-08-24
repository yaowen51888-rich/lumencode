# LumenCode Context

LumenCode measures AI coding work from local tool logs and project-local editing evidence. This glossary fixes product-specific language used when discussing attribution, step tracking, and quality insight.

## Language

**Step Database**:
A project-local evidence store containing recorded AI tool editing steps for line-level attribution.
_Avoid_: ccusage database, hook database

**Legacy Step Database**:
An existing Step Database created by older LumenCode versions before the product-owned storage path was introduced.
_Avoid_: old ccusage database, stale database

**Step Tracking**:
The feature that records AI tool editing steps in a project so later Git attribution can use them as evidence.
_Avoid_: hooks, capture, logging

**Step Database Status**:
A project-local record of notable Step Database health events that should be visible to users.
_Avoid_: recovery log, health file

**Churn**:
A line added to a project that is deleted or rewritten within the churn window (three weeks, matching GitClear's definition).
_Avoid_: rework, deletion rate

**Retention**:
The share of lines added in a period that survive past the churn window unchanged.
_Avoid_: survival rate

**Human-vs-AI Retention**:
The core quality metric: Retention of AI-attributed lines compared against human-attributed lines in the same project and window. A Retention number without this comparison is not a quality insight.
_Avoid_: AI quality score, standalone AI retention

**Quality Insight**:
The product area (page section) that presents Human-vs-AI Retention and its drill-down evidence. Parallel to the usage Dashboard, not a replacement for it.
_Avoid_: quality report, code review

**Attribution Coverage**:
The share of added lines that could be attributed as either AI or human. Unattributable lines are unknown — a third state that never joins the Human-vs-AI Retention comparison.
_Avoid_: accuracy, mapping rate

**AI Self-Revision**:
An AI-attributed line later rewritten by AI inside the churn window. Shown separately from Human Rework in the Quality Insight drill-down.
_Avoid_: AI rework, self-healing

**Human Rework**:
An AI-attributed line later rewritten by a human inside the churn window. Shown separately from AI Self-Revision in the Quality Insight drill-down.
_Avoid_: manual fix, correction
