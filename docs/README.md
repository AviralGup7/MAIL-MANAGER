# Documentation index

Newcomer order: this file → ARCHITECTURE.md → STRUCTURE.md → THREADING.md.

These are **living documents**: kept true, always. `tools/check-docs.mjs`
fails the build if a document is missing from this index, if this index names
a document that does not exist, or if the README's test count drifts from what
the suite declares.

## Doctrine — how the app is built

| File | What it answers |
|---|---|
| ARCHITECTURE.md | The layering, data flow, and extraction-first rules for the `main.js` composition root |
| STRUCTURE.md | The growth playbook: the physical map, CSS volumes and folder law, pinned not remembered |
| THREADING.md | Worker/app message contract, verbs, timeouts, degradation states |
| STATE-BOUNDARY.md | Worker ≠ app runtime state — the law against "helpfully" unifying them |
| SERVICE-WORKER.md | Why the worker owns the token; eviction behaviour; what breaks if it goes |

## The classifier

| File | What it answers |
|---|---|
| CLASSIFICATION_DATA_PACK.md | The single source the category rules are **generated** from. Never hand-edit the generated files |
| CLASSIFIER-CORRECTION.md | Retracted classifier claims and the verified rules that prevent their reintroduction |
| SEMESTER.md | The semester refresh: timetable + data-pack regeneration, with dates, owners and the accuracy gate |
| SOAK.md | The live-mailbox ritual — the one audit cap no gate can lift from the inside |

## Subsystems

| File | What it answers |
|---|---|
| TIMETABLE.md | Provenance and precedence of timetable truth |
| CYBERPUNK-AUDIO-STUDY.md | Public sound-design research translated into an original, asset-free UI synthesis grammar and safety limits |

## Records and direction

| File | What it answers |
|---|---|
| FINDINGS.md | **The finding-id ledger.** Every `AUD-*`, `EXT2-*`, `R3-*` and `ARCH-R2-*` id that a code comment cites, and what it meant. The audits that defined them are retired; the ids resolve here |
| NEXT.md | The long-term directions — M1–M5 with statuses, then the second-generation analysis (what to work on next) |
| UX-AUDIT-V4.md | The interaction-overhaul campaign (round 65) — plan, findings, per-round record |
| OVERHAUL-V3.md | The v3 overhaul plan and record — the redesign the current shell grew out of |

Audits live in [`../audits/`](../audits/). Most were retired once their
findings were fixed and pinned; the four that survive are reference material
that code cites by name, and the reasoning behind the retirement is in
[`../audits/README.md`](../audits/README.md).
