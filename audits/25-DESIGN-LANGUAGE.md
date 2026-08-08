# Audit 25 — Design Language Consistency

One question: **does this look like one team designed it, or like it accreted
over twenty-four audits?**

Not a polish pass and not a redesign. Where two patterns exist, the job is to
decide which is canonical and migrate the other toward it.

## Method

Every value-bearing property extracted from the stylesheet as a frequency
table, then compared against the token that already exists for it. A finding
requires two things: a hardcoded value, **and** a peer component using a token
for the same job. One-off values in isolation are not drift; one-off values
where a sibling uses the system are.

Icon weight was checked *optically* rather than by attribute — effective stroke
in rendered pixels is `stroke-width × (rendered ÷ viewBox)`, which is what the
eye actually sees and is not the same as the number in the markup.

## Token compliance, measured

| Property | Tokenised | Hardcoded | Verdict |
|---|---|---|---|
| `font-size` | **120 / 120** | 0 | ✅ complete |
| `line-height` | **13 / 13** | 0 | ✅ complete |
| `border-radius` | 61 / 63 | 2 (`50%`, both circles) | ✅ correct |
| `padding` | ~100 / 101 | 1 (`1px`, a hairline) | ✅ correct |
| `gap` | ~50 / 58 | 8 (all 1–2px optical nudges) | ✅ correct |
| `letter-spacing` | 9 / 16 | **7** | ❌ **incomplete** |
| `box-shadow` | 12 / 22 | **10** | ⚠️ mixed |

Type, spacing and radius migrations are **finished** — that is unusual and
worth stating, because it means the findings below are the last two unfinished
migrations rather than a general malaise.

## The four durable systems

- **Radius**: 5 tokens, used everywhere. The only literals are `50%` on two
  circles, which is correct — a circle is not a radius on a scale.
- **Buttons**: `.primary` and `.ghost` differ deliberately and consistently —
  `--s-5` vs `--s-3` horizontal padding, `--t-md` vs `--t-sm`, `--w-semi` vs
  `--w-medium`, accent border vs line border. One system, two weights.
- **Menus**: every menu in the app is built by `menu.js`, so "all menus feel
  identical" is structurally guaranteed rather than maintained by hand.
- **Elevation**: a 9-step `--z-*` ladder with no ad-hoc `z-index` anywhere.

---

## D-1 · The timetable is the only overlay with its own shadow — **and it is theme-blind**

**Component.** `.tt-panel`.

**What is inconsistent.** Eight overlays float above the page. Seven use
`var(--shadow-lg)`. One does not:

| Overlay | Shadow |
|---|---|
| `#palette-box`, `#compose`, `#help-box`, `.snooze-menu`, `#gate-card`, `.ac-list`, `#toast` | `var(--shadow-lg)` |
| **`.tt-panel`** | `0 24px 64px rgba(0, 0, 0, 0.28)` |

**What it should match.** `var(--shadow-lg)`, like its seven peers.

**Why it matters — and this is worse than a style nit.** `--shadow-lg` is
redefined per scheme: on light themes it is
`rgba(16, 24, 40, 0.07)` / `rgba(16, 24, 40, 0.12)`; on dark it deepens to
`rgba(0, 0, 0, 0.5)` / `0.55`. The timetable's hardcoded
`rgba(0, 0, 0, 0.28)` **does not participate in that**. On the four light
themes it casts a heavy near-black shadow calibrated for a dark background,
which is why the panel reads as sitting higher than every other overlay and
faintly *dirty* against a light surface.

So the largest academic surface in the product is the one place where the
elevation language visibly breaks — precisely the "academic screens belong to a
different application" failure the identity rule warns about.

**Isolated or systemic.** Isolated in count, systemic in meaning: it is the
only overlay that opted out of the theme system.

**Fix.** `box-shadow: var(--shadow-lg);`

**Migration.** One declaration. No visual change on dark themes (the token is
*stronger* there); a correct, lighter shadow on the four light themes.

**Priority: high** — it is a theme correctness bug wearing a consistency
costume.

---

## D-2 · `letter-spacing` is the one typographic axis that never migrated

**Component.** Seven rules across the brand, the radar, and the timetable.

**What is inconsistent.** `font-size` is 120/120 tokenised and `line-height` is
13/13. `letter-spacing` is **9 tokenised against 7 hardcoded**:

| Rule | Value | Should be |
|---|---|---|
| `#r-timetable .r-tt-head` | `0.4px` | **`var(--track-wide)` — identical value** |
| `#brand-text strong` | `0.2px` | `--track-wide` is 0.4px; 0.2 is half a token |
| `.radar-when` | `0.2px` | same |
| `.sc-group h3` | `0.07em` | the rail headings use `--track-wide` |
| `.tt-block-title` | `0.04em` | a private timetable value |
| `.tt-col-head` | `0.04em` | same |
| `.tt-prov-field` | `0.04em` | same |

**The first one is the proof.** `#r-timetable .r-tt-head` is set to `0.4px`,
and `--track-wide` **is** `0.4px`. Same value, written literally, because
whoever wrote it did not know the token existed. That is the definition of an
unfinished migration.

**What it should match.** The three-token scale that already exists:
`--track-tight: -0.01em`, `--track-normal: 0`, `--track-wide: 0.4px`.

**Why it matters.** Five of the seven are in academic surfaces, and the
timetable has effectively minted its own tracking value (`0.04em`, three uses)
parallel to the product's. A reader of `.tt-col-head` has no way to know
whether `0.04em` is a considered choice or a copy-paste — which is the cost of
an untokenised value regardless of how it looks.

**Isolated or systemic.** Systemic within one property, and concentrated in the
academic surfaces.

**Fix.** `0.4px` → `--track-wide` exactly. The `0.2px` and `0.04em` uses are
genuinely between existing steps, so they need **one new token**,
`--track-tiny: 0.02em`, rather than being forced onto a step that changes how
they look. Adding a token to complete a scale is finishing the system, not
expanding it.

**Migration.** Seven declarations, one new token.

**Priority: medium.**

---

## D-3 · Empty-state icons render at 1.00px and 1.28px effective stroke

**Component.** `#empty` and `#reader-empty-mark`.

**What is inconsistent.** Both are `48×48` viewBox line illustrations that mean
"there is nothing here". They are the *same component in two places*, and their
optical weights differ by 28%:

| Icon | viewBox | Rendered | `stroke-width` | **Effective** |
|---|---|---|---|---|
| `#empty` | 48 | 44px | 1.4 | **1.28px** |
| `#reader-empty-mark` | 48 | 30px | 1.6 | **1.00px** |
| `icons.js` (every generated icon) | 20 | 15px | 1.6 | **1.20px** |
| `#searchicon` | 20 | 20px | 1.6 | **1.60px** |

**What it should match.** `icons.js` at **1.20px effective** is the canonical
weight — it is what every generated icon in the product renders at, which is
the overwhelming majority of them.

**Why it matters.** These two empty states are the app's two "nothing here"
moments and a user sees them side by side when the inbox is clear. One reads as
noticeably lighter than the other, and neither matches the icon language
surrounding them.

`#searchicon` at 1.60px is the heaviest thing in the icon set and sits
permanently in the topbar beside 1.20px generated icons.

**Isolated or systemic.** Systemic in the hand-written SVGs specifically:
`icons.js` is internally perfect (one stroke width, one viewBox, one geometry),
and every deviation is in markup written by hand in `app.html`.

**Fix.** Set `stroke-width` so effective weight lands at 1.20px:
`#empty` → `1.3`, `#reader-empty-mark` → `1.9`, `#searchicon` → `1.2`.

**Migration.** Three attribute values. The *rule* — effective stroke, not
nominal — is the thing worth writing down, because it is not obvious and it is
what made the drift invisible.

**Priority: medium.**

---

## D-4 · Two panel chrome shadows are hardcoded and theme-forked by hand

**Component.** `#topbar` and `#listpane`.

**What is inconsistent.** Both carry a bespoke two-part shadow, and both are
then *overridden again* under `html[data-scheme='dark']` with a second
hardcoded value:

```
#topbar                       0 1px 0 var(--line), 0 1px 3px rgba(0,0,0,0.04)
html[data-scheme='dark'] …    0 1px 0 var(--line), 0 2px 8px rgba(0,0,0,0.28)
#listpane                     1px 0 0 var(--line), 2px 0 8px rgba(0,0,0,0.03)
html[data-scheme='dark'] …    1px 0 0 var(--line), 3px 0 14px rgba(0,0,0,0.24)
```

Four hardcoded rgba values doing manually what `--shadow-sm` already does
automatically.

**What it should match.** In principle `--shadow-sm`. **In practice, nothing —
these are directional.** A topbar casts downward, a list pane casts rightward;
`--shadow-sm` is omnidirectional and cannot express that.

**Why it matters — and why I am NOT recommending the obvious fix.** Migrating
these to `--shadow-sm` would lose the direction, which is doing real work:
it is what makes the topbar read as *above* the list and the list as *left of*
the reader. The honest description is that the elevation system has three
omnidirectional tokens and no directional ones, and two components needed
something the system does not offer.

**Isolated or systemic.** Systemic — a genuine gap in the token set rather than
sloppiness.

**Fix.** Two new tokens, `--shadow-edge-down` and `--shadow-edge-right`, each
scheme-aware like the existing three. This *removes* the manual dark-theme
forks, which is the actual defect: four values maintained by hand where the
system should supply two.

**Migration.** Two tokens defined per scheme; four rules collapse to two.

**Priority: medium** — no visual change, but it deletes the only place in the
stylesheet where a theme is forked by hand.

---

## Checked and found consistent

| Axis | Finding |
|---|---|
| Border radius | ✅ 5 tokens; only literals are `50%` on two circles |
| Border width | ✅ 1px structural, 2px focus, 3px accent rail — three deliberate roles |
| Buttons | ✅ `.primary`/`.ghost` differ consistently on all five axes |
| Menus | ✅ structurally identical — all built by `menu.js` |
| Type scale | ✅ 120/120 tokenised, 6 steps, no drift |
| Line height | ✅ 13/13 tokenised |
| Spacing | ✅ 4px grid with a guard test; only 1–2px optical nudges outside it |
| Elevation order | ✅ 9-step `--z-*` ladder, no ad-hoc `z-index` |
| Icon generator | ✅ one stroke, one viewBox, one geometry for every generated icon |
| Dialogs | ✅ gate and help share layout, focus handling and dismissal |
| Chips | ✅ `.tag`, `.att-chip`, `.r-course` all `--r-sm` + `--t-xs` |
| Colour | ✅ zero hardcoded hex outside `themes.js` and two icon fills |

## Priority

| # | Finding | Scope | Priority |
|---|---|---|---|
| D-1 | Timetable shadow ignores the theme system | 1 rule | **high** |
| D-2 | `letter-spacing` never migrated | 7 rules + 1 token | medium |
| D-3 | Hand-written icons drift 1.00–1.60px effective | 3 attributes | medium |
| D-4 | Panel edge shadows forked by hand per theme | 4 rules → 2 tokens | medium |

All four are **unfinished migrations**, not design decisions — which is the
answer to the audit's question. The language is coherent; three of its
migrations stopped at 90% and one component opted out of the theme system.

---

## Applied

All four, plus a fifth the guards found.

| # | Change | Effect |
|---|---|---|
| D-1 | `.tt-panel` → `var(--shadow-lg)` | the timetable rejoins the theme system |
| D-2 | 7 literals → tracking tokens, + `--track-tiny` | `letter-spacing` now 16/16 |
| D-3 | 3 stroke widths retuned optically | icons 1.19–1.28px, was 1.00–1.60px |
| D-4 | `--shadow-edge-down` / `--shadow-edge-right` | 4 hand-forked rules → 2 tokens |
| **D-5** | `--shadow-rim` | found by D-4's guard, see below |

**1267 tests pass. All six themes still meet WCAG AA.** Five consistency guards
added, all sabotage-verified.

### Token compliance, after

| Property | Before | After |
|---|---|---|
| `letter-spacing` | 9 / 16 | **16 / 16** |
| `box-shadow` | 12 / 22 | **21 / 22** |
| Hand-forked themes | 5 rules | **0** |
| Icon effective stroke | 1.00–1.60px | **1.19–1.28px** |

The single remaining bespoke shadow is `.theme-dot`'s
`inset 0 0 0 1px rgba(128,128,128,0.35)` — a deliberately neutral grey ring so
it reads against *any* swatch colour, which no theme token can express. The
guard excludes it by name with that reason attached.

### A guard I wrote found a fifth instance I had missed

The hand-forked-theme check was written for `#topbar` and `#listpane`. It
immediately failed on **`.snooze-menu`**, which carried a dark-only
`inset 0 1px 0 rgba(255,255,255,0.05)` — a rim of light along the top edge that
stops a floating panel reading as a hole punched in a dark page.

Same shape of gap as D-4: the system had no token for it, so the component
invented one privately. Now `--shadow-rim`, defined as transparent on light
themes and the highlight on dark — so the *rule* is identical in both schemes
and only the token changes, which is what the theme system is for.

I had looked at shadows and at dark overrides separately and not at their
intersection. The guard did.

### What the audit's question deserves as an answer

**The design language is coherent.** Type, spacing and radius are 100%
tokenised; buttons form one system; every menu is built by one primitive; the
z-ladder has no ad-hoc values.

What it had was **four unfinished migrations** — three that stopped at ~90%
(`letter-spacing`, shadows, hand-written icons) and one component that opted
out of the theme system entirely. None was a design decision; all four were
places where the system arrived after the component did.

Notably, the two findings with real user-visible consequences were both on
**academic surfaces**: the timetable casting a dark shadow on light themes, and
the timetable minting its own tracking value. That is the identity rule
failing in exactly the direction it warns about, and it is now closed.
