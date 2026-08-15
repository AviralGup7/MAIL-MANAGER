# BITS Mail Manager — Independent System-Wide Audit

**Audit date:** 2026-08-15 (IST)  
**Audited commit:** `ac0cbf2` (`main`, equal to `origin/main` at clone time)  
**Audit branch:** `audit/independent-systemwide-2026-08-15`  
**Mode:** audit-only; no production behavior changed  
**Method:** independent code-path review, repository inventory, static searches, dependency/import analysis, test execution, coverage execution, and focused reproduction. Existing audits were inventoried but not accepted as evidence.

> Scoring: **10 = excellent/low residual risk; 1 = unsafe/not release-ready.** Ratings are evidence-weighted, not averages of test counts.

---

## A. Executive risk summary

The project has unusually extensive tests, strong sanitization work, bounded caches, thoughtful Gmail error handling, no runtime dependencies, and a disciplined MV3 architecture in several areas. However, the current synchronization and outbound-side-effect boundaries contain production-critical defects that tests do not model:

1. **The background notification sweep consumes the one Gmail history cursor without durably applying the changes to the app cache.** A later cache-first app boot asks for deltas after that advanced cursor and can permanently omit mail that arrived while the app was closed.
2. **Foreground delta sync commits the cursor before the app applies and persists the returned delta.** A tab close, crash, timeout, account epoch change, or storage failure in that window loses changes.
3. **The generic Gmail retry layer retries non-idempotent sends and draft creation after uncertain outcomes.** A timeout, network reset, or retryable server response after Gmail accepted the request can duplicate outbound mail or drafts.
4. **The worker-timeout fallback re-executes verbs rather than cancelling or reconciling the original operation.** Non-idempotent verbs can run once in the worker and once in-page.
5. **Account identity is not a mandatory transaction boundary during interactive sign-in.** The token is committed before identity verification, identity failure is swallowed, account data is kept under global keys, and missing owner/current-account values are treated as dispatchable. Under a realistic account-switch plus profile-failure sequence, cached mail can cross accounts and a queued message can be sent by the wrong account.

These issues are not contradicted by the passing unit tests: they live between worker, app, storage, and Gmail acknowledgement boundaries. Because the defects include missed inbound mail, duplicate outbound mail, and cross-account behavior, the current release-readiness rating is **4/10** despite the breadth of the suite.

### Overall rating

**5.6 / 10 — sophisticated and well-tested locally, but not safe to call production-reliable until cursor ownership, uncertain send outcomes, and account transactions are redesigned.**

---

## B. Architecture map

```text
Gmail tab
  └─ content script: src/takeover/content.js
       └─ embeds web-accessible app.html with nonce handshake
            └─ app shell: src/app/main.js (3,842 LOC, 64 static imports)
                 ├─ in-memory Store + indexes: src/app/mail/store.js
                 ├─ cache/body/settings/outbox via chrome.storage.local
                 ├─ sanitized reader srcdoc
                 └─ chrome.runtime messages to service worker

MV3 service worker: src/background/index.js
  ├─ OAuth/token lifecycle: src/background/auth.js
  ├─ Gmail REST + retry + batch parser: src/background/gmail.js
  ├─ cursor orchestration: src/background/sync.js
  ├─ alarms: snooze wake, 15-minute background delta, auth retry
  └─ outbound queue dispatcher

Persistence
  ├─ chrome.storage.local: global flat keys (cache, historyId, accountEmail,
  │  outbox, snooze, settings, diagnostics, etc.)
  ├─ chrome.storage.session preferred for access token
  └─ IndexedDB adapter exists but production consumers are not migrated

Testing/CI
  ├─ 110 production JS modules; 298 static import edges; no static cycles found
  ├─ 100+ test files / 1,900+ runtime tests
  ├─ eight CI test shards plus docs, contrast, types, benchmarks, browser smoke
  └─ coverage gate exists locally but is not invoked by CI
```

### Principal trust boundaries

1. Gmail API response → worker normalization/parser.
2. Untrusted email HTML → sanitizer → sandboxed `srcdoc` reader.
3. Extension document/content script → privileged worker message router.
4. OAuth result → token storage → account identity stamp.
5. Worker delta result → app in-memory store → deferred durable cache.
6. Outbox durable state → non-idempotent Gmail send.
7. Gmail page → web-accessible app iframe/nonce handshake.

---

## C. Complete findings table

| ID | Severity | Confidence | Category / subsystem | Finding | Risk |
|---|---|---:|---|---|---:|
| AUD-I01 | CRITICAL | CONFIRMED | Data integrity / background sync | Background sweep advances the app’s sole history cursor but does not durably apply added/removed/patched messages to the cache. | 10/10 |
| AUD-I02 | CRITICAL | CONFIRMED | Data integrity / foreground sync | Delta cursor is committed before the app applies and persists the delta; interruption loses changes. | 10/10 |
| AUD-I03 | CRITICAL | HIGH | Gmail/API / send | Generic retry repeats non-idempotent send/draft-create operations after uncertain outcomes. | 10/10 |
| AUD-I04 | CRITICAL | HIGH | Reliability / fallback | A worker timeout replays the same verb in-page while the original may still complete. | 9/10 |
| AUD-I05 | CRITICAL | HIGH | Account isolation / outbox | Interactive sign-in commits a token without mandatory identity proof; missing identity is fail-open for queued sends. | 10/10 |
| AUD-I06 | HIGH | CONFIRMED | Privacy / account isolation | Worker-detected account change while the app is closed leaves old message/body/intents/outbox data under global keys; next sign-in can briefly expose old mail. | 8/10 |
| AUD-I07 | HIGH | CONFIRMED | Outbox / MV3 crash recovery | Persisted `sending` becomes immediately due `failed` after restart, allowing duplicate delivery after an accepted-but-unrecorded send. | 9/10 |
| AUD-I08 | MEDIUM | CONFIRMED | CI / test determinism | Documented `npm test` command OOMs at its 1.4 GB heap limit; CI runner uses 3 GB while claiming it mirrors the script. | 6/10 |
| AUD-I09 | MEDIUM | CONFIRMED | CI / coverage | Coverage gate is absent from CI and currently fails (`outbox.js` branch 68% < 70%). | 6/10 |
| AUD-I10 | MEDIUM | CONFIRMED | MV3 / error handling | Startup/install/alarm chains contain unhandled promise paths; failed scheduling can become an unhandled worker rejection. | 5/10 |
| AUD-I11 | MEDIUM | CONFIRMED | Type safety | Type checking is non-strict and covers only a small contract subset, excluding auth, Gmail, sync, outbox, sanitizer, and most UI. | 5/10 |
| AUD-I12 | MEDIUM | HIGH | Storage / operability | Most account data remains in one global `chrome.storage.local` namespace with no schema/account transaction; recovery depends on coordinated clears across modules. | 7/10 |
| AUD-I13 | LOW | CONFIRMED | Maintainability | `src/app/main.js` is a 3,842-line, 64-import orchestration hub; several other modules exceed 1,000 lines. | 4/10 |
| AUD-I14 | LOW | CONFIRMED | Observability | Critical failures are deliberately swallowed or reduced to generic strings; no durable per-sync transaction/cursor journal exists. | 5/10 |
| AUD-I15 | INFO | CONFIRMED | Dependencies/security | Current dependency audit reports no known vulnerabilities; no current-tree PAT, Google client secret, OAuth access token, or private-key literal was found. | 1/10 |

---

## D. Critical correctness findings

### AUD-I01 — Background sweep consumes changes that the app never commits

- **Severity / confidence:** CRITICAL / CONFIRMED
- **Subsystem:** Gmail history, background sync, app cache
- **Paths/symbols:**
  - `src/background/index.js:623-699` — `backgroundSyncRun`
  - `src/background/sync.js:103-130` — `syncDelta`
  - `src/app/main.js:3384-3409` — cache-first startup
- **Failure sequence:**
  1. App cache and `historyId=H0` are on disk; app is closed.
  2. Mail M arrives.
  3. Fifteen-minute worker sweep calls `syncDelta()`.
  4. `syncDelta()` fetches M and writes `historyId=H1` at line 128.
  5. `backgroundSyncRun()` may notify and stores only `bgNotifiedIds`; it does not update message cache, removals, or patches.
  6. App opens, hydrates old cache, then calls `SYNC_DELTA` from H1.
  7. Gmail correctly reports no changes after H1. M is absent until a separate full page refresh/resync happens, which cache-first startup does not perform.
- **Impact:** silent missing mail; stale archived/deleted/read/starred state; notification can refer to a message absent from the inbox UI.
- **Blast radius:** every signed-in user with a warm cache and background alarms.
- **Why tests missed it:** worker sweep and app cache are tested as separate units; no contract asserts that one cursor has exactly one durable consumer.
- **Preferred remediation:** do not let the notification sweep advance the app cursor. Use either (a) a separate notification cursor, or (b) a durable account-scoped change journal applied atomically before cursor advancement. The app cursor must represent “durably reflected in app state,” not “observed by any process.”
- **Regression requirement:** close-app/warm-cache test with mail arrival, background sweep, worker restart, app boot; M must be present and cursor monotonic.

### AUD-I02 — Cursor commits before durable application

- **Severity / confidence:** CRITICAL / CONFIRMED
- **Paths:** `src/background/sync.js:120-130`; `src/app/main.js:1702-1751`; `src/app/system/cache.js:243-345`
- **Failure sequence:** `syncDelta` stores the returned history ID, then sends the delta across runtime messaging. Only afterward does the app mutate its in-memory store; cache persistence is deferred through an idle/timer saver. Closing the frame, a runtime message timeout, account epoch change, exception, worker/app crash, or failed storage write after the cursor write causes the next sync to start after unapplied changes.
- **Impact:** permanent omission or stale state without a forced full resync.
- **Preferred remediation:** split **read/prepare** from **commit**. Return `{delta, nextHistoryId, transactionId}` without mutating the durable cursor. App applies and durably writes cache/journal, then sends `SYNC_COMMIT(transactionId)`. Make commit idempotent. A stronger design stores account snapshot and cursor in one IndexedDB transaction.
- **Regression requirement:** inject termination after every await from history fetch through cache commit; restarting must replay or reconcile, never skip.

### AUD-I03 — Non-idempotent Gmail calls are retried generically

- **Severity / confidence:** CRITICAL / HIGH
- **Paths:** `src/background/gmail.js:61-142` (`fetchRetrying`), `:145-168` (`api`), `:858-865` (`sendMessage`), `:905-921` (`saveDraft`)
- **Condition:** `fetchRetrying` retries all methods on network exceptions, 429, selected 403, and 5xx. Gmail may accept a POST and lose/reset the response, or return a retryable status after partial processing. `/messages/send` and new `/drafts` creation have externally visible, non-idempotent effects.
- **Impact:** duplicate emails or duplicate drafts. Duplicate outbound mail is not locally repairable.
- **Preferred remediation:** classify operations by idempotency. Automatic transport retry is safe for GET and idempotent label mutations; non-idempotent send/create needs an uncertainty state and reconciliation strategy. Add a stable client operation identifier/header where Gmail semantics permit, search/reconcile sent mail by a unique RFC `Message-ID`, and require explicit user decision when outcome cannot be proven.
- **Regression requirement:** simulate “server accepted request, client sees network reset” and “accepted then 503.” Assert no second send occurs without reconciliation.

### AUD-I04 — Timeout fallback executes the operation twice

- **Severity / confidence:** CRITICAL / HIGH
- **Paths:** `src/app/main.js:376-443` (`send`), especially lines 410-415 and 424-427
- **Condition:** on timeout or missing response, the app calls `runInPageGuarded(type, extra)` without cancelling or proving failure of the worker request. Runtime messaging timeout is not operation cancellation.
- **Blast radius:** every verb; highest risk for `SEND`, `SAVE_DRAFT`, `OUTBOX_PUMP`, snooze/wake, and cursor movement. Idempotent label operations still produce false rollback/activity state.
- **Preferred remediation:** never replay a side-effect solely because its acknowledgement timed out. Introduce operation IDs and a status/query protocol; use fallback only before dispatch is known to have started, or after a durable lease expires and reconciliation proves no effect.
- **Regression requirement:** delay worker reply beyond each verb timeout while letting the worker complete; assert exactly one external side effect.

### AUD-I05 — Identity proof is optional while account-scoped effects fail open

- **Severity / confidence:** CRITICAL / HIGH
- **Paths:**
  - `src/background/auth.js:239-269` — token/authorized persisted before best-effort profile stamp
  - `src/app/compose/outbox.js:165-182` — missing owner or current identity returns `true`
  - `src/background/index.js:383-456` — worker pump
- **Failure sequence:** user switches Google account, starts interactive sign-in, token succeeds, profile identity fetch fails transiently. Sign-in still succeeds. `accountEmail` may be absent or stale. `dispatchable()` explicitly allows sends when either current or owner identity is missing. A retained queued item can therefore be sent using a token whose account has not been proven.
- **Impact:** mail sent from the wrong account; prior-account cache exposure and incorrect Gmail mutations.
- **Preferred remediation:** fail closed. Identity verification must complete before token/session activation and before any account-scoped read/write. Sign-in should stage token → fetch profile → compare/choose account transition → atomically activate account namespace. `dispatchable` must return false if either identity is absent for any post-migration record; legacy rows require a one-time user confirmation/migration, not automatic sending.
- **Migration:** assign every durable account record an account key. Quarantine unowned legacy outbox rows.

---

## E. Security findings

### Positive evidence

- Extension-page CSP disallows external scripts and object content.
- Mail rendering uses a dedicated sanitizer and sandboxed reader boundary; dangerous schemes and SVG data images are rejected.
- OAuth `state` is validated before token acceptance.
- Token storage prefers `chrome.storage.session`; access token is not deliberately exposed to the app document.
- Current dependency audit: **0 known vulnerabilities**.
- Current-tree secret scan found no live PAT/client-secret/access-token/private-key literal.
- CI actions are pinned by commit SHA and workflow permissions are read-only.

### Material risks

- **AUD-I05/AUD-I06:** account identity is not an atomic security boundary.
- `onMessage` validates a mismatching `sender.id` but allows missing IDs (`src/background/index.js:202-206`). With the current manifest and no `externally_connectable`, ordinary websites cannot directly reach this event, so this is a defense-in-depth weakness rather than a confirmed exploit. Prefer `sender.id === chrome.runtime.id` and explicit sender-context/verb policy.
- The user-provided PAT was exposed outside the repository during this audit request. It was not used or written to disk; it must be revoked separately.

---

## F. Data-integrity findings

- **AUD-I01 and AUD-I02 are release blockers.** The cursor is a commit marker but is treated as a read-progress marker.
- Cache persistence is intentionally deferred and best-effort, yet cursor persistence is immediate. That ordering violates the fundamental invariant: `cursor <= durable state`.
- `chrome.storage.local` keys are globally named and cross-module cleanup is the transaction mechanism. A partial clear or terminated worker can produce mixed-account/mixed-generation state.
- Store indexes themselves are comparatively strong: randomized invariant tests, copy-returning APIs, bounded size, update/remove index maintenance, and deterministic ordering were observed.

Required invariant:

> For account A, the committed history cursor may advance to H only if every app-visible effect through H is durably represented in A’s snapshot/journal, or can be deterministically replayed after any restart.

---

## G. MV3 lifecycle findings

- Durable alarms are correctly used for snooze, periodic sync, and auth retry.
- Listeners are registered synchronously at module evaluation.
- **Global booleans** (`bgSyncRunning`, `outboxPumping`, auth `inFlight`) are only same-worker single-flight guards. They are not durable leases and cannot represent ownership across worker death, fallback execution, or uncertain completion.
- `onStartup` / `onInstalled` use `wakeDue().then(scheduleWake)` without a terminal catch (`src/background/index.js:749-757`). Notification click calls `openGmailTab()` without handling rejection (`:742-747`). Wake alarm awaits scheduling without a protective boundary (`:718-739`). These can surface as unhandled worker rejections.
- A service worker may terminate between any two awaits; current cursor and send protocols are not restart-safe at the acknowledgement boundary.

Lifecycle matrix:

| Boundary | Current outcome | Required outcome |
|---|---|---|
| After history fetch, before cursor write | replay; safe | replay; safe |
| After cursor write, before app apply | **changes lost** | replay transaction |
| After app apply, before cache write | **changes lost after restart** | durable journal/snapshot first |
| After Gmail accepted send, before queue removal | **duplicate possible** | uncertain/reconcile state |
| During worker timeout while operation continues | **fallback may duplicate** | status query, no blind replay |
| Account switch while app closed | **old global data survives** | namespace switch/quarantine |

---

## H. Gmail/API findings

Strengths: bounded retries with jitter, `Retry-After`, 401 renewal, history pagination, 404 stale-cursor fallback, batch-size bounds, message-ID verification, partial batch handling, typed normalization, internalDate preference, and label-cache reset hooks.

Defects/risks:

- Retry policy is transport-global rather than operation-specific (**AUD-I03**).
- Cursor ownership is shared by foreground and background consumers (**AUD-I01**).
- Gmail batch and parser tests are extensive, but no live Gmail/Chrome soak was performed in this audit; production response/header variability remains unverified.
- Full mailbox reconciliation and quota economics for very large inboxes remain bounded by a 500-message local cache and user-driven pagination.

---

## I. Sync findings

- State machine is implicit across `sync.js`, worker router, and `main.js` rather than represented as a durable transaction.
- Concurrent inbox refresh is guarded in the app, but the worker/background/fallback boundary has no account-scoped durable lock.
- Partial fetch failures do not advance the cursor inside `syncDelta`, which is good.
- Successful fetch advances too early, which is the critical defect.
- A `resync` clears cursor/store/cache but lacks a durable “resync in progress” marker; termination can leave mixed recovery state, though the missing cursor usually causes another resync.

Preferred target states:

`IDLE → PREPARING(H0,H1,tx) → DURABLY_APPLIED(tx) → COMMITTED(H1)`, with idempotent restart from every state.

---

## J. Storage / EmailStore findings

- Store indexes and mutation tests are a project strength.
- `chrome.storage.local` whole-value writes remain vulnerable to lost updates when multiple contexts modify the same key; outbox uses read-modify-write loops/locks but cannot make them atomic.
- An IndexedDB adapter exists but no production consumer uses it. IDB is the preferred location for account snapshots, change journals, and transactional cursor commits.
- Schema versioning is local to individual blobs rather than a system-level account schema/migration transaction.
- Corruption generally degrades to empty/default state; this improves availability but can hide corruption as absence. Add quarantine and diagnostics rather than silent discard for account-critical records.

---

## K. UX / accessibility findings

- Automated contrast passes all themes; semantic/focus/reduced-motion tests are broad.
- Error, empty, loading, and offline states are intentionally distinguished in many paths.
- The most important UX correctness problem is not visual: missing mail can look “Up to date,” and uncertain sends can look failed then later duplicate. Freshness/success messaging cannot be honest until transaction semantics are fixed.
- No real screen-reader run, keyboard walkthrough in Chrome, or live Gmail DOM takeover test was performed here. Automated semantics are not equivalent to assistive-technology validation.

---

## L. Performance findings

- Bounded message cache, batch Gmail requests, incremental indexes, render diffing, and benchmarks are strengths.
- Search prefix matching walks every token for each term (`src/app/mail/store.js:567-579`); bounded cache limits present harm but this will not scale to a deep IndexedDB corpus without a prefix index.
- `main.js` central orchestration and full-DOM lists remain growth ceilings.
- Full suite resource use is excessive enough to OOM at the advertised heap setting (**AUD-I08**), suggesting retained jsdom/document state and/or over-parallelization.

---

## M. Test-quality findings

### Executed

- `npm run test:unit`: **266/266 passed**, 0 skipped.
- `npm test`: **failed**; `test/app.integration.test.mjs` aborted at ~1.39 GB heap, final 1907 passed / 1 failed.
- `npm run types`: passed.
- `npm run docs:check`: 6/6 passed.
- `npm run contrast`: all seven themes passed WCAG AA combinations.
- `npm audit --audit-level=low`: 0 vulnerabilities.
- `npm run coverage`: gate **failed** because `src/app/compose/outbox.js` branch coverage was 68%, below 70%.

### Gaps

- No end-to-end test covers background sweep → app boot against the same cursor.
- No test injects termination between cursor write/app apply/cache write.
- No test models accepted send plus lost response.
- Timeout tests do not prove the original worker operation stopped before fallback replay.
- Account-switch tests do not combine identity-profile failure, retained outbox, app closed, and warm cache.
- Several “architecture” tests are regex/source pins (for example, the `bgSyncRunning` guard), proving text exists rather than that MV3 behavior is safe.
- Coverage is measured on selected modules, not the complete critical boundary, and the gate is not in CI.

---

## N. Maintainability findings

- No static import cycles found across 110 JS modules / 298 edges.
- `src/app/main.js` has 64 static dependencies and 3,842 LOC: a high fan-out orchestration hub with auth, sync, rendering, fallback, account teardown, navigation, and many feature wires.
- Other high-risk large modules include timetable UI (1,434 LOC), mail list (1,144), reader (1,137), timetable model (1,102), Gmail adapter (1,024), background index (758), and outbox (652).
- Extensive explanatory comments preserve historical decisions but also create a risk of “comment-certified correctness.” Several critical boundaries have confident comments that stop one await too early.
- Type checking uses `strict: false` and includes only `app/system/**` plus `mail/store.js`; the most dangerous protocols are unchecked.

---

## O. Release / migration findings

- Version is consistent at 2.0.0 in package and manifest.
- CI has pinned actions, read-only permissions, sharding, smoke evidence, docs/contrast/type/benchmark checks.
- Coverage is not enforced and local `npm test` is not reliable.
- Moving to account namespaces/IDB requires an explicit migration:
  1. identify active account;
  2. move only verifiably owned records;
  3. quarantine unowned outbox/intents;
  4. write schema/account marker atomically;
  5. keep old data until validation succeeds;
  6. make every step idempotent after worker termination.

---

## P. Recovery and observability findings

- Existing counters/logging are useful but not enough to reconstruct cursor transactions or uncertain sends.
- Add safe, durable events: `sync_prepare`, `sync_apply`, `sync_commit`, `sync_replay`, `send_dispatch`, `send_uncertain`, `send_reconciled`, `account_stage`, `account_activate`, and `account_quarantine`.
- Include random operation IDs and hashed/account-local correlation IDs; never email subjects, bodies, addresses, tokens, or raw Gmail payloads.
- Provide a user-safe diagnostic export with schema versions, cursor states, queue state counts, retry counts, and last error codes.
- Recovery runbooks needed:
  - cursor ahead of snapshot → discard cursor and full reconcile;
  - interrupted send → reconcile Sent by stable operation/message ID, otherwise ask user;
  - missing account ownership → quarantine and require confirmation;
  - corrupt derived indexes → rebuild from canonical account records.

---

## Q. Improvement opportunities not caused by current bugs

1. Migrate canonical mail records and sync journal to IndexedDB.
2. Add virtualized/windowed lists before raising the 500-message cap.
3. Replace token-scan prefix search with an indexed prefix/trie strategy for deep history.
4. Expand strict type checking one boundary at a time: runtime messages, Gmail responses, storage records, sync transaction, outbox.
5. Validate runtime messages with centralized schemas and per-verb authorization.
6. Add real Chrome extension tests with worker stop/restart and controlled Gmail fixtures/proxy.
7. Run a manual screen-reader matrix (NVDA/Chrome at minimum) and preserve findings as acceptance tests where automatable.
8. Split `main.js` into account session, sync coordinator, transport/fallback, and boot orchestrators without changing UI behavior.

---

## R. Recommended phased roadmap

### Phase 0 — Immediate credential and release safety

- Revoke the PAT exposed in the audit request; do not place replacement credentials in chat, commits, remotes, or shell history.
- Pause release claims involving reliable background sync or exactly-once sending.
- Disable background cursor advancement or the background sweep until AUD-I01 is fixed.
- Disable automatic retries for non-idempotent send/draft-create outcomes.

**Acceptance:** no background path mutates the foreground cursor; no non-idempotent call retries after an uncertain outcome.

### Phase 1 — Durable sync protocol

- Add account-scoped sync transaction/journal.
- Return next cursor without committing it.
- Durably apply snapshot/journal, then idempotently commit cursor.
- Use a separate notification cursor or derive notifications from committed journal entries.

**Acceptance:** termination injection at every await loses zero adds/removes/patches; replay is idempotent.

### Phase 2 — Exactly-once/uncertain outbound semantics

- Add operation IDs and `uncertain` queue state.
- Remove blind timeout fallback replay.
- Reconcile accepted sends using stable message identity before retry.
- Require explicit user action when delivery cannot be determined.

**Acceptance:** accepted-plus-lost-response fixture produces one sent message; UI says “delivery status unknown,” never falsely “failed.”

### Phase 3 — Account transaction and migration

- Require identity proof before session activation.
- Namespace all account data.
- Fail closed on missing account identity.
- Quarantine legacy unowned queue records.
- Atomically switch active account and clear/retain according to explicit policy.

**Acceptance:** randomized account switches, profile failures, worker restarts, and retained queues never expose or mutate another account.

### Phase 4 — CI and verification

- Fix/replace `npm test` so advertised local command is deterministic under documented resources.
- Add coverage gate to CI and restore outbox branch floor.
- Add the boundary tests above, Chrome worker lifecycle tests, and live-inbox staging soak.
- Expand strict typing and runtime schemas around the repaired protocols.

**Acceptance:** all documented commands pass from clean checkout; CI fails on skipped tests and coverage regression; 24-hour staged soak shows zero cursor gaps and duplicate sends.

### Phase 5 — Maintainability/performance

- Split orchestration hub, migrate deeper data to IDB, add windowing and scalable search.

---

## S. Assumptions and unverified items

- No real Gmail account, real OAuth client, Chrome extension installation, BITS Workspace policy, or live inbox was used. Gmail behavior was evaluated from code contracts and fixtures, not production traffic.
- No browser process was installed/run for visual regression or smoke in this local audit; CI configuration was inspected.
- No assistive technology was run.
- Gmail quota costs were not measured against a real account.
- Branch protection and GitHub repository settings were not accessible from the clone.
- Historical secret presence was searched with Git diff regexes; no current secret literal was found. This does not prove a credential exposed elsewhere remains revoked.
- The repository supports/tolerates one active account at a time; the audit does not assume simultaneous multi-account storage is a requirement, only that switching must be isolated.
- Findings AUD-I03/I04 are HIGH confidence rather than CONFIRMED because a live Gmail accepted-response-loss reproduction was not performed; the duplicate execution path is present in code, while server acceptance timing is the external trigger.
- Performance ratings are based on code, supplied benchmark gates, and test behavior; no low-end-device profile was recorded.

---

## Category ratings (1–10)

| Category | Rating | Evidence-based rationale |
|---|---:|---|
| Correctness | **4** | Strong local invariants, but cursor and side-effect acknowledgement boundaries can lose/duplicate real mail. |
| Security | **7** | Strong CSP/sanitizer/token isolation; account activation and sender/message authorization need hardening. |
| Privacy | **5** | Local-only design and blocked remote images help; global account keys permit cross-account exposure sequences. |
| Data integrity | **3** | Cursor can move ahead of durable state in both background and foreground paths. |
| MV3 lifecycle | **5** | Alarms/listener registration are good; durable transactions/leases and uncertain outcomes are not modeled. |
| Gmail/API semantics | **6** | Pagination, normalization, backoff, 401 and batches are strong; retry policy is unsafe for non-idempotent POSTs. |
| Sync | **3** | Core delta reduction is good; commit protocol is not crash-safe and cursor has competing consumers. |
| Storage / EmailStore | **7** | Excellent in-memory index discipline; persistence is flat, best-effort, non-transactional, and globally scoped. |
| UX | **7** | Rich, deliberate states and workflows; “up to date”/send status can be materially false. |
| Accessibility | **8** | Broad automated semantics, focus, motion, contrast work; no real AT validation. |
| Performance | **7** | Bounded caches/batches/indexes; full suite OOM and scaling ceilings remain. |
| Test quality | **7** | Exceptional breadth; critical cross-context failure combinations are absent. |
| CI / release engineering | **6** | Strong sharding and pinned gates; coverage is unenforced/failing and local canonical test command fails. |
| Maintainability | **6** | Clear modules/comments and no import cycles; central orchestration hub and partial typing raise change risk. |
| Recovery / observability | **5** | Some counters and graceful degradation; no durable sync/send transaction journal or sufficient recovery evidence. |

**Comprehensive rating: 5.6 / 10.**

The smallest safe first milestone is: **separate the background notification cursor from the app-state cursor and stop retrying non-idempotent Gmail operations after uncertain outcomes.** Those two changes immediately remove the largest inbound and outbound blast radii while the full transactional redesign is built.
