# V3 Overhaul — plan, verified baseline, and design contract

**Round 64.5 — UI/UX/theme/animation major overhaul.** Owner directive: the
overhaul is primary, the audit is secondary; every old rule and constraint is
subject to change or deletion; work lands directly on `main`; perfection is
judged by **screenshots**, not by argument.

This document is the plan and the contract for what follows. It exists so the
overhaul is a **designed** system, not sixty rounds of drift compressed into
one diff.

---

## 0 · Verified baseline defects (measured 2026-08-12, headless Chromium,
preview build, 1280×860)

Every one of these was measured in the live DOM, not eyeballed:

| # | Defect | Measurement |
|---|---|---|
| D1 | Reader pane is **0px wide** at rest, its content visibly bleeding | `#panes:has(#reader[hidden]) { grid-template-columns: minmax(300px,640px) 0 }`; readpane rect w=0, but `reader-empty` content spills to x=972 — "Select a message" wraps character-by-character into the void |
| D2 | Mailbox navigation **clipped to 52px** | `#cats` h=52.06 while containing all 23 nav rows (7 mailboxes + 15 categories); flex siblings (views 291px, side-foot 168px, brand 252px) starve it to one visible row |
| D3 | The brand block renders a **giant white clock card** | `#btn-activity` (a `.ghost.icon` button inside inline `#brand-text`) balloons to ~150×150; `#brand-text` h=224 |
| D4 | Sidebar is **over-crowded by design** | VIEWS (8 rows), DUE SOON, plus footer of 4 full-width buttons all stack in one 243px column; the actual navigation gets the scraps |
| D5 | Layer order is ad-hoc numbers | z map: topbar 2, listpane 1, suggest 40, gate 20, compose 60, palette 70, help 50, toast 80, menus 40-in-host — menus mount into their anchor's stacking context, so a menu anchored low (row, reader) can sit **under** chrome anchored high; the reported "dropdown goes under other components" |
| D6 | Notices float as an unanchored white card | `#notices li` renders 608px card overlapping the list header area with no strip styling |
| D7 | Motion is invisible | one-line findings: rows appear instantly (zero entrance), most state flips are `hidden` toggles; the "23 entrances / 1 exit" audit improved exits but the product still reads as static. User verdict: "I can't see any animation at all." |
| D8 | Sidebar overflow at intermediate widths | `--sidebar-w` collapses to 64px at ≤860 hiding `#views`/`#radar` (so they exist but vanish), while at 861–1080 the full stack must squeeze; nav clips (D2) rather than scrolling |

The previous 63 rounds produced correctness, security and tests; the *chrome*
of the app — hierarchy, crowding, choreography — is the part that was never
designed as one system. This overhaul designs it.

---

## 1 · The design contract (what "alive" means, concretely)

**R1 · One hierarchy, stated once.** Navigation lives in the sidebar. Context
(due-soon, snoozed, outbox, needs-you) lives in a right **rail**. Actions live
in bars near their subject. Nothing stacked ad-hoc. Three zones, each with one
job:

```
┌────────┬──────────────────────────────┬─────────┬──────────┐
│ SIDEBAR│ TOPBAR (search + commands)   │         │          │
│ brand  ├───────────┬──────────────────┤ READER  │  RAIL    │
│ compose│ LISTBAR   │ LIST             │         │ due soon │
│ NAV    │           │ (rows)           │         │ needs u  │
│ (scrolls)          │                  │         │ snoozed  │
│ foot   │           │                  │         │ outbox   │
└────────┴───────────┴──────────────────┴─────────┴──────────┘
```

**R2 · The rail holds what the sidebar held.** `#radar`, `#snoozed`,
`#outbox` and the idle "needs you" panel move to `#rail`. VIEWS moves out of
the sidebar entirely into a topbar menu (`Views ▾`). Element IDs are the
module contract, so modules don't change — homes do.

**R3 · The nav can never be starved.** Sidebar is `grid: auto auto 1fr auto`
— brand, compose, nav, footer. Only `#cats` scrolls; it is also the only
flexible region, with a `min-height` floor, so D2 is structurally impossible.

**R4 · No 0-width panes.** The `:has(#reader[hidden]) → 0` rule is deleted.
The reader keeps a real column and its empty state is a designed surface.

**R5 · One z-ladder, tokenized; one overlay root.** All floating UI (menus,
palette, dialogs, compose, toast, gate) mounts under `#overlay-root` with
`position: fixed` coordinates measured from the anchor's viewport rect.
Nothing floating ever renders inside a content stacking context again, so
"under other components" becomes impossible by construction.

**R6 · Motion you can actually see.** New choreography (all transform/opacity,
all instant under `prefers-reduced-motion`):

- **List entrance**: rows cascade — fade + 10px rise, 260ms, 22ms stagger,
  first 14 rows.
- **Overlays**: scale .96→1 + fade + 6px rise on a spring curve, 220ms.
- **Interactive**: every button/row/nav item transitions 140–180ms; hover
  raises (translateY(-1px) + shadow), press compresses (scale .97).
- **The reader**: slides in from the right 24px + fade when a message opens.
- **Theme switch**: surfaces cross-fade (background/color/border 200ms).
- **Toasts**: rise + spring; the archive ghost stays.
- **New mail**: rows flash the unread accent once.

**R7 · Overflow discipline.** Every flex/grid text cell carries
`min-width: 0` + ellipsis; every column declares its scrollowner; the
responsive ladder is re-measured (1280 / 1080 / 860 / 720 / 600 / 480) and
screenshotted at every rung.

**R8 · Old constraints retired by name.** The following audit-era rules are
deliberately repealed or relaxed, with tests updated to the new contract:
"idle reader yields its column to the list" (D1), "views first-class in
sidebar", "one `.primary` per screen", the rigid entrance/exit asymmetry
verdicts, and any tab-stop budget that contradicts the new chrome. Rules that
protect *correctness and accessibility* (listbox tree, contrast, named
controls, reduced-motion) are NOT repealed.

---

## 2 · Execution checkpoints

1. ✅ Baseline screenshots + DOM metrics (this file's §0)
2. Plan commit (this file) — pushed
3. Skeleton restructure: `app.html` zones + `app.css` layout/overflow rewrite
   → screenshot loop at 6 widths
4. Sidebar rebuild: brand fix, compose top, nav floor, compact footer
5. Rail build: moved sections styled as cards; rail toggle + persistence
6. Overlay root + menu.js fixed-position anchoring → dropdown repro test
7. Motion system: tokens, keyframes, row cascade, reader slide, press/hover
8. Rows: one-line scannable anatomy at all three densities
9. Screenshot polish loop (themes × widths × states) until clean
10. Test reconciliation: update layout-contract/polish/menu pins to the new
    contract; targeted suites green locally; CI is the full-suite authority
11. Push; before/after evidence table in the commit message
