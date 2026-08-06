# TODO — next 15 steps

Ordered by **risk × user impact**, not by effort. Every item traces to a
specific finding in `audits/`, and each states the finding, the fix, and how
you will know it worked.

Two things are not on this list because they are not code, and they outrank
everything on it:

- 🔴 **Rotate the v1 Google OAuth client secret.** It is in public git history.
  <https://console.cloud.google.com/apis/credentials>
- 🔴 **Revoke the GitHub PAT** used to push this repo.
  <https://github.com/settings/tokens>

Legend — **S**evere · **M**oderate · **L**ow

---

### 1 · Load the extension in Chrome and drive it against a real inbox — **S**

*Nothing below is trustworthy until this happens.* 121 tests pass and the
extension has never run in a browser. Unverified: the OAuth consent screen, the
takeover animation on live Gmail, how Gmail reacts to having its roots hidden,
and whether `chrome.identity.getRedirectURL()` matches what you registered.

`chrome://extensions` → Developer mode → Load unpacked → Options → *Use v1
client ID* → open Gmail → `Ctrl+Shift+M`.

**Done when:** you have opened, read, starred, archived and released, and have
written down every defect. Expect several. Ref: `01`, all.

---

### 2 · Fix the 400-row cap that silently hides mail — **S**

`app.js:181` truncates to 400 and sets `renderedIds` to the truncated list, so
messages 401+ are unreachable by scroll, click **and** keyboard. The sidebar
counts them; the list cannot open them. *Load more* makes the hidden set grow.

Remove the slice and rely on `content-visibility: auto`, which is the
documented reason no virtualiser exists. Measure before and after with 2000
rows.

**Done when:** 600 messages in one category are all reachable by `j`, and a
2000-row scroll holds 60 fps. Ref: `01` C-1, `03` P-3.

---

### 3 · Test the takeover — **S**

266 lines implementing the entire product, with zero tests. If
`restoreGmail()` is not a lossless round trip, the user's Gmail tab is
permanently broken after one toggle.

Build a fake Gmail DOM in jsdom, drive `BMM_TOGGLE`, and assert: roots hidden
on enter; inline `visibility`/`display` restored **byte-identically** on
release; mid-animation toggles ignored; `waitForAppReady` times out cleanly;
`pagehide` restores.

**Done when:** ~10 tests, and deliberately breaking `restoreGmail` turns them
red. Ref: `06` T-1.

---

### 4 · Test PKCE sign-in — **S**

244 lines of security-critical auth with no direct test. Stub `fetch` and
`chrome.identity` — `gmail.test.mjs` already does this for history pagination.

Assert: `code_challenge === BASE64URL(SHA256(verifier))`; a mismatched `state`
**throws**; concurrent `getToken()` calls issue exactly one refresh;
`signOut()` revokes the **refresh** token; a 400 on refresh clears storage and
throws `NOT_SIGNED_IN`.

**Done when:** turning the `state` check into a no-op fails the suite. Ref:
`06` T-2.

---

### 5 · Persist the message cache — **S**

`store.js:30` advertises "DELTA PERSISTENCE" as a headline fix. **Nothing is
persisted.** Every takeover cold-fetches ~100 messages, and the `historyId`
cursor has no local state to be a delta against, which makes the History API
integration mostly decorative.

Write headers on a debounced idle write; hydrate in `boot()` before first
render; then run `SYNC_DELTA` instead of `SYNC_PAGE`.

**Done when:** second open paints from cache in <100 ms and issues a delta, not
a full page. Ref: `01` C-2.

---

### 6 · Fix the listbox ARIA tree — **S**

`listbox > ul > option` is invalid: the `<ul>` breaks the ownership
relationship, so screen readers announce the message list as empty. No row is
focusable and there is no `aria-activedescendant`, so selection is written to
the DOM and never surfaced.

Drop the `<ul>`, append `role="option"` rows directly to the scroller, give
each a stable id, and maintain `aria-activedescendant` in `openMessage()`.

**Done when:** VoiceOver or NVDA announces "Messages, list box, 3 items" and
reads the selected row on `j`/`k`. Ref: `04` A-1.

---

### 7 · Add retry with backoff for 429 / 5xx — **M**

Every non-2xx is fatal and identical. Gmail returns `429` with `Retry-After`
under normal load — a 100-message batch is a burst by definition — and the user
gets `Gmail 429 /messages` with no recovery. Clicking Refresh reissues the same
burst.

Bounded exponential backoff in `api()`: 3 attempts, honour `Retry-After`,
jitter. Distinguish retryable (`429`, `500`, `502`, `503`, `504`) from terminal.

**Done when:** a stubbed 429-then-200 succeeds without surfacing an error. Ref:
`01` C-3.

---

### 8 · Assert the render invariant — **M**

The most important property in the codebase — one render per settled state — is
enforced by convention only. `bench.mjs` *prints* `renders triggered: 1`; it
does not assert it. A regression to per-mutation rendering, the exact defect
that made v1 unusable, would pass green.

**Done when:** ingesting 200 messages asserts exactly one render, and removing
the `batch()` wrapper fails. Ref: `06` T-3, `05` A-3.

---

### 9 · Delete the dead `GMAIL` proxy and the unused `alarms` permission — **M**

`background/index.js:74` routes `type:'GMAIL'` to a generic path builder that
nothing calls. It is a strictly worse interface than the specific verbs — it
would let the app document construct arbitrary Gmail paths, the exact
capability the worker/app split exists to deny.

`alarms` is declared and never used, undermining the 7→3 permission story.

**Done when:** both removed, tests green, `permissions` is `["identity",
"storage"]`. Ref: `05` A-2.

---

### 10 · Fix the reading-pane live region — **M**

`aria-live="polite"` on the whole `#readpane` announces the subject, sender,
date, all tag chips and the action buttons on every open.

Remove it. Make the reader `role="article"` with
`aria-labelledby="r-subject"` and move focus to the subject heading — focus
movement is the correct "you are now here" signal, and it also fixes keyboard
focus being stranded in the list after a click.

**Done when:** opening a message announces the subject once. Ref: `04` A-3.

---

### 11 · Harden the app's `postMessage` listener — **M**

Two of three listeners validate `e.source`; `app.js:810` does not, so any frame
with a handle can post `BMM_SHOWN` and steal focus. Both outbound calls target
`'*'`.

Check `e.source === parent`; replace `'*'` with the Gmail origin.

**Done when:** a message from an unexpected source is ignored, with a test.
Ref: `02` S-2.

---

### 12 · Decide what the body sanitiser is, and label it honestly — **M**

`<svg/onload=alert(1)>` **survives** the regex chain — the `on*` stripper
requires leading whitespace and a solidus is a valid separator. Not exploitable
today because the sandbox has no `allow-scripts`, but the code calls the regex
"defence in depth", inviting someone to add `allow-scripts` believing a second
layer exists.

Either relabel it "cosmetic cleanup, not a security control", or replace it
with a `DOMParser` allow-list walk (~60 lines, no dependency).

**Done when:** the `<svg/onload>` case is in the test corpus and the comment
matches reality. Ref: `02` S-1.

---

### 13 · Add a real rendering benchmark — **M**

Every performance number is headless. Nothing measures `renderList()` against a
layout engine, and the 60 fps claim rests entirely on `content-visibility:
auto` behaving as expected. A regression there is invisible to all 121 tests
and presents as exactly the symptom that killed v1.

Headless-Chrome harness over `preview.html` with 2000 rows: time to first
paint, scroll frame duration, full category-switch render time.

**Done when:** CI fails if a scroll frame exceeds 16 ms. Ref: `03` P-1.

---

### 14 · Add `npm run test:ci` that fails on skips — **M**

Without `jsdom`, `npm test` reports `96 pass, 13 skipped` and exits **zero**. CI
lacking an install step would report success while running no DOM tests —
including the two that caught the most recent real bugs.

Keep the graceful skip for local use; add a CI script that installs `jsdom` and
fails if any test skips. Wire it to GitHub Actions.

**Done when:** deleting `node_modules` fails `test:ci` and still passes `test`.
Ref: `06` T-4.

---

### 15 · Validate the classifier against real BITS mail — **M**

The rules are now byte-faithful to the data pack (891/891 keys, 0 weight
differences, sender order identical) and 152 previously-dead addresses are
loaded. **But the pack is v1's rules, not a corpus.** What is proven is fidelity
plus two genuine repairs — not accuracy on your inbox.

Send ~12 real emails (subject + sender, bodies redacted). Build
`test/corpus.test.mjs` asserting the expected category for each, and treat
every miss as a rule bug to fix in the **pack**, then regenerate.

**Done when:** a real-mail corpus test exists and passes. Ref: `01`, `README`
Status.

---

## Sequencing

**This week —** 1, 2, 3, 4. Item 1 gates everything; 2 is a live data-hiding
bug; 3 and 4 cover the two untested things the product is named for.

**Next —** 5, 6, 7. Persistence is the biggest felt speed win; 6 is the largest
accessibility defect; 7 is the most likely real-world failure.

**Then —** 8–14, cleanup and guardrails that stop regression.

**Ongoing —** 15, as soon as the sample arrives.
