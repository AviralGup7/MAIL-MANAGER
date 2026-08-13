# NEXT — the five long-term directions

Status: **active roadmap** (opened 2026-08-13, after the settings-panel and
drawer-rail rounds). This is the steering document for "what to work on
next", in the same sense OVERHAUL-V3 steered the motion campaign: each
direction carries its evidence, its milestone ladder, and the guardrails it
may not cross. Landed milestones cite their commits in place.

How to read: directions are ordered by leverage, not by size. Every
milestone is independently shippable, locally target-testable, and pushed
the moment it lands — the crash-resilience rules apply to this document's
work the same as any other.

---

## M1 — The local-first data layer

**The claim.** This app graduates from "fast Gmail viewer" to "mail client"
the day reading and triage survive a dead network.

**Evidence.** `system/cache.js` persists headers-only by explicit design
("bodies…are far too large to cache" — a capacity argument from the 10MB
quota days, not a law). `compose/outbox.js` already proves the queue-shaped
primitive (hold window, settle claim across tabs, retry discipline). The
settings schema refuses to carry `autoSyncMinutes` because the sync epic is
*specified but unbuilt* (audit 08 remains the spec home for exactly this
reason). The offline banner exists and is documented as state, not event.

**Milestone ladder.**
1. **Body cache.** Persist opened message bodies (LRU, ~50) beside the
   header cache; reader falls back to the cached copy with an honest
   "offline copy" marker when the worker is unreachable. No verb queue yet.
2. **Read-through boot.** A cached snapshot paints before any network
   answer, with the delta landing as decoration, not content.
3. **Verb intents.** Archive/star/label/read become queued intents with the
   outbox's discipline, reconciliation on `online`.
4. **Storage pressure policy.** Eviction order, quota signals, and the
   moment `unlimitedStorage` is or is not re-requested — documented here.

**Guardrails.** No new state layer; the queue rides outbox's pattern, not a
framework. Sanitised-html persistence must reuse the reader-frame pipeline,
never a second serializer.

## M2 — Browser-truth gates in CI — ✅ LANDED

**Landed:** `tools/ci-smoke.mjs` + `ci.yml` "Browser smoke gates" step,
14/14 green locally on landing (commits `a2b…` series, 2026-08-13). Boot
renders, zero console errors, the drawer-never-self-opens gate, seam
crossings both ways, compose off the rail, settings one-tab-one-panel,
density/ambience live repaints.

**Why it came first.** Every other milestone here gets its regressions
caught by this gate; before it, they were caught by a human running a
`.probe*.mjs` by hand (the rail-overlap bug shipped that way).

**Remaining ladder.** Extend to the reader (open a message, remote-image
banner states), compose (send → undo window visible), and one cold-cache
boot against the stub corpus (the render-bench fixture pattern).

## M3 — Classification that acts

**Status 2026-08-13.** Milestone 1 turned out to pre-exist: per-category
auto-archive already acts at ingest (opt-in, unread arrivals only, logged
with actor 'rule', undoable). Milestone 2 landed against it —
`autoArchiveMatchSet` in `mail/rules.js` mirrors the ingest filter's three
terms in one exported place, and the category menu's ON flip is gated
through a confirmDialog that names the current match set and restates the
arrivals-only contract (pins: `test/rule-dryrun.test.mjs`). The OFF flip
stays one click. The "read AND older than N days" action below remains
the next safe action to add.

**The claim.** The campus classifier is the product's moat; today it only
*labels*. Rules should let it *move* — with dry-run trust first.

**Evidence.** `mail/rules.js` + the options-page editor + dry run exist.
The generated rule files are CI-pinned ("the first port silently lost 802
of 891 keys"). The For-you rail already ranks by classification.

**Milestone ladder.**
1. **One safe action, gated OFF by default.** New schema key (the panel
   will surface it — a schema entry is a promise, keep the doctrine).
   "Auto-archive when read AND older than N days", workerless, running at
   refresh time against the store.
2. **Dry-run report.** The exact match set, shown before the gate can be
   flipped — trust is a preview, not a promise.
3. **User-authored rules in-app.** The options editor's grammar, surfaced
   from settings General; the options page keeps rule *maintenance*.
4. **Semester refresh ritual.** `check-departments` + data-pack updates as
   a documented calendar event, not a memory.

**Guardrails.** No action without dry-run; no network mutation queued
behind "later"; every action writes an activity-log line.

## M4 — The doctrine, inward: shell cluster extraction

**The claim.** S1/S2 split the CSS monolith and the module flatland with
byte-parity proofs; the shell (`main.js`, ~28 wiring clusters) is the same
problem one level down. ARCHITECTURE.md's warning ("don't split to hit a
number") stays law — extraction happens by closure-autonomy, not by quota.

**Milestone ladder.**
1. **Census.** The 28 clusters, each rated by what it borrows from the
   shell (state closures, ctx pieces, nothing). Leaf-first ordering.
2. **Two leaf extractions.** Rail visibility (drawer manners; its pins
   move to the new module) and the root-attribute stampers
   (density/ambience/snippets — the `applyDensity` pattern as a module).
3. **The rest, slowly.** One cluster per round, each with the same proof
   obligations S2 carried: unchanged behavior, updated pins, updated edge
   registry.

**Guardrails.** main.js stays the composition root; ctx stays the only
wiring shape; an extraction that needs to import the shell back is
evidence against itself.

## M5 — Compiler-checked contracts — ✅ LANDED

**Landed:** `tsconfig.json` (allowJs+checkJs, noEmit, strict off) +
`src/globals.d.ts` + `npm run types` + CI gate; typedef drift repaired in
place (store `Msg`, `Theme`, the STORAGE proxy seam, outbox/backup/gmail
docs). 2026-08-13 commits.

**Remaining ladder.** Widen the include set one folder at a time
(`core` next — it's a leaf by doctrine), each widening is its own commit
with its found-drift recorded here. `strict` flips are a separate campaign
and are NOT implied by this one.

---

### Deliberately not directions

Multi-account (audience of one institute address), framework/event-bus/
state-layer migrations (constraint ledger), px→rem sweeps, touch swipes
and a global redo (round-65 deferrals — the reasons still stand).

*When a milestone lands, move it from the ladder into the ✅ section with
its commit range; when a ladder empties, retire the direction the same way
the audits retired — the code is the record.*
