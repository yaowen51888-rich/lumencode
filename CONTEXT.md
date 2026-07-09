# LumenCode Context

LumenCode measures AI coding work from local tool logs and project-local editing evidence. This glossary fixes product-specific language used when discussing attribution and step tracking.

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
