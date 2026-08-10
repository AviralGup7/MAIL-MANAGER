# Audit 35 — Attention bloom

Wow-animation concept **#3**. Design only. **No code written.**

Brief: find where **attention could cause useful information to emerge from an
existing component without changing its outer geometry** — more creative than a
hover tooltip. Say so if the pattern doesn't fit, rather than forcing it.

Measured in **real Chrome 148** against `preview.html`.

---

## 1 · The constraint that shapes every answer here

This product **already killed the obvious version of this feature.** Audit 17,
item 30:

> **"30 · Hover preview card — CUT.** If the row already tells you what the mail
> says, a popover showing more of the same is a hover-intent state machine, a
> positioning engine…"

And `snippet.js` states the principle:

> *"fix the row and the popover has nothing left to say."*

So the bar is not "can something appear on hover". It is: **is there
information the row genuinely fails to deliver, which can emerge from inside
the row's own box, without a popover, without a positioning engine, and without
changing geometry?**

That is a real bar, and two candidates clear it.

---

## 2 · What the row knows and does not show — measured

| information | computed? | shown in row? |
|---|---|---|
| Full subject | yes | **no — clipped** |
| `m.dueAt` + urgency band | yes (`deadlines.js`) | **no** |
| `dueText` (the matched phrase) | yes | no |
| Classifier `reason` | yes | `title` only |
| `confidence` | yes | dashed underline only |
| Lane assignment | yes (`lanes.js`) | no |
| Conversation participants | yes | `title` only |

The row is not information-*quiet*. It is information-**starved**: it has been
compressed to a fixed 68px and several things it knows were pushed into
tooltips or dropped.

---

## 3 · Candidate A (STRONGEST) — **the subject completes itself**

### 3.1 The defect, measured

| density | subjects clipped | avg shown | avg lost |
|---|---|---|---|
| comfortable | **16/20 (80%)** | 81% | 68px |
| cosy | 14/20 (70%) | 82% | 67px |
| compact | 13/20 (65%) | 83% | 63px |

**Snippets: 20/20 clipped.**

Losing the last 19% would be harmless if subjects front-loaded their meaning.
On institutional mail they do the opposite — the actionable clause is at the
**end**:

```
 72% shown  "PS-II Station Allotment Round 2 — response req…"   [uired]
 73% shown  "Scheduled network maintenance — Saturday 2 AM …"    [to 4 AM]
 74% shown  "CS F364 Design & Analysis of Algorithms — make…"    [up class]
```

The row clips **"response required"**, **"makeup class"**, the actual time
window. The user is scanning for exactly those words and the interface removes
them. `title` exists, but a native tooltip is a ~1s hover delay, appears at the
cursor rather than in the layout, and is unavailable to keyboard users.

### 3.2 The bloom

> **The attended row spends its second line on the rest of the subject instead
> of the snippet.**

Line 2 already exists, is already occupied, and is **280–290px wide** — while
the subject overflows by only **64–82px**. Measured: `line2CanHoldRemainder:
true`. The space is already there and is currently spent on a snippet that is
itself 100% clipped.

```
resting          Practice School Division                    8:50 PM
                 PS-II Station Allotment Round 2 — response…  ● PS  ★
                 The second round of station allotment is no…

attended         Practice School Division                    8:50 PM
                 PS-II Station Allotment Round 2 —            ● PS  ★
                 response required by Friday 5 PM
```

Same two lines. Same 68px. **Nothing moves.** The subject stops being truncated
and its tail flows into the line below, which is what a second line is *for*.

### 3.3 Why this is a bloom and not a reveal

Nothing appears from outside. No new element, no layer, no positioning. The
information was already in the row's own text node — it simply had nowhere to
go. Attention **re-allocates the row's existing space** toward the thing the
user is currently interested in.

That is the honest sense of "bloom from within the existing space": the row
doesn't grow, it *re-prioritises*.

### 3.4 Feasibility

Purely a `-webkit-line-clamp` change on `.r-subj` (1 → 2) with the snippet
hidden in the same state. Both are **`display`/clamp switches, not
transitions** — no layout animation, no forbidden property.

The fade between them can be `opacity` only.

| constraint | status |
|---|---|
| Row height unchanged | **Yes** — line 2 is reused, not added |
| `contain: paint` clipping | **Respected** — everything stays inside the row |
| Forbidden transition props | **None** — opacity only |
| `content-visibility: auto` | Untouched; no per-frame work |

**Compact density is the exception:** `.r-snip { display: none }` there, so
`line2WidthPx: 0`. Two honest options — let compact bloom the snippet line back
(it has 6.4px vertical slack, needs ~18px, so **no**), or **accept that compact
does not bloom**. I would accept it: compact is the "fit more on screen" mode
and the user has already traded detail for density. Forcing it would break the
row contract, and that contract is why the list is fast.

### 3.5 Perception, keyboard, touch

- **Perceived:** *"the subject finished itself."* Not a card, not a tooltip.
- **Keyboard:** this is the strong point — the selected row is *already* the
  focus concept (`aria-selected`, `aria-activedescendant`). Bloom on
  `.row[aria-selected]` and `j`/`k` gets it **for free**, which a hover tooltip
  never gave keyboard users.
- **Touch:** tap selects, so bloom follows selection. No hover dependency.
- **Reduced motion:** the fade disappears, the re-allocation remains — the
  *information* is not motion-dependent, which is the accessibility bar.
- **Screen readers:** the full subject is already the accessible name and
  `title`. No change; no double announcement.

### 3.6 The risk I would test first

Two rows can be attended at once: `:hover` and `[aria-selected]`. If both bloom,
the eye sees two two-line subjects and the list looks broken. **Selection should
win, hover should be secondary or absent.** Measuring which feels right is the
first implementation step, not a guess.

Also: swapping line 2's content changes what a scanning eye finds. If a user
relies on the snippet, taking it away *at the moment they look* is a
regression. Mitigation: bloom only when the subject is **actually clipped**
(16/20 rows, detectable as `scrollWidth > clientWidth`) — otherwise leave the
snippet alone. That makes it responsive to a real condition rather than a
blanket rule.

---

## 4 · Candidate B (also strong) — **the plate blooms urgency**

### 4.1 The find

`m.dueAt` exists on messages and **the row never shows it**. Opening one, the
reader says:

```
Due in a week      Read from: "on monday"
```

The row that message came from showed a date, a category code and a star — no
hint that a deadline exists. The **radar** in the sidebar surfaces deadlines
globally, but nothing connects a *row* to its own due date. So a user scanning
the list cannot see which messages are time-bound; they must open each one, or
cross-reference the rail.

### 4.2 The bloom

The signature plate is a **fixed 68px** with **23px of measured slack** on the
`.r-when` line (date 45px of 68px). On attention, the date line blooms its
relative deadline in place:

```
resting     8:50 PM              attended     Due Friday
            ● PS  ★                           ● PS  ★
```

The **timestamp is replaced by the deadline** — because when a message has a
due date, "when it arrived" is the less useful of the two, and the user's
attention is precisely the signal that they now care about consequence rather
than chronology.

Only for rows with a `dueAt`. Every other row is untouched.

### 4.3 Why B is weaker than A

Honest ranking:

- **Fewer rows qualify.** A improves 65–80% of rows; B only those with a
  deadline.
- **The plate is newly stable.** Concept #1's sibling work fixed the right edge
  at 68px specifically to stop it moving. `"Due Friday"` may not fit 68px — it
  would need measuring, and if it doesn't fit, B is dead as designed.
- It edges toward re-litigating a solved layout.

**A is the recommendation. B is a genuine second candidate**, contingent on that
width measurement.

---

## 5 · Rejected, recorded

| candidate | why not |
|---|---|
| Hover preview popover | Explicitly cut in audit 17. Resurrecting it ignores a decided question. |
| Snippet expanding to 2 lines | Needs ~18px; comfortable has 11.6px slack, cosy has **−0.4px**. Breaks the row contract. Measured, not assumed. |
| Confidence/`reason` blooming | Diagnostic, not actionable while scanning. `openMessage()` already shows it only when the classifier is unsure — that judgement is right. |
| Sender address on attention | `fromClipped: 0/20`. No defect to fix. |
| Lane badge in the row | Lanes are a grouping mechanism; per-row it is a fourth code competing with the category. |

---

## 6 · Does it genuinely fit, or am I forcing it?

**It fits — but I want to be precise about what "bloom" means here.**

The brief's framing is *information emerging from within a component under
attention*. Candidate A is that literally: no new surface, no layer, no
positioning engine, no geometry change. The row **spends its own second line
differently** because the user is looking at it.

What it is *not* is a decorative flourish. Like #2, the strongest candidate is
an **information-architecture fix wearing an interaction**: 80% of subjects are
clipped exactly where the meaning lives, and the row already owns enough space
to fix it — the space is just committed to a snippet that is itself 100%
clipped.

If that reads as insufficiently "wow", I'd rather say so than propose a
popover the product already rejected on the record.

---

## 7 · Tests I would write (each sabotage-verified)

1. `.r-subj` is clamped to 1 line at rest and 2 when attended; **row height is
   unchanged in both** — sabotage: remove the clamp.
2. No transition on a forbidden layout property; opacity only.
3. Bloom is driven by `[aria-selected]`, not `:hover` alone — guarantees the
   keyboard path.
4. `.r-snip` is hidden in the bloomed state, so the two never stack.
5. Compact density does not bloom (documented, not accidental).
6. **Browser-level:** measured row height identical in both states, all three
   densities.

---

## 8 · Recommendation

Implement **A — the subject completes itself into the snippet line**, gated on
the subject actually being clipped, driven by selection (keyboard-first) with
hover as a secondary decision to be measured.

**B — the plate blooms its deadline** is a real second candidate, blocked on
measuring whether a relative deadline fits 68px without disturbing the right
edge concept #1's sibling work stabilised.

**Awaiting approval before any code is written.** No #4.
