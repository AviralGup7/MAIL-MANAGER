# Audits

This directory once held a point-in-time audit per improvement wave — 01
through 58, plus four cross-audit consolidations. They were working
documents: each drove a round of fixes, and the fixes shipped. Their lasting
content lives in the code (every rule cites its round) and in the tests that
pin it; the documents themselves were retired when keeping them started
costing more attention than they returned (round 65 cleanup).

Two audits survive, because each is still load-bearing:

| File | Why it stays |
|---|---|
| `08-GMAIL-COMPETITIVE-V2.md` | The specification home for deliberately unbuilt features. `src/app/settings.js` refuses to carry a schema entry for `autoSyncMinutes` precisely because it is only *specified here* — deleting this file would orphan that reference and lose the spec. |
| `64-COMPREHENSIVE-RATING-V2.md` | The most recent whole-app rating. It is the baseline the round-65 interaction campaign (`docs/UX-AUDIT-V4.md`) measures itself against — the "before" in the before/after. |
| `RESPONSIVE-ADAPTIVE-ARCHITECTURE-AUDIT.md` | The current adaptive-architecture reference: probe-measured breakpoint ladder, live-resize state evidence, and one open CRITICAL (R-A1: reader = 0px wide when the rail drawer is open below 600px). |

Everything else was deleted on 2026-08-13 as history that could be
reconstructed from git if ever needed. The docs that govern how the app
works today live in [`../docs/`](../docs/).
