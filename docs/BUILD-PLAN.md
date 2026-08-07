# Build plan — the 36 survivors

Tracking sheet for [`audits/17-FEATURE-ELIMINATION.md`](../audits/17-FEATURE-ELIMINATION.md).

**Rule for this build: no oversized files.** `app.js` is already 4389 lines and
is the reason the render/list/selection core is unrefactorable. Every survivor
below ships as its **own module under 350 lines**, pure where it can be, with
its own test file. Nothing new gets welded into `app.js` except the call site.

**Rule two: a feature is not "done" until its test has been sabotaged** and
observed to fail. This project has found 15+ worthless tests that way.

## Status

| # | Feature | Module | State |
|---|---|---|---|
| 29 | Sender-aware snippet | `src/app/snippet.js` | ✅ built + tested |
| 32 | Only-addressed-to-me | `src/app/direct.js` | ✅ built + tested |
| 48 | Negation and OR | `src/app/query.js` | ✅ built + tested |
| 31 | Triage lanes | `src/app/lanes.js` | ✅ built + tested |
| 51 | Default smart views | `src/app/views.js` | ✅ built + tested |
| 43 | Search suggestions | `src/app/suggest.js` | ✅ built + tested |
| 16 | Templates | `src/app/templates.js` | ✅ built + tested |
| 6 | Follow-up flag | `src/app/followups.js` | ✅ built + tested |
| 86 | Activity log | `src/app/activity.js` | ✅ built + tested |
| 87 | Local export | `src/app/backup.js` | ✅ built + tested |
| 83 | Mute a thread | `src/app/rules.js` | ✅ built + tested |
| 61 | Manual deadline | `src/app/deadline-store.js` | ✅ built + tested |
| 58 | Personal sections | `src/app/my-courses.js` | ✅ built + tested |
| 55 | Course chip | `src/app/my-courses.js` | ✅ logic built + tested |
| 57 | Room-change detection | `src/app/notices.js` | ✅ built + tested |
| 73 | Rule engine | `src/app/rule-engine.js` | ✅ built + tested |
| 74 | Rule dry-run + log | `src/app/rule-engine.js` | ✅ built + tested |
| 36 | Bulk by rule | `src/app/rule-engine.js` (`idsMatching`) | ✅ logic built |
| 39 | Keyboard cursor | `app.js` | ⬜ wiring |
| 40 | Action-and-advance | `app.js` | ⬜ wiring |
| 28 | Density | `app.css` + settings | ⬜ wiring |
| 76 | Context menu | `menu.js` | ⬜ wiring |
| 77 | Context-aware palette | `palette.js` | ⬜ wiring |
| 1 | Label write | `label-picker.js` | ⬜ needs verb wiring |
| 14 | Outbox with retry | `src/app/outbox.js` | ✅ built + tested |
| 13 | Undo send | `src/app/outbox.js` (held state) | ✅ built + tested |
| 19 | Inline quick reply | `compose.js` | ⬜ |
| 23 | Paste/drag attach | `compose.js` | ⬜ |
| 54 | Search other stores | `app.js` | ⬜ |
| 38 | Multi-select gestures | `selection.js` | ⬜ |
| 75 | Create rule from message | `rule-engine.js` + UI | ⬜ UI |
| 68 | Category correction UI | `rules.js` (logic exists) | ⬜ UI |
| 60 | Deadline correction | `src/app/deadline-store.js` | ✅ built + tested |
| 92 | Sync transparency | `app.js` | ⬜ |
| 93/95 | Notifications / badge | `background/` | ⬜ |

## Why this order

Logic first, wiring second. Every module above is reachable from a test without
booting jsdom, which is the only way 900+ tests stay fast. The wiring rows are
the ones that touch `app.js`, and they are deliberately last so that a mistake
there cannot invalidate the logic underneath it.
