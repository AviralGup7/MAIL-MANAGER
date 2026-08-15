# BITS Mail Manager — Deep System-Wide Audit (External, Round 3)

**Commit audited:** `f53175c` (`main`, clean tree, in sync with `origin/main`)
**Date:** 2026-08-15 · **Auditor:** external, evidence-driven
**Environment:** Node v20.20.2, npm 10.8.2, Linux, clean clone + `npm ci`
**Scope:** entire repository — 460 files, ~34.6k LOC in `src/`, 152 test files

**Stance:** This audit was told to rate low while being honest and to find real
problems. It does that. It also refuses to invent problems: several suspicions
raised during the sweep were *disproved by execution* and are recorded as such
in §S rather than deleted. Findings marked CONFIRMED were reproduced by running
code in this environment, not inferred from reading.

---

## A. Executive risk summary

This is a genuinely unusual codebase. It is far above the median for a
single-author project: the architecture is layered on purpose, the trust
boundaries are real, the OAuth design is defensible and documented, the
sanitiser survived every bypass thrown at it, and the store's index invariants
held under 30,000 randomised mutations. The comment culture is exceptional —
most non-obvious decisions carry the measurement that produced them.

It is also **not** in the state its own documentation claims. Three things
matter more than everything else in this report:

1. **The declared baseline is red.** `npm test` — the command in
   `package.json`, the command the README points at — **fails** on a clean
   clone at `f53175c`. `test/app.mail.integration.test.mjs` dies with
   `FATAL ERROR: Ineffective mark-compacts near heap limit — JavaScript heap
   out of memory` (SIGABRT). Reproduced 3/3 times, at the declared 1400 MB
   budget and at 3072 MB (the CI budget), and even at 3072 MB the file was
   still killed (SIGKILL) after 194 s having reached only 94 of ~111 boots.
   **This was already reported as EXT-H2 in a prior audit in this same repo and
   has not been fixed.** A known-red baseline that survives an audit cycle is a
   process finding, not just a test finding.

2. **Local search silently loses every non-ASCII message.** `Store.tokenize`
   splits on `[^a-z0-9@.\-]+`, so `é`, `ü`, `ñ`, Devanagari, Cyrillic, CJK and
   Greek are all *token separators*. "Café" indexes as `caf`; searching `café`
   or even `cafe` returns **zero results**. Confirmed on 10 real-world subject
   shapes. The product ships to an Indian university; this is not an exotic
   input class.

3. **A partially-failed Gmail batch silently deletes mail from the local
   store.** `batchMetadata` drops failed sub-requests and returns only the
   survivors; the delta path then treats the returned set as authoritative.
   The all-fail case is guarded (it throws); the *partial*-fail case is not.

Beyond those, the audit found a genuine cross-account privacy gap (per-thread
follow-ups, remote-image allow-lists, search history and the activity log
survive an account change), an unbounded quoted-history fold cost, several
observability gaps, and a documentation layer that overstates the verified
state of the system.

**Nothing found is a live remote-code-execution or credential-exfiltration
hole.** The security work in this repo is real and it holds. The risk here is
concentrated in *data integrity*, *account isolation*, and *the credibility of
the evidence chain* — which is precisely the risk class that a codebase this
confident in its own comments is least able to see.

### Verified in this environment

| Check | Result |
|---|---|
| `npm ci` | clean, 0 vulnerabilities reported at install |
| `npm test` (declared command) | **FAIL** — 2010/2011 pass, 1 file OOM/SIGABRT, ~217 s |
| `node --test test/app.mail.integration.test.mjs` (alone, default heap) | **FAIL** — OOM after 52 boots |
| same, `--max-old-space-size=1400` | **FAIL** — OOM after 96 boots |
| same, `--max-old-space-size=3072` (CI budget) | **FAIL** — SIGKILL after 94 boots / 194 s |
| `node tools/ci-test.mjs --shard 1/8` | PASS — 191/191, 0 skipped, 6 s |
| `node tools/check-docs.mjs` | PASS — 6/6 doc invariants |
| Store index invariants, 30k randomised ops | PASS — no drift, no ghosts, order stayed sorted |
| Sanitiser vs 24 XSS/DOM payloads | PASS — 0 bypasses (details §E) |
| Batch parser vs malformed/pretty-printed/boundary-in-body parts | PASS except §D-3 |
| Git history secret scan (`ghp_`, `GOCSPX-`, 504 commits) | clean — only prose references remain |

---

## B. Architecture map (as built, not as documented)

```
                    ┌──────────────────────────────────────────┐
  Gmail tab         │  src/takeover/content.js  (content script)│
  (mail.google.com) │  • hides Gmail roots, inert-guards them   │
                    │  • mints one-time embed nonce             │
                    │  • iframes app.html                       │
                    └───────────────┬──────────────────────────┘
                                    │ postMessage (origin+nonce checked)
                    ┌───────────────▼──────────────────────────┐
  extension origin  │  app.html → src/app/main.js  (3,884 LOC)  │
                    │  Store · cache · render · all UI          │
                    │  NEVER holds a token (except fallback)    │
                    └───────────────┬──────────────────────────┘
                                    │ chrome.runtime.sendMessage (verb router)
                                    │ sender.id checked; per-verb timeouts
                    ┌───────────────▼──────────────────────────┐
  service worker    │  src/background/index.js  (784 LOC)       │
                    │  handle() verb table · alarms · notify    │
                    │  auth.js (OAuth implicit) · gmail.js REST │
                    │  sync.js (history cursor) · mime.js       │
                    └───────────────┬──────────────────────────┘
                                    │ fetch + Bearer
                              Gmail REST / batch / OAuth
```

**Layer discipline observed.** `src/platform/storage.js` is a real seam and is
genuinely the only place `chrome.storage` is resolved. `src/shared/limits.js`
and `src/shared/labels.js` exist specifically so the worker and the in-page
fallback cannot drift. `mime.js` was extracted from `index.js` precisely
because importing `index.js` into a page would register a second set of
listeners — that reasoning is correct and the module boundary is honest.

**The one architectural oddity that is load-bearing:** `src/app/system/fallback.js`
re-implements the worker's verb table *in the page*, dynamically importing
`background/auth.js` and `background/gmail.js`. This means **the OAuth access
token can live in the app document**, which is the exact boundary the rest of
the design exists to protect. It is documented and it is a deliberate trade
(a dead worker otherwise bricks the product), but it doubles the number of
contexts that can hold a credential and it doubles every auth-path bug's blast
radius. See F-3.

**Complexity hotspots.** `src/app/main.js` at 3,884 LOC is the single largest
risk to maintainability in the tree; `timetable-ui.js` (1,434), `list.js`
(1,163), `reader.js` (1,140), `timetable.js` (1,102) and
`classify/pattern-rules.js` (1,059, generated) follow. `main.js` owns boot,
sync orchestration, account teardown, rendering, keyboard, views, theme, the
message router *and* the fallback degradation policy.

---

## C. Complete findings table

Severity: CRITICAL / HIGH / MEDIUM / LOW / INFO.
Confidence: CONFIRMED (reproduced here) / HIGH / MEDIUM / LOW.

| ID | Sev | Conf | Category | Subsystem | Finding |
|---|---|---|---|---|---|
| R3-01 | HIGH | CONFIRMED | Reliability / process | CI, tests | `npm test` — the declared command — fails on a clean clone (integration file OOMs). Previously reported as EXT-H2; still open. |
| R3-02 | HIGH | CONFIRMED | Correctness / UX | Store, search | Non-ASCII text is unsearchable: tokeniser treats all non-`[a-z0-9@.-]` as separators. |
| R3-03 | HIGH | CONFIRMED | Data integrity | Gmail API, sync | A partially-failed batch is treated as authoritative; the delta path then removes the messages that failed to fetch. |
| R3-04 | HIGH | CONFIRMED | Privacy / isolation | Account teardown | Follow-ups, image allow-list, search history, activity log and rules survive an account change. |
| R3-05 | MEDIUM | CONFIRMED | Reliability | MV3 lifecycle | Sharded CI hides per-file heap growth; the shard containing the OOM file passes only because it is run with 3 GB and fewer neighbours. |
| R3-06 | MEDIUM | CONFIRMED | Correctness | Store, search | Prefix search is O(unique tokens) per term — 9,725 tokens at 2k messages; measured 2.2 ms for a 3-char term, and it grows linearly with vocabulary. |
| R3-07 | MEDIUM | HIGH | Data integrity | Sync, history | `MAX_HISTORY_PAGES = 10` converts a busy week into a silent full resync with no user-visible signal and no metric. |
| R3-08 | MEDIUM | CONFIRMED | Correctness | Store | Eviction is by date, so a *backfill* of older mail into a full store is silently discarded. |
| R3-09 | MEDIUM | HIGH | Security posture | Fallback | The in-page fallback puts the OAuth token in the document that renders mail-derived DOM. Documented, but it is the widest trust-boundary concession in the design. |
| R3-10 | MEDIUM | CONFIRMED | Observability | Worker | Five counters exist; none of the failure classes that actually strand users (resync loops, batch partial-fail, intent give-up) are counted. |
| R3-11 | MEDIUM | HIGH | Maintainability | App shell | `main.js` at 3,884 LOC with ~8 unrelated responsibilities is the tree's highest future-defect surface. |
| R3-12 | MEDIUM | CONFIRMED | Test quality | Fuzz | The fuzz corpus contains Unicode strings but **no test asserts search recall over them** — which is why R3-02 survived a dedicated fuzz suite. |
| R3-13 | LOW | CONFIRMED | Correctness | Gmail API | `toEpoch` accepts negative `internalDate` (`'-5'` → `-5`), producing pre-1970 sort positions. |
| R3-14 | LOW | CONFIRMED | Correctness | Batch parser | A message body containing the boundary token yields zero parsed parts for that part. Benign against Google, but the parser is documented as "deliberately tolerant". |
| R3-15 | LOW | HIGH | Performance | Sanitiser | Quote-folding runs `querySelectorAll('blockquote')` + `closest()` per body with no size guard. |
| R3-16 | LOW | CONFIRMED | Docs | README, audits | The README's "1,998+ declared tests pass, 0 skipped" is true of *declarations* and false of *execution* at the declared command. |
| R3-17 | LOW | HIGH | UX | Settings | A shipped, visible setting ("Background priority notifications") is permanently disabled with an apology; `BACKGROUND_SYNC_ENABLED = false` is dead-but-shipped surface. |
| R3-18 | LOW | HIGH | Release | Manifest | `minimum_chrome_version: 116` is asserted but nothing verifies the APIs used are all ≥116-safe. |
| R3-19 | INFO | CONFIRMED | Security | Repo | Historical credential leak is real and correctly documented; current tree and 504-commit history are clean of live secrets. |
| R3-20 | INFO | CONFIRMED | Permissions | Manifest | Permission set is genuinely minimal and every one is used. This is a pass, recorded because it is unusual. |

---

## D. Critical correctness findings

### R3-03 — Partial batch failure silently removes mail *(HIGH, CONFIRMED)*

**Files:** `src/background/gmail.js:200-267` (`batchMetadata`, `parseBatch`),
`src/background/sync.js:119-152` (`syncDelta`), `src/app/main.js:1770-1783`.

**Condition.** `parseBatch` drops any sub-part whose status line is not 2xx:

```js
if (!/\s2\d\d\s/.test(` ${status} `)) continue; // drop failed sub-requests
```

`batchMetadata` then guards only the *total* failure:

```js
if (ids.length > 0 && out.length === 0) {
  throw new Error('batch metadata returned nothing for ' + ids.length + ' ids');
}
return out;
```

So a batch of 100 where 40 sub-requests return 500 returns **60 messages, with
no error and no signal that 40 are missing.**

**Why that is data loss, not just a short read.** In `syncDelta`, `addIds` is
the set of ids history says are present. Those ids are fetched via
`batchMetadata` and returned as `added`. `main.js` then commits the cursor:

```js
await persistBeforeCursor();
if (res.nextHistoryId) await send('SYNC_COMMIT', { historyId: res.nextHistoryId });
```

The cursor advances past changes for the 40 messages that were never fetched.
Because the cursor is the only record of what has been seen, **those 40
messages are never fetched again** until the cursor expires (~1 week) or a
resync is forced by an unrelated event. The code's own comment in `syncPage`
articulates exactly this hazard for a different call ("too-new loses mail
irrecoverably") — the same law is not applied to partial batch results.

**Blast radius.** Gmail 5xx on a subset of a batch is routine under load; the
retry logic retries the *whole batch request*, not sub-requests, and a 200 OK
envelope containing 40 failed sub-parts is not retried at all. Realistic
trigger: any rate-limited or degraded window during a delta sync.

**Affects:** correctness, data integrity, reliability.

**Repro sketch.** Stub `fetch` for `BATCH_URL` to return a multipart body where
40 of 100 parts carry `HTTP/1.1 500 Internal Server Error`; call
`syncDelta()`; observe `added.length === 60` and `nextHistoryId` still set.

**Regression tests required.**
- `batchMetadata` returns a result that *names* the missing ids.
- `syncDelta` does not return `nextHistoryId` when any requested id is absent.
- A partial batch followed by a second delta re-fetches the missing ids.

**Remediation (preferred).** Make partial success representable. Return
`{ messages, missingIds }` from `batchMetadata`. In `syncDelta`, if
`missingIds.length > 0`, either (a) retry just those ids once, then (b) if any
still missing, **withhold `nextHistoryId`** so the delta replays. Upserts are
idempotent — the code says so and the fuzz above confirms it — so replay is
free. Fallback option: keep the cursor but persist a `pendingIds` set that the
next sync drains. Prefer (a)+(b): it needs no new durable state.

**Dependencies.** None. The in-page fallback shares `gmail.js`, so the fix
lands in both contexts at once.

---

### R3-02 — Non-ASCII mail is unsearchable *(HIGH, CONFIRMED)*

**File:** `src/app/mail/store.js`, `Store.tokenize` (static, ~line 140).

```js
const text = `${msg.subject||''} ${msg.from||''} ${msg.snippet||''}`.toLowerCase();
for (const raw of text.split(/[^a-z0-9@.\-]+/)) { ... }
```

Every character outside `a-z0-9@.-` is a separator. `.toLowerCase()` runs
first, so `É`→`é`→ still a separator.

**Measured, this environment:**

| Subject | Query | Hits |
|---|---|---|
| `Café update` | `Café` / `cafe` | **0** / **0** |
| `naïve résumé` | `naïve` | **0** (indexes as `na`, `ve`, `sum`) |
| `日本語 メール` | `日本語` | **0** (indexes nothing) |
| `Привет мир` | `Привет` | **0** |
| `Zürich trip` | `Zürich` | **0** (indexes `rich`, `trip`) |
| `señor` | `señor` | **0** (indexes `se`, `or`) |
| `emoji 🎉 party` | `emoji` | 1 (ASCII words survive) |

Full index for those ten subjects:
`caf | update | a@b.c | a | b.c | na | ve | sum | rgent | se | or | rich | trip | emoji | party | nordic`

**Why this is worse than "search misses some things".** `tokenize` is described
in-file as "ONE definition of searchable text (cross-audit B-04): the index and
the free-text predicate scan the same three fields, so counts, lanes and
results cannot disagree". The unification is real — which means the defect is
unified too: **lane membership, smart views and counts inherit it.** A message
whose subject is entirely non-Latin indexes to *no tokens at all* and is
therefore unreachable by any text query, while still occupying a row.

Note the second-order effect: `Zürich` indexes as `rich`, so a search for
`rich` returns the Zürich message. The failure is not only recall; it is
spurious precision loss in both directions.

**Blast radius.** A BITS mailbox contains Hindi, transliterated names,
diacritics in staff names, and vendor mail with typographic characters. This is
mainstream input, not adversarial.

**Affects:** correctness, UX, and the credibility of the counts shown in the rail.

**Remediation (preferred).** Normalise then split on Unicode classes:

```js
const text = `${msg.subject||''} ${msg.from||''} ${msg.snippet||''}`
  .normalize('NFKD').replace(/\p{Diacritic}/gu, '')   // café -> cafe
  .toLowerCase();
for (const raw of text.split(/[^\p{L}\p{N}@.\-]+/u)) { ... }
```

NFKD-fold *and* index the raw form, so both `café` and `cafe` hit. Apply the
identical transform to the query side in `search()` or the fold is one-way.
CJK needs a separate decision (bigram indexing or substring fallback for
scripts without spaces) — that is a scoped follow-up, not a one-line fix, and
should be stated as a product limit until done.

**Regression tests required.** A recall table over the ten rows above; a
property test asserting `search(subject.split(' ')[0])` finds the message for
every generated subject — which is exactly the assertion the existing fuzz
suite is missing (R3-12).

---

### R3-08 — Backfill into a full store is silently discarded *(MEDIUM, CONFIRMED)*

**File:** `src/app/mail/store.js`, `upsert` → `_evictIfNeeded`.

`_evictIfNeeded` pops from the tail of a newest-first order, i.e. it evicts the
oldest. Confirmed here: with the store at its 2,000 cap, inserting a message
with `date: -1` leaves `store.get('ancient') === undefined` — it was inserted,
then immediately evicted, with no signal.

That is *correct* for the cap's purpose and wrong for the caller: paging
backwards through an old mailbox (`btn-more`) appends progressively older mail,
so past 2,000 messages **"Load more" stops having any visible effect**. The
store reports success; `isFull` exists but nothing on the pagination path
consults it before ingesting.

**Remediation.** Have `upsertMany` return the ids that survived eviction, and
have the pagination path disable/annotate "Load more" when a page is fully
evicted — the honest message is "this is as far back as the local store goes".
`isFull` is already the right primitive; it is simply unused here.

---

### R3-13 / R3-14 — Two small parser truths *(LOW, CONFIRMED)*

- `toEpoch('-5')` returns `-5`. `Number.isFinite(-5)` is true, so a negative
  `internalDate` becomes a pre-epoch date and sorts to the very bottom. The
  comment above it reasons carefully about `1e999` (correctly handled → 0) but
  not about sign. One-line fix: `if (ms > 0 && Number.isFinite(ms)) return ms;`.
- A part whose JSON body contains the literal boundary string causes that part
  to be lost (`text.split('--' + boundary)` cuts inside the body). Confirmed:
  `parseBatch` returned `[]` for such a part. Google will not emit this, but the
  parser advertises tolerance, and the metadata headers it requests
  (`Subject`, `From`) are *sender-controlled strings that land in that JSON*.
  A subject containing `--bmm_<random>_<ts>` is not reachable by an attacker
  (the boundary is random per request), so this is LOW, not a vulnerability.
  Correct fix is to split on `\r\n--boundary` rather than the bare token.

---

## E. Security findings

**The sanitiser is the strongest part of this codebase and it earned that.**
24 payloads were executed against `sanitizeHtml` in jsdom, covering the classic
catalogue and several second-order shapes:

| Payload class | Result |
|---|---|
| `<svg/onload=alert(1)>` (the bypass the file was rewritten for) | stripped |
| nested/split `<scr<script>ipt>` | stripped |
| `javascript:`, `data:text/html`, `vbscript:` in `href` | stripped |
| NUL / tab / newline-obfuscated schemes | stripped |
| `<img src=x onerror=…>` | attribute dropped |
| `url()` / `expression()` / `@import` inside `style` | dropped |
| `position:fixed` overlay | dropped (not on prop allow-list) |
| `<form>`, `<input>`, `<base>`, `<meta http-equiv=refresh>`, `<iframe>` | dropped with contents |
| `srcset` remote leak | dropped (not on `img` allow-list) |
| MathML/`<mglyph>` mXSS shape | dropped |
| `<noscript>` parser-differential | neutralised — survives only as an inert `title` attribute value |
| DOM clobbering (`id="attributes"`, `id="body"`) | `id` not allow-listed, dropped |
| prototype-pollution attr (`id="__proto__"`) | dropped |
| `target="_self" rel="opener"` override attempt | forced back to `_blank` + `noopener noreferrer nofollow` |
| remote `<img>` | held behind `data-bmm-src` until opt-in |

**Zero bypasses.** The two lines flagged by my crude detector
(`title` attribute containing escaped `<script>` text, and the `data-bmm-src`
holding a tracker URL) are both correct behaviour: the first is inert attribute
*text* that is never re-parsed, the second is the deliberate blocked-image
design. I checked both rather than reporting them.

Defence in depth is also real, not claimed: `READER_SANDBOX_FORBIDDEN` pins
`allow-scripts`/`allow-same-origin` out of the reader iframe as *data a test can
assert*, and `readerCsp()` derives the frame CSP from the same `allowRemote`
decision the sanitiser used — which closes the sanitiser/CSP disagreement class
outright.

Other security positives verified:
- Worker router rejects non-first-party senders (`sender?.id !== chrome.runtime.id`).
- Embed nonce prevents a foreign script on the Gmail page from completing the
  takeover handshake; both `BMM_READY` and `BMM_RELEASE` are origin- *and*
  nonce-checked, and `main.js` refuses to boot without a nonce.
- `isTrustedChord` requires `e.isTrusted`, blocking synthetic keydown from page
  script — and it is factored out specifically so the rule is testable.
- Attachment `mimeType` is regex-gated before interpolation into a `data:` URL.
- OAuth `state` is verified before any other field of the response is read.
- Header injection into outbound mail is prevented by *rebuilding* recipient
  headers from validated tokens rather than stripping — the right choice.
- 504 commits scanned: no live `ghp_`/`GOCSPX-`/`ya29.` material. The historical
  leak is real, is documented in `SECURITY.md` and `DO-THIS-NOW.md`, and a
  `package.test.mjs` gate now fails the build if a `GOCSPX-` literal reappears.

### R3-09 — The fallback widens the credential boundary *(MEDIUM, HIGH)*

`src/app/system/fallback.js` dynamically imports `background/auth.js` into the
app document when the worker is unreachable. From that moment the access token
is stored and used by the same realm that renders mail-derived DOM. The
sanitiser and the sandboxed iframe are what stand between mail content and that
token — and they hold today. But the design's own stated principle is "the app
never holds an access token", and in fallback mode that principle is inverted
while the UI shows only a degradation notice.

**Recommendation.** Not to remove it — a bricked mail client is worse. Instead:
(a) treat fallback as an *explicit, user-acknowledged* mode rather than a
silent degrade for auth-bearing verbs; (b) scope the in-page token to the
session area and drop it on mode exit; (c) add a test asserting the token is
absent from the page realm once the worker recovers. Today nothing verifies (c).

### R3-19 — Historical leak (INFO, resolved but worth restating)

The v1 client secret is in public git history of the *predecessor* repo and
cannot be un-leaked by editing files; rotation at Google is the only remedy and
`DO-THIS-NOW.md` says so correctly. Separately — and outside this repo's
control — **the GitHub PAT used to authorise this audit run was transmitted in
plaintext and must be revoked at <https://github.com/settings/tokens>.**

---

## F. Data-integrity findings

### R3-04 — Account teardown is incomplete *(HIGH, CONFIRMED)*

**Files:** `src/app/main.js:2324-2363` (`endAccountSession`),
`src/background/auth.js` (`signOut`, mismatch branch),
`src/app/system/storage-registry.js` (the full key table).

The account tripwire (AUD-C1) is well built: every silent renewal proves
identity before persisting, a mismatch clears the worker's side and throws
`ACCOUNT_CHANGED` verbatim, and both the worker path and the fallback path
reach the surface teardown with a once-guard. That machinery is sound.

**What it clears** — token, `expiresAt`, `authorized`, `historyId`,
`bgNotifiedIds`, `accountEmail`, `msgCache`, `bodyCache`, `intents`, and
(under `clearOutboxOnSignOut`, default true) `outbox`.

**What it does not clear, cross-checked against the registry:**

| Key | Content | Why it is account-scoped |
|---|---|---|
| `followups` | `threadId` + `messageId` + user note (200 chars) | Gmail thread ids of account A, plus free-text the user wrote about A's mail |
| `imageAllow` | sender email addresses | who A corresponds with |
| `queryHistory` | last 40 raw search strings | A's search terms, often names/subjects |
| `activityLog` | verbs + message ids (capped) + error strings | what was done to A's mail |
| `categoryRules` | sender corrections, thread mutes | A's correspondents |
| `deadlineOverrides` | per-message corrections | keyed to A's message ids |

The registry itself documents `historyId`, `accountEmail`, `outbox` and
`intents` as account-hazardous and excludes them from backup for that reason.
The same reasoning applies to the six above and was not carried across.

**Impact.** Sign in as account B on the same profile and: B sees A's search
history in suggestions, B's reader trusts remote images for A's senders, and
follow-up notes written about A's threads persist against ids that no longer
resolve (or, worse, collide). Message-id collision across accounts is
improbable but thread-id *reuse* of a stale entry produces a follow-up
attached to nothing, which the UI renders as "Waiting for a reply".

**Why it is HIGH and not MEDIUM.** The repo classifies cross-account
contamination as critical in its own audit instructions, and the surrounding
machinery proves the team agrees. This is the gap in an otherwise-complete
control, which is the most dangerous shape: the control's existence implies
coverage it does not have.

**Remediation.** Make the registry the enforcement point, not just
documentation. Add `accountScoped: true|false` to every row, have
`endAccountSession` iterate `STORAGE_REGISTRY.filter(k => k.accountScoped)`,
and add a registry test that fails when a new key declares neither. That
converts "remember to clear it" into a build failure — which is the pattern
this repo already uses successfully for backup keys.

### R3-07 — History exhaustion is silent *(MEDIUM, HIGH)*

`MAX_HISTORY_PAGES = 10` (5,000 records). Past that, `history()` returns
`{ tooOld: true }` — the *same* signal as a genuinely expired cursor. The
caller wipes the store, clears the cache and does a full resync. The choice not
to advance the cursor is right; the conflation is not: an operationally normal
event (a busy week, a large label reorganisation) is indistinguishable from
cursor expiry, produces a full resync with a full quota cost, and is recorded
nowhere. Add a distinct `{ exhausted: true }` and a counter (see R3-10).

### R3-10 — Diagnostics count the wrong five things *(MEDIUM, CONFIRMED)*

`src/background/diag.js` is a closed whitelist of `requests`, `retries`,
`notifications`, `renewals`, `mismatchClears`. Two of the five relate to a
feature that is disabled (`BACKGROUND_SYNC_ENABLED = false`). Meanwhile there
is **no counter** for: resyncs triggered, history exhaustion, partial-batch
shortfalls (R3-03), intents that hit `INTENT_MAX_ATTEMPTS` and were dropped,
fallback activations, or `OUTCOME_UNKNOWN` verb timeouts. Those are precisely
the events that leave a user in a wrong state, and they are exactly what a
support conversation needs. Also: `persistDiag` is only invoked from the
`SYNC_ALARM` branch, which is gated off — so in the shipping configuration
**the counters are never flushed at all.**

---

## G. MV3 lifecycle findings

This is done well and I tried hard to break it.

- No `setInterval` anywhere in `src/background/`. The only `setTimeout`s are a
  retry-backoff `sleep` inside a single awaited fetch loop, and one 60 s
  best-effort renewal retry that is explicitly acknowledged as unreliable in a
  worker — with `chrome.alarms` added as the channel that actually survives
  suspension (AUD-M4). That is the correct analysis and the correct fix.
- Listeners register synchronously at module top level; `chrome.action?.` and
  `chrome.alarms?.` are optional-chained so a malformed manifest key costs a
  capability rather than aborting worker registration. The comment explaining
  why (`Status code: 2` names no file) is accurate and hard-won.
- `wakeDue()` runs on `onStartup` *and* `onInstalled`, not only on the alarm —
  so a dropped alarm is late delivery, not lost mail. Correct.
- `scheduleWake` re-aims one alarm instead of registering one per message, and
  `nextWakeAt` was extracted to a pure module specifically because the inline
  version let `NaN` through to `alarms.create({when: NaN})`.
- Re-entrancy is guarded where it matters: `bgSyncRunning`, `outboxPumping`,
  `inFlight` for token renewal, and `sessionEpoch` to invalidate a renewal that
  completes after sign-out.

**Residual risks (not defects, but unproven):**
- `bgSyncRunning` and `outboxPumping` are *module* variables. They correctly
  prevent overlap within one worker incarnation but provide nothing across a
  suspend/restart boundary. The durable equivalents (the outbox pump lock, item
  claims) exist and are well designed; the background sweep has no such lock —
  currently harmless only because the feature is disabled. If
  `BACKGROUND_SYNC_ENABLED` is ever flipped, that gap ships with it.
- No test in the suite terminates the worker mid-await and asserts recovery.
  The `worker-contract.mjs` helper models the dispatch contract, not the
  lifecycle. This is the single largest test-coverage gap by risk (see §M).

---

## H. Gmail/API findings

**Correct and verified:** `BATCH_SIZE = 100` matches Gmail's cap and is
enforced with a throw; `maxResults` is clamped to 500; `Retry-After` is honoured
(both numeric and HTTP-date forms) and capped at 30 s; backoff is exponential
*with jitter* and the jitter rationale (parallel batches re-colliding) is
correct; 403 is split by body text into quota-retryable vs permission-fatal,
which is the right call and is rarely done; 401 is deliberately returned
through `fetchRetrying` so `api()` can own the renew-once path — and the
comment records that this branch was once dead code hiding a `ReferenceError`;
a freshly-renewed token that is *still* 401 throws `AUTH_REVOKED` rather than
returning an error body that a caller could read as an empty inbox.

`AbortSignal.timeout(30_000)` on every fetch closes the blackhole-proxy hang.
Non-idempotent callers pass `retry: false` and get `OUTCOME_UNKNOWN` rather
than a possible double-send — this is genuinely good API-economics hygiene.

**Findings:** R3-03 (partial batch, §D), R3-07 (history exhaustion, §F),
R3-14 (boundary-in-body, §D).

**One quota observation.** `ensureLabel` caches ids, but a cache *miss* costs a
full `/labels` list, and on the create-race path it costs **two** list calls
plus a create. On the snooze-wake path that is per-sweep, not per-message, so
it is acceptable — noting it only because the file claims the cache is "on the
path of every snooze", which overstates the saving.

---

## I. Sync findings

The prepare/commit split is the strongest design decision in the data layer:
`syncPage` and `syncDelta` *prepare*, the app persists, and only then does
`SYNC_COMMIT` advance the cursor. `commitHistoryId` additionally refuses to
move a numeric cursor backwards (BigInt comparison), which correctly defends
against a late commit from an older concurrent prepare.

`reduceHistory` is the right shape: one ordered map keyed by id, so
add-then-archive-then-unarchive resolves to a single final fate and `added`/
`removed` are disjoint *by construction*. I verified the
add → remove-INBOX → add-INBOX sequence resolves to `{addIds:['a']}` with empty
removes. The `labelsAdded` INBOX case (un-archive, which never produces a
`messagesAdded` record) is handled — that is a subtle Gmail semantic most
implementations miss.

`anchorHistory: false` for non-inbox mailboxes prevents Sent/Trash paging from
advancing the inbox cursor past unfetched inbox changes. Correct, and the
comment explains the failure it prevents.

**Weaknesses.** R3-03 breaks the commit discipline from underneath (the app
cannot know the delta was short). `opEpoch` guards stale completions in the app
but is a plain counter with no per-mailbox scoping — two mailbox loads racing a
sign-out all read one epoch, which is coarse but currently safe. `MAX_DELTA_ADDS
= 500` correctly forces a resync without advancing the cursor.

---

## J. Storage / EmailStore findings

**The store is the best-tested unit here, and it survived my attempt to break
it.** 30,000 randomised `upsert`/`remove`/`patch`/`patch(date)` operations with
full invariant checks every 3,000 steps: `order.length === byId.size`, no
duplicate ids in `order`, `order` monotonically non-increasing by date, no ghost
ids in any of the three indexes, and every live message present in its category
and thread index. **Zero violations.** The same held after forcing 2,500
insertions through the 2,000-message eviction path.

The two historical bugs the file documents are genuinely fixed and I confirmed
the reasoning: a changed `date` repositions in *both* `upsert` and `patch` (the
latter delegates to the former so there is one implementation), and `idsFor`
returns a copy rather than the live `order` array. Empty index Sets are deleted
rather than left behind, so `counts()` cannot walk phantom categories.

**Findings:** R3-02 (tokeniser, §D), R3-06, R3-08 (§D).

### R3-06 — Prefix search cost scales with vocabulary *(MEDIUM, CONFIRMED)*

For any term ≥3 chars, `search()` iterates **every entry in `searchIndex`**:

```js
for (const [tok, ids] of this.searchIndex) {
  if (tok.length > term.length && tok.startsWith(term)) { ... }
}
```

Measured here at 2,000 messages / 9,725 unique tokens: `"reg"` 2.23 ms,
narrower terms ~0.20 ms, typing all 12 characters of `"registration"` 2.69 ms
total. **That is fine today** and I will not call it a defect — the memo and
the rAF coalescing absorb it. It is a finding because the cost is O(vocabulary)
per term, vocabulary grows with mailbox size and language diversity, and fixing
R3-02 will *increase* vocabulary substantially. The structural answer is a trie
or a sorted-token binary search; the cheap answer is to memoise prefix
expansions per `_version`, which the memo infrastructure already supports.

### Cache

`msgCache` is one versioned blob, packed positionally, written at most once per
idle period, capped at 500 rows. Row widening degrades correctly (absent index
→ `undefined` → self-corrects on next sync) and the reasoning for not bumping
`VERSION` is sound. Per-row validation skips malformed rows individually and
requires `Number.isFinite(row[5])` — a documented past bug where a string date
broke ordered insertion. `loadCache` never throws. This is careful work.

Residual: there is no corruption *counter* and no way to distinguish "cache was
empty" from "cache was 400 rows of garbage that were all skipped" — both return
`null`. Given R3-10, nobody would ever learn this happened.

---

## K. UX / accessibility findings

Positives verified in source: the reader iframe is genuinely sandboxed without
`allow-scripts`; `role="option"` rows with a stable DOM id backing
`aria-activedescendant`; focus restoration after overlays is tested
(`focus-restore.test.mjs`); reduced-motion is respected in both the takeover
(cut, not animate) and a dedicated stylesheet; six themes pass WCAG AA via an
enforced `npm run contrast` gate — with a High Contrast theme reaching AAA;
`inert` is applied per-node to Gmail's roots with an explicit, correct
explanation of why `inert` on `document.body` broke every click; blocked remote
images carry an explanatory `alt` rather than rendering as empty boxes.

**R3-17 — shipped dead surface.** `settings-panel.js:203` renders a checkbox
labelled "Background priority notifications — **temporarily unavailable**",
permanently `disabled`, explaining that background sync is "being rebuilt".
Honest, but it is a visible control that can never be used, paired with
`BACKGROUND_SYNC_ENABLED = false`, an alarm that exists only to clear itself,
and two of five diagnostic counters that can never increment. Either finish the
independent cursor or remove the surface; a permanently disabled toggle teaches
users the settings screen is unreliable.

**Not verified.** I could not run the axe-core suite or the Playwright smoke
gates to completion in this environment. Accessibility claims here rest on
source reading and on the existence of the gates, not on my own execution —
stated in §S.

---

## L. Performance findings

Measured here: store search 0.2–2.2 ms at 2k messages (§R3-06); 30k store
mutations with full invariant validation completed in ~0.36 s; classification is
synchronous by design and the removal of the pointless `async` (which forced a
semaphore for work that never blocks) is a real, well-reasoned win.

Architecturally sound: incremental indexing with no `rebuild()` in the hot path;
one notification per settled batch; one rAF per render; row diffing against
`renderedIds`; binary-search ordered insertion instead of re-sorting; derived
reads memoised per `_version` with `_flush` as the single invalidation.

**R3-15.** `sanitizeHtml` quote-folding calls `querySelectorAll('blockquote')`
and then `closest('details')` per match, with no bound on body size or
blockquote count. A deeply-quoted 200-message reply chain is O(n·depth). Bound
it, or skip folding above a node-count threshold.

**Unverified.** The render bench and the CI paint thresholds could not be
executed here (no Chromium). The CI thresholds themselves (5,000 ms page /
9,000 ms search) are honestly documented as ~1.5× the worst observed on shared
runners — but a 5-second page-render ceiling is a very loose gate, and the
comment's defence (real regressions move medians by multiples) is plausible
rather than proven.

---

## M. Test-quality findings

**The scale is real:** 152 test files, ~2,011 executed assertions, fuzz suites
for MIME parts, batch parsing, sanitiser depth, classification, search,
deadlines, templates and backup; a mutation-testing tool; contract tests that
execute the worker's *real* `handle()` under stubbed `chrome`/`fetch` via the
`_testHandle` seam; a CI runner that **fails on skips**, which is a discipline
most projects never adopt. The reset-registry pattern — stateful modules
self-register their test resets so a forgotten seam becomes a named gap rather
than a haunted test three files away — is genuinely excellent design.

And yet:

### R3-01 — The declared baseline is red *(HIGH, CONFIRMED)*

`npm test` → `node --max-old-space-size=1400 --test test/`. On a clean clone at
`f53175c` this **fails**: 2010 pass, 1 file aborts with SIGABRT after
`FATAL ERROR: Ineffective mark-compacts near heap limit`. Reproduced three
times. Run in isolation the file still OOMs at the default heap (after 52 of
~111 boots) and at 1400 MB (after 96). At the CI's 3072 MB it was SIGKILLed at
194 s having reached 94.

The harness is not naive — `restore()` calls `win.close()`, runs
`resetAll()`, closes layers, cancels the app's pending timers, and the comment
above `win.close()` documents this exact OOM being fixed once before. The
runner's own header records the measurement: *"jsdom retains ~2.2MB per
document even after close() and an explicit gc()"*. So the leak is understood
and the response was to raise the ceiling. The file has since grown past the
new ceiling too. **Raising the limit is not a fix; it is a countdown.**

**Why this outranks its technical severity.** The prior audit in this very repo
filed it as EXT-H2/AUD-I08 and it is still open at `f53175c`. A red `npm test`
that everyone knows about trains contributors to interpret red as normal — and
that is the mechanism by which a *real* regression ships. It also invalidates,
in practice, the README's headline claim (R3-16).

**Remediation (preferred).** Split `app.mail.integration.test.mjs` into 3–4
files so per-process heap is bounded by construction; the sharded runner
already deals files round-robin, so this also spreads them across CI jobs.
Then lower `--max-old-space-size` back to something that *fails loudly* when
the leak returns. Secondary: investigate the residual per-document retention
(likely module-scope listeners on `window`/`document` registered at
`main.js` top level — lines 1189, 1973, 1977, 2763, 2955, 3032, 3283, 3294 —
which survive `win.close()` because the module graph outlives the window).

### R3-05 — Sharding hides the growth *(MEDIUM, CONFIRMED)*

The OOM file is index 8 of 152 sorted files, so under round-robin it lands in a
shard of 19 files that CI runs with 3 GB. CI is therefore green on a file that
cannot complete in isolation at 3 GB in this environment. The sharding is
well-engineered (completeness is *recomputed and proven*, not assumed; an empty
shard exits 3) — but it converts a per-file resource defect into a
configuration-dependent coin flip. `tools/ci-selfcheck.mjs` proves shard
completeness; nothing proves per-file heap headroom.

### R3-12 — The fuzz corpus contains the input the tests never assert on *(MEDIUM, CONFIRMED)*

`test/helpers/fuzz.mjs` `HOSTILE_STRINGS` explicitly includes
`'छात्रावास'`, `'日本語のメール'`, `'📧🔥'`. So Unicode *is* fed to the
system. But `fuzz-search.test.mjs` asserts **totality** — "tokenize is total and
yields only strings", "parseQuery is total", predicates don't throw — and never
asserts **recall**. R3-02 is therefore a defect that a dedicated Unicode fuzz
corpus walked straight past, because the property under test was "does not
crash" rather than "finds the message". This is the most instructive finding in
the audit: the suite's shape, not its size, is what let a HIGH-severity
correctness bug live.

### Other test gaps, ranked by risk

1. No service-worker termination/restart simulation mid-operation.
2. No partial-batch-failure fixture (directly enables R3-03).
3. No account-switch contamination test over the six leaked keys (R3-04).
4. No search *recall* properties (R3-02, R3-12).
5. No storage-quota-exceeded path test for `msgCache` (the `catch → false` is
   correct but unexercised).
6. `npm run coverage` exists as a "critical-module coverage floor" gate; I could
   not confirm which modules are floored or at what percentage.

---

## N. Maintainability findings

**R3-11.** `main.js` is 3,884 lines and owns boot, the verb client with its
timeout/replay policy, fallback degradation, account teardown, sync
orchestration, rendering, hash routing, keyboard, theme, views and telemetry.
Every one of those is individually well-written; together they are a single
file with at least eight unrelated reasons to change, and the module graph has
extremely high fan-in to it. The rest of the tree has clearly been through
deliberate extraction rounds (reader, list, bulk, overlays, motion, academic all
live in their own modules with stated ownership contracts). `main.js` is what
did not get extracted.

**The comment culture is a genuine asset and a mild liability.** Comments
routinely carry the measurement that justified the decision ("fine at 2000,
overflow at 5000", "a ONE MILLION part tree walks in 92ms", "three measured CI
runs gave 2602/2900/3435ms"). That is exemplary. The liability: several
comments assert current-state facts that are no longer checked by anything —
e.g. `mime.js`'s "index.js registers six chrome.* listeners" (a number that
will drift), and the fallback's "handle() is 158 lines and uses zero chrome.*
APIs" (a claim that is load-bearing for the fallback's *safety* and is verified
by a source pin, but which reads as a permanent truth). Prose that states
numbers should be generated or pinned; this repo already does that well for
docs (`check-docs.mjs`) and could extend it.

**Type safety.** `tsconfig.json` runs `checkJs` with `strict: false` over
exactly three surfaces: `src/app/system/**`, `src/app/mail/store.js`, and
`globals.d.ts`. The scope is *deliberately* narrow and the file says so. That
means ~90% of `src/` — including all of `background/` — has no static checking
at all. Given that `background/` is the layer handling untrusted network data
and credentials, that is the inverse of the priority I would choose. Widening
to `src/background/**` first would be the highest-value single change.

---

## O. Release / migration findings

- Manifest is MV3, minimal permissions, tight CSP with `object-src 'none'` and
  a `connect-src` allow-list. `web_accessible_resources` exposes only
  `app.html` and only to `mail.google.com` — and the nonce handshake exists
  precisely because that exposure lets any Gmail-page script iframe it. Good
  chain of reasoning.
- CI action SHAs are pinned to full commit hashes, not tags. Dependabot is
  configured. `npm audit` is deliberately on a weekly schedule rather than the
  push path, with a written rationale about not training people to ignore red.
  This is mature supply-chain practice.
- Generated files (`pattern-rules.js`, `address-map.js`) are regenerated in CI
  and diffed — catching hand-edits, which the comment says once silently lost
  802 of 891 keys. Excellent.
- `cache.js` has `VERSION` with a documented discard-on-mismatch policy, and
  widening-vs-bumping is reasoned per field.

**Gaps.** No rollback procedure is documented for a bad release. No migration
test over *real historical* stored records (only synthetic). **R3-18:**
`minimum_chrome_version: 116` is asserted but unverified against actual API
usage (`AbortSignal.timeout` is 103+, `chrome.storage.session` is 102+, so 116
is likely safe — but nothing checks it, and the number will rot).

---

## P. Recovery and observability findings

**Recovery is thoughtfully designed.** Every loader degrades to a cold/empty
state rather than throwing (`loadCache`, `loadSnoozed`, `loadFollowups`,
`loadLog`, `normaliseFollowups`, `normaliseLog` all validate per-record and
skip individually). `idbArea` does not cache a failed open, so a transient
wedge self-heals on the next read. Snooze has three independent defences (a
real Gmail label, a visible view, a catch-up sweep) so a missed alarm is late
delivery rather than lost mail — and that layered reasoning is correct.
`intents` gives up after `INTENT_MAX_ATTEMPTS` rather than looping.

**Observability is the weakest non-defect area.** See R3-10: five counters, two
tied to a disabled feature, never flushed in the shipping configuration, and
none covering the failure classes that actually strand a user. There is no
correlation id across a sync run, so a failure that spans
`syncDelta → batchMetadata → persist → commit` cannot be reconstructed from
logs. `console.*` usage is admirably sparse (~6 calls), but the result is that
when something goes wrong in the field there is almost nothing to read.

---

## Q. Improvement opportunities not caused by current bugs

1. **Make the storage registry executable for account scope**, not just backup
   (fixes R3-04's whole class permanently).
2. **Widen `checkJs` to `src/background/**`** — the layer parsing untrusted
   network data should be the *first* typed surface, not the last.
3. **Extract from `main.js`**: the verb client + fallback policy is a coherent
   module (~250 lines) with a clean interface and no DOM dependency.
4. **Represent partial success in the API layer generally** — `batchMetadata`
   is one instance; `bulk`/`batchModify` likely share the shape.
5. **Trie or prefix-memo for search** ahead of the vocabulary growth that
   fixing R3-02 will cause.
6. **Correlation ids** for sync runs; structured diagnostic events with stable
   codes rather than free-text error strings.
7. **Per-file heap headroom check** in `ci-selfcheck.mjs`, mirroring the
   existing shard-completeness proof.
8. **Decide `BACKGROUND_SYNC_ENABLED`** — ship the independent cursor or delete
   the surface, the alarm and the two dead counters.
9. **Bound the quote-fold** (R3-15) and add a body-size guard to the sanitiser's
   post-pass generally.
10. **A "what is stored about me" screen** — the registry already contains
    everything needed to render it, and it would make R3-04's class visible to
    users rather than only to auditors.

---

## R. Recommended phased roadmap

**Phase 0 — restore the evidence chain (days, blocks everything else)**
- Split the integration test file; lower the heap budget back to a level that
  fails loudly. Acceptance: `npm test` green on a clean clone, three runs, at a
  budget ≤1400 MB.
- Add a per-file heap headroom check to `ci-selfcheck.mjs`.
- Correct the README's execution claim to match reality (R3-16).

**Phase 1 — correctness and integrity (1–2 weeks)**
- R3-03: `{messages, missingIds}` + withhold cursor on shortfall. Acceptance: a
  40%-failed batch fixture causes the next delta to re-fetch exactly the missing
  ids and never advances the cursor.
- R3-02: NFKD-fold + Unicode-class tokenisation on both index and query sides.
  Acceptance: the ten-row recall table passes; a generated property asserts
  first-word recall for any subject.
- R3-04: `accountScoped` in the registry + registry-driven teardown + a test
  that fails on an unclassified new key. Acceptance: after a simulated account
  change, none of the six keys retains account-A data.
- R3-13, R3-08: one-line date-sign fix; surface eviction on the paging path.

**Phase 2 — observability and lifecycle (2–4 weeks)**
- Counters for resync, history exhaustion, batch shortfall, intent give-up,
  fallback activation, `OUTCOME_UNKNOWN`; flush on a channel that exists in the
  shipping configuration.
- Distinguish `exhausted` from `tooOld` (R3-07).
- Worker-termination simulation tests at each await boundary of the sync path.

**Phase 3 — structure (ongoing)**
- Extract the verb client from `main.js`; widen `checkJs` to `background/`;
  prefix-search index; decide the background-sync feature's fate.

---

## S. Assumptions, and what I could not verify

**Disproved suspicions — recorded rather than deleted.** Each of these looked
like a finding and was killed by execution:
- *"The sanitiser's `<noscript>` and MathML handling will differ from Chrome's
  parser and yield mXSS."* — Ran both. Neutralised. Not a finding.
- *"`title` attributes carry unescaped payload."* — The value is inert attribute
  text, never re-parsed. Not a finding.
- *"The store's index will drift under interleaved patch/remove."* — 30,000
  randomised ops, zero drift.
- *"`parseBatch` will break on pretty-printed JSON containing blank lines."* —
  `chunks.slice(2).join('\n\n')` handles it correctly. Not a finding.
- *"Status-line matching will reject HTTP/2 style `HTTP/2 200`."* — Accepted.
- *"Search is O(n) per keystroke over all messages."* — It is not; it is
  O(vocabulary) for prefix expansion only, and measured at 2.7 ms for a full
  12-character typing run. Downgraded to R3-06.
- *"Duplicate headers throw or produce arrays."* — `headerMap` last-wins,
  deterministically. Fine.

**Could not verify in this environment (no browser, no real Gmail account):**
- Any claim requiring Chrome: the takeover's real behaviour against live Gmail,
  actual service-worker suspension, `chrome.identity.launchWebAuthFlow`, the
  Playwright smoke gates, the render bench, and the axe-core a11y run. All
  accessibility and paint findings above rest on source reading and on the
  existence of the CI gates, not on my execution.
- Real Gmail API behaviour: whether a partial-failure batch appears in practice
  as I model it (the *code path* is confirmed; the *frequency* is not).
- `npm run coverage` floors — which modules, what percentages.
- Whether CI is currently green on `origin/main` (I did not query GitHub Actions).
- Performance on low-end hardware, and behaviour at 10×/100× data volume beyond
  the 2,000-message store cap.

**Assumptions made:** that `f53175c` is the intended release state; that the
sorted-round-robin sharding I recomputed matches `ci-test.mjs` (I verified the
file list and the index arithmetic, not the runner's internals end to end); and
that `Store.MAX_MESSAGES = 2000` is a product decision rather than a stopgap.

---

## Comprehensive rating — every way, 1 to 10

Rated honestly and rated *low where evidence is missing*, per the brief. A 10
means "I could not find a way to make this better"; nothing here earns that,
and several areas that read as excellent are capped by the fact that their
verification chain is currently broken.

| # | Dimension | Score | Justification |
|---|---|---|---|
| 1 | Requirements & product clarity | **7.5** | Product intent is unusually clear and consistently applied. −: a shipped-but-disabled feature and a fallback mode whose security contract is weaker than the stated one. |
| 2 | Architecture & boundaries | **8.0** | Real layering, real seams (`platform/storage.js`, `shared/*`), correct reasoning about why `mime.js` had to be extracted. −: `main.js` at 3,884 LOC is an unextracted monolith at the centre. |
| 3 | Dependency & module health | **8.5** | Six devDependencies, zero runtime dependencies, pinned CI action SHAs, generated files diffed in CI. Genuinely lean. |
| 4 | Domain model & data contracts | **7.0** | `normalise` is a real trust boundary with total coercion. −: no schema versioning on most records; validation is per-loader convention rather than a shared schema. |
| 5 | API surface & internal contracts | **6.5** | Verb table is clean and the `_testHandle` seam is smart. −: **partial success is not representable** (R3-03) — the defect and the design gap are the same thing. |
| 6 | Gmail API semantics | **7.5** | 403-splitting, Retry-After, jitter, 401-renew-once, `retry:false` → `OUTCOME_UNKNOWN` are all above par. −: R3-03, R3-07. |
| 7 | OAuth & authentication | **8.0** | The implicit-flow rationale is correct and well-argued; `state` verified first; `sessionEpoch` defeats superseded renewals; renewal failure ≠ revocation; identity proven before persisting. −: fallback moves the token into the mail-rendering realm. |
| 8 | MV3 lifecycle | **8.0** | No stray intervals, alarms used correctly, catch-up sweeps on both hooks, listeners registered synchronously with defensive optional chaining. −: zero termination-simulation tests; module-scope guards with no durable equivalent for the sweep. |
| 9 | Chrome API usage & permissions | **9.0** | Five permissions, every one used; host permissions narrow; `tabs` deliberately avoided in favour of host permissions with the reasoning written down. The best-scoring dimension. |
| 10 | Storage architecture | **7.5** | Single seam, versioned blob, per-row validation, IDB adapter with honest documented boundaries. −: no corruption signal, no account-scope enforcement. |
| 11 | Store / index consistency | **8.5** | 30k-operation invariant fuzz: clean. Both historical ordering bugs genuinely fixed with one implementation. −: eviction discards backfill silently. |
| 12 | Sync engine | **7.0** | Prepare/commit split and monotonic cursor guard are excellent. −: R3-03 undermines the commit discipline from below; R3-07 conflates two states. |
| 13 | History / incremental change | **7.5** | `reduceHistory`'s ordered-map design is correct and handles the un-archive case most implementations miss. −: exhaustion is silent and unmeasured. |
| 14 | Message fetching & batch parsing | **6.5** | Tolerant parser, id whitelist against phantom parts, all-fail guarded. −: partial-fail unguarded (the single most consequential defect found). |
| 15 | Normalisation & ingestion | **8.0** | Total coercion at one boundary; `headerMap` unified three hand-rolled parsers that each had the same crash. −: negative `internalDate` accepted. |
| 16 | Classification | **8.0** | Three-stage, synchronous, pure, data-generated with CI-enforced regeneration, total over malformed input. |
| 17 | Threading & conversations | **8.0** | Thread index maintained incrementally; summaries computed on demand rather than cached (correctly justified); `threadOf` fallback prevents an `undefined` mega-thread. |
| 18 | Search & filtering | **4.0** | **The lowest score in this audit, and deservedly.** Non-ASCII mail is unfindable, the same tokeniser feeds lanes and counts so the defect propagates, and a dedicated Unicode fuzz corpus tested totality instead of recall. |
| 19 | UI architecture & state | **7.5** | One store → one notification → one rAF → diffed rows is a genuinely good pipeline, and the "no MutationObserver, no interval" rule is honoured. −: concentrated in one enormous file. |
| 20 | UX & information architecture | **7.0** | Honest empty/error states, freshness surfaced, blocked images explained. −: a permanently disabled setting; paging that silently stops working past 2,000. |
| 21 | Accessibility | **7.0** | Real listbox semantics, focus restoration tested, reduced-motion honoured, AA contrast gated in CI. Capped because **I could not execute the a11y suite** — the design is right, the verification is unconfirmed by me. |
| 22 | Visual design & responsiveness | **7.0** | 28 stylesheets, density system, forced-colors work, a visual-regression harness with committed screenshots across 6 themes × 3 densities × 4 widths. Not independently verified here. |
| 23 | Error handling & failure semantics | **7.5** | Zero fully-empty catches in `src/`; every swallow carries a reason; error classes distinguished (`OUTCOME_UNKNOWN`, `AUTH_REVOKED`, `ACCOUNT_CHANGED`, `SILENT_FAILED:<code>`). −: free-text error strings matched by regex across layers is fragile. |
| 24 | Concurrency & asynchrony | **7.5** | `sessionEpoch`, `opEpoch`, single-flight renewal, settle-and-verify cross-tab claims and pump lock — the outbox coordination is genuinely sophisticated. −: guards are per-incarnation where the sweep is concerned. |
| 25 | Cancellation & job control | **7.0** | `AbortSignal.timeout` on every fetch; per-verb timeouts; safe-replay allow-list distinguishing observation from mutation is exactly right. −: no cancellation propagation into batch parsing or storage commit. |
| 26 | Performance | **7.5** | Incremental everything; measured claims throughout; CI paint gates exist. −: search cost grows with vocabulary; CI thresholds very loose; bench unverifiable here. |
| 27 | Memory safety | **5.5** | **A real, reproduced, previously-reported leak that still crashes the declared test command.** The product-side leak risk is unquantified because module-scope listeners survive document teardown. |
| 28 | Rate limits & API economics | **8.0** | Batching, metadata projections, jittered backoff, `Retry-After`, single-flight renewal, idempotence-aware retry policy. Well thought through. |
| 29 | Security threat model | **8.5** | Trust boundaries named and enforced; sender-id checks; embed nonce; `isTrusted` gate; token kept out of the mail-rendering realm *in the primary path*. −: fallback inverts that in the degraded path. |
| 30 | XSS / DOM / content security | **9.0** | 24 payloads, 0 bypasses. Allow-list parse-and-walk, CSS property allow-list, cid resolution scheme-checked even though it is self-sourced, sandbox flags pinned as assertable data, CSP derived from the same decision as the sanitiser. Excellent. |
| 31 | Data privacy & minimisation | **6.0** | Headers-only cache, activity log deliberately excludes subjects/addresses, bodies capped and cleared on sign-out — all good. Pulled down hard by R3-04: six account-scoped stores survive an account change. |
| 32 | Permissions & least privilege | **9.0** | Minimal, justified, fully used, with the `tabs`-vs-host-permission trade written down. |
| 33 | Input validation & trust boundaries | **7.5** | One coercion point for network data; every loader validates per record; enum/`Number.isFinite` checks throughout. −: no shared schema; validation is convention. |
| 34 | Test suite quality | **5.5** | 2,011 tests, fuzz, mutation, contract tests executing the real handler, skip-proof CI, self-registering reset seams — much of this is exemplary. But **the declared command is red**, and a HIGH correctness bug (R3-02) walked past a dedicated fuzz suite because the properties assert totality, not behaviour. Size is not the problem; shape is. |
| 35 | Test determinism | **7.0** | Seeded fuzz with printed seeds; condition-based settling rather than fixed sleeps; per-boot teardown. −: one file fails non-deterministically by resource exhaustion, which is the worst kind of flake. |
| 36 | Migrations & versioning | **6.5** | Cache versioned with a documented policy; widening-vs-bumping reasoned per field. −: no rollback story; no fixtures from real historical records. |
| 37 | Recovery & self-healing | **7.5** | Degrade-to-cold everywhere; snooze's three-layer defence; IDB open failures not cached; bounded intent retries. −: corruption is indistinguishable from emptiness, and unmeasured. |
| 38 | Observability & diagnostics | **4.5** | Five counters, two for a disabled feature, **never flushed in the shipping configuration**, none covering the classes that strand users, no correlation ids. Second-lowest score. |
| 39 | Release engineering & CI | **7.0** | Pinned SHAs, `if: always()` verdict job that correctly treats `cancelled` as failure, shard-completeness *proven* not assumed, failure artefacts with Playwright traces, weekly-not-blocking audit. −: it is green while the declared local command is red, which is the gap that matters. |
| 40 | Code quality & maintainability | **7.5** | Comments that carry their evidence are a real asset. −: one 3,884-line file; some prose asserts numbers nothing checks. |
| 41 | Type safety & static analysis | **5.0** | `checkJs` covers three surfaces; `strict: false`; `background/` — the layer touching untrusted data and credentials — is entirely unchecked. The scope is deliberate and documented, but the priority is inverted. |
| 42 | Documentation | **6.0** | Extensive, indexed, CI-checked for internal consistency. But `check-docs.mjs` verifies *declared* test counts, so the README's "1,998+ tests pass, 0 skipped" passes a gate while being false in execution. Docs that are gated on the wrong invariant are more dangerous than ungated docs. |
| 43 | Edge cases & hostile data | **7.5** | Depth bounds on both MIME and DOM walks with measured justification; breadth deliberately unbounded *with the measurement that justified it*; totality coercion throughout. −: the Unicode class is generated but not asserted on. |
| 44 | Account isolation | **5.0** | The tripwire itself (identity proven per renewal, worker + surface teardown, once-guarded, reachable from both worker and fallback paths) is excellent work. The score is low because six account-scoped stores survive it — a partial control that reads as complete. |
| 45 | Install / update / uninstall lifecycle | **6.5** | Startup self-check that names manifest/code mismatches; both `onStartup` and `onInstalled` sweeps; cache version discard. −: no upgrade-path testing across realistic version jumps. |
| 46 | Network & offline | **7.5** | Offline intents queue with bounded retries; abort budgets on every fetch; local search and categories work offline; freshness surfaced honestly. |
| 47 | Perceived responsiveness | **8.0** | Cache-first paint, skeletons only on cold start (explicitly *not* over warm content), rAF coalescing, row reuse, one render per batch. Well-reasoned throughout. |
| 48 | Repo & process hygiene | **6.5** | Good `.gitignore`, secret gates, dependabot, a candid `DO-THIS-NOW.md`. −: a HIGH finding from the previous audit cycle is still open at HEAD, which is a process failure more than a code one. |
| 49 | Honesty of self-assessment | **6.0** | Rare and admirable in places — `DO-THIS-NOW.md` admits the leak, `SECURITY.md` dismantles v1's own bad rationalisation, disproved suspicions are kept in prior audits. But prior self-ratings of 8.6/10 sit alongside a red baseline that those same audits recorded and did not fix. |
| 50 | Overall production readiness | **6.5** | The security posture would survive scrutiny; the data layer would not survive a bad network week without losing mail, and non-Latin mail is unsearchable today. |

### Comprehensive rating: **7.0 / 10**

Not an average — a weighted judgement. Security (§30, §32, §9), the store's
proven invariants (§11) and the MV3 discipline (§8) are genuinely strong and I
tried to break them and failed. The score is held at 7.0 by four things that
compound each other:

- a **HIGH data-integrity defect** that silently loses mail on partial batch
  failure (R3-03),
- a **HIGH correctness defect** that makes every non-ASCII message unsearchable
  in a product shipped to an Indian university (R3-02),
- a **HIGH privacy gap** in an account-isolation control that otherwise looks
  complete (R3-04),
- and a **red declared baseline that a previous audit already reported**
  (R3-01), which is what allowed the first three to persist — because the
  evidence chain the project relies on to know its own state is broken.

The distance from 7.0 to 8.5 is not a rewrite. It is Phase 0 plus Phase 1:
roughly a fortnight of focused work, all of it on defects this report localises
to specific functions with specific acceptance criteria. The engineering
judgement needed to do that work is visibly already present in this codebase —
which is precisely why the open items are worth calling out plainly rather than
grading on a curve.
