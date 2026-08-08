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
| 29 | Sender-aware snippet | `src/app/snippet.js` + wired into `fillRow` | ✅ built + tested |
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
| 39 | Keyboard cursor | `app.js` | ✅ **already existed** — audit was wrong |
| 40 | Action-and-advance | `app.js` | ✅ **already existed** — `selectNeighbourThen` |
| 28 | Density | `app.css` + `options.html` | ✅ built + tested |
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


## Correction to audit 17

Two features on the Keep list **already existed** and were found during wiring:

- **#39 keyboard cursor** — `j`/`k` are bound, `move()` handles the cursor and
  `scrollIntoView`, and there is a test named *"j/k move the selection and
  Escape closes the reader"*.
- **#40 action-and-advance** — `selectNeighbourThen()` already opens the next
  message after archive/trash/spam, with a test asserting the reader shows the
  neighbour rather than going blank.

Both were listed as missing in the elimination pass. That was a reading error
on my part: I inferred the gap from the *absence of a feature name* rather than
checking the behaviour. Recorded rather than quietly dropped, per the project's
rule about disproved suspicions.

What was genuinely missing near them was **#29** — the row printed
`m.snippet` raw, so every institutional row read "Dear Students, Greetings
from AUGSD".

## The memory ceiling

`npm test` used `--max-old-space-size=3072` on a machine with **1984 MB** of
RAM. That was always over-committed; adding the 191st jsdom document finally
reached the ceiling and the OS OOM-killer sent SIGKILL — reported as a test
failure with no assertion attached, which is exactly the symptom the project
notes already describe.

Lowered to **1400 MB**, which fits in real memory. The suite went from
240s (thrashing) to 153s.


## Correction: "built + tested" is not "wired in"

Checked during audit 20, not assumed:

```
snippet.js       imported by app.js          ✅ reachable
direct.js        imported by app.js, query   ✅ reachable
lanes.js         imported by NOTHING         ⬜
suggest.js       imported by NOTHING         ⬜
templates.js     imported by NOTHING         ⬜
followups.js     imported by NOTHING         ⬜
my-courses.js    imported by NOTHING         ⬜
notices.js       imported by NOTHING         ⬜
deadline-store.js imported by NOTHING        ⬜
rule-engine.js   imported by NOTHING         ⬜
outbox.js        imported by NOTHING         ⬜
activity.js      imported by NOTHING         ⬜
backup.js        imported by NOTHING         ⬜
```

**Eleven of thirteen modules are unreachable from the running extension.** They
are complete and covered by 1245 passing tests, and a user running the build
today has none of them: no outbox, no rule engine, no templates, no activity
log.

The table above this section marks them `✅ built + tested`, which is true and
misleading. The honest status is **logic complete, not integrated**. A test
that imports a module directly proves the module works; it cannot prove the
application uses it.

This is the same class of finding as audit 16's "three background verbs
implemented and unreachable", one layer up, and it recurs for the same reason:
logic and wiring land in different sessions and the suite is green either way.

**Next session should wire, not build.** Ordering by dependency:

1. `activity.js` — nothing calls `record()`, so the log is empty as well as
   unread. Wire the writers first; ten discovery ideas depend on it.
2. `outbox.js` + `templates.js` — the compose path touches both.
3. `deadline-store.js` + `followups.js` — both feed the radar.
4. `my-courses.js` + `notices.js` — both need an enrolment picker first.
5. `lanes.js` + `suggest.js` — both are list/search surfaces.
6. `rule-engine.js` — needs an editor, and must ship with its dry run.
7. `backup.js` — needs two buttons in options.


## RESOLVED — all thirteen modules are wired

Verified by grepping the import graph, not asserted:

```
snippet         app.js
direct          app.js, lanes.js
lanes           app.js            (behind the `lanes` setting)
suggest         app.js
templates       compose.js
followups       app.js
my-courses      app.js
notices         app.js
deadline-store  app.js
rule-engine     app.js, options.js
outbox          app.js, compose.js
activity        app.js
backup          options.js
```

### What a user can now actually do

| Surface | Where |
|---|---|
| Undo send | toast after Send, window configurable 0–30s |
| Outbox with retry | rail section, appears only when non-empty |
| Templates | compose toolbar, caret lands on the first `{{gap}}` |
| Activity log | written from all three mutation paths |
| Search suggestions | dropdown under the search field |
| Snoozed | rail section with a Wake button |
| Follow-ups | reader toolbar, surfaces in the radar |
| Deadline correction | reader toolbar, overrides beat the parser |
| Course chips | message rows, scoped to enrolment |
| Class-change cards | pinned above the list, read-only |
| Triage lanes | opt-in setting |
| Rules | options page, **dry run runs before every save** |
| Backup | options page, with a change preview |

### The integration suite is now two files

`app.integration.test.mjs` + `app.integration2.test.mjs`. Not organisation —
memory. Node runs each test *file* in its own process, so splitting halves the
peak live set. Measured before splitting: a 900MB heap died at 111 tests,
1100MB at 143, 1400MB at ~190. That is growth, not GC pressure, so a larger
flag was not the answer.
