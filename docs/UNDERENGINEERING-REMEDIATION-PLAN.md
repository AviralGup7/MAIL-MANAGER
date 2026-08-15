# Plan — closing the under-engineered gaps

Source: `audits/2026-08-15-UNDERENGINEERED-PARTS-AUDIT.md` at `7000e5f`.
Goal: **the next pass of that audit must not produce the same findings.**

The audit's own metrics are the acceptance criteria, because a fix that does
not move the number that found it is not a fix.

| # | Finding | Acceptance criterion | Status |
|---|---|---|---|
| P1 | `auth.js` 35–47% branch, absent from the gate | in `FLOORS`, floors at measured value | ☐ |
| P2 | axe never sees an opened overlay | axe runs on ≥1 opened dialog/menu/toast | ☐ |
| P3 | `dialog.js`, `category-menu.js`, `snooze-menu.js` untested | each has a dedicated test file | ☐ |
| P4 | 14% of modules type-checked; `src/background/**` unchecked | `tsconfig.include` covers background | ☐ |
| P5 | `app/overlays` zero fuzz | `test/fuzz-overlays.test.mjs` exists | ☐ |
| P6 | classifier constants undocumented/untuned | provenance stated at the definition | ☐ |
| P7 | 3,512 CSS lines unguarded, incl. reader | reader stylesheets under a test | ☐ |

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
