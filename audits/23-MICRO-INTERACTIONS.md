# Audit 23 — Micro-Interactions

Not a motion-design brief. One question throughout: **does the interface
acknowledge the user at the moment they act, and does it do so consistently?**

The goal is not more motion. Three of the seven findings below are *one
declaration each*, and none adds a new animation to a surface that did not
already have a peer with one.

## Method

Measured from the stylesheet parsed as a rule table, cross-referenced against
the markup and the JS that binds handlers:

- **State coverage** — every clickable surface checked for `:hover`,
  `:active` and a `transition`.
- **Drift** — surfaces that do the same job compared against each other. A
  finding is only a finding if a *peer* already does it better.
- **Reachability** — `.tag` and `.lane-head` were excluded after checking the
  JS: neither binds a handler, so neither needs press feedback.

## What the audit found already strong

Worth stating plainly, because this product is further along than most on this
axis and the findings are narrow as a result.

**17 keyframes, a four-step duration scale and four easings**, all tokenised:
`--dur-instant: 90ms` for feedback under the cursor, `--dur-fast: 140ms` for
small state changes, `--dur-base: 200ms` for panels, `--dur-slow: 300ms` for
full-surface transitions. Nothing hardcodes a duration.

**The moments that matter most are already handled.** Starring pops
(`star-pop`, spring-eased). A row leaving animates out before the store drops
it (`row-out`), and the list waits 260ms for it. The reader cross-fades between
messages (`swap-in`). The toast has a draining progress line that restarts
correctly on re-fire. The busy state sweeps a gradient across the topbar. The
skeleton shimmers rather than sitting still.

**Focus is complete** — one global `:focus-visible` with four deliberate
overrides where the default outline would clip.

**`--ease-spring` is used with restraint** — four places, all of them
*arrivals* (`ctx-actions`, `bulkbar`, `toast`, `star-pop`), never departures.
That is the correct instinct: a spring on something leaving reads as a glitch.

---

## M-1 · 45 of the 48 buttons in the product snap instead of transitioning — **systematic**

**What feels weak.** `.ghost` — the class on every toolbar action, every reader
action, Cc/Bcc, Attach, Save draft, Template, Sign out, Back to Gmail — changes
**three properties on hover** and has **no `transition`**:

```css
.ghost:hover { color: …; border-color: …; background: …; }   /* all instant */
```

**Where.** Everywhere. Measured from the markup: **45 `.ghost` buttons versus 3
`.primary`**. This is the dominant control in the product.

**What the user currently feels.** A hard flick between two states. Not
"broken" — just cheap. The cursor crosses a boundary and three colours change
in the same frame, which reads as a redraw rather than a response.

**The drift is the proof.** Its peers all have one:

| Class | Transition |
|---|---|
| `.primary` | background, box-shadow, transform |
| `a.ghost` | background-color, color, border-color |
| **`button.ghost`** | **none** |

`a.ghost` and `button.ghost` are the *same visual control* — one happens to be
a link. One fades, the other snaps. Nobody chose that.

**What feedback is missing.** The 90ms colour settle every other interactive
surface in the app already has.

**How it should feel.** Identical to `a.ghost`, because it is the same control.
The cursor arrives, the button warms up over `--dur-instant`, and leaving fades
back.

**Fix size: subtle** — one declaration, copied from the link rule.
**Isolated or systematic:** systematic, and the single highest-leverage change
in this document. One rule improves 45 controls.

---

## M-2 · Read → unread is the app's most frequent state change and it has no transition

**What feels weak.** Opening an unread message changes the row's background,
the subject's colour *and* weight, the sender's colour *and* weight, and the
category dot's scale — all in one frame, with no easing on any of it.

**Where.** Every message row, every time a message is opened or marked read.
This fires more often than any other visual change in the product.

**What the user currently feels.** The row "blinks" into its read state. The
information is correct and the delivery is abrupt — and because the change is
*so* multi-property, the snap is more noticeable than a single colour swap
would be.

Measured: `.row` transitions `background-color` only. `.row.unread .r-subj`,
`.row.unread .r-from` and the weight changes have **no transition at all**.

**What feedback is missing.** The row is currently telling the user "this is
now read" with no sense that it *became* read. The state change should read as
a settling, not a repaint.

**How it should feel.** The colour eases over `--dur-fast` while the weight
change lands immediately — font-weight cannot be interpolated smoothly and
attempting it causes reflow jitter, so colour carries the motion and weight
just arrives underneath it.

**Fix size: subtle** — a transition on `.r-subj` and `.r-from` for `color`
only, deliberately *not* on `font-weight`.

**Systematic**, but confined to one component.

---

## M-3 · Four surfaces I built last cycle have no entrance animation, while their peer does

**What feels weak.** `#radar-list .radar-item` animates in with `row-in`. The
four rail and list surfaces added in the wiring pass do not:

| Surface | Entrance |
|---|---|
| Radar item | `row-in` ✅ |
| **Outbox row** | none |
| **Snoozed row** | none |
| **Notice card** | none |
| **Suggestion row** | none |

**Where.** The sidebar, and the dropdown under the search field.

**What the user currently feels.** Sections appear fully formed between one
frame and the next. The outbox is the worst of the four: it materialises
*because the user just pressed Send*, so it is the one moment where the
appearance is a direct answer to an action — and it arrives with no motion at
all, while the toast beside it springs in.

**What feedback is missing.** The connection between the action and the new
surface. A section that fades up reads as *caused*; one that pops reads as
having always been there and simply not drawn yet.

**How it should feel.** Exactly like the radar, because they are the same kind
of thing — a rail list gaining rows. Reusing `row-in` rather than authoring
anything new is the point.

**Fix size: subtle.** One selector added to the existing `row-in` rule.

**Systematic** — and it is *drift I introduced*. The wiring pass added surfaces
and matched their layout to the existing ones without matching their motion.

---

## M-4 · The shortcuts overlay pops in while every other overlay animates

**What feels weak.** `#help-box` has no entrance animation. Its four peers all
do:

| Overlay | Entrance |
|---|---|
| `#palette-box` | `palette-in` |
| `#compose` | `compose-in` |
| `#gate` | `gate-in` |
| `.snooze-menu` | `menu-in` |
| **`#help-box`** | **none** |

**Where.** Pressing `?`.

**What the user currently feels.** A full-screen panel appears instantly over
the mail. Because every other overlay in the app eases in, this one reads as a
different, cruder surface — and it is the screen a new user is most likely to
open first.

**What feedback is missing.** The sense that the panel came *from* the
keypress. An instant full-screen change is momentarily disorienting because
nothing connects the before and after.

**How it should feel.** Like the palette, which is the closest analogue — a
centred overlay opened by a keystroke.

**Fix size: subtle.** One `animation` line reusing `palette-in`.

**Isolated.**

---

## M-5 · Three list rows respond to hover but not to the click

**What feels weak.** `.suggest-item`, `.outbox-item` and `.snoozed-item` have
no `:active`. `.rule-row` has neither hover nor press.

**Where.** The search dropdown, and the two new rail sections.

**What the user currently feels.** On a trackpad, the gap between press and
result is where an interface feels either responsive or laggy. Hover says "this
is clickable"; `:active` says "I heard you". Without it a slow action reads as
a missed click, and the user clicks again.

`.suggest-item` is the one that matters most: accepting a suggestion runs a
query, which re-renders the whole list. That is the longest gap of the three
and it currently has nothing covering it.

**What feedback is missing.** The press acknowledgement that `.cat`,
`.palette-item`, `.snooze-opt`, `.radar-item` and `.tag` all already have.

**How it should feel.** The same `scale(0.985)` idiom used everywhere else —
not a new treatment, the existing one applied to the rows that were missed.

**Fix size: subtle.** One rule, three selectors.

**Systematic** — same class of omission as M-3, from the same pass.

---

## M-6 · The row checkbox is the only control with no press feedback

**What feels weak.** `.r-check` has a transition and a focus ring but no
`:hover` and no `:active` of its own.

**Where.** The tick on every message row — the entry point to every bulk
operation.

**What the user currently feels.** Selecting messages for a bulk action is a
*repetitive* gesture: ten, twenty rows in sequence. It is exactly the
interaction where per-click acknowledgement compounds, and it is the one
control that gives none.

The row beneath it does respond, so there is feedback — but it is the row's,
not the checkbox's, and when clicking precisely on a small target that
distinction is felt.

**What feedback is missing.** A press state on the tick itself.

**How it should feel.** The same scale-press as the star beside it, which is
its direct sibling in both position and purpose.

**Fix size: subtle.**

**Isolated.**

---

## M-7 · Bulk actions acknowledge nothing until they finish

**What feels weak.** `bulkAct()` mutates the store optimistically, sends one
batched request, and shows a toast only on completion or failure. Between
pressing "Archive 40" and the request settling there is **no indication that
anything is happening**.

**Where.** The bulk bar, on any selection large enough to be slow.

**What the user currently feels.** For a handful of messages this is invisible
and fine — the rows leave instantly. For forty over campus wifi, the rows leave
instantly *and then nothing happens* for a second or more. The optimistic
update is doing its job so well that it hides the fact that work is still in
flight, and a user who then closes the tab loses the operation.

**What feedback is missing.** Any signal that a request is outstanding.

**How it should feel.** The app already has exactly the right idiom and does
not use it here: `#shell[aria-busy='true']` sweeps a gradient across the
topbar. Bulk actions should raise the same busy state they already raise for a
sync, so a long operation is visible in the place the user already looks.

**Fix size: subtle** — set and clear an attribute that already drives an
existing animation.

**Isolated**, but it covers the operation with the largest blast radius.

---

## Deliberately not changed

- **`.tag` and `.lane-head`** were flagged by the state probe and then excluded:
  checking the JS shows neither binds a handler. Press feedback on something
  that is not pressable is a lie about affordance.
- **`.row` has no `:active`.** It looks like an omission and is not — the
  comment in the stylesheet explains that a transform on the row fights
  `content-visibility` and forces the compositor to retain off-screen layers.
  A measured performance decision; left alone.
- **No new easings, durations or keyframes.** Every fix below reuses
  `--dur-instant`, `--dur-fast`, `row-in`, `palette-in` or the existing
  `scale(0.985)` press.

## Priority

| # | Finding | Reach | Fix | Priority |
|---|---|---|---|---|
| M-1 | `.ghost` has no transition | **45 controls** | 1 declaration | **highest** |
| M-2 | Read/unread snaps | most frequent change | 1 rule | **high** |
| M-3 | 4 new surfaces don't animate in | 4 surfaces | 1 selector list | high |
| M-5 | 3 rows have no press state | 3 surfaces | 1 rule | medium |
| M-7 | Bulk actions show no progress | largest blast radius | 2 lines | medium |
| M-4 | Help overlay pops in | 1 surface | 1 line | medium |
| M-6 | Row checkbox has no press | 1 control | 1 rule | low |

---

## Applied

All seven. **1254 tests pass; all six themes still meet WCAG AA.**

| # | Change | Reach |
|---|---|---|
| M-1 | `.ghost` gains the transition `a.ghost` already had | **45 buttons** |
| M-2 | `.r-subj` / `.r-from` ease colour on read/unread — never weight | every row |
| M-3 | Outbox, snoozed, notices and suggestions reuse `row-in` | 4 surfaces |
| M-4 | `#help-box` reuses `palette-in` | 1 overlay |
| M-5 | `:active` on suggestion, outbox and snoozed rows | 3 surfaces |
| M-6 | `:active` on `.r-check` | the bulk-select tick |
| M-7 | Bulk ≥10 raises `aria-busy`, cleared in `finally` | bulk path |

Nothing new was authored: every fix reuses an existing token, keyframe or press
idiom. Five drift guards were added to `package.test.mjs` and **all five were
sabotage-verified** — each fails when its fix is reverted.

### Three things went wrong while applying this, and all three were caught

**The duplicate-selector guard rejected my first attempt at M-5.** I added a
grouped `.suggest-item, .outbox-item, .snoozed-item` rule without checking
whether those classes already had blocks. Two of them did. Folded into the
existing rules instead — which is exactly what that guard exists to force.

**Two of my own new tests were wrong**, and both reported false failures rather
than false passes, which is the safe direction:

- The rail-entrance test regexed over raw text and could not see a selector
  reformatted across lines.
- The overlay test built its pattern from the selector string and could not
  match `.snooze-menu`, reporting a surface that *was* animated as missing.

Both now parse the stylesheet into a rule table and check the property. The
lesson is the one this project keeps relearning: **a check that pattern-matches
source text is testing the formatting, not the behaviour.**

### What was deliberately left alone

- **`.row` still has no `:active`.** The stylesheet explains why — a transform
  there fights `content-visibility` and forces the compositor to retain
  off-screen layers. A measured performance decision, not an oversight.
- **`.tag` and `.lane-head`** were flagged by the state probe and excluded
  after checking the JS: neither binds a handler. Press feedback on something
  unpressable is a lie about affordance.
- **Bulk under 10 messages raises nothing.** The rows leave instantly and the
  request settles before a busy indicator would finish appearing; showing one
  would be a flicker.
