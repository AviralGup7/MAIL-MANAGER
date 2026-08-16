# Bug Hunt — Round 9

> **REMEDIATION NOTE (2026-08-16, added when the findings were actioned).**
>
> This report was written against `97af5e0`. Three findings were already
> fixed at the time it was filed and are **not** defects at HEAD — re-probed
> before any work started:
>
> | Finding | Claim | Measured at HEAD |
> |---|---|---|
> | M-14 | `search('c')` returns the whole mailbox | returns **0** (round 8, M-2) |
> | M-15 | `C++` unsearchable | `search('c++')` → **1** (round 8, M-3) |
> | M-16 | duplicate headers keep the last value | keeps **'first'** (round 8, M-4) |
>
> L-22 likewise: round 8's M-6 toast copy was corrected in `be6fd0c`.
>
> **Fixed in this pass:** H-1, H-2, H-3, H-4, M-1, M-2, M-3, M-4, M-5, M-6,
> M-8, M-9, M-10, M-11, M-12, and I-3 (adopted in preference to H-4's
> narrower fix, because the narrow fix failed twice — see below).
>
> **Investigated and deliberately not changed:** M-7 (`addressOf` on an
> address *list*). Every caller in the tree passes `msg.from`, a single
> sender, so this is a latent shape issue rather than a live defect;
> loosening a lenient grouping key that rules, corrections and the reader all
> depend on, to fix a call nobody makes, is the wrong trade.
>
> **H-4 undercounted.** Eleven `.v-*` probes shipped, not seven — and six
> more (`.v9-*`) shipped during this very remediation, because the ignore
> rule was a list of prefixes and `/.v-*.mjs` does not match `.v9-`. That is
> why I-3's single `/.scratch/` directory was adopted and backed by a
> `package.test` gate asserting the outcome (no tracked dotfile scripts)
> rather than any pattern.


**Commit:** `97af5e0` (origin/main, clean tree)
**CI:** green — not re-run, per instruction. **Nothing pushed.**
**Method:** every finding executed against the real module. Reproductions
inline. Suspicions that did not survive the probe are recorded in §5 as
acquitted rather than quietly dropped.

**52 findings: 4 HIGH, 16 MEDIUM, 22 LOW, 10 INFO** — plus **12 improvement
proposals** in §4 that are not defects at all.

Round 8's H-1 (plus-addressing) and H-2 (RFC 2047) are **fixed** in
`2c3fed8` / `97af5e0`; both re-verified here and closed. This round went where
round 8 explicitly said it had not looked: the **timetable subsystem**
(~3,000 lines), templates, backup/import, contacts, snippet, undo, and the
freshly-landed decoder.

---

## 1 · HIGH

### H-1 · `detectConflicts` crashes on any entry missing `unresolved`

`src/app/academic/timetable.js:909` · **crash / data-shape**

```js
for (const e of entries) {
  if (!e.unresolved.length) continue;   // ← unguarded
```

Two lines above, the same loop body defends the sibling field:
`for (const m of e.meetings || [])`. Every *producer* of an entry also
defends — `addCourse` writes `[...(section.unresolved || [])]`, and
`applyFieldChange` reads `entry.provenance?.[field]?.source || 'unresolved'`.
The **consumer** is the only place that assumes it exists.

```
detectConflicts([{ id:'a', courseNo:'X', section:'L1',
                   meetings:[{day:'M',hour:1}] }])
  → TypeError: Cannot read properties of undefined (reading 'length')
     at detectConflicts (timetable.js:910)
```

**Reachable.** `timetable` is a `backup:true` registry key, so a restored
backup written by any older build — or a hand-edited export, which the UI
invites by offering export — produces exactly this entry shape. The throw
takes down the whole conflict pass, and with it the timetable panel.

**Fix.** `for (const f of e.unresolved || [])`, matching the line above it.

### H-2 · A single entry conflicts with *itself* when a meeting is duplicated

`src/app/academic/timetable.js` (`detectConflicts`) · **correctness**

The slot map keys on `day:hour` and pushes the entry once per meeting, with no
dedupe:

```
detectConflicts([{ id:'a', …, meetings:[{day:'M',hour:1},{day:'M',hour:1}] }])
  → [{ kind:'overlap', entryIds:['a','a'],
       message:'CS F211 L1 and CS F211 L1 are both on Monday at hour 1.' }]
```

A duplicated meeting row is exactly what a re-import or a double-applied
timetable mail produces. The user is told a course clashes with itself and has
no way to resolve it — the conflict cannot be dismissed because both sides are
the same entry.

**Fix.** Dedupe by entry id per slot before reporting.

### H-3 · Duplicate entry ids produce a conflict that can never be cleared

`src/app/academic/timetable.js` · **correctness**

```
detectConflicts([E({id:'a'}), E({id:'a'})])
  → entryIds: [['a','a'], ['a']]
```

Same root cause as H-2 but through a different door: nothing enforces id
uniqueness in the entry list. `entryId({})` returns the string
`"[object Object]:undefined"`, so a malformed entry silently collides with
every other malformed entry.

### H-4 · Seven scratch files were committed to the repo root

`.v-dec.mjs`, `.v-h3.mjs`, `.v-high.mjs`, `.v-hm.mjs`, `.v-med.mjs`,
`.v-rest.mjs`, `.v-rest2.mjs` · **release hygiene**

Verification scripts from the round-8 fix session, committed in `fbbf7fc`.
`.gitignore` already carries `/.probe-*.mjs`, `/.shot*.mjs` and
`/.shot-cp.mjs` for precisely this class — the pattern list simply did not
anticipate a new prefix.

They ship inside the extension package. Not exploitable (they are inert
`.mjs` never referenced by the manifest), but they are unreviewed code in a
shipped artifact, and the Web Store reviews what you upload.

**Fix.** Delete them; broaden the ignore to `/.v-*.mjs` — or better, adopt a
single `/.scratch/` directory (see improvement I-3).

---

## 2 · MEDIUM

### M-1 · `fmtTime` emits `NaN:NaN AM` rather than failing or blanking
`timetable.js` — `fmtTime(NaN) → "NaN:NaN AM"`. Every other display helper in
the tree renders `''` for a non-finite input (`fullDate(NaN) → ''`). This one
puts the literal string `NaN:NaN AM` on screen.

### M-2 · `fmtTime(-1)` renders `-1:-1 AM`
Same function, no floor. A negative minute-of-day is nonsense; it should blank
or clamp.

### M-3 · `fmtTime(1440)` renders `12:00 PM` — midnight shown as noon
1440 is the exclusive upper bound of a day. It wraps into the PM branch, so an
end-of-day boundary displays as *midday*. Off-by-one on the one value most
likely to appear at a slot boundary.

### M-4 · `fmtTime(1e9)` silently renders a plausible time
`→ "10:40 PM"`. No range check at all, so corrupt data looks legitimate.

### M-5 · `detectConflicts(null)` throws instead of returning `[]`
`TypeError: entries is not iterable`. Callers that pass a freshly-loaded,
possibly-empty timetable have to defend themselves.

### M-6 · A 500-way slot clash builds a 7,525-character message string
`msgLen=7525` — every colliding course is joined into one sentence with
`' and '`. It is rendered into the conflict panel, so a corrupt import
produces an unreadable wall of text. Cap the enumeration ("…and 497 others").

### M-7 · `addressOf('a@b.c, d@e.f')` returns the whole list
`src/app/core/contacts.js` — a function named for a single address returns
`"a@b.c, d@e.f"` when given a list. Callers using it as a map key (the
correction store keys on sender address) get one key per *combination* of
recipients rather than per sender.

### M-8 · Backup validation accepts an array as `data`
`src/app/system/backup.js` —
`validateBackup({format:…,version:1,data:[]}) → {ok:true}`, and
`importBackup` then reports `{ok:true, applied:[]}`. The user is told the
restore succeeded when nothing was restored. `typeof [] === 'object'` is the
hole.

### M-9 · A corrupt version number is reported as "a newer version (vNaN)"
`validateBackup({version:NaN})` →
*"That backup was made by a newer version (vNaN). Update the extension
first."* The advice is wrong — updating will not help — and the message leaks
the internal value.

### M-10 · `cleanSnippet` passes control characters through to the row
`cleanSnippet('a\u0000b\u0007c')` → `"a\u0000b\u0007c"`. `notify.js`'s
`cardText` scrubs these before an OS notification (a documented past fix); the
in-app list row never got the same treatment.

### M-11 · `cleanSnippet` passes bidi overrides through
`cleanSnippet('a\u202Eb')` → unchanged. In a list row, `U+202E` reverses the
rest of the line, so a sender controls how *neighbouring* text renders. Same
class as round 8's M-7, one layer up.

### M-12 · `drainQueuedIntents()` is fire-and-forget on every `online` event
`main.js:1198` — `window.addEventListener('online', () => { void drainQueuedIntents(); })`.
A rejection lands in the global `unhandledrejection` handler, which logs to
console and the activity log. The user's queued archives silently fail to
drain and nothing on screen says so.

### M-13 · `entryId({})` returns `"[object Object]:undefined"`
Template-literal coercion of an object. Any two malformed entries share an id.

### M-14 · The 1-char search floor still returns the whole mailbox
Round 8's M-2, re-verified unfixed: `store.search('c')` → all messages. Listed
again because the fix for round 8's M-1 (malformed query) should cover both.

### M-15 · `C++` remains unsearchable
Round 8's M-3, re-verified unfixed. `tokenize` drops `+`, leaving a 1-char
token below the floor.

### M-16 · Duplicate headers still keep the last value
Round 8's M-4, re-verified against the *new* `headerMap`: the RFC 2047 work
changed the value path but not the collision rule —
`headerMap([{Subject:'first'},{Subject:'second'}]) → 'second'`.

---

## 3 · LOW

- **L-1** `detectConflicts` is O(n²) in the worst case over `byCourse`
  grouping; fine at real sizes (500 entries in 1 ms) but unbounded by design.
- **L-2** `entryId` has no separator escaping, so `a:b` + `c` collides with
  `a` + `b:c`.
- **L-3** `emptyState()` returns a fresh object each call but `entries: []` is
  shared by reference in some paths — verify before relying on isolation.
- **L-4** `explainEntry` / `instructorsFor` have no null guards on
  `entry.provenance`.
- **L-5** The decoder's adjacent-word merge regex requires whitespace between
  words; RFC 2047 §6.2 also permits CRLF+space (folded headers).
- **L-6** `decodeEncodedWords` leaves an unterminated `=?UTF-8?B?` verbatim —
  correct fail-open, but it then reaches the search index as tokens
  (`utf-8`, `b`).
- **L-7** A 40 KB encoded word decodes fully with no length cap; the result is
  stored and indexed.
- **L-8** `validateBackup` accepts `version: 0` and `version: -1`.
- **L-9** `importBackup` reports `ok:true` with `applied:[]` for a backup
  containing only unknown keys — indistinguishable from a real restore.
- **L-10** `looksLikeAddress('a@b')` is `false`; single-label domains are
  legal in intranets (`user@localhost`).
- **L-11** `invalidAddresses('a@b.c,,d@e.f')` returns `[]` — empty segments
  are skipped silently rather than flagged.
- **L-12** `rowSnippet` returns `''` when the snippet equals the subject
  (correct) but does not trim before comparing, so `'Hello '` vs `'Hello'`
  shows a redundant snippet.
- **L-13** `UndoStack` with `max: 0` accepts a push then immediately discards
  it; `push` returns nothing, so the caller cannot tell.
- **L-14** `UndoStack` with a negative `ttlMs` silently drops every entry.
- **L-15** `README` says 2,078 declared tests; the figure is gate-checked, but
  the count changed three times in four commits — noise in the doc gate.
- **L-16** `.gitignore` lists `/.shot.mjs` *and* `/.shot2.mjs` *and*
  `/.shot*.png` *and* `/.shot-cp.mjs` — four patterns where one glob would do,
  which is why `.v-*` slipped through.
- **L-17** `fmtTime` has no unit test covering any boundary (0, 1439, 1440).
- **L-18** `timetable.js` at 1,102 lines has 24 exports — the widest public
  surface of any non-shell module.
- **L-19** `PRECEDENCE`, `TRACKED_FIELDS`, `BEYOND_LEGEND` are exported but
  used only internally (dead public API).
- **L-20** `templates.fill` leaves `{{unknown}}` verbatim in the sent body;
  `unfilled()` exists to detect this but compose does not appear to gate on it.
- **L-21** `parseAddressList` handles quoted commas correctly but
  `invalidAddresses` splits on bare `,` — the two disagree on
  `"Doe, J" <j@x.z>`.
- **L-22** Round 8's M-6 (a permanently failing cache write stalls sync with a
  misleading toast) is unfixed.

---

## 4 · Genuine improvements — not defects

These are things that are *correct today* and would still be better changed.

### I-1 · Give the timetable entry shape one constructor
H-1, H-2, H-3, M-13 and L-2 are all the same root cause: entries are plain
object literals built in several places, and every consumer re-derives its own
assumptions. A single `makeEntry()` that guarantees `meetings: []`,
`unresolved: []`, `provenance: {}` and a collision-free id would close five
findings at once and make the sixth (id escaping) a one-line change.

### I-2 · One scrub function for every user-facing string
`notify.cardText` scrubs control characters and caps length. `cleanSnippet`
does neither (M-10, M-11). `displayName` does neither. The rule "text from a
message is scrubbed before it reaches a surface" exists in one module and
should be a shared helper in `app/core/display.js`, applied at the row, the
tooltip, the notification and the reader header.

### I-3 · One scratch directory instead of six ignore patterns
`.gitignore` carries `/.shot.mjs`, `/.shot2.mjs`, `/.shot-cp.mjs`,
`/.probe*.mjs`, `/.probe-*.mjs`, `.shot*.png`. A single `/.scratch/` entry
with a one-line convention ("throwaway verification lives here") would have
prevented H-4 and is easier to honour than remembering a prefix.

### I-4 · Make `fmtTime` total
M-1..M-4 are four faces of one missing guard. `if (!Number.isFinite(min) || min < 0 || min >= 1440) return '';`
matches what `fullDate` already does and closes all four.

### I-5 · A boundary-value test file for the display helpers
`fmtTime`, `fullDate`, `relativeLabel`, `cleanSnippet` and `displayName` all
take untrusted numbers or strings and all render directly to screen. None has a
0 / negative / NaN / Infinity / max case. One table-driven test file would fix
that permanently and is the cheapest durable win here.

### I-6 · Cap enumerations in generated messages
M-6's 7,525-character sentence is one instance; the same pattern (`list.map(…).join(' and ')`)
appears in the conflict, unresolved and pending-link branches. A shared
`joinCapped(items, 3)` helper that appends "and N others" would make every
generated message bounded by construction.

### I-7 · `addressOf` should be `addressOf` (M-7)
Either make it return the first address, or rename it `addressesOf` and fix
the call sites that use it as a single key. The current name is a trap.

### I-8 · Distinguish "restored nothing" from "restored successfully"
M-8 and L-9: `importBackup` returning `{ok:true, applied:[]}` should be a
distinct outcome the UI reports as "that backup contained nothing this version
understands."

### I-9 · Promote `no-unused-vars` to error
The 16 remaining hits in `src/` were sized last session. Doing them clears the
last warning class and lets the lint gate be read as "zero output = clean".

### I-10 · Add a `timetable` fixture corpus
The subsystem is 3,000 lines with the widest export surface in the tree and no
adversarial fixtures. The five findings above were all reachable from
plausible stored state. A dozen malformed entries as a committed fixture would
have caught every one.

### I-11 · Consider a shared `assertShape` at storage boundaries
`intents`, `outbox` and `snooze` each hand-roll a `normalise*` that filters
malformed rows; `timetable` does not, which is why H-1 exists. The pattern is
proven in three modules and worth extracting.

### I-12 · Document the entry contract in `docs/TIMETABLE.md`
The doc describes the parsing pipeline but not the runtime entry shape, which
is what consumers actually need. Two paragraphs would have made H-1 obvious to
whoever wrote line 909.

---

## 5 · Acquitted — probed and found correct

Recorded so a later round does not re-litigate.

- **A-1** The new RFC 2047 decoder handles valid B and Q words, adjacent
  words, `*lang` suffixes, bad base64 (fails open), nested words (not
  re-expanded — correct), and a 40 KB payload without throwing.
- **A-2** `SHIFT_JIS` decoding is *correct*, not mojibake: the sender labelled
  it, `TextDecoder` honours it. My first reading of this was wrong.
- **A-3** `templates.fill` does **not** recursively expand — `fill('{{a}}',{a:'{{a}}'})`
  terminates. 10,000 placeholders fill in 8 ms.
- **A-4** Backup import ignores unknown keys rather than writing them; no
  prototype pollution from a `__proto__` key in `data`.
- **A-5** `parseAddressList` correctly handles quoted commas in display names.
- **A-6** `mailboxOf('me+tag@b.c')` → `me@b.c`; the plus-address fix is real.
- **A-7** `UndoStack` bounds and TTL both work as documented.
- **A-8** `readerCsp`, `READER_SANDBOX` and `READER_SANDBOX_FORBIDDEN` are
  unchanged and correct; no `allow-scripts`, no `allow-same-origin`.
- **A-9** `invalidAddresses` correctly rejects a bare word and accepts a
  trailing comma.
- **A-10** `snippet.addsInformation` correctly suppresses a snippet that
  merely repeats or prefixes the subject.

---

## 6 · Suggested order

1. **H-1** — one `|| []`, prevents a crash from restored data.
2. **I-4 / M-1..M-4** — one guard in `fmtTime`, four findings.
3. **H-2 / H-3** — dedupe by entry id in the slot map.
4. **H-4 / I-3** — delete the scratch files, one ignore rule.
5. **I-2 / M-10 / M-11** — the shared scrub helper.
6. **I-1** — the entry constructor, which retires the rest of the timetable
   cluster.

---

## 7 · What I could not check

- **No CI run**, as instructed; nothing here depends on one.
- **No browser.** Bidi (M-11) and any rendering claim need real layout.
- **Not read closely:** the motion/cyberpunk volumes and `timetable-ui.js`
  (1,434 lines) beyond its exports. Absent, not cleared.
- Round 8's M-6, M-14, M-15, M-16 are carried forward as unfixed rather than
  re-counted as new.

*No file outside this report was modified. Nothing was pushed.*
