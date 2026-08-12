# INTERACTION & TASK-FLOW ARCHITECTURE AUDIT (Round 60)

**Charter:** reverse-engineer how users actually move through the system,
what context they must carry, where workflows break down, and whether the
interaction architecture matches the information architecture. Audit only —
**no fixes implemented**. Companion to `audits/58-IA-LAYOUT-HIERARCHY-AUDIT.md`
(traced independently; where they agree it is noted, not assumed).

**Method:** handler-level tracing through app.js + the surface modules
(list/reader/sidebar/rails/bulk/suggest-ui/timetable-ui/compose/palette),
keyboard-map extraction, mode-marker grep, context-preservation mechanism
inventory, undo/hold-window analysis. Claims carry file + function;
unverifiable items are marked **UNVERIFIED**.

---

## 1. EXECUTIVE DIAGNOSIS

**The interaction architecture is sound on its load-bearing parts and has
three structural weaknesses, none of them critical.**

1. **The system's core loops are genuinely well-built.** Triage
   (open → read → act → undo), search, and bulk all follow one discipline:
   optimistic local mutation → one async verb → rollback on failure →
   thunk-based undo with a visible drain window. Context preservation is
   explicit machinery, not accident: per-category scroll memory, per-message
   reading position, pre-search scroll anchor, draft crash-recovery,
   layer-stack Esc ordering. (Evidence: §5.)

2. **Weakness A — mode awareness is implicit.** Modes (searching, selecting,
   composing, reading, scrolled) exist as scattered body-classes and state
   flags with no single owner. They compose mostly safely (§7, §18), but
   "what mode am I in" is answered by the UI only indirectly, and a few
   combinations survive only because of guard-clause ordering, not design.

3. **Weakness B — asynchronous truth lags the UI in two places.** The
   outbox rail shows queue state only when the pump renders it (no
   independent subscription), and the mark-read grace timer is invisible —
   both are by design, but the user has no surface that says "this is still
   in flight" except the toast drain and aria-busy sweep (§14).

4. **Weakness C — two task families carry more cognitive cost than their
   click-count suggests:** recategorise-then-reclassify (three mental steps
   across two surfaces) and deadline correction (menu → dialog → banner,
   with the correction living in a different store from the extraction).
   Neither is broken; both are candidates for workflow-level improvement
   (§21), not control polish.

**Verdict on the round-58 question:** the interaction architecture MATCHES
the information architecture for the two workspaces and the mail loop; the
gaps are inside task families, not between surfaces. No workflow needs a new
page. Two workflows need inline restructuring (§21).

---

## 2. COMPLETE TASK INVENTORY

Reverse-engineered from handlers, not buttons. Capability class → entry
points → implementing function.

### Browse / navigate
| Task | Entry | Handler |
|---|---|---|
| Switch mailbox | sidebar `.cat.mailbox` click · palette `Go to label` | `selectMailbox` (app.js:1745) |
| Switch category | sidebar `.cat` click · `g`+digit · palette | `selectCategory` (app.js:1713) |
| j/k navigation | keys j/k · bulkbar arrows | `move` (bulk.js) |
| Load more | topbar `Load more` | `loadPage` (app.js) |
| Refresh | `r` · topbar Refresh · freshness button | `refresh` (app.js:1397) |
| Return to Gmail | Esc ladder end · sidebar · palette | `release` (app.js:2428) |
| Open workspace | sidebar Timetable | `openTimetable` (timetable-ui.js) |

### Search / filter
| Task | Entry | Handler |
|---|---|---|
| Query | topbar input (`/` focuses) | input handler → `renderList` + `scheduleServerSearch` (app.js:1886+) |
| Accept suggestion | combobox arrows+Enter · click | `acceptSuggestion` (suggest-ui.js) |
| Save view | `Save view` (appears with query) | `promptDialog` → `saveView` (app.js boot) |
| Apply saved view | rail click · suggest · palette | `ctx.runQuery` |
| Mute/auto-archive category | category contextmenu | category-menu.js → rules.js |
| Recategorise sender | reader tag `Wrong category?` | `openRecategoriseMenu` (app.js:2299) |

### Read
| Task | Entry | Handler |
|---|---|---|
| Open message | row click · Enter | `openMessage` (reader.js) |
| Thread navigation | thread strip click | `openThreadPart` (reader.js) |
| Attachments | chip click | `downloadAttachment` (reader.js) |
| Remote images | `Show images` / `Always from this sender` | `renderBodyInto` paths (reader.js) |
| Unfold quotes | `Unfold quotes` (appears with folds) | r-unfold onclick (reader.js) |
| Open in Gmail | `Open in Gmail` · row dblclick | `gmailUrl`/`openInGmail` |
| Deadline banner evidence | r-due banner | `renderMessageDeadline` (reader.js) |
| Timetable-effect banner | r-timetable banner | `renderTimetableEffects` (reader.js) |

### Triage (single)
| Task | Entry | Handler |
|---|---|---|
| Archive/trash/spam/restore/unsnooze | reader action bar · `e`/`#`/`!` · ctx-icons · swipe | `act` (app.js:894) → `optimistic` |
| Star/unstar | action bar · `s` · row star · ctx-icon | `act('star')` → `flagAction` |
| Mark (un)read | action bar · `u` | `flagAction` |
| Snooze | action bar · `z` | snooze-menu.js → `snoozeMessage` (app.js:1053) |
| Follow up | action bar Follow up | `openFollowupMenu` (app.js:2058) |
| Correct deadline | action bar Deadline | `openDeadlineMenu` (app.js:2103) |
| Swipe archive/unarchive | touch swipe on row | list.js touch handlers → `optimistic` |

### Bulk
| Task | Entry | Handler |
|---|---|---|
| Tick row | row `.r-pick` · `x` | selection.toggle → `renderSelection` (bulk.js) |
| Range/multi | Shift-click · Ctrl-click | selection.range/toggle |
| Select all | Ctrl+A · bulkbar | selection.selectAll(renderedIdsOf()) |
| Bulk archive/trash/spam/read/star | bulkbar buttons | `bulkAct` (bulk.js) |
| Cancel a running bulk | progress-toast Cancel | chunked-loop `cancelled` flag |

### Compose / send
| Task | Entry | Handler |
|---|---|---|
| New message | `c` · sidebar Compose · palette | `openCompose` (compose.js) |
| Reply/reply-all/forward | Shift+R/A/F · reader · palette | `startReply` (compose.js) |
| Edit draft | Drafts mailbox `Edit draft` | `editDraft` (compose.js) |
| Attach | file input | compose.js attachment path |
| Send | Ctrl+Enter · Send | `doSend` → outbox hold |
| Cancel send (undo window) | outbox rail Undo | outbox.cancel |
| Retry/discard stuck | outbox rail buttons | outbox.retryNow/cancel → rails.pumpOutbox |
| Minimise/restore | compose min | compose.js minimise |

### Academic
| Task | Entry | Handler |
|---|---|---|
| Build timetable | workspace build view | timetable-ui wizard |
| Add course | Schedule room search (leads the room) | courseSearch |
| Review changes | Changes tab | pendingSection findings |
| Accept/dismiss finding | finding buttons | acceptFinding/dismissFinding |
| Resolve conflicts | Conflicts tab | conflictSection |
| Exams | Exams tab | examSection |
| Mark complete / reset | workspace header | finalize/resetTimetable |
| Radar items | sidebar radar click | radar.js → openMessage |

### System
| Task | Entry | Handler |
|---|---|---|
| Theme/density | Appearance menu · options | setTheme / settings.set |
| Settings | options page | options.js |
| Backup/restore | options Backup | backup.js |
| Activity log | sidebar Activity · palette | openActivityLog (activity-ui.js) |
| Help | topbar Help · `?` | toggleHelp |
| Sign in/out | gate · sidebar | doSignIn / sign-out path |
| Command anything | Ctrl+K | palette.js |

**Not-a-button capabilities discovered by tracing:** `g`+digit category jump
(two-key idiom with 1.2s expiry), thread-aware single-archive silently
becoming bulk (`act` spans the thread when threaded && no query),
`untilDeadline` snooze preset (reads the parsed deadline — Gmail cannot),
palette fallback "search for this text" when nothing matches, WAKE_DUE alarm
unsnoozing with the app closed (worker-side).

---

## 3. GLOBAL TASK MAP (the actual system)

```
APPLICATION
├── MAIL WORKSPACE (default surface)
│   ├── SCAN        j/k · list · lanes · counts · radar glances
│   ├── SEARCH      query · suggestions · server fallback · saved views
│   ├── READ        reader · thread strip · attachments · images · banners
│   ├── TRIAGE      archive/trash/spam/star/read/snooze/followup/deadline
│   ├── BULK        select · bulkbar · chunked verbs · cancel
│   ├── COMPOSE     new/reply/forward/draft · hold-window send · outbox
│   └── RECOVER     undo stack · outbox retry · offline/worker banners
├── TIMETABLE WORKSPACE
│   ├── BUILD       search → section chooser (asks when ambiguous)
│   ├── MANAGE      Schedule · Changes · Conflicts · Exams tabs
│   └── FINALIZE    mark complete · reset (confirm-guarded)
├── SETTINGS PAGE    preferences · rules · backup · client ID
├── AMBIENT          toast(+undo drain) · freshness · new-pill · gate
└── ACCELERATORS     palette (Ctrl+K) · help (?) · keyboard map
```

---

## 4. END-TO-END WORKFLOW TRACES

### W1 — Archive from the reader (the reference triage loop)
```
click Archive (reader action bar)
→ act('archive', id)                        app.js:894
→ thread-span check: threaded && !query && thread>1
   → YES: bulkAct('archive', threadIds)      (silent escalation!)
   → NO:  optimistic({verb:'ARCHIVE',...})   app.js:810
→ snapshot BEFORE mutation
→ selectNeighbourThen(id)                    reader lands on next row
→ store.remove(id) → batch notify → ONE rAF render (THE ONE RULE)
→ travel ghost: row rect → toast (list.js travelGhost)
→ send('ARCHIVE') async; on reject: rollback store + error toast
→ recordUndo(ctx, 'Archived', thunk)         undo-actions.js
→ toast kind:'undo' with DRAIN LINE = visible undo window
→ undo path: thunk restores store, re-sends inverse verb
FAILURE: rollback restores row; toast 'Could not archive'; undo still offered
```
Every transition has a function, a state effect, and feedback. The silent
thread-escalation is the one step with no distinct feedback (§18 F-4).

### W2 — Search, open, act, return
```
'/' focuses search → input (one rAF debounce)
→ state.query → renderList (local: store.search subject+sender)
→ scheduleServerSearch (timer-debounced Gmail query if under-served)
→ overlay results merged, labelled, deduped (server-search.js)
→ row click → openMessage → read → 'e' archives
→ Esc: reader closes → query STILL ACTIVE, scroll anchor restored
   (preQueryScroll on clear, pendingScrollRestore otherwise)
```
Context audit: query preserved through open/act; clearing restores scroll;
the server overlay clears on mailbox switch (bug-hunt #26 guard).

### W3 — Compose → send → undo-window
```
'c' → openCompose → contact book rebuilt ONCE (not per keystroke)
→ typing: autosave debounce → draft-store (crash-recovery copy)
→ Ctrl+Enter/Send → doSend
→ invalid-address check: WARN via confirmDialog, never block (Bcc included)
→ outbox.enqueue with holdMs (undoSendSeconds; 0 = immediate)
→ panel closes; rail shows HELD row with countdown
→ pump (rails.pumpOutbox → worker OUTBOX_PUMP, batched 8, ordered held-first)
→ success: rail row gone + 'Message sent' toast
→ failure: backoff 15s/1m/5m/15m → after 4: STUCK row (Retry/Discard)
   + one 'Could not send to X' toast per episode
→ cancel during hold: outbox.cancel — never dispatched
→ on-the-wire: CANNOT be cancelled (documented invariant)
FAILURE: queue keeps the message; the rail is the recovery surface
```

### W4 — Bulk archive, 40 messages, one fails mid-chunk
```
tick rows (click/Shift/x) → bulkbar appears (listhead swaps out)
→ Archive → bulkAct: snapshot all → store.batch removal → focus stays in list
→ chunk 1..n of 1000: progress toast with CANCEL action between chunks
→ chunk k partial-fails: reconcileBulk restores ONLY rejected ids
→ end: ONE undo entry ('Archived 39 messages') — inverse derived {add↔remove}
→ cancel mid-run: unsent rows restored; applied stay; single toast summary
FAILURE: partial success is NAMED ('archived: 39 of 40 applied')
```

### W5 — Timetable: room-change email lands
```
sync ingest → scanForUpdates over academic mail → finding (pending)
→ Changes tab shows it, quoting the sentence (evidence visible)
→ Accept → applyFieldChange → entry updated + provenance recorded
→ reader of THAT message shows r-timetable banner ('room 5105 → 6104')
→ conflict re-checked at render time against catalogue (staleness honest)
OFFICIAL notice path: applies WITHOUT asking (confidence-gated promotion)
```

### W6 — Error: worker dies mid-session
```
send() per-verb timeout (VERB_TIMEOUT_MS) → degradeToFallback (sticky)
→ showWorkerWarning banner (states degradation, no false comfort)
→ runInPage builds the SAME handler table from dynamic imports
→ every verb keeps working; scheduleWorkerProbe keeps checking
→ offline: separate persistent banner, no dismiss (the state IS persistent)
```

### W7 — Sign-out (context teardown)
```
sidebar Sign-out → confirm-free (session-level, reversible by sign-in)
→ release path: saver.flush + flushDraft + cancelPendingWork
→ resetView(allMailboxes): ALL stores cleared, mailboxState reset,
  selection cleared, query/search box cleared, lastSync=0 (freshness
  claims nothing), labels dropped, timetable dropped from memory
   (stays on disk — rebuild is expensive and the same person returns)
→ gate reappears
```

---

## 5. INTERACTION COST ANALYSIS (physical / cognitive / spatial / temporal)

| Workflow | Physical | Cognitive | Spatial | Temporal | Notes |
|---|---|---|---|---|---|
| Scan + open | 0–1 click (j/k) | low — one surface | none — scroll memory per category | optimistic paint | the reference loop |
| Archive/star/snooze | 1 click or key | low | none — neighbour auto-selected | optimistic + undo drain | cost model done right |
| Search → result | type + Enter | low | scroll reset to 0 (deliberate), anchor restored on clear | local instant; server debounced | |
| Bulk | ticks + 1 button | medium — scope must be tracked (count in bulkbar mitigates) | focus kept in listbox after action | chunked progress + cancel | |
| Compose→send | 1 key to start | low | panel overlays mail (mail still visible behind) | hold window = temporal safety, not delay | draft autosave removes fear of loss |
| Undo send | 1 click in rail | medium — user must NOTICE the countdown | rail always visible when queue non-empty | countdown visible | |
| Recategorise | tag → menu → choice | **high** — correction lives in rules store; effect appears only after reclassify; user must infer the pipeline | reader → menu → back | reclassify-all can be slow | Weakness C-1 (§21) |
| Deadline correction | action bar → menu → date | medium — correction and extraction are different stores; banner shows origin quote which mitigates | stays in reader | instant | |
| Timetable build | search → section clicks | medium — wizard asks only when ambiguous | workspace whole-area | parse is instant (local catalogue) | |
| Settings change | options trip | low | **leaves the app** for density/theme unless using Appearance menu (round 58 fix) | instant | |
| Activity log | 1 click (round 58 fix) | low | layer over mail | instant | was Ctrl+K-only |

**Key cost insight:** the expensive workflows are not click-heavy — they are
*inference-heavy* (recategorise: "will this apply now or later?"; deadline:
"which store wins?"). The fix space is communication, not fewer steps.

---

## 6. CONTEXT-PRESERVATION AUDIT

Mechanism-by-mechanism, traced to implementation:

| Context | Verdict | Mechanism (evidence) |
|---|---|---|
| Selected row | **preserved** across renders; cleared only by explicit close/action | `state.selected` + `selectNeighbourThen` on removal |
| Reader position in long mail | **preserved** per message | `readPosition` Map in reader.js; restored on iframe load |
| Scroll per category | **preserved** | `scrollMemory` Map (app.js); saved on switch, restored on return |
| Pre-search scroll | **preserved** | `preQueryScroll` captured on first keystroke; restored on clear (R5) |
| Post-delta scroll | **preserved** | `pendingScrollRestore` + lastUserScroll guard (spatial memory, audit 38) |
| Selection set | **preserved** through renders; unwound by Esc before reader | selection instance in bulk.js |
| Draft | **preserved** across crashes | draft-store autosave + pagehide flush + restore-on-boot offer |
| Query | **preserved** through open/read/act; cleared deliberately on mailbox/category switch (double-filter guard) | state.query |
| Mailbox pagination | **preserved** | mailboxState per mailbox (no refetch on return) |
| Timetable state | **preserved** across sessions; tab choice **preserved** across re-renders (module `tab`) but resets on re-open (deliberate: Schedule is the landing room) | timetable-store + module state |
| Theme/density | **preserved** | settings schema |
| Snoozed/outbox queues | **preserved** | storage-backed; survive restart |
| Freshness claim | **correctly NOT preserved** across sign-out | lastSync=0 on reset (trust rule) |
| Reader mark-read grace | **preserved-as-cancellable** — closing early keeps mail unread | markReadTimer + bodyToken |

**Lost contexts (by design, each justified in code):**
- Unread state of a message opened then abandoned after the grace window
  (the read happened — honest).
- Search overlay results on mailbox switch (stale hits would lie).
- Compose panel content on DISCARD (confirmed via dialog; autosave copy
  still offers recovery next boot — two-layer safety).

**No case found where a user must manually reconstruct a preserved-by-
default expectation.** The round-58 hidden-information findings (activity
log, help, density) were the exceptions and are fixed.

---

## 7. MODE ANALYSIS

Modes as implemented (entry → markers → what changes → exit → trap risk):

| Mode | Starts by | Markers | Changes | Ends by | Trap risk |
|---|---|---|---|---|---|
| Scanning | default | none | j/k active | — | none |
| Reading | openMessage | `state.selected` | reader pane, action bar by mailbox, Esc closes reader | Esc / close | none — Esc ladder ordered |
| Searching | search focus | body.searching | topbar refuses to collapse (O3 guard); suggestions live | blur | none |
| Selecting | first tick | body.selecting + bulkbar/listhead swap | bulk actions appear; Esc clears selection FIRST (before reader) | Esc / action | none |
| Scrolled | scrollTop>4 | body.list-scrolled | topbar yields (unless searching/selecting) | scroll up | none |
| Composing | openCompose | body.composing (+draft-dirty) | mail quieted (opacity), Esc closes panel (stopPropagation prevents release) | send/discard/min | none — minimise keeps draft visible via dirty mark |
| Bulk-running | chunked bulkAct | progress toast + aria-busy | cancel affordance lives in the toast | completion/cancel | none |
| Loading | sync/cache | skeleton (cold only) + aria-busy sweep | list replaced on settle | settle | none — skeleton never covers warm content |
| Error-offline | network loss | persistent banner | sync stops | reconnect (auto catch-up) | none — no dismiss = honesty |
| Error-worker | verb timeouts | warning banner | fallback runner engaged | probe recovery | none — sticky by design, stated |
| Signed-out | no token | gate | nothing else | sign-in | none |
| Timetable | workspace open | `#tt-workspace` visible | mail chrome hidden; Esc returns to MAIL not Gmail | Esc/header/sidebar | none — three exits (round 54) |

**Mode-composition rules (actual, from guard ordering):**
- searching ⊗ scrolled: searching wins (topbar stays) — O3 guard.
- selecting ⊗ scrolled: selecting wins — same guard.
- composing ⊗ anything: compose Esc stops propagation, so compose closes
  before any ladder rung — correct nesting.
- reading ⊗ selecting: allowed simultaneously; bulk on the selected row is
  the designed intersection (bulkAct closes reader when removing the open row).
- help ⊗ shortcuts: help swallows single-letter keys while open (prevents
  acting on invisible mail).

**No mode traps found.** The one latent risk is mode-blindness (§22 F-1):
nothing announces "you are in selecting mode" beyond the bulkbar itself.

---

## 8. PANEL / DRAWER / MODAL CHAINS

Maximum observed chain depth for any task:

| Task | Chain | Depth | Originating context visible? |
|---|---|---|---|
| Deadline correction | reader → menu → (dialog for manual date) | 3 | yes — reader stays under |
| Recategorise | reader → menu | 2 | yes |
| Snooze | reader/list → menu | 2 | yes |
| Follow-up | reader → menu | 2 | yes |
| Save view | search → prompt dialog | 2 | yes |
| Timetable reset | workspace → confirm dialog | 2 | yes |
| Compose discard | panel → confirm dialog | 2 | yes |
| Send with bad address | compose → confirm dialog | 2 | yes |

**No chain exceeds depth 3; every layer keeps its origin visible** (menus
anchor to their trigger; dialogs are centred over live content; nothing
full-screens except workspaces, which are destinations, not overlays).
Esc unwinds exactly one rung per press (layers stack LIFO, verified by
integration pins). Focus returns to the trigger on menu close (pinned in
the THEME focus-return test).

**Round-58 agreement:** no panel functions as a hidden page any more (the
timetable dialog was the only one; now a workspace). The layer system's
contract — transient, dismissable, origin-anchored — holds for every
current member.

---

## 9. ACTION DISCOVERABILITY

Classification vs mechanism (every primary action checked):

| Class | Actions | Mechanism | Match? |
|---|---|---|---|
| Primary | Compose, open, archive/trash/star, send | visible buttons + keys + sidebar primary styling | ✔ |
| Frequent secondary | snooze, reply family, refresh, search | visible (action bar/keys/topbar) | ✔ |
| Contextual | Wake (snoozed rail), Retry/Discard (stuck only), Unfold (folds only), Save view (query only), image bar (blocked only) | appear with their reason | ✔ — the honest-emptiness doctrine |
| Advanced | Recategorise, deadline correction, follow-up, rules | action bar (visible) + menus | ✔ visible, not shouted |
| Destructive | Trash, Spam, Reset timetable, Discard draft/stuck | styled danger + confirm for the irreversible ones; undo for the reversible ones | ✔ |
| Rare | Back to Gmail, sign-out, activity log, appearance | sidebar/Appearance menu | ✔ |
| Keyboard-only | `g`+digit, palette itself | help overlay + palette hints | ◑ `g`+digit is documented in help but undiscoverable without it — MINOR |

**Hover-dependence: none found.** Row star is click-only (not hover-reveal);
no interaction requires hover (touch-safe by construction, §13).

**One inconsistency (MINOR):** `Load more` is a topbar button but
pagination is otherwise invisible — a user cannot tell how much remains
(count shows total loaded, not remaining). See F-6.

---

## 10. ACTION → RESULT COMMUNICATION

| Action | Immediate feedback | Resulting state | Recovery |
|---|---|---|---|
| Triage verbs | row departure animation + travel ghost + undo toast WITH drain line | store optimistic | undo window = drain duration |
| Bulk | progress toast (chunked) + aria-busy sweep | batched store | one undo entry; cancel between chunks |
| Send | panel closes + rail row with countdown | queue held | Undo in rail during hold |
| Snooze | menu closes + toast | schedule stored | Wake in rail; WAKE_DUE alarm |
| Theme | toast names it + instant repaint | settings.set | re-pick |
| Save view | success toast | view in rail | remove from rail |
| Timetable accept | finding disappears + entry updates | state persisted | no undo — **F-3** |
| Reclassify | toast | re-rendered categories | re-recategorise |
| Failed verb | rollback + error toast | row returns | retry by repeating |
| Worker death | banner | fallback engaged | probe + banner state |

**Silent-action scan:** every state-changing path has a toast, an animation,
or a visible row change. The only deliberately quiet events: autosave
(silence = no interruption while typing; crash-recovery is the guarantee),
mark-read (reading is the action itself), cache writes.

**Misleading-feedback scan:** one structural near-miss, already guarded —
optimistic success precedes network confirmation; the undo window + rollback
is the honesty mechanism. Outbox on-the-wire non-cancellability is stated in
the rail's status vocabulary rather than hidden.

---

## 11. REVERSIBILITY & DESTRUCTIVE WORKFLOWS

| Operation | Reversibility | Mechanism | Accidental-activation risk | Verdict |
|---|---|---|---|---|
| Archive | undo window | thunk + inverse verb | low (key `e` is deliberate) | ✔ undo, no confirm |
| Trash/Spam | undo window (Gmail trash semantics) | same | `#`/`!` deliberate | ✔ undo beats confirm |
| Bulk of the above | one undo entry | derived inverse | medium — scope mitigated by visible count | ✔ |
| Star/unread | undo | flagAction inverse | negligible | ✔ |
| Snooze | wake anytime | rail + alarm | low | ✔ |
| Send | cancel ONLY during hold window | hold + outbox.cancel | medium — mitigated by countdown visibility | ✔ staged, correct choice |
| Discard draft | confirm dialog | dialog | low | ✔ confirm correct (no undo of a discard) |
| Timetable reset | confirm dialog, irreversible | dialog | low | ✔ confirm correct |
| Deadline dismiss | re-openable via menu (dismissal stored, not forgotten) | override map | low | ✔ |
| Sign-out | sign back in | gate | low | ✔ |

**Pattern verdict:** the codebase applies the right instrument per
operation — undo for reversible-high-frequency, hold-window for
send, confirm for irreversible, staged for risky-async. No case found
where a confirm dialog substitutes for a missing undo, or vice versa.
**Gap F-3:** timetable accept/dismiss findings have no undo (§21).

---

## 12. SEARCH / FILTER / NAVIGATION FLOWS

**search → results → selection → action → return, traced:**
```
type → one-rAF debounce → local filter (subject+sender) → render
→ under-served? → server search (timer-debounced) → overlay labelled 'Gmail'
→ click row → openMessage (query stays active, row highlighted via setHighlighted)
→ act → row departs; result set shrinks live
→ Esc → reader closes; QUERY STILL ACTIVE (correct: the search is the context)
→ clear box → scroll returns to preQueryScroll (R5) → suggestions re-offer history
```
Stability checks (traced): results re-derive from the store on every settled
change — no stale overlay survives a mailbox switch (`clearSearchOverlay`);
a delta arriving mid-search re-renders through the same query (no reset of
the input). **No lost-query, no hidden-active-filter case found** — the
double-filter guard (query cleared on category/mailbox switch) is explicit.

**filter → browse → open → return:** category switch saves/restores scroll
per category (`scrollMemory`); opening and closing messages never touches
the list scroll (reader is a pane, not a navigation). Sort order is fixed
(newest first, threading-aware) — **there is no user-facing sort control**;
recorded as scope fact, not defect (no demand surfaced in 60 rounds).

**Saved-view loop:** rail (persistent) + suggestions (contextual) + palette
(accelerator) all run the same `runQuery` — convergent redundancy (§19).

---

## 13. KEYBOARD INTERACTION ARCHITECTURE

Complete map (source: app.js keydown ladder app.js:2441+, shortcuts.js):

| Context | Keys | Behaviour |
|---|---|---|
| Global | `/` focus search · `c` compose · `r` refresh · `?` help · Ctrl+K palette · Ctrl+Z undo · Esc ladder | guard order: layers → palette → compose → **timetable workspace** → selection → typing-blur → reader → release |
| go-to idiom | `g` then 0–9 (1.2s expiry) | category jump; expired `g` falls through safely |
| List | `j`/`k` move · `Enter` open · `x` tick · Ctrl+A select-all | roving via renderedIds |
| Reader | `e` archive · `s` star · `u` unread · `#` trash · `!` spam/rescue · `z` snooze menu · Shift+R/A/F reply family | all gated on state.selected |
| Compose | Ctrl+Enter send · Esc close (stopPropagation) | panel-level handler |
| Menus | arrows wrap · Home/End · Esc | menu.js primitive, one implementation |
| Palette | arrows/Enter/Esc/fuzzy input | palette.js |
| Tabs (timetable) | arrows/Home/End switch rooms, roving stop | round 57 |
| Sidebar rail | arrows/Home/End roving | one tab stop doctrine |
| Dialogs | Enter submit · Esc cancel | dialog.js |

**Conflict scan:** no key has two actions in one context. Mode-dependent
keys are gated explicitly (`typing` guard; help swallows letters while open;
`?` handled before the shift-block). **Focus discipline:** list is one
tab stop (aria-activedescendant); rail one; tabs one; BMM_SHOWN puts focus
in the list on takeover reveal. **No keyboard traps found** (every surface
has an Esc or Tab-out; dialogs return focus).

**Keyboard gaps:** none for core tasks. ◑ MINOR: `g`+digit undocumented
outside help; no keyboard path to switch timetable rooms without focusing
the tab bar first (standard, not a defect).

---

## 14. POINTER / TOUCH INTERACTION

- **No hover-dependent behaviour anywhere** (row actions are permanent;
  no tooltips-as-labels — every icon button has aria-label + title).
- **Touch gestures (round 46 #11):** swipe-left archive / swipe-right
  unarchive with horizontal-dominance threshold (2× vertical) and
  long-press-to-select; a pan never triggers a swipe (moved-flag).
  `touch-action: pan-y` keeps vertical scroll native. Coarse-pointer media
  query enlarges targets.
- **Tiny-target scan:** row checkbox is pick-zone-padded (`.r-pick`);
  bulkbar/rail buttons standard size; the only small controls are the
  tab-count chips (non-interactive) and ctx-icons (15px icons but
  full-button hit area).
- **Accidental activation:** swipe thresholds + long-press delay (500ms);
  destructive buttons require deliberate click (no swipe-to-trash —
  deliberate: trash is not a swipe action here).
- **Drag:** none exists; nothing requires it.

---

## 15. ASYNC WORKFLOW ARCHITECTURE

| Operation | Pending signal | Success | Failure → recovery |
|---|---|---|---|
| Sync | skeleton (cold) / aria-busy sweep / freshness | render + count update | reportError classification → toast/banner; delta cursor invalid → full resync |
| Open body | `#r-loading` | srcdoc paint | error doc inside iframe; stale responses dropped by bodyToken |
| Triage verb | optimistic (no spinner — by design) | quiet | rollback + error toast; undo still registered |
| Bulk | progress toast + busy sweep | single undo entry | per-chunk reconcile; named partial results |
| Send | rail countdown | rail clears + toast | backoff → stuck → Retry/Discard; one toast per episode |
| Server search | none visible (local results show first) | overlay labelled | silent skip (fallback is best-effort) — acceptable |
| Timetable scan | none (runs on ingest) | Changes tab count badge | findings are advisory; dismissible |
| Image allow-list write | none | silent | session-only fallback (comment-documented) |

**Race inventory (traced guards):** mailbox switch vs in-flight loads
(`opEpoch`); stale body (`bodyToken`); double-flush (`outboxPumping` +
claims); render storms (batch + rAF); grace-timer vs navigation
(timer cancelled by token bump); delta vs scroll (pendingScrollRestore
guard). **No unguarded user-visible race found.**

**UI-truth vs operation-truth:** the optimistic pattern means the UI leads
the operation by design; the honesty instruments are rollback + undo drain +
rail status vocabulary. The two places truth lags (Weakness B): outbox rail
repaints only on pump boundaries; mark-read grace is invisible. Neither has
caused a defect in 60 rounds; recorded as OPPORTUNITY, not findings.

---

## 16. MULTI-ITEM / BULK WORKFLOW AUDIT

```
select (click/Shift/Ctrl/x/Ctrl+A) → bulkbar replaces listhead (mode visible)
→ count ALWAYS shown (selectionLabel) → tri-state select-all checkbox
→ action → snapshot → batch removal → FOCUS KEPT IN LISTBOX (round-45 pin)
→ chunked progress with cancel → ONE undo entry → selection cleared AFTER
  success only (explicitIds path keeps foreign selections intact)
```
- **Accidental loss:** selection survives renders; Esc clears it DELIBERATELY
  (first rung after surfaces) — no silent loss path found.
- **Scope confusion mitigations:** threaded tick = whole conversation
  (documented in code + test); count visible; hidden-by-filter items are
  NOT in renderedIds, so bulk cannot touch what the user cannot see.
- **Partial failure:** named and restorable (§W4).
- **Post-action navigation:** focus kept; reader closed only if the open row
  was removed; no disorientation case found.

---

## 17. ERROR & RECOVERY FLOWS

```
NORMAL → ACTION → FAILURE → UNDERSTANDING → RECOVERY → RESTORED
sync      delta    cursor/network  reportError copy   auto full-resync   full state
read      GET_BODY timeout          in-frame error doc reopen/refresh     body paints
triage    verb     network           rollback+toast    repeat action      row restored
send      dispatch backoff           rail status+toast Retry              queue drains
compose   send     bad address       confirm names it  decide             sent anyway
worker    any      timeouts          banner            fallback runner    all verbs work
storage   write    quota/corrupt     degrade-to-empty  loader defaults    app boots
```
**No workflow found where failure loses user context:** drafts flush on
teardown; selection survives errors; query survives; scroll anchors survive.
**No error appears in an unrelated place:** each surface owns its failure
surface (rail for sends, banner for connectivity, toast for verbs, gate for
auth). **Partial success is always named** (bulk counts, pump episodes).

---

## 18. WORKFLOW REDUNDANCY

| Redundant paths | Consistent? | Verdict |
|---|---|---|
| Compose: `c` / sidebar / palette | same openCompose | KEEP — accelerator triad |
| Archive: action bar / `e` / ctx-icon / swipe / palette / bulk | all converge on `act`/`bulkAct` | KEEP — one engine, many doors |
| Search entry: `/` / click / palette | same focus | KEEP |
| Views: rail / suggestions / palette | same runQuery | KEEP (round-58 K4) |
| Theme: Appearance menu / palette / options | same setTheme | KEEP |
| Undo: Ctrl+Z / toast action / palette | same performUndo | KEEP |
| Activity: sidebar / palette | same openActivityLog | KEEP |
| Open-in-Gmail: reader link / row dblclick | same gmailUrl | KEEP |
| Snooze: `z` / action bar | same menu | KEEP |

**Every redundancy converges on one underlying function** — no divergent
parallel implementations exist (the historical outbox dual-dispatch was
unified into one runner + two callers, pinned). No removal recommended.

---

## 19. CROSS-FEATURE WORKFLOW CONFLICTS

| Combination | Rule | Explicit or accidental? |
|---|---|---|
| search + selection | selection independent of query; bulk acts on rendered (queried) set | explicit (renderedIds) |
| filtering + navigation | query cleared on mailbox/category switch (double-filter guard) | explicit |
| reader + bulk | bulkAct closes reader iff the open row is removed | explicit |
| compose + navigation | compose overlays; Esc stopPropagation; minimise keeps draft-dirty mark | explicit |
| shortcuts + text input | `typing` guard; menu/palette own their inputs | explicit |
| panels + modal | layer stack LIFO; menus close-before-run | explicit (layers.js) |
| async updates + selection | delta re-render reapplies selection (`selection.active` check in renderList) | explicit |
| live updates + reading position | bodyToken drops stale; readPosition keyed per message | explicit |
| threaded + search | search shows MESSAGES, not conversations (documented divergence, deliberate) | explicit |
| threaded + single-archive | silent escalation to bulk over the thread (no query) | explicit but under-communicated (F-4) |

**The architecture has explicit rules for every audited combination.** The
layer-stack replacement of the Esc ladder (round ~46) is what turned this
from accidental-ordering into structural-ordering.

---

## 20. WORKFLOW QUALITY SCORECARD

Scale 1–5; every rating cites its evidence from this audit's sections.

| Workflow | Discoverability | Cognitive cost | Context preservation | Feedback | Recovery | Complexity | Overall |
|---|---|---|---|---|---|---|---|
| Scan/open/read | 5 (§9) | 5 (§5) | 5 (§6: 4 memory systems) | 5 (§10) | 5 | low | **5** |
| Triage (single) | 5 | 5 | 5 | 5 (undo drain) | 5 | low | **5** |
| Search | 5 | 4 (server overlay labelling takes a beat to learn) | 5 (§12) | 4 | 4 | med | **4.5** |
| Bulk | 4 (count + tri-state mitigate scope) | 4 | 5 (§16) | 5 (chunked) | 5 | med | **4.5** |
| Compose/send | 5 | 4 | 5 (autosave+hold) | 5 | 5 (hold window) | med | **4.7** |
| Snooze | 5 | 5 (presets; untilDeadline) | 5 | 4 | 5 (wake) | low | **4.8** |
| Recategorise | 3 (tag affordance is small text) | 2 (pipeline inference, §5) | 4 | 3 (effect delayed to reclassify) | 3 | med | **3** |
| Deadline correction | 4 | 3 (two stores) | 5 (banner evidence) | 4 | 4 | med | **3.7** |
| Timetable manage | 5 (round 54/57/58 rework) | 4 | 4 | 4 | 3 (no undo on accept — F-3) | med | **4** |
| Settings | 5 (options page + Appearance menu) | 5 | n/a | 4 (persist failure surfaced) | 4 | low | **4.5** |
| Error recovery | 5 (each surface owns its failure) | 4 | 5 (§17) | 5 | 5 | med | **4.8** |

---

## 21. FINDINGS CLASSIFICATION

### CRITICAL — none.
No workflow can fail into data loss or user entrapment. (The send path's
worst case — a stuck send — is visible, named, and recoverable; drafts
survive crashes; every mode has an exit.)

### MAJOR — none.
No high-frequency workflow is unnecessarily difficult. The scorecard's two
sub-4 workflows (recategorise, deadline correction) are low-frequency.

### MODERATE
- **F-1 Mode blindness (weakness A).** Selecting/searching/composing modes
  are signalled only by their own chrome (bulkbar, suggestions, dimming).
  A user mid-triage who loses the bulkbar from view (scroll) loses the mode
  signal. Evidence: §7 markers are all surface-local; no shell-level mode
  line exists.
- **F-2 Outbox truth lag (weakness B).** The rail repaints on pump
  boundaries; a send that leaves between pumps is shown as held until the
  next render. Evidence: §15; rails.pumpOutbox drives renderOutbox, no
  independent subscription.
- **F-3 Timetable accept has no undo.** Accepting a finding mutates entries
  with no reversal short of manual section switching. Evidence: §W5,
  acceptFinding has no recordUndo.

### MINOR
- **F-4 Silent thread-escalation.** Archiving one row of a multi-message
  thread archives the whole thread via bulkAct with bulk UI, but the entry
  gesture was single-row. Evidence: W1 branch; no distinct feedback.
- **F-5 `g`+digit undiscoverable** outside help (§13).
- **F-6 Pagination opacity.** `Load more` gives no sense of remaining
  volume (§9).
- **F-7 Mark-read grace invisible.** A user cannot tell the grace timer is
  running; skimming behaviour is correct but unexplained (§15).

### OPPORTUNITY
- **O-1 Recategorise as a guided flow** (§22 below).
- **O-2 Deadline panel consolidation** (§22).
- **O-3 Mode indicator line** in the listhead for selecting/searching.
- **O-4 Outbox live subscription** (store-style notify on queue change).
- **O-5 Timetable accept undo** (inverse operation is known: switchSection).

---

## 22. PROPOSED IMPROVED WORKFLOWS (redesign the flow, not the controls)

### P-1 — Recategorise (fixes F-related cognitive cost; MODERATE→resolved)
```
CURRENT FLOW
reader tag → menu of categories → pick → (silence) → user must find and
run reclassify to see the effect → effect appears across the list

PROBLEM
The correction writes to the rules store, but its visible effect requires a
second, separately-discovered action; the user carries the pipeline model.

PROPOSED FLOW
reader tag → menu → pick → correction applied AND the open message
re-files itself (store patch + single-row re-render) + toast:
"Future mail from X will file under Y" — with the list-level reclassify
offered IN THE SAME TOAST as an action for the existing corpus.

WHY
Effect becomes immediate and local; the batch operation becomes an opt-in
second step with its scope stated. No new surface; the toast action carries
it. Touches: openRecategoriseMenu (app.js), applyCorrection call site.
```

### P-2 — Deadline correction (consolidates two-store confusion)
```
CURRENT FLOW
banner shows extraction+evidence → Deadline menu → presets/manual/dismiss →
override store → banner re-renders

PROBLEM
Extraction (record) and correction (override) are different stores; the
menu must re-derive the effective value to show what is current.

PROPOSED FLOW
Same menu, but the CURRENT effective deadline is the menu's header line
(effectiveDeadline already computed at open), and every choice's result is
previewed in-place before commit. No store merge — the model is right; the
communication is what needed the merge.

WHY
Keeps the override/extraction separation (it is load-bearing for dismissal
semantics) while removing the inference cost. Touches: openDeadlineMenu.
```

### P-3 — Mode indicator (F-1)
```
CURRENT: bulkbar is the only selecting-mode signal; search-mode is the
suggestions list.
PROPOSED: the listhead (already swapped by the bulkbar) gains a compact
mode line: "N selected" exists; add "Searching: <query>" while a query is
active with results, cleared with the query. One element, two modes, no
new surface.
WHY: mode becomes a readout, not an inference. Touches: list.js listhead.
```

### P-4 — Outbox live truth (F-2/O-4)
```
CURRENT: rail repaints on pump boundaries.
PROPOSED: outbox.js gains the same notify discipline as Store (subscribers
on enqueue/cancel/transition); rails subscribes once. The countdown becomes
a timer-driven repaint only while the hold is live.
WHY: the rail stops lagging the queue; the hold countdown becomes honest
second-by-second. Touches: outbox.js, rails.js.
```

### P-5 — Timetable accept undo (F-3/O-5)
```
CURRENT: accept mutates entries; no undo.
PROPOSED: acceptFinding records the prior section/state and registers an
undo thunk using the existing switchSection inverse; toast gets the drain
window like every other reversible action.
WHY: brings the academic surface to the same reversibility standard as
mail triage (§11). Touches: timetable-ui.js acceptFinding.
```

**None of P-1..P-5 requires a page-architecture change** — they confirm the
round-58 verdict: the surface structure is right; the remaining work is
inside task families.

---

## 23. ARCHITECTURE CHANGES REQUIRED

For the interaction layer: **none structural.** The proposals above are all
intra-surface. Two standing rules from earlier rounds are REAFFIRMED, not
relaxed: subordinates never take the main area; Esc stays one structural
ladder. One rule is flagged for future review under §22-of-the-charter
("rules are constraints to evaluate"): the fixed newest-first sort — if a
sort control is ever needed, it belongs in the listhead mode line area, not
a new panel; no action required now.

---

## 24. COMPLETE FINAL TASK-FLOW MAP

### A. Mode/state machine
```
        ┌─────────┐  open msg   ┌─────────┐
   ┌───▶│SCANNING │────────────▶│ READING │◀─── j/k keeps it
   │    └────┬────┘             └────┬────┘
   │         │ tick                  │ Esc
   │         ▼                       │
   │    ┌──────────┐                 │
   │    │SELECTING │──Esc──▶ SCANNING◀┘
   │    └────┬─────┘
   │         │ bulk action (chunked, cancellable)
   │         ▼
   │     [BULK RUNNING]──▶ SELECTING cleared / SCANNING
   │    (/ focus)              (c opens overlay)
   │    ┌──────────┐   Esc    ┌───────────┐
   └───▶│SEARCHING │◀────────▶│ COMPOSING │ (stopPropagation Esc)
        └──────────┘          └───────────┘
 any mode ──timetable btn──▶ TIMETABLE WORKSPACE ──Esc/sidebar──▶ back
 any mode ──worker death──▶ DEGRADED (banner, fallback runner)
 any mode ──network loss──▶ OFFLINE (persistent banner)
```

### B. Context-preservation transition map
```
transition                    survives
open message                  query, scroll, selection, category
close reader                  everything (Esc ladder rung)
archive/trash                 selection moves to neighbour; undo window
mailbox/category switch       per-surface scroll memory; query cleared (guard)
search clear                  pre-search scroll restored
delta sync                    scroll anchor, selection, reader (if still present)
crash/teardown                draft, cache, queues, timetable, overrides
sign-out                      NOTHING session-scoped (trust rule); disk keeps
                              timetable+queues+settings for the same profile
```

### C. Navigation/surface map
```
shell
├── sidebar (nav + state glances)          depth 0
├── MAIL workspace                          depth 0
│   ├── listhead/bulkbar (mode swap)        depth 0.5
│   ├── reader pane                         depth 0.5
│   └── menus anchored to triggers          depth 1 (transient)
├── TIMETABLE workspace + tabs              depth 0/1
├── dialogs (confirm/prompt)                depth 1 (transient)
├── compose panel                           depth 1 (persistent-until-closed)
└── gate                                    depth ∞-until-auth
MAX DEPTH 3 (deadline manual date), origin always visible, Esc = one rung.
```

### D. Async state map
```
held ──hold expires──▶ sending ──ack──▶ sent
  │                      │
  │ undo                 └──fail──▶ retrying (15s/1m/5m/15m)
  ▼                                       │
cancelled (never dispatched)               └──4th fail──▶ stuck ──▶ retry/discard
sync: skeleton/busy ─▶ settled | resync | offline | degraded
```

### E. Feedback map
```
reversible+fast  → optimistic + undo toast WITH drain line
chunked          → progress toast with cancel + aria-busy
queued           → rail row with status vocabulary + countdown
failure          → rollback + named error toast; banner for persistent states
success-quiet    → autosave, mark-read, cache (silence documented as intent)
```

---

## 25. EVIDENCE INDEX (key references)

- Keyboard ladder & guards: `src/app/app.js:2441–2627`; shortcuts data
  `src/app/shortcuts.js:30–68`.
- Triage engine: `act` app.js:894 · `optimistic` app.js:810 · `flagAction`
  app.js:751 · thread-escalation branch app.js:~905.
- Bulk: `bulkAct`/`renderSelection`/`move` src/app/bulk.js; focus-kept pin
  round45-phase3; chunk-cancel semantics in bulkAct.
- Send/outbox: `doSend` compose.js:562+ · `enqueue/isStuck/nextWakeIn/
  prioritizeDue` outbox.js · pump rails.js · acceptance test/outbox-send.
- Context systems: scrollMemory (app.js selectCategory) · readPosition
  (reader.js) · preQueryScroll/pendingScrollRestore (list.js) · draft-store.
- Modes: body-class markers grep §7 table; Esc ladder ordering
  app.js:2444–2491; layers LIFO src/app/layers.js.
- Menus/dialogs primitives: menu.js (roles, wrap, Home/End) · dialog.js.
- Timetable: timetable-ui.js (tabs round 54/57, search-first round 58).
- Error surfaces: reportError app.js:1494 · banners 1534+/1593+ · fallback.js.
- Reversibility: undo-actions.js (drain window) · hold window outbox.
- Redundancy convergence: palette.js commands list (all call shared fns).

**UNVERIFIED:** real-Chrome timing of the outbox rail repaint lag (F-2) —
inferred from code path, not measured in a browser; all other claims traced
to code. Screen-reader runtime behaviour is infrastructure-audited (ARIA
pins + roles) but not listener-tested — consistent with roadmap Phase 2.

---

## EXECUTIVE SUMMARY (for the redesign agent)

The interaction architecture is **healthy at the structure level**: one
mail loop, one academic workspace, one settings page; max overlay depth 3
with origin always visible; every mode escapable; every context worth
keeping is kept by explicit machinery; every redundancy converges on one
engine; every destructive operation carries the correct instrument (undo /
hold / confirm). There is **no workflow that needs a new page or panel**.

Five improvements, all intra-surface, in priority order:
**P-1** recategorise with immediate local effect + corpus reclassify in the
toast (removes the only inference-heavy flow); **P-4** outbox live
subscription (honest countdown); **P-5** timetable accept undo (parity with
mail reversibility); **P-3** listhead mode line (searching/selecting
readout); **P-2** deadline menu header showing the effective value.
Plus minor communication items F-4..F-7.

The charter's warning — do not protect existing rules reflexively — was
applied: every standing rule (one-page mail surface, Esc ladder, no sort
control, subordinates never full-area) was evaluated against its cost and
kept because no proposed violation produced a better task outcome. The
priority order *task success → clarity → context → efficiency → consistency
→ engineering cost* was used for every verdict above.
