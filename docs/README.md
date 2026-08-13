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
| UX-AUDIT-V4.md | The active interaction-overhaul campaign (round 65) — plan, findings, per-round record |
| NEXT.md | The five long-term directions (M1 local-first … M5 contracts) — evidence, milestone ladders, guardrails |
| STRUCTURE.md | The growth playbook: CSS volumes and folder law, pinned not remembered |

Audits live in `../audits/`. The per-wave audit series was retired after its
fixes shipped (round 65 cleanup); the two load-bearing survivors and the
reasoning are in `../audits/README.md`.
