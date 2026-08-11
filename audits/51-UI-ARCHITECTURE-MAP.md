# 51 — UI Architecture Map (workspace model)

Round 51. Triggered by the maintainer's reframing: the product has outgrown
the single-page/single-shell mental model — "many things hide under others,
2–3 side panels are not enough, concepts overlap." The conclusion under
audit: this is an **information-architecture** problem, not a file-size
problem, and the fix is modularization at the level of **major UI
workspaces**, never arbitrary code chunks.

This map is the essay's Step 1: CURRENT inventory → PROPOSED topology →
what moves where → what stays shared → what state crosses boundaries →
migration sequence. Code moves only against this map, one module per round,
each behind the affected-test gate.

---

## 1. What the app actually is today

One HTML shell (`app.html`) containing everything, with secondary surfaces
stacked on top as layers, menus and dialogs:

```
SHELL (app.html)
├── sidebar            brand/freshness · saved views · categories ·
│                      snoozed rail · outbox rail · deadline radar ·
│                      Compose / Timetable / Back-to-Gmail / Sign-out
├── topbar             search box + suggestions · theme · density · help
├── panes
│   ├── listpane       message list · bulkbar · empty/skeleton states
│   ├── reader         head · tags · deadline/timetable banners ·
│   │                  thread strip · body iframe · attachments ·
│   │                  image bar · action bar
│   └── reader-empty   idle preview (due items) / nothing-selected state
├── dialogs            gate (sign-in) · compose · palette (Ctrl+K) · help
├── layers             timetable · activity log          (layers.js)
├── menus              snooze · category · recategorise · follow-up ·
│                      deadline · theme                  (menu.js)
├── ambient            toast · offline banner · worker warning · new-pill
└── options.html       the REAL settings surface (separate extension page)
```

Code state at the start of this round: **leaf logic already extracted**
(~58 modules: store, query, rule-engine, timetable, outbox, backup,
activity, compose core, palette, layers, menu, dialog…). The monolith left
in `app.js` (6,020 lines) was exactly **the shell + the Mail workspace**:
worker bridge, sync engine, list render, sidebar render, reader, selection/
bulk, search suggestions, boot.

The tenant pattern already exists and is uniform: modules talk to the shell
through an explicit `ctx` object, never by reaching in. Every extraction in
this round follows it.

---

## 2. The proposed topology

```
                    App Shell (app.js, shrinking)
                    navigation · mailbox switching · global overlays ·
                    boot · worker bridge · sync engine
                       │
        ┌──────────────┼─────────────────┐
        ↓              ↓                 ↓
   MAIL WORKSPACE   TIMETABLE        SHARED CORE
   ├─ list          (layer today,    store · settings schema · layers ·
   ├─ reader ✔ R51   workspace       menu · dialog · toast · dom ·
   ├─ compose        candidate)      icons · themes · display · mailboxes
   ├─ search results                 reader-frame contract · platform/*
   ├─ selection/bulk
   └─ rails (snoozed, outbox, radar, notices)
```

### Workspace decisions, one by one (essay criteria applied)

| Surface    | Verdict                    | Why |
|------------|----------------------------|-----|
| Mail       | **Workspace (default)**    | The product's reason to exist. Its components (list, reader, compose, selection) are modules inside one workspace, not four workspaces. |
| Reader     | **Component, extracted ✔** | Was ~900 lines of the monolith with its own state (`bodyToken`, `lastBody`, `openPart`, `markReadTimer`, `imageAllowList`, `readPosition`). Now `src/app/reader.js`; an agent editing the reader holds one file + a contract. |
| Timetable  | **Workspace candidate**    | Own store, own scan pipeline, own week-grid UI, own badge, internal sections (schedule / chooser / exams) already exceeding one panel. Today it opens as a layer. Promotion is a DESIGN decision first (it changes the sidebar's stated product claim — see §5), then a code move. Not this round. |
| Search     | **Stays in the topbar**    | Search here is the Gmail model: query in the bar, results in the list. query.js / server-search.js / suggest.js / saved-views.js are already modules. A separate Search workspace would break mail-first scanning and create a second home for the list. |
| Rules      | **Watch — stays a menu**   | One store (rules.js) + menus on categories. Becomes a workspace only when it grows screens worth navigating (rule list, test bench, import). Splitting now would be modularization by speculation. |
| Snooze     | **Stays rail + menu**      | Deliberately fast/low-precision ("not now, later" — snooze-menu.js header). A calendar workspace would turn a one-keystroke action into a form. |
| Activity   | **Stays a layer (for now)**| activity-ui.js is a minimal honest surface (last N entries). Graduates when it gains filters/pagination. |
| Settings   | **Options page IS the workspace** | settings.js schema + options.html sections already form the Settings workspace. Do NOT add in-app settings panels — that creates two homes for one feature, the exact overlap being complained about. In-app theme/density menus are shortcuts into it, nothing more. |
| Backup     | **Stays on the options page** | Same reasoning: one home. |

### Shell keeps (per the round-46 doctrine, reconfirmed)

- **Sync engine** (`opEpoch` is the app's spine — extraction deferred until a
  workspace genuinely needs it).
- **Boot** (composition root; wires every tenant, stays the one place that
  knows everyone).
- **List render for now** — shares `renderedIds`/`nodeById` with bulk and
  keyboard. The round-46 map sequences it AFTER the reader settles; the
  reader has now settled, so it is the next candidate (§6).

### Shared core (what workspaces may use; never each other's internals)

`store.js` · `settings.js` · `layers.js` · `menu.js` · `dialog.js` ·
`toast.js` · `dom.js` · `icons.js` · `themes.js` · `display.js` (new) ·
`mailboxes.js` · `reader-frame.js` · `platform/storage.js`.

`display.js` was created this round for exactly this slot: pure display
mappings both the list and the reader need (`CAT_COLOR`, `LOW_CONFIDENCE`,
`displayName`, `shortDate`, `fullDate`). Import-free by rule, so it can
never grow an edge back into either consumer. `gmailUrl` stays shell-owned:
it depends on the account index.

### State that crosses boundaries (explicit, via ctx)

| State | Owner | Consumers |
|---|---|---|
| `state.selected` / `state.mailbox` / `state.theme` | shell | reader, compose, bulk, menus |
| active store (getter!) | shell | reader, rails, features — always as `get store()`, never captured by value |
| rules | shell | category menu, recategorise, ingest |
| deadlines / follow-ups | stores | radar, reader banner, menus |
| activity log | activity.js | writer = every verb; reader = activity layer |
| timetable store | timetable-store.js | timetable UI, reader banner (effects), classifier hints |

---

## 3. What this round changed (increment 1 of the sequence)

**Extracted `src/app/reader.js`** — the round-46 map's documented move #1,
deferred only until toast.js proved the pattern (it did, round 46).

- Moved verbatim: `openMessage`, `closeReader`, `loadBody`, thread strip,
  attachments + download, body rendering (sanitiser/CSP/srcdoc), image
  allow-list, deadline + timetable banners, mark-read timing, reading
  position, mailbox-aware action bar sync, and all reader event wiring
  (animationend, thread strip, attachment chips, action bar) — wiring moves
  WITH logic, per the round-46 warning.
- Public surface: `wireReader`, `openMessage`, `closeReader`,
  `renderThreadStrip` (live-thread-strip delta path), `syncReaderActions`,
  `repaintBody` (theme re-render), `cancelMarkRead`, `loadImageAllowList`,
  `openPartId` (compose reply target).
- ctx seam: `{ store (getter), state, el, send, patchRow, reorientTo,
  rowDomId, syncContextActions, openRecategoriseMenu, act, followupMenu,
  deadlineMenu, gmailUrl }`.
- **One real bug avoided in flight**: capturing `c.store` by value at wire
  time resolves the getter once and survives a mailbox switch — the exact
  ctx bug documented in app.js. reader.js wraps it: `storeOf = () => c.store`.
- app.js: 6,020 → 5,162 lines; `display.js` new (6 bindings, zero imports).

**Source pins followed the extraction** (doctrine: pins track live code):
package, reader-security, round45-phase3, memory, round46-phaseA,
round47-integrity, layout-contract — 9 pins repointed, zero weakened.

---

## 4. Pre-existing defects found and fixed while testing

The extraction's test pass surfaced six failures that were **already red at
HEAD** (verified by stashing and re-running). All fixed:

1. `memory.test.mjs` R2 pin — tracked a renamed variable
   (`snapshots` → `appliedSnapshots`); pin updated to the live name.
2. `compression.test.mjs` O7 pin — compose minimise was refactored
   (`!panel.classList.contains('minimised')` → `!minimised`); pin updated.
3. `compression.test.mjs` doctrine pin — first-occurrence reduced-motion
   check broke when other features earned their own earlier blocks; now
   checks an override AFTER the compression section, which is the invariant.
4. `draft-store.test.mjs` ×2 — pins predated the confirm-dialog upgrade
   (round 48): 600-char window too small, `confirm(` now `confirmDialog(`.
5. `resilience.test.mjs` — `settings.set` was in the never-rejects sweep
   while bug-hunt 43 #17 deliberately made it the ONE rejecting persistence
   call (options.js `persist()` and app.js `.catch` handle it). The sweep
   now declares the exception and pins the STRONGER contract: reject with a
   typed error + roll the cache back. A failed write can never masquerade
   as a saved one.
6. `architecture.test.mjs` — background's outbox pump (due-send alarm)
   statically imports `app/outbox.js`, but only `snooze.js` was declared.
   outbox.js is storage-only (imports just `platform/storage.js`, no DOM),
   so the edge is legitimate: now declared, named, and symbol-limited
   (`loadOutbox, saveOutbox, dueItems, markFailed, prioritizeDue`).

---

## 5. The product tension the map must respect

`app.html`'s sidebar carries an explicit positioning claim: *"this is a mail
client that understands student life, not a student platform with a mailbox
attached"* — which is why the deadline radar sits BELOW mail navigation and
the Timetable button is sized as a secondary tool. A full workspace-rail
redesign (Timetable as a peer of Mail) changes that claim. That is a
maintainer decision, not an agent decision — the map records it as the open
question behind the Timetable promotion, and nothing in this round moves it.

---

## 6. Migration sequence (one per round, each behind the affected tests)

| # | Move | Status |
|---|------|--------|
| 1 | `reader.js` + `display.js` | ✔ this round (408/408 affected tests) |
| 2 | list render + its shared state (`renderedIds`/`nodeById`) — unblocked now that the reader has settled | next |
| 3 | search-suggest cluster (`suggestContext` → `rememberQuery`, ~300 self-contained lines) | queued |
| 4 | rails: snoozed + outbox + lane headers (rail-tenant pattern like notices-rail.js) | queued |
| 5 | sidebar render (`buildSidebar`/`renderSidebar`/freshness/counts) | queued |
| 6 | selection/bulk (after list settles — they share its state) | queued |
| — | Timetable layer → workspace promotion: DESIGN DECISION FIRST (§5) | parked |
| — | Settings stays on the options page; no in-app settings panels | doctrine |

## 7. What this map forbids (the essay's danger list, adopted)

- No complete UI redesign + complete modularization in one operation.
- No splitting by line count; only change boundaries.
- No workspace importing another workspace's internals — shared core only.
- No new surface for a concept that already has a home (the overlap disease).
- No extraction without its pins following it in the same commit.
