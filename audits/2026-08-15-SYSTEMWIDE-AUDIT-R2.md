# System-Wide Audit — 2026-08-15, ROUND 2 (post-remediation re-audit)

Whole-codebase re-audit of BITS Mail Manager at `ac0cbf2` (`main`, clean,
`main...origin/main` = 0/0, CI run 31840618381 green 10/10). This round
audits the tree **after** the morning's P0–P3 remediation commits
(`efe291a` → `ac0cbf2`), not the tree the first round read. The round-1
report (`2026-08-15-SYSTEMWIDE-AUDIT.md`) and the plan
(`docs/IMPLEMENTATION-2026-08-15.md`) are left untouched by design.

**Method.** The 50-section brief was re-executed in order: git baseline
first, then the diff surface of P0–P3 read end to end, then the interaction
graph of the new code with the old systems (the stated purpose of round 2:
composability, failure cascade, memory growth, dependency health). Prior
reports — including the round-1 clean bills — were treated as hypotheses
and spot-checked against the code (§D, §I). Reproductions ran as live
imports of the repo's own modules from a throwaway Node harness
(`/tmp/r2-repro.mjs`, deliberately NOT committed: it is a scratch witness,
not a pin — the pin requirements are specified per finding in the body).
**No production file was modified. This document is the only artifact of
round 2.**

**What was actually run.**

- `git status` / divergence: `main` @ `ac0cbf2`, clean, 0/0 against origin.
- `node tools/check-docs.mjs` → **6/6**; `node tools/ci-selfcheck.mjs` →
  **27/27**; README's `1,890` declared-test claim recomputed over column-0
  `^test(` in `test/*.test.mjs` → **1,890 exactly** (the doc is honest).
- `npm audit` and `npm audit --omit=dev` → **0 vulnerabilities** (§H).
- Four live-module reproductions (all CONFIRMED, §D/F/G):
  one foreign held outbox row pins the app in a 250 ms pump loop;
  eight foreign held rows starve the worker's 8-slot batch across 20
  emulated pump rounds; one unwakeable snooze row re-arms `bmm-wake` at
  `now + 5000` forever; persisted `diagCounters` regress 100 → 1 across a
  simulated worker reincarnation.
- Second-witness verification of the two parallel audit reports found on
  origin branches (§C.2): every HIGH there re-verified link by link
  against this tree.

**Cast of prior documents.**

| Document | Where | Status this round |
|---|---|---|
| Round-1 audit (AUD-C1…N1) | `audits/2026-08-15-SYSTEMWIDE-AUDIT.md` (main) | Fixes verified landed; landings re-read, not trusted (§E–§M) |
| Plan / P0–P3 mapping | `docs/IMPLEMENTATION-2026-08-15.md` (main) | Dispositions checked (N1 defer is recorded and honoured) |
| Post-P3 re-audit (AUD2-*) | branch `audit/2026-08-15-post-p3` (green CI) | Independent second witness; verdicts in §C.2 |
| Independent re-audit v3 (NEW-*) | branch `audit/independent-re-audit-v3` (red CI — no index row) | Verdicts in §C.2 |

---

## A. Executive risk summary

P0–P3 are real and they landed: renewal proves identity before persist,
the outbox is owner-stamped with a pump-time refusal, the sweep is
single-flighted, the batch parser whitelists, diagnostics exist, and
open-mail follows the account. The round-1 CRITICALs are closed **on the
paths they named**.

Round 2's findings share one shape: **the new safety controls are correct
in isolation and compose badly with their neighbours.** Identity now
exists — and every system that meets a row it cannot act on loops on it
forever, because none of the three forever-loops below distinguishes
"not mine" or "never possible" from "try again soon."

| ID | Sev | Conf | One line |
|---|---|---|---|
| AUD2-H2* | **HIGH** | CONFIRMED (2 witnesses) | A verb timeout replays the mutating verb in-page while the worker keeps running lock-free: a slow-but-alive worker **double-sends**. The one failure a mail client cannot undo. |
| AUD2-H1* | **HIGH** | CONFIRMED (2 witnesses) | Fallback `SYNC_PAGE` never resolves `labelName`: the snoozed mailbox paints the INBOX whenever the worker is down — the mode this project treats as production. |
| AUD2-H3* | **HIGH** | CONFIRMED (2 witnesses) | `dispatchable(stamped, '') === true` + best-effort sign-in stamp = fail-open: setting-off + failed stamp + account B sends A's queued mail as B. Pinned deliberately; still a residual of AUD-C2. |
| **R2-M1** | **MEDIUM-HIGH** | CONFIRMED (repro) | One foreign-stamped outbox row (queue kept across a switch) pins the app in a **~250 ms pump-verb loop forever**: `nextWakeIn` counts rows the pump will never dispatch, and the receipt is never shown. |
| **R2-M2** | **MEDIUM-HIGH** | CONFIRMED (emulation) | ≥8 foreign held rows fill the worker's 8-slot pump batch on every round; the session's own sends starve permanently. The contained failure of H3's refuse case is not "skipped" — it is a blockade. |
| **R2-M3** | **MEDIUM** | CONFIRMED (arithmetic) | One unwakeable snooze row (deleted message, foreign account, backup-restored) re-arms `bmm-wake` at `now+5000` forever and eats a doomed `modify` per row per fire. Terminal failure is never distinguished from transient. |
| AUD2-M2* | MEDIUM | CONFIRMED (sharpened) | `to:<addr>` returns nothing although To/Cc ARE stored (`META_HEADERS` includes them): the justification comment is factually false; Sent recipient search is dead. |

`*` = found first by the parallel post-P3 audit on branch
`audit/2026-08-15-post-p3`; round 2 verified each independently and keeps
its stable IDs. R2-* IDs are new this round.

**Top of the roadmap (R).** R2-P0: stop replaying mutating verbs after a
timeout (or make the worker pump take the storage lock), close the
fail-open in `dispatchable`, resolve `labelName` in the fallback, and make
all three forever-loops (foreign outbox rows, starved batch, unwakeable
snoozes) exit — by surfacing, retiring, or excluding. Then rotate the PAT
that commissions these audits: this is the **thirteenth** reminder across
the series, and the v3 audit independently flagged the same recurrence
(their NEW-6).

---

## B. Architecture map (verified against code at ac0cbf2)

```
Gmail tab(s) ── content.js ──> iframe app.html?u=N&embed=<nonce>
      │ BMM_TOGGLE / chord        │ verbs via chrome.runtime.sendMessage
      │                           │  ├─ ok ──────────────────────────────┐
      │                           │  └─ timeout/lastError → fallback.js ─┤  ← AUD2-H2 seam:
      ▼                           ▼                                      │    BOTH paths can be
src/background/index.js (MV3 worker)                                     │    live at once
  ├─ auth.js   implicit OAuth; renew() PROVES profile before persist;    │
  │            mismatch clears session set + throws ACCOUNT_CHANGED      │
  │            verbatim; retry = online-listener + 60s timer + one-shot  │
  │            bmm-auth-retry alarm (runAuthRetry)                       │
  ├─ sync.js   cursor pull; advance only after full drain (re-verified)  │
  ├─ gmail.js  REST; /batch; fetchRetrying (30s abort, backoff, bumps    │
  │            requests/retries); parseBatch whitelist (requested ids)   │
  ├─ notify.js selectNotifiable / mergeNotified(100) / cardText          │
  ├─ diag.js   5 counters, memory-only, overwrite-flush on sweep tick    │
  ├─ tab-pick.js prefer /mail/u/N/ match, first-tab fallback             │
  └─ alarms    bmm-wake · bmm-sync(15m, single-flighted) · bmm-auth-retry
        │ OUTBOX_PUMP: in-memory outboxPumping only — no storage lock    │  ← R2-M2 / AUD2-H2
        ▼
app (main.js shell, 3,842 lines)
  ├─ store.js 2000-cap, incremental indexes · cache.js 500 · body floor
  ├─ outbox.js held→sending→sent/failed; enqueue stamps owner;
  │            dispatchable() asymmetric BY PIN (H3 residual);
  │            claims + pump lock coordinate IN-PAGE tabs only
  ├─ rails.js pumpOutbox re-arms from nextWakeIn over the WHOLE queue     │  ← R2-M1
  ├─ fallback.js in-page verb table (no labelName resolution)            │  ← AUD2-H1
  └─ storage-registry.js: every key census'd; new P0–P3 keys all
     backup:false with sound reasons; `snoozed` is backup:true           │  ← feeds R2-M3
```

Layering law (ARCH R-7) still holds with the declared exception
(`fallback.js`); `chrome.*` in `main.js` is boot-ambience guarded by
`?.` (AUD2-L3 stands as LOW drift, not a breach).

---

## C. Complete findings table

### C.1 New this round (R2-*, all verified against `ac0cbf2`)

| ID | Sev | Conf | Category / subsystem | File:symbol | One line |
|---|---|---|---|---|---|
| R2-M1 | MEDIUM-HIGH | CONFIRMED | Resource loop / outbox | rails.js `pumpOutbox`, outbox.js `nextWakeIn` | Foreign-stamped due rows re-arm the pump every 250 ms forever; nothing breaks the loop |
| R2-M2 | MEDIUM-HIGH | CONFIRMED | Data flow / outbox | index.js `OUTBOX_PUMP` (`slice(0, MAX_PUMP_BATCH)`) | ≥8 foreign held rows permanently starve the session's own sends |
| R2-M3 | MEDIUM | CONFIRMED | MV3 lifecycle / snooze | index.js `wakeDue`+`scheduleWake`, snooze.js `nextWakeAt`, registry row `snoozed` | Unwakeable rows re-arm the wake alarm ~5s cadence forever; terminal vs transient failure never distinguished; rows cross accounts and backups |
| R2-L1 | LOW | CONFIRMED | Observability / diag | diag.js `persistDiag` | Flush OVERWRITES: counters regress across worker reincarnations; `mismatchClears` (the tripwire's own proof number) can vanish |
| R2-L2 | LOW | HIGH | Error taxonomy / gmail | gmail.js `batchMetadata` | A 401 from `fetchRetrying` is parsed as multipart → throws "returned nothing for N ids"; renew-once skipped; self-heals next round |
| R2-L3 | LOW | HIGH | Outbox retry policy | outbox.js `markFailed`/`normaliseOutbox` | `_fullError` stripped on save: same-failure short-circuit degrades to 200-char-prefix compare across pumps; comments claim full-string identity |
| R2-L4 | LOW | HIGH | Race / auth.js `signIn` | auth.js `signIn` stamp block | No epoch guard around the stamp: a racing signOut leaves an ORPHAN `accountEmail`; signed-out `online`-event pumps then burn foreign rows' retries |
| R2-L5 | LOW | HIGH | UX ambience | main.js `activeAuthUser` write | Stamp is last-BOOT, not last-active: two concurrent account tabs make openGmailTab preference arbitrary (degrades to fallback law) |
| R2-L6 | LOW | HIGH | Promise hygiene | index.js:715 `.catch?.()` | No-arg conditional catch propagates rejections unhandled; two more floating chains (notifications.onClicked, `wakeDue().then(scheduleWake)`) |
| R2-L7 | LOW | CONFIRMED | UX honesty | index.js/outbox.js `wrongAccount` ↔ app | The AUD-C2 receipt has NO consumer: no rail, toast, or counter ever tells the user queued mail is waiting on another account |
| R2-Q1 | INFO | — | Hardening / notify.js `cardText` | C0/C1/DEL stripped; bidi-override (U+202A–E, U+2066–9) passes into OS cards | Cosmetic spoofing surface; one regex class closes it |

### C.2 Second-witness verdicts (parallel audits on origin branches)

Sources: `origin/audit/2026-08-15-post-p3` (AUD2-*, 791 lines, green CI)
and `origin/audit/independent-re-audit-v3` (NEW-*, red CI — its commit
adds no audits/README.md row, which the doc-gate requires; the failure is
process, not product). Every claim re-verified against this tree.

| ID | Their sev | R2 verdict | My independent evidence |
|---|---|---|---|
| AUD2-H1 fallback `labelName` | HIGH | **UPHELD** | `grep -c labelName fallback.js` = 0; worker resolves via `ensureLabel` (index.js SYNC_PAGE). Fallback ships `opts` straight into `syncPage`, whose default labelIds are `['INBOX']` |
| AUD2-H2 timeout-replay double-send | HIGH | **UPHELD → CONFIRMED** | main.js:419-426 timer → `degradeToFallback` → `runInPageGuarded(type, extra)` replays ANY verb; worker pump (`outboxPumping` only) never touches `outboxPumpLock`/claims; in-page `flushOutbox`'s `loadOutbox` demotes the worker's in-flight `sending` rows to `failed` (due now) and sends then AGAIN. Every link read; the claims protocol coordinates in-page tabs only, never the worker |
| AUD2-H3 fail-open `dispatchable` | HIGH | **UPHELD** | outbox.js:156-166 returns true when either side unstamped; sign-in stamp is `try/catch` best-effort (auth.js); asymmetry is pinned in test/account-identity.test.mjs. R2-M2 adds the refuse-case consequence (starvation) |
| AUD2-M1 account-scoped residency | MEDIUM | **PARTIALLY SUBSUMED** | Registry confirms the surviving set (categoryRules, automationRules, savedViews, templates, followups, deadlineOverrides, myCourses, snoozed, imageAllow, timetable — all backup:true). Portability is a feature; the hazard is rows keyed by message-id acting under account B. Only `snoozed` has an ACTIVE consequence → promoted into R2-M3 with mechanism; the rest are display-noise risks, kept LOW here |
| AUD2-M2 dead `to:` search | MEDIUM | **UPHELD + SHARPENED** | query.js `buildCheck('to')` returns `() => false` for any non-`me` value with a comment claiming stored headers cannot answer it — but `META_HEADERS` (gmail.js:37) includes To and Cc, and `normalise` stores both (gmail.js:367-368). The comment is false; the contract is silently wrong exactly in Sent |
| AUD2-M3 no `login_hint`/`hd` | MEDIUM | **UPHELD (as opportunity)** | authUrl has neither param; mismatch is detected post-mint (correctly), never steered. Cheap improvement, Q-section material |
| AUD2-M4 implicit-flow ceiling | MEDIUM | **UPHELD (platform-capped)** | The auth.js header argues the wall correctly; no action available |
| AUD2-L1 BMM_SHOWN nonce | LOW | **DOWNGRADED → INFO** | The listener IS source-checked (main.js:2931 `e.source !== parent`); a nonce echo adds nothing the source check doesn't already enforce for this payload. Focus-pull is the whole blast radius. (accusation ≠ verdict) |
| AUD2-L2 sender.id fail-open | LOW | **UPHELD** | index.js:205 rejects only a mismatched id; absent id passes. Practically narrow (all real senders carry ids) but fail-open |
| AUD2-L3 chrome.* past the seam | LOW | **UPHELD as drift** | Guarded boot-ambience writes in main.js; no network paths |
| AUD2-L4 no LICENSE | LOW | **UPHELD (process)** | Confirmed absent at repo root |
| v3 NEW-1 integration-test OOM @1400MB | HIGH(infra) | **NOT RE-RUN — see §S** | Full suite is banned locally by house rule; CI's sharded runner is green at HEAD. Real_infra risk, MEDIUM confidence as a product concern |
| v3 NEW-2 cursor invariant caller-enforced | INFO | **UPHELD** | `anchorHistory` discipline lives in two call sites agreeing (main.js, server-search.js); recommend contract pin |
| v3 NEW-3 clear-on-transition not namespaced | INFO | **UPHELD** | Also the framing R2-L4/M3 extend: clearance lists are the only fence, and they are per-site manual |
| v3 NEW-5 session-storage fallback to local | LOW | **UPHELD** | storage.js documents the relaxation honestly |
| v3 NEW-6 / AUD2-P1 PAT in chat | HIGH(process) | **UPHELD — 13th reminder issued** | Out-of-band credential in a readable channel; rotate now |

---

## D. Critical correctness findings

None CRITICAL this round. The correctness surface round 1 opened
(identity) is closed on its named paths; what remains are HIGH
composability defects at the seams BETWEEN the new fences.

**D-1 (re-verified clean):** sync cursor discipline — anchor read before
listing, advance only after full drain, overflow → resync, write at
sync.js:128 happens after every batch chunk resolves. Read again end to
end this round.

**D-2 (re-verified clean):** `reduceHistory` ordered fate-map; add/remove
disjoint by construction; label gain/loss honoured.

**D-3 (re-verified clean):** backup export is `BACKUP_KEYS` straight from
the registry allow-list (backup.js:58); `NEVER_EXPORT` names credentials,
caches and outbox coordination state. The P0–P3 keys (`accountEmail`,
`diagCounters`, `activeAuthUser`) are registry'd `backup:false` with
reasons that name the hazards.

**D-4 — AUD2-H2 is the round's worst defect class** (timeout ⟶ replay of
a non-idempotent verb). Second witness confirmed; repro steps, blast
radius and options in their report §D-5, concurred here. Round 2 adds one
sharpening: `OUTBOX_PUMP`'s verb timeout is 300 s (`main.js:394`) and a
single item can legally consume 30 s × 3 attempts × (hydrate + send), so
**eight queued items is already enough to cross the budget** — the trigger
is a Tuesday, not a tornado.

**D-5 — the three forever-loops (R2-M1/M2/M3)** are the round's new
material; mechanisms and repros in §F (outbox pair) and §G (snooze).

**D-6 (acquittal, recorded):** a suspected cursor regression from
concurrent verb-vs-sweep `syncDelta` runs does NOT corrupt: both runs read
the same base, list from it, and write only after a full drain, so the
later writer's cursor is a superset-cover; replays are idempotent at the
store. Worst case is waste, never loss.

---

## E. Security findings

**E-1 — round-1 fix verification (AUD-C1).** Landed as claimed and correct
in the small: `renew()` delays persist behind a profile proof
(auth.js:349-412), distinguishes "proved different" (clear + verbatim
`ACCOUNT_CHANGED`) from "couldn't check" (`AUTH_RENEW_TRANSIENT` + retry),
and the error taxonomy survives epoch races via re-checks at each await
boundary. The router and the fallback both clear the label cache on the
signal; the surface tears down via `onAccountChanged` → `endAccountSession`
with a once-guard. Pins exist (`account-identity.test.mjs`, 13 tests).

**E-2 (R2-L4) — the stamp itself races sign-out.** `signIn()`'s best-effort
stamp (`await chrome.storage.local.set({ accountEmail: … })`,
auth.js:239-243) sits AFTER `persist()` with NO epoch re-check around the
profile fetch. Sequence: sign-in consent completes → profile fetch in
flight → user clicks Sign out (epoch++, storage cleared) → fetch resolves
→ stamp writes an ORPHAN identity onto a cleared session. Consequences are
narrow but real: (a) `dispatchable`'s "current session" side is now the
departed account, so any pump before the next sign-in treats A's rows as
dispatchable-by-stamp — and an `online`-event pump DOES fire while signed
out (main.js:1925 is unconditional), where each attempt throws
NOT_SIGNED_IN and burns one of the row's four retries; (b) combined with
an early-cancelled SECOND sign-in, the orphan can mislabel a live window.
Fix is two lines: re-check `epoch !== sessionEpoch` before the stamp set.

**E-3 — AUD2-H3 upheld:** the fail-open is pinned deliberately ("refusing
[unstamped mail] would strand real mail nobody can identify"), and it is
the right default for LEGACY rows; the defect is that a STAMPED row meets
an UNSTAMPED session contradicting it, because sign-in's stamp is
best-effort (E-2's sibling). Fail closed only in the stamped-row +
proven-stampless-session quadrant: the stamp attempt succeeded for the
OWNER, so an identified row deserves an identified dispatcher.

**E-4 (R2-Q1):** `cardText` strips C0/C1/DEL; bidi-override codepoints
pass. A crafted `Subject: …\u202E…` paints reversed text into an OS
notification card — pure confusion, no code path, INFO.

**E-5 (acquittals):** `sender.id` router check is fail-open only for
absent ids (AUD2-L2, LOW); BMM_SHOWN IS source-checked (their L1
downgraded to INFO); EMBED_NONCE gate verified at main.js:249-260;
sanitize MAX_DEPTH 1024 re-verified (fuzz-21).

---

## F. Data-integrity findings (outbox = the round's richest seam)

**F-1 — R2-M1: one foreign row, one eternal 250 ms loop (REPRODUCED).**
Setup (all legitimate): `clearOutboxOnSignOut` OFF; account A queues a
send (stamped `a@…`); session moves to B by renewal-tripwire or
re-sign-in. Now, forever, in any open app tab:

1. `pumpOutbox` → verb → worker loads, counts `wrongAccount: 1`, returns
   `sent:0, failed:0` (`more` false whenever ≤8 due; index.js:413-457).
2. App: `result.more` false → `outbox.nextWakeIn(items)` (rails.js:267) —
   which is **account-blind** and sees a HELD row with `releaseAt` past
   → `wake = 0` → `setTimeout(pumpOutbox, 250)`.
3. Worker does 1 + K storage loads per pump; the verb is ~4/second for the
   life of the tab. Nothing decrements, ages, or surfaces anything.

Reproduced against the live `outbox.js` (`nextWakeIn` = 0 on the foreign
row; re-arm arithmetic = 250, still 0 on round 10). Blast radius: battery
and radio on a laptop that may sit on this loop for days; every pump also
writes nothing, so no storage wear — the cost is compute + 4 msg/sec of
extension IPC. The same loop starts for B's view of ANY permanently
undispatchable row; foreign rows are simply the first producer of one.

**F-2 — R2-M2: eight foreign rows, a permanent blockade (EMULATED).**
The worker's batch is `prioritizeDue(dueItems(items)).slice(0, 8)`.
`prioritizeDue` is held-first and stable within class, so the oldest held
rows — the foreign ones — occupy every slot. The pump iterates, refuses
each (`dispatchable`), `continue`s, and the per-round `saveOutbox` never
touches them. The session's own fresh held send sorts BEHIND them and
never enters a batch. Emulated the index.js loop verbatim over the real
`dueItems`/`prioritizeDue`/`dispatchable`: across 20 rounds the session's
row never dispatched, and the queue length never changed (9 in, 9 out).
Note the loop in F-1 guarantees this blockade is exercised continuously,
not once.

**F-3 — R2-L7: the receipt nobody reads (CONFIRMED by census).**
`wrongAccount` is produced by both pumps and pinned in tests
(parity.test.mjs:232-238) — and consumed NOWHERE in src/app. The
typedef's own doctrine ("a silent field is a door nobody walks through")
indicts it: a user whose mail waits on another account receives no rail
badge, no toast, no count. This is the cheapest high-value fix in the
report: surface it on the outbox row ("waiting for the other account").

**F-4 — R2-L3: the retry classifier lies after a save.** `markFailed`
builds `_fullError` for full-string identity, but `saveOutbox` →
`normaliseOutbox` strips it. Across pumps the same-failure check compares
the new error against a 200-char-truncated `error`, so: two distinct long
errors sharing a 200-char prefix = "same failure twice" = straight to
stuck; and the in-code comments claiming full-string comparison are true
only intra-pump. Latent while Gmail errors stay short; the pin suite
should assert the property ACROSS a save/load round trip.

**F-5 (acquittal):** `claim`/`acquirePumpLock` settle-and-verify, claim GC
on flush, TTL backstops — re-read, sound AMONG in-page tabs. The gap is
never inside that protocol; it is that the worker stands outside it
(AUD2-H2).

---

## G. MV3 lifecycle findings

**G-1 — R2-M3: the unwakeable-row engine (CONFIRMED arithmetic).**
`wakeDue` removes a row only on `modify` success; a terminal failure
(404/410 — the message was hard-deleted in Gmail, or the id belongs to
another account) is retried forever, one doomed call per row per fire.
Then `scheduleWake` consults `nextWakeAt(all)`, which floors any past-due
instant at `now + 5000`. So ONE such row — produced by a delete in Gmail's
own UI, by a sign-out that leaves `snoozed` behind (auth.js's clear list
has no `snoozed`; `endAccountSession` likewise), or by a backup RESTORE
(`snoozed` is `backup:true` in the registry — restoring onto another
account imports foreign rows by design intent for portability) — puts the
worker on a ~5 s alarm cadence for eternity. Chrome floors alarm cadence
(~30 s in practice), which makes this warm rather than hot: ~2 worker
wakes/minute, each attempting N doomed modifies, plus quota-bearing API
calls when signed in as the wrong account round-tripping 404s. The AUD-L1
fix (finite guard + floor) correctly removed the NaN crash and inherited
this loop intact. Direction: classify failures — terminal (404/410)
removes the row with an activity note; and/or retire rows after K failed
wakes or a max age; and/or take `snoozed` into the sign-out clear set
(with the house rule honoured: behind a setting, or by scoping rather than
deleting).

**G-2 — R2-L6: three floating-promise edges.** (a) index.js:715
`.catch?.()` with NO handler — `Promise#catch(undefined)` rethrows on
rejection, so the guard is decorative (contrast line 745, which passes a
handler); (b) `notifications.onClicked → openGmailTab()` un-awaited,
un-caught; (c) `wakeDue().then(scheduleWake)` — a rejected
`alarms.clear`/`create` inside `scheduleWake` surfaces as an unhandled
worker rejection at every startup. None reachable in happy-path Chrome;
each is one crippled context (the environments this project actually
meets) from worker noise. A shared `voidSafe(p)` helper would make the
intention grep-able.

**G-3 — R2-L1: the tripwire's own scoreboard wipes itself (REPRODUCED).**
`diag.js` counters are per-incarnation by design ("a crash loses the
current window" — honest) — but `persistDiag` OVERWRITES storage rather
than merging. Reproduced with two cache-busted imports (two
"incarnations"): 100 requests flushed, next incarnation flushes after 1 —
the persisted record regresses 100 → 1, and `mismatchClears` (the number
a support conversation consults to prove AUD-C1 fired) vanishes to 0. The
flush should read-merge-add, or the registry/docs should declare the
stored blob "current incarnation only" (today the registry reason says
"lossy", not "regressing").

**G-4 (acquittal):** AUTH_RETRY_ALARM arming is correctly single-shot:
`runAuthRetry` frees the flag regardless of outcome; Chrome collapses
same-named alarms so tab+worker double-arming is one wake; a dead network
re-arms only on the NEXT transient. Read against the alarm handler
(index.js:730-740). The retry finally keeps the promise its comment made.

---

## H. Dependency findings

- `npm audit` / `--omit=dev`: **0 vulnerabilities** (run today against the
  lockfile; node_modules intentionally absent in this sandbox).
- Runtime dependencies: **none** (extension code is zero-dep by law); all
  six devDependencies are dev tooling only. Caret ranges float on
  reinstall, but `package-lock.json` pins exact versions and CI installs
  from it.
- `typescript ^7.0.2`, `jsdom ^24`, `playwright-core ^1.62.1` — versions
  plausible and internally consistent; `npm run types` clean per the P3
  session (not re-run here; deps absent).
- The headless-shell + apt-lib set used by `ci-smoke` is cache-excluded
  and re-fetched per session — environment cost, not a defect.
- **Watch item (no CVE, process):** the v3 audit's NEW-1 (102/103 then
  SIGABRT at `--max-old-space-size=1400` in `app.integration.test.mjs`,
  reproduced twice by them) was NOT re-run here per the house rule
  banning local full-suite runs. If a CI runner ever drops below the
  heap ceiling, "green CI" flaps for infrastructure reasons while looking
  like a product failure. Options stand as theirs: raise that file's heap
  in `test:ci`, then chase retained references in the jsdom boots.

---

## I. Sync findings

- Round-1 acquittals re-verified (D-1/D-2 here): cursor, fate-map,
  overflow, resync triggers all hold.
- **Concurrency across entry points (checked):** the AUD-M3 single-flight
  covers sweep-vs-sweep only. A verb-driven `SYNC_DELTA` can interleave
  with `SYNC_ALARM`'s — adjudicated SAFE in D-6 (superset-cover argument,
  idempotent replays). The notification dedupe is single-writer (only the
  sweep notifies), so the M3 fix is complete where it matters.
- **R2-L2 (taxonomy):** `batchMetadata` receives `fetchRetrying`'s
  pass-through 401 and parses the error body as multipart → empty →
  throws `batch metadata returned nothing for N ids`. It never reaches
  `api()`'s renew-once. Self-heals next round (the first `listIds` via
  `api()` forces renewal), so the price is one failed sync round plus a
  misleading error string in any log — but a diagnostics story that
  mis-diagnoses auth as emptiness is the exact class AUD-M1 was fixed
  for, one layer down.
- v3 NEW-2 (`anchorHistory` is caller-enforced) upheld as INFO: pin the
  invariant in a contract test before a third caller appears.

---

## J. Storage / EmailStore findings

- Caps everywhere re-censused: store 2000 (full-DOM ceiling acknowledged),
  cache 500, body floor, notified 100 (freshest-first merge), claims GC +
  TTL, diag = 5-key closed set. **Two stores have no eviction at all:
  foreign outbox rows (by design — but unseen, F-3) and unwakeable snooze
  rows (G-1).** Both became observable this round precisely because the
  identity controls made "rows nobody will act on" a normal state.
- Registry census is complete for every key this round read (settings and
  domains), and the P0–P3 keys carry `backup:false` + hazard naming.
- `snoozed: backup:true` is a deliberate portability choice and the
  import-path of G-1's cross-account rows: flagged, not vetoed.
- v3 NEW-3 upheld: account-scoped state is clear-on-transition; the fence
  is a manually-maintained list per teardown site. R2-L4 shows the list
  already leaks at the edges (orphan stamp). A single
  `ACCOUNT_SCOPED_KEYS` constant consulted by BOTH auth.js and
  `endAccountSession` would make the fence self-maintaining.

---

## K. UX / accessibility findings

- **R2-L7/F-3** is the headline: the queue's most confusing state is
  invisible by construction.
- R2-L5: `activeAuthUser` is stamped at app BOOT, so with two accounts'
  takeovers open, the "prefer the session's account" law prefers whichever
  app loaded most recently — honest degradation, but the stamp's name
  over-promises activity. One-line rename (`lastBootAuthUser`) or a
  visibility-change refresh would true it.
- Machine codes (`ACCOUNT_CHANGED`, `AUTH_RENEW_TRANSIENT`,
  `NOT_SIGNED_IN`) travel as `err.message` and can surface raw in
  toasts/banners on the fallback path; the gates translate, the toasts
  don't always. LOW.
- No new a11y defects this round; the audit gate (contrast AA) verified
  green per the P3 session; not re-run here (env).

---

## L. Performance findings

- R2-M1 (250 ms verb loop) and R2-M3 (perpetual wake cadence) are this
  section's body; both are correctness-shaped performance defects.
- Census otherwise unchanged from round 1's: bounded caches, notify-once
  batches, idle-deferred saver, capped batching. No new hot paths
  introduced by P0–P3 (counters are O(1); the profile-fetch adds one GET
  per silent renewal, ~hourly).
- Store/list full-DOM at the 2000 cap remains the known scaling wall
  (their AUD2-I2 concurred) — windowing is the Q-roadmap, not a defect.

---

## M. Test-quality findings

- Honesty re-verified: 1,890 declared = README's two spots; 0-skip rule;
  CI 10/10 green at HEAD.
- **Gaps this round's findings define** (pin specs for whoever implements):
  1. F-1: `nextWakeIn` under a foreign-stamped due row → either account-
     aware (new arg) or a documented exclusion; pin the no-loop property
     at the rails seam.
  2. F-2: worker pump emulation (the harness already exists —
     account-identity.test.mjs drives `_testHandle`): 8 foreign + 1 own →
     own dispatches within 2 rounds.
  3. F-3: any pump result with `wrongAccount > 0` produces a visible row
     state.
  4. F-4: same-error short-circuit across a save/load round trip.
  5. G-1: terminal failure (404) retires the snooze row; finite rows
     bound the alarm cadence.
  6. G-3: `persistDiag` merge: two incarnations → counters never regress.
  7. E-2: sign-in stamp vs racing sign-out → no orphan `accountEmail`.
  8. AUD2-H1: fallback `SYNC_PAGE` with `labelName` resolves via
     `ensureLabel` and never lists INBOX.
  9. AUD2-H2: post-timeout, the worker pump and the in-page pump cannot
     both dispatch one row (lock sharing, or no-replay rule).
  10. E-3/AUD2-H3: stamped row + proven-stampless session ⇒ refuse.
- v3 NEW-1 is the suite's own infra risk (§H).

---

## N. Maintainability findings

- The comment law mostly holds; **two comment-vs-code divergences found
  this round, both fixed-in-report only**: the `to:` justification
  (AUD2-M2, factually false) and `_fullError` identity (F-4, save-strips
  it). In this repo, a wrong WHY-comment is a defect class of its own —
  future readers trust them.
- idb.js remains a staged, test-pinned, consumer-less adapter; the
  recorded defer (plan doc → windowing milestone) is honoured. Keep the
  N1 row open until that milestone.
- `main.js` at 3,842 lines keeps growing (house rule prefers new small
  modules; the P0 work did extract `endAccountSession`). No action beyond
  the standing rule.

---

## O. Release / migration findings

- Settings schema gained `clearOutboxOnSignOut` (def true) — migration
  story by default-value; verified at settings.js:127.
- Legacy outbox rows (unstamped) dispatch by deliberate asymmetry;
  LEGACY snooze rows with damaged `at` are now filtered by all three
  readers (`due`/`pending`/`nextWakeAt`) — but see K in round-1 terms:
  **a filtered row is invisible in the Snoozed view AND unwakeable** (the
  round-1 summary's open thread). Confirmed still true at HEAD: there is
  no quarantine/repair path for damaged rows; `loadSnoozed` returns them
  raw and the readers drop them silently. LOW, and FY-1-shaped: repair
  belongs with G-1's retirement pass (one prune point at load).
- No other schema changes P0–P3.

---

## P. Recovery & observability findings

- Diag counters exist (Q1 closed) — and G-3 shows the persistence is
  self-erasing; the one counter that demonstrates the tripwire
  (`mismatchClears`) is the one a support session would read AFTER a
  restart. P0 the merge fix, it's small.
- v3's standing INFO concurred: the live inbox has still never been the
  acceptance test; the "Status code: 2" root cause remains undiagnosed
  (mitigated by fallback). Both noted; neither is code.
- The stuck-send toast (`newlyStuck` diff) still covers the main silent
  class; the foreign-account class (F-3) is its sibling.

---

## Q. Improvement opportunities (not caused by current bugs)

1. `login_hint`/`hd` on the auth URL (AUD2-M3): steer the mint toward the
   session account; detection stays the backstop.
2. Bidi scrub in `cardText` (E-4): one character class.
3. `ACCOUNT_SCOPED_KEYS` single-list fence (J / v3 NEW-3).
4. `voidSafe(p)` promise hygiene helper (G-2).
5. Contract pin for `anchorHistory` (v3 NEW-2).
6. A one-time `snoozed` janitor at load: repair `at` (from `snoozedAt +
   default`) or quarantine visibly (O-section).
7. Rename/refresh `activeAuthUser` per visibility (K).

---

## R. Recommended phased roadmap

**R2-P0 — user-correctness blockers (behaviour changes):**
- AUD2-H2: never replay mutating verbs after timeout (non-idempotent set:
  OUTBOX_PUMP, SEND, SAVE_DRAFT, BULK, triage verbs) OR make the worker
  pump acquire `outboxPumpLock`. One of the two, with pin 9.
- AUD2-H1: extract the worker's labelName resolution (incl. the AUD-M1
  "only Could-not-create is honest-empty") into a shared helper both
  routers call; pin 8.
- E-3/AUD2-H3: refuse a stamped row when the session is PROVEN stampless
  (post-sign-in stamp failure), keeping the legacy-unstamped pass; pin 10.
- R2-M1+F-3+R2-M2 as ONE fix: make `nextWakeIn`/the pump batch
  account-aware (exclude or deprioritise non-dispatchable rows), and
  surface `wrongAccount` in the rail; pins 1–3. (Fixing the loop without
  the surface would hide the blockade; do both halves.)

**R2-P1 — lifecycle hygiene:**
- R2-M3: terminal-vs-transient classification in `wakeDue` + a retirement
  rule + the O-section janitor; pin 5.
- R2-L1: `persistDiag` merge-on-flush (or honest registry wording); pin 6.
- R2-L4: epoch re-check around the sign-in stamp; pin 7.
- R2-L6: `voidSafe` sweep at the three sites.

**R2-P2 — truth-telling sweep:**
- Fix the two false comments (N), AUD2-M2's `to:` against stored To/Cc,
  v3 NEW-2 pin, `to:` test coverage in Sent.
- AUD2-L2: fail closed on absent `sender.id` unless a documented
  exception exists.

**R2-P3 — process:**
- Rotate the PAT (13th reminder; v3 NEW-6 independently concurs); prefer
  a credential helper the tooling uses but never prints.
- Decide LICENSE (AUD2-L4); land or close the two audit branches (post-p3
  is green and should merge its file + row; independent-v3's file needs an
  index row to pass its own gate).

---

## S. Assumptions and unverified items

- **Not re-run this round:** the full local test suite (house rule —
  bounded chunks only; deps absent this sandbox anyway), jsdom boots, the
  headless smoke, `npm run types`. Authoritative counter-witness: CI run
  31840618381 green 10/10 at the audited HEAD. v3 NEW-1's local OOM is
  therefore carried as infra-risk, unconfirmed here.
- **R2-M2's emulation** replicates the index.js loop's selection
  arithmetic verbatim over the real pure functions; it does not boot the
  real worker handler end-to-end (the harness for that exists — pins 2/9
  specify using it).
- Chrome's alarm flooring (~30 s minimum in current builds) is asserted
  from platform documentation, not measured here; G-1 is reported with
  the 5 s arithmetic AND the floored cadence so either way the loop is
  perpetual.
- The two parallel audit branches were read as evidence; their CI failure
  modes were diagnosed only to the depth of "missing index row" for
  independent-v3 (the post-p3 branch is green).
- OAuth consent, real Gmail history semantics at scale, Brave's worker
  registration, real OS notification rendering: never verifiable in this
  sandbox, as in every round.
- The `audit/*` branch trio beyond the two read (external-systemwide,
  independent-v3) showed no unique file diffs vs main at fetch time.

---

*Round 2 closed: additional traversal of this tree is now very likely to
re-derive the seams above rather than open a materially different class —
the identity fences are in, and everything left is about what meets the
rows the fences refuse. Awaiting the owner's pick from R before any
remediation commit.*
