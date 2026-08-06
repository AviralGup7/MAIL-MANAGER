# Audit 6 — Testing

Scope: what the 121 tests actually cover, and — more usefully — what they do
not.
Method: count assertions per module, then trace which `src/` files are executed
by any test versus merely mentioned.

**Verdict: strong where it is strong, and the two gaps are the two things the
product is named for — the takeover and the sign-in. Neither has a single
direct test.**

---

## Current distribution

| Suite | Tests | Covers |
|---|---|---|
| `classify.test.mjs` | 39 | rules, scoring, address map, data-pack fidelity |
| `store.test.mjs` | 28 | indexes, batching, ordering, eviction, aliasing |
| `sync.test.mjs` | 19 | `reduceHistory` ordering and disjointness |
| `gmail.test.mjs` | 13 | batch parsing, `normalise`, history pagination |
| `app.integration.test.mjs` | 12 | real DOM: boot, render, filter, search, triage, keys |
| `package.test.mjs` | 8 | manifest integrity, secrets, permission creep, sandbox |
| **Total** | **121** | 108 pass + 13 jsdom-dependent skips |

The quality here is genuinely good in one specific respect: **most of these
tests were written in response to a bug that had already occurred**, not
speculatively. The `idsFor` aliasing test, the `reduceHistory` disjointness
property, the manifest-file-existence test, and the data-pack fidelity test all
exist because something real broke. That is the right reason for a test to
exist.

---

## T-1 — SEVERE — the takeover has no test, and it is the entire product

`src/takeover/content.js` is 266 lines implementing the feature the extension
exists for. It is referenced by `package.test.mjs` only as a filename check.

```
$ grep -n "takeOver\|release()\|suspendGmail" test/*.mjs
(no matches)
```

Untested behaviours, all of which are user-visible failure modes:

- `suspendGmail()` records original inline `visibility`/`display` and
  `restoreGmail()` puts them back **exactly**. Get this wrong and the user's
  Gmail tab is permanently broken after one toggle. There is no test that a
  round trip is lossless.
- The `state` machine (`idle → entering → active → leaving`) explicitly ignores
  toggles mid-animation to avoid a half-mounted overlay. Untested.
- `waitForAppReady()` has a 2 s timeout fallback so a failed app cannot hide
  the frame forever. Untested.
- The `pagehide` handler restores Gmail so a crash cannot strand a blank tab.
  Untested — and this is the safety net for every other failure in the file.

This is testable in jsdom today. The harness in `app.integration.test.mjs`
already proves the pattern works: build a fake Gmail DOM (a few `div`s under
`body`), load the content script, drive `BMM_TOGGLE`, assert the roots are
hidden, assert the round trip restores byte-identical inline styles.

**Priority: highest of anything in this audit.** ~10 tests, and it protects the
one behaviour whose failure is unrecoverable for the user.

---

## T-2 — SEVERE — PKCE sign-in has no direct test

`src/background/auth.js` is 244 lines of security-critical code — verifier
generation, S256 challenge, `state` validation, token exchange, refresh
single-flighting, revocation on sign-out. Direct coverage:

```
$ grep -n "signIn\|pkce\|verifier\|challenge\|base64url" test/*.mjs
(no matches)
```

`gmail.test.mjs` only stubs storage so `getToken()` short-circuits on a fake
access token; it never exercises the auth logic itself.

Untested, each with a concrete failure mode:

- `code_challenge` is genuinely `BASE64URL(SHA-256(verifier))` — a bug makes
  every sign-in fail, or worse, silently degrades to a guessable challenge.
- `state` mismatch **throws and aborts** (`auth.js:116`). This is the CSRF
  control. If a refactor turns the throw into a warning, nothing catches it.
- The refresh single-flight (`inFlight`) prevents a thundering herd of refresh
  calls when several requests race an expired token. Concurrency bugs here are
  intermittent in production and trivial to test deterministically.
- `signOut()` revokes the **refresh** token, not the access token — this was a
  real fix, and it has no regression test, so it can silently revert.
- The 400-on-refresh path clears storage and throws `NOT_SIGNED_IN` rather than
  retrying forever.

All of it is testable by stubbing `fetch` and `chrome.identity`, exactly as
`gmail.test.mjs` already stubs `fetch` for the history pagination tests.

---

## T-3 — MODERATE — no test asserts the core render invariant

The most important property in the codebase is stated at the top of `app.js`:

> Data changes go into the Store. The Store notifies ONCE per settled state.
> Rendering happens ONCE per animation frame, no matter how many notifications
> arrived.

`test/bench.mjs` prints `renders triggered: 1` — but it *prints* it, it does
not assert it. A regression that reintroduces per-mutation rendering would make
the number 200 and the suite would still pass green.

This is precisely the defect that made v1 unusable. It should be a hard
assertion in the integration suite: ingest 200 messages, assert the render
callback fired exactly once.

---

## T-4 — MODERATE — 13 tests silently skip, and the default `npm test` hides it

Without `jsdom` installed, `npm test` reports `96 pass, 13 skipped` and exits
zero. That is the correct behaviour for a clean checkout, but it means CI
without a `npm install` step would report success while never running a single
DOM test — including the ones that caught the two most recent real bugs.

**Fix:** keep the graceful skip, but add `npm run test:ci` that installs
`jsdom` and **fails** if any test skips. The distinction between "skipped
because unavailable" and "skipped because broken" must not be invisible.

---

## T-5 — LOW — no coverage measurement, no mutation testing

Node 20 has `--experimental-test-coverage` built in; it is not wired up. There
is no line/branch number for any module, so "well tested" is an impression
rather than a measurement.

More valuable than coverage here would be a small mutation check on
`src/classify/` — flip a comparison, drop a rule — and confirm the suite goes
red. Given that the classifier's 802 missing keys survived both review and a
28-test suite, the suite's sensitivity is an open question.

---

## What is genuinely well covered

- **`reduceHistory`** — 19 tests including the last-event-wins ordering
  property and the add/remove disjointness invariant. This is property-style
  testing and it is the right approach for a reducer.
- **Batch parsing** — malformed JSON, failed sub-responses, LF-only line
  endings, junk input. Written against real observed Google behaviour.
- **Store aliasing** — the `idsFor` copy test includes a case that mutates the
  returned array to prove the store is unaffected. That is adversarial testing
  of your own API and there should be more of it.
- **Package integrity** — asserts manifest files exist, imports resolve, no
  secret is present, permissions have not grown, and the body sandbox still
  lacks `allow-scripts`. This suite catches whole classes of mistake cheaply.
- **Data-pack fidelity** — 891/891 keys and 0 weight differences, mechanically
  verified. The single most valuable test in the repo.

---

## Addendum — autonomous defect-hunting session

Ten investigation cycles, each using a **different** discovery technique.
Suite went 545 → 615 tests. Every fix was verified by sabotage before being
trusted.

### Defects found and fixed

| # | Defect | Found by | Severity |
|---|---|---|---|
| 1 | `views.js` mutators rejected into `async` click handlers — a failed write vanished as an unhandled promise, the view stayed on screen, no error shown | failure injection | High |
| 2 | A **global** `state.loading` flag guarded **per-mailbox** work: switching mid-load left a mailbox **permanently** empty for the session, unrecoverable by re-clicking | race testing (120ms latency) | High |
| 3 | `normalise()` crashed on a header with no `name`, killing a whole page of mail; non-string values flowed downstream and crashed `classify()` and `buildReply()` | fuzzing | High |
| 4 | The same header-parsing crash existed at **three** sites; fixed by extracting one `headerMap()` | regression expansion | High |
| 5 | `Store.patch()` did not reposition on a date change — the identical corruption `upsert()` was already fixed for, reachable through a second door | stress testing | Medium (latent) |
| 6 | Sanitiser's attribute allow-list was **never independently covered**; the `on*` guard silently compensated | mutation testing | Medium |
| 7 | Seven behaviours with no test at all: `Selection.live()`, `saveRules` return value, correction type-validation, `wakeLabel` at zero, empty-name overwrite, `pending` getter, `clear()` no-op notify | mutation testing | Low–Medium |

### Root causes, not symptoms

Three fixes changed the **shape** of the code rather than patching a branch:

- **One failure channel.** `saveView` returned `{ok,error}`; two siblings
  returned `void`, so there was nowhere for their errors to go. All three now
  share one guarded `write()`.
- **One header parser.** The same unchecked destructure appeared three times.
  A test now fails if a fourth appears.
- **One loading flag per mailbox**, and `state.loading` is *derived* in exactly
  one place — asserted by a test that counts its assignments.

### On equivalent mutants

Six surviving mutants were analysed and proven **equivalent** — no input can
distinguish them (e.g. `rawScore >= 5` vs `> 5`, because the fallthrough
computes `0.3 + (5/5)*0.1 = 0.4`). They are documented in the tests rather
than chased, because killing them would mean writing tests that cannot fail.

One mutant is **unkillable in Node**: `cache.js`'s `cancelIdleCallback` branch,
since `requestIdleCallback` is browser-only. Recorded as an environmental
limit, not as coverage.

### Tests that were wrong, not the code

Four times the first version of a test was the defect. Recorded because the
reflex to "fix the code" would have introduced bugs:

- Asserted `loadCache` returns an array; it returns `{messages, savedAt} | null`
  and the caller guards correctly.
- Seeded `bmmCache` instead of `msgCache`, so the corrupt-cache case never ran.
- Flushed the draft saver without scheduling, then asserted a write that
  correctly never happened.
- Used "due 29/02/2024" when bare `due` is not a trigger phrase for numeric
  dates. The parser was right.
- A `noscript` XSS vector looked like a leak because `onerror=` appeared in the
  output — inside an attribute **value**, as inert text.

### Tooling added

`npm run mutate <testFile> <source...>` — applies seven semantic mutations and
reports any the suite fails to catch. This is what found defects 6 and 7, none
of which any other technique surfaced.

### Diminishing returns

Cycle 10 produced one real finding against three equivalent mutants. Every
core module now kills every non-equivalent mutant. Remaining risk is
concentrated in what **cannot** be tested here: real-browser rendering, screen
readers, and classifier accuracy against real BITS mail.

---

## Addendum 2 — cycles 11-13

Three further cycles using techniques not applied in the first ten: auth
lifecycle racing, content-script long-session testing, and cross-module seam
testing. 615 → 631 tests.

### Defects found

| # | Defect | Found by | Severity |
|---|---|---|---|
| 8 | **Sign-out could be undone by an in-flight token renewal.** `signOut()` cleared storage, but a silent renewal already running called `persist()` afterwards and wrote a fresh LIVE access token back. The user saw the gate; a working credential sat in storage. | auth race testing | **Critical (security)** |
| 9 | The same race let a **stale renewal for the previous account overwrite a new sign-in** — reading the wrong mailbox with no indication. | regression expansion | **Critical (security)** |
| 10 | **Sign-out left every non-active mailbox fully populated.** `resetView()` called `store.clear()`, but `store` is a live binding onto the ACTIVE mailbox. The gate appeared; one click showed the previous account's Sent, Trash, Spam and Drafts. | state-transition testing | **High (privacy)** |
| 11 | **`state.signedIn` was assigned in three places and read nowhere.** Clicking a mailbox behind the gate issued a fresh `SYNC_PAGE` and repainted mail for an ended session. | data-flow analysis | **High** |

### Root causes

Defects 8 and 9 share one cause: **clearing state cannot reach work that has
already started.** Fixed with a session epoch — every operation that writes
credentials captures the generation first and refuses to commit if it moved.
A boolean "signing out" flag would not do, because sign-out completes and a
renewal started before it must stay invalid *forever* after.

Defects 10 and 11 share another: **the per-mailbox store refactor silently
changed what "clear the store" means.** `resetView` was written when there was
one store. It now takes `{allMailboxes}` so the resync path (inbox-only,
correct) and the sign-out path (everything) are distinguished explicitly
rather than by accident.

### Confirmed correct under stress

Not every investigation finds a bug, and the negatives are worth recording:

- **Auth single-flight** — 8 concurrent `getToken()` calls produce exactly one
  authorization flow; recovery after a failed renewal works; a mismatched
  OAuth `state` is rejected.
- **The takeover round-trips losslessly** across 15 cycles with late Gmail
  nodes interleaved, preserves `inert` that Gmail set itself, and never
  duplicates its MutationObserver.
- **Bulk actions cannot touch muted mail.** `selection.live(store,
  renderedIds)` resolves against the VISIBLE list, so safety comes from the
  data flow rather than a special case.

### A test that could not fail

The "search overrides mute" test passed even with `applyMute`'s query guard
deleted. Tracing both paths showed why: `visibleIds()` only calls `applyMute`
on the no-query branch, so the search path never reaches that line. The guard
is **defensive redundancy, not the mechanism**.

The test was rewritten to assert on the specific subjects the mute removed,
and then verified against the *real* mechanism (making the search branch apply
the mute), where it fails correctly. Both the test and the source now say
which is which — the fifth time in this project that a mutation "surviving"
turned out to mean the mutant was equivalent rather than the test being weak.
