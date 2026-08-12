# 56 — UI INFORMATION ARCHITECTURE: PAPER REDESIGN (Project A)

**Round 56. Charter:** decide, on paper, which of the codebase's existing
bounded surfaces deserve to be major user-facing surfaces and which remain
subordinate UI — BEFORE any further code moves. No code changes in this
document or this round.

Inputs: audits/51-UI-ARCHITECTURE-MAP.md (CURRENT inventory + workspace
verdicts), audits/55 complete architecture audit (82 modules, enforced
layering, ctx seam, M-3 app.js breadth), rounds 51–54 execution history,
and the advisor's post-audit directive: *paper redesign first; use approved
UI boundaries to drive modularization, never the reverse.*

---

## 0. THE PROJECT DOCTRINE (adopted as law by this document)

### Keep a module large when it is ONE thing

```
one domain · one workflow · one state boundary · one clear owner
```

`timetable-ui.js` (1,338 lines) is the standing example: build wizard +
manage view + scan UI are one workflow over one state with one owner.
Splitting scan from view would recreate the seam round 54 removed (55 §15).

### Extract only when ALL three hold

```
multiple independent workflows
+ different agents would routinely modify different portions
+ the portions have a stable boundary
```

### Never extract because of line count

"> 1000 / 2000 / 3000 lines" is not a reason. Architecture improvement and
line-count-driven refactoring are different activities; only the first is
permitted in this repository.

### Corollary for the UI

A surface's CODE structure must follow its UI role, never the reverse.
Architecture that is healthy on paper can still be wrong for the product;
the round-55 audit's own words: *architecturally healthy + poorly optimized
for AI context* are independent axes. Both must hold.

---

## 1. CURRENT IA (as implemented at 6272f42, evidence-traced)

```
app.html
├── #sidebar ─── brand/freshness · saved views · categories · snoozed rail ·
│                outbox rail · deadline radar · [Compose] [Timetable]
│                [Back to Gmail] [Sign out]
├── #main
│   ├── #topbar ── search combobox · theme · density · help
│   ├── #panes ─── #listpane + reader/#reader-empty          ← MAIL surface
│   └── #tt-workspace ── tabs Schedule/Changes/Conflicts/Exams
│                                                        ← TIMETABLE surface
├── fixed overlays: #gate #compose #palette #help
├── layers stack (menus, dialogs, activity log) — LIFO, Esc-ordered
└── ambient: toast · offline banner · worker warning · new-pill
options.html (separate runtime context) ── settings · backup
```

Navigation facts (traced): sidebar is BOTH the app's workspace nav and the
mail taxonomy nav; Esc unwinds layers → dismissables → workspace → mail
state → release (INV-13); mailbox/category clicks return from the timetable
workspace to mail first (round 54).

The 12 bounded surfaces the codebase actually has (55 §I.3): Mail/list,
Reader, Compose, Timetable, Search, Rules, Activity, Saved views, Snooze,
Notices, Palette, Settings/options.

---

## 2. THE CLASSIFICATION QUESTION

Not "can this module be smaller?" but:

> **Does this surface serve a distinct user goal, with enough content and
> workflow depth to own the main area — or is it an instrument of another
> surface's workflow?**

### Criteria (a surface deserves workspace status with SEVERAL of)

C1 own navigation · C2 own persistent state · C3 own multi-step workflow ·
C4 multiple related screens · C5 content that overwhelms a panel ·
C6 different user goal from mail triage · C7 independent future
development · C8 bounded domain for an AI agent (changes land in one place).

### Scoring (evidence from 51/55 audits + traced usage)

| Surface | C1 | C2 | C3 | C4 | C5 | C6 | C7 | C8 | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| Mail (list+reader+compose) | ✓ | ✓ | ✓ | ✓ | ✓ | — (it IS the product) | ✓ | ✓ | **WORKSPACE (default)** |
| Timetable | ✓ tabs | ✓ entries/findings | ✓ build/scan/apply | ✓ 4 rooms | ✓ week grid+history+exams | ✓ academic ≠ triage | ✓ | ✓ measured | **WORKSPACE (pilot, done)** |
| Settings | ✓ sections | ✓ schema | — | ✓ | medium | ✓ configuration ≠ triage | ✓ | ✓ options page | **SEPARATE PAGE (already)** |
| Search | — | query only | — | — | results render IN the list | ✗ search serves triage | low | ✗ split would duplicate the list | subordinate |
| Rules | — | rules store | thin (menus) | — | ✗ | ✗ serves triage | low | menus+engine already bounded | subordinate |
| Snooze | — | schedule | one-step | — | ✗ | ✗ | low | ✓ | subordinate |
| Activity | — | log | read-only | — | ✗ (last-N list) | low | low | ✓ | subordinate |
| Saved views | — | views | one-step | — | ✗ | ✗ | low | ✓ | subordinate |
| Notices | — | findings | one-step | — | ✗ | ✗ academic-adjacent | ✓ | subordinate |
| Palette | — | — | — | — | ✗ | ✗ accelerator | low | ✓ | subordinate |
| Reader (alone) | — | — | — | — | — | ✗ half of the mail workflow | — | ✓ | component of Mail |
| Compose (alone) | — | drafts | ✓ | — | — | ✗ half of the mail workflow | — | ✓ | component of Mail |

**Result: two workspaces (Mail default + Timetable) and one separate page
(Settings). Everything else stays subordinate.** This is not conservatism
for its own sake: every "subordinate" verdict above has a falsifiable
reason (marked ✗ columns), and the promotion gate in §6 says exactly what
would change a verdict.

---

## 3. PROPOSED IA (approved shape)

```
┌────────────────────────────────────────────────────────────────┐
│ APP SHELL  app.js/app.html                                     │
│   owns: boot · worker bridge · sync · workspace switching ·    │
│         Esc ladder · global banners · toast · sidebar chrome   │
├──────────────┬─────────────────────────────────────────────────┤
│ SIDEBAR      │ ACTIVE SURFACE                                  │
│ (app nav +   │ ┌─────────────────────────────────────────────┐ │
│  mail        │ │ MAIL WORKSPACE (default)                    │ │
│  taxonomy)   │ │  topbar(search/theme/density/help)          │ │
│              │ │  panes: list ⇄ reader · compose panel       │ │
│  · views     │ │  rails: snoozed/outbox/radar/notices        │ │
│  · categories│ ├─────────────────────────────────────────────┤ │
│  · rails     │ │ TIMETABLE WORKSPACE                         │ │
│  · [Timetab.]│ │  header · tabs: Schedule Changes Conflicts  │ │
│  · compose/  │ │  Exams · build wizard when empty            │ │
│    gmail/    │ ├─────────────────────────────────────────────┤ │
│    signout   │ │ SETTINGS — separate page (options.html),    │ │
│              │ │ never an in-app panel                        │ │
│              │ └─────────────────────────────────────────────┘ │
├──────────────┴─────────────────────────────────────────────────┤
│ SUBORDINATE SURFACES (instruments, not destinations):          │
│   search combobox+overlay · rules/category menus · snooze menu │
│   · activity layer · palette · dialogs · saved-views rail      │
└────────────────────────────────────────────────────────────────┘
```

### Product claim preserved

The sidebar keeps mail-first ordering and the timetable stays sized as a
secondary tool (app.html's positioning comment stands): *a mail client that
understands student life, not a student platform with a mailbox attached.*
The workspace promotion gives the academic half room to breathe WITHOUT
promoting it to a peer of mail. A full peer rail (Mail · Search · Rules ·
Activity as equals) would overturn that claim and remains explicitly
out of scope — see §9 guardrails.

---

## 4. NAVIGATION MODEL (the rules every surface obeys)

1. **One app nav.** The sidebar is the only workspace switcher. No second
   rail, no hamburger, no breadcrumbs.
2. **Workspaces take the main area whole.** Opening a workspace hides the
   mail chrome (topbar+panes), never floats over it. Overlays are reserved
   for things that are genuinely dismissable and transient (menus, dialogs,
   palette, compose panel).
3. **Subordinate surfaces never take the main area.** Their maximum
   expression is a rail section, a menu, or a layer — this is what keeps
   "hidden drawers" from regrowing.
4. **Esc is one ladder, structurally ordered:** layer stack → dismissables
   → active workspace → mail state → release (INV-13). New surfaces slot
   into a rung; nobody re-orders prose.
5. **Any sidebar navigation returns to mail first** when a workspace is
   active (round-54 behaviour, pinned) — the sidebar is mail's home turf.
6. **Back-to-mail affordances are redundant on purpose:** the workspace
   header button AND Esc AND any sidebar click. Redundancy in exits is
   cheap; a trapped user is not.
7. **Settings is reached from the sidebar/options page only** — never from
   a workspace header, never as a layer. One home (51 §2 doctrine).

---

## 5. STATE CROSSING BOUNDARIES (IA view of audit 55 §7)

| State | Owner | Crosses into | Mechanism | Rule |
|---|---|---|---|---|
| active store | shell | every mail surface | ctx getter (INV-4) | never captured by value |
| rules | shell | selectors, menus, sidebar, ingest | ctx getters/setters | one owner, many readers |
| deadlineOverrides | shell | radar, lanes, selectors, deadline menu | ctx getter | resolution via ONE function (`dueAtOf`) |
| timetable state | timetable-ui | reader banner (`timetableEffectsOf`) | one-way data query | the ONLY academic→mail bridge; message↔entry both directions via provenance |
| selection | bulk.js | list rows, bulkbar | accessors | transient; Esc unwinds before reader |
| settings cache | settings.js | everything (sync reads) | schema accessors | options page writes follow live |
| snooze/outbox queues | domain stores | rails (app) + alarms (worker) | declared worker edges | storage-only modules cross contexts |
| imageAllow / queryHistory | reader/suggest | storage | ad-hoc keys | flagged: registry candidate (55 M-1) |

**Boundary rule:** a workspace may READ shared state freely and WRITE only
through its owner's seam. No workspace imports another workspace's module
(verified acyclic at every extraction; the single cross-surface query —
reader→timetable effects — is data-only and one-way).

---

## 6. MODULE OWNERSHIP MAP (UI role ↔ code ↔ boundary)

| UI role | Module(s) | Owner boundary | Agent instruction |
|---|---|---|---|
| Shell | app.js, app.html | boot/sync/routing/global chrome | "change sync or navigation: read app.js; nothing else" |
| Mail workspace | list.js reader.js bulk.js suggest-ui.js sidebar.js rails.js display.js + primitives | one seam each (wire*/ctx) | "change the list: list.js; the reading pane: reader.js" |
| Timetable workspace | timetable-ui.js (+ timetable.js model, timetable-store.js, timetable-mail.js) | surface=UI+tabs, model=policy | "change timetable UI: one file" — MEASURED: all post-pilot feature diffs landed in timetable-ui.js; shell files moved only at the seam (app.html container, Esc rung, surface CSS) |
| Settings page | options.html/options.js + settings.js schema | page owns layout; schema owns keys | "add a preference: settings.js SCHEMA + options.js" |
| Subordinates | palette.js activity-ui.js menus saved-views.js autocomplete.js bulkbar.js notices-rail.js help.js | tenants of layers/menu primitives | one file per instrument |
| Domain/pure | store/query/classify/rules/deadlines/snooze/outbox/… | no DOM, no chrome.* | safe from any context |

---

## 7. TIMETABLE PILOT EVALUATION (advisor step 3 — the gate for all future promotions)

The pilot is judged on two questions, each with a measured test:

**Q1 — Did the workspace make the UI easier to navigate?**
- Steps to "see my week": sidebar click → done (was: click → layer → scroll
  past pending/conflicts). Tabs replaced stacked sections: every room is one
  click, zero scroll-hunting.
- Nothing was hidden to achieve it: all four rooms still exist; empty ones
  render no tab (honest emptiness, the rails' rule one level up).
- Regressions to watch: mail→timetable→mail round trips (Esc + sidebar +
  header button), reader banner still answers "what did this message
  change". Integration coverage: 23 TIMETABLE tests green at promotion.

**Q2 — Did it give AI agents a bounded code domain?**
- MEASURED (git history since f9f2b69): feature changes (grid pruning, tab
  state) touched timetable-ui.js only; shell-side diffs were seam files
  (container markup, Esc rung, surface CSS). The prediction "improve
  timetable → start in one directory" holds.
- Ongoing check: any future timetable change that must edit app.js logic
  (not the seam) is a boundary failure and must be diagnosed before more
  promotions happen.

**Promotion gate for any future surface:** BOTH questions must be
answerable the same way, with evidence, BEFORE code moves. No exceptions.

### A5 VERDICT (round 57 — evaluation executed)

**Q1 PASS, and completed.** The navigation claims are now contracts, not
prose: empty rooms render no tab; counts ride full ones; the tablist keeps
ONE tab stop (roving, the rail's doctrine) and arrow/Home/End keys switch
rooms with focus re-placed; a conflicted room earns a counted tab; sidebar
navigation and Esc and the header button all return to mail (four pinned
paths). Round 57 also CLOSED the pilot's one real gap — the tabs were
mouse-only; the workspace is now complete as an accessible surface.
Nothing was hidden to achieve any of it: all four rooms still exist.
Suite: 114/114 integration2 (23 original TIMETABLE + 4 EVAL contracts).

**Q2 PASS, and enforced.** The bounded-domain property was measured from git
history (above) and is now an architectural PIN (architecture.test.mjs,
round 57): no `tt-*` DOM may appear in app.js; the shell keeps seams only
(container, Esc rung, rail button). Boundary erosion fails CI, not review.

**Consequence per step 4:** the evaluation found NO subordinate surface
whose verdict should change — the §2 ✗ columns all stand. Therefore **no
further promotion is scheduled**; the next promotion happens only when real
usage produces §7-grade evidence for one.

---

## 8. MIGRATION ORDER (what is done, what is deliberately not planned)

| Phase | Content | Status |
|---|---|---|
| A0 | UI map + workspace verdicts | ✔ round 51 |
| A1 | Code sequence: reader/display → suggest → rails → list → sidebar → bulk | ✔ rounds 51–52 |
| A2 | Timetable workspace pilot + layout targets | ✔ round 54 |
| A3 | Architecture audit (evidence base for this paper) | ✔ round 55 |
| A4 | **This paper** | ✔ round 56 |
| A5 | Pilot evaluation against §7 criteria | ✔ round 57 (verdict below) |
| — | Search/Rules/Activity promotions | **NOT PLANNED** — subordinate verdicts stand until §7-style evidence overturns one |
| — | Full peer workspace rail | **OUT OF SCOPE** — overturns the product claim; requires an explicit product decision, not architectural momentum |
| — | app.js triage-verb extraction | **PARKED** — candidate acknowledged (55 M-3); extracts only when a concrete change crosses its boundary, never for size |

---

## 9. GUARDRAILS (what this paper forbids)

1. No promotion because the code already looks workspace-shaped. Code
   structure follows UI decisions, never the reverse.
2. No new in-app settings surface — options.html is the one home.
3. No second navigation rail, no breadcrumbs, no workspace switcher outside
   the sidebar.
4. No subordinate surface may grow into the main area (that is how drawers
   are born).
5. No extraction for line count (doctrine §0).
6. No agent performs "complete UI redesign + complete modularization" in
   one operation (51 §7, reaffirmed).
7. Every future promotion repeats §7's evaluation with measured evidence
   BEFORE code moves.

---

## 10. SUMMARY OF DECISIONS

1. **Two workspaces** (Mail default, Timetable pilot) **+ one separate
   page** (Settings). Everything else subordinate — each with a
   falsifiable reason recorded in §2.
2. **The ctx seam is the architecture.** No router, no state framework, no
   component library: App Shell → Workspaces → Surface modules → Domain,
   built on what exists and is enforced.
3. **The keep/extract doctrine of §0 is project law.**
4. **The timetable pilot's measured bounded-domain property is the gate**
   every future promotion must pass.
5. **Project B (further modularization) starts only when an approved UI
   boundary from this paper demands it** — or when a concrete change
   crosses the parked triage boundary in app.js.

DESIGNED ↔ ACTUAL status: for once, identical — this paper ratifies the
implemented shape rather than proposing a divergent one. The only gaps are
the intentional parks (peer rail, triage extraction), each with its unlock
condition stated.
