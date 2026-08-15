# Arena System-Wide Audit — 2026-08-15 (independent, third pass)

Independent, evidence-driven audit of **BITS Mail Manager** at tree
**`f53175c`** (`main`, clean, 0 ahead / 0 behind `origin/main`), performed in a
fresh clone from `https://github.com/AviralGup7/MAIL-MANAGER`. No production
file was modified; the only artifact added is this document. Prior audits in
`audits/` (including the same-day `2026-08-15-EXTERNAL-SYSTEMWIDE-AUDIT.md`,
`audits/64-COMPREHENSIVE-RATING-V2.md`, and `2026-08-15-RECONCILIATION.md`)
were treated strictly as *hypotheses to re-verify*, never as evidence.

**Audit mandate (from the commissioning brief).** Audit-first; do not modify
production behavior; evidence or it did not happen; distinguish
CONFIRMED / HIGH / MEDIUM / LOW confidence; stable finding IDs; file · symbol
· line references; blast radius and remediation for every finding; rate
**each audit area 1–10 honestly and low where warranted**, then give one
comprehensive system-wide rating.

**Constraint of this environment.** No live Gmail account and no real
browser were available, so anything requiring a signed-in end-to-end run is
marked UNVERIFIED in §S. Everything not so marked was verified in this
sandbox at `f53175c`: statically (full read of every backend module and the
app shell), dynamically (direct module-import reproductions under Node with a
mocked `chrome.*`), or through the repo's own verification commands, each run
and recorded below.

---

## Baseline verification (every command actually run)

| # | Command | Result at `f53175c` |
|---|---|---|
| 1 | `git status -sb` / `git log -1` / divergence | clean; HEAD `f53175c`; 0/0 vs `origin/main` |
| 2 | `npm install` | OK (Node v20.20.2, npm 10.8.2) |
| 3 | `npm test` (= `node --max-old-space-size=1400 --test test/`) | **FAIL** — every subtest of `test/app.mail.integration.test.mjs` passes (97/97), then the worker **OOM-SIGABRTs** ("Ineffective mark-compacts near heap limit"). Suite total: 2010 pass / 1 fail (the file-level crash). → ARN-H2 |
| 4 | `npm run test:ci` (= `node tools/ci-test.mjs`, 3072 MB, shardable ×8) | **PASS — 2022/2022**, ~881 s wall |
| 5 | `node tools/ci-selfcheck.mjs` | **PASS 27/27** CI invariants |
| 6 | `node tools/check-docs.mjs` | **PASS 6/6** (note: gate asserts "1998 declared" while the runtime counter reports 2022 — different counting, gate green) |
| 7 | `npm run contrast` | **PASS** — all themes WCAG AA |
| 8 | `npm run types` | **PASS** (silent) |
| 9 | `npm run coverage` | **PASS** — but `src/background/sync.js` line floor is **55 %** against an actual 58.77 % line / 94.12 % branch → ARN-M7 |
| 10 | `npm run bench` | classify 2000: **8.8 ms**; store 2000: **33.9 ms**; 100 searches: **18.7 ms**; renders triggered: **1** |
| 11 | `npm audit` / `npm audit --omit=dev` | **0 vulnerabilities** |
| 12 | DOM-sink scan (`innerHTML`, `insertAdjacentHTML`, `outerHTML`, `document.write`, `eval`, `new Function`) in `src/` | all 5 `innerHTML` sites use **constant/own strings** (verified individually); zero of the other sinks. Mail-derived text reaches the DOM via `textContent` / guard-coerced text nodes (`list.js setHighlighted` builds `<mark>` chunks as text nodes only) |
| 13 | Runtime probes (this audit) | RFC 2047 `normalise()` passthrough — **defect reproduced** (ARN-H1); classifier course-code false positives — **reproduced** (ARN-M8); snooze `nextWakeAt` past-due → `now + 5000` ms — **reproduced** (ARN-M1); snooze `due()` past-due — **reproduced** (ARN-M1) |

Repo shape at this tree: ~56.5 k lines total; `src/` 19,145 code + 12,889
comment lines (ratio 0.67 — exceptionally comment-dense); `test/` 37,111
lines across 152 files; CSS 7,997 lines. Manifest: MV3, **v2.0.0**, fixed
public `key` (extension id `dgeanijfllibcphbblkhacjcbdehihcp`), permissions
`alarms, identity, notifications, scripting, storage`, host permissions
`mail.google.com`, `gmail.googleapis.com`, `oauth2.googleapis.com`, CSP
`script-src 'self'; object-src 'none'; connect-src 'self'` + the two Google
API origins.

---

## A. Executive risk summary

BITS Mail Manager is an unusually disciplined MV3 codebase: the historically
fatal classes — mail-HTML XSS, MV3 timer loss, account bleed-through,
header injection, cursor-driven mail loss — have each been found by earlier
in-repo campaigns and **closed with regression pins**, and this pass verified
those closures directly rather than from the audit log. The reader/sanitizer,
secret hygiene of the shipped tree, token handling, and CI gating are
genuinely strong.

This pass nonetheless confirms **real, currently-shipping defects**, several
of them in the reliability layer the product sells (queues, timers, cursors):

- **2 HIGH.** (1) Inbound mail headers are **never RFC 2047-decoded** —
  non-ASCII subjects and senders render as raw `=?UTF-8?B?…?=` encoded-words
  and the classifier scores base64 (ARN-H1, reproduction in §D). (2) The
  repo's own headline command, `npm test`, **crashes out of memory on a
  clean checkout** at its declared heap budget; only the differently-wired CI
  path is green (ARN-H2, upheld from EXT-H2).
- **11 MEDIUM**, concentrated in one theme: **timers and queues**. A
  past-due snooze that cannot wake re-arms a **~5-second alarm loop
  forever** (ARN-M1); fallback mode never auto-wakes snoozes at all while a
  source comment claims it does (ARN-M2); two independent outbox dispatchers
  share no lock, leaving a mixed-mode duplicate-send path (ARN-M3);
  crash-demoted outbox rows auto-retry at boot, an acknowledged-by-test
  duplicate-send mechanism (ARN-M4); snoozes are not account-scoped, so
  signing into account B silently destroys account A's snooze schedule
  (ARN-M5); diagnostic counters are **never persisted** because their only
  flush site is behind the compile-time-disabled background sweep (ARN-M6);
  the mail-loss-critical `sync.js` carries a coverage floor tuned to 55 %,
  the shallowest line coverage in the gate (ARN-M7); the course-code
  heuristic provably misclassifies "bus **g400**" and "Draco **A100**" as
  academics with 0.90 confidence (ARN-M8); the outbox enqueue remains a
  non-atomic get-then-set (ARN-M9); safety branches dispatch on
  error-message substring matching (ARN-M10); and `main.js` is a
  3,884-line god module (ARN-M11).
- **5 LOW** and **3 INFO** (dead notification permission, snoozed-view label
  creation, dead sweep code shipped, stale comments, dead-by-design IDB
  layer, etc.).
- **Process (outside the shipped tree, HIGH):** a live GitHub PAT was pasted
  into this commissioning chat — the **third** recorded token leak for this
  repository (`DO-THIS-NOW.md` documents two prior leaks plus a `GOCSPX-`
  OAuth client secret in v1 history). → ARN-P1.

**Reconciliation against prior audits (§R):** the previous external pass's
one CRITICAL-class defect (EXT-H1, worker outbox-pump lost-update) is
**fixed** at this tree — the pump now reloads live storage before every
mutation. `EXT-M3` (coverage gate absent from CI) is also **fixed**
(`ci.yml:103–104`). The contained CRITICAL `AUD-I01` remains *contained by
amputation*: the background sweep is compiled off (`BACKGROUND_SYNC_ENABLED =
false`), and every subsystem that hung off the sweep — desktop notifications,
diagnostic persistence — is dead with it.

**Comprehensive rating (§50): 6.3 / 10** (unweighted mean of the 49 scored
areas, 6.27). Decomposition: security-critical areas **8.25**, core mail path
**6.5**, reliability/queues/timers **4.5**. In one sentence: *the locks are
excellent; the clocks and queues are not.* This is deliberately lower than
the in-repo self-ratings (7.3–8.9) and the prior external pass (8.2): the
brief asked for honesty over inflation, and the verified defect set —
especially a broken `npm test`, the RFC 2047 hole, and the four queue/timer
duplication-or-loss mechanisms — does not support an 8.

---

## B. Architecture map (verified from code at `f53175c`)

```
Gmail tab (mail.google.com)
 └─ src/takeover/content.js            mount/unmount only; iframe app.html?u=<n>&embed=<nonce>
     └─ iframe app.html (extension origin)
         └─ src/app/main.js (3,884 lines) — boot, ctx wiring, verb transport
             │  boot gate: refuses embedded boot without valid embed nonce
             ├─ mail/store.js         per-mailbox Map store + byCategory/byThread/searchIndex,
             │                        MAX_MESSAGES 2000, incremental indexing, one notify per batch
             ├─ system/cache.js       header cache v1, packed 16-field rows, cap 500, idle-coalesced saver
             ├─ system/body-cache.js  offline body floor (bounded LRU)
             ├─ mail/reader.js + core/sanitize.js + mail/reader-frame.js
             │                        sandboxed srcdoc iframe (popups only), allow-list DOM-walk
             │                        sanitizer, CSS property allow-list, depth cap 1024, remote
             │                        images blocked by default, cid resolution, fail-closed
             ├─ features/outbox/model.js    held→sending→failed|uncertain, undo-send 8 s hold,
             │                              backoff 15/60/300/900 s, cross-tab CLAIM_KEY + PUMP_LOCK
             ├─ features/snooze/model.js    chrome.alarms + catch-up sweeps
             ├─ classify/*            3-stage classifier + course-code heuristic (no network)
             ├─ system/fallback.js    in-page verb router (verb-for-verb parity; token moves into
             │                        the page context in this mode — documented trade)
             └─ verbs via chrome.runtime.sendMessage, per-verb timeouts (VERB_TIMEOUT_MS),
                 sticky workerDown → fallback; SAFE_FALLBACK_REPLAY = reads + SYNC_COMMIT only;
                 mutations after ambiguous timeout throw OUTCOME_UNKNOWN
service worker  src/background/index.js (thin router)
 ├─ auth.js    implicit flow (response_type=token), silent renew via prompt=none,
 │             sessionEpoch guard, ACCOUNT_CHANGED identity proof on EVERY renewal,
 │             token in TOKEN_STORAGE() = chrome.storage.session (local fallback),
 │             server-side revoke on sign-out
 ├─ gmail.js   fetchRetrying (Retry-After/backoff/jitter/AbortSignal), multipart batch ≤ 100,
 │             parseBatch, normalise() trust boundary, buildMime CRLF/header scrubbing,
 │             outbound RFC 2047 encodeHeader, history() capped 10×500
 ├─ sync.js    prepare-then-commit, commitHistoryId monotonic cursor, reduceHistory ordered
 │             fate map
 ├─ mime.js    extractBody, recursion depth cap 64
 ├─ notify.js, diag.js (bump/persistDiag), tab-pick.js
 └─ alarms: WAKE_ALARM (snooze), SYNC_ALARM (DISABLED: BACKGROUND_SYNC_ENABLED=false),
     AUTH_RETRY_ALARM (single-shot transient renewal)

platform/storage.js   the single chrome.* seam (session-preferred token area, live-binding
                      Proxy for test harness swapping)
platform/idb.js       AREA-contract IndexedDB adapter — shipped with zero consumers (declared)
```

Dependency direction is clean: `classify/` and `shared/` are pure; `app/`
never imports worker modules except via the deliberate, documented fallback
dynamic import; the storage seam is the only `chrome.*` owner. No import
cycles found.

---

## C. Master findings register

Confidence legend: **CONFIRMED** = reproduced/executed or directly observed
in code at `f53175c`; **HIGH** = strong static evidence, mechanism certain,
end-to-end effect not browser-observed in this sandbox.

| ID | Sev | Conf | Category | Subsystem | Where (file · symbol · line) |
|---|---|---|---|---|---|
| ARN-H1 | **HIGH** | CONFIRMED (probe) / HIGH (wire) | Correctness, i18n, classification | Ingestion | `src/background/gmail.js` · `normalise()` · ~360–390 |
| ARN-H2 | **HIGH** | CONFIRMED | Test infrastructure | Repo tooling | `package.json` · `scripts.test`; `test/app.mail.integration.test.mjs` |
| ARN-M1 | MEDIUM | CONFIRMED (probe) | MV3 lifecycle, battery | Snooze | `src/features/snooze/model.js:183`; `src/background/index.js` · `wakeDue`/`scheduleWake` |
| ARN-M2 | MEDIUM | CONFIRMED | Correctness, docs | Fallback | `src/app/system/fallback.js:220–223`; header comment vs zero in-page `due()` callers |
| ARN-M3 | MEDIUM | HIGH | Concurrency | Outbox dispatch | `src/background/index.js` · `OUTBOX_PUMP` (module flag only) vs `src/features/outbox/model.js` · `flushOutbox` (CLAIM_KEY/PUMP_LOCK) |
| ARN-M4 | MEDIUM | CONFIRMED (mechanism, test-pinned) | Data integrity | Outbox | `src/features/outbox/model.js` · `normaliseOutbox` (sending→failed); `src/app/main.js` · `start()`→`pumpOutbox()`; `test/outbox.test.mjs:~219–301` |
| ARN-M5 | MEDIUM | CONFIRMED | Data integrity, multi-account | Snooze | `snoozed` storage key (not account-scoped); `signOut` (no snooze clear); `src/background/index.js` · `wakeDue` 404→`removeSnooze` |
| ARN-M6 | MEDIUM | CONFIRMED | Observability | Worker | `src/background/index.js:751` (unreachable behind `BACKGROUND_SYNC_ENABLED=false` guard at :744) |
| ARN-M7 | MEDIUM | CONFIRMED | Test quality | Coverage gate | `package.json` coverage floors: `src/background/sync.js` line floor **55 %** (actual 58.77/94.12) |
| ARN-M8 | MEDIUM | CONFIRMED (probe) | Classification accuracy | Classifier | `src/classify/*.js` · `COURSE_CODE = /\b([a-z]{2,5})\s?([a-z])(\d{3})\b/i` |
| ARN-M9 | MEDIUM | CONFIRMED | Concurrency | Outbox enqueue | `src/app/compose/compose.js:674–675` (get-then-set; upholds EXT-M1) |
| ARN-M10 | MEDIUM | HIGH | Maintainability/correctness | Cross-layer errors | `index.js` `includes('ACCOUNT_CHANGED')`; `gmail.js` `includes('404')`; `main.js:433,483`; `index.js` `/Could not create/` (upholds EXT-M2) |
| ARN-M11 | MEDIUM | HIGH | Maintainability | App shell | `src/app/main.js` — 3,884 lines, ~260 functions (upholds EXT-M4; grew 42 lines since) |
| ARN-L1 | LOW | CONFIRMED | Least privilege | Manifest | `manifest.json` `notifications` permission — dead while sweep disabled |
| ARN-L2 | LOW | CONFIRMED | Side effects | Mailboxes | `src/app/mail/mailboxes.js` (snoozed `byLabelName`) → `SYNC_PAGE labelName` → `ensureLabel` → `createLabel` on an empty view |
| ARN-L3 | LOW | CONFIRMED | Dead code | Worker | `backgroundSyncRun`, `selectNotifiable`, `mergeNotified`, `cardText` unreachable |
| ARN-L4 | LOW | CONFIRMED | Docs drift | Search | `src/app/system/server-search.js` header: "SUBJECT AND SENDER ONLY"; `Store.tokenize` also indexes snippet (widened bug-hunt #19) |
| ARN-L5 | LOW | CONFIRMED | Dead-by-design code | Platform | `src/platform/idb.js` — zero consumers (declared; upholds EXT-I1) |
| ARN-I1 | INFO | CONFIRMED | Hygiene | Tooling | `tools/manifest-key.txt` content == the **public** manifest `key` — not a secret (retracted suspicion re-verified) |
| ARN-I2 | INFO | CONFIRMED | Multi-account design | Outbox | Legacy unstamped rows (`accountEmail:''`) dispatchable by any account — deliberate, documented in `dispatchable` |
| ARN-I3 | INFO | CONFIRMED | Docs counting | Repo | `check-docs` asserts "1998 declared"; runtime counter reports 2022 — different counting, gate green |
| ARN-P1 | **HIGH (process)** | CONFIRMED | Secrets / repo ops | Outside shipped tree | Chat-held PAT; `DO-THIS-NOW.md` records 2 prior PAT leaks + a `GOCSPX-` client secret in v1 history |

**No CRITICAL-severity defect is open from this pass at `f53175c`.** The
last CRITICAL-class item (EXT-H1, silent outbox loss) is verified fixed; the
contained CRITICAL AUD-I01 remains contained (see §R).

---

## D. Critical correctness findings (detailed)

### ARN-H1 — Inbound RFC 2047 encoded-word headers are never decoded (HIGH)

**Where.** `src/background/gmail.js`, `normalise()` (headers → message fields,
~lines 360–390). Outbound exists (`encodeHeader`, lines ~537–620, comments
cite RFC 2047); **inbound decode is absent**. A tree-wide grep for
`2047|encoded-word|decodeWord` hits only the outbound path; `test/` contains
**zero** fixtures with a `=?` encoded-word.

**Reproduction (executed this session, real module):**

```js
normalise({ payload: { headers: [
  { name: 'Subject', value: '=?UTF-8?B?4KS14KSV4KWL4KScIOCkpuClgCAyMDI2?=' },
  { name: 'From',    value: '=?UTF-8?Q?Prof._R=C3=A9sum=C3=A9?= <prof@bits.ac.in>' },
] } })
// → subject: '=?UTF-8?B?4KS14KSV4KWL4KScIOCkpuClgCAyMDI2?='   (verbatim)
// → from:    '=?UTF-8?Q?Prof._R=C3=A9sum=C3=A9?= <prof@bits.ac.in>' (verbatim)
```

**Why this is unsafe.** The Gmail API returns raw RFC 5322 header values;
encoded-words are the standard encoding for any non-ASCII subject/sender.
Consequences, in order of severity: (1) list, reader, and contacts render
**base64 garbage** for exactly the mail a BITS audience routinely receives
(Hindi/Devanagari names and subjects, accented sender names); (2) the
classifier scores the *encoded* text, so keyword rules never match — a
"शिविर सूचना" circular misclassifies into `other`; (3) search over the local
index cannot match the decoded text either. `decodeEntities` (EXT-L3) only
handles HTML entities in snippets — a different, smaller gap.

**Blast radius.** Every non-ASCII subject or sender, all views, plus
classification accuracy for non-ASCII institutional mail. ASCII-only mail is
unaffected, which is why 2,022 green tests never saw it.

**Remediation.** Add a shared `decodeRFC2047(value)` (encoded-word tokenizer:
`=?<charset>?[BQ]?<payload>?=`, uppercase-hex/base64 decode via
`TextDecoder`, joined adjacent words, unknown charsets passed through
unchanged), apply it to `Subject`, `From`, `To`, `Cc` inside `normalise()`,
and in `fallback.js`'s parallel ingestion path; pin with fixtures:
UTF-8-B, UTF-8-Q with underscores, mixed encoded/ASCII runs, invalid wire
input (must pass through), and one Devanagari subject classified into the
expected category. Effort: <100 lines + fixtures.

**Regression-test requirement.** `test/gmail.test.mjs` fixtures above,
asserting decoded `subject`/`from` and correct category.

### ARN-H2 — `npm test` OOM-crashes on a clean checkout (HIGH; upholds EXT-H2)

**Where.** `package.json` → `"test": "node --max-old-space-size=1400 --test test/"`;
crash in `test/app.mail.integration.test.mjs`.

**Reproduction (executed this session).** Fresh clone → `npm install` →
`npm test`. All **97/97** subtests of the integration file pass; the worker
then dies at the file boundary:

```
FATAL ERROR: Ineffective mark-compacts near heap limit
Allocation failed - JavaScript heap out of memory   (SIGABRT)
```

Suite line: 2010 pass / **1 fail** (the crash). The same file passes under
`npm run test:ci` (`tools/ci-test.mjs`, `--max-old-space-size=3072`, 8-way
shardable) — **2022/2022, ~881 s**. Mechanism: jsdom documents (~2.2 MB
retained each × 97 boots) exceed the 1400 MB ceiling only in the *aggregate*
run; per-shard CI never accumulates them.

**Why unsafe.** The command README tells contributors to run is red at HEAD;
anyone evaluating or contributing hits a wall of V8 stack trace and cannot
establish a local baseline. It also means "tests pass" claims in this repo
are only ever CI-shaped.

**Blast radius.** All local development; zero runtime impact on users.

**Remediation.** Point `scripts.test` at `tools/ci-test.mjs` (or raise the
budget to 3072 and keep `--test`), and add a `ci-selfcheck` invariant:
"package.json test script and ci-test heap budgets agree." Regression: a
clean-checkout `npm test` must exit 0.

### ARN-M9 — Outbox enqueue is still a non-atomic get-then-set (MEDIUM; upholds EXT-M1)

`compose.js:674–675`: `const queue = await outbox.loadOutbox();
await outbox.saveOutbox([...queue, item])`. There is no compare-and-swap on
the outbox key anywhere. The worker pump (fixed since EXT-H1) now reloads
live storage before *every* mutation, shrinking the pump-vs-enqueue race to
a sub-millisecond window — but **two tabs enqueueing concurrently** can each
read the old queue and the later save silently drops the earlier row: queued
mail that never sends, with a "queued" toast already shown. **Blast
radius:** silent non-send (the failure class the outbox comments themselves
rank alongside double-send). **Remediation:** one `mutateOutbox(fn)` helper
(load → fn → save, retried on conflict) used by all seven save sites in both
paths; two tabs can still interleave at the storage layer, so the helper
should re-read and re-apply once if the pre-write value changed.
**Regression pin:** property test interleaving enqueue/cancel/pump at every
await boundary (currently absent — crosstab tests cover flusher-vs-flusher,
not flusher-vs-enqueuer).

### ARN-M4 — Crash-demoted `sending`→`failed` rows auto-retry at boot (MEDIUM; mechanism CONFIRMED, test-pinned)

`normaliseOutbox()` demotes rows found in `sending` (a crash mid-dispatch)
to `failed` with `attempts:0, nextAttempt:0` — i.e. **immediately due** —
and `main.js start()` calls `pumpOutbox()` unconditionally. If the worker
crashed *after* Gmail accepted the send but before the ack was persisted,
the next app open re-sends with no user action: a duplicate. The outbox
header claims queued mail is "never silently re-sent," but
`test/outbox.test.mjs` (~219–301) **pins the demote-to-failed behavior**, so
this is an accepted trade-off shipped deliberately. Likelihood is low (needs
crash in exactly the ack window); consequence is the failure mode the module
calls the worst a mail client can have. **Remediation:** demote to
`uncertain` ("may have sent — check Sent") instead of `failed`, or require
one user gesture before a demoted row is due. **Regression pin:** demoted
row is not due without confirmation.

### ARN-M3 — Two outbox dispatchers share no lock (MEDIUM)

Worker `OUTBOX_PUMP` single-flights via the module-local `outboxPumping`
flag; the in-page `flushOutbox` uses the storage-level `CLAIM_KEY`/`PUMP_LOCK`
settle-and-verify protocol. **The worker path never consults those storage
locks.** Per-tab `workerDown` is sticky after any verb timeout (e.g. one
slow 45 s `SYNC_PAGE` while a sibling tab is healthy), so a mixed mode is
realistic: one tab pumping in-page while the worker pumps for the other tab.
The in-page path marks a row `sending`; the worker's `loadOutbox` →
`normaliseOutbox` demotes foreign `sending` rows to `failed` = due → both
dispatchers send it. **Blast radius:** duplicate send in mixed mode.
**Remediation:** make the worker pump acquire `PUMP_LOCK` through the same
claim protocol (or route all pumping through one dispatcher). Residual of
CAN-C3.

### ARN-M10 — Safety branches dispatch on error-message substrings (MEDIUM; upholds EXT-M2)

`String(err.message).includes('ACCOUNT_CHANGED')` (router + two sites in
`main.js:433,483`), `String(err).includes('404')` → `tooOld`,
`/Gmail 4\d\d/` → "gone forever", `/Could not create/` → honest-empty.
Invisible contract: a reworded message compiles, type-checks, and silently
turns "tear down the session" into "keep serving the wrong account's cache."
**Remediation:** closed error-code module (`shared/errors.js`, exported
consts on an `err.code`); pins test codes, not literals.

---

## E. Security

**Overall: the strongest layer of the system — verified, not inherited.**

- **DOM sinks.** All five `innerHTML` sites in `src/` take constant/own
  strings (skeleton rows, row scaffold, icon path table, `&times;`,
  sanitizer *reading* `out.innerHTML`). Zero `eval`/`new Function`/
  `document.write`/`insertAdjacentHTML`. Mail text reaches the DOM via
  `textContent` or `setHighlighted`'s text-node `<mark>` chunks, with a
  totality coercion (`String(text ?? '')`) so a poisoned cache row cannot
  abort a render batch.
- **Sanitizer (`core/sanitize.js`).** Real DOMParser parse-and-walk with
  element/attribute/CSS-property allow-lists, `url()/expression()/@import`
  refusal, `cid:` resolution for inline parts, depth cap 1024, fail-closed
  path; rendered inside a sandboxed `srcdoc` iframe with
  `allow-popups allow-popups-to-escape-sandbox` only — **no**
  `allow-scripts`, **no** `allow-same-origin`; CSP from `reader-frame.js`;
  remote images blocked by default (privacy + tracking-pixel defense).
- **Injection.** `buildMime` CRLF-scrubs and token-rebuilds address headers;
  outbound encoded-words cannot carry a line break (comment-verified).
- **Provenance & message boundary.** Embed nonce gate at boot; worker router
  checks `sender.id`; trusted-event chord for in-page verbs.
- **Token.** Session-area storage (`chrome.storage.session`, local only when
  absent — documented); never logged (scan clean); never exported —
  `backup.ts` uses an allow-list from `storage-registry.js` that excludes
  tokens, cache, outbox, activity; server-side revoke on sign-out;
  ACCOUNT_CHANGED identity proof on **every** silent renewal.
- **Dependency posture.** `npm audit`: 0 vulnerabilities; Dependabot
  configured; security workflow present.
- **Deductions.** Fallback mode moves the live token into the page context
  (documented, but a real surface increase — area 09); `notifications`
  permission requested while dead (ARN-L1); **repo-ops secret hygiene is
  poor**: a `GOCSPX-` client secret sits in v1 git history and this
  commissioning chat contains the repo's **third** leaked `ghp_` PAT
  (ARN-P1) — shipped-tree hygiene 9/10, operational rotation discipline
  4/10 (area 42).

No XSS, exfiltration, or confused-deputy path was found in this pass.

---

## F. Data integrity

| Mechanism | Verdict |
|---|---|
| Cursor: fetch/refresh → `store.batch` → `persistBeforeCursor` → `SYNC_COMMIT` | **Sound** (AUD-I02 closed; prepare-then-commit verified) |
| `commitHistoryId` monotonic commit | **Sound** |
| Worker outbox pump | **Fixed** at `f53175c` — live reload before every mutation (EXT-H1 closed) |
| Enqueue path | **Open** — non-atomic get-then-set (ARN-M9) |
| Crash recovery | **Open by design** — demote-to-failed auto-retry duplicates (ARN-M4) |
| Mixed-mode dispatch | **Open** — dual dispatcher without shared lock (ARN-M3) |
| Snooze map | **Open** — not account-scoped; account-switch destroys the other account's schedule (ARN-M5) |
| Snoozed mailbox read | Creates `BMM/Snoozed` label server-side on an empty view (ARN-L2) |

The send pipeline's integrity story is therefore *good at the cursor,
imperfect at the queue*: the two remaining mechanisms both live in the
outbox, and both are duplicates-or-loss under races/crashes rather than
steady-state operation. That is why areas 23/24/40 score 5/5/6 despite an
otherwise careful module.

---

## G. MV3 lifecycle

Verified good: event-driven worker; `chrome.alarms` for all deferred work
(the one `auth.js` `setTimeout` documents its own unreliability and arms an
alarm backstop — correct); AUTH_RETRY is single-shot and never self-re-arms;
per-verb timeouts in the app layer; `scheduleBackgroundSync` actively clears
the SYNC_ALARM while disabled.

**ARN-M1 — the 5-second loop (MEDIUM, probe-verified).** For a past-due
snooze that cannot wake (signed out, token revoked, or offline so
`ensureLabel` throws), `wakeDue` returns `0` keeping the rows, and
`scheduleWake`/`nextWakeAt` re-arms at `Math.max(next, now + 5000)` —
`snooze/model.js:183`. Probe:

```
nextWakeAt({ m1: { at: now-3600000 } }, now)  →  now + 5000 ms
due({ m1: { at: now-3600000 } }, now)         →  ['m1']
```

So the worker wakes every ~5 s **indefinitely**, burning battery/CPU on a
row that can never succeed, until the user signs back in or the row
disappears (upholds R2-M3). **Remediation:** exponential floor on unwakeable
re-arms (5 s → 5 min cap), or age out rows past `at + grace` with an honest
"snooze expired while signed out" surfacing in the rail. **Regression pin:**
100 consecutive past-due unwakeable cycles schedule ≤ 6 alarms.

---

## H. Gmail / API layer

Verified: multipart batch ≤ 100 with `parseBatch` boundary handling;
`fetchRetrying` honors `Retry-After`, exponential backoff with jitter,
AbortSignal wiring; `history()` capped at 10×500 pages; `normalise()` is a
deliberate trust boundary; drafts hydrate attachments at the wire so a dead
part fails one item loudly, not the batch.

**Deductions.** ARN-H1 (no inbound RFC 2047) lives here — the single largest
*user-visible correctness* defect of this pass; `decodeEntities` covers a
fixed HTML-entity subset only (EXT-L3, still open); `getDraftForMessage` can
page 20×500 on a reply-open (EXT-I3, INFO). Area 10 = 6/10.

---

## I. Sync

The single-consumer engine is correct: prepare-then-commit, monotonic
cursor, ordered fate map in `reduceHistory`, too-old-404 fallbacks. But:

- **Area 13 (6/10):** correctness was preserved at the cost of the feature
  set — the 15-min sweep is compiled off, and the cursor-critical file has
  the shallowest line coverage in the gate (58.77 % line vs a 55 % floor,
  ARN-M7). A prepare-then-commit engine with ~41 % of its lines unexecuted
  in tests is a file one refactor away from a regression nobody sees.
- **Area 14 (4/10):** the two-consumer design problem (AUD-I01) is not
  solved, it is *amputated*. Per-account cursor state and a reconciled
  multi-consumer protocol remain undesigned.
- **Area 15 (2/10):** dead in production — sweep, notification selection,
  `mergeNotified`, `cardText`, and `persistDiag` all unreachable (ARN-M6,
  ARN-L3); `notifications` permission still requested (ARN-L1); settings
  honestly labels the feature "temporarily unavailable" and README admits no
  desktop notifications — the disclosure is what lifts this above 1.

---

## J. Storage / EmailStore

**Store (`mail/store.js`) — 8/10.** Per-mailbox Map + order + category /
thread / search indexes, MAX_MESSAGES 2000, incremental indexing on insert,
memoized reads, one notify per batch; bench: 2000 inserts in 33.9 ms, 100
searches in 18.7 ms. Damaged-record totality guarded (fuzz round 3).

**chrome.storage layer — 6/10.** Single seam with live-binding Proxy (test
harness can swap `globalThis.chrome` per boot — thoughtful); versioned
packed-row cache (16 fields, cap 500, idle-coalesced saver);
storage-registry enumerates every key. Deductions: single-key blobs under
concurrency (EXT-L4), no CAS primitive (root of ARN-M9), and the registry's
claim that diag counters are "flushed on the sweep tick" is false while the
sweep is compiled off (ARN-M6).

**IDB adapter — 6/10.** Clean AREA contract, self-healing
versionchange/blocked handling — and zero consumers (declared "built,
deliberately unconsumed"). Shipping dead infra is a choice, not a defect,
but it is also 100+ lines of untested-in-production surface.

---

## K. UX / accessibility

Verified: WCAG AA contrast gate green across all themes; listbox semantics
with `aria-activedescendant` and stable row ids; per-row tick labels derived
from subjects; reduced-motion is honored by *not creating* motion nodes
rather than running them at 1 ms; empty states tell mailbox-specific truths;
search-hit highlighting; hovers verbs over the date slot; undo ghost
animation with measured (not hardcoded) target rects; disabled features are
labeled disabled with honest copy. Keyboard layer and palette read as
complete (verified by reading + prior pins, not interactively — §S). Scores:
a11y 8, keyboard 8, motion 7 (lightly verified), responsive 7.

The UX-adjacent deductions in this pass are honesty defects, not pixels:
the fallback header comment promises snooze catch-up that no code performs
(ARN-M2), the snoozed view creates a Gmail label as a read side-effect
(ARN-L2), and RFC 2047 garbage (ARN-H1) is, above all, a rendering defect.

---

## L. Performance

Bench at `f53175c`: classify 2000 → 8.8 ms; store 2000 → 33.9 ms; 100
searches → 18.7 ms; renders per batch → 1. Delta sync is free at the DOM
layer (guarded writes skip unchanged nodes). Bounded everything: 2000 msgs
in memory, 500 cached headers, LRU bodies, batch ≤ 100, history ≤ 10 pages,
MAX_PUMP_BATCH 8. App-layer memory: 7/10. **Battery/wake discipline: 4/10**
— solely ARN-M1's 5-second loop; without it this area is 8.

**Test-environment performance** is the outlier: the integration file's 97
jsdom boots leak to ~1.4 GB (ARN-H2). Test infra only — recorded under
areas 02/44, not 37.

---

## M. Test quality

Extraordinary breadth for a browser extension: 2,022 tests, 152 files,
fuzz/mutation/a11y/contrast/visual tooling, CI sharding, a 27-invariant
selfcheck, and a culture that pins regressions named in audits. And yet,
honestly:

1. The headline local command is red (ARN-H2).
2. The most correctness-critical file has a floor **tuned just below
   measured** (55 % / actual 58.77 %) rather than ambition-driven (ARN-M7);
   floors were set bottom-up from coverage, so the gate can never catch a
   *loss* of sync test depth.
3. Zero RFC 2047 fixtures in 37k lines of tests (ARN-H1).
4. The pump/enqueue race class has a property-test-shaped hole (ARN-M9).
5. `check-docs` asserts a declared count (1998) that no longer matches the
   runtime counter (2022); the gate passes because it checks the declaration.

Composite area 44: **6/10** — volume and tooling 9, honesty of floors 4.

---

## N. Maintainability

Comment density 0.67 with comments that record *why* (audit references at
the fix site), clean dependency direction, no import cycles, pure
`classify/` + `shared/`. Deductions: `main.js` is a 3,884-line, ~260-function
god module (ARN-M11; grew 42 lines since EXT-M4 flagged it); string-typed
error taxonomy (ARN-M10); four stale comments/docs found this pass (ARN-M2,
ARN-M6 registry claim, ARN-L4, plus the count drift ARN-I3) — each small,
collectively a signal that the comment discipline which makes this repo
reviewable also rots silently. Area 47: 7.

---

## O. Release & migration

Manifest v2.0.0; packed cache is versioned (`v1` guard); IDB numbers from
v1 with the version-numbering convention already documented in-place;
backup export is allow-listed. Missing: no changelog/release-notes
discipline in-tree; the disabled-sweep state is a *release configuration*
that has persisted with no visible path back (area 15); Chrome Web Store
policy readiness (disclosure of `identity`/host access, privacy practices)
unassessed — §S. Area 48: 6.

---

## P. Recovery & observability

Recovery: session self-heals (`versionchange` close, blocked IDB retried on
next read); token renewal has a single-shot alarm backstop; OUTCOME_UNKNOWN
discipline prevents mutation replay after ambiguous timeouts; undo-send
hold (8 s) plus backoff ladder (15/60/300/900 s).

Observability — **the weakest verified area (4/10)**: `diag.js` counters
(requests/retries/renewals/mismatchClears) are collected and **never
persisted** — the sole `persistDiag()` call (`index.js:751`) sits behind
the disabled sweep guard. A user reporting "sync feels slow" has no
counters to show; support has no telemetry (deliberately — good) *and* no
local diagnostics (accidental — bad). ARN-M6.

---

## Q. Improvement opportunities (highest leverage first)

1. **Decode RFC 2047 inbound** (ARN-H1) — the best correctness-per-line
   change available; ~100 lines + fixtures.
2. **One atomic `mutateOutbox` + one dispatcher** (ARN-M9/M3) — closes both
   duplicate-and-loss classes in the send pipeline at a single seam.
3. **Bounded re-arm for unwakeable snoozes** (ARN-M1) — battery and
   correctness; trivial diff at `snooze/model.js:183` + one policy decision
   (age-out + honest rail surfacing).
4. **Decide the background sweep's fate** — either design per-account cursors
   and re-enable (fixes ARN-M6, ARN-L1, ARN-L3, area 15 at once), or delete
   the dead code and the `notifications` permission in the next release.
5. **Raise `sync.js` floors ambition-first** (ARN-M7) — pick 80 % line, add
   tests until green; invert the direction the floors were born from.
6. **Account-scope the snooze map + clear on signOut** (ARN-M5).
7. **Error-code module** (ARN-M10) — then pins test codes.
8. **Course-code gate** (ARN-M8) — department whitelist or anchoring +
   digit-boundary + case discipline; keep the 0.90 bonus only for hits the
   gate passes.
9. **Split `main.js`** (ARN-M11) along the already-visible seams (transport,
   boot, ctx).
10. **Demote-to-uncertain policy** (ARN-M4) — a checkbox-level UX decision
    with a duplicate-send downside.
11. Ship or scrap `platform/idb.js` (ARN-L5); silence the stale comments
    (ARN-M2/L4/I3) in the same hygiene commit.

---

## R. Reconciliation with prior audits + phased roadmap

### Prior-finding status at `f53175c` (all re-verified this session)

| Prior ID | Claim | Status at `f53175c` |
|---|---|---|
| AUD-I01 (CRITICAL) | history cursor shared by two consumers → consumed-without-apply mail loss | **CONTAINED BY AMPUTATION** — `BACKGROUND_SYNC_ENABLED=false`; design unresolved (area 14) |
| AUD-I02 (CRITICAL) | commit-before-durable-apply | **CLOSED** — fetch/refresh batch → persist → SYNC_COMMIT verified |
| CAN-H1 / EXT-H1 (HIGH) | worker pump overwrites concurrently-enqueued rows | **FIXED** — live reload before every mutation (`index.js` OUTBOX_PUMP) |
| CAN-H2 (HIGH) | crash-demote auto-retry duplicates | **OPEN, test-pinned** → ARN-M4 |
| CAN-C3 | two dispatchers, one lock | **RESIDUAL** → ARN-M3 |
| CAN-H4 | fallback labelName mismatch | **FIXED** (verified in `fallback.js`) |
| R2-M1 / R2-M2 | pump re-arm starved by foreign rows | **FIXED** — blocked rows excluded from `nextWakeIn`; 250 ms floor sound |
| R2-M3 | past-due snooze re-arm cadence | **OPEN** → ARN-M1 |
| EXT-H2 (HIGH) | `npm test` OOM | **OPEN** → ARN-H2 |
| EXT-H3 (HIGH) | leaked PAT | **RECURRED (3rd)** → ARN-P1 |
| EXT-M1 | enqueue get-then-set | **OPEN** → ARN-M9 |
| EXT-M2 | string error taxonomy | **OPEN** → ARN-M10 |
| EXT-M3 | coverage gate absent from CI | **FIXED** — `ci.yml:103–104` runs `npm run coverage` |
| EXT-M4 | god module | **OPEN, grew** → ARN-M11 |
| EXT-L3 | entity-decode subset | **OPEN**; shadowed by ARN-H1 |
| EXT-L4 / EXT-I3 | single-key blobs; draft paging quota | **OPEN / accepted** (INFO) |
| EXT-I1 | idb.js unconsumed | **OPEN (declared)** → ARN-L5 |

### Phased roadmap

- **P0 — next patch:** align `scripts.test` heap with CI (ARN-H2); RFC 2047
  inbound decode + fixtures (ARN-H1); bound the past-due re-arm (ARN-M1).
- **P1 — send-pipeline integrity:** atomic `mutateOutbox` everywhere
  (ARN-M9); single dispatcher / shared lock (ARN-M3); demote-to-uncertain
  decision (ARN-M4); account-scoped snoozes + signOut clear (ARN-M5);
  error-code module (ARN-M10).
- **P2 — feature fate:** resurrect (per-account cursors) or remove the
  sweep; wire or delete `persistDiag` (ARN-M6); drop `notifications` until
  then (ARN-L1); fallback wake + honest comments (ARN-M2); sync.js coverage
  ≥ 80 % ambition (ARN-M7).
- **P3 — polish & scale:** course-code gate (ARN-M8); `main.js` split
  (ARN-M11); IDB consumer or deletion (ARN-L5); i18n scaffolding (area 35);
  stale-comment sweep (ARN-L4, ARN-I3).

---

## S. Assumptions & unverified

1. **No live Gmail / browser run.** No end-to-end signed-in sync, send, or
   render was possible in this sandbox. ARN-H1's wire half rests on
   documented Gmail API behavior (raw RFC 5322 header values); the code-side
   absence and passthrough are CONFIRMED by execution.
2. **OOM reproduction** (ARN-H2) is Node/OS-dependent: Node v20.20.2, linux
   x64, this sandbox. The mechanism (jsdom retention vs 1400 MB) is
   machine-independent in direction, not in exact threshold.
3. **Light verification only:** motion suite, options/settings panel tails,
   keyboard map, responsive breakpoints — read plus prior pins, not
   exercised interactively. Their scores carry that caveat.
4. **Store compliance** (CWS policy, privacy-practices disclosure) not
   assessed.
5. **`fallback.js` parity** was verified module-by-module for the verbs read
   (verbs/timeouts/SAFE_FALLBACK_REPLAY); not every one of the ~30 verbs was
   individually diffed against the worker router.
6. **Two prior audit docs' numeric claims** (line counts, test counts at
   their trees) reproduced only at their stated trees; this report's numbers
   are for `f53175c`.

---

## §50. The 50-area rating table (1–10, honest, low where warranted)

Scale: 10 = exemplary, industry-reference; 7–8 = solid, minor verified gaps;
5–6 = functional with verified defects; 3–4 = materially deficient;
1–2 = absent/broken. N/A areas are scored on verification-depth-adjusted
evidence. Area 50 is the computed composite, not a vote.

| # | Area | Score | One-line justification (evidence in §A–§S) |
|---|---|---|---|
| 01 | Repository state & git hygiene | 7 | clean main, audits committed, selfchecks; minus: 2 stale branches + secrets sitting in v1 history |
| 02 | Baseline command verification | 5 | `npm test` red on clean checkout (ARN-H2); every other gate green |
| 03 | Dependency & supply chain | 8 | 0 vulns, Dependabot, lockfile, tiny dep surface |
| 04 | Manifest V3 & permission minimality | 7 | tight hosts/CSP; minus: dead `notifications` (ARN-L1) |
| 05 | Content script / takeover | 8 | mount-only, embed nonce, no observers/loops |
| 06 | App boot & provenance gating | 8 | nonce gate + deep-link handling verified |
| 07 | MV3 service-worker lifecycle | 7 | event-driven, alarm backstops; minus: 5 s loop reachable (ARN-M1) |
| 08 | OAuth flow correctness | 7 | silent renew + identity proof each renewal; implicit flow only |
| 09 | Token storage & handling | 7 | session area, revoked, never logged/exported; minus: fallback puts it in page context |
| 10 | Gmail API client | 6 | batch/retry/caps solid; minus: ARN-H1, entity subset, draft paging |
| 11 | Header decoding / inbound RFC 2047 | 3 | absent; probe-verified garbage rendering + misclassification |
| 12 | MIME composition (outbound) | 8 | CRLF scrub, encoded-words, wire-time hydration |
| 13 | Sync engine & cursor discipline | 6 | prepare-then-commit sound; minus: feature amputation, 55 % floor |
| 14 | Multi-consumer history design | 4 | contained by amputation; per-account cursors undesigned |
| 15 | Background sweep & notifications | 2 | dead in production, permission retained; honest disclosure lifts it off 1 |
| 16 | Diagnostics & observability | 4 | counters collected, never persisted (ARN-M6) |
| 17 | Error taxonomy & propagation | 5 | OUTCOME_UNKNOWN discipline strong; minus: substring dispatch (ARN-M10) |
| 18 | chrome.storage architecture | 6 | good seam/registry/versioning; no CAS (ARN-M9), blob keys, false registry claim |
| 19 | IndexedDB layer | 6 | clean contract, self-healing; zero consumers (ARN-L5) |
| 20 | Header cache | 7 | packed rows, caps, coalesced saver; single-key blob |
| 21 | Email store (in-memory) | 8 | incremental indexes, memoization, totality guards, bench-verified |
| 22 | Classification engine accuracy | 6 | deterministic & fast; course-code FPs verified (ARN-M8) + ARN-H1 skew |
| 23 | Outbox state machine | 5 | undo/backoff/uncertain good; demote-to-failed dup mechanism test-pinned (ARN-M4) |
| 24 | Outbox dispatch concurrency | 5 | in-page claims good; worker ignores them (ARN-M3); enqueue non-atomic (ARN-M9) |
| 25 | Draft handling | 7 | wire-time hydration, saver discipline; quota-heavy reply-open (EXT-I3) |
| 26 | Snooze subsystem | 4 | catch-up design good; loop (M1), no fallback wake (M2), no account scoping (M5), label-on-read (L2) |
| 27 | Multi-account / switching | 6 | sessionEpoch + stamped outbox rows; minus: snooze bleed (ARN-M5), legacy fail-open rows (ARN-I2) |
| 28 | Worker-down fallback mode | 6 | verb parity + honest banner; minus: token in page, no snooze wake, false comment (ARN-M2) |
| 29 | Reader & HTML sanitizer | 9 | allow-list walk, sandbox w/o scripts, image blocking, fail-closed — reference quality |
| 30 | Search (local + server) | 7 | honest REMOTE provenance, chips, hit highlight; stale header comment (ARN-L4) |
| 31 | Keyboard & command palette | 8 | complete map, focus discipline (read + pins; §S.3) |
| 32 | Accessibility | 8 | AA gate green, listbox aria, live regions, reduced-motion |
| 33 | Motion & visual polish | 7 | measured-rect animations, reduced-motion by construction; lightly verified (§S.3) |
| 34 | Responsive / adaptive layout | 7 | density modes, breakpoint discipline; lightly verified (§S.3) |
| 35 | Localization & non-ASCII readiness | 3 | hardcoded English UI + ARN-H1 makes non-ASCII *mail* hostile |
| 36 | Performance (throughput/latency) | 8 | bench: 8.8/33.9/18.7 ms, 1 render per batch |
| 37 | Memory management (app) | 7 | bounded everything; (test-suite leak scored at 02/44) |
| 38 | Battery & worker-wake discipline | 4 | would be 8; ARN-M1's indefinite 5 s loop |
| 39 | Offline behavior | 6 | body LRU + outbox-as-send-queue + ARCHIVE intents; read coverage thin |
| 40 | Data integrity & durability | 6 | cursor sound; queue keeps 3 open mechanisms (M3/M4/M9) |
| 41 | Privacy posture | 8 | no telemetry, image blocking, backup allow-list, tight CSP |
| 42 | Secrets management (repo ops) | 4 | shipped tree clean (9/10) but 3rd PAT leak + GOCSPX in history (ARN-P1) |
| 43 | XSS / injection security | 9 | all sinks constant, sanitizer exemplary, header scrub — verified sink-by-sink |
| 44 | Test quality & coverage honesty | 6 | 2,022 tests + fuzz/mutation; minus: red local gate, tuned floor, fixture holes |
| 45 | CI/CD gating | 7 | shards, selfcheck, docs/contrast/coverage gates; local↔CI divergence |
| 46 | Documentation honesty | 6 | admits dead features; minus: 4 stale/false comments found this pass |
| 47 | Maintainability & code health | 7 | 0.67 comment ratio, clean deps; god module (ARN-M11) |
| 48 | Release & versioning practice | 6 | versioned cache/IDB conventions; no changelog; sweep limbo |
| 49 | Backup / recovery / migration | 6 | allow-listed export, session self-heal; import-path depth unverified (§S.5) |
| 50 | **Final system-wide composite** | **6.3** | unweighted mean of 01–49 = 307/49 = **6.27** |

**Composite statement.** Unweighted mean **6.3/10**. Decomposed:
security-critical areas (09, 29, 41, 43) mean **8.25**; core mail path
(10–13, 21, 23, 24, 29, 40, 43) mean **6.5**; reliability queues/timers
(13, 14, 15, 23, 24, 26, 38, 40) mean **4.5**. 11 areas ≥ 8; 8 areas ≤ 4.

Verdict in one sentence: **a security-architecture reference implementation
carrying a reliability layer that has not earned the same trust — fix the
RFC 2047 hole and the test gate (P0), then make the queues and timers as
honest as the locks (P1).**

---

## Postscript — credential safety (ARN-P1)

The GitHub PAT supplied to commit this audit was transmitted in plaintext
chat. Per this repository's own `DO-THIS-NOW.md`, two `ghp_` tokens have
leaked the same way before, and a `GOCSPX-` OAuth client secret sits in v1
history. **Revoke this token now** at https://github.com/settings/tokens
(this push used it exactly once; it was never written to `.git/config` or
any tracked file), and prefer fine-grained, short-lived tokens plus an
environment variable or credential helper for future pushes.

---

*Auditor: Arena.ai Agent Mode (independent third pass). Tree `f53175c`.
No production code modified; artifact confined to `audits/`.*
