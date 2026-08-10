# Audit 34 — Magnetic alignment

Wow-animation concept **#2**. Design only. **No code written.**

Brief: find places where elements could *attract, align or settle* toward
related elements during interaction — naturally and usefully, not as a generic
hover effect. Don't force the pattern if the product has no good candidate.

Everything below measured in **real Chrome 148** against `preview.html` (which
boots now, following concept #1).

---

## 1 · What "magnetic" can honestly mean here

The literal reading — elements physically drifting toward a cursor — is a poor
fit for this product and I want to say why before proposing an alternative,
rather than quietly substituting one.

This is a **dense keyboard-first list**. Its central performance claim is that
2000 rows scroll at 60fps with no virtualiser, and that rests on:

```css
.row { height: var(--row-h); contain: layout paint style;
       content-visibility: auto; contain-intrinsic-size: var(--row-h); }
```

Rows that lean toward a pointer would mean per-frame transforms on the exact
elements `content-visibility` is allowed to skip. And the product's own
stylesheet already rejected this class of idea twice, in writing:

> *"Only colour transitions here. A transform on the row itself would fight the
> scroll."*
> *"No transform: these sit in dense toolbars where a scale on hover would make
> the row feel unstable."*

So I looked for the **useful** sense of magnetism instead: *a thing coming to
rest in the right place rather than an arbitrary one.* Snapping, settling and
alignment — attraction between an element and the position it ought to occupy.

That reading found a real, measurable defect.

---

## 2 · Candidates surveyed

| # | Candidate | Verdict |
|---|---|---|
| **A** | **Selected row settles with lookahead instead of flush against the edge** | **STRONGEST — recommended** |
| B | Cursor attraction on `.r-star` | Rejected — solves a solved problem |
| C | Menus magnetically avoiding the viewport edge | Rejected here — real bug, wrong concept |
| D | Rows leaning toward the pointer | Rejected — violates the row contract |
| E | Scroll-snap on the list | Rejected — actively harmful, see §5 |
| F | Reader body settling between messages | Not possible — it is an iframe |
| G | Compose panel snapping to edges | Rejected — no drag exists to snap |

### B — the star (rejected, and worth recording)

The obvious "magnetic cursor" target. But the star's aiming problem is
**already solved, deliberately and better**: a 15px icon inside a 28px hit
target, with a comment explaining that this is "the difference between
designing what a control looks like and designing what it is."

A magnetic pull would move a control that is already easy to hit, on a list
that scrolls, where the pointer is often travelling *past* the star to a row
below. That is the definition of a gimmick, and it would fight the
`contain: paint` clip on the row.

### C — menus (a real bug, but not this concept)

`.snooze-menu` is positioned purely in CSS (`top: calc(100% + var(--s-2))`)
with **no collision logic at all**. I measured the category menus at three
positions down the rail expecting viewport overflow. They do not overflow the
viewport — but they **are clipped by `#cats`**, which is a scroll container.

That is a genuine defect worth its own item. It is not magnetism; it is
missing collision handling. **Filing it, not bundling it.**

### E — scroll-snap (rejected, and it is the trap)

`scroll-snap-type: y mandatory` is the reflexive "magnetic list" answer and it
would make this product worse:

- It hijacks free scrolling. Scanning a list quickly for a subject you half
  remember is a core gesture, and snap fights the flick.
- With `contain: strict` on `#scroller` and `content-visibility: auto` on rows,
  snap points are computed against elements whose layout the browser is
  deliberately skipping.
- It solves nothing that A solves, and costs the thing A preserves.

Recording it because it is the first thing anyone will suggest.

---

## 3 · The recommendation: **A — the selected row stops hugging the edge**

### 3.1 The defect, measured

`move(delta)` (`app.js:4583`) does this on every `j` / `k`:

```js
node.scrollIntoView({ block: 'nearest' });
```

`nearest` means *do the least work possible*: if the row is out of view, scroll
exactly far enough to bring it flush against the nearest edge — and no
further. Measured on a 400-row list, comfortable density:

```
step  gapAbove  gapBelow  nextRowVisible
 9      679.3      50.8      50.8
10      730.3      -0.2      0        <- flush against the bottom edge
11      730.3      -0.2      0
...     730.3      -0.2      0        <- forever
```

Once the list starts scrolling, **the selected row is pinned to the bottom edge
of the viewport for the rest of the session**, with *zero pixels* of the next
message visible.

Across three densities, 60 keyboard steps each:

| density | steps with no next-row visible |
|---|---|
| comfortable | **50 / 60 (83%)** |
| cosy | **47 / 60 (78%)** |
| compact | **43 / 60 (72%)** |

### 3.2 Why this matters more than it sounds

Triage is not reading — it is a **sequence of decisions**, and the question
being answered at each step is *"is the next thing more urgent than this
thing?"* Pinning the current row to the bottom edge means the user answers that
question **with no information**, then presses `j` and discovers the answer
after committing.

It also breaks a spatial expectation. The row moves to the bottom, the list
jumps up under it, and the eye has no anchor: the thing you are looking at is
always at the boundary, which is the one place peripheral vision has nothing to
work with.

This is the "settling in the right place" reading of magnetism, and it is a
real, measured, 83%-of-the-time defect rather than an effect.

### 3.3 The proposed behaviour

> **The selection settles one row inside the edge, not against it.**

Implemented with a CSS property that exists for exactly this purpose:

```css
#scroller {
  scroll-padding-block: var(--row-h);
}
```

`scroll-padding` tells the scroll container *"treat the viewport as if it were
inset by this much"*, and `scrollIntoView({ block: 'nearest' })` then lands the
row one row-height inside the boundary instead of on it. Measured:

| `scroll-padding-block` | gap below selection | steps blind |
|---|---|---|
| 0 (today) | −0.2px | **50/60** |
| `--row-h` (68px) | 67.8px | **0/60** |
| 2 × `--row-h` | 135.8px | 0/60 |

**One row of padding eliminates 100% of the blind steps** in every density —
and because the value is `var(--row-h)`, it is automatically 68/56/44px without
a per-density rule. That is the same token-remap discipline the density system
already uses.

`2 × --row-h` also works and gives more context, but costs a whole extra row of
scrolled distance per step. **I would ship one row** and say so rather than
present both as equal.

### 3.4 What the user should perceive

Almost nothing consciously — which is the correct outcome here. What they
should *notice the absence of* is arriving at a message and not knowing what is
behind it.

Described honestly: **the list stops shoving your message into the corner.**
There is always one more row of context in the direction you are travelling, so
the selection feels like it is *sitting in* the list rather than being pushed
out of it.

### 3.5 Does it need motion at all?

**No — and that is a point in its favour, not against it.**

`scroll-padding` changes *where the row lands*, not how it gets there. The
improvement is entirely positional.

There is a separate, optional question: today the jump is instantaneous
(`scroll-behavior: auto`). A `smooth` scroll would make the settle *visible* —
the actual "magnetic" feel. I am **recommending against it in the same change**,
for a reason I can measure: `openMessage()` already carries a `rapid` guard
(`now - lastSwapAt < 200`) because holding `j` produced a stack of interrupted
200ms animations. Smooth scrolling has exactly that failure mode, and
`scroll-behavior: smooth` has no equivalent guard — held `j` becomes a queue of
competing scroll animations.

If the user wants the visible settle, it should be **its own decision** with its
own measurement of held-key behaviour. The positional fix stands alone and is
the part carrying the value.

---

## 4 · Feasibility against the architecture

| constraint | status |
|---|---|
| No layout animation | **Satisfied** — no animation at all; one static CSS property |
| Row contract (`contain`, `content-visibility`) | **Untouched** — no per-row work |
| Forbidden transition properties | N/A — nothing is transitioned |
| Design tokens, not ad-hoc values | **Satisfied** — `var(--row-h)`, already a token |
| Duplicate-selector rule | Must edit the existing `#scroller` block in place |
| Density | **Free** — `--row-h` is already remapped per density |

### Performance

- `scroll-padding` is read by the scroll machinery, not per frame.
- 200 changes with a forced style flush: **3.9ms total, 0.019ms each.**
- 40 `j` presses on a 400-row list: **26.8ms before, 26.5ms after** — 0.67ms →
  0.66ms per move. **No measurable cost.**

### Pointer / keyboard / touch

- **Keyboard** — the whole point; `j`/`k` and arrows all route through `move()`.
- **Pointer** — clicking a row does not scroll, so nothing changes. Correct: the
  user is already looking at what they clicked.
- **Touch** — free scrolling is untouched, because this is not snap.
- One asymmetry to decide: `scroll-padding-block` pads **both** ends.
  Symmetrical is right — `k` upward deserves the same lookahead as `j` — and it
  costs nothing extra, but it should be a stated choice rather than a default.

### Accessibility and reduced motion

- **No motion is introduced**, so `prefers-reduced-motion` has nothing to
  disable — the fix applies equally in both modes, which is strictly better
  than an effect that vanishes.
- Positive for low-vision and screen-magnifier users: a magnified viewport shows
  fewer rows, so edge-pinning hurts them *more* than it hurts everyone else.
- No change to `aria-activedescendant`, focus order or announcements.

---

## 5 · Is it genuinely better, or a gimmick?

**Genuinely better, and it is barely an animation — which is why I am proposing
it rather than something flashier.**

The honest framing: I was asked for magnetic alignment and the strongest thing
I found is a **one-line positional fix to a measured defect**, not a physics
effect. I would rather report that than dress a 60fps risk in the word
"magnetic."

Against the gimmick test:

- **Does it survive being turned off?** The improvement *is* the resting
  position; there is nothing to turn off.
- **Would a user notice it missing?** They already do — 83% of steps.
- **Does it cost anything?** 0.019ms, no layout animation, no new token.

The one thing that would make it feel *magnetic* in the animated sense — smooth
settling — is the part I am **explicitly deferring**, because the held-`j`
failure mode is documented in this codebase already.

### If you want the animated version

The honest sequencing is: ship the positional fix, measure held-`j` with
`scroll-behavior: smooth` and a rapid-guard, and treat that as a separate
decision. I would not combine them, because if the combination feels wrong it
would be unclear which half was responsible.

---

## 6 · Risks

| risk | mitigation |
|---|---|
| Padding both ends wastes space on short lists | Measure: with fewer rows than a viewport there is no scrolling, so it never applies. Verify. |
| `contain: strict` interacting with `scroll-padding` | Measured working, but re-verify at all densities before locking. |
| Interaction with `overflow-anchor: auto` during delta sync | Untested. New mail inserts above the selection; must confirm padding does not amplify the anchoring correction. **This is the one real unknown.** |
| The value drifting from `--row-h` | Assert `scroll-padding` resolves to the row height in every density. |

---

## 7 · Tests I would write (each sabotage-verified)

1. `#scroller` declares `scroll-padding-block` and it resolves to `var(--row-h)`
   — *sabotage: hardcode 68px, expect fail in cosy/compact.*
2. `move()` still uses `block: 'nearest'` — the padding is what does the work,
   so a future change to `'center'` would silently double the scrolling.
3. No `scroll-snap-type` appears on `#scroller` — *records the rejected
   decision so it cannot creep back in.*
4. A jsdom-level assertion that `move()` still calls `scrollIntoView` guarded by
   the existing `typeof` feature check (a dead `j` key is worse than a missing
   scroll — that comment is already in the source).

Plus a **browser-level check** of the lookahead claim itself, since no jsdom
test can see scroll position. Concept #1 established that a real-Chrome
measurement can be part of the workflow; the lookahead number is exactly the
kind of claim that rots silently without one.

---

## 8 · Recommendation

Implement **A — `scroll-padding-block: var(--row-h)` on `#scroller`**, with:

1. verification at all three densities and on a long list;
2. the `overflow-anchor` / delta-sync interaction checked explicitly;
3. **smooth scrolling deliberately excluded** and deferred to its own round.

Also filing, not bundling: **`.snooze-menu` has no viewport collision logic and
is clipped by `#cats`.**

**Awaiting approval before any code is written.** Concept #3 untouched.
