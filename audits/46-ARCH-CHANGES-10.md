# 10 beneficial architectural changes (round 46)

Charter, unchanged from round 45: no rewrites. app.js stays one file, the
Store stays, zero-dependency shipping stays. Every item below is additive,
earns its place by naming what it retires, and is ordered by leverage.
Two are carried from round 45's deferred list — they are repeated here
because this round's evidence, not historical memory, is what promotes
them.

---

## 1 · Shared outbox core (`src/shared/outbox-model.js`)

**Why now:** round 45's chunked-progress work moved MORE policy into the
app (progress toasts, cancel semantics, applied-id tracking) while the
worker keeps dispatch — the model now has three readers (worker pump, app
runner, harness) and no neutral home. The round-45 fallback bug (imported
but not passed) was this debt's first symptom; the chunk/cancel policy is
its second surface.

**Shape:** state machine, `dueItems`, `prioritizeDue`, `markFailed`,
`attemptsAfterFailure`, `normaliseOutbox`, plus the chunk/cancel policy as
pure functions of (queue, progress). App keeps UI, worker keeps dispatch,
both import down.

**Retires:** the third worker→app edge before it happens; policy drift
between the two dispatch paths and the harness's copy.

## 2 · Storage schema registry

**Why now:** the coverage gate (round 45 A8) made shrinkage loud for CODE,
but storage keys still live in ~10 modules with per-key spelling and
lifecycle. The a11y/visual work adds two more persisted things (allow-list
manager state, reading positions) — every new key is another fiction-key
opportunity (the class that produced imageAllow/messageCache).

**Shape:** one module enumerating `{ key, owner, shape, backupPolicy,
sessionScoped, gc }`; backup, restore, sign-out clearing and claims GC all
read from it; a test asserts no module touches a key it does not own.

**Retires:** the fiction-key bug class permanently, before the next
persistence feature lands.

## 3 · Signed-in fixture mode for the visual harness

**Why now:** the harness's 72 screenshots cover the GATE, never the list,
reader or compose (round 46 problems #48) — the surfaces users stare at
are exactly the ones unshot. A deterministic signed-in boot (storage-seeded
fake inbox over the HTTP harness, worker stubbed to a canned SYNC_PAGE)
turns the harness from a gate-checker into a product checker.

**Shape:** a `?fixture=` query flag read only by the stub, not the app:
seeded theme/density, canned 40-message inbox, one open thread. The app
code never sees the flag; the stub swaps before first script.

**Retires:** the blind spot that let every list/reader visual regression
so far ship unphotographed.

## 4 · Committed baselines + pixel-diff step in CI

**Why now:** baselines not committed means the harness can diff locally
but CI catches nothing (round 46 #47–49). Screenshots without a judge are
artefacts, not protection.

**Shape:** `tools/screenshots/baseline/` committed; CI regenerates and
pixel-diffs with a tolerance; diffs post as artifacts for a human yes/no
(the harness stays a harness). Pair with #3 or the diff only covers the
gate.

**Retires:** theme and layout regressions as a shipped class.

## 5 · A11y on rendered states

**Why now:** axe runs on shells only (round 46 #42). The integration
harness already renders list, reader and compose open — exporting its boot
as a reusable helper lets the a11y test walk the same states.

**Shape:** extract the integration harness's `boot()` into
`test/helpers/app-harness.mjs`; the a11y test imports it and axe's the
rendered states; structural rules only, contrast stays with
check-contrast.

**Retires:** the gap between "attributes exist" and "the rendered thing is
usable", for the states that change.

## 6 · One dialog primitive to finish the focus contract

**Why now:** round 45 gave confirm/prompt dialogs and the timetable panel
the trap + focus-return contract; palette and menu layers still predate it
(round 46 #43). Two coexisting focus lifecycles is the pattern that
previously produced the stranded-focus bugs.

**Shape:** menu.js and palette.js consume the same layer options (trap,
restoreFocusTo, Esc) the dialogs use; the trap moves from call sites into
`openLayer` itself as an opt-out flag, so future layers inherit it.

**Retires:** the last pre-contract focus surface; makes the contract
default instead of per-call-site.

## 7 · i18n string table

**Why now:** the onboarding tour, cheatsheet and empty-lane education
(round 46 improvements) would each hardcode ~40 new strings into the same
files — extracting after they land means moving 200 strings; extracting
now means they land in the table.

**Shape:** one strings module keyed by id, consumed by the new surfaces
first; existing chrome migrates opportunistically. No locale shipped yet —
the table is the deliverable.

**Retires:** the migration that always blocks a future locale.

## 8 · Motion accessibility completeness lint

**Why now — and the guardrail:** the product decision is that animation
STAYS; the only motion debt is accessibility completeness (every motion
has a reduced-motion story). A lint that lists every `animation:` /
`transition:` and fails if one lacks a reduced-motion path makes that
decision enforceable in both directions: it neither removes motion nor
lets new motion ship inaccessible.

**Shape:** extend package.test.mjs's design guards: enumerate motion
declarations, require each to resolve inside the reduced-motion media
block or via the global zeroing rule; the stagger ramps are explicitly
whitelisted as covered by the global rule.

**Retires:** inaccessible motion as a class, without touching a single
duration.

## 9 · Interactive-state contrast pass

**Why now:** check-contrast audits text/surface; hover, selection and drag
states are checked by neither tool (round 46 #50) — and the High Contrast
theme's interactive set was never audited (#6 there). The themes are data;
states are computable.

**Shape:** extend tools/check-contrast.mjs to walk the CSS for state
selectors per theme and compute ratios for the accent/glow/warning pairs
they produce; fail CI on AA like the rest.

**Retires:** the unaudited half of the palette.

## 10 · Rendered-token design guard

**Why now:** the design guards read the CSS source; the visual harness
reads pixels; nothing connects them — a token can be present in source,
themed in themes.js, and still never reach a rendered surface (the
density-in-reader gap was exactly this, found by audit not by tool).

**Shape:** the visual harness, in fixture mode (#3), evaluates
`getComputedStyle` for a fixed token list per theme × density and asserts
each differs from its light/default value where it should — a smoke test
for token propagation, not pixel judgement.

**Retires:** "the token exists but never lands" as a discoverable class.

---

## Deliberately not here

- Splitting app.js, a state framework, rebuilding the Store, Claims v2, a
  component framework, a build pipeline — the standing non-goals, restated
  so the next audit doesn't relitigate them.
- The 50 improvements' feature work — expansion belongs after the QA
  items in the problems file (#47–49 there) and after 1–6 here.

Taken in order, the ten turn the two remaining debt classes — cross-path
drift and unaudited rendering — into build failures. That is the whole of
the architectural work this round justifies.
