# External System-Wide Audit — 2026-08-15 (independent pass)

Independent, evidence-driven audit of **BITS Mail Manager** at `ac0cbf2`
(`main`, clean tree, up to date with `origin/main`). Performed in a fresh
clone; no production file was modified. Prior audits in `audits/` were
treated as *hypotheses to re-verify*, never as evidence.

**Method.** Full-tree inventory → baseline test run → execution-path reading
of every backend module (worker, auth, gmail, sync, mime, outbox, snooze,
store, sanitize, storage seam, IDB adapter, fallback, takeover) → pattern
scans (DOM sinks, eval, timers in worker, empty catches, token logging,
storage keys) → targeted runtime reproductions for suspected races →
CI/tooling/gate verification. Every material claim below carries the file,
symbol, and where practical a reproduction.

**Baseline evidence**
- `node --test test/` (the repo's own `npm test` budget, 1400 MB heap):
  **1908 tests, 1907 pass, 1 fail** — the failure is
  `test/app.integration.test.mjs` dying with *JavaScript heap out of memory*
  (SIGABRT). With a 4096 MB heap the same file passes **108/108**. See EXT-H2.
- `npm run types` (checkJs contract surfaces): **clean**.
- `npm run bench`: classify 2000 ≈ 12 ms; store 2000 ≈ 33 ms;
  **renders triggered: 1**; 100 searches ≈ 20 ms.
- `npm run coverage`: **FAILS** — `src/app/compose/outbox.js` at 68 % branch
  against a 70 % floor. This gate is *not* wired into `.github/workflows/ci.yml`,
  so CI is green while the repo's own gate is red. See EXT-M3.
- `tools/check-docs.mjs`: 6/6 doc invariants hold.
- Static scans: zero `eval`/`new Function`/`document.write`; zero token
  logging; `innerHTML` = 5 write-sites, all with constant/own strings
  (verified individually); `setTimeout` in the worker only inside
  `auth.js`'s retry (which itself documents its unreliability and arms a
  `chrome.alarms` backstop — correct).

---

## A. Executive risk summary

This codebase is in unusually good health for its size (33 k LOC src,
417 files, 130 test files, 1908 tests, fuzz + mutation + a11y + contrast +
visual-regression + browser-smoke tooling, and an audit culture that writes
its findings into CI pins). The classic extension failure classes — XSS via
mail HTML, MV3 timer loss, header injection, account bleed-through,
history-cursor mail loss — have all been found *and closed* by prior
in-repo campaigns, each with a regression pin.

This pass **confirmed one new HIGH data-loss race**, one HIGH process/secrets
issue outside the code, and a handful of MEDIUM/LOW items:

| ID | Sev | Conf | One line |
|---|---|---|---|
| EXT-H1 | **HIGH** | **CONFIRMED (repro)** | Worker `OUTBOX_PUMP` saves a stale queue snapshot; a message enqueued by a tab during a pump is **silently deleted** — mail the user believes is queued never sends. |
| EXT-H2 | HIGH | CONFIRMED | `npm test` is red at its own declared heap budget (integration suite OOMs at 1400 MB); local baseline cannot go green. |
| EXT-H3 | **HIGH** | CONFIRMED | Live GitHub PAT pasted in chat (again — `DO-THIS-NOW.md` records two prior leaks). Process, not code, but it grants push to this repo. |
| EXT-M1 | MEDIUM | CONFIRMED | The outbox key has **no atomic read-modify-write** anywhere: `compose.js` enqueue is get-then-set racing the same key (same root cause as EXT-H1). |
| EXT-M2 | MEDIUM | HIGH | Cross-layer error taxonomy is string matching (`includes('ACCOUNT_CHANGED')`, `/Gmail 4\d\d/`, `includes('404')`, `/Could not create/`) — a reworded message silently disarms a safety branch. |
| EXT-M3 | MEDIUM | CONFIRMED | `coverage-gate` exists, currently fails, and is absent from CI — a gate with no teeth drifts red invisibly. |
| EXT-M4 | MEDIUM | HIGH | `src/app/main.js` is 3 842 lines with ~260 functions — the one genuine god module; most future-defect surface area lives here. |

Everything else found is LOW/INFO. Overall verdict: **8.2/10** (§ ratings).

---

## B. Architecture map (as verified from code, not docs)

```
Gmail tab
 └─ content script  src/takeover/content.js   (iframe mount/unmount only; no observers, no loops)
     └─ iframe app.html (extension origin, sandboxed reader iframe inside)
         └─ src/app/main.js (3.8k lines: boot, ctx wiring, verb transport)
             ├─ mail/store.js       incremental-index Map store, MAX 2000, one notify per batch
             ├─ system/cache.js     header cache, ONE storage key, cap 500, versioned
             ├─ system/body-cache.js offline body floor (LRU 50, bounded twice)
             ├─ compose/outbox.js   pure queue state machine + fallback flush (claims)
             ├─ classify/*          generated pattern rules from CLASSIFICATION_DATA_PACK.md
             ├─ core/sanitize.js    DOMParser allow-list walk, depth-bounded 1024, fail-closed
             └─ system/fallback.js  in-page verb router when the worker won't start
service worker  src/background/index.js  (thin router; alarms: wake, 15-min sweep, auth retry)
 ├─ auth.js   implicit flow, session-area token, sessionEpoch, account-identity tripwire
 ├─ gmail.js  fetchRetrying (Retry-After/backoff/jitter/AbortSignal), multipart batch, MIME build w/ header scrubbing
 ├─ sync.js   cursor-before-list, reduceHistory ordered-fate map, resync fallbacks
 └─ mime.js   body extraction (shared with fallback)
platform/storage.js  the single chrome.* seam (session-preferred token area)
platform/idb.js      AREA-contract IndexedDB adapter (built, deliberately unconsumed — G2 m1)
```

Dependency direction is clean: `classify/` and `shared/` are pure;
`app/` never imports worker modules except via the deliberate, documented
fallback dynamic import; the storage seam is the only chrome.* owner.
No import cycles found (the auth↔gmail cycle was explicitly avoided by
duplicating one profile GET — right call, documented at the site).

---

## C. Complete findings table

| ID | Sev | Conf | Category | Subsystem | Where |
|---|---|---|---|---|---|
| EXT-H1 | HIGH | CONFIRMED | Correctness / data loss | Outbox | `src/background/index.js` OUTBOX_PUMP |
| EXT-H2 | HIGH | CONFIRMED | Test infrastructure | Tests | `package.json` test script; `test/app.integration.test.mjs` |
| EXT-H3 | HIGH | CONFIRMED | Secrets / process | Repo ops | chat history; `DO-THIS-NOW.md` |
| EXT-M1 | MEDIUM | CONFIRMED | Concurrency | Outbox/storage | `src/app/compose/compose.js:674` |
| EXT-M2 | MEDIUM | HIGH | Maintainability / correctness | Cross-layer errors | many (see D2) |
| EXT-M3 | MEDIUM | CONFIRMED | Release engineering | CI | `tools/coverage-gate.mjs` vs `ci.yml` |
| EXT-M4 | MEDIUM | HIGH | Maintainability | App shell | `src/app/main.js` |
| EXT-L1 | LOW | CONFIRMED | Reliability | Worker alarms | `index.js scheduleBackgroundSync` `.catch?.()` |
| EXT-L2 | LOW | HIGH | UX correctness | Snooze | `index.js wakeDue` partial-failure order |
| EXT-L3 | LOW | CONFIRMED | Data fidelity | Ingestion | `gmail.js decodeEntities` fixed subset |
| EXT-L4 | LOW | HIGH | Storage | Single-key blobs | `cache.js`, `outbox.js`, `snooze.js` |
| EXT-I1 | INFO | CONFIRMED | Dead-by-design code | Platform | `platform/idb.js` (no consumer yet, declared) |
| EXT-I2 | INFO | CONFIRMED | Hygiene | Repo | `.census.mjs` at repo root; `tools/paste-into-devtools.js` |
| EXT-I3 | INFO | HIGH | Quota economics | Drafts | `getDraftForMessage` up to 20×500 pages per reply-open |
| EXT-I4 | INFO | CONFIRMED | Docs | Audits | prior audit docs partly describe superseded states |

---

## D. Critical correctness findings

### EXT-H1 — Worker OUTBOX_PUMP loses concurrently-enqueued mail (HIGH, CONFIRMED)

**Where.** `src/background/index.js`, `case 'OUTBOX_PUMP'`.

**The defect.** The pump loads the queue once into `items`, then between
sends performs `items = items.filter(...)` / `items.map(...)` on that
*snapshot* and writes it back with `saveOutbox(items)`. It re-reads live
storage (`const live = await loadOutbox(...)`) — but only to honour
*cancellations*. An item **added** to storage by a tab after the pump's
snapshot (compose enqueue writes `saveOutbox([...queue, item])`) is absent
from `items`, so the pump's next `saveOutbox(items)` **overwrites the queue
without it**. The message vanishes: no failure state, no toast, no activity
row — the user watched "Message queued" and it will never send.

**Reproduction (executed, minimal, against the real module):**

```
1. queue = [A(due)]                      → storage [A]
2. worker pump loads snapshot [A]
3. tab enqueues B (load→append→save)     → storage [A, B]
4. pump sends A, saves its snapshot minus A → storage []      ← B is gone
Result printed: "DEFECT CONFIRMED: enqueued item B was silently lost"
```

**Realistic trigger.** The window is the pump's Gmail round-trip
(200–600 ms per send, up to 8 sends per pump). A user sending two mails a
few seconds apart — the second enqueued while the first is dispatching —
is enough. The 15-min background sweep does not pump, but every tab's
250 ms re-arm timer makes pump-during-enqueue routine.

**Why the fallback path doesn't have it.** `outbox.js flushOutbox` (the
in-page path) already learned this lesson: its removal is a
read-modify-write against *fresh* storage with verification retries
(round 62, M3 comment). The worker path (bug-hunt P1) replaced the claim
discipline with single-flighting, which fixed *double-send* but
reintroduced *lost-update* on the other side of the same key.

**Blast radius.** Unsent mail with a false "queued" belief — the exact
failure class the outbox's own comments call "the worst failure mode of a
mail client" (they say it about double-send; silent non-send is its equal).

**Remediation (preferred).** In the worker pump, never save the snapshot:
every mutation should be `fresh = await loadOutbox(); write(f(fresh))`,
exactly as flushOutbox's removal already does — or better, extract one
`mutateOutbox(storage, fn)` helper and route *all seven* save sites in
both paths through it. Regression test: the reproduction above, plus a
property test interleaving enqueue/cancel/pump at every await boundary.

**Regression-test requirement.** Pin: "an item enqueued between a pump's
load and its save survives the pump." Currently no test covers it —
`outbox-crosstab` tests cover two *flushers*, not flusher-vs-enqueuer.

### D2 / EXT-M2 — String-typed error taxonomy (MEDIUM, systemic)

Safety-critical branches dispatch on message *text*:
- `index.js` router: `String(err.message).includes('ACCOUNT_CHANGED')`
- `main.js:433,483`: same string, two more sites
- `gmail.js history()`: `String(err).includes('404')` → `tooOld`
- `gmail.js hydrateDraftAttachments`: `/Gmail 4\d\d/` → "gone forever" class
- `index.js SYNC_PAGE`: `/Could not create/` → honest-empty vs real failure

Each works today because the producing site is nearby, but the contract is
invisible: a reworded error message compiles, passes type-check, and
silently turns "account changed → tear down session" into "generic error →
keep serving the wrong account's cache". The `AUD-C1` pin protects the one
literal it pins, not the pattern. **Direction:** a tiny closed error-code
module (`shared/errors.js`, codes as exported consts, `err.code` carried on
a subclass), consumed by every dispatch site; the pins then test codes.

---

## E. Security findings

**Overall: strong.** Verified directly, not from prior audit claims:

- **DOM sinks.** 5 `innerHTML` writes in `src/`: skeleton rows and row
  scaffold in `list.js` (constant strings), icon paths in `icons.js`
  (own constant table), `&times;` in `search-chips.js`, and
  `sanitize.js:197` *reading* `out.innerHTML`. Mail-derived text reaches the
  DOM via `textContent` everywhere sampled. No `eval`/`new Function`.
- **Sanitizer** (`core/sanitize.js`): real DOMParser parse-and-walk,
  element allow-list, per-element attribute allow-list, CSS property
  allow-list with `url()/expression()/@import/</\\` refusal, `cid:`
  resolution with URIError-safe decode, depth bound 1024 with fail-closed
  subtree drop, `data:image/svg+xml` explicitly refused, quote folding via
  native `<details>` (no script in sandbox). Reader iframe sandbox is
  `allow-popups allow-popups-to-escape-sandbox` — **no allow-scripts** —
  with a generated srcdoc CSP. Two independent layers, both real.
- **MIME/header injection**: `buildMime` scrubs *every* header at the last
  gate; address headers rebuilt from parsed tokens (not patched); subject
  cut at first line break; id-headers token-validated. The reasoning and
  the failed weaker fixes are documented at the site. Verified the
  attacker-controlled paths (Reply-To→To, inbound subject, forwarded
  filename, attachment mimeType→data URL) are each gated.
- **Token handling**: token only in worker/extension pages, never the
  Gmail document; session storage preferred; revocation on sign-out;
  sessionEpoch prevents the resurrect-after-signout race; renewal validates
  account identity before persisting (AUD-C1 implementation checked — the
  ACCOUNT_CHANGED path clears token, historyId, bgNotifiedIds,
  accountEmail, label cache, and the surface tears down once).
- **Router**: first-party-only sender check; unknown verbs answer a named
  error. CSP `script-src 'self'; object-src 'none'`, connect-src pinned to
  the two Google origins. `web_accessible_resources` = `app.html` only,
  matched to mail.google.com. Permissions are all used; no `tabs`
  permission (host-permission URL visibility used instead — least
  privilege done right).

**EXT-H3 (process).** A live `ghp_…` PAT for this repo was pasted into
chat to run this audit. `DO-THIS-NOW.md` already documents two prior PAT
leaks and a leaked OAuth client secret from v1. **Revoke this token at
github.com/settings/tokens today** and prefer a fine-grained token scoped
to this one repo for future pushes. No secret was found committed in the
current tree (git-history scan for `ghp_`/`client_secret` shows only the
guard tests and the hand-off doc that *refuses* to repeat them — good).

---

## F. Data-integrity findings

- **EXT-H1/EXT-M1** (above) are the material items: the outbox storage key
  has readers-writers in three contexts (worker pump, tab enqueue/cancel,
  fallback flush) and no atomic RMW primitive. The claim system exists but
  only the fallback path uses it.
- **EXT-L4.** The single-blob-per-key pattern (`msgCache`, `outbox`,
  `snoozed`) makes every write a whole-value write. That is the documented
  LevelDB-transaction tradeoff and fine at current sizes, but it is also
  what makes lost-update the *default* failure of any second writer.
  `mutateOutbox`-style helpers (or the IDB adapter with per-record keys)
  retire the class.
- **Store/index consistency** (`mail/store.js`): incremental index
  maintenance verified for add/update/delete/category-change paths;
  eviction at 2000 removes all secondary entries; `upsertBatch` is
  idempotent; one notify per settled batch (bench: renders triggered = 1).
  No divergence path found. Property/fuzz pins exist (`fuzz-ingest-boundary`,
  memory tests).
- **History semantics** (`sync.js`): cursor-taken-before-list (stale-not-new
  invariant, correct direction); `reduceHistory` folds chronological fate
  per message into disjoint add/remove (ordering subtlety documented and
  pinned); pagination fully drained or cursor untouched;
  `MAX_HISTORY_PAGES`/`MAX_DELTA_ADDS` both degrade to resync, never skip.
  Only the INBOX page anchors the cursor. This subsystem is exemplary.
- **EXT-L2.** `wakeDue`: `modify()` then `removeSnooze()` — if the modify
  succeeds and the storage remove fails, the next sweep re-applies
  `INBOX+UNREAD` to a message the user may have read in between (re-marked
  unread). Idempotent, no loss, minor annoyance. Inverting the order would
  instead risk a silently un-woken snooze — current order is the right
  side of the tradeoff; a "woken but unremoved" tombstone would close it.

---

## G. MV3 lifecycle findings

Verified against the code, all PASS:
- Listeners registered synchronously at module top level (action, commands,
  onMessage, onAlarm, onInstalled/onStartup, notifications).
- No timer in the worker carries durable work: snooze wake is a re-aimed
  single `chrome.alarms` alarm plus catch-up `wakeDue()` on both boot hooks
  ("late, never lost" — correct doctrine, stated and implemented).
- Auth retry: `setTimeout`+`online` are declared unreliable in-worker and a
  one-shot alarm (`AUTH_RETRY_ALARM`, 5 min, non-self-rearming) is the
  guaranteed channel. Same-name alarm collapse handles double-arming.
- The 15-min sweep is re-entry-guarded (`bgSyncRunning`) fixing the
  read-modify-write dedupe race (AUD-M3) — guard is per-worker-instance,
  which is the correct scope since alarms wake the same instance.
- Worker holds no message state; `historyId` in storage; label-id cache is
  the one in-memory cache and it is cleared on sign-out and ACCOUNT_CHANGED.
- `outboxPumping` single-flight flag dies with the worker — safe: a killed
  worker mid-pump leaves items in `sending`, which demote to visible
  `failed` on next load (crash contract implemented in `normaliseOutbox`).

**EXT-L1 (LOW).** `scheduleBackgroundSync`:
`chrome.alarms.create(...).catch?.()` — `.catch(undefined)` registers no
handler, so a rejecting create is an unhandled rejection (harmless noise,
but the guard is illusory). Same shape appears as `.catch?.(() => {})`
elsewhere, which *is* correct. One-character class of fix.

---

## H. Gmail/API findings

- Retry policy: bounded (3), exponential + jitter, honours `Retry-After`
  (numeric and date forms, 30 s cap), 429/5xx retryable, 403 split by body
  into quota-vs-scope (correct — the two 403s need opposite handling), 401
  passed to `api()` which owns renew-once, second 401 → canonical
  `AUTH_REVOKED`. Every fetch carries `AbortSignal.timeout(30s)`. This is a
  textbook-quality layer.
- Batch: 100-id cap enforced; `format=metadata` with explicit header
  allow-list (bandwidth-minimal); tolerant multipart parse with per-part
  failure isolation; **response-identity whitelist** (AUD-Q2) drops phantom
  ids before normalise; all-parts-dead throws rather than reading as empty
  inbox. Fuzz pins exist (`fuzz-parsebatch`, `fuzz-mime-parts`).
- `normalise` is a genuine trust boundary: type-coerced fields, non-finite
  epoch rejection at entry (`toEpoch`), headerMap total over malformed
  arrays. **EXT-L3 (LOW):** `decodeEntities` decodes a fixed named subset —
  numeric refs (`&#8217;` etc.) survive into snippets as literals.
  Cosmetic; snippet-only.
- **EXT-I3 (INFO).** `getDraftForMessage` linear-scans up to 10 000 drafts
  (20 pages × 500) per reply-to-draft open. Bounded and rare; a
  `q=rfc822msgid:` search or a draft-id cache would cut it, but evidence of
  actual pain is absent — leave until measured.

## I. Sync findings

Covered in §F (history). Additional checks: concurrent `SYNC_PAGE` calls
from two tabs both anchor-then-list — the cursor written twice is the
older/newer profile historyId, either of which only causes replay
(idempotent upserts), never skip; `syncDelta`'s cursor advances only after
every add was fetched. Resync loops are bounded by the app side
(cache kept on failure, honest freshness line). PASS with no new findings.

## J. Storage/EmailStore findings

Covered in §F. The storage seam (`platform/storage.js`) is a genuinely good
pattern: one chrome.* owner, live-binding proxy for test-harness swaps,
token area session-preferred with documented consent-flag exception.
`storage-registry.js`/`reset-registry.js` centralize key ownership.
**EXT-I1:** `platform/idb.js` is complete, contract-tested, and consumed by
nothing — deliberate (G2 m1) and honestly documented; keep, but its first
migrant (body floor) is where EXT-L4's whole-blob economics improve.

## K. UX/accessibility findings

- axe-core structural rules run in-suite (`a11y.test.mjs`, not skipped —
  verified `# skipped 0` in the run); contrast is a separate CI gate across
  six themes (WCAG AA, one AAA theme).
- Listbox semantics with `aria-activedescendant`, focus-restore tests,
  announce-semantics tests, reduced-motion honoured by *not creating*
  motion nodes; skeletons only on cold start; empty states are
  mailbox-specific; degraded/fallback mode announces once; outbox failure
  surfaces one toast per episode with retry quiet. Offline body copies are
  visibly dated ("a copy must never masquerade as the message").
- No new findings above LOW. The one systemic risk is EXT-M4: most UX
  wiring lives in `main.js`, where a 3.8 k-line module makes regression
  probability a function of file size.

## L. Performance findings

- Bench (this machine): classify 2000 ≈ 12 ms, store 2000 ≈ 33 ms,
  **1 render per settled batch**, 100 searches ≈ 20 ms. Render bench in CI
  with hard thresholds (infra failures soft, threshold failures hard —
  the right split).
- Store is incremental everywhere (no rebuild in hot paths), memoized
  derived reads, capped at 2000 in memory / 500 persisted / 50 bodies.
- **EXT-H2** is the one performance-adjacent defect: the integration suite
  peaks > 1.4 GB. That is a *test-harness* memory profile (jsdom documents
  accumulated across 108 tests in one process), not a product leak — the
  memory tests that exist target product structures and pass. But the
  default `npm test` fails on any 8 GB machine with the pinned budget.
  Fix: either raise the budget honestly, or split the file (it is 2×
  larger than the next test), or drop document references between tests.

## M. Test-quality findings

- 1908 tests / ~2063 `test(` declarations across 130 files; fuzz suites for
  every parser boundary; mutation tool (`tools/mutate.mjs`); worker
  contract harness executes the *real* `handle()` (`_testHandle`) under
  stubbed chrome — the "tests don't exercise production" trap is explicitly
  closed. CI shards 8-way, fails on skips, uploads shard manifests, and the
  verdict job reads real results (cancelled ≠ pass). This is well above
  typical rigor.
- Gaps: **(1)** no pin for EXT-H1's interleaving (enqueue-during-pump);
  **(2)** coverage gate not in CI and currently red (EXT-M3); **(3)** the
  OOM file makes the local suite red (EXT-H2), which trains exactly the
  "red builds nobody believes" reflex the security workflow's comments
  warn about.

## N. Maintainability findings

- **EXT-M4:** `src/app/main.js` (3 842 lines) concentrates boot, state,
  transport, degradation, account teardown, and ctx wiring. Everything else
  in the tree is modular; this is the file where two unrelated changes
  collide. Extraction seams already exist (ctx object, reset/storage
  registries) — peel transport (`send`/fallback/degrade) and account
  session lifecycle out first.
- **EXT-M2** (string errors) is the other systemic item.
- Comment density is extraordinary and — sampled against behavior —
  accurate. `check-docs.mjs` keeps the load-bearing docs true in CI. One
  stale-marker scan found effectively zero TODO/FIXME debt in src.
- checkJs typing covers contract surfaces only (deliberate, documented);
  widening to `background/` would have caught nothing this audit found —
  low priority.

## O. Release/migration findings

- CI: pinned action SHAs, least-privilege permissions, concurrency
  cancellation, 8-way shards, self-integrity check, docs gate, contrast
  gate, types gate, bench gate, browser smoke gates with failure evidence
  artifacts, generated-file drift gate. **EXT-M3:** wire
  `npm run coverage` in (and fix the outbox branch floor breach — which
  EXT-H1's regression tests will likely do for free).
- Versioned caches (`msgCache` v-checked, drop-on-mismatch = safe
  migration for recomputable state). No schema migration machinery exists
  because no non-recomputable local schema has changed yet — acceptable;
  the moment the IDB body floor lands, migration discipline becomes real
  (NEXT.md already says so).
- `npm audit` weekly + dependabot; devDeps only; zero runtime deps — the
  supply-chain surface is as small as the platform allows.

## P. Recovery and observability findings

- Recovery: everything except the outbox and snooze list is recomputable
  from Gmail; cursor expiry → clean resync; cache version mismatch → cold
  boot; corrupted outbox rows normalise to visible `failed`; account
  mismatch → full teardown with user-facing reason. Good.
- Observability: `diag.js` counters (requests, retries, notifications,
  renewals, mismatchClears) flushed on the sweep tick, with an honest
  declared loss window. This is new (AUD-Q1) and thin but correctly scoped.
  Missing: outbox drops/sends counters — EXT-H1 would have been *visible*
  in a `queued vs sent+failed+cancelled` ledger. Add two counters there.

## Q. Improvement opportunities not caused by current bugs

1. `shared/errors.js` closed error-code set (retires EXT-M2 class).
2. `mutateOutbox(storage, fn)` atomic helper; route all writers (retires
   EXT-H1/M1 class *structurally*, not just the found instance).
3. Outbox ledger counters in diag (observability for the queue).
4. Body floor onto `platform/idb.js` (already roadmapped G2 m2).
5. Numeric entity decode in `decodeEntities` (one regex).
6. Split `app.integration.test.mjs`; consider `--test-isolation=process`
   granularity to cap per-file heap.
7. `main.js` extraction: transport module + account-session module first.
8. `rfc822msgid:` search in `getDraftForMessage` (quota nicety).

## R. Recommended phased roadmap

- **Phase 0 (today, no code):** revoke the pasted PAT (EXT-H3).
- **Phase 1 (small, high value):** EXT-H1 fix + interleaving regression
  pin; EXT-M1 same-helper adoption at enqueue/cancel; outbox diag counters.
  One commit, one clear test.
- **Phase 2 (green baseline):** EXT-H2 (split/raise), wire coverage gate
  into CI (EXT-M3), fix outbox branch floor.
- **Phase 3 (structural):** `shared/errors.js` + migrate the five dispatch
  sites; `.catch?.()` sweep (EXT-L1).
- **Phase 4 (roadmap-aligned):** main.js extraction alongside already-planned
  G2 m2 IDB migration; decodeEntities widening rides along.

## S. Assumptions and unverified items

- Real-browser OAuth flows (implicit flow, prompt=none renewal, account
  switch) were **read and reasoned, not executed** — no Google account in
  this sandbox. The logic was verified statically plus via existing pins.
- `chrome.alarms` behavior (same-name collapse, ≥1-min granularity) taken
  from platform documentation, not observed.
- Multi-account concurrent *browser profiles* sharing one extension
  install: the design is single-account-with-tripwire; deliberate.
- Timetable/academic data-pack correctness (BITS-specific domain data) was
  spot-checked for shape only, not semantics.
- The render/browser-smoke gates were not run here (no preview build in
  sandbox); their CI wiring was verified instead.
- Visual regression baseline drift was not assessed.

---

# Ratings — each way scored 1–10

Scores are anchored to evidence above; a 10 is "nothing found and the
mechanisms that keep it that way are automated".

| # | Way | Score | Anchor |
|---|-----|:---:|---|
| 1 | Architecture & boundaries | **9** | One seam per concern, no cycles, dependency direction clean; −1 for the main.js concentration |
| 2 | Correctness & data integrity | **7.5** | Exemplary sync/store/ingest; one confirmed HIGH data-loss race (EXT-H1) is exactly the class the repo's own doctrine calls worst |
| 3 | Security (XSS, injection, token, permissions) | **9.5** | Two real layers on mail HTML, header scrubbing at the last gate, least-privilege manifest, epoch/identity auth discipline; nothing found by adversarial pass |
| 4 | MV3 lifecycle & service-worker discipline | **9** | Sync listener registration, alarms-only durability, crash contracts stated & implemented; −1 for `.catch?.()` slip and worker-instance-scoped guards being convention |
| 5 | Gmail API semantics & network discipline | **9** | Retry-After/backoff/jitter/abort budgets, batch identity whitelist, honest empty-vs-failed; −1 for drafts scan economics |
| 6 | Sync & history correctness | **9** | Cursor-before-list invariant, ordered fate reduction, drain-or-don't-move pagination; the strongest subsystem read |
| 7 | Storage architecture | **7.5** | Clean seam, versioned caches, honest quotas; whole-blob keys with no atomic RMW is the root cause of the one HIGH defect |
| 8 | Auth/OAuth | **8.5** | sessionEpoch, identity tripwire, revoked-vs-transient taxonomy, server-side revoke; implicit flow is a documented, defensible constraint — not free |
| 9 | UX & information architecture | **8.5** | Honest states everywhere (offline copy, degraded mode, freshness); cognitive walkthrough finds no false-success surfaces |
| 10 | Accessibility | **8.5** | axe in-suite, contrast gated in CI across themes, real listbox semantics, reduced-motion by omission; full screen-reader pass still TODO (their own #10) |
| 11 | Performance | **8.5** | Incremental everything, 1 render/batch measured, CI paint thresholds hard; test-harness OOM dents the evidence chain |
| 12 | Error handling & failure semantics | **7.5** | Failure classes deliberately separated at every layer read; but the *carrier* is string matching (EXT-M2) |
| 13 | Concurrency & races | **7** | Epochs, single-flights, claims, re-entry guards all present — and the one uncovered writer pair produced a confirmed silent-loss race |
| 14 | Test suite quality & determinism | **8.5** | 1908 tests, fuzz+mutation+contract-executing-real-handler, skip-proof CI; −: OOM red baseline, missing interleaving pin, coverage gate unenforced |
| 15 | Privacy & data minimization | **9** | Metadata-only sync, bounded body cache, account-scoped clears, no analytics, no third parties, notification text scrubbed |
| 16 | Release engineering & CI | **8** | Pinned SHAs, verdict job reads real results, evidence artifacts; coverage gate not wired and currently red |
| 17 | Maintainability & code quality | **7.5** | Zero dead-marker debt, generated rules with drift gates, accurate high-density comments; one 3.8 k-line god module |
| 18 | Documentation & knowledge transfer | **9.5** | Docs are load-bearing and CI-verified true; decision rationale is written where the code is; best-in-class |
| 19 | Observability & diagnostics | **7** | New counters are correctly scoped but thin; the queue — where the HIGH defect lives — has no ledger |
| 20 | Repo & process hygiene (incl. secrets) | **6.5** | Tree is clean and guarded by secret-shape tests; but this audit was *initiated with a live PAT pasted in chat*, the third such leak the repo itself documents |

## Comprehensive rating

Weighted toward correctness, security, and data integrity (the things a
mail client cannot apologize for):

> ### **8.2 / 10**

**What holds it at 8+:** security engineering and documentation that are
genuinely rare at any scale, a sync layer whose invariants are correct in
the hard direction, an MV3 discipline that treats worker death as the
default, and a test culture that executes real production handlers and
fuzzes its own trust boundaries.

**What keeps it under 9:** one confirmed silent-mail-loss race in the
subsystem whose own comments declare the highest stakes (EXT-H1 — small
fix, structural lesson: the outbox key needs an atomic mutation primitive,
not per-site care); a red local test baseline (EXT-H2); an unenforced,
currently-failing coverage gate (EXT-M3); an error taxonomy held together
by string literals (EXT-M2); and a process that keeps leaking live
credentials into chat (EXT-H3) — the only finding here that no code can fix.
