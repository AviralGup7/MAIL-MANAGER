# Audit 26 — Premium Feel

Not polish, not UI, not animation. **Craftsmanship**: the details that separate
software that works from software that feels expensive.

The honest framing after twenty-five audits: this product has already had its
type scale, spacing rhythm, motion system, elevation ladder and design-token
compliance audited and fixed. Those are the things that usually *are* the
answer. So this pass had to look where none of the others did — at what happens
when **real content meets the layout**, which is where craftsmanship actually
lives and where every previous audit inspected the container rather than the
contents.

## Method

Three probes previous audits did not run:

1. **Hostile content.** A 300-character unbroken token — a forwarded tracking
   URL, base64 in a subject line — pushed through every text surface in a real
   jsdom layout.
2. **Ellipsis reachability.** Every `text-overflow: ellipsis` traced to its
   flex parent, because ellipsis on a flex child without `min-width: 0`
   **never fires**. Declaring it is not the same as having it.
3. **Craft-signal inventory.** `::selection`, `caret-color`, `user-select`,
   `overflow-wrap`, `font-variant-numeric`, scrollbar styling, cursor
   vocabulary — the properties nobody notices until they are missing.

## What is already at the standard

Stating this precisely, because it changes what the findings mean.

- **The reading surface is genuinely well-made.** 15px/1.65 at a **68ch
  measure**, with a written rationale about the eye losing its place past ~70
  characters. Images constrained, `<pre>` set to `pre-wrap`, tables capped,
  `word-wrap: break-word` on the body, theme-aware ink that leaves
  sender-styled text alone. That is a considered typographic surface, not a
  default.
- **Timing is disciplined**: 71 transitions across exactly three durations,
  38 `--dur-instant` / 31 `--dur-fast` / 2 `--dur-base`.
- **Cursor vocabulary is deliberate and small**: `pointer` ×22, plus one
  `progress` and one `not-allowed` — used for meaning, not decoration.
- **`::selection` is themed**, `font-variant-numeric: tabular-nums` appears 15
  times on the numeric columns, scrollbars are styled.
- **The message row is correctly built** — `.r-mid` carries `min-width: 0`, so
  its three ellipses genuinely work. This matters: it proves the pattern was
  understood, which makes its absence elsewhere drift rather than ignorance.

---

## P-1 · Seven `text-overflow: ellipsis` declarations that can never fire — **systemic**

**Component.** `.radar-what`, `.suggest-label`, `.notice-why`, `.att-name`,
`.c-file-name`, `.r-msg-snip`, `.ac-name`.

**What reduces perceived quality.** Each declares `text-overflow: ellipsis`
inside a `display: flex` parent, with **no `min-width: 0`** on the shrinking
child. A flex item's default `min-width` is `auto`, which means it refuses to
shrink below its content — so the item grows past its container instead of
truncating. The ellipsis is dead code.

Verified in a real layout, not inferred: `.radar-item` and `.suggest-item` both
compute `display: flex`, and neither child has `min-width`.

**Why users subconsciously notice.** They do not see a missing ellipsis. They
see a deadline title shoving the date off the edge of the rail, or a suggestion
row pushing its keyboard hint out of view. It reads as the layout *losing
control* of its own content — the single loudest "unfinished" signal a UI can
emit, because it is what a broken prototype looks like.

**What premium products do differently.** They truncate. Every list row in
Linear, Superhuman and Apple Mail ends in an ellipsis rather than letting one
long string dictate the layout. The container is authoritative; the content
fits inside it.

**Concrete improvement.** `min-width: 0` on each of the seven, plus `flex: 1`
where the child is meant to absorb the space. This is exactly the pattern
`.r-mid`, `.outbox-to`, `.snoozed-what`, `.view-name` and `.rule-text` already
use — **five components got it right and seven did not**, which is what makes
this drift rather than a missing idea.

**Impact.** The rail and the search dropdown stop being deformable by content.

**Priority: high. Systemic** — it is the same one-line omission repeated seven
times.

---

## P-2 · Three attacker-controlled strings have no overflow defence at all

**Component.** `#r-subject`, `#r-from`, `.att-chip`.

**What reduces perceived quality.** These have neither `text-overflow` nor
`overflow-wrap` nor `word-break`. Measured in a 600px reader: all three compute
every relevant property as unset.

The content is not hypothetical. `#r-subject` renders the raw `Subject:`
header, `#r-from` the raw `From:`, and `.att-chip` a raw filename. All three are
fully sender-controlled, and institutional mail routinely carries base64
fragments, tracking IDs and 200-character URLs in exactly these fields.

**Why users subconsciously notice.** The reader is where the eye rests. A
subject line running under the toolbar, or an attachment chip extending past
the panel edge, is the most visible possible failure — and it happens on the
one screen the user is looking at most closely.

It is also the difference between "a long subject" and "the app is broken":
premium software absorbs bad input silently.

**What premium products do differently.** A subject wraps to two lines and then
truncates; a filename truncates in the middle so the extension stays visible.
Neither is ever allowed to change the layout.

**Concrete improvement.** `overflow-wrap: anywhere` on the subject and sender
(they should wrap, not truncate — the full text matters in the reader), and
`min-width: 0` + ellipsis on the attachment chip's name.

`anywhere` rather than `break-word`: `break-word` only breaks when a word
cannot fit on a line *of its own*, which still lets a long token overflow a
narrow flex column. `anywhere` also lets the browser count the break
opportunity when computing min-content width, which is the behaviour actually
wanted here.

**Impact.** The reader stops being deformable by a hostile header.

**Priority: high. Isolated** to three rules, but on the highest-visibility
surface.

---

## P-3 · Filenames truncate at the end, hiding the one part that matters

**Component.** `.att-name`, `.c-file-name`.

**What reduces perceived quality.** Once P-1 gives these a working ellipsis,
they will truncate on the right — turning
`Comprehensive_Examination_Timetable_Semester_II_2026_FINAL.pdf` into
`Comprehensive_Examination_Time…`.

The extension is the highest-information part of a filename. It is what tells
the user whether this is the PDF they wanted or a stray `.xlsx`, and
right-truncation is precisely the way to lose it.

**Why users subconsciously notice.** They cannot tell what the file is without
hovering. On institutional mail, where filenames are long and formulaic and
differ only at the end, right-truncation removes the discriminating
information from every chip on screen.

**What premium products do differently.** Finder, Mail.app and Slack all
middle-truncate filenames: `Comprehensive_Examin…_FINAL.pdf`. Head and tail
both survive.

**Concrete improvement.** Middle-truncate in JS at render time — CSS cannot
express it. A small helper that keeps the last 12 characters and elides the
middle, applied wherever a filename is displayed.

**Impact.** Attachments become identifiable at a glance.

**Priority: medium.** **Isolated**, but it is the difference between a chip
that informs and a chip that decorates.

---

## P-4 · Text is selectable on controls, so drag-selecting a list smears blue across the UI

**Component.** Every button, row, menu item and rail entry — `user-select`
appears **zero** times in 4,600 lines.

**What reduces perceived quality.** A click-and-drag that starts on a message
row and moves — a very common imprecise gesture — selects the text of every row
it crosses. The list fills with selection highlight, and the user has to click
elsewhere to clear it.

Double-clicking a button selects its label. Shift-clicking to extend a message
selection also text-selects everything between.

**Why users subconsciously notice.** It is the clearest tell that an interface
is *a web page wearing an app's clothes*. Native applications do not do this,
and neither do the products in the comparison list. It happens accidentally,
frequently, and always looks like a mistake.

**What premium products do differently.** Chrome UI is `user-select: none`;
*content* is selectable. The line is drawn deliberately: you can select a
message body, a subject in the reader, an address — but not a button label or
a row in a list.

**Concrete improvement.** `user-select: none` on the control surfaces —
buttons, rows, menu items, rail entries, headers — and explicit
`user-select: text` on the reading surfaces so nothing that *should* be
copyable becomes uncopyable. The second half matters more than the first: a
blanket `none` on the app would be a worse bug than the one being fixed.

**Impact.** The app stops feeling like a document.

**Priority: high. Systemic** — one absent property affecting every surface.

---

## P-5 · No `caret-color`, so the text cursor is the browser default against a themed field

**Component.** `#search`, `#c-to`, `#c-subject`, `#c-text`, the palette input.

**What reduces perceived quality.** The caret renders in the browser's default
colour — black on light themes, and on dark themes whatever the engine decides,
which is usually a plain white bar with no relationship to the accent.

**Why users subconsciously notice.** The caret is the single element the eye
tracks continuously while typing. When everything else in the field is themed
and the blinking cursor is not, it reads as one element that did not get the
memo.

**What premium products do differently.** Linear, Notion and Superhuman all
theme the caret to the accent. It is a detail nobody articulates and everybody
registers.

**Concrete improvement.** `caret-color: var(--accent)` on the text inputs.
One declaration; the token exists.

**Impact.** Typing feels like part of the product.

**Priority: medium. Systemic** but trivially fixed.

---

## Checked and found sound

| Craft signal | Finding |
|---|---|
| Reading measure | ✅ 68ch with a written rationale |
| Body typography | ✅ 15px/1.65, antialiased, theme-aware ink |
| `<pre>` handling | ✅ `pre-wrap` — plain-text mail cannot force horizontal scroll |
| Wide tables | ✅ `max-width: 100%!important` |
| Images in mail | ✅ constrained, rounded, blocked-state placeholder with alt text |
| Transition timing | ✅ 71 transitions, exactly 3 durations |
| Cursor vocabulary | ✅ `pointer`/`progress`/`not-allowed` — meaning, not decoration |
| `::selection` | ✅ themed |
| Tabular numerals | ✅ 15 uses, all on numeric columns |
| Scrollbars | ✅ styled, both standards |
| Message row truncation | ✅ `.r-mid` has `min-width: 0` — correctly built |
| Focus rings | ✅ one global rule, four deliberate overrides |
| Disabled states | ✅ present on every button variant |

**On the identity rule:** the timetable's typography and truncation are handled
by the same rules as the mail surfaces, and three of the seven P-1 offenders
are academic — meaning the academic surfaces are neither better nor worse
crafted than the mail ones. That is the correct outcome.

## Priority

| # | Finding | Scope | Priority |
|---|---|---|---|
| P-1 | 7 dead ellipsis declarations | systemic | **high** |
| P-4 | No `user-select` discipline | systemic | **high** |
| P-2 | 3 undefended sender-controlled strings | isolated, high-visibility | **high** |
| P-3 | Filenames truncate away the extension | isolated | medium |
| P-5 | Unthemed caret | systemic, trivial | medium |

---

## Applied

All five. **1272 tests pass. All six themes still meet WCAG AA.** Five craft
guards added, all sabotage-verified.

| # | Change |
|---|---|
| P-1 | `min-width: 0; flex: 1` on the seven dead-ellipsis surfaces |
| P-2 | `overflow-wrap: anywhere` on `#r-subject` and `#r-from` |
| P-3 | `middleTruncate()` in `icons.js`, wired into both attachment surfaces |
| P-4 | `user-select: none` on chrome, `text` explicitly restored on content |
| P-5 | `caret-color: var(--accent)` on inputs and textareas |

### `anywhere`, not `break-word`

Worth stating because the two look interchangeable and are not.
`overflow-wrap: break-word` only breaks a word that cannot fit on a line *of
its own*, which still lets a long token overflow a narrow flex column.
`anywhere` additionally lets the browser count the break opportunity when
computing min-content width — which is the behaviour actually needed inside a
flex layout, and the reason the subject was overflowing in the first place.

### The restore half of P-4 is the important half

A blanket `user-select: none` would have been a worse bug than the one it
fixed: the message body, the subject, an address and a deadline are all things
people legitimately copy out of a mail client. Chrome is unselectable; content
is explicitly restored, and there is a guard asserting **both** directions.

### Three of my own mistakes, all caught by existing guards

- **The duplicate-selector guard fired twice.** I added standalone
  `#r-subject` and `#r-from` blocks for `overflow-wrap`, and listed both again
  in the `user-select: text` group — while `#reader`, their ancestor, already
  covered them. Folded into the existing rules.
- **My own ellipsis guard reported six false positives**, including `.r-subj`
  and `.r-snip` — the message row, which is the one component that was already
  built correctly. The constraint can live on a **parent**: `.r-mid` carries
  `min-width: 0` and the shrink propagates. The guard now checks the real
  layout and documents the exceptions with the reason.
- **`.tt-where` was a false positive too**, for a different reason: it sits in
  a `flex-direction: column` cell, where `min-width` governs nothing because
  the main axis is vertical.

The pattern, again: **a check that reads declarations tests the declarations.
Only a check that renders tests the behaviour.**

### What this audit could not assess

Real font rendering, subpixel positioning, actual frame rate, and how any of
this feels under a trackpad. jsdom has no layout engine. The findings here are
the ones that are *provable* from structure — a dead ellipsis is dead
regardless of renderer, and an unconstrained token overflows in every browser.
Anything about optical balance or perceived smoothness remains unverified by
this pass and is honestly out of reach without running the extension.
