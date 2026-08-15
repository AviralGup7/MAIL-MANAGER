# Independent Re-Audit III — every way, scored 1–10 (HEAD at `ac0cbf2`)

A third-party, outside re-audit of the codebase at current `origin/main`
(`ac0cbf2`, audit P0–P3 shipped). It is deliberately independent of the
project's own two comprehensive ratings (audit 28 → 8.6, audit 64 → 8.8): it
does not trust them, re-verifies their load-bearing claims against the tree,
and reports where they still hold, where they have moved, and what they could
not have seen.

**Stated limitations up front, so every score below is read in the right light:**
this audit was executed in a headless, 1.9 GB RAM sandbox with **no browser and
no live Google account**. Anything that crosses the browser seam (OAuth consent
on a real account, the takeover over live Gmail, real notifications, Brave's
service-worker registration) could not be observed and is capped accordingly.
That is the same cap the project itself names (its TODO #1), and it is repeated
here because it is the single biggest asterisk on the whole table.

---

## 0 · Method & evidence

- **Checkout:** clean clone at `ac0cbf2`; `git status` clean; up to date with
  `origin/main`. Branch `main`; one additional remote branch
  `origin/copilot/check-gmail-features` (stale/unmerged). 455 commits, 417
  files, one author.
- **Dynamic evidence (executed in this sandbox):**
  - Full `npm test` (default `node --max-old-space-size=1400 --test test/`):
    **1906 / 1907 pass, 0 skipped, 1 fail**. The single failure is
    `test/app.integration.test.mjs` **aborting with SIGABRT — "JavaScript heap
    out of memory" at the configured 1.4 GB heap**. 102/103 of its subtests
    pass before the OOM. See **NEW-1**.
  - Isolated re-run of that file: reproduces the OOM (68s). It is a heap
    exhaustion, not a logic failure — but it means the **default full-suite
    promise is not green** in a memory-constrained environment.
- **Static evidence:**
  - `eval( / new Function / document.write / insertAdjacentHTML / outerHTML`
    in `src/`: **0 hits**.
  - `innerHTML`: 6 files — all static skeletons or the sanitiser's own DOM
    walk; mail-derived text is inserted via text nodes / `setText` (verified
    in `list.js` row rendering).
  - `TODO | FIXME | HACK | XXX` in `src/`: 2 hits, both cross-reference labels
    (repo TODO #4/#5), not debt.
  - `console.*`: 6 calls across 84 modules (worker startup self-check + error
    surfaces).
  - Credential scan (`ghp_`, `GOCSPX`, `ya29.`, `client_secret`,
    `password=`): hits are all **documentation of the v1 incident** and the
    client-ID validation guard in `options.js`. No live secret in `src/`.
  - `.gitignore` documents the v1 secret incident at the point of recurrence.
- **Close reading performed this audit:** `background/index.js`, `auth.js`,
  `sync.js`, `gmail.js`, `mime.js`, `platform/storage.js`, `platform/idb.js`,
  `app/mail/store.js`, `app/core/sanitize.js`, `takeover/content.js`,
  `app/system/fallback.js`, `app/mail/reader-frame.js`, `background/notify.js`,
  plus targeted scans of `main.js` (account teardown, `syncPage` call sites),
  `search/server-search.js`, and the P0–P3 commit diffs.

---

## 1 · Scorecard (independent, 14 ways)

Scores are this auditor's own, grounded in the evidence above. Where the
project's own 64 rating and mine agree, that is convergence, not delegation —
the underlying code is the same, but I re-verified the claims.

| # | Way | 64-rating | This audit | What a 10 needs (not met here) |
|---|---|---|---|---|
| 1 | Security architecture | 9 | **9** | Confirm: allow-list DOM sanitiser with per-property CSS filter, cid resolver scheme-checking its own output, fail-closed path, reader iframe `sandbox="allow-popups"` with `allow-scripts`/`allow-same-origin` absent, takeover embed nonce, trusted-keydown gate, sender-verified worker router, CSP derived from the sanitiser decision. 10 needs a live adversarial pass. |
| 2 | Auth & credential hygiene | 9 | **8** | Code side is strong (session-storage token, single-flighted renewal, session-epoch guard, server-side revoke, revoked-vs-transient taxonomy, account-identity stamping AUD-C1/P0). Deduction: implicit flow has **no refresh token** (platform-forced, but a 1 h token) and **the GitHub PAT was pasted into a chat channel a third time — in this very request** (recurrence of the project's own F1). See NEW-6. |
| 3 | Correctness & data integrity | 9 | **8** | Cursor-before-list, inbox-only anchoring, history drained before cursor advance, ordered fate-map in `reduceHistory`, disjoint add/remove by construction, idempotent upsert, batch-identity whitelist (P2). Deduction: nothing has run on a live mailbox, and the default test suite is not fully green here (NEW-1). |
| 4 | Gmail API integration | 9 | **8** | Real multipart batch, metadata allow-list, per-fetch 30 s abort budget, Retry-After + jitter backoff, 401 renew-once with AUTH_REVOKED, per-chunk bulk reconcile, byte-budgeted inline images, ensureLabel race re-list, label cache account-scoped. Deduction: live API long tail (historyId cliff at scale, throttling shapes, real attachment oddities) unverified. |
| 5 | MV3 service-worker lifecycle | 9 | **8** | Alarms-as-nudge + catch-up sweeps, stateless worker, single-flight guards, no setTimeout for durable work, `onInstalled`/`onStartup` catch-up. Deduction: the original "Service worker registration failed Status code: 2" production failure is **mitigated by the fallback but still undiagnosed** — the fallback exists because of it. |
| 6 | Storage & EmailStore | 8 | **8** | Incremental indexing (no hot-path rebuild), one notification per settled batch, delta persistence, IDB adapter behind the seam with a documented contract, account identity in the P0/P3 passes. Deduction: `MAX_MESSAGES` 2000 / `CACHE_MAX` 500 keep the list full-DOM; windowing (IDB migration, TODO #4) still open. |
| 7 | Sync engine & history | 9 | **8** | Delta+resync with guarded cursor, resync on >500 adds / >10 pages, account-scoped identity (P0/P3), no placeholder history IDs. Deduction: order/replay bugs are exactly the class only a live mailbox reveals; cursor is clear-on-transition, not namespaced (NEW-3). |
| 8 | Search, threading & classification | — | **8** | Inverted index, prefix scan, thread index maintained incrementally, single ordered fate-map. Note: prefix search is an O(vocab) scan per term (fine at the 2000 cap; a scaling consideration if the cap rises). Classification is data-pack driven with strong pins. |
| 9 | Testing & CI | 9 | **7** | Huge, well-made suite (1907 subtests, 0-skip rule, sharded CI, sabotage-verified, coverage floors). Deduction: **the default `npm test` is not green** in this environment (NEW-1), the render-bench gate can pass while red (their own F2, re-confirmed), and no browser E2E / live-inbox soak exists. |
| 10 | Performance | 8 | **7** | Benchmarks are good and honest (classify+store 2000 in ~46 ms, 1 render/settled state, 100 searches ~20 ms). Deduction: full-DOM list (O(inbox) nodes), shallow cache, and the render bench is a soft gate — the only gate that measures paint can fail to. |
| 11 | UX & accessibility | 9 | **8** | axe in CI, contrast-gated AA across themes, `aria-activedescendant` listbox, focus restoration, reduced-motion incl. delays, takeover inerts Gmail. Deduction: no screen reader has ever run against it, and nothing observed on a live Gmail DOM. |
| 12 | Maintainability & operations | 7 | **7** | Bus factor one (455 commits, one author, no second merged contributor), two credential rotations pending, classifier accuracy vs real BITS mail unmeasured, one stale investigation branch unmerged. Doc/operating surface is genuinely good. |
| 13 | Privacy & least privilege | 9 | **9** | Exactly two scopes tied to shipped features, per-user OAuth project, metadata-only lists, lazy bodies, remote images blocked by default, no telemetry, notification cards scrubbed+truncated, account-scoped data cleared on sign-out, host permission over `tabs`. Strong. |
| 14 | Repo & process hygiene | 9 | **8** | `.gitignore` records the secret incident, PAT-redacting push script, pinned action SHAs, generated-file no-op gates, titled commits admitting error. Deduction: **no LICENSE** (public repo), README/audits-index/TODO doc drift (their F4), stale branch, and the recurring PAT-in-chat pattern (NEW-6). |

**Unweighted mean: 115 / 14 = 8.21.**
Weighted toward what this project ranks highest (security ×2, correctness ×2,
auth ×1.5, testing ×1.5, sync ×1.5, privacy ×1.5): ≈ **8.2–8.3**.

**Comprehensive rating: 8.2 / 10 — excellent, still capped by the browser
seam and the never-green default suite.** Marginally below the project's own
8.8 because this audit (a) could not observe the live browser, (b) found the
default `npm test` red on a clean checkout, and (c) counts the third
recurrence of the PAT-in-chat credential finding against the process ways.

---

## 2 · New findings (not carried from prior audits)

### NEW-1 · HIGH (confidence HIGH here / MEDIUM as a product defect) — the default full test suite is red on a clean checkout
`test/app.integration.test.mjs` (3,428 lines) runs 102/103 subtests then
**aborts with `SIGABRT` / "JavaScript heap out of memory" at the configured
`--max-old-space-size=1400`**. Reproduced twice, including in isolation.
- **Why it matters:** the package's default `npm test` is the project's own
  definition of "the full suite is green"; here it is not. The integration
  harness (jsdom + full app boot + the whole store/UI stack) is a single
  ~1.4 GB+ heap consumer, so any memory-constrained runner (small CI runner, a
  student laptop, this sandbox) can fail it regardless of product correctness.
- **Blast radius:** repo-health/CI trust. Not a product defect; a test-infra
  and operational ceiling.
- **Mitigation options:** (a) split the file into sharded files (the project
  already shards by count — this one is a heavy outlier); (b) give that one
  file a higher heap in `test:ci`; (c) chase the actual retained growth —
  the app boots several contexts under jsdom and the harness may be retaining
  large references across boot cycles. Preferred: (b) immediately, (c) as a
  follow-up, since memory-growth-in-harness is the likely true cause and would
  also cap CI cost.
- **Regression test:** the whole suite green in a 2 GB CI runner.

### NEW-2 · INFO (confidence HIGH) — the "only the inbox moves the cursor" invariant is caller-enforced, not self-enforcing
`syncPage` advances the account-wide `historyId` on page 1 whenever
`anchorHistory !== false` and `!pageToken`. Both current callers are correct
(`main.js:2114` passes `anchorHistory: id === 'inbox'`;
`search/server-search.js:100` passes `anchorHistory: false`), so no live bug.
But the safety of "only the inbox anchors" lives in two callers agreeing, and
a future caller that syncs Sent/Trash/search via `SYNC_PAGE` without the flag
would silently advance the cursor past un-fetched inbox changes (unrecoverable
until Gmail expires the cursor, ~1 week). Recommendation: a contract test (or
default `false` for anything not explicitly inbox) so the invariant cannot be
silently violated.

### NEW-3 · INFO (confidence HIGH) — account-scoped state is clear-on-transition, not namespaced
`historyId`, `bgNotifiedIds`, `accountEmail`, and the label-id cache are
account-scoped but stored under **account-neutral keys**; safety relies on
every sign-out and every `ACCOUNT_CHANGED` path clearing them. The P0/P3 fix
is thorough and well-tested (all known paths clear all keys), so this is
hardening, not a live defect. A future state key that is account-scoped but
forgotten in a clear path would leak account A's data into B. Recommendation:
name such keys by account (`historyId:<email>`), or add a registry that lists
account-scoped keys and a test that every sign-out path clears exactly that
set (a storage-registry entry already exists for `accountEmail`).

### NEW-4 · LOW (confidence HIGH, platform-capped) — implicit OAuth has no refresh token
`response_type=token` yields a ~1 h access token and no refresh token. Renewal
relies on `prompt=none` against the live Google session cookie. This is the
correct call given Google's constraints (documented honestly in `auth.js`), but
it means: (a) any request issued >~59 min after the last renewal triggers a
silent renew mid-flight, and (b) if the Google session cookie lapses, the user
gets a consent prompt out of the blue. Acceptable; noted so the trade stays
conscious.

### NEW-5 · LOW (confidence HIGH) — token storage falls back to `chrome.storage.local` when session storage is absent
`sessionArea()` = `chrome.storage.session || localArea()`. On browsers where
session storage is unavailable, the access token is written to disk with the
profile. Documented as "no worse than pre-session behaviour", but it is a
relaxation of the primary token-at-rest defence. Acceptable given the fallback
is for exotic contexts; worth a one-line note in the audit trail.

### NEW-6 · HIGH (process; confidence HIGH) — the GitHub PAT was pasted into a chat channel a third time
The project's own audits 28 and 64 both flagged "live GitHub PAT pasted into a
chat to commission the audit" as their F1, and it recurred. This request did
the same (a `ghp_…` token was supplied in plain text). The code has never been
the problem; the *credential-in-plaintext channel* is the recurring defect,
and it is a real compromise vector for an attacker who can read the chat.
**Action: rotate this token immediately.** Prefer a stored `GH_TOKEN` /
credential-helper entry the tooling can *use but never see*, closing the class
rather than the instance.

---

## 3 · Confirmed strengths (independently verified this audit)

- **Trust boundary is real and enforced.** The worker owns the token and the
  Gmail path; the app renders inert, sandboxed frames; the sanitiser is an
  allow-list DOM walk, not a regex chain; `outerHTML`/`eval`/`document.write`
  are absent from `src/`.
- **MV3 lifecycle discipline.** Durable work is on `chrome.alarms`; the worker
  keeps no message state; catch-up sweeps run on `onInstalled`/`onStartup`;
  single-flight guards prevent overlapped notify and outbox pumps.
- **Data-integrity reasoning is unusually careful.** The cursor-read-before-list
  ordering, inbox-only anchoring, drained-before-advance history, ordered
  fate-map, and batch-identity whitelist are each the right call, and each is
  documented with the failure it prevents.
- **Account identity (the two CRITICAL findings of 2026-08-15) is now fixed
  end to end** and wired through worker router, in-page fallback, outbox pump,
  and app surface — verified across all three dispatch paths.
- **Static scans are clean** and consistent with the project's claims.

## 4 · Disproved or not-reproduced suspicions (recorded honestly)

- The `innerHTML` sites looked like XSS until read: all are static skeletons or
  the sanitiser's walk; mail text enters via text nodes. Not a finding.
- The `postMessage('*')`-adjacent bridge is source- and nonce-checked
  everywhere. Not a finding.
- The session-storage token does not vanish on worker eviction
  (per-browser-session, not per-worker). Not a finding.
- The two `TODO` labels in `src/` are cross-references to the repo TODO file,
  not debt. Not a finding.

## 5 · Assumptions & unverified items

- The live browser seam (OAuth consent, takeover over real Gmail, Brave SW
  registration, real notifications, real Gmail history semantics at scale) is
  **unverified** — headless sandbox.
- Whether `app.integration.test.mjs` OOMs on CI (which shards and likely has
  more RAM) is unverified; it is verified red here.
- The classifier's accuracy against real BITS mail remains unmeasured.
- Root cause of the original "Status code: 2" SW registration failure remains
  unknown (mitigated by fallback, not diagnosed).
- LICENSE status (none) confirmed; its legal implications unassessed.
