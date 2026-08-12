# UX & Interaction Intelligence Audit — Round 65 (planning doc)

Status: **Phase 1 audit + prioritized plan**. Implementation checkpoints land as
separate commits named `Round 65/x`. This file is the map they follow.

Method: full interactive-surface inventory of the extension (66 modules in
`src/app`, shell in `app.html`, 6300-line design system in `app.css`),
cross-checked against the interaction-intelligence brief received 2026-08-12
("Maximum UX & Interaction Intelligence Overhaul"). The brief's sixty sections
are distilled to nine friction themes below; each finding cites the code that
evidences it, and each fix names its scope so a checkpoint can be verified
against this document.

---

## §1 What already exists (do NOT rebuild)

The codebase is stronger than the brief assumes. Existing primitives:

- **Command palette** (`palette.js`, Ctrl/Cmd+K): commands, themes, settings,
  contacts search, category jumps, shortcuts listed, recent-style "open last".
- **Keyboard layer** (`shortcuts.js` + `app.js` keydown): j/k navigation, e/s/u
  verbs, `/` search, `?` help, Esc hierarchy, listbox aria-activedescendant.
- **Undo**: verb-level undo after every removal action via toast (`app.js`,
  `bulk.js`, `outbox.js`); optimistic updates with in-flight row marks.
- **Bulk selection** (`bulk.js`, `bulkbar.js`, `autocomplete.js`): checkbox
  column, bulk bar with verbs, select-all-in-view.
- **Drafts** (`draft-store.js`): autosaved, restored on reopen, dirty-dot on
  minimised compose (`body.draft-dirty`), beforeunload guard.
- **Offline**: outbox queue with pump + timers (`outbox.js`), offline toasts,
  degraded-paint notice on full storage.
- **State persistence** (`settings.js` schema): theme, density, rail open,
  saved views, muted/auto-archive categories, snooze — all schema-backed and
  backup/restore round-tripped (`backup.js`).
- **Search** (`query.js`, 545 lines): structured-ish query + `autocomplete.js`
  suggestions with contact/category awareness; results highlight via `mark`.
- **Notices/radar/follow-ups**: classifier-driven "needs you" surfaces with
  reasoning visible (trust-building, already editorialized).
- **Views** (`saved-views.js`): named filter presets, popover UI, counts.
- **Help** (`help.js`): full shortcut sheet; coach toast is one-time
  (`coachDone`), fresh-account coach marking (`sync.js FRESH_ACCOUNT_MS`).
- **Activity log** (`activity-ui.js`): what changed when — audit trail.
- **Reduced motion**, contrast-checked themes (`tools/check-contrast.mjs`),
  pointer-coarse pass, touch-target minimums — accessibility is a real layer.

## §2 Friction findings (ranked by frequency × cost)

**F1 — Reader body actions are one-way.** You can archive/snooze/star from the
reader, but triaging *while* reading still bounces the eye between reader
header pills and list verbs; there is no "archive + next" flow. Gmail's most
used power move (archive-and-advance) is absent. *Fix scope: reader.js +
app.js verb path. A8.*

**F2 — Selection is binary.** Single row OR the view-level select-all.
Ctrl+click additive and Shift+click range selection do not exist on rows (the
row is a button-like listbox option; the checkbox is the only multi handle).
*Fix scope: list.js pointer handling + bulk.js selection model. §6 of brief.*

**F3 — Right-click does nothing on rows/categories is partial.** Categories
have a bespoke context menu (mute / auto-archive — *nice*); rows have none.
Row verbs live in the reader and bulk bar only. *Fix scope: new row context
menu reusing menu.js primitive + existing verbs. Brief §23.*

**F4 — Swipe/none touch verbs.** `@media (pointer: coarse)` increases targets
but no swipe-to-archive on touch rows. Brief §30. *(Deferred to later round:
no touch-device verification harness here; beware unverifiable polish.)*

**F5 — Palette has no recents/context filter.** Everything always listed;
"theme" commands and "jump to" share one flat list when empty. Brief §13/14/18.
*Fix scope: palette.js ranking + MRU in settings schema.*

**F6 — Search has no scopes/chips.** `query.js` parses text; from:/in:/
has:attachment style scoping exists in autocomplete vocabulary but there are no
visible filter chips above the list ("Searching: …" text only), no one-click
clear, no saved-search → view promotion from the result state itself. *Fix
scope: listbar + list.js + saved-views.js. Brief §15/16.*

**F7 — No deep-linking.** State (view, category, query, open message) is
in-memory only; reload loses context. It's an extension page (chrome-extension
URL) but `location.hash` deep links would give Back/Forward and refresh-safety
cheaply. Brief §20/21. *Fix scope: small router in app.js; conservative:
hash mirror, NO history pollution on j/k.*

**F8 — Reader "Open in Gmail" is the only escape to the source.** Copy-link /
copy subject / copy sender address don't exist; campus workflow is "paste the
mail reference into WhatsApp/Slack". *Fix scope: reader.js menu. Cheap, high
campus value.*

**F9 — Error recovery is announce-only.** Toast + `.deadline-bump`-style
anims; failed send retry lives in outbox UI but a failed *classification* or
*sync* offers no retry affordance beyond full refresh. Brief §31. *Fix scope:
status toast gains action slot (exists? partial), sync.js retry wiring.*

**F10 — j/k travel has no "back".** Open message → go back to list jumps top,
not to previous scroll position in some paths (travel.js preserves most;
verify). Audit at implementation time; fix only if probe confirms.

**F11 — Compose is a form, not yet a smart form.** Recipient autocomplete
exists; no send-later, no "did you mean attachment?" nudge (attachment chip
exists but no keyword nudge). *Fix scope: compose.js heuristic nudge. Optional.*

**F12 — Nothing shows what's actionable right now.** The list shows state
(unread, starred, tags) but the *next* action for a hovered/selected row is
not visible until the reader or a key press. Brief §4/5. *Fix scope: row
hover quick-actions — star/archive/delete (Gmail-idiomatic), CSS-only reveal,
reduced-motion safe, pointer-coarse exempt.*

## §3 Plan (checkpoints)

- [x] **65/a — this doc.** (plan commit `4acd15d`)
- [x] **65/b — Row quick actions (F12) + row context menu (F3).** `61da55f`.
  Shipped as planned in `src/app/row-actions.js`; browser-probed hover plate
  (opacity 1, 114px) and overlay-root menu float; screenshots at the time.
- [x] **65/c — Selection v2 (F2).** `908baba`. As built: F2 was partly a
  documentation gap — `selection.js` already had anchor/range/selectAll and
  list.js already wired Ctrl/⌘-toggle and Shift-range. The round taught the
  gestures (help sheet "Pointer" group) and pinned the wiring instead of
  re-building it.
- [x] **65/d — Reader flow (F1) + copy actions (F8).** F1 also turned out to
  be an honesty gap, not a missing flow: `selectNeighbourThen` already
  advanced after archive/trash, so the fix was the label — "Archive & next"
  with a title that says so — plus tests pinning it. F8 shipped as the
  reader kebab (`#r-more`, last control in `#r-actions`): Copy link (Gmail
  URL), Copy subject, Copy sender address, on the shared menu primitive with
  a clipboard-failure fallback that shows the text rather than toasting a
  lie. Verified headless: real clipboard carries the thread URL/subject;
  `test/reader-more.test.mjs` pins the set, order, fallback and visibility.
- [x] **65/e — Search chips + clear (F6).** `src/app/search-chips.js`: the
  round-62 readout slot became an editor — one removable chip per lexical
  token (the parser's own `tokenize`, now exported; free-text runs merge
  into ONE chip because five single-word chips are five deletion tariffs on
  one thought), plus Clear and Save-view trailing. Chips funnel into the
  extracted `applySearchTyping` — the one query-application path typing
  also uses — and Save delegates to the toolbar button so the dialog exists
  exactly once. Two latent bugs found by writing the round: saving or
  removing a view never re-rendered the strip's save affordance (both
  handlers now `renderList()`), and `#listquery[hidden]` needed restating
  because the UA rule loses specificity to `inline-flex`. Fixed-slot
  contract verified in-browser: listhead 41px and scroller top identical
  before/after; integration test drives type → chip → remove → save →
  clear through the real boot.
- [x] **65/f — Palette context + recents (F5).** Untyped opens now lead
  with a "Recent" group (MRU ≤ 4, persisted as JSON-in-string
  `paletteRecents` — withheld from backups as usage history via the
  WITHHELD decision list), then "Everything" in canonical order; typed
  queries stay pure fuzzy because explicit intent outranks habit. Inert
  commands became honest: with an empty stack, Undo renders disabled with
  "Nothing to undo" in the shortcut slot — click/Enter refuse without
  closing (reason stays on screen), arrows skip it through a bounded walk,
  and the first-runnable-row rule keeps the initial highlight runnable.
  Selection-gated commands still vanish whole (never state-ambiguous, just
  absent — a different doctrine, deliberately kept). Browser-verified and
  integration-driven end to end.
- [x] **65/g — Hash deep links (F7).** `src/app/deep-links.js`:
  `#inbox/augsd?q=…&m=…` round-trips through format/parse; deliberate views
  (category, mailbox, settled runQuery) push ONE history entry each; every
  settled frame mirrors the full state via replaceState only, so j/k and
  typing can never pollute history (pinned in source: nothing outside
  deep-links.js calls the History API). popstate and boot share one apply
  path through the shell's own navigation functions with echo suppression;
  a deep-linked message that has not synced yet latches until its data
  lands. Writing the round surfaced a real bleed: each sandboxed-iframe
  srcdoc write was a joint-session-history entry (+2 per message read —
  Back would have chewed forty dead items per twenty mails). Fixed in
  reader.js as `writeBodyDoc`: swap-in an identical fresh frame per write
  (attrs clone across, sandbox intact; the load handler became a
  parameter), measured zero net entries over four reads, Back walking
  views one press per view. Integration drives boot → category → type →
  j/k → real back()/forward() restorations, plus cold-load at a deep link.
- [ ] **65/h — Recovery polish (F9):** toast action slots wired to retry for
  sync/classify failures where cheap; outbox retry surfaced in rail card.
- [ ] **65/i — Final pass:** re-run interactive flows headless at 3 widths,
  evidence table, doc close-out.

Deferred with reasons: touch swipes (F4 — no verifiable harness), compose
nudges (F11 — false-positive risk on campus mail vocabulary), global
redo-with-history (verb-level undo covers the actual risk surface).

## §4 Guardrails (from the brief, bound to this repo)

- Every checkpoint: targeted tests green (`node --test` per touched suite),
  screenshot proof where visual, commit + push.
- Overlay/motion/z rules from OVERHAUL-V3 R1–R8 remain law; new primitives
  mount under `#overlay-root`, use `--z-*` tokens, finite animations only.
- app.js is 3.5k lines; NEW interaction modules go in their own files
  (`row-actions.js`, `deep-link.js`, …) with wiring imports — modularity rule
  from the brief's closing note.
- Tests that pin retired behavior are updated deliberately, with comments
  naming the round, never silently loosened.
