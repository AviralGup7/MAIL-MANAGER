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

**Status 2026-08-13.** Milestone 1 landed: `system/body-cache.js` keeps the
last 50 opened bodies (bounded twice — count and total chars; giants
refused) beside the header cache under its own storage key. The reader
remembers each painted body, falls back to the saved copy through the SAME
renderBodyInto pipeline (one sanitiser, two sources), and says so in an
app-chrome strip dated from the copy — "a copy must never masquerade as the
message." A certainly-offline browser (`navigator.onLine === false`, the
direction that never lies) short-circuits to the floor instead of spending
the 20s timeout. Sign-out drops the floor; resync keeps it (a body is
immutable and unreachable without its store record; clearing on resync
would discard exactly the copies that make a cursor-expiry week
survivable). Pins: `test/body-cache.test.mjs`.

**The claim.** This app graduates from "fast Gmail viewer" to "mail client"
the day reading and triage survive a dead network.

**Evidence.** `system/cache.js` persists headers-only by explicit design
("bodies…are far too large to cache" — a capacity argument from the 10MB
quota days, not a law). `features/outbox/model.js` already proves the queue-shaped
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
boot against the stub corpus (the render-bench fixture pattern). — The
reader half landed 2026-08-13 with M1: `reader/*` smoke gates open a
message, prove the live path wears no provenance strip, kill the worker
mid-flight, and assert the dated offline copy renders from the floor while
a never-opened message still errors honestly. Compose and cold-cache boot
remain. 18/18.

**The 50-point CI audit (2026-08-13/14): dispositions.** Most points
landed with the hardening commit and the reader-floor round; the second
pass (2026-08-14) closed the rest of the real gaps: no `npx` anywhere
(project-local `node_modules/.bin/playwright-core`), explicit
`cache-dependency-path`, the shard manifest written by the self-check and
uploaded `if: always()` (`.ci-manifest.json`), Playwright traces on smoke
failure (`.smoke-trace.zip`), a suite floor (≥90 files — guards
disappearance without pinning growth), Dependabot for actions+npm, and a
weekly `security.yml` audit that deliberately never gates pushes (a moving
advisory DB must not manufacture red builds). Deferred with reasons:

- **Browser-binary caching (#16).** `--with-deps` is apt-level and cannot
  be cached by actions/cache anyway; the residual win is one CDN download
  per run, and a mis-keyed cache ships a stale browser while claiming
  reproducibility. Revisit if install time is ever measured as the
  bottleneck.
- **Runtime-based shard rebalancing (#18) / fast-shard heuristics (#26).**
  Round-robin-by-count was chosen so the heavy integration suites sort
  apart deterministically; runtime rebalancing needs historical data the
  runner does not persist, and duration thresholds flap on shared runners.
  The manifests now record per-shard counts and each shard logs its
  duration — the evidence to revisit this exists the day it hurts.
- **A separately-gated "regression suite" (#28).** Nearly every test file
  here IS a regression pin citing a shipped bug; carving an identity out
  of the suite would duplicate runtime to relabel it. The skip-fails
  runner + floor guard the substance instead of the label.
- **Node × OS matrices.** The runtime users execute is Chromium, not
  Node; a second Node leg only re-proves test tooling, an OS leg would
  need the POSIX-pinned test paths rebuilt — real work buying zero
  user-visible signal. Single-node-20 stays; revisit if contributors on
  other versions actually break.
- **A coverage threshold.** node:test's coverage in v20 is experimental,
  and per-shard coverage would need merging machinery to mean anything;
  meanwhile a percentage gate measures the wrong thing here — nearly
  every pin names a shipped bug, while a line hit once and never asserted
  would count toward it. Visibility, if ever wanted: summary-only, never
  a threshold.

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

## M6 — A performance RATCHET, because a ceiling cannot see a trend

**Why.** `render:bench` is a hard CI gate with absolute ceilings
(5000ms page, 9000ms search). Five measured runs, oldest to newest:

| | run 1 | run 2 | run 3 | run 4 | run 5 | change |
|---|---|---|---|---|---|---|
| page render | 2602 | 2900 | 3435 | 3380 | 3910 ms | **+50%** |
| search keystroke | 4277 | 5040 | 6164 | 5869 | 6893 ms | **+61%** |

**Every one of those runs passed.** An absolute ceiling cannot tell
"slower runner today" from "we got slower", and the gap between the
tool's own defaults (2500/2500) and the CI ceilings is wide enough to
hide a doubling. Runner noise is real — ~17% between two consecutive
commits with no code change — so the answer is not a tighter constant;
an attempt to set 4600/8000 was reverted for leaving less headroom than
the noise, which reddens builds on luck and teaches people to re-run CI.

**Shape.** Persist the last N results (a committed JSON, or the
artifact API), compare each run against the trailing median rather than
a constant, and fail on a sustained step — e.g. median of the last 3
more than 20% above the median of the 3 before. Absolute ceilings stay
as the backstop.

**Blocked on.** Run-to-run history, which this workflow does not keep;
the shard manifest artifact is the nearest existing pattern.

**Not doing instead.** Tightening the constants. It converts a real
signal into flake, which is how a gate loses its authority.

### Deliberately not directions

Multi-account (audience of one institute address), framework/event-bus/
state-layer migrations (constraint ledger), px→rem sweeps, touch swipes
and a global redo (round-65 deferrals — the reasons still stand).

*When a milestone lands, move it from the ladder into the ✅ section with
its commit range; when a ladder empties, retire the direction the same way
the audits retired — the code is the record.*

---

## Generation 2 — the next five (2026-08-14)

M1–M5 have all touched ground (M2, M4, M5 landed; M1 and M3 each hold a
landed milestone with ladders open below). This is the re-analysis for
what comes after that foundation, weighted by the repo's own instruments:
audit 64's scorecard and merge-next list, the M-ladder remainders, and
what the newest gates just made visible. Ordered by leverage.

**G1 · The live soak — make "observed working" a ritual, not a landing.**
Audit 64's cap on nearly every 9 is the same sentence: *implemented +
unit-proven, never observed working* (F8). Its #2 merge-next is the
live-browser soak, and the M2 machinery that landed since (smoke gates,
render bench, traces) is exactly the instrumentation a soak needs — but
none of it has ever touched a live Gmail DOM. **Milestones:** (1)
`docs/SOAK.md` — the checklist as a ritual: consent screen, takeover on a
live Gmail page, a week of real deltas including the historyId cliff,
quota utilization after a week of body-floor caching, notification
click-through; (2) the NVDA/VoiceOver pass — A-A9's only verdict path;
(3) the service-worker "Status code: 2" mystery reproduced or retired,
and the `38b6a3a` probe branch given its verdict; (4) every finding
returns as a commit or a pin. **Feeds:** G4's accuracy measurement draws
its corpus from the same weeks.

**G2 · The storage seam moves to IndexedDB (audit TODO #4).**
`platform/storage.js` was designed for this swap ("one seam to swap"),
and M1 just made the arithmetic real: the body floor's 2MB charter beside
the header cache's 1MB inside a 10MB `chrome.storage.local` quota is a
budget that only downward pressure is currently managing. Audit 64 names
the same move as the one that unblocks windowing, deeper cache and
fuller offline *simultaneously*. **Milestones:** (1) backend adapter
behind the STORAGE proxy with byte-parity tests — consumers never learn;
(2) caches migrate with their VERSION disciplines, `chrome.storage` kept
as the fallback when IDB is absent; (3) list windowing behind the same
honesty invariant the audit demands (one render per settled state);
(4) M1's milestone 4 (pressure policy: eviction order, quota signals,
the `unlimitedStorage` decision) lands here, with the docs.

**G3 · Verb intents — triage survives a dead network (M1, milestone 3).**
The floor made *reading* local-first; triage still evaporates offline.
The queue-shaped primitive already exists and is battle-scarred:
outbox's hold window, cross-tab settle claim, `sending`→`failed` demotion
discipline. Archive/star/read/label become queued intents riding exactly
that pattern — not a framework (guardrail from M1 stands) — reconciling
on `online`. **Milestones:** (1) one verb end-to-end (archive — biggest
surface, no ambiguity); (2) undo window per intent, activity-log actor
`intent`; (3) conflict policy when truth moved while offline (the server
wins; the intent log says what it tried); (4) then the verb set widens
one at a time, each with its failure-injection test.

**G4 · The classifier learns from its users (M3, milestones 3–4).**
The moat is campus classification, and audit 13's honest sentence is that
its accuracy on real BITS mail is *unmeasured* — with the corpus-generating
fix already shipped: sender corrections in `rules.js`. Gaps that keep the
flywheel from turning: rule authoring is options-page-only (M3 milestone
3 wants it surfaced from settings General, grammar unchanged), accuracy
has no evaluation harness, and the data pack + timetable sources are
hand-refreshed (milestone 4's "calendar act, not a memory").
**Milestones:** (1) in-app rule editor from settings General, dry-run
inherited from M3; (2) an eval tool over harvested corrections +
`check-departments`, accuracy number printed in the soak report (G1);
(3) the semester refresh ritual documented with its owners and dates.

**G5 · Finish the inward doctrine (M4, milestone 3 + the M2 tail).**
Audit 64's one point between architecture and a 10 is "the last two or
three extractions landing without breaking the render invariant";
main.js is still 3,747 lines of composition. One cluster per round, each
carrying S2-grade proofs (unchanged behavior, moved pins, edge registry)
— slow on purpose, quota-free on purpose. Beside it, the M2 ladder tail:
compose (send → undo window visible) and one cold-cache boot gate, so the
browser-truth set watches the last two surfaces it doesn't.
**Guardrails are the M4 ones, unchanged.**

### Generation 2 · landed ledger (2026-08-14)

- **G1 m1 landed** — `docs/SOAK.md`: the pre-flight, the live boot, the
  quiet week (historyId cliff + sweep + snooze), the quota arithmetic, the
  NVDA pass checklist, the `38b6a3a` verdict path, the harvest discipline
  with SOAK-LOG. Open: m2–m4 need the live mailbox — *the one thing code
  cannot supply*.
- **G2 m1 landed** — `src/platform/idb.js`: the chrome-area-shaped
  IndexedDB adapter, parity-proven against the trusted fake (one contract
  suite, both backends), failure-named and self-healing on a transient
  wedge. A bright pin keeps every consumer out until m2's deliberate
  commit (the body floor is the planned first migrant, with
  chrome.storage reachable behind it).
- **G3 m1+m2 landed** — `src/app/mail/intents.js`: offline archive queues
  instead of rolling back (the queue toast carries the Undo; drain rides
  `online` + one boot pass; give-ups are toasts and activity lines, never
  silent; actor `intent` answers "who did this while I was offline";
  sign-out disarms). QUEUEABLE stays exactly `{'ARCHIVE'}` — widening is
  a deliberate commit each time, per the outbox's own history.
- **G4 m1+m2+m3 landed** — the in-app rules editor in settings General
  (grammar pin-verified against options.html; dry run over the LIVE
  store, not the header cache; saves refresh the shell's rule list the
  same instant; smoke gate drives test→add→remove), `tools/eval-classifier.mjs`
  (the accuracy number, INFRA-soft, ready for the soak corpus), and
  `docs/SEMESTER.md` (dates, owners, the department gate, the before/after
  accuracy bar).
- **G5 both gates landed** — `compose/send-holds-with-undo` +
  `compose/undo-recalls-the-draft` (22 smoke gates now, all riding the
  network-free preview) caught one real wart and fixed it: a recalled
  send used to keep counting down in the rail until the hold timer fired,
  so Undo now flushes through the existing seam. `boot/cold-cache-paints`
  reloads onto a dead-sync boot (stub `?nosync=1`, persistence via
  localStorage, preview-only) and demands the cached rows. **Plus the
  round's one M4 extraction:** the classifier's write side
  (`openRecategoriseMenu` + `reclassifyAll` + `countFromSenderIn`) joined
  the category-menu tenant, main.js at 3,729 lines with the doctrine pins
  moved into `test/recategorise.test.mjs` — and the extraction found the
  M3 auto-archive dry run counting an empty corpus (`ctx.store` was never
  wired); it counts for real now.

**Standing user-side blockers (no code can close these):** the PAT and
v1 OAuth secret rotations — audit 64 ranks them above *all code*, and the
PAT has now been pasted into this channel repeatedly — and a LICENSE
choice (F5), which is a legal decision, not a gate.
