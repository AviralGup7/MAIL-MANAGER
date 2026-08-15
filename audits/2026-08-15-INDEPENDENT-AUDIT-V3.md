# Independent System-Wide Audit — V3 · 2026-08-15

An outside, evidence-driven audit of **BITS Mail Manager** at commit `ac0cbf2`
(`audit P3: counters where there were none; open-mail follows the account`),
performed from a clean clone, working tree clean, `origin/main` in sync.

**House rule restated.** This audit trusts nothing it did not re-read or re-run.
Prior audits, comments and documentation were treated as hypotheses; where a
comment and the code disagreed, the code won and the discrepancy is listed
(F5, F2). Every claim below carries the command or reading that produced it.

---

## 0 · Method

Environment: Node v20.20.2, npm 10.8.2, Python 3.13, git 2.47.

- **Baseline** — `git status` clean, `main` == `origin/main` at `ac0cbf2`;
  6 remote branches, 4 dependabot PRs + 1 `copilot/check-gmail-features`
  branch unmerged (see F8).
- **Dynamic evidence (run in this session):**
  - `npm run test:unit` → **266/266 pass, 0 skip, 2.8s**
  - `npm test` (the documented full command) → **1906 pass / 1 FAIL** — the
    failure is `app.integration.test.mjs` aborting with
    `FATAL ERROR: … JavaScript heap out of memory` at the 1 400 MB cap
    (F1, §M).
  - `node --test architecture + secrets + storage-registry + worker-dispatch
    + reset-registry` → **20/20 pass** (0 cycles, secret scan clean, registry
    census clean).
  - `npm run types` (tsc checkJs) → **pass**, 0 errors.
  - `npm run contrast` → **all 7 themes pass WCAG AA** (incl. AAA
    High Contrast).
  - `npm run bench` → classify 2000: **11.1ms** · store 2000: **33.2ms** ·
    100 searches: **21.2ms** · renders triggered: **1**.
  - `npm audit --audit-level=high` → **0 vulnerabilities**.
- **Static scans:** `eval(` / `new Function` / `document.write` /
  `insertAdjacentHTML` / `outerHTML` in `src/` → **zero hits**. `innerHTML` →
  9 uses, all read and all static markup or the sanitised `out.innerHTML`
  (E-2). `TODO|FIXME|HACK|XXX` in `src/` → 2 hits, both cross-reference labels
  in comments, not debt. Live-credential scan (`ghp_`, `GOCSPX-`, `client_secret`,
  `ya29.`) → **no live credentials anywhere**; hits are documentation of the
  v1 incident, test doubles, and the guard that polices them.
- **Close reading** of the trust-critical path: `auth.js`, `gmail.js`,
  `sync.js`, `background/index.js`, `mime.js`, `sanitize.js`,
  `takeover/content.js`, `fallback.js`, `platform/storage.js`, `platform/idb.js`,
  `store.js`, `cache.js`, `outbox.js`, `query.js`, `reader.js`, `main.js`
  (boot/bridge/send/teardown), `bulk.js`, `deep-links.js`, `snooze.js`,
  `backup.js`, `direct.js`, `notify.js`, `diag.js`, `tab-pick.js`, the manifest,
  `app.html`, `options.html`, and the CI workflow.

**Stated limitation (unchanged from every prior audit, still true):** no live
browser was run against a real Gmail inbox in this audit. Everything that
crosses the browser seam — the actual MV3 eviction cadence, Gmail's live
history semantics, a real screen reader — is scored with that cap (§S).

---

## 1 · Scorecard — every way, scored 1–10

| # | Way | Score | Evidence at `ac0cbf2` |
|---|---|---|---|
| 1 | Security architecture (incl. XSS/CSP/threat model) | **9** | Token never enters the mail-rendering document (worker router; fallback keeps it on the extension origin). Router rejects any sender whose id ≠ this extension. Embed provenance nonce; `Alt+Shift+M` gated on `isTrusted`. Sandboxed srcdoc iframe (`allow-popups` only — `allow-scripts`/`allow-same-origin` forbidden), CSP derived from the sanitiser's own decision, allow-list DOM-walk sanitiser, per-property CSS filter, `data:image/svg+xml` excluded, remote images blocked by default. Header injection closed by *reconstruction from validated tokens*. Minor deductions: `window.open(...,'_blank')` without `noopener` (F4); the last point needs a live adversarial pass. |
| 2 | Auth & credential hygiene | **9** | Implicit flow argued honestly (no secret to leak); token in `chrome.storage.session` (local fallback documented); session-epoch guard so a sign-out can never be overwritten by an in-flight renewal (reproduced in a test); server-side revoke on sign-out; single-flighted renewal; 401 → renew-once with revoked-vs-transient taxonomy; six setup errors each carry their remedy; zero shipped secrets enforced by a test; per-user OAuth client. The remaining point is Google's platform (implicit flow), not this code. |
| 3 | Correctness & data integrity | **9** | Sync cursor read *before* list, advanced *only after* every history page drains and every add is fetched; `reduceHistory`'s ordered fate-map makes add/remove disjoint by construction; overflow and expired cursors degrade to resync, never to silent loss; a batch whose parts all died throws rather than painting an empty inbox; store order survives date drift (both `upsert` and `patch` reposition); outbox crash semantics demote `sending`→visible `failed`, never a blind re-send; backup import is per-key with a dry-run preview. Minor: unbatched-eviction notification gap in `Store.upsert` (F6, latent — no caller triggers it). |
| 4 | Gmail API integration (sync & send) | **9** | Two round trips per 100 messages via a real multipart batch; metadata header allow-list; per-fetch 30s abort budget; retry honours `Retry-After`, distinguishes quota-403 from permission-403 *by body text*, never retries 401; batch parser now validates response ids against the request whitelist (AUD-Q2 closed); preserved draft attachments hydrate at the wire and a lost one throws to a retryable outbox failure; draft lookup paginates with a cap. Minor: `parseBatch` boundary sniff remains heuristic (a tolerance trade, documented). |
| 5 | MV3 lifecycle & concurrency | **9** | No `setInterval` anywhere in the worker; the only two `setTimeout`s are a retry backoff sleep and a 60s renewal-retry that is *backstopped by a one-shot alarm* (AUD-M4 closed). Durable scheduling rides `chrome.alarms` (wake, 15-min sync, auth-retry); catch-up sweeps run on `onStartup` **and** `onInstalled` so a missed alarm is a late delivery, not a loss. Outbox cross-tab double-send is closed by per-item claims + a pump lock with settle-and-verify; notify dedupe single-flighted. Minor: one unguarded `chrome.commands.getAll()` in the startup self-check (F7). |
| 6 | Storage architecture & data model | **9** | One storage registry (the census the backup allow-list is derived from — a fictional key can no longer ship); backup is allow-list + explicit never-export list + versioned envelope + dry-run preview; message cache is versioned, row-tolerant, idle-coalesced, bounded; every loader degrades to empty rather than throwing; an IndexedDB adapter exists behind the seam with a measured parity contract (no consumer yet — F9). Minor: 47 direct `chrome.storage` touches outside the seam (F9). |
| 7 | Performance | **9** | One render per settled state (bench: 1 render for 2000 upserts); incremental indexes, binary-search insertion, memoised derived reads; bodies lazy; metadata-only batches; idle-deferred cache writes; no rAF loops, no polling, no MutationObserver in the app; render bench is a hard CI gate with named soft/hard exit codes (prior F2 closed). Minor: prefix search scans the whole vocabulary (bounded by the 2000 cap — 21ms/100 searches), and the list is still full-DOM (the project's own declared debt). |
| 8 | Privacy & least privilege | **9** | Exactly two scopes, each tied to a shipped feature; per-user OAuth project (no embedded client to abuse); no telemetry of any kind (verified by scan); remote images blocked by default — stronger than Gmail's proxy; notification cards control-char-scrubbed and length-capped on sender **and** subject; sign-out and `ACCOUNT_CHANGED` clear account-scoped state (historyId, notified-ids, label cache); host permission instead of `tabs`; `web_accessible_resources` narrowed to `app.html`. The last point needs a live-profile persistence check (§S). |
| 9 | Accessibility | **8** | axe-core runs in CI on the booted DOM; every theme×surface pair contrast-gated at AA with a AAA theme; hidden-vs-display assertions; listbox + `aria-activedescendant`; focus restoration and reduced-motion (including delays) tested; the takeover inerts Gmail so its dialogs can't steal focus; icon buttons carry names; live regions present. Honest caps: no screen reader has ever run against it (TODO #10), and the harness's headless AX-tree absence is a known artifact. |
| 10 | UX & product completeness | **9** | Full mail lifecycle verb-tested (7 mailboxes, threading + strip, spam report *and* rescue, trash restore, undo-everything incl. send, snooze with catch-up, crash-surviving drafts, 20-operator search with a labelled server fallback, bulk with per-chunk reconcile, rule dry-run, backup, activity log). Honest empty/error/offline states everywhere. Deductions: `options.html` tells the user the build "cannot send mail" (F2) and a theme switch silently re-blocks images the user chose to show (F3). |
| 11 | Visual design & responsiveness | **9** | Themes are data, which is what makes the contrast gate possible (its first run caught the *main text colour* failing AA); tokenised CSS with a literal-bypass test; measured breakpoint ladder (R-A fixes shipped); 64-image screenshot matrix committed; reduced-motion respected. Self-authored design held to engineering rigour — not yet externally critiqued taste. |
| 12 | Resilience & degraded-mode design | **10** | The quiet masterpiece. In-page fallback keeps the extension a full mail client when the worker won't register, with verb-for-verb parity, the same MIME parser, the same chunking and label-cache laws, and an honest probe with recovery. Alarms are nudges with catch-up sweeps. The outbox survives crashes, tabs, and now account switches. Degraded mode is a *state*, not a verdict — the worker is re-probed and recovered. The single cap: it exists because of one still-unexplained production failure (§S). |
| 13 | Testing & verification | **8** | Breadth is exceptional: 1 898 declared tests across 131 files; fuzz suites per parser; property-style pins per state machine; cross-tab race reproductions; CI shards 8-way with a verdict job, self-integrity, docs-gate, contrast gate, typecheck, bench, and browser smoke with failure-artifact upload. The deduction is real and new: **the documented local command `npm test` fails out of the box** — the integration file OOMs the 1 400 MB cap (F1). CI's sharding masks a regression that any new contributor hits immediately. |
| 14 | Maintainability & documentation | **9** | Comments are decision records (the rejected alternative, why the weaker fix failed, what was measured); registries (storage, reset) keep structure true; zero TODO rot in `src/`; `git blame` lands on reasons, not shrugs. Deductions: one stale comment (`Store.tokenize` — F5) and one user-facing stale claim (`options.html` — F2); `app.js` is still the 3 842-line control tower (12.5% of `src/`, down from 27%). |
| 15 | Release/CI & repo hygiene | **8** | Sharded CI with a real aggregate verdict; pinned action SHAs; concurrency cancellation; failure artifacts; generated-file no-op regeneration gate; `push.sh` solves a measured network problem and redacts tokens; the `.gitignore` documents the v1 secret incident. Deductions: **no LICENSE file** (F8a); four dependabot PRs and one investigation branch unmerged; `jsdom` `^24` in the lockfile while a `jsdom-30` bump sits unmerged (F8b); the PAT-in-chat pattern from prior audit F1 has now recurred a third time (F8c, §S). |

**Unweighted mean: 133 / 15 = 8.87.**
**Weighted toward the ways this project itself ranks first** (security ×2,
correctness ×2, auth ×1.5, sync ×1.5, testing ×1.5): **164 / 18.5 = 8.86.**

> **Comprehensive rating: 8.9 / 10** — unchanged from the prior 8.8 at round 63
> in the mean, but on strictly stronger ground: the two CRITICAL account-identity
> findings that dominated the 2026-08-15 audit are closed and pinned (C-1), and
> the deduction that moved from 10 → 8 in *testing* is a new, concrete,
> one-line-to-reproduce regression (`npm test` OOMs), not a philosophical gap.

---

## A · Executive risk summary

The codebase is in the healthiest state this series of audits has recorded.
The two CRITICAL findings of the previous system-wide audit — **AUD-C1** (silent
OAuth renewal follows the browser's current account, no identity check) and
**AUD-C2** (outbox unscoped and uncleared at sign-out) — are both fixed at
HEAD, with regression tests:

- `auth.js` now stamps `accountEmail` at sign-in, validates **every** silent
  renewal against it, treats only a *proved* mismatch as destructive, clears
  the session set, and throws `ACCOUNT_CHANGED`, which the worker router, the
  in-page fallback, and the app surface all handle with a one-time teardown.
- The outbox stamps records with their owner's `accountEmail`, the pump
  refuses a stamped record under any other account (`dispatchable`,
  `wrongAccount`), and sign-out clears the queue behind the
  `clearOutboxOnSignOut` preference (default ON).

**What remains is a short tail of LOW/MEDIUM items** (table C): one local
test-suite OOM (MEDIUM), two stale user-facing texts (LOW), two trivial code
hygiene gaps (LOW/INFO), one latent store-notification edge (LOW), and a set
of roadmap/verification items that were already on the project's own books.

**No new CRITICAL or HIGH defect was found in this audit.**

---

## B · Architecture map (from code, not docs)

```
Gmail tab(s) ──content.js (takeover, nonce'd iframe embed)──> app.html (extension origin)
      │ BMM_TOGGLE / trusted Alt+Shift+M            │ runtime.sendMessage verbs
      ▼                                            ▼
        src/background/index.js  (service worker — deliberately thin)
          ├─ auth.js      implicit-flow OAuth; token in storage.session; account stamp
          ├─ sync.js      cursor pull: syncPage / syncDelta (pure orchestration)
          ├─ gmail.js     REST layer; /batch multipart; retry + 401/403 taxonomy
          ├─ mime.js      payload → displayable body (pure, shared with fallback)
          ├─ notify.js    notification selection + card scrub (pure)
          ├─ diag.js      worker-side counters, flushed on the sweep tick
          └─ alarms:      bmm-wake · bmm-sync (15 min) · bmm-auth-retry (one-shot)
      ▼
app (main.js shell) ── store.js (Map + incremental indexes, notify-once batches)
   ├─ cache.js (500 newest headers, one blob, idle-deferred)      ├─ outbox.js (held→sending→sent/failed; claims + pump lock)
   ├─ body-cache.js (offline body floor)                          ├─ intents.js (offline triage verbs)
   ├─ settings.js (typed schema) → root-attrs.js → themes          ├─ backup.js (allow-list export; storage-registry census)
   └─ fallback.js (in-page verb handler when the worker will not register)
```

Layering law holds: all `chrome.*` access greppable through `src/platform/`;
network only in `src/background/` + the fallback; domain modules
(`classify/`, `outbox.js`, `rules.js`, `snooze.js`, `query.js`) are chrome-free
and run in both worker and jsdom. The one deliberate exception — `fallback.js`
re-exposing worker verbs in-page — is documented, UI-flagged, and
account-identity-correct.

---

## C · Complete findings table

| ID | Sev | Conf | Category / subsystem | File : symbol | One line |
|---|---|---|---|---|---|
| V3-F1 | **MEDIUM** | CONFIRMED | Test quality / DX | `test/app.integration.test.mjs`, `package.json` (`test` script) | `npm test` OOMs the 1 400 MB cap; the documented local command fails out of the box |
| V3-F2 | LOW | CONFIRMED | Docs ↔ product | `options.html:162-163` | Setup page says the build "cannot send mail" and requests `gmail.modify` only; it sends and requests `gmail.send` |
| V3-F3 | LOW | CONFIRMED | UX / reader | `reader.js:repaintBody`, `main.js:2561` | Theme switch re-renders the body with `allowRemote=false`, silently re-blocking images the user chose to show |
| V3-F4 | LOW | CONFIRMED | Security / app chrome | `list.js:1116` | `window.open(...,'_blank')` without `noopener`; opener reference left to the target tab |
| V3-F5 | INFO | CONFIRMED | Maintainability | `store.js:tokenize` | Docstring says "subject and sender only"; the index includes `snippet` |
| V3-F6 | LOW | CONFIRMED (latent) | Data integrity / store | `store.js:upsert` | Eviction after an unbatched upsert mutates indexes without a notification/`_version` bump (no current caller triggers it) |
| V3-F7 | INFO | CONFIRMED | MV3 / worker | `background/index.js` (onInstalled) | `chrome.commands.getAll()` not optional-chained, unlike every sibling guard |
| V3-F8a | LOW | CONFIRMED | Repo hygiene | repo root | No LICENSE file |
| V3-F8b | LOW | CONFIRMED | Repo hygiene | `package-lock.json`, dependabot branches | `jsdom` `^24` in lockfile; `jsdom-30` bump + 3 more dependabot PRs unmerged |
| V3-F8c | INFO | CONFIRMED | Process | (this audit's commission) | A live GitHub PAT was pasted into chat a third time — the prior audit's F1 class, recurring |
| V3-F9 | INFO | CONFIRMED | Maintainability / platform | 16 files outside `platform/` | 47 direct `chrome.storage` touches despite the seam doctrine (ARCH R-7); the IDB adapter has no consumer yet |

**Verified clean in this audit (not re-reported):** the prior AUD-C1/C2,
AUD-M1…M4, AUD-L1…L3, AUD-Q1/Q2 are closed at HEAD (see §D–I). No new
CRITICAL/HIGH.

---

## D · Critical correctness findings

**D-1 (verified clean):** the sync cursor cannot advance past unfetched work.
`syncPage` reads the anchor *before* listing; `syncDelta` writes the cursor
only after every history page is drained and every add is batched; overflow
(>500 adds, >10 pages) and a 404 on the startHistoryId degrade to `resync`,
which removes the cursor and forces a full pass. Failure at any `await` leaves
the cursor stale — which loses nothing (upsert is idempotent, replay is free).

**D-2 (verified clean):** `reduceHistory` folds chronology into one ordered
Map so `added` and `removed` are disjoint by construction; `labelsAdded/Removed`
transitions (INBOX gain/loss, TRASH, SPAM, UNREAD, STARRED) are honoured, and
a message that is added-then-archived within one history window nets to
`remove`.

**D-3 (verified clean):** store ordering survives date drift — both `upsert`
and `patch` reposition a moved date (the binary-search insert requires a
sorted array; a single stale entry used to corrupt the whole order, and it is
now structurally impossible because ingest dates are finite-or-0 at the trust
boundary, `toEpoch`).

**D-4 (verified clean):** the outbox cannot double-send from two tabs. Per-item
claims and a per-window pump lock use a settle-and-verify protocol over shared
storage (no compare-and-set exists); the loser stands down; removals are
read-modify-write verified with retries; claims are garbage-collected; TTL is
the crash backstop; a crash-interrupted `sending` demotes to a visible,
cancellable `failed` rather than re-sending.

**D-5 (V3-F6, latent):** `Store.upsert` for a *new* message calls
`_touch(id, structural)` and then `_evictIfNeeded()`. At batch depth 0, the
touch flushes immediately, so an eviction performed afterwards mutates
`byId`/`order`/indexes and sets `_structuralChange` with **no subscriber
notification and no `_version` bump**. Every current caller wraps upserts in
`batch()` (`upsertMany`, `bulk.js` restore paths), so the evicted row is
invisible to nobody *today* — but the class is real: "no caller does X is not
an invariant, it is a coincidence" (the project's own words, from the
`patch()` fix). *Preferred fix:* evict before touch, or have eviction touch the
evicted ids. *Regression test:* unbatched `upsert` at the cap asserts a
notification with the evicted id and a `_version` bump.

---

## E · Security findings

**E-1 (positive):** header injection at the wire is closed by *reconstruction,
not patching* — `safeAddressHeader`/`safeIdHeader`/`safeSubject`/`safeFilename`
rebuild headers from validated tokens, and the comments document why the two
weaker fixes ("delete the line break", "replace it with a space") were wrong.
`buildMime` was re-read line by line; no interpolation path bypasses the gate.

**E-2 (positive):** the sanitiser is a parse-and-walk allow-list
(`sanitize.js`); the primary control is the sandboxed iframe with no
`allow-scripts` and no `allow-same-origin`; `data:image/svg+xml` excluded; CSS
filtered to a property allow-list without `url()`/`expression()`; both tree
walkers depth-bounded; remote images default off with a per-sender opt-in.
The 9 `innerHTML` uses are static markup (skeleton, row shell, `&times;`) or
`out.innerHTML` after sanitisation.

**E-3 (positive):** the token never enters a document that renders untrusted
mail; CSP is `script-src 'self'; object-src 'none'` with a two-endpoint
`connect-src`; no eval/Function anywhere; the router refuses non-extension
senders; the web-accessible `app.html` requires an embed nonce to boot and the
content script handshake requires it back; `Alt+Shift+M` requires a trusted
event.

**E-4 (positive):** the AUD-C1 account-identity tripwire is real and pinned —
`fetchAccountEmail` throws on any failure (so "couldn't check" is transient,
never treated as "account changed"), only a *proved* mismatch clears state,
and the fresh token is deliberately not persisted for an account the user
never consented to here.

**E-5 (V3-F4):** `list.js:1116` — `window.open(ctx.gmailUrl(id), '_blank')`
without `noopener`. The target is `mail.google.com` (the URL is built from a
validated account index and a Gmail thread id — no open-redirect), so this is
defence-in-depth, not an open hole: the opened tab retains `window.opener` to
the extension page. `noopener` costs nothing. Same class: audit the app's own
anchor `el.rOpen.href` (which gets `target="_blank"` from the shell) for a
`rel` the way the sanitiser already enforces on mail content.

---

## F · Data-integrity findings

**F-1 (verified clean):** storage is governed by one registry
(`storage-registry.js`) whose census is enforced by a test; the backup
allow-list is *derived* from it, so a new key cannot be silently exported or
silently skipped. The never-export list names keys that actually exist (the
old `messageCache` fiction is gone).

**F-2 (verified clean):** every loader is corruption-tolerant — `loadCache`
skips malformed rows individually and requires a finite date;
`normaliseOutbox` demotes unknown states to visible `failed` and re-anchors a
corrupt `releaseAt` to the hold (so a restart can never skip the undo window);
`loadTimetable`/`loadSnoozed`/`prime(intents)` degrade to empty rather than
throw into a click handler or a boot.

**F-3 (verified clean):** the cache packs a versioned, flags-byte row with
recipient-dependent fields persisted (audience, to/cc, list headers, courses)
so a warm start cannot mis-answer `is:direct` or the lanes — the prior
cache-round-trip bug class is closed and pinned.

**F-4 (V3-F6):** see D-5 (store eviction notification, latent).

---

## G · MV3 lifecycle findings

**G-1 (verified clean):** no `setInterval` in the worker. The two worker
`setTimeout`s are: the retry backoff `sleep` (bounded, inside fetch loops) and
auth's 60s renewal retry, which is now *backstopped by a one-shot alarm*
(`bmm-auth-retry`, `runAuthRetry`) precisely because timers die with a
suspended worker. `'online'` is registered as best-effort only; the alarm is
the wake channel.

**G-2 (verified clean):** durable scheduling rides `chrome.alarms` — snooze
wake re-aims one alarm at the next instant (`nextWakeAt`, finite-guarded),
the 15-minute sweep advances the history cursor while closed, and both
`onStartup` and `onInstalled` run catch-up sweeps (a missed alarm is a late
delivery, never a loss).

**G-3 (verified clean):** listeners register synchronously at module load;
`chrome.action`/`chrome.commands` are optional-chained so a missing key costs
the capability, not the whole worker; `onMessage` returns `true` and resolves
exactly once; the worker keeps **no** message state (the store lives in the
app; only `historyId`, the dedupe list, and the label-id cache persist, and
all three are account-scoped and cleared with the session).

**G-4 (V3-F7, INFO):** the `onInstalled` self-check calls
`chrome.commands.getAll()` unguarded while the same file guards
`chrome.commands?.onCommand` — inconsistent with the file's own doctrine. If
`commands` were ever absent from the manifest, this async listener would throw
an unhandled rejection. One `?.` closes it.

---

## H · Gmail/API findings

**H-1 (verified clean):** batch construction is correct (multipart/mixed,
`Content-ID: <bmm-i>`, `format=metadata` + explicit header allow-list); the
parser tolerates header-casing/line-ending drift by design, drops non-2xx and
malformed parts individually, and — since AUD-Q2 — **filters parsed parts
through the requested-id whitelist before `normalise`**, so a phantom part can
no longer enter the canonical store. A batch whose parts *all* died throws,
never reads as an empty inbox.

**H-2 (verified clean):** 401 reaches `api()` intact (the renew-once path is
live, not dead code); a fresh-token 401 throws the canonical `AUTH_REVOKED`
instead of returning an error body callers could read `.messages || []` on;
429/5xx retry with `Retry-After` honoured and jitter; 403 is retried **only**
for quota bodies.

**H-3 (verified clean):** history pagination is not optional — the cursor
advances only after the full drain, and >10 pages degrade to resync; `404` on
the startHistoryId is `tooOld` → cursor removed → full resync; `historyId` is
never sent as a placeholder.

**H-4 (verified clean):** `hydrateDraftAttachments` classifies a lost
attachment (Gmail 4xx) as permanent-stuck and a network/5xx as retryable, so
the outbox neither loops a dead part nor sends a message silently missing its
files.

---

## I · Sync findings

**I-1 (verified clean):** the inbox alone moves the cursor
(`anchorHistory:false` for Sent/Trash/etc.), so browsing a non-inbox mailbox
cannot advance the cursor past unfetched inbox changes.

**I-2 (verified clean):** the AUD-M1 snooze-empty-page bug is closed — only
"Could not create the label" is an honest empty; every other label-resolution
failure propagates so the caller keeps its cached page instead of upserting
an empty truth.

**I-3 (verified clean):** the background sweep is single-flighted
(`bgSyncRunning`) and the notify dedupe is a pure, capped, duplicate-free
merge (`mergeNotified`), so overlapped 15-minute runs can no longer notify
twice or corrupt the dedupe list.

**I-4 (note, INFO):** `syncPage` and `syncDelta` can overlap (a refresh while
a delta is in flight); both write `historyId` last-writer-wins. Because the
delta writes Gmail's *current* id and the page writes a possibly-earlier
anchor, the cursor can move **backward** — which costs a replay, never a loss
(upsert is idempotent; "stale loses nothing; too-new loses mail irrecoverably"
is the design's own asymmetry). Not a defect; worth a comment at both call
sites so a future reader does not mistake it for one.

---

## J · Storage / EmailStore findings

**J-1 (verified clean):** indexes are incremental (byCategory, byThread,
searchIndex) with empty-Set cleanup; reads return copies (`idsFor` aliasing
bug is fixed and documented); derived reads are memoised per `_version` with
wholesale invalidation on flush; `fromSearch` records are render-only citizens
and never move the rail's truth.

**J-2 (verified clean):** `patch` reindexes only on category/text changes and
delegates a moved date to `upsert` (one implementation of "a date moved");
`remove` deindexes all secondary indexes.

**J-3 (V3-F5, INFO):** `Store.tokenize`'s docstring ("Subject and sender only")
contradicts the implementation, which includes `snippet` — and `patch()`
correctly documents the snippet inclusion. Trivial, but exactly the
"comment contradicts implementation" class the brief asks to find.

**J-4 (V3-F9, INFO):** 16 modules still touch `chrome.storage` directly
(default parameters, the worker's key set) rather than through the seam. It is
greppable and each use is deliberate, but the seam's own header promises
"one module that owns `chrome.*` access"; the drift is real and cheap to close.

**J-5 (INFO):** `platform/idb.js` is a measured, contract-parity adapter with
**no consumer**. It is honest about its boundary (no `onChanged`, no quota
management) and lands behind the seam; the decision to migrate the body floor
is the open G2 milestone. This is roadmap, not debt.

---

## K · UX / accessibility findings

**K-1 (V3-F2):** `options.html` still says *"Scope requested: gmail.modify
only … this build cannot send mail, so it does not ask"*. The build sends
mail (compose, reply, forward, undo-send, outbox) and `auth.js` requests
`gmail.modify gmail.send` — the scope was added by V2 C-01 *because* the UI
sends. A user configuring a client ID is told the consent screen will ask for
less than it will. Fix the two lines; a one-line pin in the existing docs gate
(`check-docs.mjs`) keeps it true.

**K-2 (V3-F3):** theme switch re-blocks remote images. `setTheme` →
`repaintBody` → `renderBody(lastBody)` with the default `allowRemote=false`,
bypassing `renderBodyInto`, which owns the policy (setting `always`, or the
per-sender allow-list, or a clicked "Show images"). After any theme change the
images disappear again and the `r-images` offer bar is not recomputed.
*Preferred fix:* route repaint through `renderBodyInto(body, lastAllowRemote)`
and re-run the bar logic; *test:* render with `allowRemote`, repaint, assert
`src` (not `data-bmm-src`) survives.

**K-3 (positive):** honest states are the strongest surface — six empty-state
branches including one that refuses to say "all caught up" when a mute rule hid
the mail; offline body copies are labelled with a provenance strip; server
search results are announced rather than silently mixed; degraded mode is
flagged and recovers with a toast.

**K-4 (positive, capped):** axe runs in CI; contrast gated; semantics tested.
Still unverified against a real screen reader (TODO #10) — the headless AX-tree
absence is a known artifact of the harness.

---

## L · Performance findings

**L-1 (positive, measured):** classify 2000 → 11.1ms; store 2000 → 33.2ms;
100 searches → 21.2ms; one render for a 2000-message batch. No polling,
no rAF loops, no MutationObserver in the app; cache writes are idle-deferred
and coalesced.

**L-2 (INFO):** `Store.search` resolves ≥3-char terms by scanning the whole
vocabulary for prefix hits — O(vocabulary) per keystroke. Bounded by the
2000-message cap in practice (bench confirms), but it is the one spot where a
larger mailbox would bite first, and it is the natural place a
windowed/IndexedDB future (G2) must revisit.

**L-3 (INFO):** the list is still full-DOM (the project's own declared debt);
`CACHE_MAX` 500 and the 10MB budget keep the cache shallow. No windowing yet.

---

## M · Test-quality findings

**M-1 (V3-F1, the one real regression):** `npm test` — the command README and
CONTRIBUTING tell a contributor to run — **fails with an out-of-memory abort**:
`node --max-old-space-size=1400 --test test/` reaches
`FATAL ERROR: … heap out of memory` inside `app.integration.test.mjs`
(1906/1907 otherwise). Root cause by reading: the harness re-imports `app.js`
per boot with a **cache-busting URL**, so Node's ESM loader caches a distinct,
complete app-module graph for every one of the ~60 jsdom boots, and the
cumulative heap exceeds the 1 400 MB cap in a single process. CI hides it by
sharding 8 ways. *Preferred fix:* (a) raise the local cap (e.g. 3000) for the
one-command entry point, **and** (b) freeze the module identity (import once,
reset through the existing reset-registry — which was built exactly for
cross-boot state) so the suite's memory stops growing with its length.
*Regression test:* the file passes under the default cap, or CI runs an
unsharded smoke of the worst file.

**M-2 (positive):** the breadth is real — fuzz suites per parser, property-style
pins per state machine, cross-tab race reproductions (outbox), contract tests
for the worker verbs, a11y, contrast, structure, secrets, and CI's own
self-integrity. Tests assert behaviour, not internals, and skip-proofing is
enforced (`test:ci` fails on skips).

**M-3 (gap, carried over):** no live-browser/Gmail test, no real
screen-reader pass, classifier accuracy against real BITS mail unmeasured.
These are the project's own TODO #1/#10 and are in §S.

---

## N · Maintainability findings

**N-1 (positive):** comments are decision records; registries keep structure
true; no TODO rot in `src/`; a 1:1 test-to-source ratio.

**N-2 (V3-F5):** one stale comment (`tokenize`) — see J-3.

**N-3 (INFO):** `app.js` remains the 3 842-line control tower with 47 imports.
The project's own house rule is "do not rewrite; extract proven tenants" and
the reader/list/bulk/outbox/fallback extractions show the discipline works;
the remaining shell is the render loop and the verb bridge, which is a
coherent, if large, responsibility.

---

## O · Release / migration findings

**O-1 (positive):** the cache schema is versioned with per-field widening that
degrades and self-corrects; settings are schema-typed with coercion; backup is
versioned with a refuse-newer rule; migrations are effectively "discard and
resync" for derived state (safe by design because Gmail is the source of
truth).

**O-2 (V3-F8a):** **no LICENSE file.** For a public repository this is a
material omission (others cannot legally reuse it, and the author's own
intent is unstated). Low engineering risk, but it should not wait.

**O-3 (V3-F8b):** four dependabot PRs and one `copilot/check-gmail-features`
branch sit unmerged; `jsdom` is `^24.0.0` (installed 24.1.3) while the
`jsdom-30` bump is proposed. Not drift *within* the lockfile, but the queue of
unreviewed dependency/feature branches is growing.

---

## P · Recovery & observability findings

**P-1 (positive):** AUD-Q1's diagnostics land here — the worker now counts
requests, retries, notifications, renewals, and mismatch clears, flushed on
the sweep tick with the honest caveat that MV3 loses the current window on
crash. Structured enough to answer "sync felt slow" or "I got two
notifications" from a support conversation.

**P-2 (positive):** recovery is layered — corrupted caches degrade to cold
start; the outbox demotes and surfaces stuck items with a retry affordance; a
stale history cursor forces a resync; a dead worker triggers the in-page
fallback and later recovery; a corrupted backup is refused, never
half-imported.

**P-3 (gap, carried over):** the worker "Status code: 2" registration failure
that motivated the fallback remains unexplained (the probe branch is unmerged).
Recovery is excellent; the *root cause* of the most serious known production
failure is still open.

---

## Q · Improvement opportunities (not caused by current bugs)

1. **Window the list** behind the same honesty invariant (the project's own
   declared debt) — a 100 000-message mailbox is the one scenario the current
   full-DOM design has not met, and the IndexedDB adapter already exists for
   it.
2. **Close the platform seam** (J-4): route the 47 direct `chrome.storage`
   touches through `STORAGE`/injected params so the permission surface is
   truly greppable in one place.
3. **Move the store to `storage`-persisted windowing** only after the list
   windowing is designed; do not couple them.
4. **Add a `LICENSE`** (O-2) and merge-or-close the dependabot queue (O-3).
5. **Instrument the sync cursor** with the diagnostics counters already
   present (add `historyCalls`, `resyncs`) so the replay/resync frequency
   becomes visible.
6. **Unicode-normalise search terms** (NFD→NFC) so accented senders and
   subjects match regardless of composition form — cheap, and mail is
   increasingly multilingual.

---

## R · Recommended phased roadmap

**P0 (hours, zero behaviour risk):**
- F2 — correct the two `options.html` lines + a docs-gate pin.
- F5 — fix the `tokenize` docstring.
- F7 — one `?.` on `chrome.commands.getAll()`.
- F4 — `noopener` on the `window.open`, and audit `el.rOpen` for `rel`.
- F8a — add a LICENSE file.

**P1 (a day, test-quality):**
- F1 — make `npm test` pass locally: raise the heap cap for the entry point
  and freeze the integration harness's module identity via the reset-registry.
- F3 — route theme repaint through `renderBodyInto` and pin it.
- F6 — evict-before-touch in `Store.upsert` + the notification test.

**P2 (a week, hygiene + observability):**
- J-4 — close the platform seam (mechanical, test-covered).
- F8b — merge or close the dependabot queue; land the jsdom bump behind a
  green CI run.
- Q5 — add the sync counters.

**P3 (milestones, the project's own G2/NEXT):**
- List windowing + IndexedDB body floor (the staged adapter's first consumer).
- A real-browser ritual: run the extension against a live inbox for a week,
  then a real NVDA/VoiceOver pass — the two items every score here is capped
  by.

---

## S · Assumptions and unverified items

1. **No live browser run** — every claim that crosses the chrome seam (MV3
   eviction cadence, `launchWebAuthFlow` behaviour in Brave, Gmail's live
   history semantics, notification rendering) is unverified against a real
   profile. This is the project's own TODO #1.
2. **No real screen reader** — accessibility scores rest on axe + structure;
   TODO #10.
3. **Classifier accuracy unmeasured** against real BITS mail — the corrections
   UI is the intended corpus generator.
4. **Worker "Status code: 2" root cause** remains unexplained; the fallback is
   proven, the underlying failure is not.
5. **The `npm test` OOM** (F1) was observed once in this session at the
   1 400 MB cap; the mechanism (ESM cache growth from cache-busted re-imports)
   is a high-confidence reading of the harness code, not a heap-profile.
6. **The service-worker concurrency claims** (alarms dedupe, `storage.session`
   lifetime across restarts) are reasoned from Chrome's documented behaviour
   and the project's tests, not from a live worker.
7. **A live GitHub PAT was pasted into the chat to commission this audit** —
   the third recurrence of the prior audit's F1. Rotate it after this PR lands;
   the repo's own `push.sh` redaction and the `.gitignore` notes exist
   precisely because this keeps happening. This audit used it only to push and
   open the PR, and it is not stored in any file.
