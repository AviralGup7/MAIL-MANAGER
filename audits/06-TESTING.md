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
