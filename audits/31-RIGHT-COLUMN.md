# Audit 31 — Composing `.r-right` into one object

Inspection only. Nothing implemented. Follows audit 30, which found four
widgets stacked in a 62px column with negative vertical slack.

**Brief:** stop fitting four things into 62px. Make the right side read as one
intentional piece of UI.

---

## 1 · What I got wrong in audit 30

I described the problem as *vertical*: four objects, 89px of content, 44–68px
of room. That is true and it is not the important part.

Measuring the tag text changed the diagnosis. `.tag` is 11px uppercase with
wide tracking and 8px of horizontal padding:

| label | rendered width |
|---|---|
| `AUGSD` | ~55px |
| `ACADEMICS` | ~85px |
| `INTERNSHIP` | ~92px |
| `EXT PROMOTIONS` | ~122px |
| `PRACTICE SCHOOL` | ~129px |

**Thirteen of fifteen category labels are wider than the column they sit in.**

And `.r-right` has `min-width: 62px` with no maximum, sitting in the grid's
`auto` track:

```
grid-template-columns: var(--s-1) 1fr auto
                                  │     └── .r-right takes what .tag demands
                                  └──────── .r-mid gives up exactly that much
```

So a `PRACTICE SCHOOL` row surrenders **~67px of subject width** that an
`AUGSD` row keeps. The metadata column's left edge moves from row to row
depending on category.

**That is the scanning cost.** Not that the right side is busy — that it is not
a *column*. The eye cannot track a vertical edge that is not there, so every
row has to be re-parsed from scratch instead of scanned against a stable ruler.
The four widgets are a symptom; the ragged edge is the defect.

## 2 · The redundancy nobody noticed

Category is currently encoded **three times** in the same viewport:

| where | encoding |
|---|---|
| sidebar `.cat` button | 7px dot in `CAT_COLOR[cat]` **+ text label** |
| row `.r-bar` | 4px dot in `CAT_COLOR[cat]` (left rail) |
| row `.tag` | uppercase text pill (right column) |

All three read from one `CAT_COLOR` map. **The sidebar is a permanently visible
legend** — dot beside label, always on screen, in the same colours. The row
already carries the dot on the left.

So the text pill on the right is the third statement of a fact the row has
already made, and it is the widest element in the column.

That reframes the design question. It is not "how do we fit four things" — it
is "one of these four is a duplicate that costs 67px of subject line."

---

## 3 · The two concepts

Both keep every piece of information, keep row height, and use only
`opacity`/`transform`/`color`.

### Concept A — The metadata plate *(strongest)*

Make `.r-right` a **fixed-width, right-aligned plate** — one object with
internal hierarchy, not four siblings:

```
┌────────────┐   fixed 76px, never varies by content
│  ●   14:32 │   colour dot + time, one baseline row
│  ★ CS F111 │   star + course, one baseline row
└────────────┘
```

Four changes, each with a reason:

1. **`width: 76px`, not `min-width: 62px`.** A hard column. The metadata edge
   becomes a ruler the eye can follow, and `.r-mid` gets the same reading width
   on every row regardless of category.

2. **The category tag becomes a dot** — the same `CAT_COLOR` swatch already on
   the left rail, moved to sit beside the timestamp. The sidebar legend teaches
   it, the reader still shows the full text pill, and `title` carries the label
   for hover and screen readers. This is what buys the fixed width: the only
   variable-width element is gone.

3. **Two rows of two**, not a column of four. `● 14:32` is *when and what kind*;
   `★ CS F111` is *mine and which course*. Each line answers one question, and
   two lines fit the vertical budget that four never did.

4. **Star keeps its 28px hit target** via padding, unchanged. It stops being a
   stacked widget and becomes the leading glyph of line two.

**Why this is the strongest from a scanning point of view.** A person scanning
a mail list runs their eye down one edge looking for a match. Today that edge
moves. With a fixed plate they get three stable vertical tracks — dot column,
time column, course column — and can find "the Practice School one from
Tuesday" by colour and position without reading a word.

**What it costs.** The category label stops being readable at a glance for
someone who has not learned the colours. Genuine, and bounded: the sidebar
legend is always visible, the reader shows the label in full, and hover/AT get
it from `title`. Fifteen colours is more than the ~7 a person learns reliably —
but the muted three (`spam`, `other`, `external-promotions`) already share a
grey family, so the discriminable set is smaller than fifteen.

**Open question I cannot answer from here:** whether a colour-only category is
acceptable to *this* user. That is a preference question, not a code question.
A safe variant keeps a 3-letter micro-label (`AUG`, `ACA`, `PS`) at a fixed
width, which preserves the ruler and most of the compression while keeping text.

---

### Concept B — Time as the anchor, everything else as accent

Invert the hierarchy instead of compressing it. Accept that **the timestamp is
the only thing every row has and every row needs**, and build the plate around
it:

```
        14:32          time, right-aligned, tabular-nums, always
     ● CS F111 ★       accents on one line beneath, all optional
```

- The time is the fixed ruler — it already has `tabular-nums`, so its width is
  genuinely constant.
- Line two is a single flex row of *optional* accents: category dot, course
  chip, star. A row with none of them simply has one line, and the plate is
  shorter — but its **right edge and its top line never move**.
- Nothing is hidden; a row with all three shows all three, inline rather than
  stacked.

**Why it is worth considering over A.** It is more honest about what varies. In
A, every row is forced into a two-line plate whether or not it has a course; in
B the plate is as tall as the row's actual metadata, and the constant is the
thing that is genuinely constant. It also degrades better for a non-academic
user, whose rows would have no course chip at all — under A those rows carry a
half-empty second line.

**What it costs.** Less compression than A, and the accent line's *internal*
order shifts as items appear and disappear (dot + star with no course sits
differently from dot + course + star). A fixes that by giving each item a slot;
B trades slot stability for vertical honesty.

---

## 4 · Recommendation

**A, with the micro-label variant as the fallback** if colour-only proves too
opaque in use. It is the only one of the two that produces a genuine column,
and the ragged edge is the measured defect.

B is the better answer if it turns out most rows have no course chip — that is
an empirical question about *your* mailbox that I can settle by counting, if
you want it settled before choosing.

Both are strictly better than the carousel from audit 30, which moved metadata
around and would have made the edge *less* stable, not more.

### What neither concept does

- **No hover-dependent information.** Metadata that appears on hover cannot be
  scanned, and scanning is the entire job of this column.
- **No row height change.** Both fit the existing budget; A by going from four
  stacked items to two lines, B by being as tall as its content already is.
- **No layout-animating transitions.** `package.test.mjs` forbids them and the
  rule is right.
