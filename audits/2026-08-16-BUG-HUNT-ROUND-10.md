# Bug Hunt — Round 10

> **REMEDIATION NOTE (2026-08-16, added when the findings were actioned).**
>
> Written against `aec887c`. Every finding was re-probed against the real
> module before any code changed. **All three HIGH are fixed**, along with
> nine MEDIUM, four LOW and five of the ten improvements.
>
> **Disproved at HEAD — re-measured, not skipped:**
>
> | Finding | Claim | Measured at HEAD |
> |---|---|---|
> | M-10 | `validateBackup({data: []})` → `{ok:true}` | `{ok:false, reason:'That backup has no data in it.'}` — round 9's `c66b390` did close the array case |
> | M-11 | duplicate headers keep the LAST value | `headerMap` returns `first`; round 8's M-4 fix holds |
> | M-13 | `C++` unsearchable | `store.search('c++')` → the C++ message; `parseQuery('c++').terms` → `['c++']`. Third round this has been reported and third time it does not reproduce |
> | L-13 | compose does not gate on `unfilled()` | `doSend` has warned since bug-hunt 44 #30. It carried a *duplicate* regex, which was the real (smaller) defect and is fixed |
>
> **Found by fixing, not by the report.** The I-5 boundary file immediately
> earned its place: `fmtTime(null)`, `fmtTime([])`, `fmtTime(false)` and
> `fmtTime('')` all rendered a confident `12:00 AM`, because round 9's guard
> ran `Number(min)` first and JavaScript coerces all four to 0. Same "corrupt
> data wearing a legitimate face" failure the guard was written to stop, one
> type further out.
>
> **L-5/L-6 were worse than reported.** Both caps not only failed to apply at
> the write — they evicted in *insertion order*, so over cap the reload kept
> the oldest entries and silently discarded the corrections the user had just
> made. Both constants' own comments claimed the opposite.
>
> **Three of my own test assertions were wrong, not the code**, and are
> recorded as decisions in `test/display-boundaries.test.mjs` rather than
> deleted: `displayName` returns the whole address when there is no display
> name, `joinCapped` keeps `0`/`false` because they stringify to real text,
> and `extractDomain('Name <n@evil.com> …')` is honestly `evil.com` because
> the bracketed address wins.
>
> **Fix log:**
>
> | Finding | Commit | What changed |
> |---|---|---|
> | H-1 | `b361910` | `isAcademicSender` reuses `detectBitsSource`; local domain list deleted; `extractDomain` now requires one `@` and real DNS labels |
> | H-2, I-3, I-9 | `a6e3f63` | one `foldHeader(name, value)` for every header, with a ≤998-octet property test |
> | H-3, I-4 | `62cd64f` | grouped parser returns `null` for an empty branch instead of match-everything; `unparsed` is now reachable from it |
> | M-1, M-2, M-4, M-5, I-1 | `391e8ce` | the exported operators are total, like their loaders |
> | M-3, M-6, M-14 | `391e8ce` | `pruneOverrides(map, undefined)` prunes nothing; `entryId` refuses to invent an id; `scanMessages` is total |
> | M-7, M-8, I-6, L-20 | `5d6d340` | `src/shared/scrub.js` — one definition of every refused character; five stale `eslint-disable` directives removed |
> | I-5, I-7 | `d3ee3a0` | `joinCapped` in `core/display.js`; `test/display-boundaries.test.mjs` |
> | L-5, L-6, L-23 | `971cf51` | caps evict the oldest, at the write; `.gitignore` scratch patterns collapsed |
> | L-13 | `2bee600` | compose asks `templates.unfilled` instead of re-writing its regex |
>
> **Not actioned, deliberately:**
>
> - **L-10** (`markRead` in `DESTRUCTIVE`) — the set gates a *dry-run
>   confirmation*, and a rule that marks a mailbox read is not trivially
>   undoable across arrivals. Removing it weakens the gate more than the
>   extra prompt weakens attention. Left as a decision, not an oversight.
> - **L-1** (`fmtTime(1440)` should be rejected) — a computed end-of-day
>   genuinely reaches 1440; rendering it as midnight is the useful answer.
> - **L-3, L-4, L-7, L-9, L-11, L-12, L-14..L-19, L-21, L-22, L-24** — not
>   actioned this round.
> - **I-2** is H-1 and is done. **I-8** (hostile fixture corpus for
>   `timetable-mail`) and **I-10** are open.


**Commit:** `aec887c` (origin/main, clean tree)
**CI:** green — not re-run, per instruction. **Nothing pushed.**
**Method:** every finding executed against the real module. Reproductions
inline. Suspicions that failed the probe — including three where **my own
probe was wrong** — are recorded in §5 rather than quietly dropped.

**51 findings: 3 HIGH, 14 MEDIUM, 24 LOW, 10 INFO** — plus **10 improvements**
in §4.

Round 9 was remediated hard: **10 commits**, and I re-verified each fix rather
than trusting the messages. `fmtTime` is total, `detectConflicts` is guarded,
the scratch files are gone with a gate behind them, snippets are scrubbed,
backup errors are honest. §5 records all of it.

This round targeted two things: **the code those fixes just changed** (new
code is where new defects live) and the modules named as unexamined twice —
`rule-engine`, `deadline-store`, `followups`, `timetable-mail`, `rules`.

---

## 1 · HIGH

### H-1 · Academic-sender check accepts lookalike domains

`src/app/academic/timetable-mail.js` · **security / spoofing**

```js
return ACADEMIC_DOMAINS.some((d) => addr.includes(`@${d}`) || addr.includes(`.${d}`));
```

`includes` matches **anywhere in the string**, so every one of these is
accepted as institutional mail:

```
isAcademicSender('evil@pilani.bits-pilani.ac.in.attacker.com')      → true
isAcademicSender('x@notpilani.bits-pilani.ac.in')                   → true
isAcademicSender('spoof@evil.com?x=@pilani.bits-pilani.ac.in')      → true
isAcademicSender('Name <n@evil.com> pilani.bits-pilani.ac.in')      → true
```

The first is a **registrable domain an attacker can actually buy**
(`…ac.in.attacker.com`), and it is the classic suffix-spoof shape.

**The codebase already knows the right answer.** `src/classify/sender.js:75`
does the same job correctly, on a *parsed* domain:

```js
if (domain === d || domain.endsWith('.' + d)) {
```

and its comment even explains why: *"Uses an endsWith check on a dot-prefixed
form rather than a bare…"*. `timetable-mail.js` reimplemented the check and
got it wrong.

**Blast radius.** `isAcademicSender` gates `scanMessage` — the path that reads
a message and *mutates the user's timetable*. A crafted sender lets untrusted
mail drive course detection and timetable updates.

**Fix.** Parse the address, then reuse the `sender.js` predicate. Do not keep
two implementations.

### H-2 · `To`, `Cc`, `Bcc` and `References` still emit over-long header lines

`src/background/gmail.js` (`buildMime`) · **protocol**

Round 9's H-3 was fixed **for `Subject` only**. Measured on the current build:

| header | line length | ≤ 998? |
|---|---:|---|
| `Subject` (400 × `é`) | 19 folded lines, max **81** | ✅ |
| `To` (60 recipients) | **3062** | ❌ |
| `Cc` (60 recipients) | **3062** | ❌ |
| `Bcc` (60 recipients) | **3063** | ❌ |
| `References` (80 ids) | **3691** | ❌ |

`References` is the one that matters most: it is not exotic input at all — it
**grows by one message-id per reply**, so any sufficiently long thread reaches
it with no unusual user action. A strict MTA rejects or truncates the line;
truncating `References` silently breaks threading for every downstream client.

**Fix.** The folding helper already exists for `Subject`. Apply it to the
address and id headers, folding at commas / whitespace rather than mid-token.

### H-3 · `a OR` and `((` still match the entire mailbox

`src/app/search/query.js` · **correctness**

Round 9's M-1 is **half-fixed**. The 1-character case now correctly returns
nothing, but a query that parses to no terms *and* no operators still reports
`isEmpty: false`:

```
parseQuery('a OR') → terms:[] ops:0 isEmpty:false → visibleIds 3 of 3
parseQuery('((')   → terms:[] ops:0 isEmpty:false → visibleIds 3 of 3
parseQuery('c')    → terms:['c'] ops:0            → visibleIds 0 of 3   ✅ fixed
parseQuery('zzz')  →                              → visibleIds 0 of 3   ✅
```

The user typed a filter, the app understood none of it, and shows the whole
inbox with no signal. Because `c` now correctly filters, the inconsistency is
*worse* than before: two malformed queries behave in two different ways.

---

## 2 · MEDIUM

### M-1 · `makeRule()` throws instead of returning a default rule
`rule-engine.js` — `Cannot destructure property 'name' of 'undefined'`. Every
sibling constructor in the tree tolerates a missing argument
(`emptyRules()`, `emptyState()`); this one does not.

### M-2 · `evaluate(msg, undefined)` throws `rules is not iterable`
`rule-engine.js` — while `normaliseRuleList(null)` correctly returns `[]`. The
module defends its *loader* and not its *evaluator*, so a caller that skipped
normalisation crashes the ingest path.

### M-3 · `pruneOverrides(map, undefined)` deletes every override
`deadline-store.js:249` — `new Set(undefined)` is an empty set, so **every**
entry is treated as dead and dropped. These are the user's hand-made deadline
corrections, a `backup:true` class of data.

The only production caller passes a real `Set` and is correctly guarded
against a partial store (verified — see A-6), so this is latent. But the
function is exported, and "delete everything" is the wrong failure mode for a
missing argument.

### M-4 · `dueFollowups(null, …)` throws
`followups.js` — `Cannot read properties of null (reading 'filter')`, while
`normaliseFollowups(null)` returns `[]`. Same asymmetry as M-2.

### M-5 · `isMuted(null, key)` and `toggleMute(null, …)` throw
`rules.js` — `Cannot read properties of null (reading 'muted')`, while
`normaliseRules(null)` returns a complete empty-rules object. Third instance
of the same pattern; see improvement I-1.

### M-6 · `entryId({})` still returns `"[object Object]:undefined"`
`timetable.js` — round 9's M-13, unfixed. Any two malformed entries collide on
one id.

### M-7 · Three stale `eslint-disable` directives now ship
`sanitize.js:325`, `snippet.js:131`, `snippet.js:133` — all
`no-misleading-character-class` / `no-control-regex`, neither of which is
enabled in `eslint.config.mjs`. The linter reports them as *unused directives*.
A disable comment that suppresses nothing is a comment claiming a hazard that
does not exist, and it is exactly what `reportUnusedDisableDirectives` was
turned on to catch. Lint warnings rose 2 → 5 in these commits.

### M-8 · `no-useless-escape` in the tokeniser regex
`store.js:235` — `\-` inside a character class. Harmless, but it is in the
single most performance- and correctness-critical regex in the app, and it is
new (added with the Unicode work).

### M-9 · `courseNumbersIn` collapses repeats to one entry
`timetable-mail.js` — `courseNumbersIn('CS F211 '.repeat(2000))` → 1 entry.
Correct as a *set*, but the function name implies a list and callers cannot
tell "mentioned once" from "mentioned 2000 times", which is the signal that
distinguishes a timetable notice from a passing reference.

### M-10 · Backup `data: []` still validates as a successful restore
Round 9's M-8. `validateBackup({…, data: []})` → `{ok: true}`, then
`importBackup` → `{ok: true, applied: []}`. The honest-error work in `c66b390`
improved the *messages* but did not close the array case.

### M-11 · Duplicate headers still keep the last value
Round 9's M-16 / round 8's M-4, re-verified unfixed after the RFC 2047 work
touched the same function. RFC 5322 says first-wins for `Subject`/`From`;
last-wins hands a spoofer the display.

### M-12 · A permanently failing cache write still stalls sync silently
Round 8's M-6, carried forward. The toast says *"offline painting is
limited"*; it does not say sync has stopped advancing.

### M-13 · `C++` remains unsearchable
Round 8's M-3 / round 9's M-15. The tokeniser drops `+`; the surviving `c` is
below the floor. Now that a 1-char query correctly returns nothing (H-3's
sibling fix), searching `C++` returns nothing rather than everything — better,
but still not the message the user is looking at.

### M-14 · `scanMessage(null)` returns `[]` but `scanMessages(null)` is unprobed
`timetable-mail.js` — the singular form is total; the plural was not reachable
in isolation without a store. Flagged as *unverified*, not as a defect.

---

## 3 · LOW

- **L-1** `fmtTime(1440)` now returns `"12:00 AM"` — correct — but 1440 is the
  *exclusive* bound of a day and arguably should be rejected like 1441.
- **L-2** `detectConflicts` dedupes by entry id, so two genuinely distinct
  courses that share an id report as "appears more than once" rather than as
  an overlap. Correct behaviour, surprising message.
- **L-3** `compileCondition({field:'nope',op:'nope'})` returns a function
  rather than null; the caller cannot distinguish "compiled" from "unmatchable".
- **L-4** `validateRule(null)` and `validateRule({})` give the identical
  reason, so a null rule and an empty rule are indistinguishable in the UI.
- **L-5** `MAX_OVERRIDES` (500) is enforced only in `normaliseOverrides`, not
  in `setManual` / `correct`, so the in-memory map can exceed the cap between
  loads.
- **L-6** `MAX_FOLLOWUPS` (200) has the same shape.
- **L-7** `normaliseOverrides({m1:{at:NaN}})` drops the entry silently; the
  user's correction disappears with no signal.
- **L-8** `isAcademicSender('')` → `false` (correct) but
  `isAcademicSender(undefined)` and `(null)` also `false` — no way to
  distinguish "no sender" from "not academic".
- **L-9** `courseNumbersIn` uppercases input, so a course written `cs f211`
  normalises correctly, but the returned spelling is always the document's —
  callers echoing it back to the user change what they typed.
- **L-10** `DESTRUCTIVE` exports `['archive','markRead','skipInbox']`;
  `markRead` is not destructive in any ordinary sense and its inclusion makes
  the dry-run confirmation fire for a harmless action.
- **L-11** `timetable.js` is still 24 exports / 1,100 lines, the widest
  non-shell surface.
- **L-12** `PRECEDENCE`, `TRACKED_FIELDS`, `BEYOND_LEGEND` remain exported but
  internal-only (round 9 L-19, unfixed).
- **L-13** `templates.fill` still leaves `{{unknown}}` in a sent body;
  `unfilled()` exists and compose does not gate on it (round 9 L-20).
- **L-14** `parseAddressList` and `invalidAddresses` still disagree on
  `"Doe, J" <j@x.z>` (round 9 L-21).
- **L-15** `looksLikeAddress('a@b')` → false; single-label domains are legal
  on an intranet (round 9 L-10).
- **L-16** `README` test count changed again this round; it is gate-checked,
  but the churn suggests the count belongs in a generated line, not prose.
- **L-17** `Bcc` folding is 1 octet longer than `To`/`Cc` at the same
  recipient count — the header name length is not accounted for in any budget.
- **L-18** `buildMime` emits `Content-Transfer-Encoding: 8bit` for the plain
  part; strict 7-bit relays need QP or base64 (round 8 L-14).
- **L-19** No test covers `To`/`Cc`/`References` line length, which is why H-2
  survived the `Subject` fix.
- **L-20** `stripBidi` exists in `sanitize.js` *and* an inline copy in
  `snippet.js` — same regex, two places, already drifting in their disable
  comments.
- **L-21** `pruneOverrides` returns `map` unchanged when nothing was dropped
  (good) but `kept` is a fresh object otherwise, so callers comparing by
  identity get inconsistent aliasing.
- **L-22** `scanMessage` is total on `null` but its result shape is `[]` where
  other scanners return `{entries, notices}` — inconsistent contract.
- **L-23** `.gitignore` now has a `/.scratch/` rule (good) but the six older
  one-off patterns were left behind rather than collapsed.
- **L-24** `no-unused-vars` is still `warn` with 9 hits in `src/`; the
  promotion commit is still pending.

---

## 4 · Improvements — not defects

### I-1 · One "tolerate a missing argument" rule, applied consistently
M-1, M-2, M-4 and M-5 are one finding wearing four hats: in each module the
*loader* (`normaliseX`) defends against `null` and the *operator* does not.
Pick the rule — I would make every exported function total — and apply it
across `rule-engine`, `followups`, `rules`, `deadline-store`. It is four
one-line guards and it closes four findings.

### I-2 · Delete the second domain check (H-1)
`classify/sender.js` has the correct implementation with a comment explaining
why. `timetable-mail.js` should import it, not reimplement it. This is the
same "two copies of one rule" class that produced the `stripBidi` duplication
(L-20) and the `addressOf` confusion in round 9.

### I-3 · Fold every header, not the one that was reported
H-2 exists because the fix targeted the *symptom I reported* (`Subject`)
rather than the *class* (header line length). A single
`foldHeader(name, value)` used by every header in `buildMime`, plus one test
asserting **no emitted line exceeds 998 octets** for a hostile draft, makes
the whole class impossible rather than fixing it one header at a time.

### I-4 · Make "the query means nothing" a first-class state (H-3)
`isEmpty` currently conflates "no query" with "query I could not parse".
A third state — `unparseable` — lets the list say *"That search wasn't
understood"* instead of silently showing everything.

### I-5 · Add a `no-unused-disable` sweep to the lint promotion
M-7's three stale directives were introduced by the round-9 fixes and reported
immediately. Clearing them with the nine `no-unused-vars` hits makes the whole
gate zero-output.

### I-6 · One `stripBidi` / `stripControl` module
L-20 and round 9's I-2: the scrubbing now exists in `sanitize.js`,
`snippet.js` and `notify.js`. Three copies of a security-relevant regex is one
too many; the disable comments have already drifted apart.

### I-7 · Cap enumerations generically
Round 9's I-6 landed for the conflict message (7,525 → 91 chars — verified).
The same `join(' and ')` shape remains in the unresolved and pending-link
branches. A shared `joinCapped` finishes the job.

### I-8 · A fixture corpus for `timetable-mail`
This round's H-1 is the second spoofing-adjacent finding in a module with no
adversarial fixtures. A dozen hostile senders and notices as a committed
fixture would have caught it.

### I-9 · Assert header limits, not header content
The `buildMime` tests check *what* headers say. None checks the invariant that
matters to a receiving MTA: every line ≤ 998 octets, CRLF-terminated,
continuations start with whitespace. One property test over a generated
hostile draft covers H-2 and L-17 and L-18 permanently.

### I-10 · Consider retiring `markRead` from `DESTRUCTIVE`
L-10: gating a harmless action behind a destructive-action confirmation
teaches users to click through the confirmation, which weakens it for
`archive` and `skipInbox`.

---

## 5 · Verified fixed, and my own errors

**Round 9 remediation — re-probed, all confirmed:**

- **A-1** `detectConflicts` on an entry with no `unresolved` → `0`, no throw
  (was H-1, a crash).
- **A-2** Duplicated meeting no longer self-conflicts → `[]` (was H-2).
- **A-3** Duplicate ids now report a distinct *"appears more than once"*
  conflict rather than a bogus overlap (was H-3).
- **A-4** `detectConflicts(null)` → `0` (was M-5).
- **A-5** 500-way clash message: **7,525 → 91** characters (was M-6).
- **A-6** `fmtTime`: `NaN → ''`, `-1 → ''`, `1e9 → ''`, `1440 → '12:00 AM'`
  (was M-1..M-4, four findings, one guard — the I-4 proposal landed).
- **A-7** Scratch files untracked and a CI gate added (was H-4).
- **A-8** `cleanSnippet` now strips control chars **and** bidi overrides (was
  M-10, M-11).
- **A-9** Subject header folding round-trips **exactly** through
  `decodeEncodedWords` for emoji, CJK, Devanagari, combining marks and mixed
  scripts — 400 chars → 19 lines, max 81 octets. This is a genuinely careful
  fix.
- **A-10** `pruneAfterFullSync` is correctly gated on
  `!pageToken && !nextPageToken && !store.isFull`, so it cannot prune against
  a partial store.

**Where my probe was wrong, not the code:**

- I first reported `pruneOverrides` returning 0 keys over cap. **My call was
  wrong** — the second argument is `liveIds`, not `now`. The real function is
  correct; M-3 is the narrower `undefined` case only.
- I probed `detectConflicts` with an invented entry shape (`days`/`startMin`)
  and read the resulting throw as a defect. The real field is `meetings`; the
  genuine crash (H-1 last round) was found only after reading the source.
- I flagged SHIFT_JIS decoding as mojibake in round 9 and retracted it there;
  re-confirmed correct here.

---

## 6 · Suggested order

1. **H-1** — import the correct domain check; delete the duplicate.
2. **I-3 / H-2** — one `foldHeader`, applied to every header, with the
   ≤998 property test.
3. **H-3 / I-4** — the `unparseable` query state.
4. **I-1 / M-1, M-2, M-4, M-5** — four one-line guards.
5. **M-7 / I-5** — clear the stale directives with the lint promotion.

---

## 7 · What I could not check

- **No CI run**, as instructed; nothing here depends on one.
- **No browser.** All DOM findings are jsdom-level.
- **Not read closely:** `timetable-ui.js` (1,434 lines), the motion/cyberpunk
  volumes, `compose.js` beyond its exports. Absent, not cleared.
- **M-14** is explicitly marked unverified rather than counted as confirmed.
- Round 8's M-6 and the round-9 LOW backlog are carried forward as unfixed
  rather than re-counted as new discoveries.

*No file outside this report was modified. Nothing was pushed.*
