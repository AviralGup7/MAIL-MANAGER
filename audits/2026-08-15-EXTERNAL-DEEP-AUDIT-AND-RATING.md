# External Deep Audit & Comprehensive Rating — BITS Mail Manager

**Commit audited:** `f53175c` (main, clean tree, `origin/main` identical)
**Date:** 2026-08-15 · **Auditor:** external, no prior involvement
**Environment:** Node v20.20.2, npm 10.8.2, clean clone, `npm ci` from committed lockfile
**Posture:** audit only. **No production file was modified by this audit.** The
only file added is this report.

**Headline verdict: 5.4 / 10.** The reasoning is in §R. Short version: the
engineering *discipline* here is genuinely unusual — a 1.06:1 test-to-source
ratio, a real sanitiser, a real batch parser, a documented storage registry,
eight-way sharded CI with an aggregate verdict job. But the product has
**never once run in a browser against a real inbox** (the README says so),
the OAuth flow it depends on is **removed in OAuth 2.1 and actively being
retired by Google**, the local test suite **does not pass as invoked**
(`npm test` → 1 failure, OOM), and a large fraction of the test mass is
**source-text pinning rather than behaviour**. A product that cannot be shown
to work in its target runtime cannot be rated as if it does.

---

## A · Executive risk summary

### What I verified myself (commands, not claims)

| Check | Command | Result |
|---|---|---|
| Install | `npm ci` | clean, lockfile honoured |
| Full suite | `npm test` | **2010 tests, 1 FAIL** — `app.mail.integration.test.mjs` aborts SIGABRT, V8 heap OOM at ~919 MB |
| Same file alone, CI ceiling | `node --max-old-space-size=3072 --test test/app.mail.integration.test.mjs` | 108/108 pass, 456 s |
| Types | `npm run types` | clean |
| Docs invariants | `npm run docs:check` | 6/6 |
| Coverage gate | `npm run coverage` | all protected modules above floors; **all-files 83.22% line** |
| Contrast | `npm run contrast` | 6 themes AA |
| a11y (axe) | `npm run a11y` | 2/2, 0 skipped |
| Bench | `npm run bench` | classify 2000 = 13.1 ms, store 2000 = 55.0 ms, 100 searches = 32.0 ms |
| Load-time doctor | `npm run doctor` | worker graph 20 modules resolved |

### The five things that decide the rating

1. **UNVERIFIED IN THE TARGET RUNTIME (blocking).** The README states plainly:
   "Still not run in Chrome against a real inbox." Every OAuth path, the
   takeover over live Gmail, MV3 worker registration (which the repo's own
   `fallback.js` exists because it *failed* with "Status code: 2"), alarm
   delivery, notification cards, and every real-network Gmail semantic are
   asserted by mocks written by the same author as the code. This is not a
   test-coverage complaint; it is a **category** complaint: the suite cannot
   falsify the assumptions it was written from.

2. **THE AUTH FLOW IS ON A DEPRECATION PATH (CRITICAL).** `auth.js` uses
   `response_type=token` — the OAuth 2.0 implicit grant. OAuth 2.1 **removes
   it entirely**, and identity providers including Google have been retiring
   it. The file argues at length that Google blocks every alternative for this
   client shape; that argument is well-made and was probably true when
   written, but the conclusion — "so we ship the removed grant" — leaves the
   product's *only* way to authenticate on a flow whose vendor-side sunset is
   outside the project's control and has no fallback in the codebase. There is
   no `chrome.identity.getAuthToken` path, no code-with-PKCE path behind a
   flag, no detection, no user-facing message for the day it 400s.

3. **`npm test` — the documented command, in the README, in CONTRIBUTING —
   FAILS on a clean checkout (HIGH).** `package.json` sets
   `--max-old-space-size=1400`; the integration file needs ~3072 (which
   `tools/ci-test.mjs` knows and sets). CI is green because CI uses the other
   runner. So the repo ships a red default command and a green CI, and the
   README's "1,998+ declared tests pass, 0 skipped" is true only under a
   command the README does not give.

4. **A LARGE FRACTION OF THE SUITE PINS SOURCE TEXT, NOT BEHAVIOUR (HIGH).**
   99 of 153 test files call `readFileSync`; 92 of those pair it with
   `assert.match`. 1231 of 5054 assertions are regex/`includes` shape checks.
   Tests of the form "the source contains `setAttribute('role','tablist')`"
   pass when the code is right, pass when the code is right-but-dead, and
   fail on a rename that changes nothing. This inflates the headline test
   count and weakens the safety net exactly where refactoring pressure is
   highest.

5. **ERROR CLASSIFICATION IS SUBSTRING MATCHING ON HUMAN-READABLE STRINGS
   (HIGH, with a reproduced destructive case).** Reproduced in this audit:
   `history()` decides "cursor expired → throw the whole local mailbox away
   and full-resync" with `String(err).includes('404')`. A **transient 503
   whose URL contains a history id with `404` in it** — e.g.
   `Gmail 503 /history?startHistoryId=4045678…` — takes the destructive
   branch. Symmetrically, `reportError` in `main.js` decides "session
   expired, show the sign-in gate" with `/401|invalid_grant/i`, which fires on
   `Gmail 500 /messages/18f401ab77cd0e12/modify` because the *message id*
   contains `401`. Both verified by direct evaluation (§D, EXT2-C2).

---

## B · Architecture map (measured, not documented)

```
                       ┌─────────────────────────────────────────┐
  Gmail tab            │ src/takeover/content.js  (isolated world)│
  mail.google.com  ───▶│  hides Gmail roots, mounts <iframe>,     │
                       │  mints a per-mount embed nonce           │
                       └───────────────┬─────────────────────────┘
                                       │ postMessage (nonce-checked both ways)
                       ┌───────────────▼─────────────────────────┐
  chrome-extension://  │ app.html → src/app/main.js  (3884 lines) │
                       │  Store · cache · body-cache · intents ·  │
                       │  outbox UI · reader (sandboxed srcdoc)   │
                       └───────────────┬─────────────────────────┘
                                       │ chrome.runtime.sendMessage (verb router)
                       ┌───────────────▼─────────────────────────┐
  service worker       │ src/background/index.js (784 lines)      │
                       │  auth.js · gmail.js · sync.js · mime.js  │
                       │  notify · diag · tab-pick                │
                       └───────────────┬─────────────────────────┘
                                       │ HTTPS
                              gmail.googleapis.com / accounts.google.com

  Degraded path: src/app/system/fallback.js dynamically imports the SAME
  background modules into the page when the worker will not answer. The
  OAuth token then lives in the app document instead of the worker.
```

**Measured shape:** 115 JS modules, 34,627 lines JS + 7,997 CSS in `src/`;
152 test files, 36,724 lines. Ratio 1.06:1. Largest module `app/main.js`
(3,884 lines, 69 top-level functions); next `timetable-ui.js` (1,434),
`mail/list.js` (1,163), `mail/reader.js` (1,140), `classify/pattern-rules.js`
(1,059, generated), `background/gmail.js` (1,048).

**Layering is real and enforced** by `test/architecture.test.mjs` (classify is
pure; shared is a leaf; background never imports app; app never statically
imports background). I checked the claims by grep and they hold. `doctor.mjs`
independently proves the 20-module worker graph resolves with no DOM
references. This is the strongest part of the codebase.

**Where the architecture leaks:** `app/main.js` is a god module — it owns the
verb bridge, timeouts, fallback degradation, account teardown, ingest, sync
orchestration, theming, deep links, boot and ~20 event wirings. It is the
single point every subsystem passes through, and its `ctx` object is the
de-facto service locator.

---

## C · Complete findings table

Severity: CRITICAL / HIGH / MEDIUM / LOW / INFO. Confidence: CONFIRMED (I ran
it), HIGH (code-evident, no runtime), MEDIUM, LOW.

| ID | Sev | Conf | Subsystem | Finding |
|---|---|---|---|---|
| EXT2-C1 | CRITICAL | CONFIRMED | Process/product | Never executed in Chrome against a real inbox; every runtime claim rests on self-authored mocks |
| EXT2-C2 | CRITICAL | CONFIRMED | Sync/errors | `history()` takes the destructive resync branch on any error string containing `404`, incl. transient 5xx whose URL carries a history id with those digits |
| EXT2-C3 | CRITICAL | HIGH | Auth | Sole auth path is the OAuth implicit grant, removed in OAuth 2.1 and being retired by Google; no fallback flow, no detection, no user message |
| EXT2-H1 | HIGH | CONFIRMED | CI/tests | `npm test` (the documented command) fails: OOM/SIGABRT in `app.mail.integration.test.mjs` under the script's own 1400 MB ceiling |
| EXT2-H2 | HIGH | CONFIRMED | Test quality | 99/153 test files read source text; 1231/5054 assertions are regex/substring pins over source, not behaviour |
| EXT2-H3 | HIGH | CONFIRMED | Store/API | `Store.idsFor(category)` returns the **live memoised array** for non-`all` categories; a consumer mutating it corrupts the store's answers permanently (reproduced) |
| EXT2-H4 | HIGH | CONFIRMED | App/errors | `reportError` signs the user out on any error text matching `/401/` — including a Gmail message id containing `401` |
| EXT2-H5 | HIGH | HIGH | Outbox | Crash-demoted `sending` rows become `failed, attempts:0, nextAttempt:0` = **immediately due**; a worker killed after Gmail accepted the send re-sends on next pump (reproduced state transition) |
| EXT2-H6 | HIGH | HIGH | MV3 | The one durable background feature (`bgNotify` sweep) is **disabled by a constant** (`BACKGROUND_SYNC_ENABLED = false`) while `notifications` permission, UI copy and dedupe machinery all still ship |
| EXT2-H7 | HIGH | CONFIRMED | Search | Tokeniser splits on `[^a-z0-9@.\-]+`, so **all non-Latin text is unsearchable**: Devanagari/CJK subjects produce zero tokens; `café` indexes as `caf` |
| EXT2-H8 | HIGH | HIGH | Fallback | Degraded mode moves the OAuth token into the document that renders mail, silently reversing the security property the README advertises |
| EXT2-M1 | MED | CONFIRMED | Batch parser | `parseBatch` drops any sub-response whose JSON body contains a blank line (`\n\n`) — reproduced: part silently vanishes, no error |
| EXT2-M2 | MED | CONFIRMED | Batch parser | Boundary is re-derived from the response text by regex rather than from the request's own boundary; a body containing the boundary token splits the part (reproduced) |
| EXT2-M3 | MED | HIGH | Sync | `syncPage` non-inbox mailboxes never advance the cursor, but `server-search` results are ingested into the inbox store as `fromSearch` records with the same lifecycle — two truth sources in one store |
| EXT2-M4 | MED | HIGH | Storage | Whole-blob JSON writes (`msgCache` ~500 rows, `bodyCache` ~2 MB, `outbox`, `intents`) with no `getBytesInUse` check anywhere; quota is reasoned about in comments, never measured at runtime |
| EXT2-M5 | MED | HIGH | Concurrency | Cross-tab outbox lock is *settle-and-verify with a 25 ms sleep* — a probabilistic mutual-exclusion protocol for the one operation whose failure sends duplicate mail |
| EXT2-M6 | MED | HIGH | Auth | `dispatchable()` fails **open** for unstamped legacy rows: an unowned queued send dispatches under whatever account is signed in |
| EXT2-M7 | MED | HIGH | Maintainability | `app/main.js` at 3,884 lines with 69 top-level functions is the system's single choke point and its de-facto DI container |
| EXT2-M8 | MED | CONFIRMED | Docs | README simultaneously claims "1,998+ declared tests" and "runs all 1339"; `docs:check` validates only the first number |
| EXT2-M9 | MED | HIGH | Privacy | `imageAllow`, `activityLog`, `queryHistory`, `bodyCache` are **not account-namespaced**; only sign-out clearing separates accounts, and only if it completes |
| EXT2-M10 | MED | HIGH | Perf | Search prefix matching iterates **every token in the index** per term (`for (const [tok] of this.searchIndex)`) — O(vocabulary) per keystroke; 6,002 tokens at 2,000 messages |
| EXT2-M11 | MED | HIGH | Release | No `LICENSE` file; no versioned release process; version 2.0.0 is in three files kept in step only by a test |
| EXT2-M12 | MED | HIGH | Errors | 122 catch blocks in `src/` swallow silently by policy; several ("best-effort", "doctrine") hide storage failures that change user-visible truth |
| EXT2-L1 | LOW | CONFIRMED | Options | v1's client ID is shipped as a one-click "use default", re-centralising the failure mode the project's own security story rejects |
| EXT2-L2 | LOW | HIGH | Repo | 652 KB of committed institutional timetable data + two raw source `.txt` files inside the extension package |
| EXT2-L3 | LOW | HIGH | Diag | `persistDiag()` is only reached from the `SYNC_ALARM` branch, which is disabled by EXT2-H6 — the counters never flush in production |
| EXT2-L4 | LOW | HIGH | Perf | `test/app.mail.integration.test.mjs` takes **456 s** alone; the suite is ~3.5 min sharded and much longer serially |
| EXT2-L5 | LOW | HIGH | A11y | axe run is restricted to 9 rules on two static shells; no dynamic-state, no live-region, no real AT pass (the repo's own A-A9 debt) |
| EXT2-I1 | INFO | CONFIRMED | Security | Sanitiser survived 13 adversarial payloads I threw at it, including `<svg/onload>`, tab-split `java\tscript:`, `data:text/html`, `data:image/svg+xml`, DOM-clobbering `name/id="attributes"` |
| EXT2-I2 | INFO | CONFIRMED | Security | No `eval`, no `new Function`, no `document.write`, no `insertAdjacentHTML`; 9 `innerHTML` sites, all author-controlled literals |
| EXT2-I3 | INFO | CONFIRMED | Supply chain | Zero runtime dependencies; 6 devDependencies; CI actions pinned by SHA; weekly `npm audit --audit-level=high` off the push path |

---

## D · Critical correctness findings

### EXT2-C2 — `404` substring decides whether to destroy the local mailbox
**CONFIRMED · CRITICAL · correctness + data integrity**

`src/background/gmail.js:518`:
```js
try { data = await api(`/history?${params}`); }
catch (err) { if (String(err).includes('404')) return { tooOld: true }; throw err; }
```
`{tooOld:true}` propagates to `syncDelta()` → `kind:'resync'` → the app calls
`resetView()`, `clearCache()`, and refetches from zero.

The error strings `api()` throws are built as
`` `Gmail ${res.status} ${label} ${body.slice(0,200)}` `` where `label` is the
**path including the query string** — which contains `startHistoryId=<digits>`.
Reproduced:

```
"Gmail 503 /history?startHistoryId=4045678&maxResults=500 service unavailable"
  → includes('404') === true  → tooOld → full destructive resync
"Network error on /messages/1a404bd/modify: fetch failed"
  → includes('404') === true
```

**Blast radius.** A transient Gmail 5xx during a delta throws away the warm
cache, the store, and re-pulls the whole first page — burning quota, losing
scroll/selection, and (because `resync` clears the cursor) widening the
window in which mail can be missed. Trigger frequency: Gmail 5xx during
`/history` is routine. **Real Gmail also returns 404 for an expired cursor**,
so the intended case works — which is exactly why this survives testing.

**Fix direction.** `fetchRetrying` already has `res.status`. Attach it as
`err.status` (and `err.code`) and branch on `err.status === 404`. Same change
retires EXT2-H4 and half of EXT2-M12. Regression test: a 503 whose URL carries
`404` digits must NOT resync.

### EXT2-H4 — a message id containing `401` signs the user out
**CONFIRMED · HIGH**

`src/app/main.js:1836`: `else if (/401|invalid_grant|No refresh token/i.test(msg))`
→ `state.signedIn = false; opEpoch++; showGate('Session expired. Sign in again.')`.
Gmail message ids are hex; `18f401ab77cd0e12` contains `401`. Reproduced: a
`Gmail 500 …/messages/18f401ab77cd0e12/modify` error takes the sign-out branch.
The user is ejected to the gate by a backend blip on one message.

### EXT2-H3 — `Store.idsFor()` hands out live internal state
**CONFIRMED · HIGH · correctness**

`store.js:383`. The `'all'` path correctly `.slice()`s — with a long comment
explaining exactly why aliasing was a bug once. The **category** path returns
`this._memoGet(...)` — the memo's own array, uncopied. Reproduced:

```js
const a = s.idsFor('augsd');  a.push('POISON'); a.sort();
s.idsFor('augsd')  // → ['POISON','m0','m1','m2','m3','m4']
const first = s.idsFor('augsd'); first.length = 0;
s.idsFor('augsd')  // → []   (category now reads as empty until the next flush)
```

No current consumer mutates it — I checked all 19 call sites — so this is
latent. But the file's own comment establishes that "no caller does X" is not
an invariant here, and the fix is one `.slice()`.

### EXT2-H5 — crash-demoted sends are immediately re-dispatchable
**HIGH · reproduced state transition**

`normaliseOutbox` demotes a persisted `sending` row to
`{state:'failed', attempts:0, nextAttempt:0}`. `dueItems` returns any `failed`
row with `attempts < MAX && nextAttempt <= now` — so a row demoted after a
worker kill is due **instantly**:

```
input : {state:'sending', attempts:0}
output: {state:'failed', attempts:0, nextAttempt:0}
dueItems(...) → ['x']            // dispatched on the very next pump
```

The code documents the trade ("a duplicate is embarrassing, a mail that never
went is worse") and that judgement is defensible — but it is made *silently
and automatically*, with no cooling-off, no user prompt, and no check of
Gmail's Sent folder, even though the `uncertain` state (which does exactly
that: "check Sent before retrying") already exists and is used for
`OUTCOME_UNKNOWN`. A worker killed mid-`sendMessage` — the single most likely
MV3 event — should land in `uncertain`, not in `failed & due`.

### EXT2-H6 — the background feature the permission exists for is switched off
**HIGH**

`src/background/index.js:572`: `const BACKGROUND_SYNC_ENABLED = false;`, with
an honest comment (the sweep and the app shared one cursor — CAN-SYNC-1). The
consequences that still ship:

- `"notifications"` permission in the manifest with **no reachable caller**
  (the only `chrome.notifications.create` is inside the disabled sweep).
- Settings UI carries the toggle labelled "temporarily unavailable, disabled".
- `persistDiag()` is only invoked from the disabled alarm branch (EXT2-L3), so
  the AUD-Q1 diagnostics never reach storage in production.
- `bgNotifiedIds` dedupe, `notify.js`, `cardText` — all dead weight.

An unused permission is a Web Store review risk and a least-privilege
violation; "temporarily" has already survived at least one audit round.

---

## E · Security findings

**What is genuinely good, verified adversarially.** I ran 13 payloads through
`sanitizeHtml` in jsdom. All neutralised: `<svg/onload=alert(1)>` → dropped
entirely, `jAvAsCrIpT:` and `java\tscript:` → attribute refused,
`data:text/html,<script>` → refused, `data:image/svg+xml` → refused (raster
allow-list), `<form><input name="attributes">` → dropped with contents
(DOM-clobbering closed), `position:fixed` → filtered out of `style`,
protocol-relative `//evil.com` → refused. Depth is bounded at 1024 with a
documented overflow measurement. The reader iframe has no `allow-scripts`, no
`allow-same-origin`, and a `default-src 'none'` srcdoc CSP derived from the
same `allowRemote` decision the sanitiser used — **one decision, two
consumers**, which is the correct shape. MIME walk bounded at 64. Header
injection (CRLF in To/Cc/Subject/References) is scrubbed at the wire, with the
reply-path attack (`Reply-To: x\r\nBcc: harvest@evil`) documented as
previously exploitable and now closed. Embed provenance uses a per-mount
nonce; all three `postMessage` listeners check source **and** nonce; the app
refuses to boot in an unrecognised embed. Content-script chord requires
`isTrusted`. This is materially better than most extensions I have read.

**Where it is weaker than it reads:**

- **EXT2-C3 (auth flow).** Covered above. Additionally: `include_granted_scopes=true`
  means the token may carry scopes beyond the two requested if the user granted
  them elsewhere to the same client — a quiet widening.
- **EXT2-H8 (fallback token relocation).** `fallback.js` dynamically imports
  `auth.js` into the app document. The README's second security bullet —
  "The access token lives **only in the service worker**" — becomes false in
  degraded mode, which is not an exotic path: the fallback exists *because
  worker registration failed in practice*. The file's own comment concedes the
  point ("Still the extension origin"), but the extension origin is the
  document that renders mail bodies. The mitigation (sandboxed reader) is
  real; the README's claim is still wrong.
- **EXT2-M6.** `dispatchable()` returns `true` for an unstamped row regardless
  of session — fail-open on the send path.
- **EXT2-L1.** `options.js:48` ships v1's client ID with a one-click "use
  default" button, re-creating the single shared credential the security story
  rejects. (It is a client *ID*, correctly not a secret — but it is also the
  client whose *secret* is documented as leaked and unrotated in `SECURITY.md`.)
- **`SECURITY.md` and `DO-THIS-NOW.md` both state that a live Google client
  secret and two GitHub PATs are still unrotated.** The repo cannot fix that;
  it is, correctly, documented. It remains an open CRITICAL for the owner.

**On the PAT in this audit's request.** The token supplied in the task prompt
(`ghp_…`) was transmitted in plaintext and must be treated as burned. I have
not written it to any file, and `test/secrets.test.mjs` would refuse a commit
containing that shape. Revoke it.

---

## F · Data-integrity findings

`msgCache` packing is the best-documented part of the storage layer: fields are
either stored or provably re-derived, with per-field reasoning and a widening
strategy that degrades old blobs instead of failing to parse. `historyId` is a
prepare/commit protocol — the worker returns `anchorHistoryId`, the app
persists, *then* sends `SYNC_COMMIT`, and `commitHistoryId` refuses to move a
numeric cursor backwards. `reduceHistory` folds records into one ordered map so
`added`/`removed` are disjoint by construction. These are real, and several
were clearly learned the hard way.

Remaining gaps:

- **EXT2-M4 · quota is asserted, never measured.** `CACHE_MAX = 500` is
  justified as "≈1 MB, an order of magnitude inside the 10 MB limit"; `bodyCache`
  budgets 2 MB; `activityLog` 500 entries; `intents`, `outbox`, `savedViews`,
  `templates`, `timetable` (652 KB of course data!) are unbounded-ish or
  separately capped. Nothing calls `chrome.storage.local.getBytesInUse`. The
  failure mode is a *write rejection*, and every writer catches it silently
  (`saveOutbox` → `return false`, `persist` in intents → `return false`). The
  saver has an `onError` hook, which is good; the queue writers do not.
- **No corruption detection beyond per-row filtering.** Malformed rows are
  dropped individually (correct), but there is no checksum, no "this blob was
  half-written" signal, and no repair flow that tells the user local state was
  rebuilt. `clear()` + resync is the only recovery.
- **EXT2-M9 · account namespacing is by deletion, not by key.** `historyId`,
  `accountEmail`, `bgNotifiedIds`, token keys are cleared at sign-out; the
  outbox is cleared under a setting; `imageAllow`, `activityLog`,
  `queryHistory`, `savedViews`, `templates`, `followups`, `deadlineOverrides`,
  `myCourses` are **not**, by design (they are "user investment"). That design
  is defensible for a single-user install and wrong for a shared machine: the
  next account inherits the previous one's remote-image trust list and a
  fourteen-day log of what was done to the previous account's mail. Real
  namespacing (`<accountHash>:key`) is the fix; clearing is not.

---

## G · MV3 lifecycle findings

The doctrine is stated and mostly kept: listeners registered synchronously at
module top level, `chrome.alarms` for durable scheduling, worker holds no
message state, `wakeDue()` runs on both `onStartup` and `onInstalled` so a
missed alarm is a late delivery rather than a lost one, guards (`chrome.action?.`)
so a manifest gap costs a feature instead of aborting worker evaluation.
`AbortSignal.timeout(30_000)` on every fetch closes the hung-connection class.

Gaps:

- `scheduleRenewRetry()` registers `globalThis.addEventListener('online', …)`
  and a 60 s `setTimeout` — **and the comment admits neither works in a service
  worker** — before arming the alarm that does. Two of three channels are
  decoration; in the page-fallback context they are the only ones, which is
  presumably the intent, but the code does not distinguish contexts.
- `outboxPumping`, `bgSyncRunning`, `renewRetryArmed`, `inFlight`,
  `sessionEpoch`, `labelIdCache` are **module globals in a process that dies
  between awaits**. Each is individually reasoned about; collectively they mean
  a worker restart mid-pump silently releases every guard. EXT2-H5 is this
  class landing on the send path.
- **No lifecycle test harness.** There is no test that terminates and
  reincarnates the worker module between awaits; `worker-dispatch.test.mjs`
  exercises `_testHandle` with stubs in one continuous process. Restart
  behaviour — the stated top risk in the file headers — is verified by
  reasoning only.

---

## H · Gmail/API findings

Correct and better than typical: `maxResults` clamped, `labelIds` appended
individually, `pageToken` threaded, `format=metadata` with an explicit header
allow-list, batch capped at Gmail's 100, history paginated to exhaustion or
declared `tooOld` (never a partial cursor advance), `Retry-After` honoured with
a 30 s ceiling, jittered exponential backoff, 429/5xx retried, 403 split by
body text into quota-vs-scope, 401 returned to the owner so `api()` can renew
once and then hard-fail as `AUTH_REVOKED`, non-idempotent callers pass
`retry:false` and get `OUTCOME_UNKNOWN` rather than a silent second send.
`batchMetadata` whitelists returned ids against requested ids and treats an
all-empty batch as failure rather than an empty inbox. That last pair is the
kind of thing most codebases learn about after an incident.

Defects found:

- **EXT2-M1 (CONFIRMED).** `parseBatch` splits each part on `/\r?\n\r?\n/` and
  requires `chunks.length >= 3`, then rejoins `chunks.slice(2)`. A JSON body
  containing a literal blank line is handled — but a body whose **snippet
  contains `\n\n`** produced zero parsed parts in my reproduction:
  `parseBatch(...{"id":"z","snippet":"a\n\nb"}...)` → `[]`. The part is dropped
  with no error; if every part in a batch does this, the all-failed guard fires
  and the sync errors — but a *mixed* batch silently loses messages.
- **EXT2-M2 (CONFIRMED).** The boundary is recovered by regex from the response
  body rather than from the boundary the request generated (which is right
  there in scope). A body containing the boundary token splits the part:
  my nested-boundary probe lost the second message entirely and returned only
  the first. Google will not do this; a proxy, a mangled retry, or a future
  format change might.
- `MAX_HISTORY_PAGES = 10` (5,000 records) → `tooOld`. Reasonable, but it means
  a heavy week produces a **full resync**, not an error, and the user is never
  told why their mailbox reloaded.
- Quota accounting exists nowhere. A resync is 1 list + N batch per 100
  messages; the destructive-resync bug (EXT2-C2) multiplies that by however
  often Gmail 5xxs. No metric would show it (EXT2-L3 kills the counters).

---

## I · Sync findings

The prepare/commit split is the right architecture and is implemented with real
care: the cursor is read *before* listing (documented with the exact
lost-mail timeline that motivated it), only the inbox may advance it, and the
app commits only after `persistBeforeCursor()` proves the local write landed
(`SYNC_NOT_DURABLE` if not). `opEpoch` invalidates in-flight responses across
sign-out and account change. `MAX_DELTA_ADDS = 500` falls back to resync
without advancing.

Weaknesses:

- **Two consumers of one cursor, resolved by disabling one** (EXT2-H6). The
  honest containment is better than a silent race, but the product is left
  without background sync, which is most of the point of an MV3 extension.
- **Resync is unconditional data destruction with no user signal.** `resetView`
  + `clearCache` + refetch. Combined with EXT2-C2 this is reachable from a
  transient 503.
- **`fromSearch` overlay records live in the same store** as canonical mail,
  excluded from counts by a per-record flag checked in `counts()`,
  `unreadCounts()` and the cache writer. Three places must remember; one
  forgetting is a wrong number the user cannot explain.
- **No sync metrics, no queue-depth, no lag** — see §P.

---

## J · Storage / EmailStore findings

`Store` is the strongest single module: incremental indexing (no `rebuild()` in
any hot path), binary-search ordered insert, batch coalescing to one
notification, per-version memoisation cleared on flush, `_deindex` removes
empty Sets so counts cannot see phantom categories, date-change repositioning
handled in **both** `upsert` and `patch` (the latter by delegation, so one
implementation), eviction at 2,000 newest-first. Measured by me: 2,000 upserts
in 48 ms, 20 prefix searches in 22 ms, 6,002 tokens. Coverage 99.5% line / 88%
branch. This module deserves its reputation.

Faults:

- **EXT2-H3** — the aliasing hole in the category path (§D).
- **EXT2-M10** — prefix search scans the whole token map per term. At 6 k
  tokens × per-keystroke, fine; at 10× the corpus (the roadmap's own G2 goal)
  it is the first thing to break. A trie or sorted-key binary search is the
  standard fix.
- **EXT2-H7** — the tokeniser's character class is Latin-only. Verified:
  `परीक्षा समय सारणी` and `考试时间表` produce **no tokens at all** and are
  unfindable; `Café résumé` indexes as `caf`/`sum`. For an Indian university
  mailbox this is not hypothetical. Note the *free-text predicate* in
  `selectors.matchesQuery` uses `includes()` and **would** match — so search
  behaves differently depending on whether the term reaches the index or the
  predicate. Two semantics, one search box.
- Threads are derived, never cached — correct, and the reasoning
  ("a cached summary is one more thing that can drift") is right.

---

## K · UX / accessibility findings

Strong: axe passes on both shells; 16 `:focus-visible` rules; reduced-motion is
a first-class branch (the takeover *cuts* instead of animating, particles are
never created); WCAG AA across all 6 themes by an actual contrast tool; empty
states distinguish "you cleared this" from "this was always empty" (with a
documented load-bearing coincidence and a named tripwire test — unusually
honest); `aria-activedescendant` listbox; deep links so a refresh restores the
view; `inert` on Gmail's roots with the correct explanation of why `inert` on
`body` broke everything.

Gaps:

- **No real assistive-technology pass.** The repo says so (A-A9). axe covers 9
  rules on 2 static documents; live regions, dynamic announcements, focus
  restoration after overlays, and the body iframe's AX tree are untested.
- **The reader iframe cannot be reached by a screen reader in the harness** and
  the repo's control experiment says that is an artefact — unproven either way.
- **A disabled feature is presented in the UI** ("Background priority
  notifications — temporarily unavailable"), which is honest but is dead
  surface area users must parse.
- **The takeover's failure mode is severe by construction**: Gmail's roots are
  `display:none` and restored on `pagehide` / `release()`. If the app document
  crashes while `state==='active'` and `pagehide` does not fire (extension
  reload, renderer kill), the user is left on a blank Gmail. `pagehide` covers
  most of it; nothing covers all of it.

---

## L · Performance findings

Measured by me on this box: classify 2,000 = 13.1 ms; store 2,000 = 55.0 ms;
100 searches = 32.0 ms; 1 render per sync batch. The design decisions behind
those numbers (sync classifier, incremental index, coalesced batch,
`content-visibility:auto` instead of a hand-rolled virtualiser, delta-persist
at idle) are sound and, unusually, are justified against the v1 measurements
they replaced.

Concerns:

- **All performance evidence is data-layer.** jsdom has no layout engine; the
  README concedes it. `render-bench.mjs` exists and CI runs it under headless
  Chromium with thresholds tuned to 5,000 ms page / 9,000 ms search — those
  ceilings are ~1.5× the worst observed on CI hardware, which means the gate
  catches multiples, not regressions.
- **EXT2-L4**: the mail integration file alone takes 456 s. A 7.5-minute test
  file is a test file people stop running.
- EXT2-M10 (search) and the whole-blob cache writes are the two scaling walls.

---

## M · Test-quality findings

This is where the gap between the project's self-image and reality is widest.

**The good, verified:** 2,010 tests execute; 0 skipped under the CI runner;
integration tests boot the real `app.html` in jsdom and drive it as a user;
fuzz files exist for MIME parts, batch parsing, sanitiser depth, classification,
deadlines, search, templates, backup, deep links; `resilience.test.mjs` injects
failures across persistence modules; coverage floors are enforced per critical
module and CI fails below them; `ci-test.mjs` fails on *any* skip so a missing
jsdom cannot masquerade as a pass; shard completeness is proven arithmetically
and the manifest is uploaded on every run.

**The problems:**

1. **EXT2-H1 — `npm test` fails.** Verified twice. The default command's heap
   ceiling (1400 MB) is below what its own heaviest file needs (~3072 MB, which
   `ci-test.mjs` sets). A contributor following the README sees a red suite and
   a SIGABRT with no assertion attached — the exact confusion the
   `ci-test.mjs` header warns about, shipped in the sibling script.
2. **EXT2-H2 — source-text pinning at scale.** 99/153 files `readFileSync`;
   92 pair it with `assert.match`; 1,231/5,054 assertions are text shape checks.
   Example (`architecture.test.mjs:187`): asserting the *source string*
   `setAttribute('role', 'tablist')` appears. This passes if the call is inside
   dead code, and fails on a harmless refactor. Counting these toward "1,998
   tests pass" overstates the safety net.
3. **Mocks define the contract they verify.** There is no recorded-fixture
   layer from real Gmail responses; the batch fixtures are hand-written, which
   is precisely why EXT2-M1/M2 survived (I found both by fuzzing the real
   function directly, in ten minutes).
4. **No MV3 lifecycle simulation, no browser-restart simulation, no
   quota-exhaustion simulation** at the storage-area level, no account-switch
   *race* test (there is an account-identity test, which is not the same thing).
5. **`test/mutate.mjs` exists** — mutation testing is available and, from the
   audit trail, used ad hoc. It is not in CI, so nobody knows the suite's
   mutation score.

---

## N · Maintainability findings

The comment culture is the most distinctive thing about this repo: nearly every
non-obvious decision carries a paragraph explaining the bug that motivated it,
often with the measurement. That is real institutional memory and it made this
audit *much* faster. It is also, at volume, a cost: several files are more
prose than code, comments cite round numbers and audit IDs a newcomer cannot
resolve, and the density makes it hard to see the control flow.

- **EXT2-M7**: `main.js` 3,884 lines / 69 top-level functions, owning the verb
  bridge, timeouts, degradation, teardown, ingest, boot and the `ctx` locator.
  Every extraction so far has moved *leaf* concerns out (list, reader, bulk,
  rails); the orchestration core has not moved.
- **EXT2-M12**: 122 silent catch blocks. Most are justified individually
  ("a queue write failure must not surface mid-triage"); collectively they mean
  the system's default response to a storage failure is to continue with a
  wrong-but-plausible state.
- Error taxonomy is strings (`'ACCOUNT_CHANGED'`, `'SILENT_FAILED:…'`,
  `'AUTH_RENEW_TRANSIENT'`, `'SYNC_NOT_DURABLE'`, `'NOT_SIGNED_IN'`,
  `'AUTH_REVOKED: …'`) compared by `includes`/regex across three layers. This
  is the root cause of EXT2-C2, EXT2-H4, and the attachment classifier's
  `/Gmail 4\d\d/`. One `class BmmError { code, status, cause }` retires the
  whole class.
- **EXT2-M11**: no `LICENSE`. For a public repo this is a real gap.

---

## O · Release / migration findings

CI is above average: 8 shards with `fail-fast:false`, a `Verdict` job that
`if: always()` and fails on anything not verbatim `success` (including
`cancelled` — a genuinely good catch), SHA-pinned actions, `permissions:
contents: read`, concurrency cancellation, generated-file drift check
(`gen-pattern-rules` must be a no-op), docs-truth gate, contrast gate, coverage
gate, typecheck gate, browser smoke gate with trace/screenshot artefacts on
failure, shard manifest retained on green runs. `security.yml` is weekly and
deliberately off the push path with a written rationale.

Gaps: no packaging/signing step, no release tagging, no CHANGELOG, no rollback
procedure, no store-submission checklist, no `LICENSE`. Storage migration
exists only as "widen the packed row; old blobs degrade" — which is elegant for
the two cases it covers and is not a migration *framework*; `VERSION = 1`
everywhere means the first real schema break has no rehearsed path.

---

## P · Recovery and observability findings

- **Observability is near zero in production.** `diag.js` counts 5 things; its
  only flush site is inside the disabled alarm branch (EXT2-L3), so
  `diagCounters` is never written in a real install. 6 `console.*` calls in
  115 modules. No correlation ids, no structured events, no way for a user to
  export a diagnostic bundle. When something goes wrong in the field the
  answer will be "reinstall".
- **Recovery paths that exist:** stale-lock TTL (180 s), `sending`→`failed`
  demotion, `tooOld`→resync, cache/version mismatch → discard, per-row
  malformed-entry filtering, `forceRenew` on 401, worker re-probe chain with
  toast on recovery.
- **Recovery paths that do not:** index rebuild from primary records (the store
  has no `rebuild()` at all — by design for speed, which means a divergence has
  no repair), corrupted-vs-empty discrimination for any blob, partial-migration
  detection, user-visible "we repaired your local data" messaging.

---

## Q · Improvement opportunities not caused by current bugs

1. **Typed error objects** (`code`, `status`, `cause`) replacing string
   matching — one change retiring three findings.
2. **Namespace every account-scoped key** by an account hash rather than
   clearing at sign-out.
3. **Unicode-aware tokenisation** (`\p{L}\p{N}` with the `u` flag) plus a
   sorted token array for prefix search — fixes EXT2-H7 and EXT2-M10 together.
4. **Record real Gmail responses as fixtures** (redacted) and replay them; this
   is the single highest-value test change available.
5. **Mutation testing in CI** on the five critical modules — the suite is large
   enough that its *quality* is now the unknown, not its size.
6. **Extract an `app/shell/` layer** from `main.js`: bridge, degradation,
   session lifecycle, ingest. Four modules, each testable in isolation.
7. **Migrate the body floor to IndexedDB** — the adapter is already written,
   tested and unused (`idb.js` has zero production consumers).
8. **Budget/measure storage** with `getBytesInUse` and surface pressure before
   a write fails.
9. **Drop `notifications` from the manifest** until the sweep is re-enabled.
10. **Add `LICENSE`, CHANGELOG, and a release checklist.**

---

## R · Comprehensive rating — every way, 1 to 10

Scored honestly, against *shipping a mail client people trust with their
mailbox* — not against "impressive for a student project", which it certainly
is. **A dimension that has never been executed in its target runtime is capped
in the 4–6 band no matter how good the source reads.**

| # | Dimension | Score | Why exactly this number |
|---|---|---|---|
| 1 | Correctness (verified) | **5** | Store/sync/history logic is careful and well-reasoned, but I found a reachable destructive-resync bug, a spurious sign-out, a live-array leak and two parser losses in one session. |
| 2 | Correctness (in the real runtime) | **2** | Never run in Chrome against a real inbox. Unknown, and unknown is not a pass. |
| 3 | Security — sanitisation & rendering | **8** | 13 adversarial payloads neutralised; sandbox + CSP + allow-list, one decision two consumers. Loses points only for having no external review. |
| 4 | Security — auth & credentials | **3** | Sole flow is a grant removed in OAuth 2.1 with no fallback; fallback mode relocates the token into the mail-rendering document; unrotated v1 secret still documented as live. |
| 5 | Security — extension surface | **7** | Nonce-gated embed, source-checked messaging, `isTrusted` chord, minimal CSP. −2 for an unused `notifications` permission and `include_granted_scopes`. |
| 6 | Data integrity | **6** | Prepare/commit cursor, disjoint delta folding, per-field cache reasoning — genuinely good. Undermined by resync-on-transient-error and unmeasured quota. |
| 7 | MV3 lifecycle discipline | **6** | The doctrine is right and mostly kept; alarms used properly. But six module globals guard critical sections and no test ever restarts the worker. |
| 8 | Gmail API integration | **7** | Pagination, backoff, Retry-After, id whitelisting, all-failed-is-failure — better than most. −3 for two reproduced parser losses and a boundary re-derived from untrusted text. |
| 9 | Sync engine | **5** | Well-designed prepare/commit; background half switched off; resync is unconditional destruction reachable from a blip. |
| 10 | Store / indexing | **8** | Measured fast, incrementally indexed, well covered. −2 for the live-array leak and Latin-only tokens. |
| 11 | Search quality | **4** | Fast, but non-Latin text is unsearchable and index-vs-predicate semantics diverge. |
| 12 | Concurrency & races | **5** | Epochs, single-flight, claim+lock, cancel-race re-reads — real work. But the cross-tab mutex is a 25 ms sleep, and duplicate mail is the failure mode. |
| 13 | Error handling & taxonomy | **3** | String matching decides destruction, sign-out and retryability. 122 silent catches. This is the codebase's weakest system. |
| 14 | UX & information architecture | **7** | Thoughtful, honest empty/loading states, deep links, undo everywhere, a disabled feature labelled as disabled. Unproven on real hardware. |
| 15 | Accessibility | **6** | axe-clean on shells, focus-visible, reduced-motion, AA themes. No real AT pass; dynamic states untested. |
| 16 | Visual design & responsiveness | **7** | Token system, 7,997 lines of organised CSS, contrast-gated themes, forced-colors evidence. Not seen by me in a browser. |
| 17 | Performance (data layer) | **8** | Measured: 13/55/32 ms. Design choices justified against the v1 numbers they replaced. |
| 18 | Performance (rendering) | **4** | No layout engine in tests; CI thresholds are ~1.5× worst-observed, so only multiples are caught. |
| 19 | Test coverage (quantity) | **8** | 2,010 tests, 1.06:1 ratio, 0 skips enforced, fuzz + resilience files, coverage floors in CI. |
| 20 | Test quality (does it falsify?) | **4** | 99/153 files pin source text; 1,231 regex assertions; mocks author the contract; no lifecycle/restart/quota simulation; no mutation score. |
| 21 | Test operability | **3** | The documented `npm test` **fails** on a clean checkout; one file takes 456 s. |
| 22 | CI / release engineering | **7** | Sharding with completeness proof, SHA-pinned actions, honest aggregate verdict, drift and docs gates. −3 for no packaging/signing/tagging/rollback and no LICENSE. |
| 23 | Observability | **2** | Five counters that never flush in production; six console calls; no correlation ids; no user-exportable diagnostics. |
| 24 | Recovery & self-healing | **4** | TTLs, demotions, resync, per-row filtering. No index rebuild, no corruption detection, no "we repaired this" signal. |
| 25 | Architecture & boundaries | **7** | Layering is real and *enforced by tests*; zero cycles; clean platform seam. −3 for a 3,884-line orchestrator god module. |
| 26 | Maintainability | **6** | Extraordinary comment provenance; also extraordinary comment volume, a god module, and a string-typed error system. |
| 27 | Type safety | **4** | `checkJs` on three folders only, `strict:false`. Most of the app is unchecked JS with JSDoc. |
| 28 | Dependency & supply chain | **9** | Zero runtime deps, 6 dev deps, SHA-pinned CI, weekly high-severity audit with a written rationale for being off the push path. Best dimension here. |
| 29 | Documentation truth | **6** | `docs:check` enforces indexes and a test count — and the README still contains a stale "1339" and a token-location claim that is false in fallback mode. |
| 30 | Privacy & data minimisation | **6** | Headers-only cache, bodies bounded and giants refused, no analytics, no third-party egress. −4 for un-namespaced per-account data on a shared machine. |
| 31 | Multi-account isolation | **5** | A real tripwire (profile-validated renewal) and outbox stamping — genuinely good thinking. Fails open for legacy rows; several stores are not namespaced. |
| 32 | Offline / degraded design | **6** | Body floor, intent queue, honest freshness, worker re-probe with recovery toast. The degraded path relocates the token and is the least-tested path. |
| 33 | Product completeness | **7** | Compose, threading, 7 mailboxes, snooze, rules, bulk, undo, backup, timetable. Genuinely a mail client. |
| 34 | Product readiness | **2** | Cannot be installed and trusted today: unverified in Chrome, auth on a sunsetting grant, background sync off, unrotated credentials. |
| 35 | Repo & process hygiene | **6** | Clean tree, 504 commits, real audit trail, `.gitignore` covers secrets. −4 for no LICENSE, 652 KB of committed institutional data, and eleven audit documents whose ratings (5.6, 8.2, 8.6) disagree with each other and with this one. |

**Unweighted mean: 5.5.**
**Weighted** (correctness-in-runtime, auth security, data integrity, test
quality and observability weighted ×2, because those are what decide whether a
mail client can be trusted): **5.4 / 10.**

### What that number means

**5.4 is "an impressive engineering artefact that is not yet a product."**

It is not a low score for craft. On the dimensions that can be judged from
source alone — sanitisation, dependency hygiene, store design, layering
enforcement, comment provenance — this scores 7–9 and beats a lot of shipped
commercial code. The reason it lands at 5.4 is that a mail client is judged on
whether it can be trusted with a mailbox, and four independent things say it
cannot be, today:

1. it has never run against a real inbox;
2. its only authentication mechanism is a grant the standard removed;
3. a transient network error can be classified as "throw the local mailbox
   away", and a hex message id can be classified as "sign the user out";
4. nothing in production would tell anyone that either had happened.

Every one of those is fixable, and three of the four are small. The path from
5.4 to 8 is short and does not require an architecture change — it requires
one install, one typed-error class, one heap flag, and one honest decision
about OAuth.

---

## S · Recommended phased roadmap

**P0 — this week, small and unblocking**
- `EXT2-H1`: raise `--max-old-space-size` in `npm test` to match `ci-test.mjs`,
  or point `npm test` at the runner. One line.
- `EXT2-C2` + `EXT2-H4`: attach `err.status`/`err.code` in `fetchRetrying` and
  branch on the number. Two regression tests: 503-with-404-in-URL must not
  resync; 500-with-401-in-message-id must not sign out.
- `EXT2-H3`: `.slice()` the memoised category array.
- `EXT2-H6`: remove `notifications` from the manifest while the sweep is off,
  or re-enable the sweep behind its own cursor. Move `persistDiag()` to a live
  call site either way.

**P1 — the blocking one**
- **Install it in Chrome and Brave and use it against a real mailbox for a
  week.** Record what breaks. Nothing else on this list matters as much.
- Decide the OAuth story with evidence: re-test whether a Chrome-Extension-type
  client + `chrome.identity.getAuthToken` works today (with the documented
  Brave caveat), and if implicit must stay, add detection and a user-facing
  message for the day it stops.

**P2 — trust**
- Typed error objects replacing every string match.
- `sending`-on-restart → `uncertain`, not `failed & due` (EXT2-H5).
- Account-namespaced storage keys.
- `getBytesInUse` budgeting with a user-visible pressure state.

**P3 — the test net**
- Recorded Gmail fixtures; fuzz `parseBatch` against them (EXT2-M1/M2 are the
  first two failures it will find).
- A worker-restart harness that re-imports the module between awaits.
- Mutation score in CI for the five critical modules.
- Reclassify source-pin tests into a separate `lint:contracts` suite so the
  headline test count means behaviour.

**P4 — scale and polish**
- Unicode tokenisation + prefix structure.
- Extract `app/shell/` from `main.js`.
- Migrate the body floor onto the already-built IndexedDB adapter.
- LICENSE, CHANGELOG, release checklist.

### Smallest safe first milestone
The four P0 items plus two regression tests. Roughly 60 lines changed. They
close one CRITICAL, two HIGHs and a least-privilege violation, and they make
the documented build command true.

---

## T · Assumptions and explicitly unverified items

Stated plainly, because a rating that hides its blind spots is worthless:

1. **I did not run the extension in any browser.** No Chrome, no Brave. Every
   MV3, OAuth, takeover, alarm, notification and rendering claim in this report
   is reasoned from source or from jsdom.
2. **I did not call the Gmail API.** All API-semantics findings are derived
   from the code's own assumptions plus published behaviour, not observation.
3. **I did not run the Playwright smoke or render bench** (no browser binary
   installed here); I read their configuration and CI wiring only.
4. **I ran the full suite twice and the heavy file twice**; I did not run it
   under randomised ordering, repeated for flake detection, or under fake time.
5. **Coverage figures are the project's own gate output**, which is selective
   by design; the 83.22% all-files number includes test files in the
   denominator.
6. **I read closely**: `auth.js`, `gmail.js`, `sync.js`, `background/index.js`,
   `mime.js`, `takeover/content.js`, `fallback.js`, `sanitize.js`, `store.js`,
   `cache.js`, `body-cache.js`, `intents.js`, `outbox/model.js`,
   `snooze/model.js`, `storage.js`, `idb.js`, `storage-registry.js`,
   `selectors.js`, `selection.js`, `bulk.js`, `reader-frame.js`, `deep-links.js`,
   `classify/*`, `diag.js`, both workflows, `ci-test.mjs`, `push.sh`, the
   manifest, and roughly 800 more lines of `main.js`/`list.js`/`reader.js`.
   I did **not** closely read: the timetable subsystem (~3,000 lines), the
   motion/cyberpunk subsystem (~2,500 lines + CSS), `compose.js`, the overlay
   family, or most of `src/styles`. Findings in those areas are absent, not
   cleared.
7. **The five same-day sibling audits in `audits/` were deliberately not used**
   as input before forming findings, per the brief. Where my conclusions
   overlap theirs (identity fencing, cursor custody, string-typed errors) that
   is independent corroboration; where they differ — their ratings run 5.6 to
   8.6 — I stand on the evidence recorded above.
8. **Timing numbers are from this sandbox** (shared CPU) and are indicative,
   not a benchmark.

---

*No production file was modified in the course of this audit.*
