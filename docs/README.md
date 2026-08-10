# Documentation index

Newcomer order: this file → ARCHITECTURE.md → THREADING.md → the audits.

| File | What it answers |
|---|---|
| ARCHITECTURE.md | The layering, the data flow, and why app.js must not be rewritten yet |
| THREADING.md | Worker/app message contract, verbs, timeouts, degradation states |
| SERVICE-WORKER.md | Why the worker owns the token; eviction behaviour |
| TIMETABLE.md | Provenance and precedence of timetable truth |
| CLASSIFICATION_DATA_PACK.md | The single source the category rules are generated from |
| EXTENSION-KEY.md | What the pinned extension key protects |
| BUILD-PLAN.md | Historical; superseded by the audit roadmap |

Audits live in `../audits/`; start at `39-*` for the ten individual audits and
the consolidation for the deduplicated, priced roadmap.
