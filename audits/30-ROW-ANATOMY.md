# Audit 30 — Row anatomy, and what can change without touching height

Inspection only. Nothing implemented.

**Question:** which parts of `.row` can change presentation without changing
row height, and is there a better idea than density switching?

---

## 1 · The anatomy, measured

```
.row  display:grid  grid-template-columns: var(--s-1) 1fr auto
      height: var(--row-h)          ← hard height, not min-height
      contain: layout paint style   ← paint containment CLIPS overflow
      content-visibility: auto
      contain-intrinsic-size: var(--row-h)

├── .r-pick    4px   grid, place-items:center      [bar + checkbox]
├── .r-mid     1fr   flex column, gap 2px, min-width:0
│   ├── .r-line1     flex row, baseline   [.r-from + .r-count]
│   ├── .r-subj      13px, nowrap + ellipsis
│   └── .r-snip      12px, nowrap + ellipsis   (display:none in compact)
└── .r-right   auto  flex COLUMN, align-end, gap 4px, min-width:62px
    ├── .r-course    ~17px  (hidden unless enrolled)
    ├── .r-date      ~15px  (always)
    ├── .r-star       28px  (always — WCAG 2.5.8 hit target)
    └── .tag         ~17px  (always)
```

### The three density modes are almost entirely token changes

| | `--s-2` | `--s-3` | `--s-4` | `--row-h` | extra |
|---|---|---|---|---|---|
| comfortable | 8 | 12 | 16 | 68px | — |
| cosy | 6 | 10 | 12 | 56px | — |
| compact | 4 | 8 | 10 | 44px | `.r-snip { display:none }` |

**One structural override in the entire density system.** Everything else falls
out of four spacing tokens. That is elegant, and it is also why density
switching is a blunt instrument: it moves all rows at once and the only content
decision it can express is "snippet or no snippet".

### The finding that matters

Adding up the vertical budget:

```
comfortable  row-h=68  padding=24  content≈54  →  SLACK ≈ -10px
cosy         row-h=56  padding=20  content≈54  →  SLACK ≈ -18px
compact      row-h=44  padding=16  content≈36  →  SLACK ≈  -8px
```

And `.r-right` stacks four children in a column:

```
.r-course 17 + .r-date 15 + .r-star 28 + .tag 17 + 3 gaps 12  ≈ 89px
                                        into 44–68px of row
```

**Every mode is already over budget and relying on `contain: paint` to clip.**
Nothing is falling out of the row visually because the clip is doing the work,
but there is no vertical headroom anywhere. Any concept that needs even 4px of
extra height is dead on arrival.

**This also relocates the crowding.** It is not that rows are too tall or too
short. It is that `.r-right` is four competing objects — a course chip, a
timestamp, a star and a category tag — stacked in a 62px column that cannot
hold them. That column is the densest part of the product.

---

## 2 · What is actually free

Hard constraints, all verified against the code:

- **Height is sacred.** `height: var(--row-h)` + `contain-intrinsic-size`. A
  variable height makes the intrinsic size a lie and the scrollbar jumps.
- **`transitions must not animate layout`** — enforced by `package.test.mjs`.
  Forbidden: `width height max-height top left right bottom margin padding
  font-size`. This rule already caught me once on the scroll-compression work.
- **`font-weight` must not be transitioned** — `.r-from` documents why:
  browsers snap between faces and reflow the text.
- **`contain: paint` clips**, so anything drawn outside the row is invisible.
  No popovers escaping the row.

Free, composited, no layout:

| Property | Safe? | Notes |
|---|---|---|
| `opacity` | ✓ | compositor only |
| `transform` (translate/scale/rotate) | ✓ | already used for the selection rail |
| `color`, `background-color`, `border-color` | ✓ | already transitioned on `.r-subj`, `.r-from`, `.tag` |
| `filter`, `backdrop-filter` | ✓ | unused so far |
| `clip-path` | ✓ | animatable, composited |
| `grid-template-columns` on `.row` | ✗ | layout, and forbidden by the test |
| `flex-basis` / `width` on `.r-right` | ✗ | layout |
| `display` toggles | ✗ | layout, and cannot be transitioned at all |

One important nuance: **`transform` on a row's CHILD is fine.** The rule about
transforms fighting `content-visibility` applies to the row itself. A child that
translates inside a clipped, contained box costs nothing outside it.

---

## 3 · Three concepts

Ranked by value-to-risk. All keep every row, every row's height, and every
piece of information.

### Concept A — Right-column carousel *(recommended)*

**The problem it solves:** `.r-right` holds four objects in space for two.

Today they stack and clip. Instead, keep them stacked in the same 62px column
but give the column a `transform: translateY()` that moves in fixed row-height
steps, showing **two at a time** and shifting on attention:

```
at rest              hovered / focused / selected
┌──────────┐         ┌──────────┐
│  CS F111 │         │  CS F111 │
│      2h  │   →     │      2h  │      ← same two
└──────────┘         │  ★       │      ← star + tag translate in
   (clipped)         │ ACADEMICS│
                     └──────────┘
```

- Only `transform` on a child, inside a clipped box. Composited.
- Row height never changes; the column is taller than the row and always was.
- Nothing is hidden that is visible today — it reveals what is *already
  clipped*.
- The star remains keyboard-reachable regardless of visual position (it is
  focusable; focus triggers the same state).

**Risk:** a star you must hover to *see* is worse than one you can always hit.
Mitigation: keep `.r-star` in the always-visible pair and rotate the *tag* and
*course chip*, which are informational rather than interactive.

**Why it is the best of the three:** it targets the measured densest point, and
it is the only concept that makes the row *less* clipped rather than more
decorated.

---

### Concept B — Metadata cross-fade in one slot

Collapse `.r-course`, `.r-date` and `.tag` into a **single stacked slot** where
all three occupy the same grid cell, and cross-fade between them by attention
state:

```
resting   →  "2h"                    (the sorting key: what scanning needs)
hover     →  "CS F111 · ACADEMICS"   (the classification: what deciding needs)
```

- Pure `opacity` + a small `translateY(2px)` on the incoming layer.
- All three elements stay in the DOM, stay in the a11y tree, stay in `title`s.
- Frees ~34px of vertical column pressure immediately.

**Risk:** the date disappearing on hover is a real loss — people navigate by
"the one from Tuesday" and the row they are hovering is the one they are
deciding about. Mitigation: keep the date permanent and cross-fade only
course ↔ tag, which are both classification.

**Weaker than A** because it genuinely removes something on hover, where A only
adds.

---

### Concept C — Attention-weighted ink (no geometry at all)

Change nothing structural. Modulate **colour and opacity only**, driven by the
same signals the lanes already compute:

```
needsReply / direct      full ink,   tag at full contrast
announcements            fg-dim
newsletters / promos     fg-faint,   tag border only, no fill
read + older than 7d     opacity 0.72
```

- Only `color` and `opacity` — the two safest properties in the file.
- Zero layout risk, zero geometry change, works in all three densities.
- It is your #8 (attention-based layout) applied to *ink* instead of *space* —
  which is the version that survives a virtualised list.

**Risk:** contrast. `npm run contrast` verifies theme pairs, not
`opacity: 0.72` composited over them. Any opacity floor would need adding to
that checker first, or it silently reintroduces the `--fg-faint` AA failure the
theme audit already fixed once.

**Lowest risk, lowest ceiling.** Good as a companion to A, not as the answer.

---

## 4 · Recommendation

**A, with C as a follow-on.** A fixes the measured problem — four objects in a
62px column — using only `transform` on a clipped child. C makes the resulting
rows feel calmer without touching geometry, but should not ship until the
contrast checker understands opacity.

**B is not worth it** unless A proves impossible: it trades a real loss (the
timestamp on the row you are looking at) for space that A recovers without one.

Not proposed, and why:

- **Per-row height change** in any form — magnetic, bloom, peel. Measured cost
  is a 100px scrollbar jump on a 2000-row list.
- **Hover popovers escaping the row** — `contain: paint` clips them; escaping it
  means abandoning the containment that makes the list fast.
- **Surfacing the density selector.** Deferred as instructed, and the anatomy
  supports that call: density can only say "snippet or no snippet", which is
  not the lever the complaint is about.
