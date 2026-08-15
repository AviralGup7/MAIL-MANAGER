# System-Wide Audit — 2026-08-15 (post-P3)

Whole-codebase, evidence-driven audit of BITS Mail Manager at `ac0cbf2`
(`main`, clean, in sync with `origin/main`). This is the audit *after*
the morning's P0–P3 landings (`35d8d3d` … `ac0cbf2`), not a re-print of
`audits/2026-08-15-SYSTEMWIDE-AUDIT.md`.

**Method.** The 50-section brief was executed in order: repository
baseline first, then every production entry point, then each subsystem
along real execution paths. Prior audits, comments, and the
implementation plan were treated as hypotheses. Where a comment and the
code disagreed, the code won and the discrepancy is a finding. Claims
were verified against the current tree; two residual holes were
reproduced with a Node one-liner against the live modules. Production
files were not modified — this document is the only artifact this audit
writes.

**What was actually run.**

- `git status` / `git log` / remotes: `main` @ `ac0cbf2`, clean, not
  diverged.
- Targeted suite: `account-identity`, `auth`, `sync`, `gmail`, `store`,
  `outbox`, `audit-hardening` → **204/204 pass, 0 skipped, 2.0s**.
- Static census: 33,948 lines of `src/**/*.js`; **1,890 declared tests**
  across 128 files (matches README).
- Reproductions (live imports, not mocks of the functions under test):
  - `dispatchable({accountEmail:'a@bits.example'}, '') === true`
  - `fallback.js` contains **zero** mentions of `labelName`; the worker
    resolves `opts.labelName` via `ensureLabel`.

**Scope.** `src/**`, `manifest.json`, `.github/workflows/*`, `tools/*`
gates, storage schema, and the parts of `test/**` that decide whether
the above is trusted. The morning P0–P3 commits were re-read end to end
and independently verified rather than accepted.

---

## A. Executive risk summary

The morning's P0–P3 work is real and it landed. Silent renewal now
proves identity before persist (`auth.js` `renew()`). The outbox is
stamped and the pump refuses a stranger when *both* sides have an
identity. `SYNC_PAGE` no longer paints a network blip as an empty
snooze mailbox. Notifications are single-flighted and scrubbed.
`parseBatch` drops unrequested ids. Diagnostics exist. Tab picking
prefers `/mail/u/N/`.

Three residual holes outrank everything else, and they share one
shape: **a safety control that is correct in the happy path and
fail-open at a seam the previous audit did not walk**.

| ID | Sev | Conf | One line |
|---|---|---|---|
| AUD2-H1 | **HIGH** | CONFIRMED | In-page fallback `SYNC_PAGE` never resolves `labelName`. Opening Snoozed while the worker is down lists **INBOX**. |
| AUD2-H2 | **HIGH** | HIGH | `send()` timeout replays the same verb in-page. Worker `OUTBOX_PUMP` does not take the storage pump lock. A slow-but-alive worker can **double-send**. |
| AUD2-H3 | **HIGH** | CONFIRMED | `dispatchable(stampedA, '') === true` is pinned. Sign-in stamp is best-effort. Setting-off + failed stamp + account B = A's queued mail leaves under B. |

Nothing else is CRITICAL. The previous two CRITICALs (AUD-C1/C2) are
**closed in the path they named** and **open in a narrower residual**
(AUD2-H3). Process finding AUD2-P1 (a live GitHub PAT pasted into chat
for the third time) is not a code defect; it is the highest operational
risk on the table and it is already live.

**Top of the roadmap.** (1) Resolve `labelName` in the fallback with
the same honest-empty contract as the worker. (2) Do not replay
side-effecting verbs after a timeout; make the worker pump take the
same storage lock. (3) Fail closed: a stamped outbox row must not
dispatch when the session has no identity. Then rotate the PAT that
commissioned this audit.

---

## B. Architecture map (from code, not docs)

```
Gmail tab(s)
  └─ takeover/content.js
        │  BMM_TOGGLE / Alt+Shift+M (trusted chord)
        │  iframe app.html?u=N&embed=<nonce>
        ▼
app.html (extension origin) ── src/app/main.js (3,842-line shell)
  │  POST verbs via chrome.runtime.sendMessage
  │  timeout → degradeToFallback → fallback.js (in-page verb table)
  ▼
src/background/index.js   MV3 service worker
  ├─ auth.js      implicit-flow OAuth; token in TOKEN_STORAGE
  │               (session-preferred); accountEmail stamp; renew()
  │               proves profile() before persist
  ├─ sync.js      cursor pull: syncPage / syncDelta / reduceHistory
  ├─ gmail.js     REST; /batch multipart; retry+401; parseBatch
  │               whitelist; buildMime reconstructed headers
  ├─ mime.js      payload → displayable body (pure, shared)
  ├─ notify.js    selectNotifiable / mergeNotified / cardText
  ├─ diag.js      in-memory counters, flushed on SYNC_ALARM
  ├─ tab-pick.js  prefer /mail/u/N/ match
  └─ alarms       bmm-wake, bmm-sync (15 min), bmm-auth-retry

app domain (chrome-free where it matters)
  ├─ mail/store.js      Map + incremental indexes, notify-once
  ├─ classify/*         address → sender → weighted patterns
  ├─ compose/outbox.js  held→sending→sent/failed; dispatchable()
  ├─ search/query.js    Gmail operators + grouped OR
  ├─ core/sanitize.js   allow-list walk; sandbox is primary
  └─ academic/*         deadlines, timetable, rules, radar
```

Layering law (ARCH R-7) is *mostly* held: network lives in
`background/` + `fallback.js`; domain modules are chrome-free and run
in both the worker and jsdom. Documented exception: `fallback.js`.
Undocumented drift: `chrome.*` still appears in `main.js` (expected
bridge), `settings.js`, `cache.js`, `body-cache.js`, `compose.js`,
`draft-store.js`, `timetable-store.js`, `view-store.js`. The seam
exists; it is not exclusive. See AUD2-L3.

---

## C. Complete findings table

| ID | Sev | Conf | Category / subsystem | File:symbol | One line |
|---|---|---|---|---|---|
| AUD2-H1 | HIGH | CONFIRMED | Fallback / sync | `fallback.js` `SYNC_PAGE` | `labelName` never resolved; snoozed mailbox lists INBOX |
| AUD2-H2 | HIGH | HIGH | Concurrency / send | `main.js` `send()`, `index.js` `OUTBOX_PUMP` | Timeout replays mutating verbs; worker pump has no storage lock |
| AUD2-H3 | HIGH | CONFIRMED | Account isolation / outbox | `outbox.js` `dispatchable` | Stamped row + empty current → send. Pinned on purpose; still a hole |
| AUD2-M1 | MEDIUM | CONFIRMED | Account isolation / storage | registry DOMAIN_KEYS | Rules, templates, followups, imageAllow, snooze, views, courses survive account switch |
| AUD2-M2 | MEDIUM | CONFIRMED | Search contract | `query.js` `buildCheck('to')` | `to:` ignores stored To/Cc; Sent recipient search is dead |
| AUD2-M3 | MEDIUM | HIGH | OAuth | `auth.js` `authUrl` | No `login_hint` / `hd`; mismatch is detected after mint, not prevented |
| AUD2-M4 | MEDIUM | HIGH | Auth design | `auth.js` header | Implicit flow is still the weakest available design (platform wall) |
| AUD2-L1 | LOW | CONFIRMED | Takeover handshake | `main.js` `BMM_SHOWN` listener | Shown-message does not echo the embed nonce |
| AUD2-L2 | LOW | HIGH | Messaging | `index.js` onMessage | `sender.id` missing is allowed (fail-open) |
| AUD2-L3 | LOW | CONFIRMED | Architecture | several `src/app/**` | `chrome.*` leaks past the platform seam |
| AUD2-L4 | LOW | CONFIRMED | Legal / process | repo root | No LICENSE on a public repo |
| AUD2-I1 | INFO | — | Observability | `docs/SOAK.md` | Live inbox has still never been the acceptance test |
| AUD2-I2 | INFO | — | Scale | `store.js` / `list.js` | Full-DOM list; `idb.js` staged and unused |
| AUD2-I3 | INFO | — | Product | `classify/` | Classifier unmeasured against a real BITS corpus |
| AUD2-P1 | HIGH (process) | CONFIRMED | Secrets | commissioning chat | A live `ghp_` PAT was pasted into chat to commission this audit — third instance |

**Previous AUD-C1/C2/M1–M4/L1–L3/Q1/Q2 — status at `ac0cbf2`:** landed as
claimed. See §3 of the scorecard. Residuals are *new* IDs, not reopenings
of the original statements.

---

## D. Critical correctness findings

No new CRITICAL correctness defect was confirmed. The two previous
CRITICALs are closed on the path they named:

- **AUD-C1 closed:** `renew()` fetches `users/me/profile` on the fresh
  token, compares a canonicalised `accountEmail`, and only then
  persists. Mismatch clears the auth-owned set and throws
  `ACCOUNT_CHANGED` verbatim (the catch no longer relabels it
  transient). Fetch failure is `AUTH_RENEW_TRANSIENT` and clears
  nothing. Epoch is re-checked after the profile await so a straggler
  cannot wipe a newer sign-in. All of this is pinned in
  `test/account-identity.test.mjs` and was re-run green (204).
- **AUD-C2 closed on the named path:** enqueue stamps; `dispatchable`
  refuses A-under-B; sign-out clears the queue under
  `clearOutboxOnSignOut` (def true); the worker pump skips
  non-dispatchable rows and reports `wrongAccount`.

The remaining correctness risk is **seams**, not the happy path. AUD2-H1
and AUD2-H2 are the ones that can produce a user-visible wrong mailbox
or a duplicate send without any account switch.

**D-1 (verified still clean):** cursor is read before listing; advanced
only after every history page drains and every add is fetched; inbox-only
anchoring; overflow → `resync`. Re-read `sync.js` end to end.

**D-2 (verified still clean):** `reduceHistory` folds chronology into
one ordered Map; add/remove are disjoint by construction; INBOX
gain/loss and TRASH/SPAM gain are honoured.

**D-3 (verified still clean):** store `upsert`/`patch` re-position on
date drift; empty index sets are deleted; `idsFor` returns a copy;
eviction pops oldest; notify-once batches.

**D-4 — AUD2-H1 (the fallback lists the wrong mailbox).**

- *File / symbol:* `src/app/system/fallback.js` `dispatch` `SYNC_PAGE`
  (line 113) vs `src/background/index.js` `handle` `SYNC_PAGE`
  (lines 219–244).
- *Condition:* worker down (the mode this project treats as production,
  not exotic) **and** the user opens a mailbox addressed by label name
  (Snoozed, `mb.byLabelName`).
- *What happens:* the app sends `{ type:'SYNC_PAGE', opts:{ labelName,
  anchorHistory:false } }`. The worker would `ensureLabel` and list that
  id. The fallback passes `opts` straight into `syncPage`, which does
  `labelIds: labelIds || (q ? [] : ['INBOX'])`. `labelName` is not
  `labelIds`. The snoozed mailbox paints the inbox.
- *Why this is unsafe:* the user then acts on those rows believing they
  are snoozed. Wake/unsnooze against inbox mail is mostly harmless; the
  information architecture is not. "My snoozed mail is gone / is my
  inbox" is the failure mode.
- *Blast radius:* every session that has already degraded to fallback
  (the amber banner). This project built fallback *because* worker
  registration has failed in production.
- *Evidence:* `fallback.js` has zero `labelName` tokens. Worker has
  `ensureLabel(opts.labelName)`. Reproduction is the source itself.
- *Preferred direction:* extract the worker's `labelName` resolution
  (including the AUD-M1 "only *Could not create* is honest-empty") into
  a shared helper both routers call. Do not fork the contract again.
- *Regression test:* fallback `SYNC_PAGE` with `labelName: SNOOZE_LABEL`
  must call `ensureLabel` and must not list INBOX. A network failure
  must surface `{ok:false}`, not an inbox page.

**D-5 — AUD2-H2 (timeout replay can double-send).**

- *File / symbol:* `src/app/main.js` `send()` (timer at ~410–416);
  `src/background/index.js` `OUTBOX_PUMP` (`outboxPumping` only);
  `src/app/compose/outbox.js` `acquirePumpLock` (fallback only).
- *Sequence:*
  1. `pumpOutbox()` → `send('OUTBOX_PUMP')`.
  2. Worker begins dispatching. Per-item send has a 30s abort × 3
     attempts. Eight items can exceed the 300s verb timeout.
  3. Timer fires, `degradeToFallback`, **replays the same verb**
     in-page.
  4. Worker callback arrives later and is discarded (`if (settled)
     return`) — but the worker's sends have already happened.
  5. Fallback `flushOutbox` takes the storage lock. The worker never
     did. `normaliseOutbox` demotes in-flight `sending` rows to
     `failed`, which are due immediately, and sends them again.
- *Why the current implementation is unsafe:* a timeout is a claim
  about liveness, not about cancellation. The worker request is not
  aborted. Replaying a non-idempotent verb is how a mail client
  produces the one failure it cannot undo.
- *Realistic trigger:* campus network, attachments to hydrate, a queue
  of more than two or three items. The 300s budget is generous and
  still smaller than `8 × (hydrate + 90s send)`.
- *Blast radius:* duplicate emails. Bounded by queue length, not by 1.
- *Preferred direction (in order):*
  1. `send()` must not replay `OUTBOX_PUMP` / `SEND` / `SAVE_DRAFT`
     (and arguably any mutate) after timeout. Surface the timeout;
     let the next scheduled pump retry.
  2. Worker `OUTBOX_PUMP` must acquire the same `outboxPumpLock` the
     in-page runner uses, so a replay that *does* happen stands down.
  3. Optionally raise the pump timeout or make it a function of
     `due.length`.
- *Regression test:* a worker pump that is still in `sending` when the
  app timer fires must result in `sent <= 1` per id. Pin it at the
  lock, not with a wall-clock 300s sleep.

---

## E. Security findings

**E-1 (positive, re-verified):** token never enters the document that
renders mail HTML in the normal architecture. Worker router
sender-checks. Embed handshake nonce on `BMM_READY` / `BMM_RELEASE`.
Trusted-event chord. Sanitiser is a real allow-list walk; sandbox
forbids `allow-scripts` and `allow-same-origin` (`reader-frame.js`
contract, test-asserted). CSP `script-src 'self'`. Zero `eval` /
`Function` / `document.write` / `outerHTML` in `src/`. `innerHTML`
hits are static skeletons (`list.js`), sanitiser output
(`sanitize.js`), and icon path literals (`icons.js`).

**E-2 (positive, re-verified):** `buildMime` reconstructs address and
id headers from parsed tokens; subjects are cut at the first line
break. `getAttachment` scheme-checks the MIME type before interpolating
it into a `data:` URL. Remote images default off.

**E-3 — AUD2-M3 / AUD2-M4.** Silent renewal still has no `login_hint`.
Google mints for whoever the browser considers current; we detect the
swap after the fact. That is the right *detection*, not the right
*prevention*. Adding `login_hint=<accountEmail>` (and `hd=pilani.bits-pilani.ac.in`
when the stamp is a BITS address) would stop the wrong token being
issued. Implicit flow remains the platform wall; the header in
`auth.js` is still an honest argument and still correct.

**E-4 — AUD2-L1 / AUD2-L2.** `BMM_SHOWN` is source-checked against
`parent` but does not echo the nonce. Impact: a Gmail-page script in
the parent can pull focus into the list. Low. The onMessage
`sender.id` check fail-opens when `id` is missing. Web pages cannot
`runtime.sendMessage` without `externally_connectable` (absent). Low,
keep the belt.

**E-5 — AUD2-P1 (process, recurring).** A live GitHub PAT was pasted
into the commissioning message for this audit. Audit 28 recorded the
first instance (2026-08-10). Audit 64 recorded the second
(2026-08-12). This is the third. The weakness is the path, not the
person: "push this for me" is faster if the token is in the prompt.
`DO-THIS-NOW.md` already asked for rotation and claimed the token was
removed from `.git/config`. The remote on this clone was reconstructed
with a new `ghp_` in the URL. **Rotate this token before merging this
PR.** Do not put the next one in chat.

---

## F. Data-integrity findings

**F-1 — AUD2-H3 (residual of AUD-C2).**

```
dispatchable({ draft, accountEmail: A }, '') === true   // reproduced
```

The test file pins this (`test/account-identity.test.mjs`, "an unproven
session does not strand stamped mail"). The comment is honest about the
trade. The trade is still wrong for a *stamped* row:

1. User A queues mail.
2. `clearOutboxOnSignOut` is OFF (the documented escape for
   same-account sign-out).
3. Sign-out (stamp cleared) → sign-in as B.
4. `signIn`'s profile read is best-effort and fails (the other pinned
   test: "sign-in still succeeds when the profile read fails").
5. `accountEmail` is empty until the first successful renewal.
6. `start()` calls `pumpOutbox()` immediately.
7. Pump reads empty current → `dispatchable` returns true → A's draft
   is sent with B's token.

Default-ON of the setting makes this uncommon. It does not make it
closed. `PROFILE` succeeding also does **not** stamp `accountEmail` —
only `signIn` and `renew` do — so a successful PROFILE + failed stamp
is the same hole.

*Preferred direction:* change the predicate to

- no stamp on the item → dispatch (legacy; keep);
- stamp on the item, no current identity → **refuse** (fail closed);
- stamp ≠ current → refuse (already).

And stamp `accountEmail` from the PROFILE response in `start()` if the
storage key is empty, so a successful "who am I" is not discarded.

*Do not* keep the current pin as a promise. Rewrite the test to name
the new law.

**F-2 — AUD2-M1 (the rest of the account-scoped set).** Sign-out
clears token, cursor, notify floor, caches, intents, in-memory stores,
and (by default) the outbox. It does **not** clear:

| Key | Hazard on account switch |
|---|---|
| `categoryRules` | A's mutes/corrections apply to B |
| `automationRules` | A's archive rules fire on B's mail |
| `followups` | thread-id collision is theoretical; wrong reminders are not |
| `deadlineOverrides` | same |
| `imageAllow` | A-trusted sender loads remote images in B |
| `snoozed` | wake attempts 404 under B (documented as OK) |
| `savedViews` / `templates` / `myCourses` | usually fine to share; not namespaced |

For a single-account BITS student this is convenience. For anyone who
signs the same install into a personal Gmail after an institute
account, it is cross-account contamination of *judgement*, not just
mail. Not CRITICAL because message bodies and the token are cleared.
MEDIUM because image-allow and automation have side effects.

*Preferred direction:* namespace these keys by `accountEmail`, or
clear the side-effecting subset (`automationRules`, `imageAllow`,
`categoryRules`, `followups`, `deadlineOverrides`, `snoozed`) on
`ACCOUNT_CHANGED` and on sign-out-into-a-different-account. Keep
templates / courses / views if the user wants them — behind a setting,
defaulting to the safe clear on identity change.

**F-3 (positive):** backup export is allow-listed from the registry;
`NEVER_EXPORT` covers credentials. Cache rows are versioned; corrupt
rows skip individually.

---

## G. MV3 lifecycle findings

**G-1 (positive):** durable work is alarms (`bmm-wake`, `bmm-sync`,
`bmm-auth-retry`). Catch-up on `onStartup` and `onInstalled`.
`setTimeout` in the worker is only retry/backoff that may die with the
worker — AUD-M4's alarm now covers the renewal retry the comment
promised.

**G-2 (positive):** a killed worker mid-pump leaves `sending`,
demoted to `failed` on next load. Visible, cancellable, not blindly
re-sent — *unless* AUD2-H2's timeout replay races it. The crash
contract is sound; the timeout contract is not.

**G-3 (positive):** listeners register synchronously at module load.
MIME parser is listener-free so the fallback can import it.

**G-4:** `bgSyncRunning` and `outboxPumping` are in-memory. Worker
restart mid-run starts a new one. Cursor and queue contracts make this
safe for sync; the pump relies on `sending`→`failed` demotion. Acceptable.

**G-5:** `sessionEpoch` in `auth.js` is in-memory. A worker kill mid-
sign-in cannot resurrect a superseded token because persist itself
checks the epoch, and a killed worker drops the in-flight promise.
Sign-out writes are in storage. Acceptable.

---

## H. Gmail / API findings

**H-1 (positive):** retry honours `Retry-After` with a 30s cap, jitters,
distinguishes quota-403 from scope-403, 401 returns to the renew-once
path, every fetch has a 30s abort. A fresh-token 401 is `AUTH_REVOKED`,
not an empty inbox.

**H-2 (positive):** history pagination drains with a 10-page / 5,000
record ceiling; overflow is `tooOld` rather than a skipped tail.
`startHistoryId` is stringified. 404 → resync.

**H-3 (positive, P2 landed):** `batchMetadata` drops parts whose `id`
is not in the requested set *before* `normalise`. All-phantom still
throws rather than painting empty. `test/fuzz-parsebatch.test.mjs`
exists.

**H-4 — AUD2-M2.** `query.js` `to:` is still the pre-header-fetch
stub: `to:me` is a tautology, anything else matches nothing. The
canonical model now fetches and stores `to` / `cc` (V2 P0-3,
`META_HEADERS`). The Sent mailbox is a first-class view. `to:prof` on
Sent is the search a student actually types, and it is dead. The
comment ("we only ever hold the signed-in mailbox… anything else
cannot be answered from stored headers") is **stale**. Server-search
fallback may rescue some queries; local Sent search will not.

*Preferred direction:* `to:` / `cc:` become substring matches on
`m.to` / `m.cc`, with `to:me` matching `state.selfEmail` (and still
failing open if self is unknown). Rewrite the comment.

**H-5 (INFO):** Gmail `watch` push remains absent by design. An MV3
worker cannot hold a channel. 15-minute deltas + app-open polling is
the correct substitute. Do not re-litigate.

---

## I. Sync findings

Covered in D-1/D-2 plus:

**I-1 (positive):** `backgroundSync` single-flights (`bgSyncRunning`).
Notify merge is pure (`mergeNotified`). App `SYNC_DELTA` can still
overlap a sweep; both are idempotent on the cursor; only the sweep
notifies.

**I-2:** AUD-M1 landed in the worker. The fallback does not have the
equivalent (AUD2-H1). The "empty means empty" contract is true in one
router and false in the other.

**I-3 (positive):** non-inbox mailboxes pass `anchorHistory: false`.
A Sent page cannot walk the inbox cursor past unseen inbox changes.

---

## J. Storage / EmailStore findings

**J-1 (positive):** `storage-registry.js` is still the executable
census. `accountEmail`, `diagCounters`, `activeAuthUser` are listed.
The registry test fails on an unlisted `KEY` literal.

**J-2 (positive):** store invariants hold under the targeted suite.
`patch` delegates date moves to `upsert`. Snippet/from/subject patches
reindex. `fromSearch` is excluded from rail counts.

**J-3 — AUD2-I2.** `idb.js` is a fully tested adapter with zero
production callers. The P3 decision to defer adoption is still right
at CACHE_MAX 500 / store cap 2000. Recorded so it is not "forgotten
infrastructure".

**J-4:** `historyId` is a single un-namespaced key. Safe because
ACCOUNT_CHANGED and sign-out remove it. If a future multi-account mode
lands, this must become `historyId:<email>` on day one.

---

## K. UX / accessibility findings

**K-1 (positive):** axe suite exists; contrast gate covers all themes
including High Contrast; reduced-motion is CSS law; focus restoration
is the layer primitive; the gate focuses its button; empty states
refuse to say "all caught up" when a mute hid the mail.

**K-2:** AUD-M2 landed — `pickGmailTab` prefers `activeAuthUser`.
Fallback to first-tab is preserved.

**K-3:** AUD2-H1 is also a UX finding. A snoozed mailbox that shows
inbox mail while the amber banner is up will be reported as "snooze
is broken", not as "fallback parity drifted".

**K-4:** A-A9 remains open and correctly so: the body iframe's
headless AX absence is a harness artifact. A real NVDA/VoiceOver pass
on hardware is the only verdict path.

---

## L. Performance findings

**L-1 (positive):** incremental store indexing, memoised derived
reads, incremental list DOM updates, one-batch-per-sync-page (list +
batch = 2 RTT). Address parsing is linear (fuzz #12). Render bench is
a hard CI gate with a named soft exit for missing Chromium.

**L-2 (INFO):** the list is still full-DOM. Fine at 500 cached / 2000
capped. Windowing is the G2 milestone, not a defect.

**L-3 (INFO):** `deepScanMessages` fetches bodies for academic
candidates at ingest. Bounded by the cheap pre-scan. `diag.js` now
exists to count this; nobody is reading the counters yet.

**L-4:** `main.js` auto-refresh is a repeating timeout re-armed after
settle, gated on `signedIn` and `document.hidden`. Sound.

---

## M. Test-quality findings

**M-1 (positive):** 1,890 declared tests, CI refuses skips, eight
shards with printed manifests, `fail-fast: off`, action SHAs pinned,
doc-truth gate, generated-file sync gate, contrast gate, typecheck,
sabotage-verified tests in several suites. Account-identity suite
exists and is green.

**M-2 — gaps, ranked by production risk:**

1. **Fallback `SYNC_PAGE` / `labelName`** — no pin. First-class. P0
   with AUD2-H1.
2. **Timeout-replay of mutating verbs** — no pin. P0 with AUD2-H2.
3. **`dispatchable` fail-closed on empty current** — the existing pin
   *forbids* the fix. Rewrite with the fix.
4. **MV3 termination between awaits** — still a soak item, not a unit
   fake.
5. **Live Gmail** — AUD2-I1 / SOAK.md. Caps every 9 on the scorecard.

**M-3 (positive):** no fixed-sleep synchronization in production
tests. Fuzz wall-clock budgets are CI-tolerated by design.

---

## N. Maintainability findings

**N-1:** `src/app/main.js` is 3,842 lines. Still the shell by house
rule. Wiring is thinner than it was; domain logic keeps moving out.
Watch item.

**N-2 — AUD2-L3.** The platform seam is real and under-used.
`timetable-store.js`, `draft-store.js`, `view-store.js`, `cache.js`
talk to `chrome.storage` directly. Not a security hole (extension
origin). It is how the next storage migration will miss a writer.

**N-3 (positive):** comments are still decision records. Retracted
claims stay retracted. Zero `TODO`/`FIXME`/`HACK` debt in `src/`
except a cross-reference to repo TODO #5 and the staged idb adapter.

**N-4:** `DO-THIS-NOW.md` still says "890 tests" and describes a
credential-rotation state that is no longer true. The doc-truth gate
does not cover it. Stale onboarding is how the next agent pastes a
PAT.

---

## O. Release / migration findings

**O-1 (positive):** backup format versioned; `msgCache` versioned;
settings typed with rollback-on-failed-write; pinned extension `key`
keeps the OAuth redirect stable.

**O-2:** no data-migration machinery, because no schema has needed
one. Bump-and-discard remains the documented plan for incompatible
cache rows. Sound, as long as AUD2-M1's account-namespacing — if it
lands — ships a real migration, not a silent key rename.

**O-3 — AUD2-L4.** Public repo, no LICENSE. Default copyright
contradicts CONTRIBUTING.md's inviting tone. One-file fix.

---

## P. Recovery and observability findings

**P-1 (positive):** corruption degrades up (cache → cold start;
`sending` → visible failed; all-dead batch → error, not empty).
`doctor.mjs`, `sw-probe/`, startup self-check, badge-on-injection-
failure are real.

**P-2 (positive, P3 landed):** `diag.js` counts requests, retries,
notifications, renewals, mismatch-clears. Flushed on the sweep tick.
Best-effort and lossy, as documented.

**P-3:** there is still no user-exportable diagnostic bundle. Support
conversations will still be "what did you click". P3+, not a defect.

---

## Q. Improvement opportunities (not caused by current bugs)

1. `login_hint` / `hd` on silent renewal (AUD2-M3) — prevent, don't
   just detect.
2. Namespace or clear side-effecting prefs on identity change (AUD2-M1).
3. Honour stored `to`/`cc` in search (AUD2-M2).
4. Stamp `accountEmail` from PROFILE if missing.
5. Make `send()` cancellation-aware (AbortSignal into `gmail.api`) so
   a timed-out verb actually stops.
6. Virtualise the list behind the existing render invariant (G2).
7. Adopt `idb.js` when CACHE_MAX is no longer enough.
8. A LICENSE.
9. A stored `GH_TOKEN` the agent can use and never see, so the next
   audit cannot be commissioned with a pasted PAT.
10. One live-inbox soak, recorded in `docs/SOAK.md`.

---

## R. Recommended phased roadmap

**P0 — this week, small, no product change the user asked for:**

1. **Rotate the PAT that commissioned this audit.** Close the class
   (credential helper / env), not the instance.
2. **AUD2-H1.** Shared `resolveSyncPageOpts(opts)` used by both
   routers. Pin: fallback + `labelName` does not list INBOX; network
   error is not an empty page.
3. **AUD2-H2.** `send()` does not replay `OUTBOX_PUMP` / `SEND` /
   `SAVE_DRAFT` after timeout. Worker pump acquires `outboxPumpLock`.
   Pin: one id cannot leave twice across a timeout seam.
4. **AUD2-H3.** `dispatchable` fails closed on (stamped, unknown
   current). Stamp from PROFILE if storage is empty. Rewrite the pin
   that currently forbids this.

*Acceptance:* the three new tests green; no change to default-ON
`clearOutboxOnSignOut`; no change to legacy-unstamped dispatch.

**P1 — honest contracts:**

- AUD2-M2 (`to:` / `cc:`).
- AUD2-M1 clear-or-namespace on identity change, gated as a setting
  that defaults to the safe clear (house rule: nothing is removed
  without a setting).
- AUD2-M3 `login_hint`.

**P2 — coverage and hygiene:**

- AUD2-L1 nonce on `BMM_SHOWN`.
- AUD2-L3 remaining `chrome.*` writers onto the seam.
- AUD2-L4 LICENSE.
- Refresh `DO-THIS-NOW.md` so it cannot commission the next leak.

**P3 — scale and the soak:**

- Live-inbox ritual (`docs/SOAK.md`).
- idb adoption decision revisited against real mailbox size.
- Counters on a diagnostics page the user can export.

---

## S. Assumptions and unverified items

1. AUD2-H2 is verified by reading both routers and the timeout
   wrapper, not by an end-to-end double-send against Gmail. Confidence
   HIGH because every compensating control was searched for: the
   worker pump does not take `outboxPumpLock`; `send()` replays on
   timeout; `normaliseOutbox` demotes `sending` to due `failed`. The
   e2e replay is a P0 acceptance step.
2. Google's silent-renewal account selection still cannot be
   exercised from this sandbox. AUD-C1's original caveat stands;
   the *code* of the fix was re-read and the suite was re-run.
3. This audit did not run the full 8-shard CI locally (jsdom +
   playwright Chromium install). Targeted 204 and the static census
   are the local evidence. CI at `ac0cbf2` is the last known green
   of the P3 push.
4. Classifier accuracy against real BITS mail is unmeasured
   (AUD2-I3). Synthetic pack + generated-file gate only.
5. Notification OS-card rendering of residual Unicode was not
   re-checked against a live Chrome; AUD-L2's subject scrub is in
   the code and pinned.
6. `chrome.storage` NaN fidelity is taken from the earlier fuzz
   campaign; `nextWakeAt` now filters non-finite, so the writer is
   closed regardless.
7. Fallback verb-for-verb parity is trusted where
   `behavior-parity.test.mjs` pins it. That suite did not catch
   AUD2-H1, which is itself a test-quality finding.
8. No production file was modified. Ratings below assume `ac0cbf2`
   as shipped.

---

## Scorecard — every way, 1–10

Same fifteen ways as audit 64, rescored at `ac0cbf2` after P0–P3 and
against the new findings. A 10 still requires a live adversarial pass
on a real inbox (AUD2-I1); that cap is applied consistently, not as
an excuse to flatten the table.

| # | Way | Score | Why this number, at this commit |
|---|---|---|---|
| 1 | Security architecture | **8** | Defence in depth is real (sandbox + allow-list + nonce + no-eval + reconstructed headers). Deducted for AUD2-H2 (timeout replay is a security-adjacent integrity hole), AUD2-H3 (identity fail-open), and the missing `login_hint`. A 10 needs the live adversarial pass. |
| 2 | Auth & credential hygiene | **8** | AUD-C1 landed and is pinned. Session-epoch, revoke-on-sign-out, revoked-vs-transient taxonomy, per-user client ID, zero shipped secrets in tree. Deducted for implicit flow (platform), no `login_hint`, best-effort stamp, and AUD2-P1 (the PAT is not in the tree and still exists). |
| 3 | Correctness & data integrity | **8** | Cursor, reduceHistory, store indexes, outbox state machine remain excellent. Deducted for AUD2-H1 (wrong mailbox in a shipped mode) and AUD2-H2 (duplicate send is the one unrecoverable mail-client failure). |
| 4 | Gmail API integration | **9** | Batch, retry, 401, history pagination, MIME totality, attachment hydrate-at-wire, bulk chunking — all sound. `to:` is the one stale contract (AUD2-M2). A 10 needs live quota/history-cliff mileage. |
| 5 | Testing & CI | **9** | 1,890 declared, zero-skip, 8 shards, SHA-pinned actions, doc-truth, contrast, types, hard render gate. Deducted because the two new HIGH holes had no pin, and one existing pin *forbids* the H3 fix. |
| 6 | Performance | **8** | Incremental everything; benches gated. Full-DOM list is the known ceiling. Unchanged. |
| 7 | Code quality & documentation | **9** | Decision-record comments still set the standard. Deducted one from 64's 10 because `to:`'s comment is false, `DO-THIS-NOW.md` is stale, and fallback's own header claims verb-for-verb parity it no longer has. |
| 8 | Architecture & modularity | **8** | 0 conceptual cycles in the domain; fallback is the right exception. Deducted for AUD2-H1 (the two routers drifted), chrome.* leaks (AUD2-L3), and `main.js` still 3,842 lines. |
| 9 | Accessibility | **8** | Structural axe + contrast + focus/overlay contracts. Real screen-reader still unrun (A-A9). Unchanged. |
| 10 | UX & product completeness | **8** | Full mail lifecycle is implemented. Deducted for snooze-shows-inbox in fallback and dead `to:` on Sent — both user-visible, both "the app is lying". |
| 11 | Design system & visual craft | **9** | Themes-as-data, token discipline, contrast-gated, 64-image matrix. Unchanged; still self-authored taste held to engineering rigour. |
| 12 | Resilience & degraded-mode | **8** | Fallback is still the project's quiet masterpiece — and AUD2-H1/H2 land *inside it*. A degraded mode that lists the wrong mailbox and can double-send is a degraded mode that needs another pass. |
| 13 | Maintainability & operational risk | **7** | Bus factor one; classifier unmeasured; timetable hand-fed. Unchanged and still honest. |
| 14 | Privacy & least privilege | **8** | Two scopes, no telemetry, host permission over `tabs`, remote images off. Deducted for AUD2-M1 (automation + image-allow survive an account switch). |
| 15 | Repo & process hygiene | **6** | CI and ignore-rules are excellent. Deducted hard for AUD2-P1 (third PAT paste in five days) and AUD2-L4 (no LICENSE). The code's process is not the human process. |

**Unweighted mean: 121 / 15 = 8.07.**
**Weighted** (security ×2, correctness ×2, auth ×1.5, Gmail/sync ×1.5,
testing ×1.5): **150 / 18.5 ≈ 8.11.**

### Comprehensive rating

**8.1 / 10 — still exceptional craft, with three remaining HIGH seams
and a recurring operational failure.**

Down from audit 64's 8.8, and that drop is not a regression of the
P0–P3 work. Those landings closed the two CRITICALs they named. This
pass walked the seams those fixes created and the router they did not
touch, and found three HIGH items a 9 cannot carry. The defining
trait of the codebase is intact: comments as audit trail, CI as
institutional memory, retracted findings as evidence. The remaining
distance to a 9 is one short week of P0 (H1, H2, H3, rotate the PAT)
plus the soak no gate can invent from inside jsdom.

---

## Previous-audit status at `ac0cbf2`

| Prior ID | Status | Proof |
|---|---|---|
| AUD-C1 silent renewal follows browser account | **fixed on the named path** | `auth.js` `renew()` + `test/account-identity.test.mjs` green |
| AUD-C2 outbox unscoped / uncleared | **fixed on the named path; residual AUD2-H3** | stamp + refuse-stranger + setting; fail-open on empty current remains |
| AUD-M1 snoozed mailbox offline reads as empty | **fixed in the worker; open in fallback (AUD2-H1)** | worker catch narrowed to `/Could not create/`; fallback never entered the path |
| AUD-M2 toolbar opens first Gmail tab | **fixed** | `tab-pick.js` + `activeAuthUser` |
| AUD-M3 notify dedupe race | **fixed** | `bgSyncRunning` + `mergeNotified` |
| AUD-M4 renewal retry weaker than comment | **fixed** | `bmm-auth-retry` alarm |
| AUD-L1 non-finite snooze `at` | **fixed** | `nextWakeAt` |
| AUD-L2 notification subject unscrubbed | **fixed** | `cardText` |
| AUD-L3 no double-injection DOM guard | **fixed** | `#bmm-takeover-host` |
| AUD-Q2 parseBatch no id validation | **fixed** | requested-set filter + fuzz suite |
| AUD-Q1 no instrumentation | **fixed (minimal)** | `diag.js` |
| AUD-N1 idb adoption | **deferred, as decided** | adapter stays; no caller |
| Audit 64 F2 soft render bench | **fixed earlier** | named exit 2 vs 1 in `ci.yml` |
| Audit 64 F3 playwright in `dependencies` | **fixed** | now `devDependencies` |
| Audit 64 F1 / 28 F1 PAT in chat | **recurred (AUD2-P1)** | third instance, this commission |

---

## The 50-section sweep (what was inspected, what was not a finding)

This is the brief's checklist, collapsed to the evidence. Anything
that produced a finding is referenced by ID; anything that was
inspected and is clean is marked so, so the next audit does not
re-derive it from zero.

| § | Brief | Result |
|---|---|---|
| 01 | Repo state | `main` @ `ac0cbf2`, clean, not diverged. 417 files. No accidental secrets in tree (`secrets.test` still the gate). |
| 02 | Product contract | Source of truth for metadata is Gmail; local store is a cache. Categories are local. Sync cursor is `historyId`. Duplicates prevented by upsert id. Offline is local-read + queued intents/outbox. Account change is now an explicit teardown. Undocumented: fallback snooze lists inbox (AUD2-H1). |
| 03 | Architecture | Five-layer model holds with the documented fallback exception and AUD2-L3 leaks. |
| 04 | Dependency graph | Zero runtime deps. Dev: jsdom, axe, fake-indexeddb, playwright-core, pngjs, typescript. Lockfile present. No cycles in domain. |
| 05 | Domain model | Message / thread / history / label ids distinguished. Dates finite at ingest (`toEpoch`). Account identity is now a field, not yet a namespace (AUD2-M1). |
| 06 | API / contracts | Verb table in worker + fallback. PumpResult typedef is the outbox contract. Timeout wrapper silently changes the contract of every verb (AUD2-H2). |
| 07 | Gmail API | Endpoints used: profile, messages.list/get/modify/batchModify/trash/untrash/send, drafts.*, labels.*, history, attachments, `/batch`. Semantics match. |
| 08 | OAuth | Implicit, state-checked, silent `prompt=none`, session-epoch, revoke, identity proof on renew. No `login_hint` (AUD2-M3). |
| 09 | MV3 lifecycle | Alarms for durable work. Listeners sync at load. In-memory flags are restart-lossy and the durable contracts compensate, except AUD2-H2. |
| 10 | Chrome APIs | Permissions match use (`alarms`, `identity`, `notifications`, `scripting`, `storage` + three hosts). No `tabs` (host permission instead). |
| 11 | Storage | Registry is the census. Session token + local consent. No schema version on domain keys other than `msgCache`. |
| 12 | EmailStore | Incremental index, copy-on-read, date reposition, eviction, memo per `_version`. Clean. |
| 13 | Sync engine | Pull, not push. Single history cursor, inbox-anchored. Fallback is the hole (AUD2-H1). |
| 14 | History API | Types requested: added/deleted/labelAdded/labelRemoved. Overflow → resync. 404 → resync. |
| 15 | Batch fetch | Multipart, requested-id whitelist, mixed 2xx/5xx drops failed parts, all-dead throws. |
| 16 | Normalisation | One trust boundary (`normalise` + `toEpoch` + `headerMap` + `str`). Totality pinned. |
| 17 | Classification | Address → sender → patterns; course-code boost; user corrections win. Unmeasured on real mail (AUD2-I3). |
| 18 | Threads | Gmail `threadId`, incremental `byThread`, summaries computed on demand. |
| 19 | Search | Index + operators + grouped OR. `to:` stale (AUD2-M2). Server fallback exists. |
| 20 | UI state | One store notification → one rAF. `opEpoch` drops stale responses. Popup/options treated correctly. |
| 21 | UX IA | Gate / amber / offline banners are distinct. Destructive actions have undo. Fallback lying about snooze is the UX hole. |
| 22 | Accessibility | Structural coverage in CI. A-A9 open. |
| 23 | Visual / responsive | Tokenised, contrast-gated, 4-width screenshot matrix. |
| 24 | Errors | Taxonomy exists (auth / network / revoked / quota). Timeout-as-death is the misclassification (AUD2-H2). |
| 25 | Concurrency | Outbox lock is tab-safe and worker-absent (AUD2-H2). Sync single-flight in sweep only. |
| 26 | Cancellation | AbortSignal on fetches (30s). Verb timeout does not cancel the worker request (AUD2-H2). |
| 27–29 | Perf / memory / quota | No new hot-path scan. Quota uninstrumented beyond counters. |
| 30–34 | Threat model / XSS / privacy / permissions / validation | See E, F. Least privilege holds. Input totality at ingest is real. |
| 35–37 | Tests / flakes / fuzz | See M. Fuzz campaign still load-bearing. |
| 38–39 | Migrations / recovery | See O, P. |
| 40 | Observability | `diag.js` landed. No exportable bundle. |
| 41 | CI | 8 shards + checks + Verdict. Least-privilege `contents: read`. Concurrency cancels stale runs. |
| 42–44 | Quality / types / docs | `checkJs` on contracts. Doc-truth gate does not cover `DO-THIS-NOW.md`. |
| 45 | Hostile data | Fuzz suites cover the ingest/MIME/search/sanitiser surface. Fallback path less so. |
| 46 | Multi-account | Identity is a tripwire, not a mode. Residuals: AUD2-H3, AUD2-M1, AUD2-M3. |
| 47 | Install / update | `onInstalled` catch-up. Pinned key. No migration. |
| 48 | Offline | Local read, queued ARCHIVE intents, outbox. Banner is honest. |
| 49 | Perceived UX | Cache-first paint, incremental list, silent auto-refresh. |
| 50 | Synthesis | This document. Three HIGH seams, one process HIGH, no new CRITICAL. |

---

*Preserved in Git per the brief: report first, then any long-running
work. P0 above is the only behaviour change this audit recommends;
everything else is test, comment, setting, or roadmap. Production
behaviour was not modified.*
