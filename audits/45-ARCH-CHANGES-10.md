# 10 beneficial architectural changes (round 45)

Companion audits: `45-UIUX-PROBLEMS-50.md`, `45-UIUX-IMPROVEMENTS-50.md`.

Charter, carried from every round before this one: **no rewrites.** app.js
stays one file, the Store stays, the layer model stays. Everything below is
an ADDITIVE structural investment — each one earns its place by naming the
class of bug it retires, with evidence from the audit trail.

Ordered by leverage: the first four retire bug classes this project has
already paid for; the rest are insurance against the ones it is about to.

---

## 1 · Shared outbox core (`src/shared/outbox-model.js`)

**Evidence:** the worker now imports app-layer `outbox.js` AND `snooze.js`
— two worker→app edges, and audit 44 confirmed the debt is no longer
theoretical. This round's fallback bug (outbox imported but never passed to
`makeHandler`) is exactly the confusion the edge invites.

**Shape:** move the pure queue model — state machine, `dueItems`,
`prioritizeDue`, `markFailed`, `attemptsAfterFailure`, `normaliseOutbox` —
into `src/shared/`. App keeps the UI runner, worker keeps dispatch, both
import down. Follow the labels.js/limits.js seam doctrine exactly.

**Retires:** the third worker→app edge before it happens; model drift
between the two dispatch paths.

## 2 · Storage schema registry

**Evidence:** the `imageAllowList` vs `imageAllow` backup fiction, the
`messageCache` vs `msgCache` NEVER_EXPORT fiction, claims entries that
never get GC'd, snoozes resurrected across accounts — four rounds of bugs
with one root: ~14 storage keys defined in ~10 modules, each with its own
spelling, owner and lifecycle.

**Shape:** one module enumerating every key: `{ key, owner, shape,
backupPolicy, sessionScoped, gc }`. Backup, restore, sign-out clearing and
claims GC all read from it. A test asserts no module touches a key it does
not own.

**Retires:** the entire fiction-key bug class, permanently.

## 3 · One UI-primitive layer (toast · dialog · menu)

**Evidence:** four native `confirm()`s survive beside an in-app dialog
primitive; focus-return is tested for two surfaces and absent for others;
toast replacement semantics fight the shared-element ghost (45-problems
#12/#14); error/success differ by a 2px colour edge only.

**Shape:** promote `dialog.js`/`menu.js`/toast into one primitives module
with ONE focus contract (trap, return, Esc) and ONE announcement contract
(role=alert vs status chosen by kind). Native `confirm()` becomes a lint
error.

**Retires:** the two-voice confirmation problem, focus-stranding after
bulk actions, the silent-error accessibility gap.

## 4 · Motion & density token layer

**Evidence:** ten distinct durations, three easing families, density defined
by scattered overrides; the reader iframe never receives density at all;
reduced-motion needed a special block to zero stagger delays someone forgot
were motion.

**Shape:** `--motion-fast/base/slow`, `--ease-out-standard` etc. as CSS
custom properties beside the existing spacing scale, plus a documented rule
(enter = base, exit = fast, stagger ≤ fast). Density extends its token set
into the reader frame contract (#5).

**Retires:** per-surface motion invention; makes reduced-motion auditing a
grep instead of a hunt.

## 5 · Reader frame contract module

**Evidence:** the reader's safety rests on three coupled artefacts — the
iframe sandbox attributes in app.html, the generated CSP meta, and the
sanitiser's allow-lists — that live in three files and were unpinned until
this round. The `#r-body` white background leak (45-problems #1) is the
same coupling failing cosmetically.

**Shape:** one module owns the frame's contract: sandbox flags, CSP
generation, theme/density/typography inputs. app.html and renderBody
consume it; the existing reader-security tests grow into its suite.

**Retires:** the next "someone edited one side of the reader" incident,
security or cosmetic.

## 6 · Render-pipeline memoisation layer

**Evidence:** lane counts and `idsFor(category)` walk the full order array
per render with no memo; at the 2000-message cap every refresh pays O(n)
several times over (44-problems #22, 45-problems #28).

**Shape:** a tiny version-stamped memo around the derived reads —
store-version + key → result — invalidated by `_flush`. The selectors
extraction (R-6) already made the reads pure; memoising pure reads is
mechanical and reversible.

**Retires:** the large-mailbox sidebar cost before it becomes a complaint;
keeps the no-framework ruling intact.

## 7 · Coverage gate in CI

**Evidence:** the suite can only grow or break, never visibly shrink;
audit after audit found modules with zero coverage (activity-ui at round
44) and contracts pinned by nothing (autocomplete ARIA, 45-problems #35).

**Shape:** a threshold floor per directory (app, background, classify,
platform) that fails CI when coverage drops. Ratchet up on every new
module.

**Retires:** silent coverage erosion — the meta-bug behind several
"nobody tested this" findings.

## 8 · Accessibility assertion harness in CI

**Evidence:** ARIA is structurally present and individually tested, but no
automated pass walks a rendered surface; the screen-reader debt (TODO #10)
has no bridge between "attributes exist" and "it's usable".

**Shape:** axe-core (or equivalent) run in the existing jsdom harness over
six key surfaces: list, reader, compose, palette, timetable, gate — failing
on critical/serious violations.

**Retires:** whole classes of a11y regressions cheaply, and gives the
eventual real-SR pass a clean baseline.

## 9 · Visual regression across themes × densities

**Evidence:** the `#r-body` white leak shipped through six audit rounds —
nothing inspects pixels, so colour bugs are invisible until a human opens a
dark theme. The contrast checker audits the PALETTE; nothing audits the
RENDERED result.

**Shape:** screenshot diffing of the six core surfaces across all six
themes and three densities (headless Chromium already ships for the
smoke path). Baseline once; diff forever.

**Retires:** theme leaks, density gaps and motion-freeze artefacts as a
class — the exact family of 45-problems #1/#3/#16.

## 10 · Layout contract tests (breakpoints & resize)

**Evidence:** two breakpoints, nothing below 860px, no test exercises a
resize at all (45-problems #45/#47). The app's desktop assumption is
currently protected by nothing.

**Shape:** declare the supported widths as a contract; jsdom resize
scenarios assert the structural guarantees that matter (list reachable,
bulk bar usable, reader opens) at each. When a new width is supported, the
contract grows; when the layout breaks at one, CI says which.

**Retires:** the "it broke on a narrow window and nobody knew" family, and
makes responsive work testable instead of eyeballed.

---

## What this list deliberately excludes

- **Splitting app.js** — the project's standing non-goal; line count is a
  metric to watch (44-problems #75), not a trigger.
- **A state framework** — the store + selectors model is pure and tested;
  replacing it buys nothing.
- **Claims v2 / transactional storage** — parked until degraded-mode
  dispatch matters more than it does.
- **Component-scoped CSS or a build pipeline** — zero-dependency is a
  feature this extension ships on.

Each of the ten is one focused change with a testable end state. Taken in
order, they retire the bug classes this project has actually paid for —
which is the only honest definition of architectural progress.
