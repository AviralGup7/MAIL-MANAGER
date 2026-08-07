# 14 · Complexity, file size and module boundaries

**Subject:** BITS Mail Manager at `1386c30`.
**Question:** are the files, functions and boundaries still healthy?
**Method:** measured. Import graphs, fan-in/fan-out, per-function concern
counts, and — the decisive one — **which module-level bindings are touched by
which feature domains.** Scripts, not impressions.

Size alone proves nothing. The test applied throughout: *is this file large
**and** are its responsibilities drifting?*

---

## Verdict in one table

| File | Code lines | Verdict |
|---|---|---|
| `app/app.js` | **2460** | **Oversized and genuinely mixed** — split, in stages |
| `app/features.js` | 663 → **18** | ✅ Split into five modules + a barrel |
| `app/timetable-ui.js` | 810 | Large, cohesive. Leave alone |
| `app/timetable.js` | 618 | Large, **pure**, zero mutable state. Leave alone |
| `background/gmail.js` | 388 | One job: the Gmail wire format. Healthy |
| `app/store.js` | 306 | One job, four indexes. Healthy |
| `classify/pattern-rules.js` | 1027 | **Generated.** Not hand-maintained; irrelevant |

---

## The measurements that matter

### Fan-out

```
20  src/app/app.js        ← nothing else exceeds 8
 8  src/app/features.js
 6  src/classify/index.js
```

`app.js` imports 20 modules and **nothing imports it**. That is the definition
of a control tower. It is not automatically wrong — a shell *should* be the
thing that wires everything — but it sets the bar for what else it may do.

### Fan-in

Highest is `contacts.js` at 4. **No module is imported everywhere.** There is
no hidden god-dependency; the layering holds.

### Concern spread per function

83 functions over 10 lines. **11 touch four or more of** {network, store, DOM,
state, persistence, toast, render}:

```
160L  boot            net,dom,state,persist,toast,render
164L  act             net,store,state,persist,toast
109L  openMessage     net,store,dom,state,render
104L  loadMailboxPage net,dom,state,render
```

`boot` and `act` are orchestrators; breadth is their job. `openMessage` and
`loadMailboxPage` are the ones where breadth is drift.

### The decisive measurement: do domains share state?

For each of the 24 module-level bindings in `app.js`, I counted how many
feature domains touch it.

```
store          7  nav,search,render,reader,actions,sync,menus
rules          5  nav,search,render,sync,menus
savedViews     4  views,reader,render,sync
renderedIds    3  nav,render,actions
—— everything else: 1 or 2 ——
bodyToken      1  reader          catMenu    1  menus
lastBody       1  reader          snoozeMenu 1  menus
markReadTimer  1  reader          helpLayer  1  menus
autoRefreshTimer 1 sync           themeMenuBuilt 1 views
```

**Only 4 of 24 bindings span three or more domains.** That is the finding. The
file is *not* an entangled ball — it is several well-separated modules that
happen to live in one file, plus a genuinely shared core of `store`,
`renderedIds` and `rules`.

Walking top to bottom, the domain changes **42 times across 92 functions** (43
runs, longest 12). The concerns are interleaved on disk even though they are
separated in state. That is what makes the file hard to read.

---

## 🔴 F-1 · `features.js` is five modules in one file — ✅ **DONE**

**What's mixed:** undo, deadline radar, command palette, compose, contact
autocomplete. Five things with nothing in common but the word "feature".

**The evidence that makes this safe:** I checked every module-level binding
against the section it is used in.

> **Zero of ten bindings cross a section boundary.**
> `paletteCommands`, `paletteFiltered`, `paletteIndex`, `knownLabels`,
> `paletteLayer` → palette only. `pendingFiles`, `composeCtx`, `composeMeta`,
> `draftSaver` → compose only. `contactBook` → autocomplete only.

There is no shared state to disentangle. The split is mechanical.

**Severity:** cleanup, not structural risk — but the *cheapest* real
improvement available, and compose alone is 440 lines that would benefit from
being findable.

**Clean split:** `undo.js` (exists), `radar.js`, `palette.js`, `compose.js`,
`autocomplete.js`. `features.js` becomes a re-export barrel or disappears.

**When:** now.

**Outcome.** Split into `undo-actions.js` (21), `radar.js` (69),
`palette.js` (191), `compose.js` (292) and `autocomplete.js` (101), with
`features.js` reduced to an 18-line barrel that re-exports them. No importer
changed. Radar has zero mutable state; every other module owns only its own.

`_resetFeatureState` now calls three per-module seams instead of reaching into
four files' internals — which is the clearest sign the boundary is real.

**One bug came out of it, caught by the suite:** `setStatus()` sat physically
below the autocomplete section, so splitting on section boundaries carried it
into `autocomplete.js` — where it had one caller while compose had eight.
*Proximity in a file is not ownership.* That is the failure mode of every
boundary-based refactor and it is worth expecting rather than being surprised
by.

---

## 🟠 F-2 · `app.js` is a control tower with tenants — **split in stages**

2460 code lines is 3× the next hand-written file. But the earlier audit
(`09-ARCHITECTURE-POST-CHANGE`) concluded *"do not split by line count —
render/sidebar/reader/triage are genuinely coupled via `renderedIds` and
`nodeById`."* **That conclusion was right and is now partly out of date.**

The coupling measurement says which parts are genuinely welded and which are
tenants:

| Group | Lines | Calls out | Called in | Verdict |
|---|---|---|---|---|
| **server search** | 76 | 4 | 1 | **Extract first** — nearly free |
| ~~**saved views**~~ | 128 | 10 → **1** | 4 | ✅ Extracted. The audit's estimate of 10 was wrong; only `countFor` needed the store |
| ~~**menus**~~ | 345 | 7 | 3 | ✅ **Moot.** Now three thin call sites over `menu.js`; the duplication that justified extracting them is gone |
| **reader** (open/close/body/strip) | 347 | 12 | 5 | Extract last, or leave |
| render / list / selection | ~900 | — | — | **Leave.** Genuinely welded via `renderedIds`, `nodeById`, `store` |

**Severity:** structural risk, but a slow one. Nothing is broken; the cost is
that a new engineer must read 2460 lines to find where a category menu lives.

**When:** after `features.js`, one group per change, tests green between each.
Not in one sweep — that is how a working system gets broken for a tidier tree.

---

## 🟡 F-3 · Three hand-rolled menus with identical scaffolding — ✅ **DONE**

`openCategoryMenu`, `openRecategoriseMenu` and `openSnoozeMenu` each build the
same thing: `.snooze-menu` container, `role="menu"`, `.snooze-opt` buttons,
identical arrow-key/Escape handler, `openLayer(...)`, anchor positioning.

Measured: **3 copies** of `className = 'snooze-menu…'` and **3 copies** of the
identical `items[(i + 1) % items.length]` keyboard loop.

The layer primitive already unified *dismissal*. Nothing unified *construction*.
A fourth menu will be a fourth copy, and the keyboard handler is exactly the
kind of thing that gets fixed in two places out of three.

**Clean split:** one `menu({ anchor, label, items })` helper.
**When:** with the menu extraction in F-2.

**Outcome.** `menu.js`. The three call sites disagreed on exactly two things
and both became parameters rather than being flattened: the item **role**
(category rules are `menuitemcheckbox`, snooze options are plain `menuitem`)
and the **mount point** (snooze hangs off the reader's action bar so the row's
overflow cannot clip it). Eight tests written first, pinning the two details a
re-implementation drops — ArrowUp from the first item must wrap to the *last*,
and Escape must `stopPropagation` or one press also closes the reader. Removed
`catMenu` and `snoozeMenu` from `app.js`.

---

## 🟡 F-4 · Six copies of the optimistic-mutation pattern — ✅ **DONE**

`act()` contains six near-identical blocks:

```
const snapshot = {...m}; selectNeighbourThen(id); store.remove(id);
send(VERB).catch(rollback); recordUndo(...)
```

for archive, trash, spam, restore, unsnooze, snooze. The variation is only the
verb, its inverse, and the toast.

This is why `act()` is 164 lines and touches five concerns. It is not
*confused* — it is the same correct idea written six times, which means a fix
to the rollback discipline has six places to miss.

**Clean split:** one `optimistic({ id, verb, undoVerb, label })` helper; each
case becomes three lines.
**When:** with F-2's action work. Lower risk than it looks — the pattern is
already uniform, which is precisely what makes it extractable.

**Outcome.** `optimistic()`. `act()` went from 164 to 125 lines. Snooze did
*not* fit the original shape — it writes local state before the request, so
both the failure path and the undo path must unwind that write — so the helper
grew two honest hooks rather than snooze being forced into a bad fit.

**Sabotage found the missing test that mattered most.** Moving the snapshot to
*after* `store.remove()` broke nothing: undo still put a row back, so every
row-count assertion passed. What silently broke was the **content** — the
restored message would carry post-change values, so an undone star came back
wrong. There is now a field-by-field comparison, and it fails when the
ordering is reversed.

---

## What is healthy, and should be left alone

Stated explicitly, because the instruction not to punish large files for
existing is the right one:

- **`timetable.js` (618 lines).** 34 exports, **zero imports, zero mutable
  state.** A pure domain module. Large because the domain is large.
- **`timetable-ui.js` (810).** One job: the timetable panel. All six bindings
  are panel state.
- **`gmail.js` (388).** One job: Gmail's wire format.
- **`store.js` (306).** One job with four incremental indexes.
- **`pattern-rules.js` (1027).** Generated by `npm run classify:rules`. Its
  size is data, not complexity.

---

## Order of work

1. ~~**F-1 `features.js` → five modules.**~~ Done.
2. ~~**F-3/F-4 the two duplicated patterns.**~~ Done.
3. ~~**F-2 server search, then saved views.**~~ Done. **Stopped there.**

### Where this stopped, and why

Re-measured after the work:

```
module-level bindings in app.js:  24 → 19
spanning 3+ feature domains:       4 → 3   (store, renderedIds, rules)
app.js:                         2460 → ~2200 code lines
```

The three bindings that remain shared are precisely the welded core the
original measurement identified. Menus were dropped from the plan on evidence
rather than fatigue: once `menu.js` existed they became three thin call sites,
and moving them would buy nothing.

The next candidate is the render/list/selection cluster. It is genuinely
coupled through `store`, `renderedIds` and `nodeById`, and splitting it would
mean rewriting several unrelated flows at once. **Better a slightly larger
coherent core than a clean split that damages the product.**

Nothing here is urgent. Everything here compounds.

---

## The answer

**Which file is closest to a god object?** `app.js` — 20 imports, imported by
nothing, 2460 lines, 42 domain switches top to bottom.

**But it is not one.** Only 4 of its 24 bindings span three or more domains.
It is a control tower with four extractable tenants and a genuinely welded
render core, which is a much better position than the line count suggests.

**The most valuable single change is not to `app.js` at all** — it is
`features.js`, where five unrelated modules share a file and **not one binding
crosses between them**.

---

## Addendum — the fourth menu

The cleanup pass above unified **three** hand-rolled menus and declared the
duplication gone. It had missed one.

The theme picker in `app.js` built its own container, wired its own
`role="menu"`, called `openLayer` itself, and carried its own arrow-key
handler. It was not found by the original scan because that scan looked at the
three menus that sat near each other; the theme picker lives 1,300 lines away
in the header section and reads as unrelated code. **Proximity is not
ownership — and neither is distance evidence of independence.**

### The copies had already drifted

This is the part worth recording. By the time the fourth menu was found:

| | `menu.js` | theme picker |
|---|---|---|
| Arrow wrap | yes | yes |
| Escape + `stopPropagation` | yes | yes |
| **Home / End** | **no** | **yes** |
| **Opens on the current item** | **no** | **yes** |
| Item role | checkbox / plain | **radio** |

Two capabilities existed in one copy and not the other, and a third — the
radio role — was a genuine semantic difference the primitive could not express.
That is the copy-paste failure mode the primitive was created to prevent,
observed inside the very pass that created it, one step late.

Absorbing the fourth menu therefore **added** behaviour to the primitive rather
than removing it: Home/End and open-on-current now apply to all four menus, and
`menuitemradio` joins the two roles already supported. No menu can lose them
individually any more.

### A layout bug the tests could not see

Moving the picker onto the primitive broke the colour swatches. The primitive
wraps a label in a plain inline `<span>`, and `width`/`height` do not apply to
an inline non-replaced element — so every 14px dot collapsed to nothing, in the
one menu whose entire justification for existing (rather than being a
`<select>`) is that it shows colour.

**All 873 tests passed while it was broken.** jsdom reports a computed width
for a collapsed inline element quite happily. It was found by rendering the
menu to HTML and looking at it. The wrapper now carries `.menu-label` and the
label `.menu-name`, and a test pins the hook — but the finding is that a
DOM-assertion suite cannot see a layout regression, and rendering remains the
only way to catch this class of defect.

A second, quieter version of the same problem: `.theme-item` and `.snooze-opt`
have equal specificity, and `.theme-item` is declared ~1,500 lines **earlier**.
Every property where they disagreed — alignment, font size, padding — silently
resolved to the primitive's value on source order. Fixed by writing the theme
rules as `.snooze-opt.theme-item`, which wins on specificity and therefore does
not depend on where in the file either block happens to sit.

### An intermittent test, root-caused

`UNDO: a rolled-back action restores the message as it was` failed roughly one
run in four under load. Not a flake to be re-run away: opening a message arms
the 1200ms mark-read timer, and when the machine is busy the test's own waits
exceed that window, so the timer fires *after* undo has restored the snapshot
and flips `unread`. The test then fails on a field it is not about. It now
boots with `markReadOnOpen: false`, which removes the clock from the
measurement and leaves only the snapshot ordering under test — verified still
to fail when the snapshot is taken late.

### Result

```
app.js:                3977 → 3937 lines
menu.js:                165 →  219 lines  (absorbed capability, not just code)
hand-rolled menus:        1 →    0
tests:                  869 →  874
```

Four assertions in the new boundary guard were **sabotage-verified**, and two
of them failed that check on the first attempt: `/menuitemradio/` and
`/'Home'/` both still matched after the behaviour was deleted, because the
strings survived in a CSS selector and an index expression. They now match the
role expression and the branch condition. A source-scanning assertion that
matches a bare string is worth very little; this is the third time that has
been true in this project.

---

## Addendum 2 — the bulk ladder, and a blind spot in the coverage

A third pass over the same brief. The four named criteria all measured as
already met:

```
hand-rolled menu containers in app.js:   0
`const snapshot = {...m}` copies:        1  (inside the helper)
openMenu call sites:                     4
server-search.js / saved-views.js:       extracted
```

Menus really are done. The three remaining arrow-key handlers — the sidebar
rail, the palette and the autocomplete — are a roving-tabindex tree and two
comboboxes. They are different interaction patterns, not menus, and forcing
them through `openMenu` would be abstraction for its own sake.

But the optimistic-mutation criterion had been measured with the wrong
instrument. `const snapshot = { ...m }` is the fingerprint of the *single
message* path, and counting it found one copy and reported success. The
**bulk** family was never part of that merge.

### What was actually there

`bulkAct` carried two five-branch ladders — a forward chain and a separately
hand-written inverse chain inside `recordUndo` — and `autoArchive` added two
more literals. Twelve label lists describing five actions.

**Every inverse was correct.** That was checked before touching anything, by
extracting both ladders and asserting each undo exactly swapped its forward
delta. The finding is not a bug; it is that nothing *made* them correct.

### Why a wrong inverse would have been nearly invisible

This is the part worth recording. The list on screen is restored from the
**local snapshot**, whatever payload goes to the server. So a completely wrong
undo payload still repaints the inbox perfectly and diverges only in Gmail —
where this suite cannot look.

Demonstrated rather than argued: with `trash`'s inverse sabotaged to omit
`remove: ['TRASH']`, the pre-existing test *"BULK: archiving many undoes as ONE
step"* **still passed**. It counts rows. Rows are local.

The new test asserts the round trip at the wire — for each of the five
actions, whatever the forward call adds the undo must remove, and vice versa —
and was verified to fail under two separate sabotages.

### A function with no coverage at all

`autoArchive()` turned out to have **no integration test whatsoever**.
`rules.js` is thoroughly tested — toggling, persistence, the mute/auto-archive
contradiction — so the rule engine was proven while the code that acts on it,
and silently removes mail from the user's inbox on arrival, was not.

Two tests added before refactoring it: that it files new mail, announces
itself, and undoes to the inbox; and that it leaves already-read mail alone.
Both sabotage-verified. Writing them also corrected an assumption of mine — I
asserted the toast read "Auto-archived 3 messages" and it reads "Auto-archived
3" plus an Undo affordance. The test was wrong, not the product.

### Result

```
BULK label literals outside the table:  12 → 0
hand-written inverse chains:             2 → 0   (both derived)
app.js:                               3937 → 3972 lines
tests:                                 874 → 878
```

`app.js` grew by 35 lines, and that is the right outcome. The ladders shrank;
the documentation of why the table exists is longer than the code it replaced.
**Fewer places to be wrong matters more than fewer lines.**

`autoArchive` was deliberately **not** routed through `bulkAct`. It fires
without awaiting, must not clear the user's ticks or close their reader, and
says "Auto-archived" rather than "Archived" because the user did not do it.
Those are real differences and merging them would have meant three flags. Only
the label delta — which was never one of the differences — is now shared.

### Where this stops

Unchanged from the previous pass: the render/list/selection core stays welded.
Nothing in this addendum went near it.
