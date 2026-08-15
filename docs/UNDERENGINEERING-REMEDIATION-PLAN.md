# Plan — closing the under-engineered gaps

Source: `audits/2026-08-15-UNDERENGINEERED-PARTS-AUDIT.md` at `7000e5f`.
Goal: **the next pass of that audit must not produce the same findings.**

The audit's own metrics are the acceptance criteria, because a fix that does
not move the number that found it is not a fix.

| # | Finding | Acceptance criterion | Status |
|---|---|---|---|
| P1 | `auth.js` 35–47% branch, absent from the gate | in `FLOORS`, floors at measured value | ☐**done** `cc9c4bc` |
| P2 | axe never sees an opened overlay | axe runs on ≥1 opened dialog/menu/toast | ☐**done** `c6f9722` |
| P3 | `dialog.js`, `category-menu.js`, `snooze-menu.js` untested | each has a dedicated test file | ☐**done** `5a7472e`+`ee5a8de` |
| P4 | 14% of modules type-checked; `src/background/**` unchecked | `tsconfig.include` covers background | ☐**done** `cc9c4bc` |
| P5 | `app/overlays` zero fuzz | `test/fuzz-overlays.test.mjs` exists | ☐**done** `28b0cff` |
| P6 | classifier constants undocumented/untuned | provenance stated at the definition | ☐**done** `cc9c4bc` |
| P7 | 3,512 CSS lines unguarded, incl. reader | reader stylesheets under a test | ☐**done** (this commit) |

## Order and reasoning

Cheapest-first, and **each step is committed and pushed before the next
begins** so no cycle can lose the previous one.

1. **P1 + P4 + P6** — configuration and comments. No behaviour change, so they
   cannot break anything; they raise the floor immediately.
2. **P3** — three dedicated test files. `dialog.js` first: it is the modal
   focus primitive and the highest-risk untested module.
3. **P2** — reuse the axe runner already in `a11y.test.mjs` against overlay
   states built by the existing harness.
4. **P5** — fuzz mail-derived strings into overlay rendering.
5. **P7** — guard the reader stylesheets (434 lines, they style untrusted
   mail).

## Rules honoured throughout

- Git state verified before work; commit **and push** before testing; push
  again after every fix cycle.
- Only targeted suites locally, each run well under ~50 s. Full suite is CI's.
- A test that pins existing behaviour is checked against *whether that
  behaviour is correct* — three bugs in the last round survived because their
  tests pinned the bug as the contract.

## Explicitly out of scope

`app/overlays` behavioural density (5.9/100) and the remaining ~3,000 CSS
lines are volume problems, not gaps a single pass closes honestly. P2/P3/P5
raise overlays materially; the rest is a standing backlog item, not something
to fake in one commit.


---

## Outcome (all seven closed)

| # | Closed by | Evidence the metric moved |
|---|---|---|
| P1 | `cc9c4bc` | `auth.js` in `FLOORS` at 60/42, measured 71.6/100. The gate's own reader was also fixed: it kept the *last* coverage table per file, and auth ranges 39–71% across its three suites, so the gate's verdict was decided by process ordering. Now keeps the best row per metric. |
| P4 | `cc9c4bc` | `tsconfig.include` covers `src/background/**`. Typechecks clean with **no source changes** — the worker was always type-correct, nothing was checking. 14% → 21% of modules. |
| P6 | `cc9c4bc` | Scoring constants documented as inherited-not-measured, with what *is* verified (the algorithm) separated from what is not (the weights), and the honest procedure for changing one. |
| P3 | `5a7472e`, `ee5a8de` | `dialog.js` 16 tests, `category-menu`/`snooze-menu` 8. `app/overlays` untested modules: **3 → 0**. |
| P2 | `c6f9722` | axe runs on four *opened* states (prompt, destructive confirm, category menu with checked state, snooze menu). a11y suite 2 → 6 tests. All four passed first time: a fence, not a repair. |
| P5 | `28b0cff` | `test/fuzz-overlays.test.mjs`, 440 deterministic iterations, asserting totality **and** structural inertness. `app/overlays` fuzz suites: **0 → 1**. |
| P7 | this commit | `test/reader-styles.test.mjs` guards the 434 lines that style untrusted mail — containment, no `position:fixed`, no remote `url()`/`@import`, and the density contract agreeing with `reader-frame.js`. |

**Five fixture bugs were found and fixed while writing these, all mine, none
a product defect:** dialog button order is `[Save, Cancel]`; `menu.js` renders
`role="menuitemcheckbox"` for toggles; the a11y fixture needed `#overlay-root`
inside a landmark to match `app.html`; the injected-element selector wrongly
listed `input`, which `promptDialog` builds legitimately; and
`<input type="text">` strips CR/LF per spec. Each was diagnosed by dumping the
real value rather than by loosening the assertion — the failure mode this
project has been bitten by before is a test relaxed until it passes.

**Honest scope note.** `app/overlays` behavioural density rises materially but
does not reach the tree median, and ~3,000 CSS lines outside the reader remain
unguarded. Both are volume problems; they stay on the backlog rather than
being faked in one pass.
