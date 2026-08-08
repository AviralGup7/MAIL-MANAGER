# Audit 21 — Visual Hierarchy

**Not** a polish audit, **not** a design-system audit, **not** a redesign. The
single question throughout: *does visual weight match product importance, and
does the eye land in the right place without conscious searching?*

## Method: measured, not eyeballed

A hierarchy audit written by reading CSS is an opinion. Every finding below is
backed by a number.

**Visual weight proxy** — the eye responds to the product of three things, not
to any one of them:

```
weight = contrast(colour, surface) × (size ÷ 13px) × weightFactor
         weightFactor: 400→1.00  500→1.08  600→1.18  700→1.30
```

That is a model, not physics. It is deliberately crude and it is *consistent*,
which is what makes two elements comparable. Where it says two things are within
a few percent of each other, they will compete — and competition is the finding,
regardless of the model's absolute accuracy.

Measurements were taken from `src/app/app.css` parsed as a rule table, from the
real `app.html` DOM booted in jsdom, and from `themes.js` for actual colour
values. Where a rule is injected at runtime by `app.js`, the JS was read too —
which is how finding **H-1** surfaced.

## Verdict up front

**The foundations are sound.** Six things this audit expected to find, and did
not:

- `.primary` appears exactly **3 times** in the whole document (`Compose`,
  `Sign in`, `Send`) and **never twice on one screen**. Most products fail this.
- The reader hierarchy is measurably correct: subject 27.85, sender 17.44, body
  16.15, date 5.19. First glance lands on the subject, which is right.
- Accent-as-background appears on 8 selectors, but four are mutually exclusive
  states and one (`#topbar::after`) is a busy indicator hidden at rest.
- The type scale is a real scale — 11/12/13/15/19/23 — not an accumulation.
- Elevation is a formal 9-step `--z-*` ladder with no ad-hoc `z-index` values.
- Category colour is **never** the sole carrier of meaning; every dot is paired
  with a text tag.

So this audit is narrow on purpose. Seven findings, ordered by how much they
cost a user per session.

---

## H-1 · Two competing specifications for the same sidebar heading — **measured**

**What currently attracts attention.** "Categories" — the *middle* section
label — is the strongest of the three section headings in the rail.

| Heading | Selector | Size | Weight | Contrast | Tracking |
|---|---|---|---|---|---|
| Views | `#views-title` | 11px | **700** | 5.88 | 0.08em |
| Due soon | `#radar-title` | 11px | **700** | 5.88 | 0.08em |
| Categories | `.rail-heading` | 11px | **600** | **7.87** | 0.07em |

**What should attract attention instead.** Nothing. All three are peer labels
whose only job is to separate groups. They should be visually identical and
they should all recede.

**Why the hierarchy is weak.** Two independent implementations exist for one
role. `#views-title` and `#radar-title` are styled from `app.html`'s static
markup; `.rail-heading` is injected at runtime by `buildSidebar()` in `app.js`
and was styled separately. Neither author saw the other. The result is that the
*lowest*-priority heading has **34% more contrast** than its peers while being
100 weight units lighter — two errors pointing in opposite directions, which is
why nobody noticed by eye.

**How it affects usability.** The rail is a 244px column the user scans
vertically many times per session. Inconsistent label weight makes the groups
read as though they have different importance, so the eye pauses at
"Categories" on every pass. It is a small cost paid very often.

**Concrete improvement.** Delete `.rail-heading`'sstandalone declaration and add the
class to the existing `#views-title, #radar-title` rule. One selector list, one
spec, three headings. No new tokens, no visual invention.

**Expected benefit.** The rail becomes three evenly-quiet groups; the eye stops
snagging. **Priority: high** — near-zero cost, and it is a correctness bug in
the design system rather than a taste question.

---

## H-2 · Sender and subject are tied in the message row — **measured**

**What currently attracts attention.** Neither, distinctly. Measured on
Daylight:

| Element | Score | Size | Weight | Contrast |
|---|---|---|---|---|
| subject (unread) | 19.05 | 13px | 600 | 16.15 |
| sender (unread) | 17.59 | 12px | 600 | 16.15 |
| **subject (read)** | **6.95** | 13px | 400 | 6.95 |
| **sender (read)** | **6.93** | 12px | 500 | 6.95 |
| snippet | 4.79 | 12px | 400 | 5.19 |
| date | 4.39 | 11px | 400 | 5.19 |

Read sender and read subject differ by **0.02 — a 0.3% difference**. That is a
tie. The 1px size advantage of the subject is exactly cancelled by the sender's
extra 100 weight units.

**What should attract attention instead.** The subject, clearly and always. In
a campus inbox the sender is frequently the *same* — AUGSD, the placement unit,
one mailing list — across a dozen consecutive rows, so the sender carries almost
no discriminating information while the subject carries nearly all of it.

**Why the hierarchy is weak.** Not a mistake so much as an unresolved tension:
`--w-medium` on `.r-from` is doing "sender is a name, names read better with a
little weight", and `--t-md` on `.r-subj` is doing "the subject is the content".
The two intentions cancel.

**How it affects usability.** Scanning a list of 44 conversations, the eye has
no consistent entry point per row and re-decides where to start on every one.
This is the single highest-frequency hierarchy cost in the product — it is paid
once per row per scan.

**Concrete improvement.** Drop `.r-from` to `font-weight: 400` for the **read**
state only. (There is no `--w-regular` token — the scale starts at
`--w-medium: 500` — so this is a literal, or the scale gains a `--w-regular:
400` entry first. I checked; assuming the token existed would have shipped
unbuildable advice.) The unread state already separates cleanly (19.05 vs 17.59, both at
600) and must not change. This makes read rows score subject 6.95 / sender 6.44
— a visible 8% gap using the existing tokens, no new colour, no size change.

**Expected benefit.** A predictable left-to-right entry point on every read row;
faster scanning of exactly the mail the user is triaging.
**Priority: high.**

---

## H-3 · The brand mark is the loudest permanent element on screen

**What currently attracts attention.** `#brand-mark` — a 26px square carrying
`linear-gradient(135deg, accent, accent 40%, warning)` **plus** `box-shadow:
0 2px 8px var(--glow)`. It is the only element in the app combining a
multi-hue gradient with a coloured glow, and it is visible on every screen,
permanently, at the top-left — the strongest position on the page in a
left-to-right reading order.

**What should attract attention instead.** The unread mail, or the primary
action. The brand mark is pure identification and needs to be *findable*, not
*prominent*. Nobody opens a mail client to look at its logo.

**Why the hierarchy is weak.** It uses two of the app's scarcest signals —
gradient and glow — for the element with the least ongoing informational value.
By the audit's own standard, *is every piece of emphasis earned?*, this one is
not: it is earned once, on first launch, and never again.

**How it affects usability.** Mild but constant. It sets a high baseline of
visual energy at the top of the rail, which the genuinely important accent
signals below it (the selected-category bar, the Compose button) then have to
compete against. It also puts `--warning` on screen at all times, which weakens
warning as a semantic colour — see H-5.

**Concrete improvement.** Keep the gradient, drop the glow. `box-shadow: 0 2px
8px var(--glow)` is the part doing the shouting; the gradient alone still reads
as a brand mark at 26px. Optionally replace `--warning` with `accent 70%` so the
mark stays inside one hue family.

**Expected benefit.** The rail's visual energy budget goes to navigation state
rather than to the logo, and `--warning` regains its meaning.
**Priority: medium.**

---

## H-4 · The date is quieter than the snippet, inverting their real value

**What currently attracts attention.** Between the two, the snippet (4.79) over
the date (4.39) — they share `--fg-faint` and differ only by 1px of size.

**What should attract attention instead.** These should be *distinguishable by
role*, not stacked on one contrast level. The date is a precise, scannable
datum the user often navigates by ("the one from Tuesday"). The snippet is
supporting prose that is deliberately skimmable and, after the snippet-cleaning
work, is frequently empty.

**Why the hierarchy is weak.** Both were assigned "least important" and given
the same token, so a *sorting key* and a *preview* occupy the same visual
layer. Two different jobs, one weight.

**How it affects usability.** Date-based scanning — a genuinely common
retrieval strategy — is slower than it needs to be, because the date does not
form its own visual column despite being right-aligned and structurally ideal
for one.

**Concrete improvement.** Move `.r-date` up one step to `--fg-dim` while
*keeping* `--t-xs`. Small-and-clear beats large-and-faint for a scannable
column, and the size difference preserves the hierarchy against the subject.
Leave the snippet at `--fg-faint`.

**Expected benefit.** The right edge becomes a readable time column; the
snippet stays quiet. **Priority: medium.**

---

## H-5 · `--warning` is spent on decoration, weakening it as a signal

**What currently attracts attention.** `--warning` appears in the permanent
brand gradient (H-3). It is also the semantic colour for the amber
service-worker banner and for overdue deadlines in the radar.

**What should attract attention instead.** Only genuine warnings. A semantic
colour's power is entirely a function of its scarcity.

**Why the hierarchy is weak.** The audit brief asks *which colour represents
warning?* — and the honest answer here is "warning, plus the logo". Any user who
has seen the mark for a week has partly habituated to the hue before a real
warning arrives.

**How it affects usability.** Degrades the amber banner and the overdue-deadline
state, which are the two moments the product most needs to interrupt someone.

**Concrete improvement.** Remove `--warning` from `#brand-mark`'s gradient
(folds into H-3's fix). Then `--warning` appears **only** on: the fallback
banner, overdue radar entries, and the exam chip.

**Expected benefit.** Amber means "attend to this" again.
**Priority: medium** — cheap, and it protects two high-stakes states.

---

## H-6 · The reader has no visual separation between headers and body

**What currently attracts attention.** Correctly, the subject (27.85), then the
sender (17.44). That part is right and should not change.

**What should attract attention instead.** Nothing different — but the *grouping*
is missing. Measured: `#r-from` scores 17.44 and the body scores 16.15. They are
within 8% of each other, and there is no rule between them, no surface change,
and no spacing step larger than `--s-3`.

**Why the hierarchy is weak.** The brief asks whether related information groups
and unrelated information separates. Sender/recipients/date are *metadata about*
the message; the body is *the message*. They currently read as one continuous
block of text at two similar weights.

**How it affects usability.** On a long institutional notice the eye does not
get a clean "the message starts here" signal, so the first paragraph is often
re-read after the reader realises the header ended.

**Concrete improvement.** One hairline `border-bottom: 1px solid var(--line)`
under the metadata block, plus a `--s-4` gap below it. This is the same
separator idiom `#side-foot` and `#radar` already use — no new visual language.

**Expected benefit.** A clear entry point into the body; less re-reading on the
long notices that dominate this inbox. **Priority: medium.**

---

## H-7 · The compose failure indicator is styled like ordinary metadata

**Correction to my own first draft.** I initially wrote that both
`role="alert"` elements were visually silent. Checking rather than asserting:
`#gate-error` carries `class="err"`, which applies `color: var(--danger)
!important`. **The sign-in error is correctly styled.** Only one element has
the defect, and the finding is narrower than I first claimed.

**What currently attracts attention.** Nothing. `#c-status` — the element that
reports *"Could not send"* in the compose panel — is styled with exactly one
declaration:

```css
#c-status { font-size: var(--t-sm); }
```

No colour, no weight. It inherits the panel's body colour, so a send failure
renders identically to a character count or a "Saved" hint.

**What should attract attention instead.** A failed send is the highest-regret
event in the product. It should be the most prominent thing in the compose
panel at the moment it happens — above the Send button in visual weight, since
Send has already been pressed and failed.

**Why the hierarchy is weak.** The element carries `role="alert"`, so the
accessibility layer already classifies it as interruptive and a screen reader
announces it. The pixels do not agree. Semantics and visuals have diverged, and
the sighted user is the one who loses.

**How it affects usability.** This is the only finding in the audit that can
cost a user their work. A send that fails silently — indistinguishable from a
status hint — means the user closes the panel believing the message went. The
outbox work exists precisely to prevent that class of loss, and its own error
surface undermines it.

**Concrete improvement.** Give `#c-status` the treatment `.err` already
defines, keyed off the ARIA attribute so the two cannot drift again:

```css
[role='alert']:not(:empty) {
  color: var(--danger);
  font-weight: var(--w-medium);
}
```

`--danger` and `--w-medium` both already exist. `:not(:empty)` keeps the rule
inert until there is something to say, so the normal state is untouched.

**Expected benefit.** A failed send becomes as visible as it is already
announced. **Priority: high** — the only finding here with a data-loss failure
mode.

---

## Screens audited and found sound

Recording these matters as much as the findings — an audit that only reports
hits is not evidence.

| Screen | Primary focal point | Verdict |
|---|---|---|
| **Reader** | Subject (27.85, clear winner) | ✅ correct ordering; see H-6 for grouping only |
| **Compose** | `#c-send` is the only `.primary` in the panel | ✅ send is unmistakable |
| **Command palette** | Single-column list, one highlighted row | ✅ no competition |
| **Gate / sign-in** | One `.primary`, `role="dialog"`, focus lands on it | ✅ |
| **Toolbar** | All six buttons `.ghost`, none competing | ✅ correctly subordinate to content |
| **Menus** | `--z-menu: 40` above `--z-sticky: 3`, `--shadow` applied | ✅ depth matches interaction depth |
| **Toast** | Inverted surface (`--fg` bg), `--z-toast: 80` | ✅ top of the ladder, correctly |
| **Category dots** | Always paired with a text tag | ✅ colour never sole carrier |
| **Timetable / academic panels** | Behind `T`, not on the mail surface | ✅ **stays mail-first** |
| **Deadline radar** | 6-item cap, sits below navigation in the rail | ✅ supports, does not compete |

**On the academic question specifically**, which the brief singles out: the
timetable is a separate screen, the radar is capped at six entries and placed
*below* both navigation groups, and the course chip is a single small token on
the row. Academic features are subordinate everywhere they touch the mail
surface. **No finding.** The product is visually mail-first.

---

## What this audit deliberately did not do

- **No new tokens**, with one flagged exception: H-2 needs a literal `400` or
  a new `--w-regular` token, because the weight scale currently starts at 500.
  Everything else reuses `--fg-dim`, `--fg-faint`, `--line`, `--danger` and
  `--w-medium`, all already defined.
- **No new colour.** H-3 and H-5 *remove* a colour; nothing adds one.
- **No layout changes.** No panel proportions, no grid changes, no spacing
  scale edits.
- **No redesign.** Six of the seven findings are one or two declarations.

## Priority summary

| # | Finding | Cost to user | Fix size | Priority |
|---|---|---|---|---|
| H-7 | Compose send-failure styled as metadata | Can lose data | 1 rule | **high** |
| H-2 | Sender/subject tied in the row | Once per row per scan | 1 declaration | **high** |
| H-1 | Two specs for one heading role | Every rail scan | 1 selector merge | **high** |
| H-6 | No header/body separation in reader | Per long message | 2 declarations | medium |
| H-4 | Date as faint as the snippet | Per date-scan | 1 token swap | medium |
| H-3 | Brand mark is the loudest element | Constant, low | 1 declaration | medium |
| H-5 | `--warning` spent on the logo | Weakens 2 states | folds into H-3 | medium |

The three high-priority items are **three declarations and one selector merge**
between them.

---

## Applied in this pass

The three high-priority findings are fixed. The four medium ones are specified
above and left for a deliberate decision, since each is a taste call as much as
a correctness one.

| # | Change | File |
|---|---|---|
| H-1 | `.rail-heading` folded into the `#views-title, #radar-title` rule | `app.css` |
| H-2 | `.r-from` → `var(--w-regular)`; unread override untouched | `app.css` |
| H-7 | `[role='alert']:not(:empty)` gets `--danger` + `--w-medium` | `app.css` |

**Measured after:** read-row subject 6.95 vs sender 6.42 — an **8.3% gap**,
up from 0.3%. All three sidebar headings compute identically. `#c-status`
renders in `--danger`.

### Two things the existing test suite caught in my own fixes

Worth recording, because they are the reason the design system is worth having:

1. **`font-weight: 400` was rejected** by *"typography, spacing and motion all
   come from tokens"*. The guard was right — a literal bypasses the scale. The
   honest fix was to add **`--w-regular: 400`**, which the scale had always been
   missing: it started at `--w-medium: 500` on the reasoning that unstyled text
   is already 400, and that held only until a rule needed to push something back
   *down* to regular.

2. **A duplicate `.rail-heading` block was rejected** by *"no selector is
   defined twice within one layer"*. I had merged the selector into the shared
   rule but left the original behind, relying on source order — exactly the
   fragile pattern that guard exists to prevent.

Both guards were written in earlier audits. They paid for themselves here.

### A pre-existing bug found while verifying

The radar test *"the heading reports how many and how urgent"* was failing
before any of these changes — confirmed by stashing them and re-running.

`DUE_MESSAGES` seeded `date: Date.now() - 7200_000` with the snippet
*"submit the PS report by today"*. Deadlines are anchored to the message's
**send** date, deliberately, so that opening a three-day-old mail does not push
its deadline forward. Run at 01:34 UTC, a two-hour-old message was sent
*yesterday*, so "today" resolved to yesterday and the radar correctly said
`1 overdue` while the test demanded `today`.

**The product was right; the test was wrong**, and it had been silently
time-dependent — passing for 22 hours of every day and failing for two. Seeds
now anchor to local noon, so the offset cannot cross a day boundary in any
timezone. The behaviour under test is unchanged.

### Verification

- **1245 tests pass, three consecutive clean runs.** (The single failure in the
  run that straddled the radar fix was that test mid-repair.)
- `doctor`, `operators`, `departments` clean.
- **`contrast`: all six themes still pass WCAG AA** — the `--fg-faint` heading
  colour and the `--danger` alert were both re-checked, since a hierarchy change
  that breaks contrast trades one problem for a worse one.
