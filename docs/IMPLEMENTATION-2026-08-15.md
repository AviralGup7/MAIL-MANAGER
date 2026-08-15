# Implementation Plan — 2026-08-15 System-Wide Audit Findings

Companion to `audits/2026-08-15-SYSTEMWIDE-AUDIT.md`. Every finding is
mapped to a concrete change, the files it touches, and the regression test
that pins it. Standing constraint from the owner: **nothing is removed;
any behavioral removal becomes a setting that defaults to the safe
position and can be switched on the settings page.**

Statuses: ✅ landed · ◻ planned.

| Finding | Resolution | Gates as a setting? |
|---|---|---|
| AUD-C1 silent renewal follows browser account | ✅ P0 | no (pure safety floor) |
| AUD-C2 outbox unscoped/uncleared | ✅ P0 | **YES — `clearOutboxOnSignOut` (def true)** |
| AUD-M1 snoozed mailbox offline reads as empty | ✅ P1 | no (honest error surface) |
| AUD-M2 toolbar opens first Gmail tab, any authuser | ✅ P3 | prefers matching authuser, falls back to old behavior |
| AUD-M3 notify dedupe race | ✅ P1 | no |
| AUD-M4 renewal retry weaker than comment | ✅ P2 | no |
| AUD-L1 non-finite snooze `at` reaches alarms.create | ✅ P1 | no |
| AUD-L2 notification subject unscrubbed | ✅ P1 | no |
| AUD-L3 no double-injection DOM guard | ✅ P1 (DOM-level guard) | no |
| AUD-Q2 parseBatch no id validation + no adversarial pins | ✅ P2 | no |
| AUD-T1 test gaps | ✅ filled per finding | — |
| AUD-Q1 no instrumentation | ✅ P3 minimal counters | no |
| AUD-N1 idb adoption | ◻ decision recorded below (defer) | — |

## P0 — account identity (AUD-C1 + AUD-C2)

**Root fix:** the account becomes an identity, not an assumption.

1. `src/background/auth.js`
   - `signIn`: after consent, read `profile().emailAddress` (best-effort;
     a failed read stores nothing, never blocks sign-in) and persist
     `accountEmail`.
   - `renew()`: after minting silently, validate — fetch the profile and
     compare (lowercased, trimmed) with stored `accountEmail`:
     - **fetch failed** → treat as transient (`AUTH_RENEW_TRANSIENT`):
       nothing persisted, nothing cleared. The destructive default is the
       one thing this design refuses.
     - **mismatch** → clear the auth-owned set (`accessToken`, `expiresAt`,
       `authorized`, `historyId`, `bgNotifiedIds`, `accountEmail`), throw
       `ACCOUNT_CHANGED`. The caller layers finish the teardown.
     - **match, or nothing stored (legacy upgrade)** → persist token;
       stamp `accountEmail` when it was missing.
   - Profile read lives in auth.js as a minimal direct fetch, NOT a
     gmail.js import: auth→gmail→auth is an import cycle, and one tiny GET
     duplicated beats a cycle (comment says so).
   - `signOut` removes `accountEmail` too.
2. `src/background/index.js` — `onMessage` wrapper: on `ACCOUNT_CHANGED`
   from any verb, `_clearLabelCache()` before responding. Label ids are
   account-scoped; the in-page fallback does the same in its wrapper.
3. `src/features/outbox/model.js`
   - `enqueue(draft, { accountEmail })` stamps the record; `normaliseOutbox`
     preserves it (string-only).
   - `dispatchable(item, accountEmail)` — pure: unmarked legacy rows pass,
     marked rows must match. The worker pump skips non-dispatchable items
     (they stay queued, armed for the account that owns them) and reports
     `wrongAccount: n` when it skipped any.
   - `clearOutbox(storage)` — the first removal verb the queue ever had,
     and its caller is the *setting*, not the worker.
4. `src/app/system/settings.js` + `settings-panel.js` — **the removal, as a
   setting**: `clearOutboxOnSignOut: { type:'bool', def:true }`, composing
   section: "Cancel unsent messages when I sign out". Default ON = the
   audit's safe floor; OFF is for people who sign out and back into the
   SAME account and want the queue to wait.
5. `src/app/main.js`
   - Sign-out handler: when `clearOutboxOnSignOut`, `await clearOutbox()`.
   - `send()` error path: an `ACCOUNT_CHANGED` error runs the same local
     teardown as sign-out (cache, bodies, intents [+ outbox per the
     setting], stores) and gates with an account-changed message.
   - Enqueue call sites stamp `accountEmail: state.selfEmail`.
6. `src/app/system/storage-registry.js` — `accountEmail` row (owner
   auth.js, backup:false, credentials/identity class).

**Tests:** `test/account-identity.test.mjs` — sign-in stamps; renewal
match keeps; renewal mismatch clears the five keys + throws
ACCOUNT_CHANGED and refuses a queued send (`dispatchable`); validation
fetch failure clears nothing; legacy no-email first renewal stamps;
`clearOutbox` empties; normalise preserves the stamp; unmarked legacy row
dispatches. Settings wiring rides the amended `settings-panel.test` (11
checkboxes) and `options.test` coverage (key has a control).

## P1 — honest failures (M1, M3, L1, L2, L3)

1. **M1** `background/index.js` `SYNC_PAGE`: only the label-created-but-
   absent classification returns an empty page; network/auth/server
   failures rethrow into the app's existing error surface (the "empty
   means empty" contract).
2. **M3** `backgroundSync` single-flights on a module flag (the
   `outboxPumping` pattern); the dedupe merge is pure
   (`notify.js: mergeNotified`) and pinned: two overlapping sweeps over one
   delta notify ≤ once per id by construction of the flag, and the merge
   keeps order + 100-cap.
3. **L1** the wake-time selection moves into `src/features/snooze/model.js` as
   pure `nextWakeAt(all, now)` (finite filter, `max(next, now+5000)`);
   index.js delegates. Non-finite entries can no longer reach
   `alarms.create`.
4. **L2** `notify.js: cardText(msg)` owns the card strings — sender AND
   subject scrubbed of control characters and capped (the #50 treatment,
   both fields, one place).
5. **L3** `content.js` takeOver aborts if a live `#bmm-takeover-host`
   already exists in the DOM (cross-instance guard the per-instance state
   machine cannot express).

**Tests:** `test/audit-hardening.test.mjs` — M1 classification helper pin
(if extracted pure) + wake selection + merge + cardText; the content.js
guard is a source/consumer pin beside the takeover's existing contract
tests.

## P2 — coverage & parser (Q2, M4)

1. **Q2** `gmail.js batchMetadata`: parts whose `id` is not in the
   requested set are refused before normalise (valid traffic unchanged;
   a phantom can no longer be ingested). `test/fuzz-parsebatch.test.mjs`:
   hostile bodies, boundary-in-content, mixed 2xx/5xx pages, duplicated
   parts, phantom ids — never throws, never yields an unrequested id, and
   honest parts still parse.
2. **M4** the SYNC_ALARM handler re-arms auth: on
   `AUTH_RENEW_TRANSIENT` a one-shot `bmm-auth-retry` alarm (5 min) retries
   `getToken()`; the comment keeps its promise through a channel workers
   actually have.

## P3 — economics & scale (Q1, N1-adjacent, M2 above)

1. **Q1** `src/background/diag.js` — a tiny counter module (requests,
   retries, notifications, renewals, mismatch-clears), in-memory in the
   worker, persisted to `diagCounters` on each SYNC_ALARM tick (registry
   row, backup:false, documented as best-effort: the MV3 worker is
   lossy by design).
2. **N1 decision:** idb.js adoption is DEFERRED to the windowing milestone
   (store cap 2000, cache 500 — no user-visible pressure today); the
   adapter and its suite stay, the review point is the G2 milestone.
3. **M2** `openGmailTab` prefers a tab whose `/mail/u/N/` matches the
   session's authuser (reported by the takeover frame; stored as
   `activeAuthUser`), falling back to the current first-tab behavior when
   unknown — recorded in P3 rather than P1 because it needs the session
   index plumbing, and the old behavior is preserved as the fallback.

## Order of landing

Plan doc (this file) → P0 → P1 → P2 → P3, each its own commit with its
own push before its tests run locally; README's declared count moves with
each new test file (doc gate), and CI is watched to green at the final
push.
