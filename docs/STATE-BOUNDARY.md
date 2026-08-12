# STATE BOUNDARY — worker ≠ app runtime state

**Roadmap M2 (documentation debt, round 62).** The architecture is correct;
this document exists so no future agent "helpfully" unifies what is
deliberately separate.

## The rule

**The service worker and the app page do NOT share runtime state.** They
share STORAGE. Synchronization happens through sync and storage, never
through a shared object, a shared module instance, or a message-passed
reference that is then retained.

```
WORKER (background/index.js)          APP PAGE (app.html → app.js)
├── history cursor    → storage       ├── Store per mailbox (memory)
├── notify dedupe     → storage       ├── UI state (state{}, body classes)
├── auth token        → storage       ├── cache snapshot (memory + disk)
├── alarms (chrome)                   ├── selection, reader, in-flight (memory)
└── outboxPumping flag (memory)       └── layers stack (memory)
        ▲                                       ▲
        └──────── chrome.storage.local ─────────┘
              (the ONLY shared surface; registry in
               src/app/storage-registry.js)
```

## Why it must stay this way

1. **MV3 evicts the worker.** Any runtime state kept only in the worker is
   gone on eviction. Worker state that must survive (cursor, token, dedupe,
   outbox queue) is therefore in storage, and the worker reloads it on every
   wake. A shared in-memory object would silently become stale the moment the
   worker is reclaimed.
2. **The app page is rebuilt on every load.** App runtime state (Store,
   selection, in-flight, layers) is reconstructed from cache + storage at
   boot. Nothing the worker holds is needed to rebuild it, and nothing the
   app holds is needed by the worker between verbs.
3. **Two contexts means two module instances.** `outbox.js` imported by the
   worker and by the page are DIFFERENT instances with different `TAB_ID`s —
   which is exactly what the cross-tab claim protocol relies on (round 62
   M3). Unifying them would destroy the coordination, not improve it.

## What crosses the boundary, and how

| Crossing | Mechanism | Direction |
|---|---|---|
| Verbs (SYNC_PAGE, STAR, BULK, OUTBOX_PUMP…) | `chrome.runtime.sendMessage` → worker `handle()` switch | app → worker, one response each |
| Worker dead | `degradeToFallback`: the page runs the SAME handler table in-page via dynamic import; sticky, probed | app self-degrades |
| Persistent truths (queue, rules, overrides, settings, token, cursor) | chrome.storage.local, keys in the registry | both, storage is the arbiter |
| Settings changed in Options | `storage.onChanged` → `followExternalChanges` | options → app |
| Outbox dispatch coordination across tabs | `outboxClaims` + `outboxPumpLock` in storage (nonce + settle + verify; TTL backstop) | tab ↔ tab via storage |

## Invariants (do not break)

- No message response carries a retained object reference; responses are data.
- Worker memory (`outboxPumping`) is a lock, never a ledger — the ledger is
  the queue in storage.
- App runtime state is never written to storage directly except through the
  registry-owned keys and their owning modules.
- A feature needing "worker + app agreement" gets a storage claim with TTL,
  not a shared variable (see outbox claims for the pattern).

## If you think you need to share runtime state

You almost certainly need one of: a storage key (add it to the registry), a
verb (add it to the worker switch + fallback table in BOTH places), or a
`storage.onChanged` subscription. If none fits, stop and re-read this file.
