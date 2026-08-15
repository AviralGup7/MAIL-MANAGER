# Reconciliation & Canonical Verdicts — 2026-08-15

Five audit reports, one tree (`ac0cbf2`, post-P0–P3). This document is not a
summary. It is the adjudication: every cross-report disagreement resolved
against the code, one canonical severity per finding, the root-cause graph
each report saw a slice of, and the implementation roadmap with the
fix / redesign / replace / leave-alone decision already made for you.

**The five witnesses**

| Report | File | Character | Headline verdict |
|---|---|---|---|
| Round 1 (morning) | `2026-08-15-SYSTEMWIDE-AUDIT.md` | Found the identity class (AUD-C1/C2); unremarked on cursor/outbound | drove P0–P3 |
| Post-P3 (branch) | `origin/audit/2026-08-15-post-p3` | Seam-walker; found H1/H2/H3 | — |
| Round 2 (R2) | `2026-08-15-SYSTEMWIDE-AUDIT-R2.md` | Found the forever-loop class at the new fences | R2-M1/M2/M3 |
| INDEPENDENT | `2026-08-15-INDEPENDENT-SYSTEMWIDE-AUDIT.md` | Deepest on cursor + outbound semantics; harshest rating (5.6) | AUD-I01..I05 |
| EXTERNAL | `2026-08-15-EXTERNAL-SYSTEMWIDE-AUDIT.md` | Broadest verification; found the enqueue/pump lost-update; most generous (8.2) | EXT-H1 |

**Adjudication method.** Where reports disagreed, the code was re-read at
the named seams (not either report): the boot chain `start()` →
`loadCache()` → `refresh()` → `send('SYNC_DELTA')`, the only three full-page
callers, `scheduleAutoRefresh`'s `document.hidden` pause, the worker pump's
snapshot saves, `fetchRetrying`'s method-agnostic retry, `buildMime`'s
header set, `ci.yml`, `tools/ci-test.mjs`, `tsconfig.json`, and a local run
of `tools/coverage-gate.mjs`. Verdict key: **UPHELD / AMENDED (severity
moved, evidence given) / DEMOTED / ERRATUM (a report's claim is wrong)
/ SUBSUMED (same root, merged ID)**.

---

## A. Executive verdict

Two findings redraw the risk map, and both come from the INDEPENDENT
report. They were missed — or actively acquitted — by every other pass,
including round 2's (the errata are owned in §F):

1. **The history cursor has two consumers and one of them never applies
   anything** (AUD-I01). The 15-minute sweep advances `historyId` and keeps
   only `bgNotifiedIds`; the app's boot is cache-hydrate + delta-only; the
   auto-refresh is delta-only and *pauses entirely in a hidden tab*; a full
   inbox page is pulled only on cold boot, cursor expiry, or mailbox
   switch. ⇒ Mail the sweep consumed never reaches the app — invisible,
   and unreachable even by pagination (`nextPageToken` is empty and
   Load-more disabled until a first page pull). **This is the modal
   usage pattern**: laptop open, browser running, Gmail tab in background.
2. **Every layer of the outbound path treats an uncertain send as a
   certainly-failed send** (AUD-I03 + AUD-I04 + AUD-I07 + EXT-H1). Four
   partial fences, and the gaps between them are where duplicates and
   silent losses live. None of the four fences alone is a bug; the class
   is systemic and only a single redesign retires it.

These are CRITICAL-class design defects in a mail client's two core
promises (you see all your mail; your sends happen exactly once). With them
confirmed, EXTERNAL's 8.2 is too generous and INDEPENDENT's 5.6 is too
punitive (its own E-section evidence reads 8–9 on security, UX, docs).
**Canonical composite: 7.3/10** — see §G.

Everything else across the five reports reconciles into the register in
§C. Total canonical open register: **2 CRITICAL, 5 HIGH, 11 MEDIUM,
10 LOW, 6 INFO**, mapped onto **8 root causes**.

---

## B. The disagreement ledger (all adjudications)

### B.1 CURSOR OWNERSHIP — the decisive split

| Claim | Source | Canonical verdict |
|---|---|---|
| Sweep advances the one cursor without durably applying changes → permanent loss | INDEPENDENT AUD-I01 (CRITICAL, CONFIRMED) | **UPHELD — CRITICAL / CONFIRMED (my boot-chain evidence, below)** |
| Sweep + app can advance cursor past unapplied delta on crash/commit boundary | INDEPENDENT AUD-I02 (CRITICAL, CONFIRMED) | **UPHELD — CRITICAL / CONFIRMED; the `epoch!=='stale'` discard and verb-timeout windows make it non-crash-rare, not just power-loss rare** |
| Sync/history is "exemplary… PASS, no new findings" (9/10) | EXTERNAL §F/§I | **ERRATUM.** The invariants they verified (cursor-before-list, drain-or-don't-move, ordered fate-map) are real — and answer a different question. Consumption-without-application sits one layer up, at consumer ownership. |
| Round-2 D-6 acquittal ("concurrent syncDelta sound") | R2 | **ERRATUM (self-reported).** Concurrency *between* the two consumers is safe; the defect is that one consumer *discards*. The acquittal answered the wrong question honestly. |
| Sweep comment: "the app still paints from its own cache + full sync when it opens" | `index.js` (round-1 era) | **FALSE COMMENT.** Boot with a warm cache paints cache + delta; "full sync when it opens" does not exist. This comment is what let every later pass (R1, R2, EXT) read the design as safe. Corrective comment or code change must land with the fix. |

Boot-chain evidence (all read this session): `start()` returns early
unless delta is `'none'` (main.js:3405); `refresh()` is delta-only for
inbox; `scheduleAutoRefresh` re-arms without calling `refresh()` when
`document.hidden`; `fetchPage('')` has exactly three callers (cold boot,
resync, none); `state.nextPageToken` is never populated on the warm path,
so pagination can't recover the omission either.

### B.2 OUTBOUND UNCERTAINTY — four fences, no yard

| Claim | Source | Verdict |
|---|---|---|
| Worker timeout replays the verb in-page → double-run | AUD2-H2 (HIGH) + AUD-I04 (CRITICAL) | **UPHELD, raised to CRITICAL.** Likelihood was the only thing holding it at HIGH; R2's own arithmetic (300 s budget ÷ ~30 s×3 per item ⇒ 8 items cross it) plus hydrate time makes the trigger routine on campus networks. Two witnesses + my per-link read. |
| Transport retries non-idempotent POSTs (send, draft-create) | AUD-I03 (CRITICAL/HIGH) | **UPHELD — CRITICAL / HIGH-conf.** `sendMessage` and `POST /drafts` ride `api()` → `fetchRetrying` (network/429/quota-403/5xx) plus the 401 renew-once replay. No anchoring header exists (`buildMime` sets In-Reply-To/References only). Accepted-then-lost is not sandbox-reproducible; mechanism is confirmed in code. |
| Crash-demoted `sending` → `failed(0, nextAttempt 0)` auto-retries | AUD-I07 (HIGH) | **UPHELD — HIGH / CONFIRMED.** `start()` calls `pumpOutbox()` at every boot; the retry fires with no user action. The outbox header's "visible and cancellable, never silently re-sent" became false when the pump became automatic (bug-hunt P1). Comment-law violation, second instance. |
| Worker pump's snapshot saves eat concurrent enqueues (and enqueue's snapshot can resurrect a sent row → duplicate) | EXT-H1 (HIGH) + EXT-M1 (MEDIUM) | **UPHELD — HIGH / CONFIRMED, both directions.** Between a pump's `loadOutbox` and its `saveOutbox(items)`, a tab's `saveOutbox([...queue, item])` lands — and the pump's next save drops it (loss); symmetrically, an enqueue that loaded a pre-removal snapshot writes a sent row back (duplicate). Two writers, one whole-blob key, no atomic RMW. EXT ran the repro; I re-derived both directions. |
| Ampliﬁer nobody reported | this document | **MI-1 (§E):** R2-M1/M2's 250 ms pump loop makes the enqueue-during-pump window *continuous* for affected users. The loop fixes and the atomic-RMW fix must not ship separately. |

### B.3 IDENTITY & RESIDENCY

| Claim | Source | Verdict |
|---|---|---|
| `dispatchable` fail-open + best-effort sign-in stamp → cross-account send residual | AUD2-H3 (HIGH) + AUD-I05 (CRITICAL) | **UPHELD at HIGH.** INDEPENDENT's CRITICAL declined on likelihood (needs a profile-fetch failure inside the sign-in window) — but its *fix* (stage → prove → activate) is adopted wholesale; see §D/§F. |
| Token committed before identity at interactive sign-in | AUD-I05 | **UPHELD as mechanism.** The stamp sits after `persist()`. The redesign makes the ordering transactional. |
| Worker-side tripwire while app closed → next sign-in flashes old cache | AUD-I06 (HIGH) | **AMENDED → MEDIUM.** Verified real but bounded: post-tripwire boot has no cursor (`historyId` cleared), so `refresh()` returns `'none'` → `resetView` + `clearCache` land within the same boot; the stale paint is a flash between sign-in click and delta answer, not a persisted state. |
| Account-scoped data under global keys; clear-on-transition fences | v3 NEW-3 / AUD-I12 / R2-J | **UPHELD MEDIUM** as a *model* finding; the instance with teeth is `snoozed` (R2-M3). Full namespacing is a migration, deferred to the IDB milestone (§F decisions). |
| `main.js` god module | AUD-I13 (LOW) / EXT-M4 (MEDIUM) / R2-N | **UPHELD MEDIUM** — raised because the RC-2 redesign must edit this file; its size is now a correctness risk, not aesthetics. |

### B.4 LOOPS, TAXONOMY, INFRA (fast table)

| Finding | Reports | Canonical |
|---|---|---|
| Foreign outbox rows: 250 ms eternal pump loop | R2-M1 only | **UPHELD MEDIUM-HIGH** |
| ≥8 foreign rows starve the 8-slot worker batch | R2-M2 only | **UPHELD MEDIUM-HIGH** |
| Unwakeable snooze row → perpetual ~5 s wake cadence | R2-M3 (EXT-L2 adjacency disagrees on severity) | **UPHELD MEDIUM.** EXT-L2's "right side of the tradeoff" is about modify/remove *ordering* — different question, also upheld. |
| `wrongAccount` receipt has no consumer | R2-L7 only | **UPHELD LOW** (fix rides the RC-4 pack) |
| diag counters regress across worker reincarnation | R2-L1 only | **UPHELD LOW** |
| String-matched error taxonomy | EXT-M2 only (R2-L2 is one instance) | **UPHELD MEDIUM**; R2-L2 **SUBSUMED** into it |
| Startup/alarm floating promises | AUD-I10 (MED) / R2-L6 (LOW) / EXT-L1 (LOW) | **UPHELD LOW.** INDEPENDENT's MEDIUM declined: reachable consequence is a missed re-arm only in crippled contexts; one-character-class fix regardless. |
| `npm test` OOM at 1400 MB; ci-test runs 3072 while its comment claims mirroring | AUD-I08 + EXT-H2 + v3 NEW-1 | **UPHELD MEDIUM** (infra, not product). The comment lie in ci-test.mjs:106 is a third comment-law instance — fixed in the same commit that raises the budget. |
| Coverage gate absent from CI and currently red (outbox 68% < 70%) | EXT-M3 + AUD-I09 | **UPHELD MEDIUM / CONFIRMED ×3** (my own run: `1 file(s) below floor`). |
| Types: strict:false, include = system/** + store.js | AUD-I11 | **UPHELD LOW** — LEAVE decision (§F); EXT's "would have caught nothing here" is accurate. |
| `to:` dead search vs stored To/Cc | AUD2-M2 | **UPHELD MEDIUM** (META_HEADERS evidence from R2 stands) |
| Fallback `labelName` never resolved | AUD2-H1 | **UPHELD HIGH** (second-witnessed in R2; not re-litigated by the two new reports) |
| BMM_SHOWN nonce (AUD2-L1) | post-p3 | **CLOSED as INFO** in R2 (source check exists); no new evidence. |
| PAT in chat | EXT-H3 / v3 NEW-6 / AUD2-P1 | **4th documented instance; process, can't be code-fixed. Reminder #14 issued.** |
| `idb.js` unconsumed (EXT-I1, AUD-N1), drafts scan (EXT-I3), entities subset (EXT-L3), hygiene files (EXT-I2) | various | **LEAVE / Q-ride** per §F |
| Overall rating | 5.6 vs 8.2 vs ~8.9(v3) | **Canonical 7.3** (§G) |

### B.5 Findings closed this reconciliation

AUD2-L1 (source check present), v3 NEW-5 (documented relaxation),
AUD-I15 (deps clean, confirmed twice more), EXT-L2 (ordering correct as
is), EXT-I1 (declared staging), AUD-I11→LEAVE, AUD-I08/EXT-H2→infra-M.

---

## C. Canonical findings register (the single source of truth now)

| Canon ID | Sev | Root cause | Merged IDs | One line | Evidence |
|---|---|---|---|---|---|
| CAN-C1 | **CRITICAL** | RC-1 | AUD-I01 | One cursor, two consumers; the sweep discards | main.js:3405 + index.js:623-699 + refresh delta-only + hidden-pause |
| CAN-C2 | **CRITICAL** | RC-1 | AUD-I02 | Cursor commits before durable apply; multiple discard windows | sync.js:128 before response; opEpoch 'stale' discard; verb timeout |
| CAN-C3 | **CRITICAL** | RC-2 | AUD-I04, AUD2-H2 | Timeout replay runs mutating verbs twice; worker pump is lock-free | main.js:419-443; index.js pump; flushOutbox demote |
| CAN-C4 | **CRITICAL** | RC-2 | AUD-I03 | Non-idempotent POSTs auto-retried at transport; no send anchor | gmail.js fetchRetrying + api 401-replay + sendMessage/saveDraft create |
| CAN-H1 | **HIGH** | RC-2 | EXT-H1, EXT-M1 | Outbox key: non-atomic RMW across 3 writer contexts → loss AND resurrection-duplicate | index.js snapshot saves vs compose.js:674 append |
| CAN-H2 | **HIGH** | RC-2 | AUD-I07 | Crash-demoted rows auto-retry; accepted-but-unrecorded duplicates | normaliseOutbox demote + dueItems + start()→pumpOutbox |
| CAN-H3 | **HIGH** | RC-3 | AUD-I05, AUD2-H3 | Identity fail-open edges: unordered sign-in, asymmetric dispatch | auth.js:231-243; outbox.js dispatchable |
| CAN-H4 | **HIGH** | RC-5-adj | AUD2-H1 | Fallback SYNC_PAGE never resolves labelName → snoozed paints INBOX | 0 tokens in fallback.js |
| CAN-H5 | **MEDIUM-HIGH** | RC-4 | R2-M1, R2-M2 | Foreign rows: eternal 250 ms loop; ≥8-row batch blockade | R2 repros |
| CAN-M1 | **MEDIUM** | RC-4 | R2-M3 | Unwakeable snooze rows: perpetual wake cadence + doomed modifies; cross-account via clear lists and backup:true | R2 repro; registry |
| CAN-M2 | **MEDIUM** | RC-3 | AUD-I06 | Post-tripwire sign-in paints a stale-cache flash | doSignIn→start() paint order |
| CAN-M3 | **MEDIUM** | RC-3 | AUD2-M1, v3 NEW-3, R2-J | Global-key account data; fence model is per-site manual | registry census |
| CAN-M4 | **MEDIUM** | RC-5 | EXT-M2, R2-L2 | String-typed cross-layer error taxonomy; a reword silently disarms safety branches | includes('ACCOUNT_CHANGED') etc. |
| CAN-M5 | **MEDIUM** | RC-6 | AUD-I08, EXT-H2, v3 NEW-1 | Local `npm test` red at declared heap; CI comment claims mirroring | ci-test.mjs:95,106 vs package.json |
| CAN-M6 | **MEDIUM** | RC-6 | EXT-M3, AUD-I09 | Coverage gate unenforced in CI and currently red (outbox 68/70) | my run of tools/coverage-gate.mjs |
| CAN-M7 | **MEDIUM** | RC-7 | EXT-M4, AUD-I13 | main.js god-module concentrates exactly the seams RC-2/RC-3 fixes must change | 3,842 LOC, 64 imports |
| CAN-M8 | **MEDIUM** | RC-Q | AUD2-M2 | `to:` returns nothing despite stored To/Cc; justification comment false (comment-law #4) | query.js:335-339 vs gmail.js:37,367-368 |
| CAN-M9 | **MEDIUM** | RC-4 | R2-L7 | Foreign-account queue state invisible to the user | grep: no consumer |
| CAN-L1 | LOW | RC-4 | R2-L1, AUD-I14(part) | diag overwrite-flush regresses; no outbound ledger | R2 repro |
| CAN-L2 | LOW | RC-3 | R2-L4 | sign-in stamp races sign-out → orphan identity | auth.js |
| CAN-L3 | LOW | RC-8g | R2-L6, AUD-I10, EXT-L1 | Floating promises: `.catch?.()` no-arg; onClicked; startup chain | index.js:715,742-757 |
| CAN-L4 | LOW | RC-2 | R2-L3 | `_fullError` stripped at save; short-circuit degrades across pumps | outbox.js |
| CAN-L5 | LOW | RC-5 | AUD2-L2 | Router fail-open on absent sender.id | index.js:205 |
| CAN-L6 | LOW | RC-Q | R2-L5 | activeAuthUser is last-boot, not last-active | main.js:267-273 |
| CAN-L7 | LOW | RC-Q | AUD-I11 | Types: strict:false, narrow include | tsconfig |
| CAN-I1..I6 | INFO | — | R2-Q1 bidi; EXT-L3 entities; EXT-I2 hygiene; EXT-I3 drafts scan; AUD2-I1/I2/I3 standing | | |

---

## D. The canonical root-cause graph

```
                        ┌───────────────────────────────────────────┐
                        │  THE TREE TRUSTS NEARBY TRUTH             │
                        │  (comments say it; pins pin the literal;  │
                        │   nobody pins the cross-context sequence) │
                        └───────────────┬───────────────────────────┘
            ┌───────────────────────────┼───────────────────────────────┐
            ▼                           ▼                               ▼
   RC-1 CURSOR OWNERSHIP       RC-2 OUTBOUND UNCERTAINTY        RC-5 STRING CONTRACTS
   cursor means "seen by       outcomes treated as certain;    includes()/regex dispatch
   someone", not "applied"     four partial fences, gaps       silently disarms fences
            │                   between them                             │
   ┌────────┴─────────┐   ┌─────┬──────┬──────┬────────┐                 │
   CAN-C1 (sweep       │   │     │      │      │        │        (amplifier for all
   discards)           │   C3   C4     H1     H2      L4         three branches: a
   CAN-C2 (commit      │   replay retry  lost-  crash-   error    reworded string kills
   before durable      │   C4/H2 share: no client-  update  demote  trunc.  the ACCOUNT_CHANGED
   apply)              │   stable send anchor              identity  teardown, the 404
            │          └───┬────────────────────────────────┘    class, honest-empty)
            │              │                                     
            ▼              ▼                                     
   Missing: one durable   Missing: one outbound LEDGER —         
   "applied-truth"        atomic mutation + uncertainty          
   journal (until IDB,    state + stable Message-ID anchor       
   use split cursors +    + replay policy.                       
   commit-after-apply)                                           
                                                                 
   RC-3 IDENTITY EDGES              RC-4 SCHEDULER BLINDNESS     
   proven on one path,              re-arm arithmetic can't see  
   assumed on neighbours            "never mine"/"never possible"
   ┌───┬────┬────┬───────┐          ┌──────┬──────┬──────┐       
   H3  M2   M3   L2      │          H5     M1     M9     │       
   │   │    │    │       │          │      │      │      │       
   └───┴────┴────┴───────┘          └──────┴──────┴──────┘       
   Fix: transactional sign-in;      Fix: account/terminal-aware  
   fail-closed quadrant; single     selection; retire; SURFACE.  
   ACCOUNT_SCOPED_KEYS fence.                                    
                                                                 
   RC-6 VERIFICATION DECAY    RC-7 CONCENTRATION    RC-8 PROCESS 
   green-CI ≠ true-locally    main.js hosts the     PAT ×4; rotate
   (M5,M6,L7)                 seams to change (M7)  (non-code)    
```

**Why five good audits saw five different trees:** round 1 verified
within-call invariants; EXT verified layer quality; v3 scored breadth;
post-p3 walked seams; R2 walked fence interactions; INDEPENDENT walked
*sequence-of-custody*. The CRITICALs live in custody, not in any call.
The comment-law violations (4 instances) are not trivia — they are the
mechanism by which later audits inherit false premises. Every false
comment is named so it dies with its fix's commit.

---

## E. Missed systemic interactions (new this document)

- **MI-1 — The loop feeds the race.** R2-M1/M2's pump cadence is the
  *window* EXT-H1's enqueue race needs: with a foreign row present, the
  pump is in-flight every 250 ms, so "enqueue during pump" stops being a
  coincidence. Ship order matters (§F).
- **MI-2 — The tripwire's blind boot.** CAN-C1 + CAN-M2 compound: after a
  worker-only account change, the next boot both flashes the stale cache
  (M2) AND starts a delta from a cursor the sweep advanced (C1). One
  "account generation" boot marker closes both — see §F, RC-3 gate.
- **MI-3 — The taxonomy is the joints.** RC-5 isn't one more LOW: every
  P0–P3 fence (ACCOUNT_CHANGED teardown, 404→tooOld, Could-not-create
  honest-empty, Gmail 4xx gone-forever) hangs on a string literal. A
  copy-edit anywhere upstream disarms a safety branch while everything
  stays green. This is why CAN-M4 is sequenced before, not after, the
  RC-2 rollout.
- **MI-4 — Automation broke a promise.** H2's "never silently re-sent"
  was true when retries were manual; the P1 worker pump made retries
  automatic and the comment survived its own repeal. Same class as the
  sweep's "full sync when it opens" and ci-test's "mirrors npm test":
  **automation changed the semantics; the sentence stayed.** Any future
  automation PR must cite which comments it retires.
- **MI-5 — The gate blocks its own cure.** CAN-M6's failing module is the
  exact file RC-2 must add branches to (outbox.js). Wiring the gate first
  would block the redesign; skipping it would bake in 68%. Hence the P0
  order: outbox branch tests → gate in CI → redesign lands *behind* the
  now-enforced gate.

---

## F. Decisions — fix / redesign / replace / leave alone

| Root cause | Decision | The chosen shape (and the rejected alternative) |
|---|---|---|
| RC-1 cursor | **REDESIGN (bounded), not the full journal yet** | (a) Sweep gets its OWN cursor `bgHistoryId`; it never touches `historyId` again (kills C1 with ~20 lines). (b) `syncDelta` returns `{delta, nextHistoryId}` uncommitted; the app applies, forces the cache write, then sends `SYNC_COMMIT(nextHistoryId)`; boot treats a cache older than cursor as proof-of-crash and resyncs (kills C2's windows). (c) Warm boot gains a page-1 reconcile of the inbox (belt; adds recovered even if a window evaded us). Full IDB journal/snapshot (INDEPENDENT's preferred) DEFERRED to the G2 milestone — right destination, wrong size for the first patch. |
| RC-2 outbound | **REDESIGN (one ledger), replacing four partial fences** | New `mutateOutbox(storage, fn)` (fresh read inside, conditional write) for ALL SEVEN writers — pump, enqueue, cancel, retryNow, flush claim paths (kills H1 both directions). Outbox row gains a stable client `Message-ID` (uuid per row, set by `buildMime`, survives retries). New state `uncertain` for crash-demotes and post-acceptance ambiguity: never auto-retried; reconciled by searching Sent for the anchor; user decides the rest (kills H2, and C4's dup channel). Transport: `fetchRetrying` takes `{idempotent:false}` for `/send`+`POST /drafts` — no auto-retry, no 401-replay for them (kills C4). Verb replay: a whitelist of replayable verbs in main.js `send()`; mutating verbs surface "worker slow — check Sent before retrying" (kills C3). |
| RC-3 identity | **FIX (transactional sign-in) + FENCE** | Sign-in becomes stage→prove→activate (fail closed; retry prompt on profile failure). Epoch re-check around the stamp (L2). `dispatchable`: stamped row + proven-stampless session ⇒ refuse (H3). Legacy unstamped rows: keep dispatching under an existing session identity (house rule honoured; the danger pair was stamped-row/stampless-session). New constant `ACCOUNT_SCOPED_KEYS` consulted by BOTH auth.js and endAccountSession; boot writes an `accountGeneration` marker and refuses warm-cache paint when it mismatches (MI-2). |
| RC-4 schedulers | **FIX pack** | `nextWakeIn(items, accountEmail)` skips non-dispatchable rows (loop dies); pump batch cap excludes refused rows (blockade dies); `wrongAccount` surfaces on the outbox rail with a per-row "cancel" (honesty); `wakeDue` retires a row on terminal 404/410 and after K failed wakes; a load-time janitor repairs/quarantines damaged rows (M1, and round-1's leftover). |
| RC-5 taxonomy | **REPLACE the mechanism** | `src/shared/errors.js`: closed code constants carried as `err.code`; migrate the five dispatch sites; string pins become back-compat shims; new pins assert codes. |
| RC-6 verification | **FIX + ENFORCE (in MI-5's order)** | outbox branch tests to ≥70 → wire `npm run coverage` into ci.yml gates → then land RC-2. Heap honesty: `npm test` raised to the CI-proven 3072 (not the reverse — evidence is 108/108 at 4 GB and OOM at 1.4); ci-test.mjs comment corrected; `app.integration.test.mjs` split into two files lands in the same phase, not "someday". |
| RC-7 main.js | **REDESIGN-lite (peel, don't split)** | Extract exactly two modules: `app/transport.js` (send/timeout/fallback — where RC-2's replay table lives) and `app/account-session.js` (tripwire/teardown/boot gate). The rest waits for real need. Big-bang split rejected. |
| RC-8 process | **Non-code** | PAT rotation #14; fine-grained + credential helper afterwards. Audit branches: merge the green post-p3 file; the independent-v3/file-on-this-branch set is now superseded by the uploads — close branches, keep files here. |
| Leaf items | **FIX (P1–P3)** or **LEAVE (recorded)** | LEAVE: `idb.js` staged, drafts scan (unmeasured), entities widen (Q), types widening (LOW value now — revisit after the RC-2/3 seams settle), AUD2-M3 login_hint (Q), LICENSE (owner's call), AUD2-L1 closed. FIX list in the roadmap. |

---

## G. Canonical rating

INDEPENDENT 5.6 / EXTERNAL 8.2 / v3 ~8.9 → **canonical 7.3/10**.

| Dimension | Canonical | Why |
|---|---|---|
| Security & privacy surface | 9 | Both hostile passes found nothing new; tripwire works as designed |
| Sync *mechanics* | 8 | The verified invariants stand; the ownership layer was the gap |
| **Data integrity (custody)** | **4** | CAN-C1/C2/H1: seen≠applied, written≠durable, queued≠safe |
| **Outbound guarantees** | **4** | CAN-C3/C4/H2: uncertainty handled as failure everywhere |
| Identity model | 8 | Fences in and proven; edges fail open |
| MV3 discipline | 8 | Alarms/catch-up/crash contracts good; floating promises + cadence loops dock it |
| Tests & CI | 6.5 | Suite is strong; the local baseline is red and a gate is unenforced |
| Observability | 6 | Counters exist but regress; no outbound ledger |
| Maintainability | 7 | Comments elite and mostly true — the four false ones were load-bearing |
| UX honesty | 7.5 | Best-in-class states — except the two places they can lie (up-to-date; queued) |

*Weighting: correctness-facing dimensions double-weighted; a mail client
cannot apologize for invisible mail or duplicate sends.*

---

## H. The roadmap (decision-complete)

**P0 — truth & safety (hours, no behavior change):**
1. Rotate the PAT (14th reminder).
2. Outbox branch-coverage tests → the repo's own gate goes green; wire
   `npm run coverage` into `ci.yml` (CAN-M6).
3. Heap honesty: `npm test` → 3072, correct ci-test.mjs's comment
   (CAN-M5); split `app.integration.test.mjs` (≤ two files).
4. Correct the three false comments now (sweep "full sync"; outbox
   "never silently re-sent"; query `to:`) — comments are contracts here.

**P1 — custody (the two CRITICAL pairs):**
5. RC-1: `bgHistoryId` split; uncommitted-delta + `SYNC_COMMIT` +
   crash-proof boot rule; warm-boot page-1 reconcile. *Pins: sweep never
   moves `historyId`; termination-injection at every await between fetch
   and commit replays; boot-after-sweep shows the swept mail.*
6. RC-2: `mutateOutbox` everywhere; `Message-ID` anchor + `uncertain`
   state + Sent-reconcile; transport idempotency flag; verb replay
   whitelist; transport peel from main.js lands here so the replay table
   has one home. *Pins: EXT's interleaving repro both directions;
   accepted-then-5xx fixture sends once; demote lands `uncertain`, never
   auto-retries; mutating verb timeout produces zero second effects; the
   RC-4 loop fixes (7) ride the SAME commit so MI-1 ships atomic.*
7. RC-4: account-aware `nextWakeIn`, batch cap excluding refusals,
   outbox rail `wrongAccount` surfacing + per-row cancel, snooze terminal
   retirement + load janitor.
8. CAN-H4 shared `labelName` resolver for worker+fallback (with the
   honest-empty law inside).

**P2 — contracts & fences:**
9. RC-3: stage→prove→activate sign-in; epoch-stamp; fail-closed
   `dispatchable` quadrant; `ACCOUNT_SCOPED_KEYS` single fence +
   `accountGeneration` boot marker (MI-2).
10. RC-5: `shared/errors.js` + five-site migration (CAN-M4); new code
    pins; CAN-L5 fail-closed.
11. CAN-M8: `to:`/`cc:` against stored headers (Sent finally works);
    v3 NEW-2's `anchorHistory` contract pin; CAN-L1 diag merge-flush +
    two outbox ledger counters (queued/sent/failed — would have made
    H1 visible in telemetry).
12. CAN-L3 `voidSafe` sweep; CAN-L4 persist an error-hash instead of
    the truncated-string identity.

**P3 — hygiene:** bidi scrub (R2-Q1), `activeAuthUser` rename/refresh
(CAN-L6), EXT-I2 file cleanup, `login_hint` (AUD2-M3), entity widen
(EXT-L3), LICENSE decision, branch merge/close.

**P4 — deferred largers (standing):** IDB milestones (body floor first;
sync journal when G2 lands), main.js further peels on evidence, drafts
`rfc822msgid:` when measured, types widening after the seams settle,
windowed list before any cap raise.

**Acceptance for the whole program:** the simulated close-app/sweep/boot
mail-visibility test passes with a killed worker at every await; the
outbound fixtures (accepted-lost, timeout, crash, concurrent enqueue)
produce exactly one externally-visible effect; every finding row in §C
carries a green pin; coverage gate enforced and green; local `npm test`
green on an 8 GB machine.

---

## I. What this reconciliation itself assumes

- AUD-I03's accepted-then-lost-response is mechanism-confirmed, not
  live-reproduced (no sandbox can); its CRITICAL rests on consequence +
  retry policy, both code-verified.
- Nothing was changed in production code; this document and the two
  archived reports are the commit.
- Gmail preserves client-set `Message-ID` through send (platform
  documentation; the reconcile pin will prove it against fixtures and,
  later, the staged soak).
- The boot-chain readings (B.2 evidence) were static but total: every
  caller of `fetchPage`, `loadPage`, `refresh`, `scheduleAutoRefresh`
  was enumerated, not sampled.

*The five reports disagreed; the code was the referee. This file is now
the register — amend findings by editing here, not by adventuring a sixth
audit.*
