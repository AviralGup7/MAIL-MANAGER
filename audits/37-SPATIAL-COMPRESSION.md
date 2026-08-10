# Audit 37 — Spatial compression: complete opportunity map

Concept **#5**. Audit only — **no code written**. Scope is decided with the
user after this map.

The question is not "what can we shrink". It is: *where could the interface
make the user feel "the UI is making room for what matters right now"?*
Every surface of the product was surveyed against eight forms of
compression: visual density, attention/focus, quieting surroundings,
reclaiming unused space, temporary reallocation, component transformation,
hierarchy change, and compression around an active element.

Per the corrected process: existing rules are **constraints with a price**,
not vetoes. Each opportunity below states the constraint it hits and what
relaxing it would actually cost, measured in real Chrome 148 against
`preview.html` (1280×800 and 1440×900).

## 0 · The measured ground truth

| surface | idle @1280 | reader open @1280 | @1440 |
|---|---|---|---|
| `#topbar` | 61px h | 61px | 61px |
| `#sidebar` (rail) | 244px w | 244px | 244px |
| `#listpane` | 400px w (capped by `minmax(300px,400px)`) | 400px | 400px |
| `#reader` | **hidden — 0px** | 636px w | ~796px w |
| `#scroller` | 698px h | 698px | 798px |

- Reader body text at 1440 ≈ 740px ≈ **95ch** — past the product's own 68ch
  reading measure; the surplus is dead margin. The subject is capped at
  62ch; the body is not.
- One `grid-template-columns` change + forced reflow: **1.7–2.2ms**.
- One topbar height collapse + forced reflow: **0.2ms**.
- Row contract unchanged throughout: `contain: layout paint style` +
  `content-visibility: auto`; a full relist of 2000 rows is not what any
  proposal below triggers.

**The doctrine this audit amends, with the price stated:** "transform and
opacity only, never layout" exists so nothing reflows per frame. Every
opportunity below is a **discrete, state-bound** change (one reflow of
0.2–2.2ms at the moment of a mode change), not a per-frame animation.
The measured cost is <14% of one 16ms frame, paid once per user action.
The amendment proposed: *per-frame layout animation stays forbidden;
discrete layout transitions ≤200ms are permitted where a measurement in
this table is cited.* Per-frame proposals (O9) remain rejected.

## 1 · The opportunity map

### O1 — Reader idle: the list gets the room back (reclaim unused space)
- **What improves:** at rest the right pane is 636px of "Select a message"
  while scanning — the product's central gesture — is capped at 400px.
  Widening the list to ~640px shows the full subject (audit 35 measured
  64–82px clipped) *and* most of the snippet without blooming.
- **Value:** high. This is the idle state — what a new user sees first and
  what every archive returns you to.
- **Implementation:** `#panes` columns `minmax(300px,400px)` →
  `minmax(300px,640px)` while `#reader[hidden]`, with the amended discrete
  transition. No cap change while a message is open.
- **Constraint conflict:** the no-layout-transition doctrine (priced above:
  2ms) and `#listpane`'s duplicate-selector exemptions (edit in place).
- **A11y/perf:** none lost; the empty state stays centred.
- **Broad-application noise:** none — bound to one binary state.
- **Bucket: clearly worth implementing.**

### O2 — Reading focus: the rail becomes an icon strip (attention reallocation)
- **What improves:** while a message is open the task is reading, not
  navigating; the rail's 244px then buys scanability the user is not using.
  Collapsing to 56–64px icons (counts as tiny badges, labels on hover —
  `title` already exists) gives the reader +180px at 1280, moving body text
  from 580px (~76ch) toward the measure's useful range, and gives the LIST
  room if combined with O1.
- **Value:** high at ≤1280, moderate at 1440 (where the reader is already
  over-wide — there the win is quieting, not width).
- **Implementation:** body class `reading` while `#reader` open; rail width
  token remap; icons already exist per mailbox/category (`MAILBOX_ICON`,
  category dots); expand on hover/focus-within and on reader close.
- **Constraint conflict:** "rail counts are scannable" (the two-number
  design). Priced: counts remain as badges; full numbers return on hover
  and on close. Scanning and reading are different tasks; the rail serves
  the wrong one while reading.
- **A11y:** labels must survive as `aria-label`, not just `title`; roving
  tabindex unchanged.
- **Noise:** none if bound to reader-open only; auto-collapse during scroll
  would be noise (see O-rejected).
- **Bucket: worth it if the scanability constraint is relaxed contextually.**

### O3 — Topbar yields on scroll-down, returns on scroll-up (reclaim)
- **What improves:** +61px ≈ one comfortable row while moving through the
  list; the bar returns the instant the user scrolls up or focuses search.
- **Value:** moderate but *every session*; standard, legible pattern.
- **Implementation:** reuse the existing `#listpane.scrolled` machinery
  (already debounce-toggled at scrollTop>4); collapse via a grid row or
  height with the discrete transition; 0.2ms reflow measured.
- **Constraint conflict:** #1 "the list must not jump under the cursor".
  Priced: #1's defect was an *unsignalled* jump during aiming; a
  scroll-direction-bound collapse is signalled by the user's own gesture
  and reverses on the opposite gesture. Mitigation: never collapse while a
  selection is live (bulk mode) and never partially — one state, one move.
- **A11y:** search focus always restores; reduced-motion → instant.
- **Noise:** low; the reverse gesture is the undo.
- **Bucket: clearly worth implementing.**

### O4 — Brand block compacts while scrolling (hierarchy)
- 79px of account/freshness compress to one line during `scrolled`.
- **Value:** low (19px, and the freshness line is the sync button now).
- **Bucket: interesting but low-value.** Fold into O3 if desired, not alone.

### O5 — Reader head folds on body scroll (hierarchy, quieting)
- **What improves:** on long mail, meta/tags/date (~70px) leave while the
  subject pins; the eye stays on content.
- **Value:** moderate for long institutional mail; zero for short mail.
- **Implementation:** `#r-body` is a cross-origin srcdoc iframe — its scroll
  is NOT observable from the app. The fold must instead key on message
  length (body text > N chars) + app-level state, or move the scroll
  container. That makes it a design decision on guessed state → weaker.
- **Constraint conflict:** none hard; the iframe wall makes the honest
  trigger expensive.
- **Bucket: interesting but low-value as designed; reopens if the reader
  body ever becomes same-origin scrollable.**

### O6 — Rail groups accordion (hierarchy)
- Folding VIEWS/CATEGORIES to make room for the other.
- **Value:** low — the rail already scrolls (`#cats`), and accordions tax
  every navigation with a prior expand.
- **Bucket: interesting but low-value.**

### O7 — Compose open: the rest of the app goes quieter (quieting)
- **What improves:** writing is the one task where the inbox is pure
  distraction; dropping list/rail to ~0.5 opacity (colour/opacity only —
  doctrine-safe, zero layout) says "you are composing" without a modal.
- **Value:** moderate; also fixes a real confusion: a minimised compose is
  the only trace today (and now a dot, polish 16).
- **Implementation:** `body.composing #sidebar/#panes { opacity }` with an
  opacity transition; restored on minimise/send. Pointer events unchanged
  (the user can still reach the list — quieting, not blocking).
- **Constraint conflict:** none (opacity is sanctioned).
- **Noise:** one context only; applying dimming more broadly (bulk mode,
  search) is the noisy version — rejected there (O11).
- **Bucket: clearly worth implementing.**

### O8 — Focus mode: user-invoked full compression (attention)
- One key hides rail + topbar; an exit chip + `Esc`-twice returns them.
- **Value:** high for long reads on small screens; zero cost to everyone
  else because opt-in.
- **Constraint conflict:** shortcut policy (must pick a free key; `f` is
  free), discoverability (coach mark / help lists it), a11y exit affordance.
  All solvable; none architectural.
- **Bucket: worth it if shortcut+exit UX is designed (small, bounded).**

### O9 — Adaptive density while fast-scrolling (visual density) — REJECT
- Auto-compact during flick, restore at rest.
- **Why not, measured:** density remap re-renders every row metric; the row
  contract exists precisely so scrolling never pays for rows. Per-frame or
  per-gesture density changes also make the list *unstable under the eye*
  — the failure #1 and #2 fixed, generalised. The constraint here is worth
  preserving; its price (no free density theatre) is paid gladly.
- **Bucket: not actually useful.**

### O10 — Neighbour rows lean away from the attended row — REJECT
- Inverse compression around the active element.
- **Why not:** the row already re-allocates its OWN pixels (audit 35);
  moving neighbouring rows adds motion where the eye aims next. Noise, and
  it fights the transform ban on rows for no information.
- **Bucket: not actually useful.**

### O11 — Bulk mode dims/moves the chrome — REJECT
- Multi-select is seconds-long; relocating chrome mid-aim breaks the anchor
  #1 established. The bulkbar morph already carries the mode change.
- **Bucket: not actually useful.**

### O12–O14 — Toast stacking, timetable collapse, search-bar growth
- Toast is single-instance by design; the timetable panel already hides
  when empty; growing the search input while querying buys ~90px for a task
  that already has the palette.
- **Bucket: interesting but low-value.**

### O15 — No-matches: give the dead pane a job (reclaim)
- When the list is empty and the reader idle, both panes are dead space;
  O1 already redirects the space; a further compression adds nothing.
- **Bucket: interesting but low-value (absorbed by O1).**

### O16 — Blockquote folding in the reader (quieting surrounding content)
- **What improves:** institutional replies bury the new sentence under five
  screens of quoted history. Folding quotes past ~6 lines behind a
  "Show quoted text" control is the single largest *content*-space win in
  this map — Gmail itself ships it (audits 07/08 recorded our gap).
- **Value:** high for the reply-heavy fraction of mail; zero otherwise.
- **Implementation:** a post-sanitise DOM pass in the srcdoc builder:
  `blockquote` (and `> `-style `div` chains if the sanitizer unwraps them)
  taller than N lines get `max-height` + a toggle button injected inside
  the srcdoc (same document, so no cross-origin problem).
- **Constraint conflict:** "the sender's layout is left as they designed
  it" (sanitize.js). Priced: the rule exists so newsletters render as
  intended; folding quoted *history* is a reading aid the sender benefits
  from too, and the content stays one click away. Relax with the toggle
  defaulting to folded only for quotes >6 lines.
- **A11y:** the toggle is a real button with a label; reduced-motion
  irrelevant (discrete).
- **Bucket: clearly worth implementing.**

## 2 · Grouped

**Clearly worth implementing:** O1 (list gets the room), O3 (topbar yields),
O7 (compose quieting), O16 (blockquote folding).

**Worth it if a constraint is relaxed (priced above):** O2 (icon rail while
reading — relaxes rail scanability, contextually), O8 (focus mode — relaxes
shortcut policy), O5 only if the reader body becomes observable.

**Interesting but low-value:** O4, O6, O12–O15.

**Not actually useful:** O9, O10, O11 — and the reasons are measurements,
not taste.

**Noise warning:** the tempting generalisation — dim/collapse chrome on
*every* state change — is exactly what turns a calm tool into a Christmas
tree. The map applies compression only where a *task* changes (scan →
read → write), never where a *selection* changes.

## 3 · Suggested scope for the decision

Phase 1 (bucket 1): O1 + O3 + O7 + O16, with the doctrine amendment
(discrete layout transitions ≤200ms, per-frame still banned) written into
the stylesheet header and its test.
Phase 2 (optional): O2 + O8.
Everything else recorded here so it is never re-proposed blind.

---

# IMPLEMENTATION RESULT #5

Shipped as one system (`SPATIAL COMPRESSION` section, app.css; state wiring
in app.js/compose.js; fold in sanitize.js). Verified in real Chrome 148:

| move | measured |
|---|---|
| O1 list width idle/open | 640 / 400 at 1280, identical in compact + midnight |
| O3 topbar rest / scrolled / search-focus | 61 / 0 / 61 |
| O7 sidebar rest / composing / after | 1 / 0.5 / 1 |
| O16 fold | one fold per >480-char quote; short quotes untouched; `foldQuotes:false` opt-out |
| reduced motion | states apply instantly (topbar 0 in 60ms sample) |

5 contract tests + doctrine exemption in package.test (selector-scoped,
measurements cited). 4 sabotages caught (cap removed, guards dropped,
quote-fold threshold zeroed, quieting turned into locking).

## O2 and O8, evaluated during implementation as instructed

**O2 (icon rail while reading) — rejected, with a measurement.** At 1280 the
open reader's body text is already ~78ch; collapsing the rail would push it
to ~102ch — the wrong direction for a product whose own measure is 68ch.
The rail's width buys line-length the reader does not want. Quieting while
reading remains available via the O7 pattern if a future round wants it.

**O8 (focus mode) — rejected this round.** Its measurable benefit is
immersion, and the measurable cost is a third transient chrome state plus a
shortcut-policy change; O7 delivered the quieting half without hiding
anything. Documented, not deleted: if a round adds reader-side line-length
capping (a `68ch` max-width on the body), O2's width argument reverses and
both should be re-evaluated together.

Everything that "feels mechanically compressed" was checked against the
noise warning: all four moves key on task changes; none fires on selection.
