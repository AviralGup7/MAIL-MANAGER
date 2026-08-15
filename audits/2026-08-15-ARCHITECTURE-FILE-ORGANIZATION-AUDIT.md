# Architecture, File Organization and Naming Audit

**Date:** 2026-08-15  
**Baseline reviewed:** `7a60466`  
**Scope:** all tracked root files; `src/**`; `test/**`; `tools/**`; active documentation and audit indexes; static import graph; entrypoints; CSS volume ownership; generated sources.  
**Method:** complete file inventory, LOC/fan-in/fan-out census, cross-top-level dependency graph, filename-pattern scan, duplicate-basename scan, local-link validation, stale-path search, entrypoint verification and test-name review.

---

## A. Executive summary

The repository already had a strong coarse architecture: MV3 entrypoints are explicit, the classifier is isolated, shared constants are leaves, storage is behind a platform seam, UI concerns are grouped by responsibility, CSS cascade order is encoded in numbered filenames, and the static module graph is acyclic. The review found **114 production JavaScript modules and 304 static edges with no cycle**.

The material problems were concentrated at boundaries and names:

1. The background worker imported two files from `src/app/**`, making the presentation layer a de facto owner of cross-context outbox and snooze models.
2. A one-off accessibility census lived as hidden `.census.mjs` in the repository root instead of the tools surface.
3. Several active comments and documents referenced deleted `notes/**`, retired audits, `app.js`, `app.css`, and `src/app/settings.js` paths.
4. Test names such as `app.integration2`, `round45-phase3`, `features`, `parity`, `pipeline`, and `polish` encoded chronology or vagueness rather than behavior.
5. `direct.js` did not communicate that it owns audience/direct-vs-broadcast classification.
6. `68-depth.css` (1,078 lines) and `86-v3-skin.css` (764 lines) each contained several unrelated component families despite the volume system’s single-owner intent.
7. `main.js` remains a 3,900-line, 65-import composition root; `timetable-ui.js`, list, reader and timetable domain are the next major extraction candidates.
8. Active docs claimed obsolete file counts, scope counts and paths.

### Overall architecture rating

| Dimension | Before | After remediation |
|---|---:|---:|
| Top-level dependency direction | 7.5 | 9 |
| File placement | 7 | 9 |
| Filename clarity | 7 | 9 |
| CSS ownership | 7 | 8.5 |
| Test discoverability | 6.5 | 9 |
| Documentation path integrity | 6 | 9 |
| Composition-root size | 5 | 6 |
| Overall | **6.8/10** | **8.6/10** |

---

## B. Architecture map

```text
Chrome/Gmail entrypoints
├── manifest.json
├── src/background/index.js       MV3 worker composition root
├── src/takeover/content.js       Gmail content-script entrypoint
├── app.html → src/app/main.js    application-page composition root
└── options.html → src/options/options.js

Context-neutral production layers
├── src/classify/                 pure classification domain + generated data
├── src/shared/                   leaf constants
├── src/platform/                 browser persistence adapters
└── src/features/
    ├── outbox/model.js           cross-context queue/state/persistence model
    └── snooze/model.js           cross-context schedule/state model

Application page
└── src/app/
    ├── core/                     DOM-safe primitives, display, contacts, sanitizer
    ├── system/                   settings, themes, caches, fallback, backup
    ├── mail/                     inbox/store/list/reader/bulk/undo
    ├── compose/                  composer, drafts, templates, autocomplete
    ├── search/                   query, suggestions, server overlay, views
    ├── academic/                 timetable/deadlines/rules/activity
    ├── overlays/                 menus/dialogs/layers/palette/settings
    ├── workspace/                sidebar/rails/telemetry
    ├── motion/                   finite animation primitives
    └── main.js                   wiring and page-level coordination
```

Dependency direction after remediation:

```text
background ─┬─> features ─> platform/shared
            ├─> classify/shared/platform
            └─X app (forbidden)

app ─> features/classify/platform/shared
app ─X background (fallback uses deliberate dynamic infrastructure imports)
shared ─> nothing
classify ─> classify only
```

---

## C. Findings and dispositions

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| ARCH-H01 | HIGH | Worker statically imports `app/system/snooze.js` and `app/compose/outbox.js`. | **FIXED:** moved to `src/features/*/model.js`; worker no longer imports app. |
| ARCH-H02 | HIGH | Active docs reference deleted classifier correction and sync notes. | **FIXED:** created `docs/CLASSIFIER-CORRECTION.md`; sync points to `docs/THREADING.md`. |
| ARCH-H03 | HIGH | Active architecture doc links a deleted audit; competitive audit links deleted predecessor. | **FIXED:** honest Git-history/retired wording, no broken links. |
| ARCH-M01 | MEDIUM | Hidden root `.census.mjs` is an unowned tool. | **FIXED:** moved to `tools/ui-census.mjs`; added `npm run ui:census`. |
| ARCH-M02 | MEDIUM | `direct.js` hides audience-classification responsibility. | **FIXED:** renamed `audience.js`; imports/tests updated. |
| ARCH-M03 | MEDIUM | Integration test names use `integration2` rather than bounded responsibility. | **FIXED:** `app.mail.integration` and `app.features.integration`. |
| ARCH-M04 | MEDIUM | Round-number tests encode chronology rather than contract. | **FIXED:** workflow contracts, UI regression guards, extraction integrity. |
| ARCH-M05 | MEDIUM | Generic test names `features`, `parity`, `pipeline`, `polish`. | **FIXED:** feature contracts, worker-fallback parity, ingestion pipeline, UI polish contracts. |
| ARCH-M06 | MEDIUM | `68-depth.css` owns search, selection, attachments, views, autocomplete, toast and rails. | **FIXED:** split into depth, selection/attachments, overlays/rails preserving byte order. |
| ARCH-M07 | MEDIUM | `86-v3-skin.css` owns shell, rows, motion and responsive ladder. | **FIXED:** split into skin, rows, motion/responsive while token authority stays in skin. |
| ARCH-M08 | MEDIUM | README tree says snooze/outbox live in app and has stale stylesheet/scope counts. | **FIXED:** feature layer and current counts documented. |
| ARCH-M09 | MEDIUM | `main.js` is 3,900+ lines and 65 imports. | **PARTIALLY FIXED:** theme policy and reader facts extracted; composition root retained rather than rewritten. |
| ARCH-M10 | MEDIUM | `timetable-ui.js` is 1,434 lines with multiple UI subdomains. | **DEFERRED WITH BOUNDARY:** no safe behavior-neutral split established in this campaign; next candidates listed below. |
| ARCH-L01 | LOW | Generic entrypoint names `background/index.js`, `classify/index.js`. | **ACCEPTED:** conventional package/context entrypoint names; manifest/import location disambiguates. |
| ARCH-L02 | LOW | `display.js`, `dom.js`, `rails.js` are broad names. | **ACCEPTED:** directory context and narrow exported contracts make these readable. |
| ARCH-L03 | LOW | Historical audits retain old paths. | **ACCEPTED:** point-in-time evidence; active docs corrected. |
| ARCH-L04 | LOW | Generated classifier files have generic data names. | **ACCEPTED:** generator/source-of-truth headers and drift gates are stronger than renaming. |
| ARCH-L05 | LOW | `preview.html` and `.ci-manifest.json` appear in workspace root. | **ACCEPTED AS GENERATED:** both ignored; not tracked artifacts. |

---

## D. File naming standard

### Production JavaScript

- Lowercase kebab-case.
- Name the owned concept, not implementation chronology.
- `index.js` only for a real entrypoint/public package boundary.
- `main.js` only for a composition root.
- Cross-context feature state lives under `src/features/<feature>/model.js`.
- UI-only rendering stays under `src/app/**`.
- Browser adapters stay under `src/platform/**`.

Examples:

| Old | New | Why |
|---|---|---|
| `app/system/direct.js` | `app/system/audience.js` | Names direct-vs-broadcast classification. |
| `app/compose/outbox.js` | `features/outbox/model.js` | Shared by page and worker; no longer presentation-owned. |
| `app/system/snooze.js` | `features/snooze/model.js` | Shared schedule model, not generic app system. |
| `.census.mjs` | `tools/ui-census.mjs` | Tool is discoverable and runnable by script. |

### Tests

Names describe the contract or bounded integration surface:

| Old | New |
|---|---|
| `app.integration.test.mjs` | `app.mail.integration.test.mjs` |
| `app.integration2.test.mjs` | `app.features.integration.test.mjs` |
| `round45-phase3.test.mjs` | `workflow-contracts.test.mjs` |
| `round46-phaseA.test.mjs` | `ui-regression-guards.test.mjs` |
| `round47-integrity.test.mjs` | `extraction-integrity.test.mjs` |
| `features.test.mjs` | `feature-contracts.test.mjs` |
| `parity.test.mjs` | `worker-fallback-parity.test.mjs` |
| `pipeline.test.mjs` | `ingestion-pipeline.test.mjs` |
| `polish.test.mjs` | `ui-polish-contracts.test.mjs` |
| `direct.test.mjs` | `audience.test.mjs` |

### CSS volumes

- Two-digit cascade prefix remains authoritative.
- Names describe component families.
- Token definitions remain only in `00-tokens.css` and `86-v3-skin.css`.
- A volume should generally stay below ~900 lines; split earlier when it has multiple named owners.

New split:

```text
68-depth.css                       shell depth, degraded state, toolbar, search
69-selection-and-attachments.css   scroll edge, selection, bulk, attachments
70-overlays-and-rails.css           views, autocomplete, toast, rails, help
86-v3-skin.css                     V3 tokens/shell/rail/overlay/notices
86-v3a-rows.css                    row anatomy and hover actions
86-v3b-motion-responsive.css       V3 finite motion and responsive ladder
```

---

## E. Import graph review

### Baseline measurements

- 114 production JS modules.
- 304 static import edges.
- No static cycle.
- Largest fan-out: `app/main.js` at 65.
- Largest fan-in: `platform/storage.js` at 21.
- `core/icons.js` 13, settings/reset registry 12 each.

### Positive findings

- Storage fan-in is intentional: one browser persistence seam.
- Reset registry fan-in reflects explicit test/page lifecycle ownership.
- Motion tokens/spring fan-in reflects shared primitives.
- Classifier remains pure.
- No app module statically imports background.
- Background now imports cross-context feature models rather than app presentation.

### Remaining hotspot guidance

#### `main.js`

Keep as composition root, but future additions must extract one proven tenant first. Candidate order:

1. sync-page/delta UI coordinator;
2. account-session teardown coordinator;
3. worker transport/fallback coordinator;
4. theme menu UI (theme policy already extracted).

Do not rewrite wholesale; current integration coverage and runtime state make incremental extraction safer.

#### `timetable-ui.js`

Candidate behavior-neutral splits:

1. `timetable-workspace.js` — open/close/state;
2. `timetable-findings.js` — scan/accept/dismiss;
3. `timetable-tabs.js` — tab semantics/focus;
4. `timetable-grid.js` — rendering and selected-course inspector;
5. `timetable-editor.js` — lock/swap/teacher controls.

This audit does not claim those splits landed: they require a dedicated fixture-first campaign because module-level state and 25 listeners currently form one lifecycle.

---

## F. Documentation integrity

### Fixed

- Added stable classifier correction document.
- Removed broken active links to retired audits.
- Replaced stale `app.js` references in active UX/state docs.
- Updated structure trees for `features/`, `audience.js`, moved outbox/snooze, current style count and integration filenames.
- Replaced missing sync-notes reference with threading contract.

### Retained intentionally

Historical audits still mention paths that existed at their audited commits. Rewriting those would falsify evidence. Active indexes explain retired history.

---

## G. Generated and root artifacts

| File | Decision |
|---|---|
| `preview.html` | Ignored generated preview; keep out of Git. |
| `.ci-manifest.json` | Ignored CI evidence generated locally/remotely; keep out of Git. |
| `.census.mjs` | Moved into tools and named. |
| `.gitignore` | Required root configuration. |
| `DO-THIS-NOW.md` | Owner action register; root visibility is intentional. |
| `app.html`, `options.html`, `manifest.json` | Browser entrypoints; root placement is correct. |
| `package*.json`, `tsconfig.json` | Toolchain roots; conventional. |

---

## H. Validation requirements

The remediation must satisfy:

1. all relative imports resolve;
2. static graph remains acyclic;
3. background imports no `src/app/**` module;
4. feature models import no app/background context;
5. every test filename describes behavior, not round chronology;
6. active local Markdown links resolve;
7. generated classifier regeneration is a no-op;
8. CSS link order equals sorted volume order;
9. token definitions remain in two authorities;
10. docs test count remains exact;
11. remote shards stay disjoint/complete after renames;
12. browser smoke and coverage remain green.

---

## I. Final disposition

All concrete path, naming, layer and documentation defects found in this audit were fixed. Two large-module opportunities remain intentionally staged rather than claimed complete: further `main.js` tenant extraction and the stateful timetable UI split. They are not safe mechanical renames; their required boundaries and acceptance order are documented above.
