# Audit 24 — Motion System

Not "add more animation". The question is whether the motion in this product
behaves like **one designed system** or like twenty-four independent decisions
that happen to share a token file.

## Method

The stylesheet parsed into a rule table, then every `animation` declaration
extracted with its keyframe, duration and easing, and every `@keyframes` block
decomposed into its transform and opacity tracks. That produces a table of what
each surface actually does — which is what makes the *system* questions
answerable rather than impressionistic.

## The system as it stands

**24 animated surfaces, 17 keyframes, 4 easings, 4 durations.** All tokenised;
no hardcoded timings anywhere except three deliberate long-running loops
(`sk-shimmer` 1.35s, `sweep` 1.1s).

The direction language is already coherent and worth stating, because the
findings below are deviations from it:

| Distance | Used by | Meaning |
|---|---|---|
| `-3px` / `-4px` | `note-in`, `menu-in` | attached to something above |
| `6px` / `7px` | `empty-in`, `swap-in`, `row-in`, `ctx-in` | content settling into place |
| `8px` | `palette-in`, `tt-in` | overlay arriving |
| `14px` / `16px` | `toast-in`, `compose-in` | large surface entering from off-screen |

Distance scales with the weight of the thing moving. That is a real system.

**Reduced-motion is handled correctly and completely** — `animation-duration`,
`transition-duration`, `animation-iteration-count` *and* `animation-delay` are
all neutralised. The delay is the half most implementations forget, and the
comment in the stylesheet explains exactly why it matters: zeroing duration
alone leaves a reduced-motion user waiting 450ms watching staggered rows
appear, which reads as the app being slow rather than as an effect.

**`--ease-spring` is used with discipline** — four places, all arrivals
(`ctx-actions`, `bulkbar`, `toast`, `star-pop`), never a departure.

---

## MO-1 · Twenty-three surfaces animate in; one animates out — **systemic**

**What is weak.** Of 17 keyframes, exactly **one** is an exit: `row-out`. Every
overlay in the product — palette, help, compose, menus, gate, toast — closes by
setting `hidden = true`, which is an instantaneous vanish.

**Where.** `layers.js` tears down through `teardown()`; `palette.js` and
`compose.js` both set `.hidden = true` directly.

**How it feels now.** Asymmetric in a way users feel without naming. A surface
eases in over 200ms establishing that it is a *thing that arrived*, then
disappears between two frames. The eye tracks the arrival and is given nothing
to track on the way out, so the close reads as a glitch rather than a
dismissal — particularly on Escape, where there is no pointer near the surface
to explain what happened.

**What it should communicate.** That the overlay went *back* where it came
from, and that the surface underneath is being returned to the user. An exit
is the sentence's full stop.

**Timing / easing change.** Exits should be **faster than entrances and use a
different curve**. An entrance is `--dur-base` on `--ease-out` because arriving
should decelerate into place; an exit should be `--dur-fast` on `--ease-in`,
accelerating away. Reversing the entrance curve is the common mistake — it
makes the surface hesitate before leaving, which feels sticky.

`--ease-in` currently has **two** uses in the whole stylesheet, both on the busy
sweep. It is the exit curve and it is essentially unused, which is itself the
tell.

**Importance: high.** It is the single largest gap between this motion system
and a designed one.

**Systemic.**

---

## MO-2 · `#toast` declares two different easings for the same animation

**What is weak.** `#toast` is animated twice, in two blocks, with two curves:

```
line 2020:  animation: toast-in var(--dur-base) var(--ease-out) both;
line 2825:  animation: toast-in var(--dur-base) var(--ease-spring) both;
```

Later wins, so the toast springs. The first declaration is dead — but a reader
of line 2020 has no way to know that, and either curve is defensible, so the
*intent* is unrecoverable from the file.

**Where.** Every toast: send confirmation, undo offer, every error.

**How it feels now.** Fine, by accident. The surviving spring is the right
choice for a toast, which is an arrival that should feel like it landed.

**What it should communicate.** One decision, once. This is the same class of
defect as the two `.rail-heading` specifications in audit 21 — two authors, one
element, and the reader cannot tell which is current.

**Change needed.** Delete the dead declaration and state why the spring is
correct.

**Importance: medium** — no visual change, but it is a correctness bug in the
system's legibility.

**Local**, though `#reader.swap` is also declared twice (identically, so it is
harmless duplication rather than a contradiction).

---

## MO-3 · The help overlay slides down from above while being vertically centred

**What is weak.** `#help` is `display: grid; place-items: center` — a centred
dialog. It reuses `palette-in`, which starts at `translate3d(0, -8px, 0)` and
settles downward.

That curve is correct *for the palette*, which is anchored at `padding-top:
14vh` and genuinely hangs from the top of the viewport. A centred dialog moving
downward is anchored to nothing.

**Where.** Pressing `?`.

**How it feels now.** Slightly untethered. The panel arrives from a direction
that does not correspond to anything on screen.

**What it should communicate.** That the dialog materialised *in place*,
because that is what a centred modal does. `gate-in` is exactly this — opacity
only, no translate — and `#gate` is the other centred surface in the product.

**Change needed.** Use `gate-in`, not `palette-in`. Same family, correct
anchor.

**Importance: medium.** **Local — and it is drift I introduced in audit 23**,
where I fixed the help overlay popping in by reaching for the nearest
animation without checking that its anchoring matched.

---

## MO-4 · `tt-in` is the only keyframe that does not use `translate3d`

**What is weak.** Sixteen keyframes use `translate3d(...)`. One uses
`translateY(8px) scale(0.995)`.

**Where.** The timetable panel.

**How it feels now.** Indistinguishable to the eye in isolation — but
`translate3d` promotes the element to its own compositor layer and `translateY`
may not, so the timetable panel is the one large surface that can animate on
the main thread and jank under load. It is also the largest surface in the app.

**What it should communicate.** Nothing different. This is a consistency and
performance fix, not a feel change.

**Change needed.** `translate3d(0, 8px, 0) scale(0.995)`.

**Importance: low-medium.** **Local**, but on the surface where a dropped frame
is most visible.

---

## MO-5 · The reader swap animates content arriving but nothing acknowledges what left

**What is weak.** `swap-in` fades and lifts the new message into place over
`--dur-base`. The outgoing message is replaced synchronously.

**Where.** `j`/`k` between messages, and clicking a different row.

**How it feels now.** Good, actually — better than most clients. The gap is
narrow: during rapid `j`/`k` the animation restarts on each keypress, so
holding the key produces a stack of interrupted 200ms fades that never
complete. The reader flickers rather than settling.

**What it should communicate.** Under rapid navigation the *content* matters and
the transition does not. A user pressing `j` five times wants to arrive, not to
watch five fades.

**Change needed.** This is an **interruption** problem, which the brief asks
about specifically. The fix is not a longer animation — it is to skip the swap
when the previous one has not finished, so rapid navigation is instant and a
deliberate single step still animates.

**Importance: medium.** **Local**, but on the most-repeated interaction in the
product.

---

## MO-6 · No surface declares `will-change`, including the two that animate transform on every keystroke

**What is weak.** Zero uses of `will-change` in 4,600 lines.

**Where.** Most relevant on `#reader.swap` (fires on every `j`/`k`) and
`.row.leaving` (fires on every archive).

**How it feels now.** Almost certainly fine. `translate3d` already triggers
layer promotion in every current engine, which is why this is listed last and
marked low.

**What it should communicate.** Nothing — this is purely a smoothness
insurance policy.

**Change needed.** Arguably none. Recorded because the brief asks about
performance under motion, and because the *reason* it is safe (translate3d
promotes) is worth writing down so nobody "optimises" the transforms into
`translateY` later and quietly loses it. MO-4 is that risk already realised
once.

**Importance: low — recommend NOT fixing.** Adding `will-change` to surfaces
that are already promoted costs memory and gains nothing measurable. Listed for
completeness and deliberately declined.

---

## Checked and found sound

| Question the brief asks | Finding |
|---|---|
| Reduced motion respected? | ✅ duration, iteration **and delay** all neutralised |
| Entrance easing correct? | ✅ `--ease-out` on 24 of 24 entrances |
| Spring used appropriately? | ✅ 4 uses, all arrivals, never departures |
| Timing matches importance? | ✅ `instant` 90ms cursor feedback → `slow` 300ms gate |
| Distance matches weight? | ✅ 3px attached → 16px large surface entering |
| List insert/remove? | ✅ `row-in` staggered, `row-out` with a 260ms settle before counting |
| Stagger bounded? | ✅ capped so the last item does not read as lag |
| Menu anchoring? | ✅ `menu-in` −4px, correct for a dropdown |
| Toast stacking? | ✅ single toast, re-fire restarts the drain via forced reflow |
| Loading state? | ✅ shimmer, plus a topbar sweep for busy |
| Academic surfaces louder than mail? | ✅ no — `tt-in` is the same `--dur-base`/`--ease-out` as the mail surfaces, and the timetable is behind `T` |

**On the identity rule:** the timetable panel uses the same duration and easing
as the mail panels and is not more animated than them. MO-4 makes it *more*
consistent, not more prominent. No finding.

## Priority

| # | Finding | Scope | Priority |
|---|---|---|---|
| MO-1 | No exit animations anywhere | systemic | **high** |
| MO-2 | `#toast` has two contradictory easings | local | medium |
| MO-3 | Centred dialog slides from above | local | medium |
| MO-5 | Reader swap flickers under held `j`/`k` | local | medium |
| MO-4 | `tt-in` misses compositor promotion | local | low-medium |
| MO-6 | No `will-change` | systemic | **declined** |

---

## Applied

Five of six. MO-6 was declined on measurement, not skipped.

| # | Change |
|---|---|
| MO-1 | Four exit keyframes + `closeWithMotion`/`cancelExit` in `layers.js`, wired into palette, help, compose and toast |
| MO-2 | Dead `#toast` declaration removed; the spring is now the only one |
| MO-3 | `#help` uses `gate-in` (opacity) instead of `palette-in` (slides down) |
| MO-4 | `tt-in` → `translate3d`; **and `sk-shimmer`, which the new guard caught** |
| MO-5 | Reader swap skips its animation when the last one was under 200ms ago |
| MO-6 | **Declined** — `translate3d` already promotes; `will-change` would cost memory for nothing measurable |

**1262 tests pass.** Eight motion guards added, **all sabotage-verified**.

### The exit animation was wrong twice before it was right

Worth recording in full, because the suite did the correcting both times.

**First attempt — menus.** I gave `.snooze-menu` an exit by deferring
`node.remove()` for 140ms. Four tests failed instantly:
`querySelector('.snooze-menu')` still found the closing menu, so by every
observable measure it was still open.

The tests were encoding a real contract, not an implementation detail. A menu
still in the DOM is one an outside click can hit and a screen reader will
announce. I tried making it inert while fading — `aria-hidden`,
`pointer-events: none` — and then **reverted the whole thing**. For the one
surface users dismiss by clicking elsewhere, "closed" and "gone" should not
come apart. Menus now close instantly, and that is documented as a decision
rather than an omission: `menu-in` is `--dur-fast` from −4px, small and quick
enough that its absence on exit is not felt.

**Second attempt — overlays.** I deferred `hidden = true` until
`animationend`. Two more tests failed:
`assert.equal(help.hidden, true)` after Escape.

Again the tests were right. `hidden` is the *observable state* of an overlay —
Escape handling, focus restoration and outside-click dismissal all key off it.
Deferring it means that for 140ms the overlay reports itself as open, and a
second Escape during the fade unwinds the wrong surface. **Motion is
presentation; state does not wait for it.** `hidden` now lands two frames in,
which is enough for the exit to start and short enough that nothing can
observe the gap.

### A guard I wrote found a bug I had not looked for

The `translate3d` check was written for `tt-in`. It immediately failed on
**`sk-shimmer`** — which I had missed because I only inspected entrance
keyframes, and which runs *infinitely* on every skeleton row. It is the
animation where compositor promotion matters most in the whole product.

### Deliberately not done

- **`will-change`** (MO-6). Declined on measurement: `translate3d` already
  triggers layer promotion, so adding it costs memory and gains nothing. The
  reasoning is written into the audit so nobody re-derives it.
- **Menu exits** — reverted, see above.
- **No new tokens, durations or easings.** Every exit reuses `--dur-fast` and
  `--ease-in`, the curve that existed with two uses precisely because there
  were no exits to put it on.
