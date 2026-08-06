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
instructors · room · meetings · daysHours · semester
provenance · history · locked · unresolved
```

`provenance` is per field. Each of `instructors`, `room`, `meetings` and
`daysHours` records **where that value came from**, its reference, and when.
That is what makes every value explainable rather than merely present.

`history` is append-only. Nothing is overwritten silently — the losing value is
recorded, not discarded.

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
slot), `duplicate`, `missing-link`, `unresolved` (a section the document could
not describe).

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

## Persistence

Stored under the `timetable` key in `chrome.storage.local`, so it survives app
restart, browser restart, mail refresh and sync. Cleared on sign-out — it
belongs to the account.

Every persistence path degrades rather than throws: a corrupt blob loads as an
empty timetable, a write failure is reported rather than thrown, a read failure
degrades. A packaging error costs the timetable feature and nothing else — the
inbox still works.

---

## Two defects this feature found in itself

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

---

## Where the code lives

```
tools/parse-timetable.mjs   offline parser: PDF text -> data.json
src/timetable/data.json     688 courses, 119 change rows (generated)
src/timetable/sources/      the two official documents, verbatim
src/app/timetable.js        the model: entries, precedence, conflicts, trace
src/app/timetable-mail.js   deterministic mail patterns
src/app/timetable-store.js  persistence and course search
src/app/timetable-ui.js     the panel: wizard, manager, proposals
test/timetable.test.mjs     54 tests
```

Layering: `timetable.js` is **pure domain** — no DOM, no storage, no `chrome`.
`timetable-store.js` is platform, `timetable-ui.js` is features. The dependency
tests in `test/package.test.mjs` enforce this.
