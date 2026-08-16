# Bug Hunt — Round 8

**Commit:** `0ed94f0` (origin/main, clean tree, 23 commits newer than the
previous session's HEAD)
**CI:** green — not re-run, per instruction. **Nothing pushed.**
**Method:** every finding below was produced by *executing* the real module
against a probe, not by reading. Each entry carries the reproduction. Where a
suspicion did not survive the probe, it is recorded in §7 as acquitted rather
than deleted.

**36 findings: 3 HIGH, 12 MEDIUM, 15 LOW, 6 INFO.**

A note on severity, because this codebase is well defended and a list of 36
could otherwise mislead: there is **no crash, no data-loss and no XSS** here.
The sanitiser turned back all ten payloads I threw at it, MIME parsing survived
cyclic input, the store's indexes stayed consistent across 2,050 evictions, and
the outbox refused every malformed record. What follows is mostly *correctness
at the edges* — mail filed in the wrong lane, text that cannot be found,
protocol violations that a strict receiver will reject.

---

## 1 · HIGH

### H-1 · Plus-addressed mail is classified `broadcast`, so it never reaches "Needs reply"

`src/app/system/audience.js` · **correctness / product**

Gmail delivers `me+anything@domain` to the same mailbox — plus-addressing is a
first-class Gmail feature and students use it constantly (`me+jobs@`,
`me+bits@`). `audienceOf` compares the recipient against the signed-in address
literally, so the tag makes it a stranger.

```
audienceOf({to:'me+bits@pilani.bits-pilani.ac.in'}, 'me@pilani.bits-pilani.ac.in')
  → 'broadcast'          (expected: 'direct')
audienceOf({to:'me@pilani.bits-pilani.ac.in'},      same)
  → 'direct'             ✓
```

**Why it is HIGH.** `lanes.js` routes on this. `needsReply` is documented as
"addressed to me personally" and is *the one lane that must never be wrong* —
the module's own comment says so. Mail a human sent directly to the user lands
in `announcements` instead, which is the bulk lane nobody reads carefully.

**Fix.** Strip `+tag` from the local part on both sides before comparing.
Note the same normalisation is needed in `contacts.js` if identity is compared
there too.

### H-2 · RFC 2047 encoded headers are never decoded inbound — they poison the search index

`src/background/gmail.js` (`normalise`) · **correctness / search**

The codebase *encodes* encoded-words when sending (`encodeHeader`) and has no
decoder for the receive path. Gmail's API normally pre-decodes, but not for
every header on every message — and when it does not:

```js
store.upsert({ from: '=?UTF-8?B?SsO2cmc=?= <j@x.z>',
               subject: '=?UTF-8?Q?Caf=C3=A9?=' })

search('jörg')  → []          // the actual name is unfindable
search('utf')   → ['1']       // garbage IS findable
tokens          → ['utf-8', 'caf', 'c3', 'a9', 'sso2cmc', 'j@x.z', 'x.z']
```

Three consequences, compounding: the sender's real name renders as
`=?UTF-8?B?SsO2cmc=?=` in the list; the name cannot be searched; and the
encoding fragments (`utf-8`, `c3`, `a9`) become permanent index entries that
match unrelated queries. `displayName()` passes it through verbatim
(confirmed).

**Fix.** Decode encoded-words in `normalise()`, at the trust boundary, before
`headerMap` values reach the store — the same place every other coercion
already happens.

### H-3 · A non-ASCII subject over ~330 chars emits a header line that violates RFC 2822

`src/background/gmail.js` (`buildMime` / `encodeHeader`) · **protocol**

`encodeHeader`'s comment states base64 "cannot produce a line that needs
folding for a realistic subject". Measured:

```
subject = 'é'.repeat(400)
Subject: line length = 1089 octets     (RFC 2822 limit: 998)
folded?  false                         (no continuation lines emitted)
```

A 400-character subject is unusual but entirely legal, and a forwarded thread
with several `Re:`/`Fwd:` prefixes in a non-Latin script reaches it. Strict
MTAs reject or truncate over-long header lines; the send fails or the subject
is silently mangled, and the outbox reports a failure the user cannot act on.

**Fix.** Emit multiple encoded-words separated by CRLF+space (RFC 2047 §2
explicitly allows this and requires each word to be ≤75 chars).

---

## 2 · MEDIUM

### M-1 · A malformed query silently matches everything

`src/app/search/query.js` · reproduced

```
parseQuery('a OR') → terms:[] operators:[] isEmpty:false → visibleIds: 3 of 3
parseQuery('((')   → terms:[] operators:[] isEmpty:false → visibleIds: 3 of 3
```

`isEmpty:false` claims "this is a real filter", but nothing was parsed, so the
predicate matches every message. The user typed a filter, sees their whole
inbox, and has no signal that the query was not understood. Compare
`'"unclosed'` which correctly yields 0 results.

### M-2 · A single-character search term returns the entire mailbox

`src/app/mail/store.js` (`search`)

Terms shorter than 2 chars are filtered out; when *every* term is dropped the
function falls through to `idsFor(category)` — the whole list. Typing `c` on
the way to `cs f211` flashes the complete inbox. For CJK the floor is lifted
(correct), but the Latin path has no "no usable term" state distinct from "no
query".

### M-3 · `C++`, `C#` and similar tokens are unsearchable

`src/app/mail/store.js` (`tokenize`)

The tokeniser splits on everything outside `[a-z0-9@.\-]` plus letter/mark
classes, so `+` and `#` are separators and the surviving `c` is below the
2-char floor — the token vanishes entirely.

```
subject 'C++ and (parens) [brackets]'
tokens → ['and','parens','brackets','a@b.c','b.c']     // no 'c++'
search('c++') → []
```

Course codes and language names are exactly the terms a student searches for.

### M-4 · Duplicate headers keep the *last* value; RFC says the first

`src/background/gmail.js` (`headerMap`)

```
headerMap([{name:'Subject',value:'first'},{name:'Subject',value:'second'}])
  → { subject: 'second' }
```

A message with two `Subject:` or two `From:` headers is a classic spoofing
shape: the receiving client shows one value while a filter matched the other.
Last-wins hands the attacker the display.

### M-5 · An absurd `internalDate` pins a message to the top of the list for ever

`src/background/gmail.js` (`toEpoch`)

```
toEpoch('99999999999999','') → year 5138
```

`toEpoch` correctly rejects non-finite values (a documented past fix) but
accepts any finite number. A message dated year 5138 sorts above everything,
survives cache round-trips, and cannot be dismissed. `internalDate` is
server-supplied so this is not attacker-controlled *today*, but the `Date:`
header fallback is.

### M-6 · A permanently failing cache write stalls sync silently

`src/app/main.js` (`persistBeforeCursor`, changed in `0ed94f0`)

The recent fix is right — a durability failure must not hide mail that already
arrived. But the new contract is: when `durable === false`, the history cursor
is *never committed*. On a persistently full profile that means the delta is
replayed on every refresh, for ever, and the only signal is a
once-per-session toast reading *"Local storage is full — offline painting is
limited"*. That sentence describes a cosmetic degradation; it does not say
**sync has stopped advancing**.

### M-7 · Bidi override characters can spoof a link's visible text

`src/app/core/sanitize.js`

```
'<a href="https://good.example">\u202Emoc.live</a>'
  → survives; the anchor text renders right-to-left
```

The `title` attribute added by the sanitiser (showing the real hostname) is a
partial mitigation, but it requires a hover. `U+202E`/`U+202D`/`U+2066`+ should
be stripped or escaped in link text.

### M-8 · `title` attribute content is not entity-decoded before display

`src/app/core/sanitize.js`

```
'<div title="&quot;onmouseover=alert(1)">t</div>'
  → <div title="&quot;onmouseover=alert(1)">t</div>
```

Not exploitable — it stays an attribute *value* and the frame has no scripts —
but the tooltip shows raw entity text to the user, and the pattern is one
escaping change away from mattering.

### M-9 · An empty `To:` header is emitted rather than omitted

`src/background/gmail.js` (`buildMime`)

```
buildMime({to:'',subject:'s',body:'b'}) → "To: "
```

A bare `To:` with no address is malformed. The compose UI should prevent it,
but `buildMime` is also fed by the outbox replaying stored drafts and by
`buildReply`, so the guard belongs at the wire.

### M-10 · Attachment filenames are stripped rather than escaped

`src/background/gmail.js` (`safeFilename`)

```
filename 'a"b.pdf' → filename="ab.pdf"
```

The quote is *deleted*, so the user's file silently arrives under a different
name. RFC 2231 encoding (or backslash-escaping) preserves it. Safe, but lossy
and silent.

### M-11 · `?m=` in a deep link yields an empty-string message id

`src/app/system/deep-links.js`

```
parseHash('#inbox/all?m=') → { m: '' }
```

`''` is falsy so most call sites survive, but it is passed to
`checkPendingSelection` as a *present* selection. A hand-edited or truncated
URL leaves a latch that never resolves.

### M-12 · Negative `releaseAt` is preserved, making a held send immediately due

`src/features/outbox/model.js` (`normaliseOutbox`)

```
{state:'held', releaseAt:-5} → releaseAt:-5, dueItems() → 1 item
```

`Number.isFinite(-5)` is true, so the corrupt-value re-anchor
(`queuedAt + DEFAULT_HOLD_MS`) never fires. The undo-send window the user is
entitled to is skipped. The same guard already exists for `NaN`/missing.

---

## 3 · LOW

- **L-1** `NaN` dates sink to the bottom of the list rather than being
  rejected at ingest (`store.upsert`). Order stays *sorted* — verified, no
  corruption — but the message is effectively hidden at position 2000.
- **L-2** `toEpoch('-5')` returns `-5`: a 1969 timestamp is accepted. Pre-1970
  mail is a deliberate contract (an earlier round withdrew a "fix" for this),
  but there is no floor at all, so `-10^15` is equally accepted.
- **L-3** `displayName('=?UTF-8?B?…?=')` returns the raw encoded word (see
  H-2) — listed separately because the display fix is independent of the index
  fix.
- **L-4** `fullDate(-1)` renders "Wed, Dec 31, 1969, 11:59 PM" while
  `fullDate(0)`, `fullDate(NaN)` and `fullDate(Infinity)` all render `''`. The
  boundary is inconsistent: 0 is treated as "unknown", −1 as a real date.
- **L-5** `parseHash('#inbox')` (no category) yields `category:null` while
  `formatHash` always emits one — the round trip is not symmetric.
- **L-6** Repeated query params (`?q=a&q=b`) silently take the first; no
  signal that the URL was malformed.
- **L-7** `settings.get('unknownKey')` **throws** `Unknown setting`. Every
  other read path in the app degrades; this one takes down the caller. Fine
  for a typo caught in tests, hostile if a stale key survives a downgrade.
- **L-8** `body-cache.js` `let mem = null` (and three siblings) infer type
  `null` under `strictNullChecks` — 26 of the 94 staged errors live in this
  one file, four JSDoc lines from being clean (measured last session).
- **L-9** `mergeNotified(['a','a','b'], ['b','c'])` → 3 entries. Correct, but
  the cap arithmetic counts pre-dedupe, so the effective notification floor is
  slightly smaller than `100`.
- **L-10** The sidebar's `title` tooltips (added in `284ebae`) duplicate the
  accessible name on *every* button at full width, where the label is already
  visible. Screen readers may announce the name twice.
- **L-11** `presets()` omits "This weekend" when today *is* the weekend — a
  deliberate choice, but "Next week" then jumps 5+ days with nothing between.
- **L-12** `audienceOf` is case-insensitive for the address (verified) but the
  `LIST_HEADERS` probe is a substring match, so a header named
  `X-Not-A-List-Id` would register as a list header.
- **L-13** 27 `no-unused-vars` warnings survive in `src/` (lint is `warn`,
  by design, pending the promotion commit).
- **L-14** `buildMime` emits `Content-Transfer-Encoding: 8bit` for the plain
  part; strict 7-bit relays require quoted-printable or base64.
- **L-15** `tools/make-icons.py` loses its executable bit on every workspace
  snapshot, so `ruff`'s `EXE001` re-appears locally between sessions.

---

## 4 · INFO — observations, not defects

- **I-1** `parseBatch` correctly handles pretty-printed JSON bodies containing
  blank lines. My round-4 finding (EXT2-M1) was a false positive and remains
  correctly withdrawn — re-verified here against the *old* implementation.
- **I-2** The store survives 2,050 upserts past its 2,000 cap with **zero**
  ghost entries across `byCategory`, `searchIndex` and `byThread`.
- **I-3** `extractBody` survives a **cyclic** MIME tree, null headers, and
  non-base64 payload data without throwing.
- **I-4** CRLF header injection through `to`, `cc`, `subject` and `references`
  is closed — re-probed directly.
- **I-5** Only 12 `!important` declarations across 7,997 lines of CSS, 6 of
  them in the reduced-motion volume where they are correct.
- **I-6** All 33 settings keys appear in the storage registry; no enum default
  falls outside its own option list.

---

## 5 · Suggested order

1. **H-1** — one-line normalisation, fixes mail landing in the wrong lane.
2. **M-1 / M-2** — both are "the filter silently did nothing"; one shared
   "query understood nothing" state fixes them together.
3. **H-2** — a decoder at the trust boundary; fixes L-3 and the index
   pollution at the same time.
4. **M-6** — change the toast copy; the mechanism is already right.
5. **H-3 / M-9 / M-10 / L-14** — the RFC cluster in `buildMime`, worth one
   focused pass with a fixture per rule.
6. Everything else as encountered.

---

## 6 · What I could not check

- **No CI run**, as instructed. Nothing here depends on one: every finding is
  reproduced by a direct module probe.
- **No browser.** All DOM findings are jsdom-level; the bidi (M-7) and tooltip
  (L-10) findings need real rendering and a screen reader to judge fully.
- **Not read closely:** the timetable subsystem (~3,000 lines), the
  cyberpunk/motion volumes, and the 23 new commits' CSS beyond a specificity
  scan. Findings are absent there, not cleared.

*No file outside this report was modified. Nothing was pushed.*
