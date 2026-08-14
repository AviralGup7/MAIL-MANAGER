# BITS Mail Manager

## Contents

- [What it does](#what-it-does) — the mail client, then the BITS-aware parts
- [Themes](#themes)
- [Install (unpacked)](#install-unpacked) · [Getting a client ID](#getting-a-client-id) · [Why the implicit flow](#why-the-implicit-flow-and-not-pkce)
- [Why it is fast](#why-it-is-fast)
- [The takeover](#the-takeover)
- [Classification](#classification)
- [Layout](#layout) · [Seeing it without installing it](#seeing-it-without-installing-it)
- [Security](#security) · [Status](#status) · [Known gaps](#known-gaps) · [Audited, then fixed](#audited-then-fixed)
- [Contributing / quick start](CONTRIBUTING.md)
- [Documentation index](docs/README.md) — architecture, threading, worker, timetable
- [Audits](audits/) — the two load-bearing audits, and where the rest went
- [Security posture](SECURITY.md) and [things only you can do](DO-THIS-NOW.md)


A Chrome extension that takes over the Gmail tab and replaces it with a faster,
cleaner mail client. One click (or `Alt+Shift+M`), Gmail slides out, this
slides in. `Esc` gives the page back.

**A better Gmail that happens to understand student life** — not a student
platform with a mailbox bolted on. The inbox is the centre of gravity and the
BITS-aware parts orbit it: they surface where they help with mail and stay
invisible where they do not.

Version 2. Version 1 worked but became slow and drifted from the idea; the
classification rules were the good part and they are carried over here, bugs
fixed. Everything else was rebuilt.

---

## What it does

**This is a mail client first.** Everything below the first group is a mail
feature; the BITS-specific intelligence exists to make those same tasks
faster, and it stays out of the way when it has nothing to add.

### The mail client

- **Takes over the Gmail page in place.** Not a side panel, not a new tab. The
  URL stays `mail.google.com`.
- **Every message, read or unread.** The list is the whole inbox; the rail
  shows the unread count and the total side by side, so a category full of
  read mail never looks empty.
- **Seven mailboxes** — Inbox, Snoozed, Sent, Drafts, Starred, Spam, Trash.
  Categories apply to the inbox, where they mean something.
- **Read and triage:** open, search, star, archive, delete, report spam (and rescue
  from it), restore from Trash, wake a snoozed message, mark read/unread,
  snooze, multi-select with bulk actions, attachment download, inline images.
- **Conversation threading.** A five-part exchange is one row showing who is
  in it and how many messages; opening it gives a strip of every message,
  oldest first. Actions apply to the conversation, read state stays per
  message, and search deliberately shows the matching message rather than
  hiding it behind a newer reply.
- **Compose, reply, reply-all and forward**, with file attachments, Cc/Bcc,
  correct RFC 2822 threading,
  contact autocomplete drawn from mail you already have, and drafts that
  survive a crash.
- **Undo everything**, not just send — archive, delete, star, snooze and bulk
  actions all reverse with `Ctrl+Z` for five minutes.
- **Category rules Gmail cannot offer:** mute a category, auto-archive it, or
  tell it "wrong category" — the correction is keyed by sender, applies to mail
  already on screen, and can be undone.
- **A deterministic timetable.** Built once from the official BITS timetable
  (688 courses) and the change notice, then updated only by rules that can be
  written down. Course → teacher → section, with linked tutorials and labs
  attached automatically when the document says they belong together. **No
  inference:** if the source does not say it, you are asked rather than
  guessed at. Email can propose a change but cannot outrank the official
  document, and every value explains where it came from.
  See [`docs/TIMETABLE.md`](docs/TIMETABLE.md).
- **Search that knows BITS:** 20 operators, including `category:ps` for the
  classifier's own buckets and `label:Thesis` for your real Gmail labels.
  Your labels are listed in the command palette so you need not remember them.
- **Keyboard first:** 24 shortcuts, and `?` lists them all. `j`/`k` move,
  `Enter` open, `e` archive, `s` star, `u` unread, `#` delete, `z` snooze,
  `!` spam, `c` compose, `r` refresh, `/` search, `Ctrl+K` palette, `Esc` back to Gmail.
- **Seven themes**, every one audited against WCAG AA in CI — Daylight,
  Midnight, Pilani Dusk, Solarised, Nord, a AAA High Contrast, and
  **Cyberpunk**: a fan skin with scanline textures, chamfered controls,
  glitch-in motion and its own synthesized UI sounds, all gated on the theme
  so every other theme stays byte-for-byte untouched.
- **Privacy by default:** remote images are blocked until you ask for them,
  which is stronger than Gmail's proxy. No telemetry, no server.

### What it knows about BITS

The quiet advantage. None of this replaces the inbox or takes over the
navigation — it is reachable from the mail it relates to.

- **Sorts every message into 15 BITS categories** — AUGSD, Academics, Practice
  School, Internship, Competitions, Clubs, Events, Library, Technology, Admin,
  Administration, Ext Services, Ext Promotions, Spam, Other — using ~1000
  generated sender and keyword rules built around Pilani's actual mailing
  lists.
- **Deadlines extracted from mail**, shown in a rail panel *below* the mailbox
  navigation, hidden entirely when there is nothing due.
- **A deterministic timetable** built from the official document, which mail
  can update through strict rules. A secondary tool, opened from a small
  button — see [`docs/TIMETABLE.md`](docs/TIMETABLE.md).

## Themes

Themes are **data**, in `src/app/system/themes.js`, not hand-written CSS blocks. That
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
| Cyberpunk | dark | Neon cyan on near-black maroon. The full skin: textures, chamfered buttons, glitch-in motion, synthesized sounds — all original code, all gated on the theme. |
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
4. Credentials → Create credentials → OAuth client ID → application type
   **Web application**.

   > Yes, "Web application", even though this is an extension. Google's
   > "Chrome Extension" client type only supports `getAuthToken`, which is
   > Chrome-only and does not work in Brave. This is confirmed by Google's own
   > extensions DevRel; see the header of `src/background/auth.js`.

5. Under **Authorized redirect URIs** add the URI shown on the extension's
   Options page, exactly, trailing slash included:

   ```
   https://dgeanijfllibcphbblkhacjcbdehihcp.chromiumapp.org/
   ```

   That is derived from the extension ID, which is pinned by the `key` field in
   the manifest and does not change between reloads.

6. OAuth consent screen → **Test users** → add your BITS address. Without this
   Google refuses consent before the flow starts.
7. Paste the client ID into Options. **Ignore the client secret** — this build
   never sends one.

### Why the implicit flow, and not PKCE

This started as authorization-code + PKCE, which is the correct answer for a
public client in the abstract. It cannot work against Google from an extension:

- Google's token endpoint requires `client_secret` for
  `grant_type=authorization_code` on a **Web application** client. **PKCE does
  not exempt you.** The response is
  `400 invalid_request / "client_secret is missing."`
- Switching the client to type **Chrome Extension**, which *is* a public
  client, does not help: those clients only accept `getAuthToken`-style flows
  and reject a `chromiumapp.org` redirect.
- `chrome.identity.getAuthToken` would avoid the whole problem but is
  Chrome-only, and this is used in Brave.

So every code-exchange route demands a secret. This is the same wall v1 hit,
and v1's answer was to hardcode the secret — which is how it ended up published
in a public repository.

`response_type=token` returns the access token directly in the redirect
fragment. There is no exchange, so no secret can be demanded.

**The trade, stated plainly:** tokens last one hour and there is no refresh
token. Renewal is silent — `launchWebAuthFlow({interactive: false})` with
`prompt=none` mints a new token with no UI while the Google session cookie is
alive. You see a consent screen once.

Security-wise this is not a loss: a one-hour token that cannot be refreshed is
a smaller prize than a refresh token granting `gmail.modify` indefinitely.

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

Rendering is measured too, not just the data layer: `npm run render:bench`
opens the real app in headless Chromium and times boot, page renders, scroll
frame-times and search latency (regression thresholds for software-rendered
CI; real hardware is 10–20× faster). The claim the architecture was built
for — one render per settled state, compositor-only scrolling — holds where
it matters:

```
boot → 100 rows painted    120–140 ms (headless software rendering)
scroll frame-time p95      16.7 ms  — locked at 60 fps even unaccelerated
list page render (100 rows) ~1.0 s software / ~50–100 ms on real hardware
search keystroke → update  ~1.1 s software / ~60–120 ms on real hardware
```

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

The full map, with the rules that keep it true at 4x this size, is
**[docs/STRUCTURE.md](docs/STRUCTURE.md)** (enforced by test/structure.test.mjs).

```
manifest.json               MV3. 4 permissions, 1 scope.
app.html                    The app shell — static, parsed once, not built by JS.
options.html                Client ID + preferences.
icons/                      Generated by tools/make-icons.py.
src/
  styles/                   THE stylesheet as 26 numbered volumes (was app.css);
                            the NN- prefix IS the cascade order, 99- is last
  takeover/                 content.js + takeover.css: the iframe-over-Gmail glue
  background/               service worker: verbs, auth, gmail REST, sync, notify
  shared/                   leaf constants (labels, limits) — imports nothing
  platform/                 the chrome.storage wrapper
  classify/                 the classifier (address-map + pattern-rules GENERATED)
  options/                  options page logic
  app/
    main.js                 THE SHELL: render loop, routing, ctx (was app.js)
    core/                   shared vocabulary: dom, icons, display, sanitize…
    motion/                 the animation kit: springs, camera, light, particles
    system/                 settings, themes, cache, identity, snooze/outbox
                            persistence, backup, fallback, deep-links
    overlays/               layers, menu, dialog, toast, help, settings-panel,
                            palette, the menus
    mail/                   store, list, reader, bulk, rows, undo, rules…
    search/                 query language, suggestions, saved views, chips
    compose/                compose, autocomplete, templates, drafts, outbox
    academic/               timetable suite, deadlines, radar, notices, lanes…
    workspace/              sidebar and the context rails
timetable/data.json         GENERATED. 688 courses, 119 change rows.
timetable/sources/          The two official documents, verbatim.
tools/parse-timetable.mjs   Offline parser. Never runs in the extension.
test/                       1,830 declared tests. `npm test` · `npm run test:ci` (fails on skips)
  app.integration.test.mjs  Boots the real app.html in jsdom and drives it.
  resilience.test.mjs       Failure injection across every persistence module.
  package.test.mjs          Lints the manifest, tokens, motion rules, hit targets.
audits/                     The two load-bearing audits; the retired series is
                            summarised in audits/README.md.
DO-THIS-NOW.md              The short list of actions only the owner can take.
docs/CLASSIFICATION_DATA_PACK.md  Source of truth for every rule and weight.
tools/make-icons.py         Deterministic icon generation.
tools/check-contrast.mjs    WCAG AA audit of every theme. `npm run contrast`
tools/mutate.mjs            Mutation testing. `npm run mutate <test> <src>`
tools/make-preview.mjs      Builds preview.html — the UI on synthetic mail.
tools/gen-pattern-rules.mjs Regenerates pattern-rules.js from the data pack.
tools/gen-address-map.mjs   Regenerates address-map.js from the data pack.
```

No build step and no runtime dependencies. `npm test` runs `node --test test/`.

`jsdom` is an optional devDependency used only by the integration tests. Without
it they skip and the suite still passes; with it, `npm install && npm test`
runs all 1339.

### Seeing it without installing it

```
npm run preview      # writes preview.html, open it in any browser
```

That is the real app — real classifier, real store, real render loop — running
on 20 synthetic BITS emails. Only the network is faked, so if the rules
mis-file something the preview mis-files it too.

---

## Security

- **No client secret, anywhere.** v1 shipped a live Google OAuth client secret
  hard-coded in `lib/auth.js` in a public repository, with a comment claiming
  this was not a vulnerability. The premise was right — extensions cannot keep
  secrets — but the conclusion was backwards: the answer is a flow that does
  not need one. Google blocks the textbook answer (PKCE) for extensions, so
  this uses the implicit flow instead; see above. **That secret is in git
  history and must be rotated.** See `SECURITY.md`.
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

**1,830+ declared tests pass, 0 skipped.** Many of them boot the real `app.html` in a real
DOM and drive it as a user would — click a row, type in search, press `j`/`k`,
archive, snooze, sign out. All seven themes pass WCAG AA in CI.

**Still not run in Chrome against a real inbox.** Everything the tests cannot
reach is unverified: the OAuth consent screen, the takeover animation on a live
Gmail page, how Gmail behaves when its roots are hidden, and real-browser frame
rate — jsdom has no layout engine, so every performance claim here is a
data-layer measurement, not a rendering one.

**The classifier is validated against `docs/CLASSIFICATION_DATA_PACK.md`, not
against real mail.** Every rule and weight matches the pack exactly (891/891
keys, sender order identical), plus 152 curated addresses v1 never read. What
is proven is fidelity to the pack, not accuracy on your inbox. The classifier
correction feature is both the fix for a wrong bucket and the mechanism that
would produce a real corpus.

### Known gaps

- **Gmail labels are searchable, not manageable.** Your labels appear in the
  command palette and `label:Thesis` filters by them, but you cannot apply,
  create or remove a label from the UI. The last significant one-way feature.
- **No desktop notification for new mail.** The inbox refreshes itself every
  two minutes, but nothing tells you while the tab is in the background.
- **No view-original or print.**
- **Single account.** No account switcher.
- **Attachment preview.** Attachments download; they do not preview inline.

### Audited, then fixed

The codebase has been through dozens of autonomous audit-and-fix waves:
correctness, security, performance, accessibility, architecture, testing, two
competitive gap analyses against Gmail, delight, motion, state, and several
whole-app ratings. The point-in-time documents were retired once their fixes
shipped and became test-pinned code; what remains — and why — is in
[`audits/README.md`](audits/README.md). The current campaign's plan and
running record is [`docs/UX-AUDIT-V4.md`](docs/UX-AUDIT-V4.md).

Defects found and fixed by systematic hunting, each verified by sabotaging the
fix before trusting it:

- **Sign-out could be undone by an in-flight token renewal** — the user saw the
  sign-in gate while a live access token sat in storage. Fixed with a session
  epoch. *(security)*
- **Sign-out left every non-active mailbox populated** — the gate appeared, and
  one click showed the previous account's Sent and Trash. *(privacy)*
- **Remote and inline images were both silently broken** — the sanitiser
  allowed `https:` that the frame CSP then refused, so images rendered as empty
  boxes with no explanation, and `cid:` had no handling at all.
- **A global loading flag made a mailbox permanently unloadable** — switching
  mid-load left it empty for the rest of the session, unrecoverable.
- **Malformed headers crashed a whole page of mail** — the same unchecked
  destructure existed at three sites; fixed by extracting one parser.
- **One-row updates re-rendered the entire list** — 549ms to star a message at
  2000 rows, now 8ms and constant-time.
- **`Store.patch()` could corrupt ordering** the same way `upsert()` once did.
- **The starred indicator failed WCAG on 9 of 18 theme/surface combinations**,
  including the theme named "High Contrast", because the colour bypassed the
  token system and the contrast checker never saw it.

`npm run mutate` applies semantic mutations and reports any the suite fails to
catch — it found seven behaviours nothing verified, including the sanitiser's
attribute allow-list.

