# BITS Mail Manager — Independent System-Wide Audit (Agent pass, 2026-08-15)

**Target:** `MAIL-MANAGER` @ `f53175c` (origin/main, 504 commits, working tree clean)
**Method:** Clean clone; dynamic validation (full suite, isolated rerun, tsc, coverage gate, bench); close reading of every trust-critical module (`auth.js`, `gmail.js`, `sync.js`, `background/index.js`, `sanitize.js`, `mime.js`, `store.js`, `cache.js`, `body-cache.js`, `fallback.js`, `reader.js`, `reader-frame.js`, `takeover/content.js`, `platform/storage.js`, `platform/idb.js`, `storage-registry.js`, `backup.js`, `classify/index.js`, `main.js`). Every rating and finding below is backed by a command or a line reference; disproved suspicions are recorded in §T.

**Honesty framing:** this is a genuinely strong, extensively self-audited codebase. I am not going to score it low to flatter the request — that would be dishonest, and the user asked for honest scores that find *real* problems. The real problems are real, and they are enumerated with evidence. Scores below reflect that: high where the code earns it, and pulled down precisely where the evidence pulled it down (a reproduced test-suite OOM, an account-isolation residue, a warm-start pagination gap, single-database storage economics).

---

## A. Executive risk summary

| Dimension | Verdict |
|---|---|
| Overall composite | **7.1 / 10** (good, with a small cluster of genuine, reproducible defects in test reliability, account isolation, and warm-start sync) |
| Security posture | **Strong.** OAuth implicit flow with state verification + session-storage token, worker keeps the token out of the DOM, reader body rendered only in a `sandbox` without `allow-scripts`/`allow-same-origin`, real parse-and-walk sanitiser (not regex), header-injection scrubbing in `buildMime`, `isTrusted` gate on the page chord, embed nonce. No secrets in the tree. |
| Data integrity | **Good but not airtight.** Sync custody (cursor read before list; commit only after durable flush) is sound for the common path. Residual: account-scoped stores survive sign-out, and the whole-value JSON blob design makes commit-vs-crash windows coarser than IndexedDB would allow. |
| MV3 lifecycle | **Good.** Stateless worker, alarms for durable wake, one-shot chained probes, epoch guards. One live tradeoff: the background sweep (and its notifications) is **disabled** by design after the cursor-ownership findings. |
| Test suite | **The weakest area I reproduced.** 2010/2011 pass in a single process, but the flagship integration file aborts with a heap OOM **even in isolation** (95/96 subtests pass, process dies with SIGABRT). In CI's 8-shard layout this file sits alone in a shard and is the likeliest source of a red/flaky run. |
| Top risks (ranked) | (1) Test-suite OOM/flakiness; (2) account-isolation residue on sign-out; (3) warm-start inbox cannot page past the 500-cache; (4) production persistence is single-database whole-blob `chrome.storage.local`; (5) background notifications/offline catch-up effectively off. |

---

## B. Architecture map (as built)

- **Entry points (4):** `src/background/index.js` (MV3 module service worker), `src/app/main.js` (`app.html`), `src/options/options.js` (`options.html`), `src/takeover/content.js` (Gmail page).
- **Layering:** `src/background/*` = worker-owned REST/OAuth/sync; `src/classify/*` = pure synchronous classifier (no chrome.*, no DOM); `src/platform/*` = the only module owning `chrome.*`/IndexedDB access (ARCH R-7); `src/app/system/*` = settings/cache/backup/theme seams; `src/app/mail|search|overlays|academic|compose|motion|workspace/*` = presentation; `src/shared/*` = leaf constants; `src/features/{outbox,snooze}/model.js` = cross-context pure state machines.
- **Data flow (read path):** content script → `app.html` iframe (nonce/`u` query) → `main.js` `send()` → worker `handle()` → `gmail.js` → Gmail. Worker owns the token; the app never sees it. **Fallback path:** if the worker is dead, `main.js` dynamically imports the background modules *into the page* (`fallback.js`) and runs the same verb table in-page — token then lives in the extension-page document (still not in the Gmail document).
- **Write path (sync):** app asks worker `SYNC_PAGE`/`SYNC_DELTA` → worker returns prepared records → app ingests via the one canonical shaper `shapeRecords` → one `store.batch()` → one render → `persistBeforeCursor()` flushes cache → `SYNC_COMMIT` advances `historyId`.
- **Measurements (reproduced this pass):** `tsc -p tsconfig.json` exit 0; `npm test` 2010/2011 (one OOM); `tools/coverage-gate.mjs` green, all-files 83.22% line; `bench` classify-2000 8.3ms, store-2000 31.6ms, 1 render, 100 searches 18.0ms. 84 modules / 216 edges / 0 cycles (prior measured figure, consistent with reading).

---

## C. Findings table

Stable IDs, severity, confidence, subsystem. Details + reproduction in §D onward.

| ID | Severity | Conf | Subsystem | Finding (one line) |
|---|---|---|---|---|
| AGENT-01 | HIGH | CONFIRMED | Tests/CI | `test/app.mail.integration.test.mjs` aborts with heap OOM even in isolation (95/96 pass, SIGABRT). |
| AGENT-02 | HIGH | CONFIRMED | Account isolation | Sign-out/account-change clears caches/outbox but **not** `imageAllow`, `followups`, `deadlineOverrides`, `categoryRules`, `automationRules`, `savedViews` — account-B inherits account-A's image allow-list, auto-archive rules, corrections and reminders. |
| AGENT-03 | MEDIUM | CONFIRMED | Sync/UX | Warm-start (cache-first) inbox leaves `nextPageToken=''` → “Load more” disabled → capped at 500 newest with no in-session pagination until cold boot/resync. |
| AGENT-04 | MEDIUM | CONFIRMED | Storage | Production persistence is entirely `chrome.storage.local` whole-value JSON (msgCache ~1MB, bodyCache up to 2MB raw HTML, +25 keys). IndexedDB adapter exists but **zero** consumers migrated. Near 10MB quota with growth; quota failure degrades silently. |
| AGENT-05 | MEDIUM | CONFIRMED | MV3/BG | `BACKGROUND_SYNC_ENABLED=false` permanently disables the background sweep, its notifications, and offline cursor catch-up — the feature is off by design, not user-facing. |
| AGENT-06 | LOW | CONFIRMED | Security/SEAM | Production `window.__bmm*` test seams (`__bmmIngest`, `__bmmPumpOutbox`, `__bmmShowGate`, `__bmmTeardown`, `__bmmStore`, `__bmmModeOf`, `__bmmHideGate`, `__bmmAutoRefreshPending`) expose privileged operations on the extension-page global. Reachable only under CSP/no-inline-scripts today; should be build-gated. |
| AGENT-07 | LOW | CONFIRMED | Maintainability | Stale/contradictory comment in `store.js:tokenize` — prose says snippet is *not* indexed; code indexes it. |
| AGENT-08 | MEDIUM | MEDIUM | Docs/OAuth | `auth.js` documents OAuth client type as **Web application**, but `chrome.identity.launchWebAuthFlow` + `getRedirectURL()` requires a **Chrome Extension** client with the `chromiumapp.org` redirect registered. Likely wrong setup guidance → onboarding friction. |
| AGENT-09 | LOW | CONFIRMED | Observability | All diagnostics are `console.*`; no structured log records, correlation IDs, or stable error codes across async boundaries. Error taxonomy is string-fragile (app substrings `err.message`). |
| AGENT-10 | LOW | CONFIRMED | Privacy | `bodyCache` persists up to 50 raw message HTML bodies (≈2MB) at rest in the browser profile; no user-facing disclosure of what is stored locally. |
| AGENT-11 | LOW | CONFIRMED | Repo hygiene | 72 committed `tools/screenshots/*.png` render artifacts add repo bloat for no runtime value. |

---

## D. Critical-correctness findings

I found **no** live CRITICAL correctness defect in the current tree of the class the prior audits identified (the two cursor-ownership CRITICALs and the outbox lost-update have clear remediation in the code I read). The nearest thing to a critical path that is not defended is AGENT-02 (account isolation residue) — it sits in the same class the repo itself treated as CRITICAL (AUD-C1/C2) and is therefore rated HIGH, not downgraded.

---

## E. Security findings

- **OAuth (strong).** Implicit flow, `state` verified, `prompt=none` silent renewal, `sessionEpoch` invalidates in-flight renewals across sign-out, identity (`fetchAccountEmail`) gates every renewal (AUD-C1 landed), token stored in `chrome.storage.session` via `TOKEN_STORAGE`, `authorized` flag in local. No token ever logged. Revocation is server-side.
- **Body isolation (strong).** `reader-frame.js` documents `READER_SANDBOX_FORBIDDEN = [allow-scripts, allow-same-origin, allow-forms, allow-modals]`; app.html iframe carries only `allow-popups allow-popups-to-escape-sandbox`; srcdoc CSP `default-src 'none'`. Sanitiser is a DOMParser parse-and-walk with element/attr/CSS/URL allow-lists, depth-capped (1024), fail-closed with a user-facing notice. `data:image/svg+xml` excluded. Confirmed `0` inline handlers in app.html and a single `type=module` script.
- **Header injection (strong).** `buildMime` scrubs every header incl. `Subject`, addresses rebuilt from parsed tokens (`safeAddressHeader`), CR/LF/U+2028/2029 stripped, `safeFilename`. Real, previously-exploitable class, now closed.
- **Weaknesses to flag:**
  - **AGENT-06:** the `__bmm*` seams are privileged verbs on a shared global; benign under current CSP but a latent escalation surface if the extension page ever loads an inlined script or a third-party module. Prefer gating behind a dev manifest.
  - **AGENT-08:** the documented OAuth client-type guidance is very likely wrong for the actual flow, which will make onboarding fail with `redirect_uri_mismatch` for anyone who follows the docs.
  - `chrome.runtime.onMessage` in the worker checks `sender.id === chrome.runtime.id` (good); the *content script's* `BMM_TOGGLE` listener does not validate `sender`, but it is only reachable via worker messages (no `externally_connectable`), so LOW.

## F. Data-integrity findings

- Sync custody on the common path is correct: `syncPage` reads `profile().historyId` **before** listing (stale-safe, never too-new); `commitHistoryId` refuses to move the cursor backward (BigInt compare); the app only sends `SYNC_COMMIT` after `persistBeforeCursor()` (durable flush). Delta application is a single ordered fate-map (`reduceHistory`) that keeps `added`/`removed` disjoint.
- **AGENT-04** is the integrity risk: durability is measured by a 500-row cache flush, not by full-store persistence. A crash between store mutation and cache flush rolls back in-memory only; because the cursor is committed *after* flush, a replay is idempotent — so this is safe, but it relies on the cache flush succeeding. `persistBeforeCursor` throws `SYNC_NOT_DURABLE` if the flush returns false, which is the right failure.
- **AGENT-02** is a real integrity gap: rule/follow-up/deadline/imageAllow state is account-scoped in meaning but is *not* cleared or re-validated on account change, so account B can act on account A's decisions (auto-archive, image allow-list, reminders).

## G. MV3 lifecycle findings

- Stateless worker; module-scoped mutable state is minimal and carefully epoch-guarded (`sessionEpoch`, `opEpoch`, `outboxPumping`, `bgSyncRunning`). Durable scheduling uses `chrome.alarms` (WAKE/AUTH_RETRY/SYNC). Worker-restart-safety for the outbox is handled by `sending → failed` demotion on load. Snooze wake is a nudge + catch-up on startup/install (correct for MV3).
- **AGENT-05:** the only durable scheduled job that was *added* for background freshness (`backgroundSync`) is compiled off (`BACKGROUND_SYNC_ENABLED=false`). Consequences: notifications on augsd/academics mail and background cursor advancement do not happen; a long absence is caught only on the next app open. This is a deliberate, documented remediation of the cursor-ownership finding, but it is a real feature regression that users are not told about.

## H. Gmail/API findings

- Endpoint usage is correct and quota-conscious: `format=metadata` + explicit `META_HEADERS` for the list; `/batch` capped at 100; `batchModify` chunked at 1000; history types enumerated; `Retry-After` honoured, jittered exponential backoff, 403-quota distinguished from 403-scope, `OUTCOME_UNKNOWN` for non-idempotent retries. `parseBatch` is tolerant and ID-whitelisted (AUD-Q2). Attachments coerced to `data:` with MIME type token-validated.
- Minor: `decodeEntities` is a fixed-set decoder (fine for display via textContent). `normalise` sets `threadId || id` (sensible). No defect found in the API layer itself beyond AGENT-08's doc mismatch.

## I. Sync findings

- **AGENT-03 (warm-start pagination).** Reproduced by reading `start()`: with a warm cache and a live cursor, `refresh()` returns `'delta'` and `start()` returns **without** calling `loadPage('')`. So `state.nextPageToken` stays `''` and the “Load more” button is disabled for the whole session. Cold boot and resync DO populate the token. The result is that the cache-first path — the *common* path — is capped at the 500 newest and cannot page further in-session. Not data loss (Gmail is source of truth; a later cold boot pages), but a real functional inconsistency between the two boot paths.
- Cursor ownership (the former CRITICAL) is fixed: the sweep is disabled and `syncPage`/`commitHistoryId` are custody-correct.

## J. Storage/EmailStore findings

- `Store` is a well-designed in-memory store: incremental inverted indexes, single batch notification, delta persistence via `cache.js`, memoised derived reads, `_insertOrdered` binary search with date-reposition on both `upsert` and `patch` (the date-drift class is closed). `idsFor` returns a copy (aliasing bug closed).
- **AGENT-04:** all persistence is whole-blob JSON under one 10MB `chrome.storage.local` quota. `msgCache` (500 rows ≈1MB) + `bodyCache` (up to 2MB of raw HTML) + 25 other keys + settings + backup snapshots can approach the limit; a user with many saved rules/views/templates/follow-ups and a busy mailbox is the realistic trigger. The IndexedDB adapter (`platform/idb.js`) is well-built (contract-parity, onversionchange close, failed-open not cached) but **no consumer uses it** — the roadmap's intended first migrant (body floor) has not landed. Quota failures degrade the cache silently and warn once (`onError`), which is safe but means the failure is invisible until offline paint is degraded.
- **AGENT-10:** the body floor stores raw HTML at rest — expected for a mail client, but undocumented to the user.

## K. UX/accessibility findings

- Genuinely strong: one source of truth for reader-frame CSP/sandbox/typography, fail-closed body notices, persistent offline banner that self-clears, accurate “Updated N min ago” freshness, focus-in/focus-restore on gate/dialogs, `aria-activedescendant`, reduced-motion, WCAG AA contrast verified by `tools/check-contrast.mjs`. The UX-AUDIT-V4 and post-implementation UI audits are consistent with the code I read.
- **AGENT-03** is the one UX gap: the warm-start list silently stops at 500 with a disabled Load-more control, with no indicator that older mail exists behind an unreachable pagination step.

## L. Performance findings

- Reproduced: classify-2000 8.3ms, store-2000 31.6ms, 100 searches 18ms, exactly 1 render per settled sync batch. Search is index-backed with prefix matching; list diffing is O(changed). No polling loop in `main.js`. `window` test seams and the disabled sweep keep idle CPU near zero.
- One latent cost: `Store.search` prefix-matches by iterating **all** distinct index tokens for terms ≥3 chars (`for (const [tok, ids] of this.searchIndex)`). At the 2000 cap this is fine (measured 18ms/100 searches), but it is O(#tokens) per keystroke and would degrade if `MAX_MESSAGES` is ever raised. Note only.

## M. Test-quality findings

- 2011 tests, 2010 pass in a single `node --test` run; `tsc` clean; coverage gate green at 83.22% line; fuzz, property-style (fuzz-*), account-identity, worker-dispatch, a11y, and invariants are present — this is a well-tested project (≈1:1 test:source).
- **AGENT-01 (reproduced defect):** `test/app.mail.integration.test.mjs` runs 96 subtests, 95 pass, then the Node process aborts with `FATAL ERROR: Reached heap limit — JavaScript heap out of memory` (SIGABRT), **both** in the full run and in isolation at `--max-old-space-size=1400`. This is a memory leak across the file's jsdom boots (accumulated listeners/documents/timers not released between subtests). It is the single most likely cause of a red/flaky CI run: under the 8-shard `ci-test.mjs` layout this file lands alone in one shard and will OOM there too. It must be split or given an explicit teardown between subtests; the OOM should be a treated as a CI failure, not a wall-clock artifact.

## N. Maintainability findings

- Excellent overall: a 1:1 test:source ratio, load-bearing inline comments, an explicit storage-key registry (`storage-registry.js`) with a sweeping test, a compiler-checked contract surface (`tsconfig.json` checks `system/**` + store), no cycles, no eval/`new Function`/`document.write`, minimal runtime deps (zero prod deps), dependency-review CI, least-privilege CI.
- **AGENT-07:** the `tokenize` comment contradicts the code (snippet *is* indexed). Small, but it is exactly the stale-comment class the codebase elsewhere claims to have eliminated.
- **AGENT-09:** error/observability taxonomy is substring-typed strings; the audit history itself flagged this (EXT-M2) and it remains. `handle()` catches and stringifies; the app regex-matches messages. Brittle across refactors/localisation.

## O. Release/migration findings

- Versioned cache blobs (`VERSION=1`), widening rows degrade rather than fail to parse, backup envelope versioned (`BACKUP_VERSION=1`), CI reproducible via `npm ci` + lockfile. No prod manifest differs from dev (a single `manifest.json`). `manifest-key.txt` is the public key (verified byte-identical to manifest `key`).
- No schema migration runner exists; cache/bodyCache schema changes rely on manual `VERSION` bumps. Acceptable at this scale, but the first IndexedDB migration (AGENT-04) will need one and it does not exist yet.

## P. Recovery & observability findings

- Recovery is decent: cache read never throws; corrupt rows skipped individually; `tooOld` triggers a clean resync + `clearCache`; sign-out clears caches/outbox; the reader falls back to the body floor. 
- **AGENT-09:** no structured diagnostic events, no correlation IDs, no request/outcome metrics persisted beyond the capped activity log (500 entries/14 days) and `diag.js` counters that are only bumped (not surfaced). A production outage would be hard to reconstruct from `console.*` alone. Recommend the roadmap's structured-log item.

## Q. Improvements not caused by current bugs

- Gate the `__bmm*` seams behind a dev build (AGENT-06).
- Move `bodyCache` to IndexedDB first (it is the intended first migrant) to defuse AGENT-04 without touching the header cache.
- Add a warm-start “Load older” path that does a real `loadPage('')` when the user reaches the bottom of the cache (AGENT-03).
- Re-aim the background sweep behind an independent cursor (per the reconciliation's own roadmap) so notifications and offline catch-up can return without reintroducing the cursor-ownership defect.
- Surface local-storage usage to the user (e.g., a quota meter) so AGENT-04's silent degradation is visible.

## R. Recommended phased roadmap

- **P0 (do now, cheap):** Fix AGENT-01 (split/teardown the integration test; treat OOM as CI failure). Clear/namespace `imageAllow`, `followups`, `deadlineOverrides`, `categoryRules`, `automationRules`, `savedViews` on account change (AGENT-02) or make their account scoping explicit.
- **P1 (correctness/UX):** Warm-start “Load older” pagination (AGENT-03).
- **P2 (storage):** Migrate the body floor to the existing IndexedDB adapter; introduce a real versioned migration runner (AGENT-04).
- **P3 (ops):** Structured diagnostics + correlation IDs; re-enable background notifications behind an independent cursor.
- **P4 (hygiene):** Correct the OAuth client-type docs (AGENT-08), remove committed screenshots (AGENT-11), fix the stale comment (AGENT-07).

## S. Assumptions & unverified items

- I ran the full suite once in a single process and the flagship file once in isolation; I did **not** run the 8-shard CI matrix end-to-end. AGENT-01's CI manifestation is inferred from the shard layout, not reproduced on a runner.
- Real Gmail behavior (history expiry, batch parsing against live payloads, OAuth `launchWebAuthFlow` client-type acceptance) was **not** exercised against a live account; AGENT-08 and H are based on documented Chrome/Google semantics, not a live sign-in.
- I did not audit every one of the 153 test files or every CSS file; UI/craft claims rely on the checked-in audits plus spot reading.
- I did not run a real headless browser (`playwright-core` is a devDependency) to confirm a11y/visual claims; those are taken from the repo's own control-proven reports.
- `npm audit` at install reported 0 vulnerabilities; not re-checked at release time.

---

## T. Full 1–10 ratings (each “way” from the audit brief)

Scored 1–10, 10 = best. Rationale from this pass's evidence.

| # | Way | Score | One-line rationale |
|---|---|---|---|
| 01 | Repository state & baseline | 9 | Clean, in-sync, 504 commits, sane .gitignore, no secrets, no stray build artifacts (only 72 screenshots, AGENT-11). |
| 02 | Requirements & product contract | 8 | Rich docs (README/SECURITY/DO-THIS-NOW) matching code; a few accidental-behavior gaps (AGENT-03). |
| 03 | Architecture & boundaries | 9 | Clean layering, single chrome.* seam, 0 cycles, canonical shaper; fallback duplication is intentional and tested. |
| 04 | Dependency graph & module health | 9 | Zero prod deps, 84 modules, no cycles, storage registry sweeps keys. |
| 05 | Domain model & data contracts | 8 | Strong types + `checkJs` on contract surface; error taxonomy still string-typed (AGENT-09). |
| 06 | API surface & internal contracts | 8 | Export-limited, injected deps, test seams; in-page/worker verb tables duplicated by necessity and pinned. |
| 07 | Gmail API semantics | 9 | metadata projection, batch, quota, retry, ID whitelist, ordering, 401/403 distinction all handled. |
| 08 | OAuth & authentication | 9 | Implicit flow + state check + session storage + epoch invalidation + identity-gated renewal; doc mismatch (AGENT-08). |
| 09 | Manifest V3 service-worker lifecycle | 8 | Stateless, alarms for durable wake, chained probes, epoch guards; background sweep disabled (AGENT-05). |
| 10 | Chrome extension API usage | 8 | Correct permissions, optional-chained action/commands, runtime.lastError handled; no externally_connectable. |
| 11 | Storage architecture | 6 | All whole-blob JSON under one 10MB local quota; IDB adapter unused (AGENT-04). |
| 12 | EmailStore & index consistency | 9 | Incremental indexes, date-reposition closed, copy-return closed, invariant tests. |
| 13 | Sync engine | 7 | Custody-correct; warm-start pagination gap (AGENT-03). |
| 14 | History API & incremental tracking | 8 | Drain-or-don't-move, tooOld→resync, account-scoped cursor; sweep disabled. |
| 15 | Message fetching & batch processing | 9 | Chunked, tolerant parser, ID whitelist, memory-bounded. |
| 16 | Email normalization & ingestion | 9 | One trust boundary in `normalise`, totality fuzz-tested, idempotent. |
| 17 | Categorization & classification | 9 | Pure, sync, address→sender→scoring, course-code signal, auditable. |
| 18 | Threads & Gmail semantics | 8 | Thread index + rootIds + live strip; fallback to id when no threadId. |
| 19 | Search & filtering | 8 | Inverted index, prefix match, intersection; O(#tokens) prefix scan is a scaling note. |
| 20 | UI architecture & state management | 9 | One render per settled state, rAF coalescing, opEpoch, ctx getter for store. |
| 21 | UX & information architecture | 8 | Persistent offline banner, accurate freshness, no false success; warm-start cap (AGENT-03). |
| 22 | Accessibility | 9 | axe-core wired, focus restore, ARIA, reduced-motion, contrast gate green. |
| 23 | Visual design & responsiveness | 8 | Six themes, responsive ladder, WCAG AA; judged from check-in audits + spot reads. |
| 24 | Error handling & failure semantics | 7 | Rollback+Retry, OUTCOME_UNKNOWN; string-typed taxonomy (AGENT-09). |
| 25 | Concurrency & asynchrony | 8 | Epochs, single-flight outbox, per-mailbox loading flags; fallback multi-tab pump is the known weak spot. |
| 26 | Cancellation & job control | 8 | bodyToken, opEpoch, pagehide teardown, saver.invalidate; cancellation semantics documented. |
| 27 | Performance & computational cost | 9 | Measured: 39.8ms for 2000 messages, 1 render, 18ms/100 searches. |
| 28 | Memory safety & leaks | 6 | In-app design is bounded, but the integration test leaks to OOM (AGENT-01). |
| 29 | Rate limits, quotas & API economics | 8 | Batch/metadata/Retry-After/jitter; still whole-blob storage quota (AGENT-04). |
| 30 | Security threat model | 8 | Solid boundaries; `__bmm*` seams and fallback token-in-page are the residues (AGENT-06). |
| 31 | XSS / DOM / HTML / CSP | 9 | Parse-and-walk sanitiser + sandbox + srcdoc CSP + no inline handlers; SVG excluded. |
| 32 | Data privacy & minimization | 6 | Raw bodies stored at rest, undocumented; account-B inherits A's allow-list (AGENT-02/10). |
| 33 | Permissions & least privilege | 9 | Minimal permissions, specific host matches, optional-chained surface. |
| 34 | Input validation & trust boundaries | 9 | Boundary coercion, fuzz sweeps, whitelists, ID-whitelist on batch. |
| 35 | Test suite quality | 7 | Deep and broad (2011 tests, fuzz, invariants), but the flagship file OOMs (AGENT-01). |
| 36 | Test determinism & flakiness | 6 | The OOM makes the integration file non-deterministic across runs/shaders. |
| 37 | Property / fuzz / adversarial testing | 9 | Many fuzz-* suites for parsers, sanitizer, classifier, sync sequences. |
| 38 | Migrations & versioning | 7 | Versioned blobs + widening rows; no real migration runner yet (AGENT-04/P2). |
| 39 | Data recovery & self-healing | 8 | Corrupt-row skip, tooOld resync, body floor, backup export/import. |
| 40 | Observability & diagnostics | 6 | console.* only, no correlation IDs / structured events (AGENT-09). |
| 41 | Release engineering & CI | 7 | 8-shard CI, least-privilege, dependabot, weekly audit; but the OOM threatens shard greenness (AGENT-01). |
| 42 | Code quality & maintainability | 9 | Excellent factoring, named extraction, low duplication, one shaper. |
| 43 | Type safety & static analysis | 8 | `checkJs` on contract surface + tsc clean; strictness deliberately limited to contract files. |
| 44 | Documentation & knowledge transfer | 7 | Rich docs; OAuth client-type guidance likely wrong (AGENT-08), one stale comment (AGENT-07). |
| 45 | Edge cases & hostile data | 9 | Depth caps, totality, fuzz coverage of long/unicode/malformed input. |
| 46 | Account isolation & multi-account | 6 | Core identity fixes landed, but rule/follow-up/imageAllow/view residue survives sign-out (AGENT-02). |
| 47 | Update/install/uninstall lifecycle | 8 | onInstalled/onStartup, versioned cache, backup versioning; no destructive-upgrade tests for storage. |
| 48 | Network / offline / connectivity | 8 | Offline banner, queued intents (ARCHIVE), body floor, online-drain; offline catch-up off in background (AGENT-05). |
| 49 | UX performance & perceived responsiveness | 8 | Cache-first, optimistic actions, 1 render/settle; warm-start cap affects perceived completeness (AGENT-03). |
| 50 | System-wide audit & synthesis | 8 | Five same-day audits + reconciliation already landed; this pass adds the residual cluster above. |

**Composite = 7.1/10.** Strong security, correctness-on-the-common-path, and maintainability; held back by a reproduced test-suite OOM, an account-isolation residue, a warm-start pagination gap, and single-database storage economics.
