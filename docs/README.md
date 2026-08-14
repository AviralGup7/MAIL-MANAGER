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
| OVERHAUL-V3.md | The v3 overhaul plan and record — the redesign the current shell grew out of |
| NEXT.md | The long-term directions — M1–M5 with statuses, then the second-generation analysis (what to work on next) |
| SOAK.md | The live-mailbox ritual (direction G1): the one audit cap no gate can lift from the inside |
| SEMESTER.md | The semester refresh (direction G4 m3): timetable + data-pack regeneration, with dates, owners and the accuracy gate |
| STRUCTURE.md | The growth playbook: CSS volumes and folder law, pinned not remembered |
| IMPLEMENTATION-2026-08-15.md | The plan landing the 2026-08-15 system audit's findings — every AUD-ID mapped to files, settings, and pins (P0–P3) |
| STATE-BOUNDARY.md | Worker≠app runtime state — the law against "helpfully" unifying them |

Audits live in `../audits/`. The per-wave audit series was retired after its
fixes shipped (round 65 cleanup); the two load-bearing survivors and the
reasoning are in `../audits/README.md`.
