# BITS Mail Manager — Post-Implementation UI Defect and Improvement Audit

**Date:** 2026-08-15  
**Audited commit:** `9c5ce59`  
**Scope:** static HTML, every style volume, UI rendering/controllers, settings/options, takeover, Cyberpunk motion/audio, UI test and screenshot tooling.  
**Method:** repository-state verification; HTML ID/ARIA reference census; CSS pseudo-element ownership and breakpoint census; listener/lifecycle census; source-to-DOM contract tracing; settings/feature truth comparison; review of existing targeted, a11y, contrast, package, browser-smoke and screenshot tooling. No prior report was treated as proof.

> Severity is based on visible breakage, false product claims, accessibility, privacy/trust, recoverability and likelihood. “Improvement” is not a defect unless current behavior contradicts a stated contract.

---

## A. Executive verdict

The interface has strong foundations and unusually good automated discipline, but the recent information-rich UI campaign introduced several **cross-layer composition defects that source-presence tests did not detect**. The most important are not subjective styling disagreements:

1. Two new row features take over pseudo-elements already owned by the base list component. Provenance overwrites the selection rail; the new selected cursor overwrites a separator pseudo-element that base CSS forces to opacity zero.
2. “Legacy” mode does not restore the legacy layout. Query console, dossier grid, thread styling and provenance remain active.
3. “Calm content” does not stop the global Cyberpunk scan overlay from painting over content, and Calm intensity still leaves scan textures on dialogs and toasts.
4. Authentication and notification UI contains materially false product claims: two OAuth scopes are requested, sending exists, and the disabled background sweep cannot currently deliver the promised closed-app notifications.
5. Remote server-search IDs are merged into the visible list, but row rendering reads only the Store; overlay-only rows can render empty.
6. The options page’s fieldsets are structurally nested under “Setting up your own client ID,” so the new two-column direct-child layout does not apply as intended and assistive grouping is misleading.
7. Visual-regression tooling omits Cyberpunk and asks for a nonexistent `high-contrast` theme ID, silently exercising fallback styling instead.

### Current assessment

| Area | Rating | Reason |
|---|---:|---|
| Core information architecture | 8/10 | Strong shell, reader/list split, rails, settings and workspace hierarchy. |
| Visual correctness after recent additions | 5/10 | Pseudo collisions and incomplete Legacy/Calm contracts are material. |
| Accessibility | 7.5/10 | Existing semantics are strong; new facts/options grouping need correction. |
| Responsive behavior | 7/10 | Good ladder, but new 840px fork and telemetry clipping lack evidence. |
| Cyberpunk visual system | 7.5/10 | Better semantic grammar; calm/content boundaries are not fully honored. |
| Cyberpunk audio | 8/10 | Modular, bounded, original; cue inference and voice cap have edge defects. |
| UI test quality | 7/10 | Broad source contracts, but computed visual interactions and current theme screenshots are missing. |
| Overall UI release confidence | **6.7/10** | Usable and sophisticated, but the confirmed HIGH defects should be fixed before calling the new profile complete. |

---

## B. Complete verified findings

| ID | Severity | Confidence | Subsystem | Finding |
|---|---|---|---|---|
| UI-H01 | HIGH | CONFIRMED | List/CSS | Provenance reuses `.row::before`, overwriting the selection-rail pseudo-element. |
| UI-H02 | HIGH | CONFIRMED | List/CSS | Selected-target cursor reuses `.row::after`, whose base selected rule sets opacity to zero. |
| UI-H03 | HIGH | CONFIRMED | Compatibility settings | Legacy profile hides only part of the additive UI; dossier/query/thread/provenance styling remains. |
| UI-H04 | HIGH | CONFIRMED | Cyberpunk/content | Calm-content contract does not remove the global scan sheet above mail content. |
| UI-H05 | HIGH | CONFIRMED | Auth/onboarding | Gate and options claim one scope/no sending while auth requests `gmail.modify` + `gmail.send` and compose ships. |
| UI-H06 | HIGH | CONFIRMED | Notifications/settings | UI promises closed-app background notifications while `BACKGROUND_SYNC_ENABLED = false`. |
| UI-H07 | HIGH | CONFIRMED | Server search/list | Overlay IDs are returned by selectors, but row build/fill resolves messages only from Store. |
| UI-H08 | HIGH | CONFIRMED | Options semantics/layout | Missing early `</fieldset>` nests most options under OAuth setup and defeats direct-child grid layout. |
| UI-H09 | HIGH | CONFIRMED | Visual regression | Cyberpunk omitted; invalid `high-contrast` ID falls back and is not token-verified. |
| UI-H10 | HIGH | HIGH | First paint | `app.html` pre-stamps `data-theme="light"`, bypassing the CSS rule intended to hide pre-theme paint. |
| UI-M01 | MEDIUM | CONFIRMED | Thread trajectory | CSS targets `aria-current`, renderer writes `aria-pressed` and `.current`; active trajectory style is dead. |
| UI-M02 | MEDIUM | CONFIRMED | Theme preview | `.set-theme` is flex, while preview uses `grid-column`; preview has no full-row flex basis and can collapse/squeeze. |
| UI-M03 | MEDIUM | CONFIRMED | Cyberpunk calm mode | Calm intensity removes body sheet/glow but leaves dialog/menu/toast scan backgrounds. |
| UI-M04 | MEDIUM | CONFIRMED | Telemetry | Operations entry promises sync/outbox/account/storage center but merely clicks the existing activity log. |
| UI-M05 | MEDIUM | CONFIRMED | Telemetry lifecycle | `wireSystemTelemetry` adds a listener but reset only nulls global context; old documents can call the newest context. |
| UI-M06 | MEDIUM | CONFIRMED | Reader facts/a11y | `aria-label` on generic `div` is weak semantics; key/value facts should be `dl/dt/dd` or a named group. |
| UI-M07 | MEDIUM | CONFIRMED | Reader noise | Confidence is shown for every message in facts, contradicting the existing “diagnostic only when uncertain” doctrine. |
| UI-M08 | MEDIUM | CONFIRMED | Outbox ledger | Failed state colors every phase warning, visually implying all four phases completed rather than failure before settlement. |
| UI-M09 | MEDIUM | CONFIRMED | Audio routing | Any control with `aria-haspopup` receives “open” even when its current `aria-expanded` state means the click closes it. |
| UI-M10 | MEDIUM | CONFIRMED | Audio/autoplay | Delegated `change` treats every event as a trusted gesture; synthetic changes may attempt context creation. |
| UI-M11 | MEDIUM | CONFIRMED | Audio polyphony | At 11 voices, noise layer can add voice 12 and oscillator then adds voice 13; cap can be exceeded. |
| UI-M12 | MEDIUM | HIGH | Cyberpunk motion | Superseded signal leaves old `animationend` listener attached; rapid signals can let stale handlers clear newer state. |
| UI-M13 | MEDIUM | CONFIRMED | Cyberpunk/body | Global scan overlay sits at z-index 39 and is not scoped away from calm reader/compose content. |
| UI-M14 | MEDIUM | CONFIRMED | Responsive | New 840px breakpoint forks the established 860px ladder solely to avoid a source-test collision. |
| UI-M15 | MEDIUM | CONFIRMED | Telemetry first paint | Strip is visible before settings stamp and initially shows placeholder facts that may be wrong for the active session. |
| UI-M16 | MEDIUM | CONFIRMED | Search console | Styling implies a parse console, but OR/group relationships are not represented—chips remain a flat token list. |
| UI-M17 | MEDIUM | HIGH | Reader dossier layout | Grid changes `#reader-head` without an explicit placement map for nav/actions; browser auto-placement can vary with hidden children. |
| UI-M18 | MEDIUM | CONFIRMED | Options information architecture | Setup copy and settings are interleaved due nesting; wide two-column CSS reaches only true direct children. |
| UI-M19 | MEDIUM | CONFIRMED | Background status language | Telemetry says `OFFLINE` for signed-out state, conflating authentication with network connectivity. |
| UI-M20 | MEDIUM | CONFIRMED | Settings truth | Legacy and Calm labels promise stronger rollback than their selectors implement. |
| UI-L01 | LOW | CONFIRMED | Reader facts | Truncated opaque Gmail thread ID uses space without helping most users; count/participants are more useful. |
| UI-L02 | LOW | CONFIRMED | System strip | `overflow:hidden` can silently clip status/action under zoom, localization or large text. |
| UI-L03 | LOW | CONFIRMED | Query console | Visible pseudo-label `QUERY` duplicates the existing “Searching:” label. |
| UI-L04 | LOW | CONFIRMED | Breakpoint maintenance | 1240/1080/860/840/720/600 create an undocumented extra step. |
| UI-L05 | LOW | CONFIRMED | Audio fatigue | `VOICED` includes ordinary text/search inputs, so focusing a field can sound like activating a command. |
| UI-L06 | LOW | CONFIRMED | Audio quality | Master gain changes instantaneously; profile/intensity changes can click instead of ramping. |
| UI-L07 | LOW | CONFIRMED | Audio output | No compressor/limiter exists; layered maximum-profile bursts rely only on conservative gain. |
| UI-L08 | LOW | CONFIRMED | Audio hover | `pointerover` can re-fire while moving among descendants of the same control; cooldown hides but does not model intent. |
| UI-L09 | LOW | CONFIRMED | Settings navigation tests/docs | Test/document names still say five settings sections after six shipped. |
| UI-L10 | LOW | CONFIRMED | Options style logic | Delay label dimming remains an inline opacity mutation instead of a semantic disabled class. |
| UI-L11 | LOW | CONFIRMED | Main orchestration | `main.js` is 3,914 LOC and still owns state, transport, boot, account lifecycle, sync apply and broad wiring. |
| UI-L12 | LOW | CONFIRMED | Large modules | Timetable UI 1,434 LOC, reader 1,158, list 1,149 and compose 837 remain high-collision surfaces. |
| UI-L13 | LOW | HIGH | Listener lifecycle | Several UI modules add many listeners with no removal because they assume one page lifetime; test/HMR reuse depends on bespoke reset seams. |
| UI-L14 | LOW | CONFIRMED | Cyberpunk stylesheet | `88-cyberpunk.css` remains one increasingly large owner; internal sections are clear but physical modularity is absent. |
| UI-I01 | INFO | CONFIRMED | Static semantics | No duplicate static IDs and no missing static ARIA/label references were found. |
| UI-I02 | INFO | CONFIRMED | Accessibility gates | Existing axe, focus, hit-target, contrast and reduced-motion gates remain valuable and currently pass. |
| UI-I03 | INFO | CONFIRMED | Security | No new unsafe mail HTML sink was introduced by the UI campaign. |

---

## C. Critical composition defects

### UI-H01 — provenance destroys the selection rail

**Evidence**

- `src/styles/20-list.css:72-85` owns `.row::before` as the absolute 3px selection rail and transforms it from `scaleX(0)` to `scaleX(1)`.
- `src/styles/89-ui-innovation.css:79-85` redefines `.row[data-source]::before` with textual `content: attr(data-source)`, flex sizing, typography and uppercase.
- Every rendered row receives `data-source` in `src/app/mail/list.js`.

The new rule does not create a second pseudo-element. It modifies the same one. Because it does not reset the base absolute positioning, width, transform or background, the source text is forced into the selection rail’s geometry while the original selection indicator loses ownership.

**Impact:** selected-row state and provenance are both unreliable; visual damage applies to every row when provenance is enabled (default).

**Preferred fix:** add a real `.r-origin` child inside the row’s existing content/right column. Never reuse `::before` or `::after` on `.row`; those are reserved component primitives. Add a pseudo-ownership test.

### UI-H02 — selected cursor is forced invisible

**Evidence**

- Base `.row::after` is the separator.
- Base `.row[aria-selected='true']::after` sets `opacity: 0`.
- Modern profile reuses selected `.row::after` as a rotated square cursor but does not restore opacity.
- Cyberpunk also styles the same selected `::after`.

**Impact:** the promised square current-target cursor is invisible; the separator pseudo is repurposed inconsistently.

**Preferred fix:** use a real `.r-cursor` child inside `.r-pick`, or style the existing `.r-bar` plus an additional nested element. Keep pseudo ownership one-component/one-purpose.

### UI-H03 — Legacy mode is incomplete

`data-ui-profile='legacy'` currently hides system strip, facts, theme preview, delivery track and selected cursor. It does not suppress:

- dossier `#reader-head` grid;
- thread trajectory styling;
- query-console framing;
- provenance pseudo rules;
- operation borders;
- several Cyberpunk generation-two treatments.

**Impact:** users choosing Legacy do not get the previous UI promised by the setting.

**Preferred fix:** make modern profile the positive gate for every additive selector (`data-ui-profile='modern'`) rather than trying to enumerate legacy reversals. Add computed-style parity snapshots comparing pre-campaign baseline with Legacy.

### UI-H04/UI-M13 — Calm content boundary does not stop the scan sheet

The global Cyberpunk `body::after` is a fixed z-index 39 scan/vignette sheet. Clearing `background-image` on `#r-frame` and `#c-text` does not prevent an ancestor-level overlay from painting above them.

**Impact:** the setting’s central promise—no decorative texture over mail and writing surfaces—is not fulfilled.

**Preferred fix:** when `data-calm-content='on'`, move the global texture behind content or remove it and reapply texture only to chrome surfaces. Verify with screenshot pixel samples over reader/compose.

### UI-H05 — OAuth UI is factually wrong

- `app.html` gate says “One scope, gmail.modify.”
- `options.html` says the build cannot send and does not request `gmail.send`.
- `src/background/auth.js` requests both `gmail.modify` and `gmail.send`.
- Compose/send/outbox are shipped and tested.

**Impact:** consent explanation is false in a security-sensitive onboarding flow.

**Preferred fix:** state both scopes and why each is required. Add a contract test deriving displayed scope names from the auth scope definition or a shared capability descriptor.

### UI-H06 — background-notification setting promises disabled behavior

The settings panel says closed-app notifications run about every 15 minutes. The options/schema default remains on. `src/background/index.js` deliberately sets `BACKGROUND_SYNC_ENABLED = false` as cursor-safety containment.

**Impact:** a visible enabled preference cannot work.

**Preferred fix:** until a separate notification cursor/journal ships, disable the control and explain “temporarily unavailable while safe background sync is rebuilt.” Never display an enabled toggle for a disabled subsystem.

### UI-H07 — overlay-only search rows cannot render correctly

Selectors merge `overlay.ids()` into visible IDs. `list.js` builds and updates rows with `storeOf().get(id)` only. Overlay-only IDs therefore pass `undefined` to `fillRow` and can create empty row skeletons.

**Preferred fix:** define one `messageOf(id) = store.get(id) || overlayGet(id)` function and use it in build, update, patch, achieved-state and departure decisions. Add an integration test with one remote-only result asserting sender, subject, source and open behavior.

### UI-H08/UI-M18 — options fieldset nesting

`<fieldset>` “Setting up your own client ID” opens at line 138 but closes near the end of the page. Appearance, Rules, Backup, Sync, Reading and Composing fieldsets are nested inside it. The new wide layout styles `main > fieldset`, so most sections are not grid children. Screen-reader grouping can also associate unrelated controls with OAuth setup.

**Preferred fix:** close setup immediately after its hint (around current line 179) and remove the final stray close. Add a DOM test asserting all eight fieldsets are direct children of `main` and legends are not nested.

### UI-H09 — current theme lacks visual-regression coverage

`tools/visual-regression.mjs` hardcodes:

`daylight, midnight, pilani-dusk, solarised, nord, high-contrast`

Problems:

- Cyberpunk is absent.
- Actual high-contrast theme ID is `contrast`, not `high-contrast`.
- Unknown IDs fall back to the default theme.
- Token guard skips an unknown theme because no matching theme data exists.

**Impact:** screenshots labeled high-contrast are likely fallback output; Cyberpunk’s most visual changes have no baselines.

**Preferred fix:** derive IDs directly from `THEMES_DATA`, add an explicit expected count, and fail on unknown ID. Generate Cyberpunk Calm/Balanced/Maximum plus textures-off and reduced-motion baselines.

### UI-H10 — wrong-theme first-frame guard is bypassed

CSS hides `html:not([data-theme]) body` until JavaScript applies the saved theme. But `app.html` ships `data-theme="light"`, so the condition is false from the first parse. `light` is not even a current theme ID (`daylight` is).

**Preferred fix:** remove the static attribute or use a separate `data-theme-ready` stamp. Add a test that static HTML cannot bypass the boot-flash guard.

---

## D. Cyberpunk audio and motion review

### Strengths

- Original synthesis only; no game assets.
- Clear controller/audio/motion split.
- Lazy gesture-owned AudioContext.
- No idle loops.
- Semantic Minimal/Semantic/Full profiles.
- Reduced-motion and Calm gates.
- Generated electrical texture adds physicality.
- Explicit teardown and source-level tests.

### Defects and preferred changes

1. **Voice-cap reservation:** reserve two slots before adding tonal+noise layers, or treat a cue as one tracked voice group.
2. **Trusted changes:** pass `gesture: e.isTrusted`; synthetic change events may reuse an existing context but never create one.
3. **Open/close inference:** check `aria-expanded` first. `true` means close, `false` means open; only fall back to `aria-haspopup` when expanded state is absent.
4. **Text-field fatigue:** remove text/search inputs from generic activation cue; voice value changes, explicit submit and command controls instead.
5. **Pointer intent:** compare `relatedTarget.closest(VOICED)` to avoid re-voicing movement inside one control.
6. **Gain smoothing:** use `setTargetAtTime` for master changes.
7. **Limiter:** add a modest DynamicsCompressor after the master or before destination for maximum-profile bursts.
8. **Signal generation token:** stale animationend handlers should verify a sequence number before clearing classes.
9. **Pagehide listener:** disposal should remove or de-duplicate the global pagehide listener during reinitialization.
10. **Runtime Web Audio tests:** source tests are useful but do not prove graph connection/cleanup. Add a small fake AudioContext contract test.

---

## E. Accessibility and interaction review

### Confirmed strengths

- Static IDs are unique.
- Static `aria-controls`, `aria-labelledby`, `aria-describedby` and label `for` references resolve.
- Listbox ownership is direct.
- Reader remains an article.
- Dialog layering/focus traps are mature.
- Reduced motion and contrast gates pass.

### Improvements

1. Replace reader facts with `<dl>` and `<dt>/<dd>`.
2. Do not announce opaque thread IDs by default; expose count/participants and put ID in advanced diagnostics.
3. Add `aria-live="polite"` only to the specific sync-status value if new telemetry is intended to announce state; otherwise leave freshness as the sole announcement to avoid duplicates.
4. Ensure system strip remains readable at 200% zoom and long localization.
5. Add a forced-colors treatment for selected cursor, provenance and outbox tracks.
6. Add screen-reader test for facts order and outbox uncertain state.
7. Make operation center name match actual activity-log contents until the center is expanded.
8. Ensure focus rings are not clipped by Cyberpunk `clip-path` on buttons/dialogs.
9. Add keyboard tests for six settings tabs and narrow scroll position.
10. Use `aria-pressed`/`.current` consistently in thread trajectory CSS.

---

## F. Responsive and visual hierarchy review

1. Merge 840px rules into the established 860px step; tests should find the right component block rather than force a new breakpoint.
2. Replace telemetry `overflow:hidden` with deliberate priority collapse and an overflow/details action.
3. Test 320px and 400% text zoom, not only 480px.
4. Give reader dossier children explicit grid areas.
5. Make theme preview `flex-basis:100%` and enable wrapping on tile.
6. At compact density, provenance must not consume a fourth grid column.
7. Ensure category/user colors remain visible in forced colors via shape/text.
8. Test outbox transaction track with long recipient names and Retry/Discard buttons.
9. Verify system strip stays outside timetable scroll and does not reduce critical week-grid height excessively.
10. Avoid all-uppercase wrapping in narrow Cyberpunk controls.
11. Test texture-on/off screenshots over dense reader content.
12. Verify selected target at each density and width with computed opacity, not source presence.

---

## G. UX truth and information architecture

### Text/capability corrections

- Gate: explain `gmail.modify` and `gmail.send`.
- Options: remove “this build cannot send.”
- Background notification: unavailable/disabled while safe cursor separation is pending.
- Operations button: rename “Activity” unless it gains sync/storage/account events.
- Telemetry signed-out state: use `SIGNED OUT`, not `OFFLINE`.
- Legacy setting: either complete rollback or rename to “Reduced modern chrome.”
- Calm setting: either enforce texture exclusion or narrow its description.

### Dossier improvements

- Replace thread ID with message count and participants.
- Show confidence only below threshold or after human correction.
- Add attachment count after body metadata arrives.
- Show local/live provenance with a human label and tooltip.
- Keep raw IDs behind an advanced diagnostics disclosure.

### Search console improvements

- Represent OR groups with group containers/connectors.
- Distinguish local result count from remote overlay count.
- Show remote-search progress and failure in the same console region.
- Avoid duplicate QUERY/Searching labels.
- Explain why selected result matched.

### Delivery center improvements

- Model queued→held→dispatch→acknowledged; failed/uncertain are terminal branches, not fourth completed stage.
- Add accessible text equivalent for stage, while keeping track decorative.
- Make Check Sent the primary uncertain action.
- Surface account ownership and quarantine.
- Add conservation totals: pending, uncertain, failed and sent receipts.

---

## H. Maintainability and modularization roadmap

### Immediate extractions

1. **`main.js` transport/session coordinator** — worker send/fallback/account epoch.
2. **`main.js` sync UI coordinator** — page/delta apply, persistence, freshness, busy state.
3. **Reader facts component** — rendering and semantic structure separate from reader transport.
4. **List row model** — one message resolver handling Store + overlay, provenance and operation state.
5. **Settings descriptor data** — separate static configuration from panel lifecycle/rendering.
6. **Timetable UI submodules** — tabs, grid, conflict inspector, enrollment editor.

### CSS ownership rules to add

- Declare `.row::before` and `.row::after` reserved in a machine-readable pseudo-owner registry.
- Require additive UI selectors to be positively gated by Modern profile.
- Derive visual-regression theme IDs from theme data.
- Forbid unrecognized breakpoints outside the responsive authority volume.
- Add computed-style assertions for selected cursor opacity/geometry.

---

## I. Test-gap roadmap

### P0 regression tests

1. Selected row has visible rail and visible cursor simultaneously.
2. Provenance text renders in a real child and does not alter row grid tracks.
3. Legacy computed styles equal pre-campaign baseline for additive surfaces.
4. Calm content pixel area contains no scanline modulation.
5. Scope copy equals auth scope constants.
6. Disabled background feature cannot present enabled setting.
7. Overlay-only result renders subject/sender and opens correctly.
8. Options fieldsets are direct siblings.
9. Every theme data ID receives screenshot coverage.
10. Static HTML cannot show a wrong-theme frame.

### P1 interaction tests

11. Thread current style follows `aria-pressed`/`.current`.
12. Theme preview occupies full tile row at 600/1280 widths.
13. System strip at 200% zoom retains account/sync/action.
14. Signed-out telemetry says signed out, not offline.
15. Reader facts use semantic definition-list order.
16. Failed outbox track ends before acknowledgement.
17. Operations button opens a surface matching its name.
18. Cyberpunk open control toggles open/close cues correctly.
19. Synthetic change cannot create AudioContext.
20. Polyphony never exceeds configured cap.

### P2 visual matrix

- Every theme × three densities × 480/600/860/1280.
- Cyberpunk Calm/Balanced/Maximum.
- Cyberpunk textures off and sounds irrelevant to screenshot.
- Reduced motion.
- Forced colors.
- Reader open, search active, settings, compose, timetable, uncertain outbox and empty/error states.

---

## J. Prioritized implementation plan

### P0 — correctness and truth

- Fix pseudo collisions with real row children.
- Complete positive Modern gating and true Legacy rollback.
- Fix calm-content/global texture boundary.
- Correct OAuth and notification copy/state.
- Fix overlay message resolution.
- Fix options fieldset structure.
- Repair visual-regression theme enumeration.
- Remove static invalid theme stamp.

### P1 — semantic/UI repair

- Fix thread active selector.
- Convert facts to definition list and reduce always-on confidence.
- Correct telemetry state labels and operations naming.
- Repair outbox branch visualization.
- Make theme preview full-row.
- Merge 840 breakpoint into responsive ladder.

### P2 — audio/motion hardening

- Voice-group cap reservation.
- Trusted-event context creation.
- Open/close state inference.
- Text-input silence.
- Gain smoothing/compressor.
- Stale animation listener generation guard.

### P3 — modularization

- Extract transport/session and sync UI from main.
- Create overlay-aware row model.
- Split reader facts.
- Split settings descriptor.
- Split timetable UI.

### P4 — evidence

- Expand computed-style tests, browser smoke and full screenshot matrix.
- Add real Cyberpunk baselines and correct contrast theme ID.
- Add zoom/forced-colors/manual screen-reader runs.

---

## K. Explicit acquittals

The audit did **not** find:

- duplicate static IDs;
- broken static ARIA references;
- new unsafe email HTML rendering;
- unbounded Cyberpunk idle animation;
- eager AudioContext construction;
- sampled/proprietary audio assets;
- missing reduced-motion global kill;
- missing theme contrast roles;
- import cycles in the UI module graph.

---

## L. Final standard

The modern profile should not be declared complete until:

- row primitives have single ownership;
- Legacy and Calm mean exactly what settings say;
- UI capability copy matches production behavior;
- remote-only results are renderable;
- options structure is semantically flat;
- Cyberpunk has real screenshot baselines;
- every new visual state has computed, not merely textual, regression evidence.
