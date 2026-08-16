# Audits

This directory once held a point-in-time audit per improvement wave — 01
through 58, plus four cross-audit consolidations, plus the 2026-08-15 cluster
of same-day system-wide passes. They were **working documents**: each drove a
round of fixes, and the fixes shipped.

They are not kept as trophies. An audit is retired once all three are true:

1. every finding is fixed, withdrawn with evidence, or carried forward into a
   document that *is* kept;
2. a test pins each fix, so the regression is caught by CI rather than by
   re-reading the audit;
3. the reasoning that mattered lives in a comment at the line it explains.

At that point the document costs attention and returns nothing — and git
history still has it, in full, for anyone who wants the narrative.

**Finding ids outlive their documents.** Around a hundred comments in `src/`,
`test/` and `tools/` cite an id like `AUD-C1`, `R3-02` or `EXT2-C2`. Those
resolve in [`../docs/FINDINGS.md`](../docs/FINDINGS.md), the canonical ledger,
which is why the documents that defined them could be retired without leaving
a single dangling citation.

---

## What is still here, and why

Four documents survive. Each is **reference material that code points at by
name** — not a fix list — and each would orphan a citation if deleted.

| File | Why it stays | Cited by |
|---|---|---|
| `08-GMAIL-COMPETITIVE-V2.md` | The specification home for deliberately **unbuilt** features. `settings.js` refuses to carry a schema entry for `autoSyncMinutes` precisely because it is only *specified here* — deleting this would orphan that reference and lose the spec. | `src/app/system/settings.js` |
| `ACCESSIBILITY-INPUT-ARCHITECTURE-AUDIT.md` | The input/focus/semantics reference: AX-tree-proven census, the focus/overlay/announcement maps. All confirmed defects fixed and pinned (A-A1 `bd5ee8c`, A-A2 `011c50b`, A-A3 `44cd0e2`, A-A6 `1f132a1`, A-A4/A-A7 `2304e5d`; A-A5 withdrawn as an erratum). **One open debt:** A-A9 — the body iframe's headless AX absence is control-proven a harness artifact, so a real NVDA/VoiceOver pass on real hardware is the only verdict path left. | `test/row-naming.test.mjs` |
| `RESPONSIVE-ADAPTIVE-ARCHITECTURE-AUDIT.md` | The adaptive-architecture reference: probe-measured breakpoint ladder and live-resize state evidence. All R-findings carry resolution commits (R-A1..R-A5 fixed, R-A6/R-A7 verified and closed). | `src/styles/54-responsive.css` |
| `ANIMATION-INTERACTION-AUDIT.md` | The motion overhaul's steering document and register: the measured census of the old stock, the surface→tier map, and the binding spring/depth/lighting vocabulary. **P1–P7 all shipped**, each commit-pinned. | `src/app/motion/tokens.js` |

## The bug hunts

| File | What it found |
|---|---|
| `2026-08-16-BUG-HUNT-ROUND-10.md` | Round-10 probe-driven hunt at `aec887c`, aimed at the code round 9's fixes had just changed plus the five modules named unexamined twice (`rule-engine`, `deadline-store`, `followups`, `timetable-mail`, `rules`). Load-bearing: `isAcademicSender` used a bare `includes`, so `evil@pilani.bits-pilani.ac.in.attacker.com` — a domain an attacker can buy — was accepted as institutional mail on the path that mutates the timetable (H-1); round 9's header folding had been applied to `Subject` only, leaving `To`/`Cc`/`Bcc`/`References` at 3,000+ octets against RFC 5322's 998, with `References` reachable by nothing more exotic than a long thread (H-2); and the grouped query parser reported `unparsed:false` unconditionally, so `a OR` and `((` showed the whole mailbox for a filter the app had not understood (H-3). The remediation note at the head of the file records the four findings that were **disproved** at HEAD, the `fmtTime` hole the new boundary tests found on their first run, and the two caps that turned out to evict the user's newest data rather than their oldest. |

Rounds 8 and 9 are retired: every finding is fixed or annotated in place, each
is pinned by a test, and the round-10 note above records what carried forward.
Their ids appear in code comments as `round 8, H-2` / `round 9, M-6` — the
round number *is* the citation, and the fix is described at the line.

---

The docs that govern how the app works today live in
[`../docs/`](../docs/). The finding-id ledger is
[`../docs/FINDINGS.md`](../docs/FINDINGS.md).
