# TODO

Ordered by **risk × user impact**, not by effort. Thirteen of the original
fifteen items are done; the rest are below, followed by the historical record
of what the finished work found.

Two things are not on this list because they are not code, and they outrank
everything on it:

- 🔴 **Rotate the v1 Google OAuth client secret.** It is in public git history.
  <https://console.cloud.google.com/apis/credentials>
- 🔴 **Revoke the GitHub PATs** used to push this repo.
  <https://github.com/settings/tokens>

Legend — **S**evere · **M**oderate · **L**ow

---

### 1 · Run it in Chrome against a real inbox — **S**

*Nothing below is trustworthy until this happens.* **The suite passes (1,300+ tests, 0 skipped) but the
extension has never run in a browser.** Unverified: the OAuth consent screen,
the takeover animation on live Gmail, how Gmail reacts to having its roots
hidden, and whether `chrome.identity.getRedirectURL()` matches what you
registered.

`chrome://extensions` → Developer mode → Load unpacked → Options → paste a
client ID → open Gmail → `Alt+Shift+M`. Then press **`?`**.

The service worker logs to its OWN console: `chrome://extensions` → the blue
**"service worker"** link. Expect `[BMM] ready. Shortcut: Alt+Shift+M`.

**Done when:** you have opened, read, starred, archived, snoozed and composed,
and written down every defect. Expect several.

**Now also build your real timetable** (`T`, or the toolbar button) and check
it against the printed one. The parse is verified against the source document
for the courses that have tests, but 688 courses is a lot of rows and the
cheapest way to find a bad cell is to look at your own six.

---

### 2 · Timetable parse — **MEASURED, mostly resolved**

`tools/parse-timetable.mjs` turns the official text into **688 courses / 1681
sections** and 119 change rows. The awkward cases have tests: `M W 3 Th 9` must
not become Th3, `Th` is never `T`+`h`, a `M 6 7` lab is two meetings, and an
unparseable cell yields nothing rather than a guess.

The long tail has now been counted rather than guessed at:

| Measure | Count | Verdict |
|---|---|---|
| Sections with any `unresolved` | 242 / 1681 (14.4%) | see below |
| — missing room | 239 | **source is blank** |
| — missing time | 161 | **source is blank** |
| Sections with no instructor | 0 / 1681 | clean |

**Both gaps were checked against the source and the parser is faithful.**

- The 161 with no time are `LABORATORY PROJECT`, `INDEPENDENT STUDY`, thesis
  and similar. The document lists them with credits and an instructor and *no
  schedule at all*, because they genuinely have none.
- The 84 rows where room and time disagree are mostly labs like `BITS U104 P1`,
  which the document prints as `P1  V Manjuladevi  F 8 9` — a time and no room.

So 14.4% unresolved is **the document being incomplete, not the parser losing
data**, which is exactly the behaviour the no-guessing rule demands: the field
stays empty and the user is asked.

**Still worth doing:** open your own six courses in Chrome and compare against
the printed timetable. Aggregate numbers cannot catch a value that parsed
cleanly into the wrong field — which is not hypothetical. Pass 2 found exactly
that: eleven sections had their **compre date sitting in the midsem field**,
including CS F111. Every count was correct; the meaning was not. Fixed via the
legend, but it is the clearest argument for one careful human read-through.

---

### 3 · Conversation threading — **DONE**

Shipped in three steps: the store index, then the list and reader, then the
remaining subsystems. `docs/THREADING.md` records the rules and the two
regressions that shaped them.

The IndexedDB migration was NOT a prerequisite after all. Threading needed an
index over messages already in memory, not more of them on disk — the
migration matters for how MANY messages can be held, which is a separate
question.


### 4 · Migrate the cache to IndexedDB — **M**

`chrome.storage.local` is a 10MB budget and `CACHE_MAX` is 500 messages, which
is why only the inbox is cached. It blocks threading (item 2), attachment
preview and offline support simultaneously.

---

### 5 · Background sync and notifications — **DONE**

The 15-minute `bmm-sync` alarm advances the history cursor via the existing
worker-safe `syncDelta`, so a long absence never builds a delta backlog that
forces a full resync. New mail is classified in the worker and — only when
the user opts in — notified for `augsd` and `academics` only: the one thing
Gmail structurally cannot offer (its notifications are all-or-nothing).
Conservative by design: burst cap of 3 per run, a persisted dedupe list
(cleared on sign-out, since message ids are account-scoped), no notification
while a Gmail tab is open, and the selection logic is a pure module
(`src/background/notify.js`) with its own unit tests.

---

### 6 · Undo Send — **M**

The undo stack covers archive, delete, star, snooze and bulk — everything
except the one thing Gmail *can* undo. Client-side hold, then send. The timer
belongs in the service worker so closing the app still delivers.

---

### 7 · Gmail's own labels — **DONE**

Decided: finish it minimally rather than delete. `LIST_LABELS` is now called
once per session from `start()`, fire-and-forget, and populates a cache that
the command palette turns into "Go to label: X" entries. `label:` is no longer
a silent alias of `category:` — it matches the real `labelIds` a message
carries, case-insensitively, including the leaf of a nested `Parent/Child`.

Three things worth knowing:

- **The palette caps its list at 12.** Label commands are appended after the
  categories and themes, so on an empty query they are legitimately off the
  end. You reach them by typing, which is how anyone uses a palette anyway.
- **Label names are cleared on sign-out.** They are the previous account's
  private data. There is a test for this and it fails when the clear is removed.
- **`features.js` module state survived a test boot** — now fixed at the
  harness level. Only `app.js` is re-imported with a cache-busting URL, so its
  imports keep their state across cases. Two green-but-meaningless tests came
  out of this: one read labels a previous test had seeded, and one asserted
  against a stale DOM because a palette left open made `openPalette()`
  early-return. `_resetFeatureState()` now clears all nine bindings from
  teardown; disabling it fails three tests.

`CREATE_LABEL` remains uncalled by any verb, but it is **not dead** —
`ensureLabel()` uses it internally on every snooze. Leaving the verb is
harmless; the audit finding was about reachability, and that is now resolved
for the half that was genuinely unreachable.

---

### 8 · Add a real rendering benchmark — **M**

jsdom has no layout engine, so the 60fps claim remains an expectation. The
data-layer bench measures classification and store cost only; it cannot see a
dropped frame. Needs headless Chrome.

---

### 9 · Validate the classifier against real BITS mail — **M**

Fidelity to `docs/CLASSIFICATION_DATA_PACK.md` is proven; accuracy is not.
The classifier-correction UI is both the fix for a wrong bucket and the
mechanism that would generate the corpus.

---

### 10 · Screen-reader pass — **L**

ARIA is present and structurally tested; no NVDA or VoiceOver has ever run
against it. Measured accessibility is not actual accessibility.

---

## Historical record

### What the finished work actually found

Fixing these turned up five defects that the audits had not:

- **Sign-out left the previous account's rows on screen.** `store.clear()` only
  *schedules* a render, so clearing `renderedIds`/`nodeById` immediately after
  had them repopulated by the queued frame. The resync path had the same latent
  bug. Both now use one `resetView()`.
- **`release()` did not call `restoreGmail()`** — it repeated the un-hide
  inline, so the restore existed in two places that had to agree and only the
  `pagehide` copy was tested. Sabotaging `restoreGmail` failed one test while
  both round-trip tests passed, proving the path taken by *every normal
  release* was uncovered.
- **The Refresh button passed its click `Event` as the options object**,
  silently enabling silent mode.
- **`content.js` claimed "exactly ONE MutationObserver"** in its header. There
  are none; it was describing v1.
- **The permission guard still asserted `alarms`** after it was removed — found
  by the new CI gate on its first run.

### On verifying tests can fail

Four of these were only found because the test was deliberately sabotaged
before being trusted:

- The first render-invariant test counted DOM writes and **passed** with
  `upsertMany` broken into a per-message loop, because the rAF coalescer
  collapses the notifications anyway. It now asserts notifications *and* writes,
  and the same sabotage fails it.
- The first sanitiser test failed on `<scr<script>ipt>` and looked like a
  sanitiser bug. It was a test bug — the output is escaped text with zero
  script elements. Rewritten to assert on executability, because grepping for
  `alert(1)` cannot distinguish inert text from live markup.

A test that has never been seen to fail is a hypothesis, not a test.

---

## Session log — audit execution

Built from the gap analysis in `audits/07-GMAIL-COMPETITIVE.md`, in its
priority order. At the time of that session: **515 tests, 0 skipped.**
(Now 633 — see the header.)

### Tier 0 — live defects

- **Remote images were silently broken.** `sanitize.js` allowed `https:` on
  `img[src]`; the frame CSP then refused it. The tag rendered, the fetch died,
  the user got an empty box with no explanation. The decision now lives in ONE
  place and the CSP is derived from it, plus a reader bar with a per-sender
  allow-list. Blocking by default is stronger privacy than Gmail, which
  proxies and still confirms the read.
- **Inline `cid:` images had no handling at all.** Resolved from the message's
  own MIME parts via the existing `GET_ATTACHMENT`, capped at 2MB / 20 parts.
  Needed no CSP change: `img-src data:` was already permitted.
- **Draft autosave.** Closing compose or crashing discarded everything typed.
  Debounced local save + restore-on-launch, flushed on `pagehide` where the
  debounce timer can never fire.
- **`?` shortcut overlay.** 13 shortcuts existed with nothing naming them.
  Rendered from `shortcuts.js`, and a test asserts every documented key is
  really handled — which immediately proved `z` and `g` were documented but
  unimplemented, so both were built.

### Tier 1 — core mail client

- **System mailboxes** (Sent, Drafts, Snoozed, Starred, Spam, Trash). The
  audit's "biggest leak": there was no way to see what you had sent. One
  `Store` per mailbox. Non-inbox syncs pass `anchorHistory:false` — otherwise
  loading Sent advances the account-wide history cursor past unfetched inbox
  changes, which is unrecoverable for about a week.
- **Category rules** — mute, auto-archive, and classifier corrections. The
  feature Gmail structurally cannot copy. Muting never hides from search or
  from a category opened by name, and an all-muted list says so.
- **Contact autocomplete**, built from addresses already in the store. No new
  scope, no round trip. Warns on a malformed address rather than blocking.
- **Snooze**, with a catch-up sweep on startup as well as on the alarm — a
  missed alarm must be a late delivery, never a lost message.
- **Search falls back to Gmail** for message bodies. The local index covers
  subject and sender only, so it was silently missing; a confidently wrong
  "no results" is worse than a slow one.

### Measured UI findings

Each was found by measurement, not by looking:

- **The starred indicator failed WCAG 1.4.11 on 9 of 18 theme/surface
  combinations** — 1.77:1 on the default theme, and failing in the theme named
  "High Contrast". Cause: `#eab308` hardcoded in CSS, so it bypassed
  `npm run contrast` entirely. Now a `--star` token; worst case is 4.52:1.
- **`.primary svg` set `opacity: 0.85` then immediately overrode it to `1`** —
  the optical softening was dead code, hidden by a duplicate selector.
- **Two `@keyframes` were defined twice.** Keyframes do not cascade: the later
  definition wholly replaces the earlier, so `toast-in`'s first definition
  described an animation that never ran.
- **`syncReaderActions()` sat after an early return**, so switching to Trash
  never re-evaluated the action bar and "Archive" stayed on deleted mail.
  Found by a behavioural test, invisible to source reading.
- **The client-secret guard was unreachable.** It ran *after* the format check,
  and a real `GOCSPX-` secret fails the format check first — so pasting an
  actual secret produced "That does not look like a client ID" instead of the
  security warning.
- **The file header claimed "no animation runs forever"** while two ran
  forever. Both are correctly gated on loading states; the rule was restated
  accurately and is now enforced by a test that reads the gate.

### New guardrails

`npm test` now fails on: a colour literal that bypasses the theme tokens; a
theme missing a role the CSS consumes; an ungated infinite animation; a
duplicate or orphaned keyframe; a selector defined twice inside one layer; and
any menu row under the 24px hit floor.

### Still open

- 🔴 The OAuth client secret is **not rotated**; both GitHub PATs are **not
  revoked**.
- **Never run in Chrome.** Item 1 above still gates everything.
- No real BITS corpus. Classifier corrections are now the mechanism that would
  produce one.
- Threading, undo-send and background sync are specified in the audit and not
  yet built. `alarms` is now permitted, so the latter two are unblocked.
