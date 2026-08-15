# Remediation — External Deep Audit (EXT2), round 4

**Baseline:** `16e0d97` (main, after the R3 remediation wave)
**Audit being closed:** `audits/2026-08-15-EXTERNAL-DEEP-AUDIT-AND-RATING.md`
**Method:** every finding re-verified against the code **at `16e0d97`** before
any of it was touched. Several had already been fixed by the R3 wave and are
recorded here as closed-by-others rather than re-fixed. Two of my own findings
were **wrong** and are withdrawn with the evidence.

Operating rules followed throughout: git state checked before work started
(main had moved, and the audit branch was stale); commit **and push** before
testing; commit and push again after each debugging cycle; only targeted test
chunks locally, every run under ~50 s; the full suite left to CI.

---

## 1 · Verified already fixed at `16e0d97` — not re-touched

| Finding | Evidence it is closed |
|---|---|
| EXT2-H7 Unicode search | `search('परीक्षा')`→`['1']`, `search('考试')`→`['2']`, `search('cafe')` folds to `Café`. Fixed by R3-02 with `\p{M}` retention. |
| EXT2-M2 boundary-in-body | `parseBatch` now anchors the delimiter at a line start; my probe returns both parts. Fixed by R3-14. |
| EXT2-H1 `npm test` OOM | Both monolith suites split (115-boot and 141-boot files → 4 + 4 parts); `ci-selfcheck` makes boots-per-file a hard invariant at cap 45 and pins the heap budget at 1400 in both places. 38/38 CI invariants hold. |
| EXT2-M9 account namespacing | R3-04 sweeps every account-scoped key at session end. |
| EXT2-M8 (partial) | The doc gate recomputes the declared count; the *prose* sentence beside it was still stale — closed below. |

## 2 · Fixed in this wave

### EXT2-C2 — CRITICAL — a `404` substring could destroy the local mailbox
`history()` chose the destructive branch with `String(err).includes('404')`.
The error text embeds the request path, which embeds `startHistoryId=<digits>`.
`{tooOld:true}` is not an error report: it makes `syncDelta` answer `resync`,
and the app then clears the store, clears the warm cache and refetches from
zero.

Reproduced, and re-verified after the fix:

```
Gmail 503 /history?startHistoryId=4045678&maxResults=500
  old (includes '404') -> true   -> DESTROYS the mailbox
  new (status === 404) -> false  -> keeps it; kind = 'server'
```

Root cause was the string-typed error taxonomy, so that is what was fixed:
`apiError(status, label, body)` and `networkError(label, cause)` attach
`status`, `code` and `kind` while leaving the message text byte-identical, so
every existing prose pin still passes. `history()` now branches on
`status === 404 || status === 410`; everything else rethrows and the caller
keeps its cursor.

Same taxonomy closed a latent bug one layer over: `hydrateDraftAttachments`
classified with `/Gmail 4\d\d/`, which swallowed **429** into the permanent
lost-attachment class — a rate-limited refetch went straight to stuck instead
of retrying.

### EXT2-H4 — HIGH — a hex message id containing `401` signed the user out
`reportError` matched `/401|invalid_grant/i` against message **text**. Gmail
message ids are hex, so `Gmail 500 /messages/18f401ab77cd0e12/modify` matched
`401` inside the id and ejected the session on an unrelated backend blip.

Structured clone drops `Error` fields across `chrome.runtime.sendMessage`, so
the classification had no way to reach the app. The worker now sends
`status`/`code`/`kind` as response keys, `send()` reattaches them to the
rejected Error, and the auth branch asks `status === 401`. Text patterns are
kept **only** as the fallback for errors that genuinely carry no status
(auth.js's own vocabulary, and anything thrown in-page by the fallback path).

### EXT2-H5 — HIGH — a killed worker could re-send mail
A record left in `sending` was demoted on load to `failed` with `attempts:0,
nextAttempt:0` — which `dueItems` reads as **immediately due**. The next pump
re-sent a message whose request may already have reached Gmail. This is the
duplicate-mail failure that the cross-tab claim, the pump lock and the
settle-and-verify protocol were all built to prevent; the crash path walked
past every one of them.

The old test asserted `state === 'failed'` and `dueItems().length === 1` — it
**pinned the bug as the contract**, which is why it survived every prior audit
green.

Now demoted to `uncertain`: not due, surfaced by `isStuck`, rendered as
"Delivery status unknown — check Sent before retrying", and retryable on
purpose. Same state `markUncertain` assigns to `OUTCOME_UNKNOWN` on the live
path — a worker death mid-flight is the same epistemic state by another door.
A cause is attached so the row explains itself instead of showing a bare
"unknown".

### EXT2-H3 — HIGH — `Store.idsFor(category)` leaked its live memo array
The `'all'` path has sliced since the `renderedIds` aliasing bug; the category
path returned `_memoGet`'s own array. `idsFor('augsd').push(x)` corrupted every
later read until the next flush; `.length = 0` made the category read empty.
Sliced. The A7 memo test asserted reference-equality — it pinned the hazard —
and now asserts equal contents, a fresh array per call, `_memo` genuinely
populated, and that mutating a handed-out copy cannot reach the store.

### EXT2-H6 — HIGH — a granted permission with no caller
`BACKGROUND_SYNC_ENABLED = false` makes `chrome.notifications.create`
unreachable, yet `"notifications"` was still granted — the exact shape v1 was
criticised for, and a Web Store review flag. Withdrawn from the manifest; it
returns in the same commit that re-enables the sweep.

`test/package.test.mjs` could not tell "granted with no caller" from "guarded
caller with no grant" — it scanned for the string `chrome.X` in `src/`. It now
recognises a dormant API explicitly and, in exchange, requires every call site
to be provably unreachable (optional-chained or flag-guarded), with comments
stripped first so prose about an API is not mistaken for a call.

**That tightened test immediately found a real defect:**
`chrome.notifications.clear(id)` inside the `onClicked` handler was unguarded
and would have thrown inside the worker.

### EXT2-L3 — LOW — diagnostics that never flushed
`persistDiag()`'s only call site was the `SYNC_ALARM` branch — the disabled
one — so in production the AUD-Q1 counters never reached storage and
`diagCounters` was permanently absent. Observability that cannot be read is not
observability. It now flushes from the **wake** alarm (the durable tick that
does fire) and from `chrome.runtime.onSuspend`, Chrome's warning before MV3
termination. Still best-effort and never-throwing, per diag.js's doctrine.

### EXT2-M8 / EXT2-H8 / EXT2-M11 — docs and licensing
- The README carried a stale "runs all 1339" three lines under its own count.
  Replaced; count refreshed to 2,019; `docs:check` 6/6.
- "The access token lives **only in the service worker**" was **false** in
  degraded mode — `fallback.js` runs the same Gmail modules in the app
  document. The exception is now stated with its mitigation, rather than going
  unmentioned in the security section, especially as the fallback exists
  because worker registration has actually failed in practice.
- Added `LICENSE` (MIT). A public repo had none.

## 3 · Withdrawn — my findings were wrong

### EXT2-M1 — `parseBatch` drops bodies containing a blank line — **FALSE POSITIVE**
My reproduction used a raw newline inside a JSON string, which is **invalid
JSON**; `JSON.parse` rejected it correctly and the parser was never at fault.
Re-tested with valid pretty-printed JSON carrying a real blank line: the *old*
parser handled it. The `splitOnce` rewrite is kept because it is strictly more
correct — it leaves the body byte-identical to the wire instead of rejoining
with a hardcoded `'\n\n'`, and it accepts a part with no MIME preamble — but it
is a hardening, not a bug fix.

### EXT2-M6 — outbox dispatch fails open — **WITHDRAWN AFTER IMPLEMENTING IT**
I proposed also refusing an unstamped row under an unproved session. Built it,
tested it, and it is wrong: `accountEmail` is absent for an ordinary
single-account install until identity activation completes, and for every
caller that does not thread it through. The stricter rule stranded queued mail
in **seven** existing scenarios — precisely the harm the legacy fail-open
exists to prevent — in exchange for a cross-account send the *stamp* already
prevents on every row written since AUD-C2.

Reverted. The residual exposure is narrow: a row queued before stamping
existed, still queued, sent under a different account. Closing it properly
means backfilling stamps at migration, not refusing mail at dispatch. Recorded
in source and test so it is not re-attempted.

## 4 · Deliberately not touched

- **EXT2-C1 (never run in Chrome)** and **EXT2-C3 (implicit grant removed in
  OAuth 2.1)** — neither is a code change. C1 needs an install and a week of
  real use; C3 needs a product decision about the OAuth client type, with the
  Brave constraint measured rather than assumed. They remain the two findings
  that hold the rating down, and no amount of source work closes them.
- **EXT2-M7** (`main.js` 3,884 lines), **EXT2-M10** (O(vocabulary) prefix
  search), **EXT2-M4** (no `getBytesInUse` budgeting), **EXT2-H2** (source-text
  pinning at scale) — structural, each needing its own staged commit with its
  own tests. Not started rather than half-done.

## 5 · Validation

Targeted chunks only, each well inside the 50 s local ceiling; the full suite
is CI's job.

| Suite | Result |
|---|---|
| gmail · sync · store · worker-dispatch · auth | **175/175** |
| account-identity · outbox · outbox-send · outbox-crosstab | **54/54** |
| package · diag-counters | **105/105** |
| architecture · secrets · structure · storage-registry · reset-registry | **27/27** |
| `npm run types` | clean |
| `npm run docs:check` | 6/6 |
| `npm run doctor` | 19 modules resolved |
| `node tools/ci-selfcheck.mjs` | 38/38 |

Each of the four fixed defects re-verified against its original reproduction
after the fix, and each regression test fails against the parent commit.

## 6 · Standing corrections to the audit's scores

| Dimension | Was | Now | Why |
|---|---|---|---|
| Correctness (verified) | 5 | 7 | The two reachable destructive paths are closed and pinned. |
| Error handling & taxonomy | 3 | 7 | Typed errors with status/code/kind across the wire; string matching survives only as a no-status fallback. |
| Concurrency & races | 5 | 6.5 | The crash-path duplicate send is closed; the 25 ms settle-and-verify mutex still stands. |
| Security — extension surface | 7 | 8 | Dead permission withdrawn, and the permission law can now tell dormant from unpermitted. |
| Observability | 2 | 4 | The counters actually flush. Still five counters, no correlation ids, no export. |
| Documentation truth | 6 | 8 | Both false claims corrected at the source. |
| Test quality | 4 | 5 | Three tests that pinned bugs as contracts are fixed, and the router envelope is testable for the first time. Source-text pinning at scale is untouched. |
| **Overall** | **5.4** | **6.3** | Held below 7 by EXT2-C1 and EXT2-C3, which are not code problems. |

*No finding was closed without evidence, and the two I got wrong are recorded
as wrong.*
