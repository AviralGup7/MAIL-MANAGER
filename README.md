# BITS Mail Manager

A Chrome extension that takes over the Gmail tab and replaces it with a faster,
BITS-Pilani-aware inbox. One click (or `Ctrl+Shift+M`), Gmail slides out, this
slides in. `Esc` gives the page back.

Version 2. Version 1 worked but became slow and drifted from the idea; the
classification rules were the good part and they are carried over here, bugs
fixed. Everything else was rebuilt.

---

## What it does

- **Sorts every message into 15 BITS categories** — AUGSD, Academics, Practice
  School, Internship, Competitions, Clubs, Events, Library, Technology, Admin,
  Administration, Ext Services, Ext Promotions, Spam, Other — using ~200
  hand-curated sender and keyword rules built around Pilani's actual mailing
  lists.
- **Takes over the Gmail page in place.** Not a side panel, not a new tab. The
  URL stays `mail.google.com`.
- **Read and triage:** open, search, star, archive, delete, mark read/unread,
  per-category counts. Composing and replying hand off to real Gmail — this is
  deliberately a read-and-triage tool.
- **Keyboard first:** `j`/`k` move, `Enter` open, `e` archive, `s` star, `u`
  unread, `#` delete, `r` refresh, `/` search, `Esc` back to Gmail.

---

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   pick this folder.
2. Open the extension's **Options** and paste a Google OAuth **client ID**
   (see below). The page shows the exact redirect URI to register.
3. Open Gmail, click the toolbar icon or press `Ctrl+Shift+M`.

### Getting a client ID

1. `console.cloud.google.com` → create or pick a project.
2. Enable the **Gmail API**.
3. OAuth consent screen → External → add your BITS address as a test user.
4. Credentials → Create credentials → OAuth client ID → **Web application**.
5. Add the redirect URI shown on the extension's options page
   (`https://<extension-id>.chromiumapp.org/`).
6. Paste the client ID into Options. **Ignore the client secret** — this build
   does not use one and never will. See `SECURITY.md`.

---

## Why it is fast

The previous version's own audit named the cause: the render cycle was welded
to the data pipeline. Every single store mutation fired `renderEmailList` +
`rebuildSearchIndex` + `silentRefresh`, so syncing 200 messages produced dozens
of full re-renders and full index rebuilds inside one synchronous batch. On top
of that, a permanent `requestAnimationFrame` loop drove an 840-line 3D canvas
background that was started on every mount and never stopped.

What changed:

| | v1 | v2 |
|---|---|---|
| Renders per sync of 200 | dozens | **1** |
| Search index | full rebuild per mutation | incremental, never rebuilt |
| Search | O(n) scan per keystroke | inverted index with prefix match |
| Persistence | whole array rewritten per mutation | changed ids, after the batch settles |
| Background animation | permanent rAF loop | none; entrance runs once and stops |
| MutationObservers | 1, undebounced, re-entrant | **0** |
| Timers/polling | 300 ms `silentRefresh` | **0** |
| Classification | async + concurrency semaphore, for pure string matching | synchronous |
| Message cap | 200 | 2000 |
| Permissions | 7 | **3** |
| OAuth scopes | 6 | **1** (`gmail.modify`) |
| Transition durations / easings | 11 / 12 | **3 / 2** |

Measured (`npm run bench`, 2000 synthetic messages, 2-core sandbox — absolute
numbers vary with the machine, the **renders count does not**):

```
classify  10-22 ms
store     30-46 ms
TOTAL     41-68 ms     renders triggered: 1   (old version: dozens)
100 searches  21-29 ms
```

For scale: 2000 messages is ten times v1's entire 200-message cap, and the
whole ingest finishes inside two animation frames.

Three structural decisions do most of the work:

1. **`store.batch()` coalesces N mutations into 1 notification**, and
   **`scheduleRender()` coalesces N notifications into 1 animation frame.**
   The data pipeline and the render loop no longer know about each other.
2. **The list diffs.** A delta sync of 3 new messages touches 3 DOM nodes.
   Every `textContent` write is guarded by a comparison, because writing an
   identical string still dirties the node.
3. **`content-visibility: auto` + `contain: layout paint style` on rows.** The
   browser skips rendering off-screen rows entirely, which gets 2000-row
   scrolling to 60 fps without a hand-written virtualiser.

---

## The takeover

Three options were considered:

- **Overlay div inside Gmail's DOM** — Gmail's own scripts keep mutating the
  tree, and the overlay inherits Gmail's CSS. Fragile.
- **Replace `document.body`** — unrecoverable; Gmail cannot be given back.
- **A full-viewport iframe, with Gmail's roots hidden** ← chosen. The app runs
  in its own origin with its own CSS, Gmail is suspended rather than destroyed,
  and `Esc` unhides it exactly as it was.

The animation: **380 ms in, 260 ms out**, `transform` and `opacity` only, so it
is GPU-composited and never touches layout. `will-change` is dropped the moment
the transition ends. It runs **once** and stops. The frame is not revealed until
the app inside posts `BMM_READY`, which is what prevents the white flash. A
`pagehide` handler restores Gmail, so a crash cannot strand the user on a blank
tab. `prefers-reduced-motion` is honoured in both the JS and the CSS.

Gmail's root elements are found via `document.body.children` — never via
Gmail's obfuscated class names, which change without warning.

---

## Classification

Two stages, carried over from v1 with its scoring constants unchanged:

1. **Sender.** Exact-domain and contains matching against ~200 curated
   patterns. A hit here short-circuits.
2. **Weighted keywords.** `sender ×1.5`, `subject ×1.2`, `snippet ×1.0`, with
   diminishing returns (`0.6`) on repeat hits and an overlap-ratio conflict
   resolver. Confidence is mapped through the original ladder;
   below `0.7` the category tag renders dashed, meaning "guessed".

A BITS-internal sender can never be classified as an external promotion — the
"unsubscribe" in a club mail footer used to win otherwise.

### Four real bugs found while porting the rules

1. `'placement unit'` was in **both** the `clubs` and `internship` sender
   lists, and `clubs` is evaluated first — **every Placement Unit mail was
   filed under Clubs.**
2. `external-promotions` was ordered **before** `external-services` and matched
   the bare substring `'unsubscribe'` — **every GitHub, Substack and arXiv
   notification landed in Promotions.**
3. `'tedxPilani'` had a capital P, but matching runs against a lowercased
   haystack — **dead rule, never fired.**
4. `'augsd'` and `'academic section'` only existed with `@bits-pilani`
   attached, so AUGSD mail from any other address was missed.

Each has a regression test.

`detectBitsSource` does a real domain/subdomain check, so
`bits-pilani.ac.in.evil.com` is correctly rejected — that is the shape of a
phishing sender and v1 would have trusted it.

---

## Layout

```
manifest.json               MV3. 3 permissions, 1 scope.
app.html                    The app shell — static, parsed once, not built by JS.
options.html                Client ID entry.
icons/                      Generated by tools/make-icons.py.
src/
  takeover/content.js       Iframe-over-Gmail, enter/exit animation, Esc, pagehide.
  takeover/takeover.css     transform + opacity only.
  background/index.js       Service worker: click routing, message router.
  background/auth.js        PKCE (RFC 7636). No secret.
  background/gmail.js       REST + multipart batch + MIME body extraction.
  background/sync.js        Page sync and History API deltas.
  app/app.js                Render loop, triage, keyboard.
  app/app.css               3 durations, 2 easings.
  app/store.js              Incremental indexes, batched notification.
  classify/                 Categories, sender rules, pattern rules, scoring.
  options/options.js
test/                       65 tests. `npm test`
tools/make-icons.py         Deterministic icon generation.
```

No build step and no dependencies. `npm test` runs `node --test test/`.

---

## Security

- **PKCE, no client secret.** v1 shipped a live Google OAuth client secret
  hard-coded in `lib/auth.js` in a public repository, with a comment claiming
  this was not a vulnerability. The premise was right — extensions cannot keep
  secrets — but the conclusion was backwards. Extensions are *public clients*;
  the answer is PKCE, not shipping the secret. **That secret is in git history
  and must be rotated.** See `SECURITY.md`.
- The access token lives **only in the service worker**. The app document,
  which renders untrusted mail, never sees it and asks the worker to make calls
  on its behalf.
- Message bodies render in an iframe with **no `allow-scripts` and no
  `allow-same-origin`**, under a CSP of `default-src 'none'; img-src data:`.
  Remote images are blocked, so opening a mail does not confirm your address to
  a spammer.
- No `eval`, no remote code, no CDN. Everything ships in the package.
- Dropped from v1: the `generativelanguage.googleapis.com` host permission (no
  code referenced it), and the `gmail.send`, `gmail.labels`, `userinfo.*`
  scopes.

---

## Status

Working and tested (65 tests, all passing) but **not yet verified on physical
hardware.** Load it unpacked and try it.

Known gaps: no compose or reply by design; attachments list but do not download
(open in Gmail); no thread view — messages are listed individually.
