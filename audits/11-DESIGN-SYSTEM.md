# 11 · Premium UI/UX, motion and design-system audit

**Subject:** BITS Mail Manager at `2c40804`.
**Method:** measurement, not opinion. Every finding below was reproduced with a
script or in jsdom *before* a line was changed, and every fix was verified by
sabotaging it afterwards.

That constraint mattered. Of the eleven things I flagged, **three were false
alarms** — caught because each was checked before being acted on. They are
recorded here rather than deleted, because a design audit that only reports its
hits is not evidence, it is marketing.

---

## What was already right

Worth stating precisely, because a polish pass most often damages things that
were already correct:

- **Radii, type sizes, weights and spacing are fully tokenised.** Zero
  violations across ~3,400 lines. Only *four* line-heights had slipped.
- **All three easing curves** were token definitions; not one inline
  `cubic-bezier` anywhere.
- **`prefers-reduced-motion`** zeroes delay as well as duration — the half
  almost everyone forgets, and without it a reduced-motion user still waits
  450ms watching a stagger they cannot see.
- **Zero transitions animate a layout property.** Of 17 keyframes, exactly one
  does, deliberately.
- **A global `:focus-visible` rule** already covered every interactive element.

---

## The findings

### D-1 · The toast was invisible from half the app — **major**

`z-index` was eight magic numbers assigned per component. The toast sat at
**30**; the timetable panel, help, compose and palette sat at **40–60**.

Nine call sites inside the timetable panel raise toasts — *"Could not save the
timetable"*, *"Added CS F111 L1"* — and **every one rendered underneath the
panel that raised it.** Confirmed with `getComputedStyle` before any fix.

Three unrelated overlays also shared `z60`, so palette-vs-help-vs-timetable
stacking was decided by DOM order rather than intent.

Replaced with a nine-step `--z-*` scale that reads as a story about what may
cover what, gaps of 10 so a tenth surface needs no renumber, and **the toast
last** — the app's only channel for *"that failed"* cannot be occludable.

### D-2 · The focus ring changed the shape of what it focused — **major**

```css
:focus-visible { outline: …; border-radius: var(--r-sm); }
```

That last line applies to the **element**, not the outline. Keyboard-focusing a
pill (`--r-full`) or a panel (`--r-lg`) snapped its corners to 6px — the
component visibly deformed at the moment it most needed to look stable.

Mouse users never saw it. That is how it survived four previous audits.

### D-3 · Six entrance animations used the exit curve — **major**

Found by noticing the *same* `menu-in` keyframe played with opposite easing
depending on which menu opened it. That inconsistency was worth a measurement
rather than a preference, so I sampled both curves:

| curve | progress at halfway |
|---|---|
| `--ease-in` `cubic-bezier(0.4, 0, 1, 1)` | **32%** |
| `--ease-out` `cubic-bezier(0.22, 1, 0.36, 1)` | **96%** |

`ease-in` loiters, then rushes — correct for something *leaving*, wrong for
something arriving, where it reads as a hang followed by a lurch. Six entrances
used it: palette, compose, toast, theme menu, reader swap, timetable search.
**Every overlay in the app except two opened with the wrong curve.**

### D-4 · Disabled controls were indistinguishable from enabled ones — **major**

Measured: an enabled and a disabled `.primary` computed to the same opacity,
the same background, and `cursor: pointer` for both.

Four controls disable at runtime — Sign in, Send, Load more, finalise — and all
four went on looking fully clickable. During a slow send the user clicks Send
again, nothing happens, and they conclude the app is broken. Only
`.att-chip:disabled` had ever been styled.

`pointer` on something unpressable is the specific lie: the cursor is the
fastest affordance signal there is, and it was pointing the wrong way.

### D-5 · Overlays scrolled the page behind them — **moderate**

Nine scroll containers, **none** with `overscroll-behavior`. Reaching the
bottom of the palette, help sheet or timetable panel handed the rest of the
gesture to the document underneath, so the mail list slid away while the user
was reading the dialog.

Eight are now contained. `.err` is left alone — a small inline box in the gate,
not an overlay; containing it would be cargo-culting.

### D-6 · Two hit targets were far under any guideline — **moderate**

`.r-check` (the row selection checkbox) at **15×15**, and `.view-remove` at 1px
of padding. Both sit beside other controls and both do something consequential.

The **visual** size is unchanged — a 24px checkbox in a mail row would be a
heavy dot competing with the subject line. The **target** grew instead. What a
control looks like and what it catches are different things.

### D-7 · Two fields whose only label vanished when you typed — **moderate**

The compose body and the palette input were named by placeholder alone. A
placeholder is not a label: it disappears on the first keystroke, so anyone
tabbing back into a half-written message has nothing telling them what the
field is.

### D-8 · Four line-heights bypassed the scale — **subtle**

Including `1.55`, which *is* `--lh-body`. The compose textarea's `1.6` was a
genuinely different intent — text you *write* wants a looser measure than text
you *read* — so it became `--lh-compose` rather than being flattened into the
nearest existing step.

---

## The one deliberate cost

`row-out` animates `max-height`, which forces layout each frame, and it fires
on the most frequent action in the product.

**Kept.** The collapse *is* the message: without it the row fades in place and
the rows below jump up in a single frame. The point of an exit animation is to
explain where the gap went, and a fade alone does not. Bounded to one row,
140ms, `overflow: hidden`; the list render was measured at 8.1ms for 2000 rows,
so this is not the expensive part.

This is the case the brief describes — a minor performance cost buying a
noticeable gain in perceived quality — and it is now pinned by a test as the
**sole** exception, so a second one cannot appear without someone making that
call again.

---

## What I got wrong

### F-1 · "27 elements have `:hover` but no `:focus-visible`"

There is a **global** `:focus-visible` rule. All 27 were covered. Checking that
claim is what surfaced D-2, so the false alarm was still productive — but the
finding as stated was wrong.

### F-2 · "Five inputs are unlabelled"

Three (To, Cc, Subject) are wrapped in `<label>`. My probe only looked for
`label[for=…]`. The test now checks `closest('label')` too, so nobody later
"fixes" the wrapping form on the strength of a naive check.

### F-3 · "`toast-drain` is an unused keyframe"

Applied from JS with an inline animation string. Static scanning cannot see it.

### F-4 · A bug in my own test, not in the code

The disabled-state test used `/(?:^|\})…:disabled…/` to find rules. That prefix
**consumes** the previous rule's closing brace, so with two adjacent `:disabled`
rules the first match ate the second's selector — and the test reported a rule
that plainly existed as missing. I went looking at the CSS before questioning
the regex. It splits on `}` now.

### F-5 · A flaw my own fix introduced

Giving `.view-remove` a 24px target widened a slot that is only occupied on
hover, so the row **twitched under the cursor**. Caught by measuring after the
change rather than assuming it was safe. Both states of the slot now reserve
the same width.

*A fix that introduces a jitter is not a fix.*

---

## Standing invariants added

Six new tests, each sabotage-verified in both directions where a
too-eager and a too-lazy implementation are both wrong:

- every `z-index` comes from `--z-*`, and the toast outranks every overlay
- `:focus-visible` never overrides the radius of what it focuses
- type, weight, leading and easing all come from tokens
- every pointer target reaches 24px, and the saved-view slot cannot twitch
- entrances decelerate; only exits accelerate
- scrollable overlays contain their scroll
- exactly one keyframe may force layout

---

## What I did not do

**Nothing here has been seen in a browser.** jsdom has no layout engine and no
compositor, so every claim above is about *declared* values, not painted
pixels. Frame rate, shadow softness, subpixel rendering, scroll inertia and
perceived weight — a large part of what the brief asks about — cannot be
audited from here at all.

The honest summary: this pass fixed the class of defects that is **measurable
without a renderer**, and found a lot of them. The class that needs eyes on
glass remains untouched.
