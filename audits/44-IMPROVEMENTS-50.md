# Improvements audit — 50 opportunities (round 44)

Companion to `44-PROBLEMS-75.md`. By design this list contains **no
defects**: every entry is an addition, an upgrade, or an investment —
something the product does not have yet, not something it does wrong.
Grouped so a focused pass can take a whole section at once.

---

## A · Product features (1–16)

1. **Send later.** The outbox already holds messages for the undo window;
   extending `releaseAt` to an arbitrary future turns it into scheduled
   send — the single most requested Gmail-parity gap.
2. **User-selectable notification categories.** Background notifications
   currently hardcode augsd/academics; make the allow-list a setting with
   the same conservative defaults.
3. **Follow-up reminders.** Follow-ups resolve silently; a worker alarm
   that nudges "you're still waiting on Prof X" closes the loop the
   feature was built for.
4. **Custom snooze date/time** beside the four presets — "after exams" is
   a real student need the presets can't express.
5. **Deadline weekly digest.** One Sunday summary of the radar ("3 due
   this week") beats seven separate glances.
6. **Attachment preview.** Images and PDFs inline in the reader before
   download; the budget machinery to do it safely already exists.
7. **Drag-and-drop attachments** into the compose panel.
8. **Per-context signatures** (academic / clubs / personal) selected by a
   one-key toggle.
9. **Rule templates.** Pre-built "mute newsletters", "star the Dean",
   "archive placements after 2 weeks" — the rule engine is powerful and
   undiscoverable.
10. **Saved views pinned to the sidebar** instead of buried in the palette.
11. **Search operator cheatsheet** rendered under the search box on focus —
    the grammar is the product's secret weapon and nobody can see it.
12. **Timetable ICS export** — every phone calendar can import the term.
13. **Timetable clash warnings** when adding two sections that overlap.
14. **Course-aware compose**: composing to an instructor auto-suggests the
    course code in the subject (the data is already in the timetable).
15. **Activity log export** (JSON/CSV) for diagnostics and peace of mind.
16. **Bulk progress with counts** and a cancel-between-batches affordance.

## B · UX & accessibility (17–28)

17. **Keyboard-path into conversations** (Enter/right-arrow expands a
    collapsed thread) — completes j/k as a full navigation surface.
18. **Focus mode**: one key hides everything except the deadlines lane.
19. **Reader typography settings** — font size and serif/sans, persisted;
    the iframe plumbing for density already shows the way.
20. **High-contrast theme** alongside the existing palette.
21. **`aria-live` on the new-mail pill** and on lane-count changes, so
    arrivals and reclassification are audible, not just visible.
22. **Replace the four surviving native `confirm()`s** with the in-app
    dialog primitive, starting with the destructive timetable wipe.
23. **Toast queueing for distinct kinds** so an error is never silently
    replaced by a success half a second later.
24. **Onboarding tour** beyond the coach mark: three screens showing
    categories, deadlines, and the takeover chord.
25. **Printable shortcuts cheat-sheet** from the `?` overlay (one button).
26. **Compose char/attachment budget indicators** before the user hits a
    server-side wall.
27. **Empty-state education**: an empty lane explains what would land
    there, turning dead space into teaching.
28. **i18n groundwork** — extract the string table now so a Hindi pass is
    ever possible; today every string is inline.

## C · Architecture & reliability (29–38)

29. **Shared outbox core extraction** (`src/shared/outbox-model.js`) — the
    worker now imports app-layer queue logic; give the pure core a neutral
    home before the third importer appears.
30. **Behavioural parity runner**: a table-driven harness that executes the
    same inputs against worker handler, fallback handler, and fake worker,
    diffing observable outputs — the contract tests' executable cousin.
31. **One exported failure-classification predicate** (the same-error and
    attachment-loss rules currently live in three places).
32. **Global `unhandledrejection` observer** writing to the activity ring —
    observability for the modules that never call reportError.
33. **Read-path body cache** (bounded LRU of getFull results) to cut
    repeated round trips on reopen.
34. **Versioned verb contract**: worker and app exchange a protocol
    version at AUTH_STATUS, so skew answers "update" instead of raw text.
35. **Account-scoped snoozes** (namespace the storage key) so multi-account
    users and backup restore can never cross streams.
36. **Claims v2 only if ever needed**: a worker-transactional dispatch for
    degraded mode — explicitly parked until degraded mode matters more.
37. **Storage usage dashboard** in options (cache/outbox/claims/draft
    bytes) — quota surprises become visible before they bite.
38. **Backup scheduler**: weekly automatic export with a two-backup
    rotation, opt-in.

## D · Testing & CI (39–45)

39. **Coverage gate in CI** — a floor the suite cannot silently drop below.
40. **Benchmark thresholds in CI** (`bench.mjs` gains budgets and fails on
    regression instead of printing).
41. **Property-based test harness** for the parser family (parseDaysHours,
    parseQuery, deadlines, addresses) — round-trip and no-crash properties.
42. **2000-message load test** as a standing integration scenario, so
    eviction, indexing and render costs are exercised every run.
43. **CSP/sandbox pins**: assert the generated srcdoc keeps its meta CSP
    and the body iframe keeps its sandbox attributes.
44. **Explicit DOM-condition waits** to retire `settle(N)` heuristics from
    timing-sensitive tests.
45. **Mutation-testing cadence**: the sabotage discipline is ad hoc and
    brilliant; schedule it (one module per week) before it depends on one
    person remembering.

## E · Documentation & process (46–50)

46. **Architecture decision records index** — the codebase's comments are
    already ADRs in spirit; an index file would make "why" navigable
    without reading 25,000 lines.
47. **CONTRIBUTING quickstart**: exact commands for targeted tests, the
    sabotage method, and the forced rules (no full-suite locally, main-only
    workflow).
48. **Release checklist**: manifest version bump, TODO freshness, audit
    file of the round, credential rotation reminder.
49. **Real-inbox runbook** (TODO #1 turned into a script): a repeatable
    checklist for the first live run, so the browser-validation debt gets
    paid in one sitting instead of forever.
50. **Verb threat-model template**: every new worker verb answers four
    questions (input trust, failure shape, parity, timeout) in its commit
    message — the lesson of every audit this project ever ran, written
    down once.

---

## How to use this list

- **A** is product roadmap material — sequence by user value, not by ease.
- **B** belongs to the focused UX/accessibility pass the triage prescribed.
- **C** is the only section that touches structure — and even it is
  additive, not a rewrite.
- **D** multiplies the value of every future audit: the better the net,
  the cheaper the hunt.
- **E** is one afternoon each and compounds.

None of this is required for stability. The system is functionally
stabilized; this is the list of what makes it *good* rather than *sound*.
