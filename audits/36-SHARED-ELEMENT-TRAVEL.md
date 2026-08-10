# Audit 36 — Shared-element travel

Wow-animation concept **#4**. Design only. **No code written.**

Brief: find where an element could visually **travel from its current location
into its destination**, making "this thing became that thing" clear. Don't
force FLIP just because the pattern exists.

Measured in **real Chrome 148**.

---

## 1 · The test I applied

A shared-element travel is honest only when **all** of these hold:

1. **Both endpoints exist on screen** at the moment of the change.
2. **The two things are the same object**, not merely related.
3. **The relationship is currently unclear** — the travel must teach something.
4. It survives the architecture: rows live inside `contain: strict`, so
   anything leaving a row needs a body-level ghost.
5. It is not out-competed by a **simpler static answer**.

Five candidates measured. Most fail on #1 or #3.

---

## 2 · Candidates measured

| # | Travel | Endpoints both visible? | Verdict |
|---|---|---|---|
| **A** | **Archived row → Undo toast** | source destroyed, toast appears 661px away | **STRONGEST** |
| B | Row subject → reader heading | yes, both visible | Rejected — see §4 |
| C | Row → snoozed rail section | **destination `hidden` at action time** | Rejected |
| D | Compose → outbox rail | **destination `hidden` at action time** | Rejected |
| E | Row → sidebar category count | destination may be scrolled out of `#cats` | Rejected |

### C and D fail on a measured fact

```
snoozed: { hidden: true, x:0, y:0, w:0, h:0 }
outbox:  { hidden: true, ... }
radar:   { hidden: true, ... }
```

All three rail sections are **hidden when empty**. On the first snooze or first
send, the destination *does not exist yet* — there is no box to travel to, and
one would have to be conjured mid-flight. Animating toward a point that is
about to be created is not a shared element; it is a guess.

### E fails on containment

`#cats` is `overflow: auto` and **scrollable** (`catsScrollable: true`, 23
categories). The destination count can be scrolled out of view, so the travel
would sometimes fly to an invisible target.

---

## 3 · Candidate A (recommended) — **the archived row becomes the Undo**

### 3.1 The measured gap

Archiving with `e`, frame by frame:

```
t(ms)   row.leaving   row opacity   toast visible
 38        true          0.53           false
 88        true          0.04           false
121        true          0.00           false     <- row is gone
155        false          —             true      <- toast appears
```

- The row fades and collapses, reaching **opacity 0 at 121ms**.
- The toast appears at **155ms** — a **34ms dead gap**.
- The toast lands at **(641, 834)**; the row was at **(244, 305)**.
  **661px apart**, bottom-right versus upper-left.
- `rowCount: 20 → 19`. **The source is destroyed.**

So the most repeated gesture in the product ends with a thing vanishing in one
corner and an unrelated-looking chip appearing in another, with a third of a
frame of nothing in between.

### 3.2 Why this is the strongest — and why it is unusual

Normally a destroyed source *weakens* a travel. Here it is the **whole point**:

- The row is gone, so there is **no double** — the classic failure of
  shared-element animation (source and clone both visible) cannot occur.
- The toast is not merely *about* the row — it **is** the row's continued
  existence. `Undo` restores exactly that message. "This became that" is
  literally true.
- Triage is almost entirely departure. This is the gesture the user repeats
  more than any other.

The stylesheet already argues this case for the exit animation:

> *"The point of an exit animation is to explain where the gap went, and a fade
> alone does not do that."*

`row-out` explains the **gap in the list**. Nothing explains **where the message
went**. The travel completes a sentence the product already started.

### 3.3 Proposed behaviour

> **The departing row condenses into the toast.**

A body-level ghost — a small chip carrying the sender or subject — is captured
at the row's box as it begins to leave, then travels along a shallow arc to the
toast's position, shrinking and fading as it arrives. The toast's own `toast-in`
begins as the ghost lands, so the toast appears to be *what the row turned
into* rather than a notification that happened to fire.

Deliberately **not** the whole row: a 400×68px rectangle flying across the
screen is a cartoon. A condensed chip reads as the message being *filed*.

Total ≈ 200ms, overlapping the existing 140ms `row-out` — so it adds **no
perceived latency**; it occupies the 34ms of dead air already there.

### 3.4 Feasibility — measured

| concern | measurement |
|---|---|
| Ghost cost | `getBoundingClientRect` ×100 = **0.4ms** (0.004ms each); ghost build **0.2ms** |
| Containment | Row cannot leave `#scroller` (`contain: strict`) → ghost must be `position: fixed` at body level. Standard, and already how overlays work. |
| Layout animation | None — `transform` + `opacity` only |
| Row contract | Untouched; the ghost is not a row and never enters the list |

Costs are negligible. The design question is taste, not performance.

### 3.5 Keyboard / pointer / touch

- **Keyboard (`e`)** — the primary path; the travel is *most* valuable here,
  because the user's eyes are on the list, not on a button they clicked.
- **Pointer** — same, from the toolbar archive control.
- **Touch** — same. No hover dependency anywhere.
- **Bulk archive** — must **not** fire N ghosts. One ghost, or none. This is a
  real edge case and I would ship it as: bulk archive gets no travel.

### 3.6 Reduced motion

The travel is pure decoration over an already-complete state change: the row
still leaves, the toast still appears, Undo still works. Under
`prefers-reduced-motion` the ghost should **not be created at all** — not merely
run at 1ms. Creating and destroying a DOM node to satisfy a media query the
user set against motion is the wrong instinct.

### 3.7 The simpler static alternative, honestly considered

**Move the toast nearer the list, or anchor it under the archived row.** That
removes the 661px gap with zero animation.

I do not recommend it, for a measured reason: the toast is `position: fixed` at
the bottom centre and is shared by **every** transient message in the product
(errors, sync results, send confirmations). Re-anchoring it per-action would
make its position mean different things at different times, which is worse than
a long distance.

But it deserves recording, because a static fix that removes the problem is
usually better than an animation that explains it.

---

## 4 · Candidate B — row subject → reader heading (rejected, with the numbers)

Superficially the textbook case, and the measurements are genuinely attractive:

```
subject in row:    x=268  y=337  13px  weight 600
subject in reader: x=668  y=81   19px  weight 600
travel: dx=400, dy=-256 · identical text · same weight
```

Same string, same weight, a clean 400×256 translation and a 1.46× scale.

**It fails on frequency.** Measured `j` at a fast-but-human repeat rate:

```
gaps: [46.4, 46.2, 44.4, 44.5, 45.9, 45.7, 44.6, ...]
12/12 steps land inside the 200ms window a travel would need
```

Every step arrives in **~45ms**. A 200ms travel would be interrupted **100% of
the time** during normal navigation. `openMessage()` already carries a `rapid`
guard for exactly this — it exists because holding `j` produced a stack of
interrupted 200ms fades.

Adding a heavier, longer, position-dependent animation to the same code path
would reintroduce the defect that guard was written to fix, and worse.

**Also:** the source remains fully visible (the row stays selected, and after
concept #3 it is *bloomed* and more prominent than before). A travel that
leaves its source in place is a **duplicate**, not a transformation — the exact
failure mode I rejected row→reader for in audit 33.

Two independent disqualifications, both measured. Recorded so it is not
proposed a third time.

---

## 5 · Is there a case for doing nothing?

Yes, and it should be stated. Candidate A is the only survivor of five, its
value is real but modest, and its honest description is *"the most repeated
gesture gains a visual thread between cause and effect."*

That is worth doing. It is not worth doing if it costs a frame on the scroll
path — and measured, it does not, because the ghost is outside the list
entirely.

If you would rather bank the wins from #1–#3 and stop, that is a defensible
call and I would not argue hard against it.

---

## 6 · Risks

| risk | mitigation |
|---|---|
| Bulk archive firing N ghosts | One or none. Must be explicit. |
| Ghost outliving a fast second archive | Cancel-and-replace by a single owner, as `closeWithMotion` does |
| Ghost stealing clicks | `pointer-events: none`, non-negotiable |
| Ghost in the a11y tree | `aria-hidden="true"`; the toast already announces |
| Toast repositioned by a future change | Measure at flight time, never hardcode |

---

## 7 · Tests I would write (each sabotage-verified)

1. The ghost is `position: fixed`, `pointer-events: none`, `aria-hidden`.
2. Only `transform`/`opacity` animate.
3. Exactly one ghost exists at a time; bulk archive creates none.
4. Under `prefers-reduced-motion` **no ghost node is created at all**.
5. The ghost is removed on completion — no leak after 50 archives.
6. **Browser-level:** row count, toast text and Undo all behave identically
   with the travel disabled.

---

## 8 · Recommendation

**A — the archived row condenses into the Undo toast.** One ghost, ~200ms,
overlapping the existing exit so it adds no latency, occupying a 34ms dead gap
that exists today, across a measured 661px that currently has nothing
connecting it.

**B is rejected on two measured grounds** (interrupted 100% of the time; source
survives ⇒ duplicate). C, D and E fail because their destinations are hidden or
scrollable.

**Awaiting approval before any code is written.** No #5.
