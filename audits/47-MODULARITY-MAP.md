# Modularity mapping audit (round 46, AI-maintainer strategy)

Charter from the strategy: do NOT modularize on line count; modularize on
CHANGE BOUNDARIES; one feature = one obvious home; every significant module
carries a RESPONSIBILITY/OWNS/DOES-NOT-OWN/DEPENDS-ON header; extract one,
test, commit, next. No code changes in this document; the extractions that
follow it are executed separately, each behind the full regression.

## Census

| File | Lines | Verdict |
|---|---|---|
| src/app/app.js | 6062 | **MODULARIZE (selectively)** |
| src/app/timetable-ui.js | 1231 | KEEP — one cohesive subsystem with a clean header now |
| src/app/timetable.js | 1102 | KEEP — pure domain model |
| src/classify/pattern-rules.js | 1059 | KEEP — data, not logic |
| everything else | <1000 | KEEP |

app.js is the only file past the "investigate seriously" line, and it fails
the real metric badly: an agent changing ONE feature (say, the reader's
quote fold) must first hold list rendering, sidebar counts, sync, keyboard,
bulk, outbox UI and boot wiring, because they share one scope.

## Responsibility map of app.js

| Responsibility | Lines (approx) | Functions | Shared state touched |
|---|---|---|---|
| worker plumbing | 382–500 | send, degradeToFallback, scheduleWorkerProbe | workerDown |
| toast | 503–577 | toast, hideToast | el.toast, toastTimer |
| list render | 578–1545 | scheduleRender, renderList, buildRow, fillRow, empty/skeleton, travelGhost | el.list, renderedIds, nodeById |
| sidebar | 1547–1930 | buildSidebar, renderSidebar, freshness, counts, r-due/r-timetable head | el.cats, el.topbar |
| reader | 1934–2590 | loadBody, openThreadPart, renderThreadStrip, openMessage, renderAttachments, downloadAttachment, renderBodyInto/Body, escapeDoc, closeReader, syncContext/ReaderActions | el.r*, state.selected, readPosition |
| triage actions | 2594–3170 | flagAction, optimistic, act, snooze, ingest, applyRules, autoArchive | store, rules, undo |
| sync | 3187–3490 | fetchPage, loadPage, refresh, banners, gate | state.loading, opEpoch |
| search suggest | 3936–4190 | suggest render/move/accept, rememberQuery | el.search, queryHistory |
| menus & theme | 4192–4836 | theme menu, snoozed, followup/deadline menus, recategorise | el menus |
| outbox UI | 4461–4610 | pumpOutbox, renderOutbox | outbox storage, el.outbox |
| selection/bulk | 5032–5420 | move, renderSelection, bulkAct, reconcileBulk | selection, store |
| keyboard & boot | 4837–5030, 5422–end | release, keydown, auto-refresh, start, boot | everything |

## Dangerous coupling (the reason extractions are risky)

- ONE `state` object and ONE `el` map are read/written by every block. Any
  extraction must inject both (getters), never import them.
- `store` is a REBINDABLE `let` (mailbox switch) — modules must take a
  getter, exactly the lesson the ctx.store getter fixed.
- Event wiring for reader surfaces lives far from reader logic (4700s) —
  extraction must move the wiring with the logic or the split strands.

## Extraction plan (executed, in order, each behind full regression)

1. **src/app/reader.js** — the reader cluster above, including its event
   wiring and the r-due/r-timetable head renderers, injected with
   `{ state, store(), el, send, toast }`. Biggest context win: an agent
   editing the reader goes from 6062 lines to ~700 + a contract.
2. **src/app/toast.js** — toast/hideToast; every caller already calls a
   single function, so this is the lowest-risk extraction and proves the
   pattern before the big one.

Not extracted now (documented reasons): list render (shares renderedIds /
nodeById with bulk and keyboard; extraction would move the hardest shared
state first — do it after reader settles); sync (opEpoch is the app's
spine); boot (must stay the composition root).

## Header convention (applied to every significant module)

Every extracted or significant module carries:

    RESPONSIBILITY  one sentence an agent can act on
    OWNS            the state/DOM it mutates
    DOES NOT OWN    what it must never touch
    DEPENDS ON      injected contracts + module imports

Applied to reader.js, toast.js, and retrofitted onto compose.js,
timetable-ui.js, layers.js, dialog.js, store.js, selectors.js, outbox.js,
server-search.js so the convention is uniform, not special.
