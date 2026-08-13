# Responsive & Adaptive Architecture Audit

**Scope:** the whole app shell (`app.html`, `src/app/app.css` ~6.4k lines, and
the JS that owns layout decisions) across widths 1920→340, heights 860→420,
three densities, both pointers, and pathological content. **Method:** static
rule inventory, then a live headless-Chromium probe driving one long session
(resize while selected/searching/reading, rail drawer, content injection).
Raw probe dump: `/tmp/r1.json` (regenerate via `.probeR.mjs`). Audit only —
no fixes shipped. Findings classified per §22.

---

## 1. Executive diagnosis

The product has **two responsive ladders, not one**, and they overlap:

- the **round-45 contract ladder** (`app.css:2679-2720`: 720/600/480) and
- the **V3 ladder** (`app.css:6356-6430`: 1240/1080/860/720/600).

Where they set the same property, V3 wins by source order — which leaves the
480px `--sidebar-w: 52px` rule **measurably dead** (sidebar computes 64px at
480/400/340). The rest of the system is genuinely content-driven: fixed
slots, minmax floors, ellipsis gates proven under 140-char injection, and
state that survives live resize with **zero** loss (selection, reader,
query, chips, bulk mode all preserved through 1440→520→1440; focus stayed
on `#list`).

The critical defect is a **specificity defeat**: below 600px, with the rail
open and content in it, `body.rail-open #panes:has(#rail-scroll > :not([hidden]))`
(`app.css:5937`, two ids via `:has`) beats the stack rule
(`app.css:6384`, one id), so `#panes` still computes **three columns
("340px 0px 300px" measured at 520px)** and the open reader is laid out at
**0px wide — invisible while selected**.

## 2. Responsive mechanism inventory (verdicts inline)

| Mechanism | Where | Trigger | Effect | Verdict |
|---|---|---|---|---|
| Width MQ ladder (legacy) | app.css:2679–2720 | 1080/720/600/480 | pane tracks, stack, compose 100% | **480 rule dead** (overridden by later 860 block); rest duplicated by V3 ladder |
| Width MQ ladder (V3) | app.css:6356–6430 | 1240/1080/860/720/600 | rail→drawer, pane floors, icon-rail sidebar, toolbar label hide, stack | Load-bearing; measured transitions all fire exactly at declared values |
| Height MQ | app.css:5634 | ≤700px | topbar 61→49px | content-driven, measured ✓ |
| Hover MQ | app.css:1748, 6210 | `hover:hover` | row hover-verb reveal (65/b) gated off coarse pointers | correct input adaptation |
| Pointer MQ | app.css:2722 | `pointer:coarse` | row-h 64px, 32px min targets, `touch-action: pan-y` | paired with list.js:112 swipe wiring ✓ |
| Reduced motion | app.css file-last ×2 + list.js:708,1107 + content.js:77 | prefers-reduced-motion | kills animation, skips JS flourish paths | correct, pinned by guards |
| JS drawer MQ | app.js:3193 `drawerMq (max-width:1240px)` | live | outside-click + Esc close for the rail drawer | one JS breakpoint = CSS 1240 ✓ aligned |
| Menu viewport clamp | menu.js:262, app.js:3259 | open | fixed menus clamp/flip inside viewport | content-context, no breakpoint |
| Density | `:root[data-density]` (209,219,5811…) | user pref | token remap (row-h 62/58/40, snippet removal at compact) | orthogonal to width; by design |
| Scroll-collapse topbar | `body.list-scrolled` app.css:5638 | list scroll | topbar height→0, restores on search/selection | information relocation by **task context** — the subtlest rule in the file |
| Bloom measure | list.js `refreshSubjectClip` (375,937) | layout measure per row | width-bloom class ↔ tooltip rules | ResizeObserver-free; re-run on density change; fine |
| Virtualization | `.row { content-visibility:auto }` app.css:1094 | viewport proximity | off-screen rows skip render | adapts to *content volume*, not width |

No container queries, no ResizeObserver, no per-resize re-render — resize is
pure CSS + one matchMedia listener. Performance of adaptation is
**not a finding**.

## 3. Breakpoint map (measured; all values from the live probe)

```
>=1241px   #shell: 244 sidebar | #panes: list~40% reader~1fr rail 300 (static 3rd col)
1240       rail: static col → FIXED DRAWER (320px, ≤88vw, shadow, --z-drawer)     [V3:6356 + drawerMq]
1080       list floor 340→300px / 40%                                             [V3:6373  (legacy 2657 dup, loses)]
860        sidebar 244 → 64px ICON RAIL; brand/cats/footer labels hidden          [V3:6401 — the icon turn]
720        toolbar button labels → icon-only (font-size 0); list floor 260px/44%  [V3:6381]
600        panes STACK: 1 column, rows 3fr/2fr; compose → 100% bottom sheet        [V3:6392 + legacy 2684]
480        intended sidebar 52px — DEAD (860's 64px wins by order; measured 64)    [legacy 2707]
340        still coherent: no h-scroll at any width
```

Legacy/V3 duplicates at 1080/720/600 are conflicting-by-construction: they
encode the same transitions twice and rely on file order for the winner.
The ladder otherwise derives from **content floors** (list never below
260px, compose never narrower than viewport), not device names — good.

## 4. Content-driven adaptation (injection probe at 900px)

| Injected pathology | Result | Verdict |
|---|---|---|
| 140-char sender / 280-char subject / 40-char tag / long date | row height pinned at 62px; subject never overlaps the right gutter; tag clamps to pill-ish 34px; ellipsis engaged | **adapts** |
| All four at once | `listpane.scrollWidth > clientWidth` — **inner horizontal scroll appears inside the list pane**, document-level clean | MODERATE — contained but the row box should never outgrow its track |
| Height stress 560/420 | topbar already collapsed; palette `max-height:46vh` scales (257px/193px); reader/list split holds | adapts |

Heights: the architecture does not assume a tall screen — the single height
rule (700) exists, measured, and the scroll-collapsed topbar recovers every
state probe (`searching`/`selecting` guards). Nested scrolling is 1-deep
everywhere (`#scroller`, `#rail-scroll`, palette list): no nested-scroll
traps found.

## 5. Resize behavior (§11/§12)

Live wide→narrow→wide while *selected + reader open + query "semester" +
bulk mode + chip strip*: **all preserved**, focus stable, no mode reset.
The single regression is F-R1's ghost track appearing exactly in this path
(rail-open + ≤600 while selected).

## 6. Findings (classified)

| # | Sev | Where | Evidence |
|---|---|---|---|
| **R-A1** | **CRITICAL — FIXED `7d81db4`** | app.css:5937 vs ladder | ≤600px + `body.rail-open` + live rail content → `#panes` = 3 cols; **open reader = 0px wide**. Follow-up probe showed it was worse than first measured: the reader crushed at **every** width ≤1240 whenever reader+rail were both open (15px @900, 213px @1100). Fix: each drawer-mode block gained the `:has(#rail-scroll…)` form (equal specificity, later order). Matrix re-verified: 340–600 × {rail, reader, search} single stack; resize both directions restore 3-col at 1280. |
| R-A2 | **FIXED `c494b92`** | legacy ladder | Retired; byte-for-byte identical responsive matrix before/after proves it was dead weight. Breakpoint set is now exactly {1240,1080,860,720,600}, pinned. |
| R-A3 | **FIXED `c494b92`** | app.css 480px block | Both 480 rules (52px sidebar, 1fr/1fr split) were dead by source order — deleted, not resurrected; 64px icon rail measured coherent to 340px. Tests now fail if a 480 step returns. |
| R-A4 | **CLOSED — symptom of R-A1** | row internals | Re-probed post-fix at 1440/1240/860/600/340 with full pathological injection: `#listpane` scrollWidth == clientWidth everywhere. The audit's h-scroll measurement was taken *inside the corrupt 3-track grid*. No containment change needed; verified, not assumed. |
| — | **Round-63 item — FIXED `ce48c08`** | timetable ≤860px | Clipped tt-where/tt-now recover via titles + a condensed `.tt-meta` second row at ≤860 (rule-exact replica-verified placement). |
| R-A5 | OPPORTUNITY | icon rail (≤860) | Compose becomes a 46px circle; footer actions (activity/timetable/Gmail/sign-out) vanish whole — palette reaches some, Gmail/sign-out **none**. "Icon rail = pure navigation" erases *exit* |
| R-A6 | OPPORTUNITY | height | only one height rule; reader header + chips + banner + iframe at 420px leaves ~2 lines of body — consider a reading-focused compact header |
| R-A7 | OPPORTUNITY | toolbar ≤720 | labels disappear with no overflow menu — verbs stay (icons do carry), but "Views/Help" first-run teachability drops |

Not raised to findings: touch targets (32px min, panned scroll), density
(orthogonal, pinned), menu clamping (viewport-aware already), deep-link +
45-contract rows: all verified working.

## 7. Proposed breakpoint model (content-derived, from probe measurements)

```
reader needs ~360px + list floor 300px + rail 300px  →  3-col ends ≈1240  [current 1240 is CORRECT]
list+reader floors 300+360 = 660 + sidebar 244 ≈ 900 — sidebar icon-turn at 860 is 40px late but harmless
below 660: any 2-col is fractions → stack is correct at 600  [CORRECT]
below stack: single workspace; rail is a drawer everywhere ≤1240  [CORRECT]
```
The model *vindicates* the V3 ladder; the fix direction is deleting the
legacy ladder (retire 2657–2720), reviving or deleting the 480 intent, and
giving the stack step a selector that beats 5937 (e.g. include the
`:has(#rail-scroll…)` form in the 600 block — same trick menu.js taught).

## 8. Architecture maps

**Transformation map (measured):**
```
WIDE (≥1241)   shell: 244 | list 40% | reader 1fr | rail 300 static
MEDIUM (861–1240)  244 | list ≥300/40% | reader 1fr | rail = fixed drawer
NARROW (601–860)   64-icon-rail | list ≥260/44% | reader | drawer; toolbar icons-only ≤720
EXTREME (≤600)     64-icon-rail | STACK list 3fr / reader 2fr | drawer; compose = bottom sheet
```
**State map:** resize perturbs *nothing* — selection/reader/query/draft mode
all ride through (probe-verified); the only widow is the R-A1 layout.

**Overflow map:** `#scroller` (list), `#rail-scroll`, palette list (46vh),
reader body iframe (sandboxed) — all 1-deep, keyboard-ordered; one inner
h-scroll leak under injected extremes (R-A4).

---
*Probe: headless Chromium 131, 22 widths × 5 heights × live-resize × content
injection, preview build of the real classifier/store. Round 65 addendum —
filed alongside the surviving audits per the cleanup's load-bearing rule.*
