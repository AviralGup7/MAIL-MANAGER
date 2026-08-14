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
| `RESPONSIVE-ADAPTIVE-ARCHITECTURE-AUDIT.md` | The adaptive-architecture reference: probe-measured breakpoint ladder and live-resize state evidence. All R-findings carry resolution commits (R-A1..R-A5 fixed, R-A6/R-A7 verified and closed). |
| `ACCESSIBILITY-INPUT-ARCHITECTURE-AUDIT.md` | The input/focus/semantics reference: AX-tree-proven census, the focus/overlay/announcement maps, and the ranked A-findings. All confirmed defects are fixed and pinned (A-A1 `bd5ee8c`, A-A2 `011c50b`, A-A3 `44cd0e2`, A-A6 `1f132a1`, A-A4/A-A7 `2304e5d`; A-A5 was withdrawn as an erratum). One debt remains: A-A9 — the body iframe's headless AX absence is control-proven a harness artifact, so a real NVDA/VoiceOver pass on real hardware is the only verdict path left. |
| `2026-08-15-SYSTEMWIDE-AUDIT.md` | The post-fuzz-sweep whole-system audit (2026-08-15): MV3 lifecycle, OAuth, sync, account isolation and storage economics verified against code at `2b82f0e`. Two CRITICAL findings (both the same root cause — the account is an assumption, not an identity): silent OAuth renewal follows the browser's current account with no profile validation (AUD-C1), and the outbox is neither account-scoped nor cleared at sign-out (AUD-C2). Phased roadmap P0–P3 inside; P0 is the only behavior change proposed. |
| `ANIMATION-INTERACTION-AUDIT.md` | The motion overhaul's steering document and register: the measured census of the old stock, the surface→tier map, the binding spring/depth/lighting vocabulary, and the milestone plan — **P1–P7 all shipped** (springs → microtier → camera/overlays → signature morphs → key light/particles/breath), each commit-pinned, 218 local contracts green, live CDP walk 9/9. Integration runs on CI. |

Everything else was deleted on 2026-08-13 as history that could be
reconstructed from git if ever needed. The docs that govern how the app
works today live in [`../docs/`](../docs/).
