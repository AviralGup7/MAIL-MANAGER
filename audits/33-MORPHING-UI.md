# Audit 33 — Morphing UI

Wow-animation concept **#1 of N**. Design only. **No code written.**

Question asked: *where in this product does one UI representation already turn
into another, but is implemented as a disappear-and-reappear?*

---

## 1 · Method

I did not look for places to add an animation. I looked for **pairs of surfaces
that are the same thing in two states** and then checked how the transition is
currently implemented. A morph is only honest where the two states genuinely
share an identity; anywhere else it is a special effect.

Search: every `hidden = ` assignment in `src/app/` (**65 sites**, 17 distinct
elements), plus every `display: none` toggle in `app.css`.

The filter that killed most candidates: **does the outgoing surface still exist
on screen after the change?** If yes, the second surface did not *become* the
first — they coexist, and a morph would be a lie.

---

## 2 · Candidates considered

| # | Pair | Current transition | Verdict |
|---|---|---|---|
| **A** | `#listhead` ⇄ `#bulkbar` | both `hidden`-toggled; bulkbar gets `bulk-in` (translate −6px) | **STRONGEST — recommended** |
| B | `.row` → `#reader` | reader gets `swap-in` (translate 6px) | Rejected — both stay visible |
| C | `#compose` ⇄ `#compose.minimised` | `display: none` on body+foot, instant | Real defect, ranked #2, own round |
| D | `.view-count` ⇄ `.view-remove` | `display` swap on hover | Already slot-stable; too small to carry |
| E | `#search` ⇄ `#search-suggest` | suggest is a panel below | Not the same object |
| F | `.r-star` empty ⇄ filled | `star-pop` keyframe | Already a morph, already good |
| G | `#empty` ⇄ `#list` | `hidden` toggle + `empty-in` | Genuine pair, but low frequency |

### Why B (row → reader) is rejected, in detail

This is the obvious "wow" answer and it is wrong here.

1. **The panes are side by side.** `#panes` is
   `grid-template-columns: minmax(300px, 400px) 1fr` — the list does not go
   away when the reader opens. A row that flies rightward and becomes the
   reader would leave its own copy behind in the list. That is not a morph,
   it is a duplicate.
2. **The row cannot leave its box.** `.row` carries
   `contain: layout paint style` and `content-visibility: auto`. Paint
   containment *clips*; a row cannot render outside its own bounds, so a FLIP
   would need a cloned ghost `position: fixed` at the shell level. Buildable,
   but it is 60+ lines of measurement code on the hottest path in the product
   to animate something that is not conceptually happening.
3. **`openMessage()` already had to defend against this class of motion.** The
   `rapid` guard (`now - lastSwapAt < 200`) exists because holding `j`
   produced a stack of interrupted swaps. A heavier row→reader morph would
   make that failure mode worse, not better.

Recording B here rather than deleting it, because it will be proposed again.

---

## 3 · The recommendation: **A — the list header becomes the bulk bar**

### 3.1 What it is today

```html
<div id="listhead">      <span id="listtitle">Inbox</span> <span id="listcount">…</span> </div>
<div id="bulkbar" hidden> [✓] <span id="bulk-count">3 selected</span> [actions…] [×] </div>
```

```js
el.bulkbar.hidden = n === 0;
el.listhead.hidden = n > 0;
```

Two siblings in the `#listpane` flex column, above `#scroller`. One is deleted
from layout, the other is inserted, in the same frame.

### 3.2 Why this is the strongest candidate

**It is already trying to be a morph and says so in the source.** `app.html`:

> *"Replaces the list header rather than sitting beside it. A bar that appears
> in addition to the header pushes the list down and costs a reflow of
> everything below; swapping in place keeps the rows exactly where the user's
> eye already is."*

The intent is stated. The implementation is a hard cut.

**The two bars share a real structure.** Not a coincidence — the same three
slots, in the same order:

```
listhead:   [ —         ]  Inbox · 214        [ —                    ]
bulkbar:    [ ☑ select  ]  3 selected         [ actions        ] [ × ]
             LEFT           CENTRE LABEL        RIGHT
```

The **centre label is the same element doing the same job**: it states what
this list currently is. `Inbox · 214` → `3 selected` is one sentence changing
tense, in the same place, at the same size. That is the definition of a morph
and it is being thrown away.

**It is high frequency and it is a mode change.** Entering multi-select is the
only modal state in the list. A hard cut gives the user no signal that they
have *entered a mode* — which is exactly the confusion a morph resolves.

### 3.3 The defect I found while auditing it — the bar is NOT the same height

The comment above claims the swap keeps the rows still. Computed from the
cascade, it does not:

| | padding | tallest child | border | **total** |
|---|---|---|---|---|
| `#listhead` | `--s-2` = 8px ×2 | `#listtitle` `--t-md` 13px × 1.45 lh ≈ **18.9px** | 1px | **≈ 35.9px** |
| `#bulkbar` | `--s-2` = 8px ×2 | `.ghost.small`: 12px × 1.45 + `--s-1`×2 + 2px border ≈ **27.4px** | 1px | **≈ 44.4px** |

**≈ 8.5px of jump, every time the first row is ticked**, and again when the
selection is cleared. In comfortable density that is 12.5% of a row height —
the list nudges under a cursor that is mid-triage, aiming at the *next*
checkbox.

> ⚠️ **These are computed from the stylesheet, not rendered.** jsdom does no
> layout and there is no Chrome in this sandbox (`which google-chrome` → empty),
> so I cannot confirm the exact numbers here. The *sign* of the difference is
> certain — `.ghost.small` buttons are unambiguously taller than a single 13px
> line — the magnitude is not. **Locking the container height must wait for a
> real measurement**, exactly as the 68px signature plate did. I am flagging
> this rather than picking a number, because guessed thresholds have been wrong
> in this codebase before.

So the morph is not decoration. **It fixes a layout jump that the source
comment claims does not exist.**

---

## 4 · Proposed animation — "the header takes over"

### 4.1 Structure (the part that does the real work)

Wrap both bars in one container of **fixed** height and position them
absolutely inside it:

```
#listbar            position: relative; height: <MEASURED>px; flex: none;
  #listhead         position: absolute; inset: 0;
  #bulkbar          position: absolute; inset: 0;
```

Consequences:

- **The scroller top never moves.** The 8.5px jump is gone in both directions,
  for keyboard, mouse and `Escape`.
- Nothing about the transition animates layout, so it does not touch the
  forbidden-property rule in `test/package.test.mjs`
  (`width height max-height top left right bottom margin padding font-size`).
- It works with motion fully disabled. At `prefers-reduced-motion` the global
  1ms override makes it an instant swap **with no jump** — strictly better than
  today.

### 4.2 The motion

Four elements, staged, all `transform` + `opacity` + `color` only.

| element | in (select) | out (clear) |
|---|---|---|
| **centre label** | **does not fade.** `color` `--fg-faint` → `--accent`, `--dur-fast` linear. It is the same sentence; it must not blink. | reverse |
| **left checkbox** | `scale(0.6) → 1` + opacity, `--dur-fast` `--ease-spring`, delay 0 | `--dur-fast` `--ease-in`, no delay |
| **right actions** | `translate3d(8px,0,0) → 0` + opacity, `--dur-fast` `--ease-out`, delay **40ms** | `--dur-fast` `--ease-in`, no delay |
| **bar background** | `--bg` → `--accent-soft`, `--dur-fast` linear | reverse |
| **`#listtitle` + `#listcount`** | fade out, `--dur-instant`, no movement | fade in |

Total in ≈ **180ms** (140 + 40 delay). Out ≈ **140ms**, no stagger — per the
existing exit doctrine in the stylesheet: *exits are `--dur-fast` and
`--ease-in`, and are not the entrance reversed.*

Every duration and easing is an existing token. **No new token is required**,
which is the test the design-system check applies.

### 4.3 What the user should perceive

> *"The header I was already looking at picked up a checkbox and some buttons."*

Not *"a blue bar appeared."* The centre label is the pivot: it is the only
thing that never fades, so the eye stays locked to one point while the two ends
of the bar populate around it. That is what makes it read as one object
changing state instead of two objects trading places.

The 40ms delay on the actions is doing something specific: it makes the
**checkbox arrive first**, which is the causal order — you ticked something,
*therefore* there are now actions. Simultaneous arrival reads as a panel; the
stagger reads as a consequence.

### 4.4 Accessibility

- `#bulk-count` keeps `aria-live="polite"`. It must remain the *only* live
  region here, or selecting a row announces twice.
- Both bars stay as **separate DOM nodes**. Visually they cross-fade; to AT the
  inactive one must be genuinely out of the tree (`hidden`, applied *after* the
  exit animation via the existing `.closing` helper pattern used by every
  overlay in the file). Morphing must not leave a stale "Inbox" in the
  accessibility tree while the bulk bar is live.
- No information is hover-dependent or motion-dependent. With motion off, all
  the same content is present.
- Contrast: `#bulk-count` is `--accent` on `--accent-soft` today and already
  passes `npm run contrast`. The morph changes *when* that pairing appears, not
  what it is — but the mid-transition colour is an interpolation between
  `--fg-faint`-on-`--bg` and `--accent`-on-`--accent-soft`, and
  `check-contrast.mjs` does not model intermediate frames. At 140ms that is
  acceptable; noting it as a known blind spot rather than claiming coverage.

### 4.5 Performance

- Fires on **selection change**, not on scroll and not per frame. Two composited
  layers for ~180ms.
- The absolute positioning removes work: today's swap dirties layout for
  `#listpane` and everything below it, including `#scroller`. After the change
  the container height is constant, so neither state change reaches the list.
- **This is a net performance improvement, not a cost.** That is unusual for an
  animation proposal and is the main reason I am putting it first.

### 4.6 Does it actually feel better? — the honest answer

**Yes, but the animation is the smaller half of the win.**

If I shipped only the fixed-height container and kept the hard cut, the
interaction would already be better, because the rows would stop moving. The
motion adds the *mode* legibility on top.

I want that stated plainly so the value is not attributed to the wrong thing.
The ranking of what matters here:

1. the list stops jumping — **large, measurable**
2. the centre label persisting — **moderate, this is the morph**
3. the staggered checkbox/actions — **small, this is the polish**

If a browser measurement later shows the two bars are in fact the same height
(i.e. my arithmetic is wrong), item 1 evaporates and this becomes a
polish-only change. **I would still recommend it, but at much lower priority**,
and I would say so rather than quietly keeping it at the top of the list.

---

## 5 · Risks

| risk | mitigation |
|---|---|
| Container height guessed wrong → bars clip or float | Measure in Chrome before locking. Do not ship a guessed constant. |
| `--row-h` and density modes change `--s-*`, so bar height differs per density | The container height must be a token per density, like `--row-h`. Must be measured in **all three** densities, as the 68px plate was. |
| `bulk-in` keyframe becomes orphaned | `test/package.test.mjs` `'every keyframe is defined exactly once and is actually used'` will catch it. Replace, don't strand. |
| Duplicate-selector check | `#bulkbar` and `#listhead` blocks must be edited in place, not re-declared — the "no selector defined twice within one layer" rule already caught `#account` once. |
| Two live regions announcing | Verify with a test asserting exactly one `aria-live` inside `#listbar`. |

---

## 6 · Tests I would write (each sabotage-verified before being trusted)

1. `#listhead` and `#bulkbar` are both children of `#listbar`, and `#listbar`
   has a fixed height token — *sabotage: remove the height, expect fail.*
2. Neither bar's transition touches a forbidden layout property — *sabotage:
   add `height` to the transition list.*
3. Exactly one `aria-live` region inside `#listbar` — *sabotage: add a second.*
4. The outgoing bar is `hidden` after the exit completes, not merely
   transparent — *sabotage: set `opacity: 0` only, expect fail.*
5. A bar-height token exists for each of the three densities — *sabotage:
   delete the compact one.*

### 6.1 A conflict the existing tests will expose — found by reading them

`app.integration.test.mjs:2585` asserts, **synchronously after `settle()`**:

```js
doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', … }));
await settle();
assert.equal(doc.getElementById('bulkbar').hidden, true);
```

The deferred-hide pattern in §4.4 (`.closing` → wait for `animationend` → set
`hidden`) **will break this**, because jsdom never fires `animationend` — there
is no animation engine. Today's synchronous `hidden = true` is why it passes.

This is the same shape of trap as the `#compose` `cancelExit()` code in
`compose.js`. Three options, in order of preference:

1. **Hide synchronously, animate the *incoming* bar only.** The outgoing bar is
   `hidden` at once; the arriving one animates in over the top. Since both are
   absolutely positioned in one box, there is no gap to cover. Keeps both
   existing assertions passing **unmodified** and needs no `animationend`
   plumbing at all.
2. Use the existing `closeWithMotion` helper and add a jsdom-safe fallback
   timer. More machinery, and a timer that fires in tests is a timer that can
   flake.
3. Weaken the assertions. **Rejected.**

**Option 1 is what I would implement**, and it is a real simplification rather
than a compromise: with a fixed-height container the exit has nothing to
explain, because nothing moves when the old bar leaves.

Plus the two existing assertions in `app.integration.test.mjs:1821-1827`
(`bulkbar.hidden`, `listhead.hidden`) must **keep passing unmodified**. If the
restructure requires weakening them, the restructure is wrong.

---

## 7 · Recommendation

Implement **A — the list header becomes the bulk bar**, in this order:

1. Measure both bar heights in Chrome, in all three densities. *(Blocked on the
   user; there is no browser in this sandbox.)*
2. Restructure to a fixed-height `#listbar` container. Verify the jump is gone.
3. Add the staged cross-morph.
4. Full affected-test run + `npm run contrast` + `npm run doctor` + preview
   render, inspected in all three densities.

**Awaiting approval before any code is written.**

Next concept in the queue, untouched: **#2 — Magnetic alignment.**

---

# IMPLEMENTATION RESULT

Shipped. Measured in **real Chrome 148** (installed in the sandbox with
puppeteer + the missing system libraries), not computed.

## Measurement, before → after

| density | `#listhead` | `#bulkbar` | jump |
|---|---|---|---|
| comfortable | 32px | **55px** | **23px** |
| cosy | 28px | **51px** | **23px** |
| compact | 24px | **47px** | **23px** |

Identical in all six themes; 18 combinations measured.

**After: 0.00px in all 18.** Sampled every animation frame during the
transition — the scroller top never moves once.

## My audit estimate was wrong, and understated the problem

I computed ~8.5px. The real figure was **23px**. The missing 14px was a defect
I could not have found by reading:

**The bulk bar overflowed the pane at every viewport width.** `#listpane` is
`minmax(300px, 400px)`, so it is ~318px regardless of window size. The five
text buttons needed **423px**. They wrapped to two lines — which is where the
extra 14px came from — and *after wrapping they still overflowed*, leaving
**Archive, Report spam and Delete unreachable** at 1024, 1280, 1440, 1680,
1920 and 2560. A shipped feature that could not be operated.

Fixed by converting them to icon buttons, reusing the glyphs `#ctx-actions`
already uses for the same three verbs. Now 106px in comfortable, no overflow
anywhere, and every target clears WCAG 2.5.8: 33×33 comfortable, 29×29 cosy,
25×25 compact.

## THE PREVIEW HAD NEVER RUN

The most serious finding, and it invalidates prior work rather than this
change: **`preview.html` threw `SyntaxError` before its first statement**, at
the parent commit and for an unknown number of commits before it. Zero rows,
zero icons, an empty shell. `npm run preview` printed a plausible size and
exited 0 throughout.

Every "rendered the artefact and inspected it" check in recent sessions was
looking at a blank page. I have corrected the audit's own claim accordingly —
this was not caused by the morph work.

Three independent bundler defects:

1. **`$&` expansion.** The replacement string passed to `String.replace` was
   the bundle, and `contacts.js` contains the standard regex-escape idiom
   `'\\$&'`. `$&` means *the matched text*, so the builder spliced
   `<script type="module" src="src/app/app.js">` into a string literal in the
   middle of the code. Fixed with function replacers on all three
   substitutions.
2. **`export { addressOf };`** — a bare re-export with no `from`, which
   `rules.js` uses deliberately and documents. Unhandled → `Unexpected token
   'export'`.
3. **`import * as ns from '…'`** — namespace imports, twelve of them.
   Unhandled → `Unexpected token '*'`.

The suite could not see any of this because the existing bundler test checked
the *builder's source* for phrases. The new test **builds the bundle and
parses it**, which covers the whole class. All three defects were
independently sabotage-verified against it.

## What shipped

- `#listbar`: one fixed-height slot, `--listbar-h` **41 / 37 / 33px** measured
  per density, both states `position: absolute; inset: 0`.
- Morph: centre label is the pivot (colour only, never blinks); checkbox
  `scale(0.6)→1`; actions `translate3d(8px)→0` at **+40ms**. Transform,
  opacity and colour only.
- Exit is synchronous, so **both existing integration assertions pass
  unmodified** — no `animationend`, which jsdom never fires.

Frame-by-frame proof of the staging (rAF sampling):

```
t(ms)   scrollerShift   checkbox   actions
12      0.00            0.43       0.00     <- checkbox leads
45      0.00            0.92       0.30     <- actions follow
179     0.00            1.00       1.00
```

## Verification

- **1311 tests, 0 failures** (1305 baseline + 6 new). The "1276 baseline" in
  my earlier notes was stale; re-measured on a clean stash.
- 6 new tests, **each sabotage-verified** (10 sabotages total, every one caught
  by the intended assertion).
- Contrast AA on all 6 themes · doctor clean.
- Reduced motion: animations 1ms, delays zeroed, **jump 0**, all content
  present.
- Accessibility: hidden state is `display:none` and absent from the a11y tree —
  no stale "All mail" while a selection is live. Exactly one live region.
- Inspected in all 3 densities × 6 themes, driven through the **real theme
  menu** rather than by setting `data-theme` (themes are data applied by JS;
  faking the attribute changes nothing — a trap I fell into first).

## Two mistakes the suite caught while I worked

- I declared `:root[data-density='cosy']` a second time. `no selector is
  defined twice within one layer` failed. `--listbar-h` now lives with the
  other density tokens.
- My first bundler assertion banned `<script` anywhere in the bundle;
  `sanitize.js` legitimately contains it in prose and a regex. Narrowed to the
  exact self-referential tag. Also tripped the existing `URL.pathname`
  portability rule.

## Honest assessment, revisited

The audit said the jump fix was the large half and the animation the smaller
half, and that if the bars turned out to be the same height this would drop to
polish-only. The measurement went the other way: the jump was **2.7× worse**
than estimated, and underneath it sat unreachable controls. The ranking stands
but the gap is wider — this was a bug fix with a morph on top.
