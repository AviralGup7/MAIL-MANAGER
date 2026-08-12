# 58 — INFORMATION HIERARCHY & LAYOUT ARCHITECTURE AUDIT

**Round 58. Charter:** determine whether the application's entire information
hierarchy and page architecture needs redesign — from user tasks, not from
the DOM. Auditing the architecture, NOT protecting it. Where this audit
found failures, they were fixed in the same round (cycles 2–4 below); every
fix is marked **[FIXED]** with its commit, every accepted risk is marked
**[KEPT]** with its justification.

Method: markup inventory of app.html/options.html + JS state/visibility
tracing (what is reachable from where), control counts per surface, cap
audits, pin cross-checks. Conclusions that could not be measured are marked
**DESIGN JUDGMENT**.

---

## 1. EXECUTIVE DIAGNOSIS

**The single-page model has NOT failed. Three surfaces had failed the
hierarchy, and all three were fixable without decomposition.**

The evidence: the product has exactly two information domains (mail,
academics) plus configuration. Mail is one workflow family (scan → read →
triage → reply) sharing one dataset; academics is a second workspace
(promoted in round 54); settings already live on their own page. That is
three pages' worth of concepts in a product whose domains genuinely share
context (deadlines extracted FROM mail, timetable effects applied TO mail).
Splitting mail into more pages would separate things that belong together;
the actual failures were local: information hidden behind recall-dependent
paths, one buried creation action, one split appearance setting, and one
options page that separated an input from its instructions.

Found and fixed this round: **5 hierarchy failures** (H1 activity-log
concealment, H2 buried add-course, H4 invisible help, H10 split appearance
settings, H-opts orphaned instructions). Examined and deliberately kept:
**7** (documented with reasons in §3). Rejected-as-temptations: **9**
compression strategies (§15).

---

## 2. CURRENT INFORMATION ARCHITECTURE MAP (as of 70a82b1 + this round)

```
EXTENSION
├── Gmail page ── takeover/content.js
│     chord Alt+Shift+M · iframe handshakes · suspend/restore
│
├── APP PAGE (app.html) — one shell, two workspaces, subordinate surfaces
│   ├── #sidebar ──────────────────────────────────────────────── 1 surface
│   │   ├── brand · account · freshness (sync stamp) · ACTIVITY button [NEW]
│   │   ├── Views rail        (saved views, live counts, empty-hint)
│   │   ├── Categories nav    (7 mailboxes + All + 15 categories, roving)
│   │   ├── Snoozed rail      (≤8, hidden when empty, Wake action)
│   │   ├── Outbox rail       (hidden when empty, retry/discard when stuck)
│   │   ├── Deadline radar    (≤6, hidden when empty, urgency bands)
│   │   └── footer: Compose(primary) · Timetable · Back-to-Gmail · Sign-out
│   ├── #main
│   │   ├── #topbar ──────────────────────────────────────────── 1 surface
│   │   │   search combobox (+save-view, +note) · ctx-actions(3 icons) ·
│   │   │   Refresh · Load-more · HELP button [NEW] · Appearance menu [NEW]
│   │   ├── #panes (MAIL workspace)
│   │   │   ├── listpane: listhead/bulkbar swap · list rows · new-pill ·
│   │   │   │             empty state · skeleton
│   │   │   └── reader / reader-empty(idle preview)
│   │   │        head · tags+recat · DUE banner · TIMETABLE-EFFECTS banner ·
│   │   │        unfold · action bar (≤9 by mailbox) · attachments ·
│   │   │        image-permission bar · thread strip · body iframe
│   │   └── #tt-workspace (TIMETABLE workspace, round 54)
│   │        header(semester · Mark-complete · Reset · Back-to-mail) ·
│   │        tabs Schedule/Changes/Conflicts/Exams (empty rooms render
│   │        nothing) · Schedule room: ADD-COURSE search [MOVED to top] ·
│   │        week grid · course list
│   ├── overlays: gate(sign-in) · compose panel · palette(Ctrl+K) · help
│   ├── layer stack: menus (category · recategorise · snooze · follow-up ·
│   │   deadline · Appearance) · dialogs (confirm/prompt) · activity log
│   └── ambient: toast · offline banner · worker warning
│
├── OPTIONS PAGE (options.html) — settings workspace, 8 sections:
│   client-ID input → client-ID setup guide [ADJACENT now] → Appearance ·
│   Rules · Backup · Sending · Reading · Composing
│
└── WORKER (background/) — no UI; verbs, alarms, notifications
```

Reachability (traced through JS, not markup): everything above is reachable
in ≤2 deliberate steps from the shell; the deepest chains are
reader → deadline-menu → dialog (3) and recategorise → menu (2), both
task-scoped and both closing on one Esc.

---

## 3. HIERARCHY VIOLATIONS FOUND (and the verdicts)

### Fixed

| # | Violation | Level that was wrong | Fix |
|---|---|---|---|
| H1 | Activity log reachable ONLY via Ctrl+K → type "activity" — information you had to remember was hidden | application level: an operational record had no home in any visible surface | **[FIXED]** visible button beside freshness — both answer "what is happening with my mail" |
| H2 | Timetable add-course buried under grid + course list — primary creation action below secondary information | section level inside a room | **[FIXED]** course search leads the Schedule room, matching the build view |
| H4 | Help existed only as a key — an invisible affordance | topbar level | **[FIXED]** Help button in the toolbar |
| H10 | Density (appearance) lived only on the options page while theme lived in the topbar — one concept split across contexts | application level: appearance had two homes | **[FIXED]** Appearance menu = theme group + density group, one divider, radio semantics both |
| H-opts | Client-ID instructions separated from the client-ID input by six unrelated sections | page level: an explanation orphaned from its subject | **[FIXED]** guide moved directly under the input ("the box above" is now literally above) |

### Examined and KEPT (with the reason each is not a violation)

| # | Surface | Temptation | Why kept |
|---|---|---|---|
| K1 | Reader action bar: up to 9 simultaneous actions | overflow menu | All 9 are triage verbs of EQUAL class; per-mailbox filtering already removes the irrelevant ones; frequency-hiding would trade discoverability for tidiness in the product's CORE workflow. DESIGNED + documented |
| K2 | Sidebar footer mixes Compose + Timetable + Back-to-Gmail + Sign-out | split into menus | These are four session-level controls, visually differentiated (primary / ghost / ghost-small); a menu here would nest the escape hatch. DESIGNED |
| K3 | Rails (snoozed/outbox/radar) inside the navigation sidebar | "navigation mixed with content" | Rails are STATE GLANCES capped at 8/8/6, hidden when empty; they are not destinations and never scroll independently of the nav. Moving them to a page would cost a trip for a glance. DESIGN JUDGMENT, kept |
| K4 | Saved views appear in rail + suggestions + palette | deduplicate | Three LEVELS of one object: persistent home, contextual-at-typing, accelerator. Same object, different moments — not duplication |
| K5 | Palette duplicates routes (compose/undo/views/categories…) | prune | The accelerator pattern: every palette command also exists visibly elsewhere; the palette is for hands-on-keys speed, never the only door. Verified: no palette-only function exists except the activity log, which H1 just fixed |
| K6 | New-pill / offline banner / worker warning coexist | merge | Three different TRUTHS (arrivals, connectivity, degradation) with different lifetimes; merging would lie about at least one |
| K7 | Sidebar holds 23 nav destinations | collapse categories | One-line items, roving tabindex = ONE tab stop; collapsing would hide the taxonomy that IS the product's promise. Scroll budget measured: worst case ≈ 23 items + 3 rails + footer, single scroll, no nesting |

---

## 4. OVERLOADED PAGES/PANELS — MEASURED

| Surface | Concepts | Controls | Destinations | Nesting | Scroll | Verdict |
|---|---|---|---|---|---|---|
| Sidebar | 6 sections | 4 footer + 1 activity | 23 nav + 3 rails | depth 1 | one scroll | **busy but sound** — K3/K7 |
| Topbar | search + 5 control clusters | ~9 (2 contextual) | — | depth 1 | none | sound |
| Reader | head/tags/2 banners/8 actions/attachments/images/thread/body | ≤9 actions + 2 image + recat | — | depth 1 | body only | sound — K1 |
| Timetable workspace | 4 rooms | header 4 + tabs ≤4 | 4 tabs | depth 1 | per-room | sound (round 54) |
| Compose panel | recipients/subject/body/attachments/send | ~12 | — | depth 1 | body | sound — one task, one panel |
| Options | 8 sections | ~18 | — | depth 1 | page | sound after H-opts |
| Gate | title + 1 action + error | 1 | — | — | none | minimal — correct |

**No surface is a compressed page.** The round-54 promotion removed the only
one (the timetable dialog). The test-verified tab-stop budget (≤21, now
accounted to 22) is the standing numeric guard against stop proliferation;
the pin demands any future increase be named.

---

## 5. HIDDEN-INFORMATION PROBLEMS

| Information | Where it lived | Problem | Resolution |
|---|---|---|---|
| Activity log | palette-only | recall-dependent | **[FIXED]** H1 |
| Help/shortcuts | ?-key only | invisible | **[FIXED]** H4 |
| Density | options-only | context-split | **[FIXED]** H10 |
| Client-ID guide | page bottom | orphaned | **[FIXED]** H-opts |
| Unread-per-category | sidebar counts | — | visible always (counts render even at 0-read) — correct |
| Deadline evidence | reader banner quotes `dueText` | — | visible where questioned — correct |
| Snoozed mail | rail (hidden when empty) | — | hidden-when-empty is honesty, not concealment; Wake + WAKE_DUE alarm restore it — correct |
| Worker degradation | persistent banner | — | states itself, offers no false comfort — correct |
| Message bodies | sandboxed iframe, remote images blocked by default | — | privacy default with an explicit, sender-scoped unlock bar — correct |

Remaining hidden things are all **justified deferrals** (§7 pattern:
rare/destructive/expert behind a deliberate step, never behind recall).

---

## 6. NAVIGATION-DEPTH PROBLEMS

Measured paths (steps from shell steady state):

| Task | Path | Steps |
|---|---|---|
| Open message | click / j-k | 1 |
| Archive/star/snooze | key or action bar | 1 |
| Deadline correction | reader → Deadline menu → dialog | 3 — task-scoped, Esc-ordered |
| Recategorise | reader tag → menu | 2 |
| Bulk action | ticks → bulkbar | 2 |
| Search | / → type | 1–2 |
| Save view | search → Save view (appears with query) | 2 — contextual appearance |
| Timetable | sidebar button | 1 (+ tabs 1) |
| Add course | workspace → search leads the room | 1–2 **[FIXED H2]** |
| Activity log | sidebar button | 1 **[FIXED H1]** |
| Settings | options page (own context) | 1 trip |
| Backup | options → Backup section | 1 trip + 1 |

**No panel→panel→menu→modal chains exist.** Nothing changes route based on
hidden state except the layer stack itself, which is structurally ordered
(LIFO). Duplicated routes (K4/K5) are accelerators over visible paths, never
replacements. Spatial-lost risk: zero known — every workspace has ≥2 exits
documented in the round-56 nav model.

---

## 7. EVIDENCE & MEASUREMENTS (source of every claim above)

- Counts: `app.html` inventory; `MAILBOXES` (7) + `SIDEBAR_ORDER` (15) + All
  = 23 destinations (mailboxes.js:49, categories.js:59).
- Reader actions: 11 `data-act` buttons in markup; `actionsFor`
  (mailboxes.js:133) hides per mailbox — default shows 8 + Open-in-Gmail.
- Rail caps: snoozed `slice(0, 8)` (rails.js:75), radar `RADAR_MAX` = 6 +
  idle preview 4 (radar.js:120/178).
- Tab stops: integration pin counts persistent stops across 3 vs 200
  messages, budget `< 22` after this round's two accounted additions.
- Options: 8 `<legend>` sections; reorder verified by options.test 15/15.
- Theme/Appearance menu: `.theme-item` vs `.density-item` keep radio
  semantics per group; integration THEME suite 6/6.
- Timetable room order: integration2 TIMETABLE 27/27 after the reorder.
- Palette-only surfaces: grepped — after H1, zero functions are reachable
  only through the palette.
- UNMEASURED (labelled): real-Chrome panel pixel heights — the repo's
  visual-regression tooling covers this separately; no conclusion in this
  audit depends on pixels.

---

## 8. RECOMMENDED INFORMATION HIERARCHY (the shape the product should keep)

```
NAVIGATION   sidebar = app nav + mail taxonomy (the ONLY switcher)
WORKSPACE    Mail (default) · Timetable · Settings-page
TASK         inside a workspace: list/reader rooms; tabs in timetable
SUPPORTING   rails (state glances), banners (context truths), counts
ACTIONS      where the object is: row star, reader verbs, rail Wake,
             bulkbar on selection — never a global action drawer
OVERLAYS     only the transient/dismissable: menus, dialogs, palette,
             compose, help, gate
```

Rules (round-56 paper, reaffirmed): subordinates never take the main area;
workspaces take it whole; Esc is one structural ladder; every hidden thing
is hidden by honesty (empty) or by deliberation (rare/destructive/expert),
never by recall.

## 9. PAGE/VIEW DECOMPOSITION

**Keep together:** list+reader+compose (one workflow, one dataset); sidebar
nav+rails (nav + its state glances); theme+density (one Appearance concept);
client-ID input+guide (subject + explanation).
**Separate:** already separated correctly — Settings (own page), Timetable
(own workspace). Nothing further qualifies today: the §3 K-table is the
standing argument.
**Contextual:** save-view (appears with a query), image bar (appears with
blocked images), unfold (appears with folds), bulkbar (appears with
selection), rails (appear with content), recat (appears on a tag).
**Temporary:** all menus/dialogs/palette/help/toast — layer-stack governed.

## 10. GLOBAL LAYOUT ARCHITECTURE

Pattern mix (deliberately not one pattern everywhere): **one main workspace
with a whole-area switch** (mail ⇄ timetable), **split view** inside mail
(list|reader), **contextual side panels** nowhere needed (rails instead),
**separate page** for settings, **command navigation** as accelerator only.
Rejected: drill-down pages (nothing is deep enough), secondary nav rails
(the sidebar is the nav).

## 11–14. VISIBILITY LEDGER

**Always visible:** current location (sidebar currents + workspace header),
primary nav, sync freshness, unread counts, selection state, critical errors
(offline/worker banners, gate error), primary actions (Compose, per-object
verbs). **Contextual:** §9 list. **Separate pages:** Settings only.
**Removed/merged this round:** the theme-only menu (merged into
Appearance); nothing else qualified for removal — no dead surface exists.

## 15. REJECTED QUICK FIXES (the critical rule, applied)

Rejected in this audit's own deliberation: "More"-ing the reader action bar
(K1); collapsing categories behind an expander (K7); moving rails to a page
"to clean the sidebar" (K3); a generic in-app settings layer (two homes);
nested menus for the footer controls (K2); accordion tabs in the timetable;
tooltip-only icon controls (the two NEW buttons both carry visible labels or
names); deduplicating views by killing the rail (K4); any fix that hides
something to make room.

## 16. MIGRATION STRATEGY FROM HERE

Nothing structural needs migrating — this round's fixes were local and each
shipped behind its gates. Standing trajectory: (1) any NEW surface starts as
a subordinate and earns workspace status only via the round-56 §7 evidence
gate; (2) the tab-stop budget and the architecture pins police regression;
(3) if real usage ever shows a third domain (beyond mail/academics), the
promotion playbook is the timetable one — container in #main, Esc rung,
seam-only shell involvement, boundary pin.

## 17. HIGHEST-PRIORITY REDESIGN OPPORTUNITIES

Ranked by value/risk — all are now either DONE or explicitly parked:

1. **[DONE]** Surface the activity log (H1) — highest recall-cost removed.
2. **[DONE]** Un-split appearance (H10) + visible help (H4).
3. **[DONE]** Unbury timetable creation (H2) + options adjacency (H-opts).
4. **[PARKED, gated]** Full peer workspace rail — product decision only
   (round-56 §9).
5. **[PARKED, gated]** app.js triage-verb extraction — on boundary-crossing
   change only (round-55 M-3).

---

## CYCLE LOG (audit executed in 4 cycles, as chartered)

- **Cycle 1:** inventory + measurement + violation list (12 candidates).
- **Cycle 2:** H1/H2/H4/H10 fixed (`346527b`), gates green.
- **Cycle 3:** H-opts fixed; gate/reader/ambient/rail sweeps → K-verdicts;
  tab-stop budget accounted (`70a82b1`); options 15/15, integration 99/99.
- **Cycle 4:** this document; final gate pass; closeout commit.

**Bottom line:** the hierarchy did not need a redesign — it needed five
corrections, each smaller than a panel. The single-page-plus-workspaces
model is the right architecture for two domains plus configuration, and it
now has no known concealment, orphaning, or burial left in it.
