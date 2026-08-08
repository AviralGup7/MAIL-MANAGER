# Audit 22 — UI Completeness

Not a polish audit, not a hierarchy audit, not a redesign. One question:
**where does the interface still feel like it needs one more pass?**

Completeness here means: a control has every state it needs, a surface says
something useful when it has nothing to show, and capability that exists in the
code is actually reachable by a user.

## Method

Measured, not impressionistic:

- **State coverage** — the stylesheet parsed into a selector table, then every
  interactive component checked for `:hover`, `:focus-visible`, `:active` and a
  disabled variant.
- **Reachability** — every background verb cross-referenced against app-layer
  callers; every module against the import graph; every DOM id against JS
  references.
- **Empty states** — `app.html` booted in jsdom, every list container inspected
  for what it renders with zero children.

## Two things this audit expected to find and did not

Recording these because an audit that reports only hits is not evidence.

**Focus states are complete.** My first probe reported focus missing on nine of
nineteen components. That was the probe being wrong: a global
`:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`
covers every focusable element, with four components overriding it where the
default outline would clip. No finding.

**The reader header/body separation is complete.** Audit 21 recorded H-6 as a
missing separator between metadata and body, reasoning from typography scores
alone. `#reader-head` in fact carries *both* `border-bottom: 1px solid
var(--line)` **and** a distinct `background: var(--bg-raised)` — a stronger
grouping signal than the hairline I proposed adding. **H-6 is retracted.** It
was measured from the wrong evidence: I compared text weights and never looked
at the container.

---

## C-1 · Eleven modules are built, tested, and have no interface — **the finding**

**What feels unfinished.** Nothing, visually — and that is the problem. The
product looks finished because the features that would change how it looks are
not connected to it.

**Where it appears.** Everywhere and nowhere. Measured against the import graph:

| Module | Lines | Tests | Imported by the app |
|---|---|---|---|
| `outbox.js` | 321 | 21 | **no** |
| `rule-engine.js` | 347 | 33 | **no** |
| `templates.js` | 271 | 27 | **no** |
| `activity.js` | 229 | 20 | **no** |
| `followups.js` | 192 | 22 | **no** |
| `deadline-store.js` | 223 | ~15 | **no** |
| `my-courses.js` | 237 | ~15 | **no** |
| `notices.js` | 271 | ~14 | **no** |
| `lanes.js` | 218 | 21 | **no** |
| `suggest.js` | 252 | 25 | **no** |
| `backup.js` | 251 | 21 | **no** |

**Why it feels incomplete.** This is the purest form of "functionality that
exists but is not surfaced in the UI", which the brief names explicitly. A user
running the current build has no outbox, no undo-send, no templates, no rule
engine, no activity log and no backup — while the test suite reports 1245
passing tests covering all of them.

**What a finished version would include.** Each module needs one entry point:

| Module | The one surface it needs |
|---|---|
| `outbox.js` | a rail row that appears only when non-empty, + the undo-send toast |
| `templates.js` | a button in the compose toolbar |
| `activity.js` | `record()` called from the mutation paths, then a log screen |
| `suggest.js` | a dropdown under the existing search field |
| `backup.js` | two buttons in options |
| `deadline-store.js` | "Set deadline" / "Not a deadline" in the reader |
| `followups.js` | a reader toolbar button + a radar section |
| `lanes.js` | section headers in the existing list renderer |
| `my-courses.js` | an enrolment picker + a chip on the row |
| `notices.js` | a pinned card above the list |
| `rule-engine.js` | an editor in options — **must ship with its dry run** |

**Missing state or control.** All of them.

**Importance.** Highest in this document by a wide margin. Every other finding
here is a refinement of something a user can see; this is eleven features they
cannot.

**Fix first.** `activity.js` — nothing calls `record()`, so the log is empty as
well as unread, and ten downstream ideas depend on it. Then `outbox` +
`templates`, which share the compose surface.

---

## C-2 · The saved-views section renders a heading over dead whitespace

**What feels unfinished.** With no saved views, `#views` shows the label
"VIEWS" and then nothing — an empty `<ul>` with no copy, no hint, and no
affordance to create one.

**Where it appears.** Sidebar, top section, on any profile where the built-ins
have been dismissed or a view has been deleted.

**Why it feels incomplete.** Verified in jsdom: `#views-list` renders zero
children and `renderViews()` has no zero-length branch. `#views` itself is
never hidden. Compare with `#radar`, which *does* hide when it has nothing —
so two adjacent rail sections handle emptiness in two different ways, and one
of them leaves a titled void.

A heading over blank space is the single most recognisable "unfinished" signal
in a UI. It says a feature exists without saying what it is or how to start.

**What a finished version would include.** One line of muted copy in the empty
slot — *"Save a search to keep it here"* — which explains the feature at the
only moment the user is looking at its absence. This is what `#empty` already
does for the message list (*"You're all caught up / Nothing in this view"*), so
the idiom exists and is not being applied consistently.

**Missing state.** The empty state.

**Importance.** Medium-high — cheap, and it is visible on a fresh profile,
which is the first impression.

**Fix first.** Yes: one element, one string, reusing `.hint`.

---

## C-3 · The palette has no "no matches" state

**What feels unfinished.** Typing a query in the command palette that matches
nothing leaves the list blank while the input stays focused. The palette does
not close, does not explain, and does not offer a fallback.

**Where it appears.** `Ctrl+K` → any unmatched string.

**Why it feels incomplete.** Measured: `palette.js` has no zero-length branch
at all. Every other search surface in the product handles this — the message
list has `#empty`, and search has `#search-note`. The palette is the one that
silently shows nothing.

This is worse than an ordinary empty list because a palette is *modal and
keyboard-driven*: the user has committed to a flow, typed, and received no
signal at all about whether the command exists or they mistyped.

**What a finished version would include.** A single muted row —
*"No command matches 'xyz'"* — and, since the palette already knows the query
string, a fallback action: *"Search mail for 'xyz'"*, which turns a dead end
into the thing the user probably wanted.

**Missing state.** The empty state and the fallback action.

**Importance.** Medium-high. Low frequency, but it happens at the exact moment
the user is trying to move fast.

**Fix first.** Yes, alongside C-2 — same idiom, same size.

---

## C-4 · RETRACTED — mailbox rows already have every state

**The claim was:** the mailbox rows (Inbox, Sent, Drafts, Trash, Spam) carry no
`:hover` or `:active`, while their `.cat` siblings do.

**It is false.** `mailboxButton()` builds them with
`b.className = 'cat mailbox'` — they *are* `.cat` rows with a modifier, so they
inherit `.cat:hover`, `.cat:active` and the `translateX(2px)` nudge in full.

**Why the probe was wrong.** It searched the selector table for a `.mb` class,
inferring the name from `.mb-icon`, which does exist. `.mb-icon` is a child
element inside a `.cat` row; there has never been a `.mb` block. The probe found
no rules for a class that was never used and reported the absence as a gap.

Recorded rather than deleted. The lesson is the one this project keeps
relearning: a probe that infers a selector name rather than reading the code
that emits it will confidently measure something that does not exist.

---

## C-5 · `.tag`, `.palette-item` and `.radar-item` have no pressed state

**What feels unfinished.** Three clickable surfaces respond to hover but not to
the click itself. `.snooze-opt` and `.cat` both have `:active`; these do not.

**Where it appears.** Category tags on message rows, command palette rows,
deadline radar entries.

**Why it feels incomplete.** On a trackpad the gap between press and result is
where a UI feels either responsive or laggy. Hover says "this is clickable";
`:active` says "I heard you". Without it a slow action reads as a missed click,
and the user clicks again.

`.radar-item` is the worst of the three: it opens a message, which involves a
network fetch, so it has the longest gap to cover and no feedback during it.

**What a finished version would include.** The existing `:active` idiom —
`transform: scale(0.98)` or the `--bg-sunken` press already used elsewhere.

**Missing state.** Pressed.

**Importance.** Medium.

**Fix first.** Yes — one rule, three selectors.

---

## C-6 · Two icon-only buttons carry no accessible name

**What feels unfinished.** `#empty-action` and `#toast-action` render with no
text, no `aria-label` and no `title`. They are labelled at runtime by JS, which
means that between first paint and the JS assignment they are unnamed, and if
the assignment path is ever missed they are permanently unnamed.

**Where it appears.** The empty-state call to action; the toast's Undo button.

**Why it feels incomplete.** `#toast-action` is the **Undo** affordance. It is
the recovery control for every destructive action in the product, and it is the
one button in the document with no name in the markup. Every other icon button
in `app.html` carries either text or a `title`.

**What a finished version would include.** A default `aria-label` in the markup
that JS overwrites, rather than one that JS must supply.

**Missing state.** The default label.

**Importance.** Medium-high for `#toast-action` specifically — it is the undo
button.

**Fix first.** Yes, trivially.

---

## C-7 · `WAKE_DUE` is the one background verb with no app-layer caller

**What feels unfinished.** Snoozed mail wakes on a worker alarm, and the app
has no path to trigger or observe it. There is no "Snoozed" view, no count, and
no indication that anything is scheduled.

**Where it appears.** Absent from the rail entirely.

**Why it feels incomplete.** A user who snoozes a message gets a toast and then
has no way to answer "what did I snooze, and when does it come back?" — the
mail is simply gone until it reappears. `SNOOZE` and `UNSNOOZE` both have UI;
the third member of the trio does not, so the feature is two-thirds surfaced.

Related and confirmed by discovery audit 20: search cannot see snoozed mail
either, so the message is unreachable by any route until its alarm fires.

**What a finished version would include.** A "Snoozed" rail entry with a count,
listing pending items with their wake times — `snooze.js` already exports
`pending()` and `wakeLabel()`, both unused by any UI.

**Missing control.** The view.

**Importance.** Medium-high — it is a trust gap. Mail the user deliberately
hid should be findable.

**Fix first.** After the C-2/C-3 batch.

---

## What was audited and found complete

| Surface | Verdict |
|---|---|
| Global focus ring | ✅ one rule covers everything; 4 deliberate overrides |
| Reader header/body grouping | ✅ border **and** raised surface — audit 21's H-6 retracted |
| `#empty` (message list) | ✅ icon, title, subtitle, contextual action |
| `#reader-empty` | ✅ icon, prompt, **and a keyboard hint** — the best empty state in the app |
| Loading | ✅ `#skeleton` for the list, `#r-loading` body-shaped placeholder for the reader |
| Disabled variants | ✅ `.primary`, `.ghost`, `.att-chip` all have them |
| Compose | ✅ Cc/Bcc progressive disclosure, attachment chips, status line, autocomplete lists |
| Bulk bar | ✅ 5 actions + select-all, hidden until selection exists |
| Menus | ✅ unified through `menu.js`, focus-managed, `--z-menu` above content |
| Gate | ✅ `role="dialog"`, `aria-modal`, focuses the primary, has an error slot |
| Help overlay | ✅ generated from the shortcut registry, so it cannot drift |
| Toast | ✅ inverted surface, top of the z-ladder, action slot |
| Academic surfaces | ✅ timetable behind `T`; radar capped at 6 and **hides when empty** |

**On the identity rule:** the radar is the only academic surface on the mail
screen, it is capped at six entries, it sits below both navigation groups, and
it hides itself when it has nothing to say. The inbox remains the centre of
gravity. No finding.

---

## Priority

| # | Finding | Size | Priority |
|---|---|---|---|
| C-1 | 11 modules with no interface | large | **highest** |
| C-6 | Undo button has no accessible name | 2 attributes | **high** |
| C-2 | Saved views: heading over empty space | 1 element | high |
| C-3 | Palette: no "no matches" state | 1 branch | high |
| C-7 | No Snoozed view | 1 rail entry + list | medium |
| C-5 | Three surfaces missing `:active` | 1 rule | medium |

C-2, C-3, C-5 and C-6 are **four small, self-contained fixes** (C-4 was
retracted). C-1 is the real work
and is tracked in `docs/BUILD-PLAN.md`.

---

## Applied in this pass

Every finding except C-1 and C-7 is fixed. C-1 is the wiring work tracked in
`docs/BUILD-PLAN.md`; C-7 (a Snoozed view) needs a new rail surface and list
renderer, which is a feature rather than a completion.

| # | Change | Files |
|---|---|---|
| C-2 | `#views-empty` — *"Save a search to keep it here."*, toggled by `renderViews()` | `app.html`, `saved-views.js`, `app.css` |
| C-3 | Palette no-match row quoting the query, with a **working** search fallback | `palette.js`, `app.css` |
| C-5 | `:active` on `.tag`, `.palette-item`, `.radar-item` | `app.css` |
| C-6 | `aria-label` in the markup for `#toast-action` and `#empty-action` | `app.html` |

Also applied from audit 21, whose medium findings were outstanding:

| # | Change |
|---|---|
| H-3/H-5 | Brand mark: glow removed, gradient moved inside one hue family so `--warning` is no longer permanently on screen |
| H-4 | `.r-date` → `--fg-dim`, so the date forms a scannable column instead of sharing the snippet's layer |
| H-6 | **Retracted** — the reader already separates header from body |

**1249 tests pass. All six themes still pass WCAG AA.** Three sabotages run
against the new tests; all three failed as they should.

### Two of my own findings were false, and one of my own fixes was wrong

Worth recording, because the corrections came from checking rather than from
review:

**C-4 was false.** I reported that mailbox rows had no hover or active state.
They are built with `className = 'cat mailbox'` — they *are* `.cat` rows and
inherit everything. The probe had inferred a `.mb` class from the existence of
`.mb-icon`; no such block has ever existed, so it measured the absence of rules
for a selector that is never used.

**H-6 was false**, for the same shape of reason: I compared typography weights
between the reader's metadata and its body and concluded there was no
separation, without looking at the container. `#reader-head` carries both a
`border-bottom` and a `--bg-raised` surface.

**The `:active` fix was initially wrong.** `.radar-item:hover` already sets
`transform: translateX(2px)`, and a bare `scale()` on `:active` *replaces* a
transform rather than composing with it — so pressing a radar entry would have
snapped it left before opening. Caught by grepping the selectors for existing
transforms before adding the rule; `.radar-item:active` now composes both.

The pattern across all three: **a probe that infers structure rather than
reading the code that emits it will confidently measure something that is not
there.**
