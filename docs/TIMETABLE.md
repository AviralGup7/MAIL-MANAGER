# The timetable builder

A deterministic academic schedule, built once from official BITS data and
updated afterwards only by rules that can be written down.

**There is no inference here, and that is the point.** No model, no heuristic
that "usually works", no filling a gap with a plausible value. If the source
does not say it, the field stays unresolved and the user is asked. Several
tests exist specifically to fail if someone later improves the builder by
adding a clever guess.

---

## What it is built from

| Source | File | What it gave us |
|---|---|---|
| Official timetable | `Timetable_05_Aug_2026…txt` | 688 courses, every section |
| Change notice | `TIMETABLE_CHANGES_NOTICE_4thAug26_1.txt` | 119 change rows, effective 05-Aug-2026 |

Both are committed under `src/timetable/sources/` and parsed **offline** by
`tools/parse-timetable.mjs` into `src/timetable/data.json`. The app ships the
parsed JSON and never parses a PDF at runtime.

Semester: **FIRST SEMESTER 2026-2027**.

### The parse is checked against the real document, not a fixture

`CS F111` in the source reads:

```
COMPUTER PROGRAMMING  1008  CS F111  3 1 - - 4  L1  VINTI AGARWAL  5105  M W 3 Th 9  02/12 AN
                                                 L2  Yash Sinha    5105  M W 2 T 8   02/12 AN
                                      Practical  P1  Manasvi Singh(RS)  6117  M 6 7
```

and parses to 30 sections, of which:

- `L1` → meetings **M3, W3, Th9** — *not* Th3. `M W 3 Th 9` is two groups:
  Mon+Wed at hour 3, then Thu at hour 9. Reading it as one group of three days
  is the obvious wrong answer and there is a test for it.
- `Th` is Thursday, never a Tuesday followed by a stray `h`.
- `P1` → **M6, M7** — a multi-hour lab block becomes several meetings.

An unreadable cell yields **nothing**, never a guess.

### How much is unresolved, and why

Counted across all **1681 sections**, not estimated:

| Measure | Count |
|---|---|
| Sections with any `unresolved` field | 242 (14.4%) |
| — missing room | 239 |
| — missing time | 161 |
| Sections with no instructor | 0 |

Both gaps were traced back to the source, and **the parser is faithful in both
cases**:

- The 161 with no time are `LABORATORY PROJECT`, `INDEPENDENT STUDY` and
  thesis-type courses. The document gives them credits and an instructor and
  no schedule, because they have none.
- Most room gaps are labs printed without one, e.g. `BITS U104` reads
  `P1  V Manjuladevi  F 8 9` — a time and no room.

That 14.4% is **the document being incomplete, not data being lost**. It is the
no-guessing rule working: the field stays empty and you are asked.

---

## The model

Every entry is a course section you are enrolled in, and carries:

```
courseNo · comCode · title · section · kind (lecture|tutorial|practical)
instructors · inCharge · credits · room · meetings · daysHours
midsem · compre · semester
provenance · history · locked · unresolved
```

Three of those come straight from the legend rather than from a guess:

- **`credits`** — the five columns named: `{lecture, practical, tutorial,
  selfStudy, units}`. A dash is the document *stating an absence* and becomes
  `0`; anything unreadable becomes `null`. Collapsing both to `0` would invent
  a fact, so they are kept apart.
- **`inCharge`** — legend 6: *"Name in BLOCK LETTERS indicates
  INSTRUCTOR-IN-CHARGE"*. This is who you email about a clash or a makeup.
  673 of 1681 sections are marked; a section whose names are all mixed case
  claims nobody.
- **`midsem` / `compre`** — see *Exams*.

`provenance` is per field. Each of `instructors`, `room`, `meetings` and
`daysHours` records **where that value came from**, its reference, and when.
That is what makes every value explainable rather than merely present.

`history` is append-only. Nothing is overwritten silently — the losing value is
recorded, not discarded.

---

## Exams

605 sections carry exam dates, and they are modelled as typed events
(`examEvents`), not stored strings. Session times are transcribed from the
legend:

| Sessions | Times | Meaning |
|---|---|---|
| `FN1` `FN2` `AN1` `AN2` | 09:00–10:30 · 11:00–12:30 · 14:00–15:30 · 16:00–17:30 | mid-semester, 90 min |
| `FN` `AN` | 09:00–12:00 · 14:00–17:00 | comprehensive, 3 hours |

**That table also fixed a real bug.** Most rows print two dates, midsem then
compre, and the parser took the first as the midsem unconditionally. Eleven
sections list only *one* date and it is the compre — so **CS F111, a
first-year core, displayed its final exam as a mid-semester test**. A numbered
session is a midsem and a bare one is a compre wherever it appears in the row,
so the session code decides and position is only a fallback.

A session the legend does not describe keeps its date and shows *"time not
stated"*. Two different courses examined in the same date and session raise a
**blocking `exam-clash`** — the kind of thing you must report to AUGSD, and
previously invisible until the day. A course's own sections never clash with
each other.

---

## Precedence

One rule decides every conflict, and it is the same rule everywhere:

```
5  manual    your edit
4  notice    official change notice
3  document  official timetable
2  mail      academic email
1  unresolved
```

- A **higher** source overwrites a lower one.
- A **lower** source never overwrites a higher one. It is reported, not applied.
- **Equal** sources that disagree, from different references, become a
  **conflict** the user resolves. Two official notices contradicting each other
  is a real event and the system refuses to pick.
- Re-applying the same source with the same value is idempotent.

### Why an email cannot change your room

Mail sits *below* the official timetable. So a room-change email does **not**
edit the timetable — it raises a proposal quoting the sentence it found. If you
accept, the change is recorded as **your** edit, because it is: you decided.
The precedence rule is never bent to make a feature feel smoother.

The email is still recorded as what prompted the edit. Accepting keeps a link
back to the message (see *Traceability*).

---

## Change notices

The notice is the **second-highest authority** — above the official timetable,
below only you. The 119 rows parse into five kinds:

| Kind | Rows | Applied automatically? |
|---|---|---|
| instructor | 63 | **No** — reported only |
| new-section | 27 | No — informational |
| room | 17 | Yes, when both columns are readable |
| time | 9 | Yes |
| compre | 3 | No — reported only |

The document prints From and To as two columns
(`151  L1  6156  6160 BIO G542`), so reading the second is not inference, it
is the column the source labelled *To*. When a row wraps and only one value
survives it is genuinely ambiguous — old or new? — so it stays report-only.

Instructor changes are **never** applied automatically. Names wrap across
lines in this document, and a half-read name written into a timetable is worse
than a prompt.

Two parsing traps worth knowing, both found while wiring this up:

- `M W 2 T 9` is two groups. An earlier pattern stopped at the first hour and
  silently dropped the Tuesday class.
- `TThF 4 01/12` — the `01` of the exam date looks exactly like an hour, and
  parsed as three phantom classes at slot 1. Dates are stripped first.

---

## Mail rules

A message is only considered if the sender is academic **and** it names a
course you actually hold. Everything else is ignored entirely — no scanning
your personal mail for stray dates.

Recognised patterns: `cancellation`, `extra-class`, `room`, `instructor`,
`timetable-correction`, `exam`, `holiday`, `deadline`.

Two deliberate restraints:

- **A matched pattern with no stated value degrades to a notification.** "The
  venue has changed" with no room named tells you something happened; it does
  not invent a room.
- **Instructor changes are reported and never applied.** The patterns that
  detect them are not precise enough to be trusted with a write.

A message naming no section applies to every section of that course you hold.
Course numbers are recognised however they are written (`CS F111`, `CSF111`,
`cs f111`). An already-applied message is not scanned again.

---

## Building it

One-time, in this order:

1. **Course** — search by number, computer code or title.
2. **Teacher** — asked *before* the section, because it is the choice students
   have an opinion about, and it shortens a thirty-section list to a scannable
   one.
3. **Lecture section**.
4. **Linked sections** — a single tutorial or lab attaches **automatically**.
   Several are **asked for**, never chosen for you.

After that the timetable is never rebuilt. Updates touch only the affected
entry.

---

## Switching, finishing, resetting

- **Switch section** — the new section is a genuinely different class, so a
  fresh entry is built from the source rather than fields being mutated;
  otherwise provenance would claim the document said things about L2 that it
  said about L1. The lock flag and the fact of the switch carry over. Offered
  only where the source has another section of that kind.
- **Mark complete** — a milestone, **not** a freeze. Official notices still
  land afterwards, because AUGSD does not care that you pressed a button, and
  freezing would turn a finalised timetable into a stale one. Refuses while
  blocking conflicts remain.
- **Reset** — the only sanctioned route back to a rebuild, so it confirms
  first. Deliberately *not* `emptyState()`: `appliedMail` clears too, or the
  rebuilt timetable is permanently deaf to every message it already handled.

---

## Protecting your changes

- **Lock** an entry and automatic updates stop touching it. They are still
  *reported*, so a locked entry never silently drifts out of date.
- A **manual edit** works on a locked entry — the lock is against automation,
  not against you.
- **Restore** returns a field to the official source value, not to whatever it
  was a moment ago. History can hold several manual edits and "undo the last
  one" is a different feature.

---

## Conflicts

Detected and surfaced, never silently resolved: `overlap` (two classes in one
slot), `exam-clash` (two courses examined in one session), `duplicate`,
`missing-link`, `orphan-link` (a lab whose lecture was removed), `unresolved`
(a section the document could not describe).

Two more are computed against the current catalogue at render time rather than
stored — `stale-course` and `stale-section` — because they depend on
(state, catalogue) while the rest depend on entries alone. Storing them would
make the conflict list vary with whether an async fetch had landed.

Recomputed from scratch on every mutation. The list is at most a few dozen
entries, and a conflict set that drifts out of sync with reality is worse than
a cheap recompute.

---

## Traceability, in both directions

- **Entry → source.** `explainEntry(entry)` returns, per field, the value, the
  source, its reference and when it arrived. Every value can account for
  itself.
- **Source → entries.** `entriesForMessage(state, ref)` answers the question
  users actually ask: *this room change is open in front of me — has it already
  been applied, or am I about to walk to the wrong room?* The reader shows a
  quiet banner naming the class and the before/after value, and it is hidden
  unless the message really changed something.

Grouped by entry, not by field: one email that moves a class *and* changes its
room is one link, not two.

---

## Hardening (Pass 3)

Five defects, every one found by probing the running code rather than by
reading it.

| Failure | What happened | What it does now |
|---|---|---|
| **Corrupt record** | One `null` in `entries` threw on first render — the panel would not open at all | Unusable records are dropped, **counted**, and reported |
| **Orphaned lab** | Removing a lecture left its practical pointing at a section that no longer existed, silently | `orphan-link` conflict; the lab is **not** auto-deleted |
| **Stale catalogue** | A regenerated document could drop a section you hold, and nothing noticed | `stale-section` / `stale-course`, surfaced not applied |
| **Failed write** | A toast, then the panel kept showing an edit that would vanish on reload | Persistent banner naming the error, with a retry |
| **Duplicate mail** | The same message twice in one scan raised two identical proposals | Deduped by id within the scan as well as across sessions |

Three principles run through all of them:

- **Nothing is repaired with defaults.** A record patched up to look valid is a
  fabricated one — it would assert a class exists with no time and no source.
  Drop it and say so.
- **Nothing is auto-deleted.** An orphaned lab and a withdrawn section are both
  real classes on a real schedule. Removing one silently is worse than showing
  a broken link.
- **Nothing is rolled back on a write failure.** Discarding what someone just
  typed because storage was briefly full is its own data loss.

And one deliberate silence: **an absent or empty catalogue means no opinion.**
`loadSourceData` degrades to `{courses: []}` on a failed fetch, and reading
that as evidence would flag every class as withdrawn — a transient error
rendered as a screenful of alarming nonsense.

The whole checklist runs as one simulation (`SEMESTER:` in the tests): build,
a re-issued notice, a manual override, a mail that must lose, a lock, a save,
a reload — then every invariant asserted at once. It exists because integrity
is a property of a *sequence*, and no unit test would catch drift that only
appears after twenty operations.

---

## Persistence

Stored under the `timetable` key in `chrome.storage.local`, so it survives app
restart, browser restart, mail refresh and sync. Cleared on sign-out — it
belongs to the account.

Every persistence path degrades rather than throws: a corrupt blob loads as an
empty timetable, a write failure is reported rather than thrown, a read failure
degrades. A packaging error costs the timetable feature and nothing else — the
inbox still works.

---

## Defects this feature found in itself

Recorded because both were invisible until a test was deliberately sabotaged.

**`manualEdit` discarded which email prompted an edit.** It hardcoded
`ref: 'user'`. Accepting a proposal from mail therefore recorded the precedence
correctly — manual, because the user decided — but threw away the message id,
so the trail ended exactly where it was most useful. `ref` is now a parameter.
The precedence rule is unchanged.

**The first empty-reference test was worthless.** The shared fixture passes a
real ref, so nothing exercised the guard, and removing the guard broke no test.
Entries built with no stated source carry `ref: ''` on *every* field — without
the check, a blank id links a message to the user's entire timetable. That case
now has its own test with an explicit precondition.

**Eleven sections showed their compre as a midsem** — see *Exams*. Eight audits
and a full test suite had not noticed, because every test used fixtures and the
fixtures copied the bug.

**Change notices could report but never change.** `matchNotice` emitted
`value: null, actionable: false`, so the second-highest authority in the system
was inert for 31 real changes.

**Pass 3 found five more defects, none of them visible on inspection.** Every
one turned up by running the code against a hostile input — a corrupt blob, a
regenerated catalogue, a rejected write, a duplicated message — and none by
re-reading a function that looked correct. Details in *Hardening* above.

**Three worthless tests, each caught by sabotage rather than by review:**

- *"a mixed-case section claims no in-charge"* used the hand-written fixture,
  which never runs the parser — so a parser ignoring capitalisation entirely
  still passed.
- *"marking complete refuses while a clash remains"* assumed the shared fixture
  overlapped. It does not, so the refusal path was never exercised.
- *"one course's own sections do not clash"* used two different sessions, which
  can never collide, instead of the real case: one course held as both a
  lecture and a lab, sharing one exam.

The pattern in all three: **a test that passes for a reason other than the one
it claims.** Sabotage is the only thing that has reliably exposed them.

---

## Where the code lives

```
tools/parse-timetable.mjs   offline parser: PDF text -> data.json (npm run timetable)
src/timetable/data.json     688 courses, 119 change rows (generated)
src/timetable/sources/      the two official documents, verbatim
src/app/academic/timetable.js       the model: entries, precedence, conflicts,
                                    trace, exams, credits, day/hour grammar
                                    (shared with the tool)
src/app/academic/timetable-mail.js  deterministic mail patterns
src/app/academic/timetable-store.js persistence and course search
src/app/academic/timetable-ui.js    the panel: wizard, manager, proposals
test/timetable.test.mjs             the contracts
```

Layering: `timetable.js` is **pure domain** — no DOM, no storage, no `chrome`.
`timetable-store.js` is platform, `timetable-ui.js` is features. The dependency
tests in `test/package.test.mjs` enforce this.
