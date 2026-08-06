# BITS Mail Manager

A Chrome extension that takes over the Gmail tab and replaces it with a faster,
BITS-Pilani-aware inbox. One click (or `Alt+Shift+M`), Gmail slides out, this
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
- **Six themes**, every one audited against WCAG AA in CI — Daylight,
  Midnight, Pilani Dusk, Solarised, Nord, and a AAA High Contrast.

## Themes

Themes are **data**, in `src/app/themes.js`, not hand-written CSS blocks. That
is what lets `npm run contrast` walk every text/surface pair in every theme and
fail the build on a violation.

It was worth doing. The first run found `--fg-faint` failing AA on every
surface in **both** original themes — 2.95:1 on the light background, 2.72:1 on
the sidebar — and that is the colour used for dates and snippets, which is most
of the text in the message list. Nobody spots that by looking; the
accessibility audit had listed contrast as "not yet measured".

| Theme | Scheme | For |
|---|---|---|
| Daylight | light | The default. Neutral, high legibility. |
| Midnight | dark | The neutral dark. |
| Pilani Dusk | dark | BITS colours — warm sand on deep indigo. |
| Solarised | light | Flat luminance, for long sessions. |
| Nord | dark | Cool and desaturated. |
| High Contrast | light | AAA, heavy borders. Low vision and direct sunlight. |

Adding one is an object in `themes.js`; it appears in the picker automatically.
Run `npm run contrast` before committing — CI runs it too.

---

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   pick this folder.
2. Open the extension's **Options** and paste a Google OAuth **client ID**
   (see below). The page shows the exact redirect URI to register.
3. Open a **fresh** Gmail tab, then click the toolbar icon or press
   `Alt+Shift+M`. (Not `Ctrl+Shift+M` — that combination is the browser's own
   profile switcher and never reaches an extension.)

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
| Persistence | whole array rewritten per mutation | one idle-coalesced write per sync, after paint |
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

Three stages. The rules and every scoring constant come from
`docs/CLASSIFICATION_DATA_PACK.md`, the authoritative export of v1's rule files.

0. **Exact address.** 152 hand-curated BITS addresses → category, O(1) `Map`
   lookup, confidence `0.98`. An exact address is a fact rather than a
   heuristic, so it outranks everything below it.
1. **Sender substring.** ~200 curated patterns matched against the whole `From`
   header. **First rule wins**, so array order is precedence and is not
   negotiable. A hit short-circuits.
2. **Weighted keywords.** `sender ×1.5`, `subject ×1.2`, `snippet ×1.0`, with
   diminishing returns (`0.6`) on repeat hits in the same field and an
   overlap-ratio conflict resolver. Confidence maps through the original
   ladder; below `0.7` the category tag renders dashed, meaning "guessed".

Stages 0 and 2 are generated from the data pack by `tools/gen-address-map.mjs`
and `tools/gen-pattern-rules.mjs`. Both files carry a do-not-edit banner and a
test asserts they stay in sync with the pack — because the first attempt at
this was hand-written and silently drifted (below).

An `isBits` filter runs on both stage 1 and stage 2, in both directions: a BITS
sender can never land in an external category (the "unsubscribe" in a club
mail's footer must not win), and an external sender can never land in an
internal one.

### Stage 0 is new: 152 addresses that were never loaded

v1 shipped `email-mappings/*.json` with 152 curated address→category pairs.
The data pack records that they were **"not loaded by the classifier code at
runtime"** — dead data. Loading them is the single largest accuracy win
available: 70 administration, 32 admin, 15 internship, 10 library, 9 ps,
8 augsd, 8 clubs.

### Two real bugs, found by diffing the port against the pack

1. **`senderExact` was implemented as equality.** The spec says *"email
   includes any exact"*, and the entries are display-name fragments
   (`'placement unit'`, `'tpo'`) that could never equal a whole `From` header.
   Equality made every `senderExact` list unreachable — including all 29
   entries that drive the `technology` category, so technology mail scored
   zero and fell through to whatever matched next.
2. **The `isBits` filter had only one of its two halves.** External senders
   could match internal BITS rules, so `Placement Office <careers@evil.example>`
   was shown to the student as internal placement mail. That is a phishing
   shape, in the category a student is most likely to act on.

`detectBitsSource` also does a real domain/subdomain check, so
`bits-pilani.ac.in.evil.com` is correctly rejected.

### Retraction: four earlier "bug fixes" were wrong

An earlier pass through this repo reported four bugs in v1's rules and
"fixed" them. With the data pack in hand — specifically the sender rule
**order** and the pipeline spec, neither of which I had — all four are wrong.
They are retracted in full in `notes/CLASSIFIER_CORRECTION.md`. The short
version:

| Claim | Reality |
|---|---|
| `'placement unit'` in both `clubs` and `internship` misfiled placement mail | `internship` is rule 7, `clubs` is rule 11 — internship already won. Redundant, never wrong. |
| `external-promotions` first meant `'unsubscribe'` stole GitHub mail | Stage 1 reads the **From header only**. GitHub matched `external-services` correctly all along. |
| `'tedxPilani'` was dead code | The matcher lowercases both sides. |
| `'augsd'` only existed with `@bits-pilani` | Bare `'augSD'` was already in the list. |

Worse than the wrong diagnoses was the second one's "fix": it **reordered**
`external-services` ahead of `external-promotions`, which really did change
behaviour — `newsletter@substack.com` moved from Promotions to Services — with
no evidence for it. The hand-written port had also dropped **802 of 891**
pattern-rule keys and rewritten 70 weights onto an invented scale, while its
header comment claimed a faithful carry-over. All of it is now restored and
generated from the pack.

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
  app/cache.js              Persisted headers; the warm start.
  app/themes.js             Six themes as DATA, so contrast can be audited.
  app/sanitize.js           DOMParser allow-list for untrusted mail bodies.
  classify/                 Categories, sender rules, pattern rules, scoring.
    address-map.js          GENERATED. 152 exact addresses (stage 0).
    pattern-rules.js        GENERATED. 891 keys, original weights.
  options/options.js
test/                       230 tests. `npm test` · `npm run test:ci` (CI, fails on skips)
  app.integration.test.mjs  Boots the real app.html in jsdom and drives it.
  package.test.mjs          Fails if the manifest names a file that is absent.
audits/                     Six audits of this codebase. Start at audits/README.md.
TODO.md                     The next 15 steps, prioritised by risk.
notes/SYNC_BUGS.md          Seven sync/render bugs found before shipping.
notes/CLASSIFIER_CORRECTION.md  Four retracted bug claims, and what was really wrong.
docs/CLASSIFICATION_DATA_PACK.md  Source of truth for every rule and weight.
tools/make-icons.py         Deterministic icon generation.
tools/check-contrast.mjs    WCAG AA audit of every theme. `npm run contrast`
tools/make-preview.mjs      Builds preview.html — the UI on synthetic mail.
tools/gen-pattern-rules.mjs Regenerates pattern-rules.js from the data pack.
tools/gen-address-map.mjs   Regenerates address-map.js from the data pack.
```

No build step and no runtime dependencies. `npm test` runs `node --test test/`.

`jsdom` is an optional devDependency used only by the integration tests. Without
it they skip and the suite still passes; with it, `npm install && npm test`
runs all 230.

### Seeing it without installing it

```
npm run preview      # writes preview.html, open it in any browser
```

That is the real app — real classifier, real store, real render loop — running
on 20 synthetic BITS emails. Only the network is faked, so if the rules
mis-file something the preview mis-files it too.

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

Feature-complete. **230 tests pass**, including 39 that boot the real
`app.html` in a real DOM and drive it as a user would — click a row, type in
search, press `j`/`k`, archive, star.

**Not yet run in Chrome against a real inbox.** Everything the tests cannot
reach is unverified: the OAuth consent screen, the takeover animation on a live
Gmail page, and how Gmail behaves when its roots are hidden. Load it unpacked
and tell me what breaks.

Nine bugs were found and fixed *after* the code was written but *before* it
ever ran: five in the delta-sync reducer, two in the render loop
(`notes/SYNC_BUGS.md`), and two in the classifier (`notes/CLASSIFIER_CORRECTION.md`).
Six of the nine lost or misfiled mail silently — the same failure class that
made version 1 feel broken. The write-ups exist so they do not come back.

**The classifier is validated against `docs/CLASSIFICATION_DATA_PACK.md`, not
against real mail.** Every rule and weight now matches the pack exactly
(891/891 keys, 0 weight differences, sender order identical), and 152 curated
addresses are loaded that v1 never read. But the pack is v1's *rules*, not a
corpus — so what is proven is fidelity to the old logic plus two genuine
repairs, not accuracy on your inbox. A sample of real BITS mail is still the
only thing that can establish that.

Known gaps: no compose or reply by design; attachments list but do not download
(open in Gmail); no thread view — messages are listed individually.

### Audited, then fixed

Six audits ran over this codebase before it had ever launched in a browser:
correctness, security, performance, accessibility, architecture and testing.
They found **23 issues**, six severe. **12 of the 15 follow-up items are
done** — see [`audits/README.md`](audits/README.md) and [`TODO.md`](TODO.md).

Closed since: the 400-row cap that made messages 401+ unreachable by scroll,
click and keyboard; the missing persistence layer, so a second open now paints
from disk and asks only for a delta; the invalid `listbox > ul > option` tree
that made the message list announce as empty; retry with backoff, so a routine
Gmail rate-limit is no longer a hard error; a real `DOMParser` sanitiser
replacing a regex chain that `<svg/onload=>` walked straight through; and
direct tests for the takeover and PKCE sign-in, the two things the product is
named for, which previously had none.

**Still open:** it has not run in Chrome (1), there is no rendering benchmark
(13), and the classifier has never seen real BITS mail (15).
