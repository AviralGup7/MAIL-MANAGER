# Animation & Interaction Overhaul — Audit + Language Spec (round A-anim)

**Date:** 2026-08-13 · **Scope:** the takeover shell (`app.html` + `src/app/*`), and where they differ, options/timetable pages.
**Trigger:** the Maximum Animation & Interaction Overhaul directive (50 sections). This document is its Phase-1 audit and the binding vocabulary every later phase must speak.

---

## 0. Standing constraints (NOT negotiable, survive this overhaul)

1. **Reduced-motion is inviolable.** The file-end `@media (prefers-reduced-motion: reduce)` guard (app.css:6478) squashes every `animation-duration`/`transition-duration` to 1ms AND zeroes delays — the delay half is the part everyone forgets, and its comment explains why. Every new effect, JS-driven or CSS, must collapse through the SAME gate (JS checks `matchMedia` once at module level and re-checks on change; CSS stays inside the guard). The motion system exists to be *skipped* exactly as much as to run.
2. **State never waits for pixels** (the closeWithMotion doctrine, layers.js:236): `hidden`, aria attributes, focus restoration and the layer stack all settle synchronously; animation is presentation layered over logical truth. New motion must not invert this — nothing interactive may wait for an animation before becoming logically real.
3. **The ladder stays the ladder.** One Escape peels one layer; `stopPropagation` ownership per surface; the layer stack owns overlay lifecycle. Animation joins as *rendering*, never as an additional owner of visibility.
4. **app.js does not grow.** New interaction code lands in new modules (`src/app/motion/*`), wired at boot through the existing ctx/seam patterns.
5. **No px→rem migration, no framework, no event bus, no new state layer** (master backlog). Motion reads the state system; it does not become one.
6. **Contrast gate stays 6/6 AA** (`tools/check-contrast.mjs`); the layout contract (`test/layout-contract.test.mjs`) stays green — motion may not change resting geometry measured by the contract.
7. **Process rules (owner's, 2026-08-13):** commit+push before any test run; local tests ≤ ~50s and only the smallest relevant chunk; the full suite and both integration files run on remote CI, never locally; kill-all process hygiene at every session start.

---

## 1. What exists today (measured census)

| Stock | Count / location |
|---|---|
| `@keyframes` | 31 in app.css — entries dominate (`*-in`): head, star-pop, empty, sk-shimmer, swap, menu, sweep, gate, palette, compose, row, toast, ctx, bulk ×3, note, tt, reorient-pulse, v3 ×5; exits: overlay-out, fade-out, compose-out, toast-out, row-out |
| `transition:` declarations | ~69 sites; **~50 run on the DEFAULT `ease`** (no timing function stated) |
| Bespoke beziers | 4 total, one-use each: `--ease-out` (0.22,1,0.36,1), `--ease-in` (0.4,0,1,1), `--ease-spring` (0.34,1.42,0.64,1 — the only overshooting curve), + (0.3,1.3,0.4,1) |
| Duration tokens | `--dur-instant 90 / -fast 140 / -base 200 / -slow 300 / -pulse 700 / -flash 1600` (app.css:136-148) |
| Lists | id-diffing renderer (rows reused); `v3-row-in` cascade staggered via `--rk` custom prop through the first 14 children — already plays *when content is new* |
| Exit choreography | `closeWithMotion`/`cancelExit` (layers.js): `.closing` class one frame before `hidden`; palette/compose/toast/help/gate have real exits |
| Gesture layer | **none** — zero `pointermove`/`touchstart`/`draggable` handlers in app JS |
| Canvas/WebGL | **none** (sole `getContext` is sanitize.js's offscreen measurement) |
| Physics | **none** — no spring integrator anywhere; the one "spring" is a static bezier |
| Cursor | native only; no magnetic, no custom cursor, no lighting model |
| Depth | flat; shadows static; no perspective anywhere |

**Read:** the app already has *polish* (entries, exits, stagger, tokens, a motion doctrine) but no *physics* — nothing has mass, nothing tracks velocity, nothing reacts continuously to input, and half the transitions ride the browser-default easing. The vocabulary exists and is tokenised; the overhaul extends it rather than replacing it.

---

## 2. Surface inventory → tier map (directive §41)

Tier budget: **T1 ambient** ≤90ms whispers · **T2 microinteraction** ≤200ms springs · **T3 component** ≤450ms springs + choreography · **T4 major** camera/morph, full scene · **T5 hero** rare, spectacular, interruptible.

| Surface | Today | Tier | Overhaul signature |
|---|---|---|---|
| Buttons (all `button`, `.primary`, `.ghost.icon`) | default-ease color/shadow hovers | T2 | **Press physics**: spring compress → release overshoot; dynamic shadow follows press depth; important ones (Compose, Send) magnetic (§3/§4/§23) |
| Compose FAB-equivalent `#btn-compose` | static | T2+ | magnetic (strong set), hover lift, icon micro-drift |
| List rows `#list .row` | v3 cascade entry only | T2/T3 | hover = physical (lift + light); selection ripple; **row→reader shared-element morph** (§5) is the T4 signature |
| Reader open | `v3-reader-in` translateX entry | T4 | row's from/subject FLIP into the reader header; body iframe cross-fades under a settling mask (sandbox makes true content-morph impossible — the *header* is the shared element) |
| Menus `menu.js` / ctx menu | `menu-in`/`ctx-in` spring bezier entries | T3 | popover grows FROM its invoker (transform-origin at anchor, spring scale+fade), exits reverse along live velocity (§12/§35) |
| Palette Ctrl+K | overlay-in/out | T3 | camera push: backdrop scale 1.0→0.985 + blur, dialog springs in; command rows stagger; Esc = exact reverse spring (§8/§12) |
| Compose dialog | compose-in/out | T3/T4 | button→dialog morph candidate: the Compose button's geometry seeds the dialog's first frame (§5/§6); content stays logical per doctrine |
| Views pop / saved views | `v3-pop-in` | T2 | anchored pop + per-item stagger |
| Search suggest | display toggle | T2 | height/reveal spring + option stagger; combobox aria stays synchronous (A-A6 contract untouched) |
| Toast | toast-in/out + drain | T2 | spring entrance from edge + overshoot settle; drain unchanged (it is a timer made visible) |
| Bulkbar | `bulk-in` + bar-check-in | T2 | toolbar unrolls from the count pill; item count numerically tweens (§14) |
| Sidebar categories | default-ease hovers | T2 | magnetic-lite nav; active pill glides (shared layout indicator) instead of repainting |
| Rail "For you" cards | `v3-rail-in` | T1/T2 | ambient breathing on empty states (§27); hover depth |
| Snooze/deadline/radar notices | note-in | T2 | physics entries; dismiss throws the card away with swipe-velocity spring (§11 gesture) — pointer-drag dismiss |
| Gate (sign-in) | gate-in + sweep | T4 (first-run hero) | one allowed T5 moment: particles assemble the brand mark on first paint (§15/§46.12) |
| Timetable workspace | tt-in + tt-flash | T4 | camera-like takeover (list recedes in depth, workspace rises); entries cascade; `tt-flash` stays (accessibility-tuned already) |
| Empty/loading states | `sk-shimmer`, empty-in | T1 | breathing skeletons (opacity on the shimmer gradient already; upgrade to travelling luminance band tied to actual geometry, §26) |
| Takeover enter/exit (release → Gmail) | instant swap | T4 | camera pull-back: shell scales 0.99→1 + fade under 300ms; Gmail revealed beneath — the one true page transition (§8) |
| Help dialog | overlay-in/out | T2 | consistent overlay physics |
| Options page | static HTML | T2 | press/hover physics only — out-of-phase page, low traffic |
| Scroll regions | none (scroll-behavior smooth in places) | T1 | depth parallax on the lone scroller (list shadows deepen at edges); NO scroll-jacking — the muscle-memory contract is sacred |
| Counts/badges (`--badge`, unread digits, rail tick) | text swap | T1 | number roll/tween (§14) |
| Icons (menu↔close, star, check) | instant swap | T2 | geometric morph where pairs exist (§25) — star-pop already exists as the seed |
| Drag & drop | none in product | — | **not invented**: the roster has no reorder verb; creating one is interaction redesign, which the master backlog forbids. §37 applies only if a draggable surface is ever born (snooze dispose gesture is the closer: drag-to-dismiss) |

---

## 3. The animation language (one physical universe, §45)

### 3.1 Springs instead of curves

A cubic-bezier cannot reverse mid-flight from current velocity; a spring can. New JS module **`src/app/motion/spring.js`**: RK4-ish semi-implicit integrator stepping `x, v` toward a target under `stiffness, damping, mass`; rAF-driven, one global loop, per-animation cancellation; step function exported pure for node tests. All JS motion routes through it. CSS keeps declarative transitions for T1/T2 color/state whispers (upgraded to the spring-ish bezier family), JS springs own T3+ geometry.

**The spring vocabulary (the only four masses this app has):**

| Preset | stiffness | damping | mass | ζ | Feel | Used by |
|---|---|---|---|---|---|---|
| `WHISPER` | 420 | 34 | 1 | 0.83 | instant settle, ≤1% overshoot (invisible on opacity/lift) | T1 ambient, hovers |
| `SNAP` | 360 | 26 | 1 | 0.69 | fast, ~5% overshoot | T2 micro (press, check, pill glide) |
| `PANEL` | 240 | 20 | 1.1 | 0.62 | deliberate, ~8% overshoot | T3 (overlays, menus, palette) |
| `HEFT` | 170 | 18 | 1.4 | 0.58 | cinematic arrive, one gentle ~10% bounce | T4/T5 (camera moves, morphs) |

(ζ values are the derived damping ratios — the pin file asserts each preset's measured overshoot band so the language cannot drift silently.)

CSS mirror: `--spring-pop: cubic-bezier(0.34, 1.56, 0.64, 1)` family stays for pure-CSS consumers; the JS presets are the truth for geometry.

### 3.2 Depth model (§7)

Perspective container on `#shell` (`perspective: 1200px`, shipped P2/P4); five planes: **backdrop −60px** (dim+blur) · **content 0** · **float +30px** (cards/popovers) · **overlay +90px** (palette/dialogs) · **toast +140px**. Elevation reads as BOTH translateZ and shadow from one token pair — a shadow may never claim a height the geometry denies. Shadow color stays theme-token-derived (contrast gate untouched). **Enforcement (P4):** package.test.mjs's token census forbids speculative CSS tokens, so plane/lift/light custom properties enter the stylesheet only together with their first consumer (P5/P6), mirrored day/night like the `--shadow-*` family. The camera itself ships its physics now (motion/camera.js) and needs no CSS tokens.

### 3.3 Lighting model (§19)

One virtual key light: cursor-driven--light custom properties `--lx/--ly` (px, root) updated on pointermove via rAF coalescer (only while any `.lit` surface is visible — never always-on). Cards/rails read radial-gradient highlight positioned at (`--lx`,`--ly`) at 3-8% alpha; disabled under coarse pointers and reduced-motion. This is ambient, Tier 1 — cheap by construction (one custom-property write per frame, no per-element listeners).

### 3.4 Interaction primitives (`src/app/motion/`)

| Module | Directive § | Contract |
|---|---|---|
| `spring.js` | 3, 12 | `springTo(el, {prop..., preset, onRest})`, interruptible, reverse-from-velocity; pure `springStep` for tests |
| `press.js` | 22, 23, 24 | pointerdown/up/leave on delegated `[data-press]` → scale/compress spring + shadow depth + ripple spawn |
| `ripple.js` | 24 | pooled ripple spans per host (max 3 live), origin = press point, capped radius, auto-GC |
| `magnetic.js` | 4 | `attachMagnetic(el, {radius, strength})`, spring return, pointer:fine only, reduced-motion off |
| `morph.js` | 5, 6, 9 | FLIP: `capture(el)` → `play(ghost, to, preset)` on translate/scale/radius; row→reader the first consumer |
| `camera.js` | 8, 10 | scene-level transforms on `#shell` (scale/translateZ/blur) for takeover/timetable/palette pushes |
| `numbers.js` | 14 | `tweenNumber(el, to)` — counting tween with format preservation |
| `particles.js` | 15, 16-lite | ONE canvas overlay, pooled particles (hard cap 240, decay-bound), used for gate assemble + delete-to-dust + success burst; disabled under reduced-motion, torn down when idle |
| `dismiss.js` | 11, 37 | drag-to-dismiss on rail notices: translate+rotate follows pointer with velocity; past threshold → throw, else elastic return |

WebGL shaders (§16-18) are **deliberately capped**: a displacement pass over the takeover exit is the only justified shader candidate and is Phase-6 stretch — the app's surfaces are text UI, and a shader that doesn't survive Gmail's host CSS fights gets cut.

### 3.5 Timing doctrine (§43)

No `setTimeout` for effect. Input acknowledgement ≤ 1 frame (press down = immediate 2% compress), then spring settle. Staggers cap at 12 items × 24ms — after that items appear together. Everything interruptible: any spring can be retargeted mid-flight from live `(x, v)`.

### 3.6 Reduced-motion translation of the spec

Under `prefers-reduced-motion`, the directive's sections translate to: instant state, *no* spring loop ticks (spring.js parks at target synchronously), no particles canvas, no lighting vars, no magnetic listeners (never even attached), CSS guard squashes the rest. The spec above is the *default* experience; the reduced experience is complete, not degraded-in-parts.

---

## 4. Phases (milestone = commit+push; tests = targeted new files only)

| # | Milestone | Deliverables | Pins |
|---|---|---|---|
| P1 | **This document** | audit + vocabulary | — |
| P2 | Motion core | `spring.js`, `tokens.js`, `numbers.js`, CSS depth/lighting tokens | `test/motion-spring.test.mjs` (convergence, overshoot bound, interruption, reversed velocity), `test/motion-numbers.test.mjs` |
| P3 | Microinteraction tier | `press.js`, `ripple.js`, `magnetic.js`; buttons/rows/nav wired via one delegated wiring module `motion/wire-micro.js` | wiring pins (jsdom): ripple pool cap, magnetic skip-on-touch, press interrupt |
| P4 | Overlay physics + camera | `camera.js`, `morph.js`; palette/views/menu/help entries+exits on PANEL springs with live reversal; backdrop depth push | morph FLIP math pin; layers.js semantics untouched (closeWithMotion still owns `hidden`) |
| P5 | Signature morphs | row→reader FLIP; compose button→dialog seed; active-category pill glide | FLIP regression pins; reader/palette Escape contracts (menu/search-escape pins must stay green) |
| P6 | Ambient & hero | lighting coalescer, breathing empties, particle canvas (gate assemble + undo/delete dust), timetable camera | particle pool cap + auto-teardown pins |
| P7 | Final audit pass | probe-walk of every §50 surface on the checklist; screenshots archived in the probe (not the repo) | contract suites re-run locally (≤50s: layout-contract + motion pins + accessibility pin files); integration = CI |

**Hard exclusions:** no scroll-jacking, no always-running particle fields, no effect behind an artificial delay, no authorship of new drag-verb surfaces, no growth of app.js, no aria/value desync (motion clones zero state).

**Standing decisions discovered during P4 (do NOT re-litigate):**
1. **Menus exit instantly, deliberately** (menu.js onClose doctrine, test-encoded): the node is REMOVED, so "closed" and "gone" stay the same thing for outside-click dismissal and AT. Animated exits would force a zombie-DOM window. Entries may be upgraded (popFrom anchored springs); exits may not.
2. **`hidden` never waits for motion** (layers.js + package.test.mjs pin: no timer ≥2 digits may gate hiding; Escape/focus/dismissal key off it). Therefore exit *grace periods* are banned; a visible exit, if ever wanted, must run on a pointer-events:none CLONE after the real node hides — presentation only, state instant. Deferred until a surface genuinely needs it.

---

## 5. Success evidence

Per milestone: the pin files above + a live probe (CDP, existing harness pattern) measuring that the surface moves through intermediate states (≥3 sampled frames show interpolation) and settles at the documented rest state; reduced-motion run shows 1ms squash; menu/search-escape/layers/focus-restore/toast-naming/announce-semantics/layout-contract suites stay green. Full integration on CI at P4 and P7 minimum.
