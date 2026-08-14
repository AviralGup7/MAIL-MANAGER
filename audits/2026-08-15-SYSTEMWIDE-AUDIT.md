# System-Wide Audit — 2026-08-15

Whole-codebase, evidence-driven audit of BITS Mail Manager at `2b82f0e`
(post fuzz-sweep: 15 real defects #1–#19 family closed; CI run 31826181759
green, 8/8 shards + checks + Verdict).

**Method.** Ordered by the 50-section brief: repo baseline first, then every
production entry point, then each subsystem along real execution paths.
Claims were verified against code, with runtime reproductions where
practical (node one-liners against the real modules; no production file was
modified — this document is the only artifact this audit writes).
Comments and prior audits were treated as hypotheses, not evidence; where a
comment and the code disagreed, the code won and the discrepancy is listed.

**Scope.** `src/**` (33k LOC), `manifest.json`, `.github/workflows/*`,
`tools/*` gates, storage schema, and the parts of `test/**` that decide
whether the above is trusted. A just-completed fuzz campaign had already
swept classify, deadlines, search, backup, contacts, rules, snooze,
templates, deep-links, display, ingest boundary, MIME parts and the
sanitiser; this audit therefore spent its effort on the systems the
campaign did not touch: MV3 lifecycle, OAuth, sync, batching, account
isolation, storage economics, and cross-subsystem boundaries.

---

## A. Executive risk summary

The codebase is, overall, in the healthiest state this series of audits has
recorded: ingestion is total over hostile wire data, the render path is
textContent-based with an allow-list sanitiser and a sandboxed frame, the
outbox cannot double-send from two tabs, and every gate on CI is green.

Two findings outrank everything else, and they share one root cause —
**the account is an assumption, not an identity**:

| ID | Severity | Conf. | One line |
|---|---|---|---|
| AUD-C1 | **CRITICAL** | HIGH | A silent OAuth renewal follows whatever Google account is current in the browser; nothing validates post-renewal identity, so account B can be read/written with account A's history cursor, label ids and caches. |
| AUD-C2 | **CRITICAL** | CONFIRMED (by reading) | The outbox is neither account-scoped nor cleared at sign-out: a queued or failed send from account A can be dispatched under account B's token — sending A's drafted content *from* B's mailbox. |

Everything else is MEDIUM or below: three honest-error-surface gaps
(snooze mailbox offline reads as empty; notification-race duplicates;
renewal retry weaker than its own comment), two small sanitation gaps, and
a set of test-quality and roadmap items.

**Top of the roadmap (R):** persist account identity at interactive
sign-in, verify it after every silent renewal, and scope or clear the
outbox with the rest of the account state. Both fixes are small, localised,
and each has an obvious regression test.

---

## B. Architecture map (from code, not docs)

```
Gmail tab(s) ──content.js (takeover)──> iframe app.html (extension origin)
      │ BMM_TOGGLE / keydown                 │ POST verbs (runtime.sendMessage)
      │                                      ▼
      │                            src/background/index.js  (service worker)
      │                              ├─ auth.js   implicit-flow OAuth; token in
      │                              │            chrome.storage.session (local fallback)
      │                              ├─ sync.js   cursor pull: syncPage / syncDelta
      │                              ├─ gmail.js  REST layer; /batch multipart; retry+401
      │                              ├─ mime.js   payload → displayable body (pure)
      │                              ├─ notify.js notification selection (pure)
      │                              └─ alarms:   bmm-wake (snooze), bmm-sync (15 min)
      ▼
app (main.js shell) ── store.js (Map + indexes, notify-once batches)
   ├─ cache.js (500 newest headers, one blob, idle-deferred writes)
   ├─ body-cache.js (M1 body floor)
   ├─ settings.js (schema) → root-attrs.js → themes/shape
   ├─ outbox.js (held→sending→sent/failed; WORKER is sole dispatcher)
   ├─ intents.js (offline triage verbs; cleared at sign-out)
   ├─ backup.js (allow-list export; storage-registry.js is the key census)
   └─ fallback.js (in-page verb handler if the worker will not register)
```

Layering law (ARCH R-7) holds: all `chrome.*` access is greppable through
`src/platform/`; network only in `src/background/` + `fallback.js`; domain
modules (`classify/`, `outbox.js`, `rules.js`, `snooze.js`) are chrome-free
and run in both the worker and jsdom tests. The one deliberate exception is
`fallback.js`, which re-exposes worker verbs in-page when the worker cannot
register, trading background features for a non-bricked app (documented,
UI-flagged).

---

## C. Complete findings table

| ID | Sev | Conf | Category / subsystem | File:symbol | One line |
|---|---|---|---|---|---|
| AUD-C1 | CRITICAL | HIGH | Account isolation / OAuth | auth.js `renew()`, gmail.js `labelIdCache` | Silent renewal follows the browser's current account; no identity check |
| AUD-C2 | CRITICAL | CONFIRMED | Data integrity / compose | main.js:2190-2215, outbox.js | Outbox unscoped, uncleared at sign-out; cross-account send possible |
| AUD-M1 | MEDIUM | CONFIRMED | Sync contract | background/index.js `SYNC_PAGE` | Transient label-resolution errors return "empty mailbox" |
| AUD-M2 | MEDIUM | HIGH | Multi-account UX | background/index.js `openGmailTab` | Toolbar/notification click toggles the FIRST Gmail tab, any authuser |
| AUD-M3 | MEDIUM | HIGH | Concurrency / notify | background/index.js `backgroundSync` | Dedupe read-modify-write race → duplicate notifications |
| AUD-M4 | LOW→MED | CONFIRMED | MV3 lifecycle / auth | auth.js `scheduleRenewRetry` | Retry rides events workers never get + a timer suspension kills |
| AUD-L1 | LOW | CONFIRMED | Snooze | background/index.js `scheduleWake` | Non-finite `at` (legacy/corrupt) reaches `alarms.create(when:)` |
| AUD-L2 | LOW | CONFIRMED | Notify / sanitation | background/index.js `backgroundSync` | Sender scrubbed (#50), subject is not |
| AUD-L3 | LOW | MEDIUM | Content script | takeover/content.js | No DOM-level double-injection guard (race window only) |
| AUD-Q1 | INFO | — | Quota economics | gmail.js, sync.js | Per-run budget is reasonable but uninstrumented (see I / L) |
| AUD-Q2 | INFO | — | Parser hardening | gmail.js `parseBatch` | No request↔response id validation; boundary sniff is heuristic |
| AUD-T1 | INFO | — | Test quality | test/ | Gaps: account-switch, parseBatch fuzz, MV3 termination, notify race |
| AUD-N1 | INFO | — | Maintainability | src/platform/idb.js | Staged G2 adapter with no consumer yet (adoption decision pending) |

---

## D. Critical correctness findings

The correctness surface the fuzz campaign covered is closed (15 real
defects fixed with pins; totality at ingest, finiteness at the date
boundary, depth bounds in both tree walkers). The remaining correctness
risk is concentrated at **identity boundaries**, per AUD-C1/C2 in E/F.

**D-1 (verified clean):** the sync cursor cannot advance past unfetched
work — `syncPage` reads the anchor before listing, `syncDelta` writes it
only after every page is read and every add is batched, and both treat
overflow as `resync` (sync.js). Replays are idempotent by the store's
upsert. Failure at any await leaves the cursor stale, which loses nothing.

**D-2 (verified clean):** `reduceHistory` folds chronology into one
ordered Map so add/remove are disjoint by construction (sync.js:134-197),
and label transitions (TRASH/SPAM/INBOX gain/loss) are honoured, not just
messagesAdded/Deleted.

**D-3 (verified clean):** the store's ordered array survives date drift:
both `upsert` and `patch` re-position on changed dates (store.js), and the
binary-search insert cannot corrupt ordering after #19 made every ingest
date finite.

## E. Security findings

**E-1 (positive):** header injection at the wire is closed by reconstruction,
not patching — `safeAddressHeader`/`safeIdHeader`/`safeSubject` rebuild
headers from validated tokens (gmail.js:648-763). `buildMime` was re-read
line by line; no interpolation path bypasses the gate.

**E-2 (positive):** the sanitiser is a real parse-and-walk allow-list with a
sandboxed, `allow-scripts`-less iframe as the primary control; remote images
default off with a per-sender opt-in; `data:image/svg+xml` excluded; CSS
filtered to a property allow-list without `url()`. Depth-bounded as of #21.

**E-3 (positive):** token never enters a document that renders mail HTML in
the normal architecture; the fallback keeps it on the extension origin;
CSP `script-src 'self'`, no eval/Function anywhere in `src/`.
Message router refuses any sender whose id is not this extension
(index.js:202-207). Embed attack on the web-accessible app.html is answered
by a one-time handshake nonce (content.js:62-68).

**E-4 — AUD-C1 (the only security finding that matters):** OAuth at
`src/background/auth.js:300-330` renews silently with `prompt=none`,
which Google's side resolves against **the browser's current session** —
whoever that is this hour. Post-renewal there is no `profile()` call and no
comparison against any stored identity (verified: the only `emailAddress`
readers are main.js:3250-51, for display). Consequences on an account
change: A's `historyId` applied to B's history feed (wrong-mailbox deltas),
A's cached label ids used in B (cleared only on explicit SIGN_OUT,
index.js:216 / fallback.js:93), A's `bgNotifiedIds` dedupe against B's mail,
and — see AUD-C2 — A's queued sends dispatched with B's token.
_Blast radius:_ every multi-account Google user (the norm for the target
population: institute + personal accounts). _Trigger:_ changing the
default/active account in the browser, then any hourly renewal.
_Remediation (P0):_ persist `accountEmail` at interactive sign-in; after
every silent renewal call `profile()` once and compare; on mismatch, stop,
clear the account-scoped set (the same set sign-out clears, plus outbox),
and surface a re-auth. _Regression test:_ renewal returning a different
`emailAddress` must not advance `historyId`, must clear the label cache,
and must refuse OUTBOX_PUMP.

**E-5 (INFO):** `notifications` permission is used for at most 3
category-gated cards per 15-min run (notify.js) — the smallest surface
that justifies the permission. Keep.

## F. Data-integrity findings

**AUD-C2 (headlining this section):** sign-out hygiene (main.js:2190-2214)
clears `msgCache`, the body floor, `intents`, `historyId`, `bgNotifiedIds`
and all in-memory stores — but **not the outbox**. `outbox.js` exports no
clear verb and no account field exists on queue records. A `held` item
(8s window) or, realistically, a `failed`/`stuck` item (persists
indefinitely, retryable on demand) outlives the session; the next session's
pump (worker `OUTBOX_PUMP`) dispatches it with whatever `getToken()`
returns. With AUD-C1 providing an unsigned path to a different account,
this is a cross-account **send** — the worst integrity failure class for a
mail client; with only explicit sign-out/sign-in between two accounts it
still fires.
_Remediation (P0):_ clear the outbox alongside `clearIntents()` at
sign-out; add `accountEmail` to each record and refuse dispatch on
mismatch (belt and braces; the clear is the floor).
_Regression test:_ enqueue → sign out → sign in as other profile → pump →
nothing is sent and the queue is empty or refused.

**F-2 (positive):** store invariants — index add/remove are symmetric,
empty index sets are deleted, `threadOf` falls back to id, eviction pops
oldest, and batching is notify-once (store.js, re-read end to end).

**F-3 (MEDIUM, AUD-M1):** `SYNC_PAGE` with `labelName` (the snoozed
mailbox) catches **every** `ensureLabel` failure as "the label does not
exist yet → empty page" (index.js:223-231). Offline, 429s and 5xxs are
therefore indistinguishable from "no snoozed mail" to the app: the mailbox
reports `loaded` with `nextPageToken: ''`, and the freshness line claims
sync. Upsert semantics mean no rows are deleted — the damage is staleness
and a dishonest status surface, not data loss.
_Remediation (P1):_ catch only the 404/404-shaped failure as empty;
rethrow the rest so the app's existing error+retry surface owns it.
_Regression test:_ `ensureLabel` failing with a network error must surface
`{ ok:false }`, not an empty page.

## G. MV3 lifecycle findings

**G-1 (positive):** every durable timer is an alarm (`bmm-wake`, `bmm-sync`);
catch-up runs on both `onStartup` and `onInstalled`; the wake alarm is
re-aimed at the computed next snooze, never per-message; docs'
"alarms are the only timers that survive" claim is true of the runtime
(`setTimeout` appears only inside retry/backoff paths that may safely
die with the worker).

**G-2 (positive):** a killed worker mid-pump leaves a `sending` record that
demotes to `failed` on next load — visible, cancellable, never resent
(outbox.js, worker OUTBOX_PUMP documents it; parity.test pins the pump's
live-storage re-check).

**G-3 — AUD-M4 (LOW→MEDIUM):** `scheduleRenewRetry` (auth.js:376-385) arms
`addEventListener('online')` and a 60s `setTimeout`. Workers do not
receive `online` events, and the timer dies with the worker — so the
"retry when the network returns" half of the auth taxonomy's promise is
weaker than the comment claims. Real recovery arrives via the 15-minute
`bmm-sync` alarm or the next user action, so impact is bounded; the gap is
honesty between the comment and the platform.
_Remediation (P2):_ re-arm renewal from the alarm handler (one line) and
soften the comment.

**G-4 (positive):** module-load side effects in the worker are restricted
to listener registration; the MIME parser was deliberately split into a
listener-free module, which is what makes the in-page fallback safe.

**G-5 — AUD-L1 (LOW):** `scheduleWake` filters `typeof t === 'number'`
but not finiteness, so a legacy/corrupt `at` (NaN survives chrome.storage,
per the fuzz-#5 evidence) reaches `alarms.create({ when: NaN })` from the
SNOOZE handler tail — after the Gmail modify already succeeded — turning a
fine snooze into an error response. Same class the campaign fixed in the
readers; this writer was missed.
_Remediation (P1):_ `Number.isFinite` in the filter; one-line fix, one pin.
_Regression test:_ snooze map containing `{ at: NaN }` must not reject
SNOOZE.

## H. Gmail/API findings

**H-1 (positive):** retry policy honours `Retry-After` with bounds, jitters
parallel bursts, distinguishes quota-403 from scope-403, returns 401s to
the layer that owns renewal, and gives every fetch a 30s abort budget
(gmail.js:57-138). `api()` renews once and treats a renewed-401 as the
canonical revoked state.

**H-2 (positive):** history pagination drains fully with a 10-page/5000-
record ceiling and converts overflow to `resync`; the cursor/pagination
split is exactly right (the response's `historyId` semantics are handled
correctly).

**H-3 — AUD-Q2 (INFO):** `parseBatch` infers the boundary from the first
`--…` line and never validates that returned parts correspond to requested
ids (identity is carried in-band, and the store keys on it, so a wrong part
would still land under its true id — the exposure is limited to phantom
records if Gmail ever returned one). Multipart fuzz is a listed test gap
(AUD-T1).
_Remediation (P3):_ assert each part's `id` ∈ requested set before ingest.

**H-4 (positive):** drafts round-trip correctly (message-id → draft-id
lookup pages fully, capped at 20 pages), attachment bytes hydrate at the
wire with per-item failure classification, and bulk actions chunk at
Gmail's 1000-id limit with per-chunk reconciliation.

## I. Sync findings

Covered in D-1/D-2/F-3 plus: `backgroundSync` (15-min alarm) and an
app-triggered `SYNC_DELTA` can overlap. Both converge on the same
`setHistoryId`, so the cursor is safe (idempotent), but
`bgNotifiedIds` is a read-modify-write outside any lock: two overlapping
runs can read the same list and each notify the same fresh ids —
**AUD-M3**, a duplicate-notification race.
_Blast radius:_ cosmetic; bounded by `NOTIFY_BURST_CAP` (3).
_Remediation (P1):_ single-flight `backgroundSync` in the worker (the same
`outboxPumping` pattern), which also bounds notification spend.
_Regression test:_ two concurrent sweeps over one delta notify ≤ once
per id.

**I-1 (positive):** the inbox gate on history anchoring (`anchorHistory:
id === 'inbox'`) is present and correct — non-inbox mailboxes cannot move
the cursor.

## J. Storage / EmailStore findings

**J-1 (positive):** the storage census is executable — `storage-registry.js`
is the single table of every key, swept by a test that fails on unlisted
KEY literals; backup export derives from it (`BACKUP_KEYS`), so the
fictional-key failure class cannot recur. `NEVER_EXPORT` correctly
contains every credential and cache, and export is allow-listed.

**J-2 (positive):** cache rows are versioned, corrupt rows skip
individually, dates must be finite at hydrate, one blob is written at most
once per idle period, `flush()` is pagehide-safe, and `invalidate()`
prevents post-clear resurrection (cache.js — re-read fully).

**J-3 (INFO, AUD-N1-adjacent):** the 500-header cache + 2000-message store
cap + 10MB quota leaves ~9MB headroom; windowing beyond CACHE_MAX is the
documented indexDB milestone (idb.js). No action needed at current scale;
the decision belongs to the windowing milestone.

**J-4 (INFO):** the snoozed map is deliberately not cleared at sign-out —
wake attempts under another account 404 harmlessly and the entries are
correct when the owner returns. With AUD-C1's identity check, this needs a
one-line `#` comment that it is intentional, nothing more.

## K. UX / accessibility findings

**K-1 (positive):** the a11y expectation set is executable
(`test/a11y.test.mjs`, axe, contrast gate across all themes incl. forced
`High Contrast`; reduced-motion covered by CSS law + tests). The one
documented debt — real-screen-reader verification of the body iframe —
remains correctly open (A-A9) and is a harness limitation, not a defect.

**K-2 — AUD-M2 (MEDIUM):** `openGmailTab()` focuses the **first**
mail.google.com tab regardless of authuser index; the takeover then mounts
inside whichever account that tab belongs to while OAuth/data follow the
signed-in account. The deep-link layer is u/N-aware (content.js passes
`accountIndex()`) but the orchestration layer is not. Wrong-account takeovers
present as "my mail is wrong", not an error.
_Remediation (P2):_ prefer the tab whose `u/N` matches the app session's
known index; deep-link the account chooser when none matches.
_Regression test:_ with synthetic tabs u/0 and u/1, the toggle lands in the
matching tab.

**K-3 — AUD-L2 (LOW):** notification cards scrub the sender but not the
subject (control chars/5000-char subjects land in the card); mirror the
subject with the #50 treatment.

## L. Performance findings

**L-1 (positive):** the render/bench numbers are hard CI gates, the sweep
re-verified store incremental indexing, memoised derived reads, incremental
list DOM updates, one-batch-per-sync-page network shape (list + batch =
2 round trips/page). Fuzz #12 removed the quadratic address parsing at
ingest with wall-clock pins.

**L-2 (INFO, AUD-Q1):** quota economics per steady-state open: ~5 units
list + ~5×N/100 batch + ~5 profile anchor; the 15-min background delta
adds ~25/hour idle. `deepScanMessages` fetches bodies for academic
candidates at ingest (bounded by the cheap pre-scan; worth a counter when
instrumentation lands in P3). No hot path was found doing full-store
rescans; the O(n) walks that remain are memoised per `_version`.

**L-3 (positive):** background CPU idle cost is two alarms and two capture
listeners; idle app cost is the deferred cache saver only.

## M. Test-quality findings

**M-1 (positive):** 1,842 declared tests, CI refuses skips, jsdom absence
fails the build in every shard, the doc/truth gates recompute README's
stated counts, and source-scan pins are now amended with dated why-notes
(the two that drifted during the fuzz campaign were healed in this
session, e04509e/2b82f0e).

**M-2 — AUD-T1 (gaps, ranked by production risk):**
1. **Account-switch coverage is absent** — the scenario behind AUD-C1/C2
   has no test at any level. First-class gap; P0 with the fix.
2. **parseBatch fuzz** (malformed parts, boundary-in-content, mixed 2xx/5xx
   pages) — parser is tolerant but unpinned against its adversarial input
   class. P2.
3. **MV3 termination/restart** — covered by seams and the sw-probe tool,
   but no automated "worker dies between awaits" test exists (hard;
   keep on the SOAK menu, do not fake it in unit tests).
4. **Notify dedupe race** (AUD-M3) — needs the single-flight first.
5. Wall-clock determinism audit: the two remaining time-sensitive suites
   (render-bench, fuzz wall-clock budgets) are CI-tolerated by design;
   no fixed-sleep synchronization found in tests.

## N. Maintainability findings

**N-1 (INFO):** `src/app/main.js` is 3,752 lines — still the largest
fan-in node by design (the shell). The constraint set forbids a redesign;
the standing mitigation (wiring stays thin, domain logic keeps moving to
small modules) is visible in the git history. Watch item, not a defect.

**N-2 — AUD-N1 (INFO):** `src/platform/idb.js` is a fully tested adapter
with zero production callers — landed for the G2 windowing milestone. The
inventory question is settled (tested, documented); the open decision is
adoption timing. Accepted as staged infrastructure; flag in the G2 review.

**N-3 (positive):** zero `eval`/Function, zero console.log in src, no dead
files found (every src file is reachable from an entry point or a test
seam), package.json and manifest versions agree (2.0.0), dependencies are
dev-only with dependabot on. One stale-comment class found and noted: none
materially contradictory (spot-checked the highest-traffic claims:
SERVICE-WORKER's timer claim, cache's field table, outbox's state machine).

**N-4 (INFO):** `workbox`-style none; zero runtime dependencies — the
supply-chain surface is the dev toolchain only, audited weekly off the
push path by `security.yml`.

## O. Release / migration findings

**O-1 (positive):** backup format is versioned with strict refusal;
`msgCache` is versioned with discard-on-mismatch; settings have typed
defaults with rollback-on-failed-write; the pinned extension `key` keeps
the identity stable across releases (redirect URI constant) — the OAuth
setup doc's core promise holds.

**O-2 (INFO):** no data migration machinery exists because no schema has
needed one; the widened packed-row trick (cache v1 rows widening by index
with self-correction) is the established pattern for compatible changes.
Bump-and-discard is the documented plan for incompatible ones. Sound.

## P. Recovery & observability findings

**P-1 (positive):** corruption degrades up, not down (cache → cold start;
outbox `sending` → visible failed; batch zero-hydrate → error, not empty;
label race → re-list). `doctor.mjs`, `sw-probe/`, startup self-check and
the badge-on-injection-failure are real, exercised diagnostics.

**P-2 (gap, AUD-Q1):** there is no request/quota/notify counter anywhere;
the roadmap's instrumentation milestone remains the way to see retry
storms, quota exhaustion and duplicate-notification rates. P3, small.

## Q. Improvement opportunities (not caused by current bugs)

1. **Persist and verify account identity** (AUD-C1 fix) — also unlocks
   first-class multi-account support later.
2. **Account-scoped outbox** records (key + per-record email).
3. **Request id validation in parseBatch** + adversarial fixtures.
4. **Single-flight backgroundSync** + counter instrumentation.
5. **Honest SYNC_PAGE labelName errors** (M1) — also simplifies mental
   model ("empty means empty").
6. **Tab selection by authuser** for toolbar/notification opens.
7. **Subject scrub parity** for notification cards.
8. **idb.js adoption decision** at the windowing milestone review.

## R. Recommended phased roadmap

**P0 — identity (this week, small):**
- signIn persists `accountEmail`; silent `renew()` validates `profile()`
  after minting; mismatch → clear account-scoped state (sign-out's set +
  outbox) and force interactive re-auth. *Acceptance:* AUD-C1 regression
  test green; no historyId/label/outbox ops across a mismatched renewal.
- Outbox cleared at sign-out (beside `clearIntents()`). *Acceptance:*
  AUD-C2 regression test green.

**P1 — honest failures (next):**
- M1 (labelName errors), M3 (backgroundSync single-flight), L1 (finite
  alarm `when`), L2 (subject scrub). Each has a named one-pin regression
  test above.

**P2 — coverage:**
- Account-switch test suite (unit + integration); parseBatch adversarial
  fixtures; renewal re-arm via alarm (M4).

**P3 — economics & scale:**
- Instrumentation (request/quota/notify counters), idb adoption decision,
  M2 tab selection by authuser.

## S. Assumptions and unverified items

1. **AUD-C1 is verified by code reading, not by end-to-end replay** —
   Google's silent-renewal account selection cannot be exercised from this
   sandbox (needs two live Google sessions). Confidence HIGH because every
   compensating control was searched for and found absent; the e2e replay
   is a P0 acceptance step on real hardware.
2. `chrome.storage` NaN/Infinity fidelity is taken from the fuzz campaign's
   recorded measurements (AUD-L1 path); not re-measured here.
3. Notification card rendering of control characters in `message`
   (AUD-L2) was not reproduced against a live Chrome; severity kept LOW.
4. The snooze map's cross-account 404 noise (J-4) is reasoned, not
   observed; harmless either way.
5. The app-side behaviour on **Gmail-side label deletion** of the snooze
   label between syncs was not exercised; `ensureLabel`'s re-list fallback
   covers create-races, and stale label ids 404 per-message (absorbed).
6. Performance numbers quoted are the repo's own pinned benches
   (README:231-233); hardware here cannot reproduce the render gate.
7. The audit did not re-run the full local suite (campaign-verified minutes
   before it started, CI green at HEAD); bounded imports of every module
   under audit were executed for the verification greps/reproductions.

---

*Preserved in Git per the audit's own rule: report first, then any
long-running work. P0 items above are the only behavior changes this audit
recommends; everything else is test, comment, or roadmap.*
