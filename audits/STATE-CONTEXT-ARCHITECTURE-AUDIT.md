# STATE & CONTEXT ARCHITECTURE AUDIT (Round 62)

**Charter:** what does the application know, where does it live, who owns it,
who can change it, how does it propagate, and what happens to it when the
user moves through the application? Audit only — **no fixes implemented**.
Third of the architecture series (58 hierarchy → 60 interaction → 62 state).
Evidence standard: file/symbol for every claim; **UNVERIFIED** where not
checkable from code; **INTENDED/ACTUAL** where they differ.

---

## 1. EXECUTIVE DIAGNOSIS

**The state architecture is the strongest of the three audited layers —
and it got that way because its failures were each paid for and then
structuralized.**

The system runs on four disciplined decisions, each traceable to a defect it
ended:

1. **One Store per mailbox, mutated only through `batch()`** — mutations
   coalesce to ONE notification, rendering coalesces to ONE rAF (THE ONE
   RULE). No UI code renders directly from a mutation.
2. **The `ctx` seam** — surfaces never import the shell; capabilities are
   injected at wiring; the active store crosses ONLY as a getter (the
   captured-store bug is the most expensive one in project history, now
   pinned).
3. **Storage has a registry** (round 59): every persisted key has an owner,
   purpose, backup decision; backup derives its allow-list from it.
4. **Test isolation has a registry** (round 59): cached module state
   self-registers resets; the harness runs one call.

**Remaining weaknesses (none critical):**

- **W-1 — Distributed mode truth.** Mode is encoded across body classes
  (`searching`, `selecting`, `composing`, `draft-dirty`, `list-scrolled`),
  `state.*` flags, layer stack depth, and `hidden` attributes. No single
  read answers "what mode is the app in" — every consumer derives it from a
  different signal. Safe today because each consumer reads only what it
  needs; brittle under future cross-mode features.
- **W-2 — Two representations of "which message is open"**: `state.selected`
  (conversation/row) vs reader `openPart` (message inside it). Deliberate,
  documented, and correctly synchronized — but it is the one place two
  source-of-truth-looking values coexist, and `ctx.openMessageId` exists
  precisely to reconcile them for compose.
- **W-3 — Worker-side state is sessionless by design but not obviously so**:
  the worker keeps cursor + dedupe + token in storage; the app keeps stores
  in memory + cache. Consistency is re-established by sync, not shared
  state. Correct for MV3, but the split is only documented in fragments.
- **W-4 — Optimistic divergence window.** Between optimistic mutation and
  verb ack, UI leads server; rollback is the honesty mechanism. The window
  is short and covered, but NOTHING surfaces "in flight" for single verbs
  (bulk has progress; singles don't). Opportunity, not defect.

**Verdict:** no redesign needed. Two structural nudges recommended (§22):
a mode-state read-only view (makes W-1 inspectable without changing writers)
and an in-flight registry (makes W-4 visible). Both additive.

---

## 2. COMPLETE STATE INVENTORY

### 2.1 Shell state (app.js)

| State | Kind | Owner | Persistence |
|---|---|---|---|
| `stores` Map (Store per mailbox) | domain container | app.js | memory; cache.js snapshot |
| `store` live binding | view onto active store | app.js | — |
| `mailboxState` Map (nextPageToken/loaded/loading per mailbox) | sync | app.js | memory |
| `state.mailbox/category/query/selected/theme` | navigation+view | app.js | memory (theme→settings) |
| `state.nextPageToken/loading` | sync | app.js | memory |
| `state.signedIn/selfEmail/lastSync` | auth/session | app.js | memory (truth in worker) |
| `rules` | user rules | app.js | storage `categoryRules` |
| `deadlineOverrides` | corrections | app.js | storage `deadlineOverrides` |
| `followupList` | follow-ups | app.js | storage `followups` |
| `enrolment` | academics | app.js | storage `myCourses` |
| `automationRules` | automation | app.js | storage `automationRules` |
| `opEpoch` | race guard | app.js | memory |
| `goPending` (g+digit) | keyboard mode | app.js | memory (1.2s TTL) |
| worker-down flag + probe timer | degradation | app.js | memory (sticky) |
| auto-refresh timer | scheduling | app.js | memory |
| cache saver handle | persistence debounce | cache.js | idle/50ms timer |

### 2.2 Surface module state (extracted rounds 51–52)

| Module | State | Lifecycle |
|---|---|---|
| list.js | renderedIds, nodeById, firstPaint, scrollMemory Map, newCount, preQueryScroll, pendingScrollRestore, restoreQueued, lastUserScroll, scrolledOn, travelGhostEl | session; reset seam `_resetList` |
| reader.js | bodyToken, lastBody, markReadTimer, lastSwapAt, openPart, imageAllowList (→storage `imageAllow`), readPosition Map | session; survives only via persisted imageAllow |
| bulk.js | selection (Selection instance) | session; `_resetBulk` |
| suggest-ui.js | suggestions, suggestIndex, queryHistory (→storage), suggestBlurTimer | session; history persisted |
| rails.js | outboxTimer, pumpFailedNotified, newlyStuck | session |
| timetable-ui.js | timetable state (→storage `timetable`), pending findings, unsavedError, source catalogue, tab, ctxRef | persisted; tab session-only |
| compose.js | panel DOM state, draft autosave (→storage `composeDraft`), attachments staged | draft persisted |
| palette.js | open layer, filtered list | transient |
| layers.js | layer STACK (the modal/order source of truth) | transient |
| menu.js | the one open menu | transient |
| help.js | helpLayer | transient |
| undo-actions.js | undoStack (thunks) | session |
| activity.js | log queue (→storage `activityLog`) | persisted |

### 2.3 Worker state (background/)

| State | Persistence |
|---|---|
| OAuth token + expiry (`accessToken`, `expiresAt`) | session-area-preferred storage |
| history cursor (`historyId`) | storage |
| notify dedupe | storage |
| alarms (WAKE_ALARM, SYNC_ALARM) | chrome.alarms |
| `outboxPumping` in-flight flag | memory only (correct: eviction clears it) |

### 2.4 DOM-as-state (hidden/aria/class carriers)

`hidden` attributes: gate, compose, palette, help, tt-workspace, panes
children, rails (empty-hides), r-due/r-timetable/r-unfold/r-images,
skeleton, empty, bulkbar/listhead swap, newpill, offline banner, worker
warning, listquery (round 62). Body classes: searching/selecting/
composing/draft-dirty/list-scrolled. Aria carriers: aria-selected on rows
(from state.selected), aria-pressed on stars, aria-current on rail,
aria-expanded on combobox+theme trigger, aria-activedescendant on listbox
and combobox. **Rule: DOM carries PROJECTIONS only; every one is rewritten
from state on the responsible render pass** — verified: no DOM node is the
sole holder of a truth the logic reads, with ONE documented exception: the
scroll position itself (scrollTop IS the state; scrollMemory snapshots it).

### 2.5 Persisted keys (registry, round 59)

The registry (`storage-registry.js`) is the source of truth: 13 settings
keys (SCHEMA-derived) + 19 domain keys, each with owner/purpose/backup
decision/reason. Never-export list enforced by test. This audit defers to it
rather than re-listing; its completeness sweep test is the guarantee.

### 2.6 URL state

**None.** The app has no URL routing by design (extension page inside an
iframe; Gmail owns the URL). Deep links go OUT (gmailUrl), never in.
Recorded as a fact with consequences in §15.

---

## 3. STATE OWNERSHIP MAP (single-source vs duplicated vs derived vs implicit)

```
MAIL DATA
├── owner: Store per mailbox (store.js)
├── writers: ingest (sync path ONLY), triage verbs, bulkAct, undo thunks
│            — all through batch()
├── readers: list (visibleIds via selectors), reader, rails, suggest,
│            sidebar counts, server-search overlay
├── persistence: cache.js snapshot (warm starts)
├── derived: visibleIds (query+category+muted+threads), counts, radar items,
│            suggestions, lane assignment, course chips
└── UI projections: rows (nodeById), sidebar counts, rails, radar

VIEW STATE
├── owner: app.js `state` object
├── writers: shell handlers ONLY (surfaces request via ctx callbacks:
│            selectCategory/selectMailbox/runQuery)
├── readers: every render pass
└── persistence: theme via settings; rest session-only

SELECTION
├── owner: bulk.js Selection instance
├── writers: tick/x/Ctrl+A paths, cleared by Esc/actions
├── readers: renderSelection, bulkAct, selectedMessageIds
└── invariant: selection ⊆ renderedIds semantics (live() filters stale ids)

OPEN MESSAGE
├── conversation: state.selected (owner: shell via reader.openMessage)
├── message-in-thread: reader.openPart (owner: reader.js)
├── reconciler: ctx.openMessageId = openPart || selected
└── consumers: compose reply targeting

OUTBOX
├── owner: outbox queue in storage (outbox.js model)
├── writers: enqueue (compose), cancel, pump transitions (worker OR fallback
│            runner — ONE runner, two callers)
├── readers: rails rail, pump scheduler
└── in-flight flag: worker memory only (eviction-safe by design)
```

**Single-source verdict:** mail data, view state, selection, outbox, theme,
timetable, rules — each has exactly one authoritative holder.
**Duplicated-but-derived (safe):** sidebar counts vs list counts (both derive
from the same Store through collapseThreads — agreement pinned by R-6), row
aria-selected vs state.selected (projection, rewritten on render).
**Dangerous duplications found: none.** The historical ones (two dispatch
loops; hand-mirrored backup keys) were each eliminated and pinned.

---

## 4. STATE DEPENDENCY GRAPH

```
state.query ──▶ visibleIds ◀── state.category ──▶ sidebar counts
                  │                    ▲
                  ▼                    │
             renderList ──▶ renderedIds ──▶ selection.live() ──▶ bulkbar
                  │                                  │
                  ▼                                  ▼
              nodeById ◀──────────── renderSelection
                  │
state.selected ──▶ reader.openMessage ──▶ openPart ──▶ ctx.openMessageId
                  │                                       │
                  ▼                                       ▼
            markReadTimer ──(grace)──▶ store.patch(unread) ──▶ counts
store batch ──▶ notify ──▶ scheduleRender ──▶ ONE rAF ──▶ all renderers
rules ──▶ applyCorrection (ingest) ──▶ store categories ──▶ list+sidebar
deadlineOverrides ──▶ dueAtOf ──▶ radar/lanes/r-due banner
timetable state ──▶ conflicts(render-time vs catalogue) ──▶ Conflicts tab
outbox queue ──▶ nextWakeIn ──▶ outboxTimer ──▶ pump ──▶ queue transitions
```

**Circular dependencies: none** (graph is a DAG; the only loops are
intended feedback loops: action → store → render → user). Stale-state
guards at every async edge: `opEpoch` (mailbox), `bodyToken` (body),
`markReadTimer` cancellation, pump in-flight flag, render coalescing.
**State calculated in multiple places:** collapseThreads is the ONE choke
point for thread-collapse agreement (verified: sidebar AND list AND
selection all route through it). **Ambiguous owners: none found** beyond
the documented selected/openPart pair.

---

## 5. CONTEXT INVENTORY (persistent / session / transient / derived)

| Context | Class | Home |
|---|---|---|
| signed-in identity | session (worker-persisted) | auth storage + state.selfEmail |
| theme/density/prefs | persistent | settings schema |
| rules/overrides/followups/enrolment/timetable/views/templates | persistent | registry keys |
| imageAllow, queryHistory, composeDraft | persistent | registry keys |
| active mailbox/category | session | state |
| search query | session | state.query (+ listquery readout) |
| selected conversation | session | state.selected |
| open message in thread | session | reader.openPart |
| multi-selection | session | Selection instance |
| scroll per category | session | scrollMemory |
| pre-search scroll | session | preQueryScroll |
| reading position per message | session | readPosition |
| open panel/menu/dialog | transient | layers stack / menu |
| focused element | transient | DOM + focus-return in teardowns |
| keyboard sub-mode (g pending) | transient (1.2s TTL) | goPending |
| pending ops (verb in flight, grace timer, chunk progress) | transient | tokens/timers/toast |
| undo history | session | undoStack |
| mode readout | derived | body classes + listquery + bulkbar |

---

## 6. CONTEXT-PRESERVATION MATRIX

| Context | Transition | Verdict | Mechanism |
|---|---|---|---|
| selected row | open/act/render | **preserved** | state.selected + selectNeighbourThen on removal |
| reading position | close/reopen same message | **preserved** | readPosition keyed by message id |
| scroll | category switch | **preserved** | scrollMemory save/restore |
| scroll | search clear | **preserved** | preQueryScroll (R5) |
| scroll | delta sync | **preserved** | pendingScrollRestore + user-scroll guard |
| scroll | mailbox switch | **reset to 0 — intentional** (new dataset) |
| query | open/act/return from reader | **preserved** | state.query untouched by reader |
| query | mailbox/category switch | **cleared — intentional** (double-filter guard) |
| selection | renders/deltas | **preserved** (reapplied in renderList) |
| selection | Esc | **cleared — intentional** (first rung) |
| selection | bulk action success | **cleared — intentional**; kept on explicitIds paths |
| draft | discard | **cleared after confirm**; crash copy offers recovery next boot |
| draft | crash/teardown | **preserved** | autosave + pagehide flush |
| draft | minimise | **preserved + dirty-marked** |
| compose target | send-to-outbox | **transitions to queue row** (context becomes the rail) |
| reader state | workspace switch | mail chrome hidden, reader state intact (state.selected kept) |
| timetable tab | re-render | **preserved** (module `tab`) |
| timetable tab | close+reopen | **reset to Schedule — intentional** (landing room) |
| undo stack | sign-out | **discarded with session — intentional** |
| freshness claim | sign-out | **zeroed — intentional** (trust rule) |
| snoozed/outbox/timetable | sign-out | **kept on disk, dropped from memory — intentional** (same-profile reinvestment) |
| server-search overlay | mailbox switch | **cleared — intentional** (stale-hit guard) |

**No unintended loss found.** Every "lost" row above is an explicit,
comment-documented decision with a guard test or pin.

---

## 7. CONTEXT LOSS AUDIT

Exhaustive sweep for reconstruction costs. Format: what → why it matters →
reconstruction cost → intentional?

| Loss | Impact | Reconstruction | Intentional? |
|---|---|---|---|
| Query on mailbox/category switch | user mid-search switching context loses the text | retype (suggestions offer history) | YES — double-filter guard; alternative (stale hidden filter) is worse |
| Scroll on mailbox switch | disorientation | scroll | YES — different dataset |
| Selection after bulk | mode must end | re-tick | YES — action completed |
| Draft on discard | typing lost | autosave crash copy offers it back | YES — confirmed + recoverable |
| Undo stack on sign-out | cannot undo previous session | none needed (session ended) | YES |
| Reader tags after reclassify | would show stale category | — | **FIXED round 61 (P-1): tags re-render in place** |
| Outbox countdown between pumps | countdown frozen until pump render | wait for pump | UNRESOLVED-LIGHT (W-4/M2 — Chrome-verdict pending) |
| Findings after accept-undo | would strand reverted change | — | **FIXED round 61 (P-5): finding returns** |

**Conclusion:** the only live reconstruction costs are the intentional ones;
the two accidental ones found in round 60 were fixed in round 61.

---

## 8. STATE MACHINES (major workflows)

**Reader/selection navigation**
```
NO_SELECTION --open--> READING --Esc--> NO_SELECTION
READING --j/k--> READING(other)        (bodyToken drops stale)
READING --act(removal)--> NEIGHBOUR_SELECTED (selectNeighbourThen)
READING --workspace switch--> READING-PAUSED (state kept, chrome hidden)
```
Impossible states verified: reader open with no selected id (openMessage
guards on store lookup); two readers (single pane, single state.selected).

**Outbox item**
```
HELD --hold expires--> SENDING --ack--> SENT(removed)
HELD --undo--> CANCELLED (never dispatched)
SENDING --fail--> RETRYING(15s/1m/5m/15m) --due--> SENDING
RETRYING --4th fail--> STUCK --Retry--> SENDING
STUCK --Discard--> REMOVED
```
Impossible: cancel after dispatch (documented invariant, pinned);
double-dispatch (pumping flag + claims, pinned). Ambiguity: none — the rail
status vocabulary names every state (statusOf pinned for truthfulness).

**Sync**
```
IDLE --refresh--> LOADING --delta-ok--> SETTLED(lastSync stamped)
LOADING --cursor-invalid--> FULL_RESYNC --> SETTLED
LOADING --network--> ERROR(reportError classifies) --retry--> LOADING
any --worker dead--> DEGRADED(fallback runner; banner)
any --offline--> OFFLINE(persistent banner) --reconnect--> catch-up
```
lastSync advances ONLY on success (trust invariant, commented + pinned).

**Compose/draft**
```
EMPTY --typing--> DIRTY(draft-dirty class + autosave debounce)
DIRTY --minimise--> MINIMISED(dirty mark survives)
DIRTY --send--> QUEUED(hold window) --undo--> GONE / --expire--> SENDING
DIRTY --discard--> CONFIRMED-GONE (crash copy still offers recovery)
any --crash--> RECOVERABLE(boot offers the draft)
```

**Auth/gate**
```
SIGNED_OUT(gate) --SIGN_IN--> AUTHENTICATING --token--> SIGNED_IN
SIGNED_IN --SIGN_OUT--> TORN_DOWN(resetView allMailboxes) --> SIGNED_OUT
```
Missing states: none reachable-unhandled; gate error path named.

**Layer stack (modal ordering)**
```
EMPTY --openLayer--> STACK[n] --closeTopLayer--> STACK[n-1]
STACK --Esc--> pops exactly one rung (LIFO, pinned)
any --teardown--> closeAllLayers WITH onClose teardowns first (harness rule)
```

**Conflicting-state scan:** no machine admits two active modes that fight —
searching⊗selecting⊗scrolled resolve by explicit guard priority (O3);
composing⊗ladder resolved by stopPropagation; help⊗shortcuts by swallow.

---

## 9. HIDDEN STATE AUDIT

Could two developers reasonably believe the app is in different states?

| Hidden carrier | What it encodes | Discoverability | Verdict |
|---|---|---|---|
| body.searching/selecting/composing/draft-dirty/list-scrolled | modes | grep-able, one convention | acceptable — but no single read (§22 N-1) |
| `hidden` attributes (17+ carriers) | surface visibility | DOM-inspectable | acceptable — all rewritten from state |
| aria-selected/pressed/current/expanded | selection/press/nav/open | projection only | correct |
| layer stack depth | modal nesting | layers.js API (layerCount/topLayerName exist for tests) | acceptable |
| goPending timer | g+digit sub-mode | TTL-bound, single variable | acceptable |
| scrollTop itself | scroll position | inherent | unavoidable; snapshotted where needed |
| worker `outboxPumping` | dispatch in flight | worker-memory only | correct for MV3 |
| opEpoch | staleness epoch | single counter | acceptable (named, commented) |
| storage keys | persistent truth | **registry (round 59)** | solved |
| module state across boots | test isolation | **reset registry (round 59)** | solved |

**Verdict:** hidden state exists (inevitable) but every carrier is either a
named convention, a projection, or registry-managed. The one genuine gap is
the missing *aggregated* mode read (W-1) — addressed as a proposal, not a
defect, because no current consumer needs the aggregate.

---

## 10. DUPLICATED STATE AUDIT

| Concept | Representations | Authoritative | Sync mechanism | Dangerous? |
|---|---|---|---|---|
| open conversation | state.selected + row aria-selected | state.selected | rewritten on render | NO — projection |
| open message | openPart + ctx.openMessageId | openPart | getter derives | NO — reconciler exists |
| starred | store field + row aria-pressed + reader star | store | flagAction + render | NO |
| unread | store field + markReadTimer pending | store (timer defers the write) | grace cancellation | NO — window documented |
| counts | sidebar + listhead | Store (derived via collapseThreads) | one choke point | NO — agreement pinned |
| category | store field + tag + row bar color | store | reclassify re-render | NO (staleness FIXED r61) |
| theme | settings + state.theme + root dataset | settings schema | boot read + setTheme | NO — single writer |
| effective deadline | extraction + override | override-or-extract via effectiveDeadline | ONE resolution fn | NO — menu now shows reconciliation (r62 P-2) |
| draft | panel fields + autosave copy | panel while open; copy for crash | autosave debounce | NO — two-layer safety by design |

**All duplications are intentional projections or reconciled derivations.
No dangerous duplication survives.**

---

## 11. DERIVED STATE AUDIT

| Derived | Source | Consumers | Invalidation | Risk |
|---|---|---|---|---|
| visibleIds | store + query + category + rules + threads | list, bulk, server-search overlay | every settled change | low (one choke point) |
| collapseThreads results | same | sidebar, list, selection | same | low (ONE function) |
| radar items | deadlines + overrides + store | radar rail, reader-idle | render pass | low |
| lane assignment | store + selfEmail + overrides | lane headers | render when setting on | low |
| suggestions | store senders + labels + views + history | combobox | rebuilt per focus/input | low |
| conflicts | entries vs catalogue | Conflicts tab | **render-time** (staleness honest) | low — deliberately not stored |
| counts | store | sidebar/listhead | render | low |
| fresh/label state | lastSync | freshness stamp | render on sync | low |

**Stored-where-derivable:** none found. **Recomputed-in-multiple-places:**
collapseThreads deliberately centralized; no conflicting derivations.
Performance: derivations run on settled changes/rAF, never per keystroke
except suggestions (bounded inputs, measured cheap).

---

## 12. STATE LIFECYCLE AUDIT

| State | Created | Destroyed | Survives-too-long? | Resets-too-early? |
|---|---|---|---|---|
| Store per mailbox | first touch | sign-out (all) | NO | NO |
| selection | first tick | Esc/action/sign-out | NO | NO |
| draft | compose open | send/discard-confirmed | crash copy intentionally outlives | NO |
| undoStack | first action | session end | NO (session-scoped correct) | NO |
| layer entries | openLayer | close/teardown | harness closes-with-teardown | NO |
| bodyToken/lastBody | first open | closeReader | NO | NO |
| scrollMemory | first switch | session end | NO | NO |
| queryHistory | first search | never (persistent) | persistent by design | NO |
| module state in tests | import | reset registry | **was the round-54 bug class — registry closed it** | NO |
| worker cursor | first delta | never | correct (server-side truth) | NO |

**Outlives-owner scan:** clean. **Initialized-too-late scan:** settings
cache is loaded FIRST in boot (documented ordering invariant); rules before
first ingest (documented); nothing else order-sensitive found.

---

## 13. ASYNC STATE & RACE AUDIT

| Race | Guard | Evidence |
|---|---|---|
| stale body response | bodyToken bump on every open/close | reader.js; integration |
| mailbox switch vs in-flight loads | opEpoch invalidation | app.js; RACE integration tests |
| render storms | batch → one notify → one rAF | THE ONE RULE pins |
| grace-timer vs navigation | timer cancelled by token bump | integration (skim-past test) |
| double dispatch | outboxPumping flag + storage claims | outbox-send acceptance |
| cancel vs dispatch | hold-window boundary; on-wire non-cancellable stated | outbox tests |
| delta vs scroll | pendingScrollRestore + user-scroll guard | spatial-memory pins |
| selection vs delta | reapplied in renderList; live() filters stale ids | selection tests |
| stale search overlay | cleared on mailbox switch | bug-hunt #26 pin |
| optimistic vs server | rollback on reject + undo window | triage tests |
| state update after teardown | cancelPendingWork on release; saver flush ordering | release path |
| stuck pending states | pump re-arm + nextWakeIn; RETRYING has named backoff; STUCK waits for user | outbox tests |

**Uncovered theoretical race (UNVERIFIED in browser):** two tabs with the
app open both pumping — claims guard targets same-profile coordination;
cross-tab behaviour relies on storage-claim atomicity. Recorded, not fixed
(charter: no fixes).

---

## 14. MULTIPLE WRITER AUDIT

| State | Writers | Coordination | Verdict |
|---|---|---|---|
| Store | ingest, triage verbs, bulkAct, undo thunks | ALL through `batch()`; verbs own optimistic protocol | justified |
| rules | category menu, recategorise, reclassifyAll | one module surface (app.js) + storage | justified |
| deadlineOverrides | deadline menu only | single surface | clean |
| outbox queue | enqueue(compose), cancel, pump(worker OR fallback) | ONE runner fn, claims guard | justified |
| settings | options page + setTheme in-app | settings.set is the single API; followExternalChanges syncs pages | clean |
| imageAllow | reader only | single surface | clean |
| timetable state | wizard, acceptFinding, dismiss, reset, undo thunk (r61) | all inside timetable-ui; persist() single writer fn | clean |
| selection | tick paths, Esc, bulk cleanup | Selection API only | clean |
| DOM | renderers ONLY (one per surface) | THE ONE RULE | clean |

**No state has uncoordinated writers.** The Store's multiple writers are the
one that could have been dangerous; `batch()` + the optimistic protocol is
the coordination, and it is the most-tested part of the codebase.

---

## 15. PERSISTENCE & REHYDRATION

```
runtime → serialization → storage → restart → deserialization → rehydration
settings   flat typed keys   local    boot     SCHEMA coerce     loadSettings FIRST
rules      JSON blob         local    boot     emptyRules() on corruption
outbox     queue JSON        local    boot     loadOutbox degrades to []
draft      draft JSON        local    boot     restore offer (never auto-open)
cache      snapshot          local    boot     warm start; full sync reconciles
timetable  state JSON        local    boot     emptyState() on corruption
overrides  map JSON          local    boot     {} on corruption
imageAllow list             local    boot     [] on corruption
historyId  cursor            local    boot     absent → full sync (safe)
token      token JSON        session  boot     absent → gate
```
- **Schema/version:** settings SCHEMA is typed with defaults + coercion;
  other blobs use shape-tolerant loaders that degrade to empty (each pinned).
- **Corruption:** every loader degrades-to-empty rather than throwing (the
  resilience sweep enforces the contract for every entry point).
- **Partial writes:** storage.set is per-key; no multi-key transactions
  exist or are needed (keys are independent truths).
- **Init ordering:** settings → rules → imageAllow → start() (documented +
  integration-covered).
- **Accidentally persisted:** none (registry backup-flags each key with a
  reason; NEVER_EXPORT enforced). **Should-be-persisted-but-isn't:** none
  identified — session-only items (selection, scroll, undo) are correctly
  session-scoped.

---

## 16. URL / ROUTING STATE

The app holds **zero URL state** — deliberate: it runs inside an iframe on
Gmail's URL; Gmail owns the address bar. Consequences, stated honestly:
- Reload/back/forward/new-tab operate on GMAIL, not on app context.
- Nothing is shareable/deep-linkable into the app.
- Context survival across reload = whatever persistence covers (registry
  keys) + cache warm start.
**Mismatch risk:** none possible (no URL state to mismatch). If deep links
are ever wanted, the mapping is clean: mailbox+category+query+selected are
exactly `state`'s navigable fields. **UNVERIFIED:** iframe restore semantics
across Gmail navigation in real Chrome (roadmap Phase 4).

---

## 17. UI STATE SYNCHRONIZATION

Direction of authority, traced:
```
state/store (authoritative) → batch → notify → rAF → renderers → DOM
user event → handler → state mutation → (same path) → DOM
```
- **DOM authoritative anywhere?** NO — with the documented scroll exception
  (scrollTop is inherently DOM state; snapshotted at the right moments).
- **Mutations bypassing state?** none found — every handler mutates state or
  a store, never DOM-first.
- **State changes without UI update?** impossible by construction (notify →
  rAF render covers every settled change); the outbox rail repaint lag
  (W-4) is the one *timed* gap.
- **UI updating before state?** optimistic pattern does this BY DESIGN;
  rollback is the honesty instrument.
- **Impossible-state flashes:** bulkbar/listhead swap is synchronous (no
  both-visible frame); skeleton only on cold start; no both-hidden pane
  state reachable (empty states cover zero-count).

---

## 18. CROSS-COMPONENT STATE COUPLING

| Coupling | Mechanism | Verdict |
|---|---|---|
| surfaces → shell | ctx callbacks ONLY | clean seam (pinned by architecture tests) |
| shell → surfaces | wire* injection + render calls | clean |
| sibling surfaces | NONE directly — always via shell/store | clean |
| reader → timetable | one-way data query (timetableEffectsOf) | declared, acyclic |
| list → rails | insertLaneHeaders (fragment transform) | one-way |
| sidebar → list | setCount/collapseThreads imports | one-way, agreement pinned |
| bulk → list | renderedIdsOf/nodeByIdOf accessors | accessors, not reach-in |
| DOM-query-as-communication | only the $ helpers against known ids | acceptable, layout-contract pinned |
| shared mutable objects | `state` + `el` (shell-owned, passed by ref) | documented, getter-guarded where reassigned |

**No parent-reaching into child internals, no sibling globals, no event-bus
spaghetti.** The layer stack is the closest thing to a bus and it is typed,
tested, and LIFO-ordered.

---

## 19. CONTEXT ACROSS THE INFORMATION ARCHITECTURE (per surface)

| Surface | Context needed | Source | If it became a separate page |
|---|---|---|---|
| Mail list/reader | store, query, category, selection, selected | shell state + Store | already self-contained; nothing to split |
| Timetable workspace | timetable state, findings, catalogue, enrolment | own module + storage | already a workspace (r54); needs nothing from mail except the provenance link |
| Settings page | schema, backup registry | settings + registry | already separate |
| Compose | draft, contacts, templates, signature | own module + settings | stays panel-over-mail (mail context visible is the point) |
| Rails | store subsets, outbox, snoozed | derived | must stay IN the sidebar (they are glances, not destinations) |
| Palette | everything addressable | ctx | stays overlay |

**The round-56 verdict holds at the state level:** every surface's context
needs are already cleanly sourced; the two workspaces have clean ownership;
no proposed separation would strand or duplicate state.

---

## 20. STATE-DRIVEN UI COMPLEXITY

Combination space: selection × reader × search × filter × loading × sync ×
error × compose × workspace. Estimated raw combinations ≈ 2^9 = 512; the
guards collapse it:
- loading ⊗ content: skeleton only cold; busy sweep otherwise (2 states, not 4)
- error states are banners INDEPENDENT of content states (orthogonal by design)
- workspace switch HIDES mail chrome entirely (mail⊗timetable never renders simultaneously)
- compose ⊗ anything: overlay with quieting (one rule covers all)
- selecting ⊗ searching ⊗ scrolled: explicit priority (O3 guards)
**Unhandled combinations:** none reachable found. **Impossible by guard:**
skeleton-over-warm, both-pane-hidden, dual-reader, selection-over-stale-ids.
**Flags that should become machines:** none — the body classes are
projections of machines that already exist (selection, query, compose).

---

## 21. STATE INVARIANTS

| Invariant | Owner | Enforcement | Failure-if-violated | Test |
|---|---|---|---|---|
| ONE render per settled change | store.batch + scheduleRender | THE ONE RULE | render storms | integration perf pins |
| renderedIds ≡ nodeById snapshot | list.js | cleared together via resetView/clearRows only | sign-out render bug (historical) | R-2 comment + integration |
| active store crosses as getter | ctx wiring | documented at every wire | captured-store bug (historical, most expensive) | architecture pin + integration |
| selection ⊆ live data | Selection.live() | filters stale ids each render | ghost ticks | selection tests |
| one open conversation | state.selected | single assignment site family | dual reader | integration |
| lastSync advances on success only | refresh | commented rule | false freshness | freshness integration |
| layer stack LIFO; one Esc = one rung | layers.js | stack API | Esc over-shoot | layers tests + Esc ladder pins |
| persisted keys ⊆ registry | registry | sweep test | silent-backup bug class | storage-registry tests |
| undo thunk matches its action | recordUndo | thunk captures snapshots | wrong undo | undo tests |
| outbox never double-dispatches | claims + flag | pinned | duplicate email (worst outcome) | outbox tests |
| settings cache warm before reads | boot order | documented ordering | default-flash | integration boot |
| rules loaded before first ingest | boot order | documented ordering | uncorrected first page | integration boot |

---

## 22. RANKED FINDINGS

### CRITICAL — none.
No state path can corrupt data, lose work, or strand context. The worst-case
paths (stuck send, failed verb, crash) are all visible, named, recoverable.

### MAJOR — none.

### MODERATE
- **W-1 distributed mode truth.** No single read answers "what mode now";
  consumers each read their signal. Safe today, brittle for cross-mode
  features. (§23 N-1 proposes a read-only aggregator.)
- **W-4 single-verb in-flight invisibility.** Optimistic verbs give no
  pending indicator; only rollback/undo make them honest. Bulk has progress;
  singles don't. (§23 N-2 proposes an in-flight registry.)

### MINOR
- **W-3 worker state split is documented in fragments** (cursor/dedupe/token
  vs app memory). Correct architecture, scattered explanation.
- **Outbox rail repaint lag** (round-60 F-2) — Chrome-verdict pending; the
  state itself is consistent, only the projection timing lags.

### OPPORTUNITY
- **N-1 mode aggregator** (below).
- **N-2 in-flight registry** (below).
- **State map as code comments:** the ownership map in §3 could live as a
  header in store.js/app.js for future agents (documentation, not code).

---

## 23. PROPOSED STATE ARCHITECTURE (additive only)

**No rewrite is supported by the evidence.** Two additive changes:

### N-1 — Mode aggregator (read-only)
```
current problem:  mode truth is read from 5+ different signals
proposed owner:   a pure derivation in the shell:
                  modeOf() → { searching, selecting, composing, reading,
                               scrolled, workspace, degraded, offline }
affected modules: none mutated — consumers OPT IN to reading it
migration:        add the function; convert nothing initially; future
                  cross-mode features consume it
risk:             ~0 (pure derivation)
benefit:          W-1 becomes inspectable; future mode features have one
                  source to read
```

### N-2 — In-flight registry (visible async truth)
```
current problem:  single verbs are optimistically silent about in-flightness
proposed owner:   a Map<id, verb> beside the optimistic protocol; the list
                  row gains a subtle in-flight mark while the verb is
                  unresolved; cleared on ack/rollback
affected modules: app.js optimistic/flagAction + list.js row render
migration:        additive; existing rollback/undo untouched
risk:             low (projection only)
benefit:          W-4 closes; UI truth matches operation truth for singles
                  as it already does for bulk
```

Both follow the project's own pattern: derive, project, never duplicate.

---

## 24. COMPLETE STATE & CONTEXT MAPS

### A. Global state architecture
```
RUNTIME
├── SHELL STATE      state{} · stores · mailboxState · rules · overrides ·
│                    followups · enrolment · automationRules · opEpoch
├── NAVIGATION       mailbox · category · query (+ listquery readout)
├── WORKSPACE        #panes visible ⇄ #tt-workspace visible (+ Esc rung)
├── TASK STATE       selection · openPart · draft · in-flight verbs ·
│                    outbox queue · undoStack
├── UI STATE         body classes · hidden attrs · layer stack · focus
├── ASYNC STATE      bodyToken · markReadTimer · outboxTimer · probe timer ·
│                    autoRefresh · goPending(TTL)
└── PERSISTED        registry keys (settings 13 + domain 19) + worker keys
```

### B–I. Maps by name (actual symbols)
```
OWNERSHIP     Store←batch · state←shell handlers · Selection←bulk paths ·
              outbox←enqueue/cancel/pump · settings←set API · layer stack
DEPENDENCY    query+category+rules+threads→visibleIds→renderedIds→selection
              →bulkbar; store→counts(sidebar≡listhead); overrides→dueAtOf
CONTEXT       scrollMemory(preQuery/pendingRestore/readPosition) ·
              draft-store · state.query survival · selection reapply
MACHINES      outbox HELD→SENDING→SENT/RETRYING→STUCK · sync
              IDLE→LOADING→SETTLED/RESYNC/DEGRADED · compose
              EMPTY→DIRTY→QUEUED · layers LIFO
PERSISTENCE   runtime→typed/JSON→storage→degrade-to-empty rehydration;
              settings FIRST ordering
ASYNC         opEpoch · bodyToken · claims · grace-cancel · batch→rAF
UI SYNC       state→batch→notify→rAF→DOM (DOM never authoritative but
              scrollTop)
CROSS-COMP    ctx seams · one-way imports · layer stack bus
```

---

## EXECUTIVE SUMMARY (for the next agent)

The state layer is the healthiest of the three audited layers, because every
historical state failure was paid for and then made structural: one Store
per mailbox mutated only through `batch()`; one render per settled change;
the active store crosses seams only as a getter; storage has a registry with
backup derivation; test isolation has a reset registry. Single-source-of-
truth holds for every concept; every duplication is a projection or a
reconciled derivation; no circular state dependencies; every async edge has a
named staleness guard; every context loss is an intentional, documented
decision.

Two moderate weaknesses remain, both with cheap additive fixes (N-1 mode
aggregator, N-2 in-flight registry) and neither blocks anything. The
round-56 conclusion survives at the state level: **the architecture needs no
redesign — the remaining work is projection and visibility, not structure.**
