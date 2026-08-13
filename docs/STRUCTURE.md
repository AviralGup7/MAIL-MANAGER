# Repository structure — the physical map

**Status:** landed (S1 styles, S2 folders). `docs/ARCHITECTURE.md` remains
the doctrine (layers, ctx, state ownership); this document is the
*floor plan* that doctrine lives on, and `test/structure.test.mjs` is the
bouncer that keeps it true.

Why this file exists: the codebase passed 37,000 source lines and 90 test
files, and a flat `src/app/` had 73 modules in one directory. That is fine
at 7,000 lines of CSS and survivable at 37k of JS. It is unmaintainable at
the 15–25k-line stylesheet and 100k-line source tree this project becomes
if it keeps working. So the layout is now decided *by rule*, not by taste,
and the rules are enforced by tests — the same house pattern as everything
else that has ever stayed true here.

---

## 1 · The tree

```
manifest.json                 MV3 package manifest (Chrome's entry point)
app.html                      the app document (shell page, loads styles + main.js)
options.html                  settings page
src/
  styles/                     THE stylesheet, as numbered volumes (see §3)
  shared/                     leaf constants (labels, limits) — imports nothing
  platform/                   chrome.storage wrapper
  classify/                   the mail classifier (pure domain, generated files)
  background/                 the service worker (credentials, network, sync)
  takeover/                   the content script Gmail sees (zero imports)
  options/                    options page logic
  timetable/                  academic data (data.json + source documents)
  app/
    main.js                   THE SHELL — render loop, routing, ctx (was app.js)
    core/                     shared vocabulary: dom, icons, display, sanitize,
                              selectors, shortcuts, contacts, reset-registry
    motion/                   every animation primitive (springs, camera, light,
                              particles, morphs); imports nothing app-side
    system/                   settings, themes, cache, body-cache (reader's
                              offline floor), identity (direct),
                              snooze/outbox persistence, backup, fallback,
                              deep-links, storage/view stores,
                              root-attrs (settings -> :root stamps)
    overlays/                 the overlay stack: layers, menu, dialog, toast,
                              help, settings-panel, snooze-menu, category-menu,
                              palette
    mail/                     the inbox: store, list, reader, reader-frame,
                              bulk, bulkbar, row-actions, selection, undo,
                              mailboxes, rules, snippet, undo-actions
    search/                   query language, suggestions, saved views,
                              server-search fallback, chips
    compose/                  compose, autocomplete, templates, drafts, outbox
    academic/                 timetable suite, deadlines, radar, notices,
                              activity log, lanes, rule-engine
    workspace/                sidebar chrome, rail visibility postures, the
                              live context rails
test/                         the contracts (node:test); helpers/ for test seams
tools/                        build/check/CI executables (never shipped)
audits/                       dated records — history; paths in them are frozen
docs/                         living documents — kept true, always
```

## 2 · The rules that are pinned, not remembered

1. **`src/app/` root holds exactly one file: `main.js`.** Every module joins
   a named folder. A new file with no folder is a test failure.
2. **Cross-folder imports are a closed set.** `test/structure.test.mjs`
   carries the allowlist of folder→folder edges, each with its reason. A new
   edge fails until it is justified in one line. This is not bureaucracy: it
   is the difference between a framework that grows by accretion and one that
   grows by design.
3. **The module graph stays acyclic at file level**, verified by traversal,
   which is a stronger guarantee than the old 18-file layer table gave.
4. **`motion/` imports nothing outside itself.** It is the one folder another
   engineer should be able to lift out wholesale.
5. **No barrels.** `features.js` (a re-export file) is dissolved; importers
   name the true owner. Barrels re-announce themselves as the place imports
   go to be wrong six months later.
6. Existing doctrines stand untouched: reduced-motion is the final cascade
   authority, tokens are a closed set, `app.js`'s successor `main.js` accretes
   one wiring line per feature and no feature code.

## 3 · The stylesheet, as volumes

`src/app/app.css` (6,667 lines) is split into `src/styles/NN-name.css`. The
**NN prefix is the load order** — sorted directory order, nothing else. No
manifest of files exists anywhere, because the filenames are the manifest.

- `app.html` lists the files in sorted order; a test asserts the
  `<link>` sequence equals the sorted directory listing. Adding a volume is:
  write the file, add one link tag. The extension needs no build step and
  gains none.
- Byte-level continuity: the concatenation of the volumes equals the former
  monolith **exactly** (proven at split time and pinned), so the split cannot
  have changed a single computed style.
- Pins that used to read the monolith (`package.test.mjs`,
  `layout-contract.test.mjs`, the contrast gate, preview builds) now read the
  **bundle** through `test/helpers/css.mjs` / `tools/css-bundle.mjs`.

Volume rules, each pinned:

| Rule | Pin |
|---|---|
| Every file is `NN-name.css`, two digits, dash-cased | structure test |
| `00-tokens.css` is first; the V3 token remap lives in `86-v3-skin.css`; **no other file may define a `--token`** (`^  --x:`) | structure test |
| `99-reduced-motion.css` is last, and the reduced-motion guard is the final rule of the bundle | package + structure tests |
| `app.html` link order == sorted directory order | structure test |
| Concatenation equals the split-time bytes (drift tripwire during the migration) | structure test |

## 4 · Naming

- `lower-kebab.js` everywhere; a surface twin of a data module is `-ui`
  (`timetable.js` / `timetable-ui.js`), a persistence twin is `-store`
  (`view-store.js`, `deadline-store.js`).
- Perfect beats stable: `app.js → main.js`, `views.js → view-store.js`
  happened because the old names had stopped telling the truth. Rename
  boldly, then let the import-resolution and structure pins catch the
  fallout — that is what they are for.

## 5 · Growth playbook

- **New mail feature:** a module in `mail/` (or `search/`, `compose/` if
 they own the verb). One wiring line in `main.js`. One registry line only if
  a *new cross-folder edge* appears.
- **New academic feature (e.g. placements tracker):** new files inside
  `academic/` — or a new sibling folder if it owns ≥5 modules; register the
  folder in the structure test with its allowed edges.
- **New animation:** only in `motion/`, gated by `reducedMotion()`, no
  imports outward, springs from `tokens.js`. Constants that must paint look
  live in `90-motion-system.css`.
- **New styles:** append to the volume that owns the surface; only a *new
  surface class* earns a new `NN-` volume, inserted between neighbours —
  the numbering is the order, so insertion is obvious.
- **New tool:** `tools/`, invoked from `package.json` scripts, never shipped.
- **Runs the risk of a test run:** commit and push first. Always.
