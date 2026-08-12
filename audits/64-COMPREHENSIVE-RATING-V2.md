# 64 · Comprehensive Rating II — every way, scored 1–10

A second outside rating of the codebase, at `4e9e73d` (Round 63 close),
thirty-five rounds after audit 28's 8.6/10 at `e378df6`. Same promise as 28:
every claim below carries the command or reading that produced it, disproved
suspicions are recorded in §6 rather than deleted, and the one finding in 28
that was about *process* rather than code is checked first — because it
recurred (§2 F1).

Where 28 audited 12 ways, this one audits **15**: the three added (Design
system & visual craft, Resilience & degraded-mode design, Repo & process
hygiene) are areas the last 35 rounds built almost from nothing, and a
comprehensive rating that omits them would undersell where the project's mass
now sits.

## 0 · Method

Executed in a clean clone on Node 20.20.2, against `git status` clean and
`origin/main` at `4e9e73d`:

- **Targeted dynamic evidence** (per the house rule: fast slices locally, the
  full 8-shard suite is CI's job):
  - `npm run test:unit` → **266/266 pass, 0 skipped, 2.2s**
  - `node --test architecture + secrets + reader-security + sanitize +
    reset-registry + storage-registry + worker-dispatch + package` →
    **155/155, 0 skipped, 4.0s**
  - `node --test outbox + outbox-crosstab + outbox-send + timetable + a11y`
    → **140/140, 0 skipped, 4.1s** (the a11y suite confirmed *not skipped*:
    axe-core executed, `# skipped 0`)
  - `npm run bench` → `classify 2000: 10.3ms`, `store 2000: 35.7ms`,
    `renders triggered: 1`, `100 searches: 20.0ms`
  - `npm run contrast` → all six themes pass WCAG AA, including the AAA
    High Contrast theme
  - Total executed locally: **561 tests, 0 failures, 0 skips**, every run
    inside the 50-second local ceiling.
- **Static scans**: `grep -rnE "eval(|new Function|document.write|outerHTML|
  insertAdjacentHTML" src/` → **zero hits**. `innerHTML` → 7 hits, all read
  (§6). `TODO|FIXME|XXX|HACK` in `src/` → one hit, a *cross-reference label*
  in a comment (`background/index.js:587` names repo TODO #5), not debt.
  `console.*` → **6 calls in 84 modules** (all in the worker's startup
  self-check and error surfaces). Repo-wide secret scan
  (`client_secret` literals, `GOCSPX`, `ghp_`, `ya29.`, private-key blocks,
  excluding docs and tests) → **no live credentials anywhere**; hits are the
  documented v1 incident, test doubles, and the CI guards that police it.
  `tools/manifest-key.txt` verified to be the *public* key, byte-identical to
  the manifest `key` field.
- **Measured structure** (script in this audit's method, re-runnable):
  84 modules, 216 import edges, **0 dependency cycles**,
  **0 modules unreachable from the four entries** (app, worker, options,
  content script). Hub: `platform/storage.js` (18 dependents). Largest
  importer: `app.js` (47).
- **Size**: 27,668 lines JS + 5,731 CSS in `src/`; 27,767 lines of test
  across 70 files — a **1.00:1 test-to-source ratio**. Static test-case
  count: **1,537**.
- **Close reading** of the trust-critical path, all of it, at this commit:
  `auth.js`, `gmail.js`, `sync.js`, `background/index.js`, `sanitize.js`,
  `mime.js`, `takeover/content.js`, `fallback.js`, `reader-frame.js`,
  `platform/storage.js`, `features.js`, the app bridge and teardown in
  `app.js`, the row renderer in `list.js`, `store.js`'s batch/notify core,
  the outbox state machine, the classifier, the query engine, the themes data,
  the CI workflow, `push.sh`, `.gitignore`, `CONTRIBUTING.md`, `TODO.md`,
  `docs/ARCHITECTURE.md`, `docs/STATE-BOUNDARY.md`.

**Stated limitation, unchanged from 28 because TODO #1 is still open:** this
audit did not run the extension in a live browser against a real inbox, and
neither has anyone else. Every score that crosses the browser seam is capped
accordingly. See F8.

## 1 · Scorecard

| # | Way | Score | Evidence at this commit · what a 10 requires |
|---|---|---|---|
| 1 | Security architecture | **9** | Token still never enters the document that renders mail — the worker router is the only Gmail path, sender-verified (`index.js` `sender.id !== chrome.runtime.id` → silence). The reader frame contract is now *declared as data and asserted by tests*: sandbox flags in `reader-frame.js` (`allow-popups` only; `allow-scripts`/`allow-same-origin` named as forbidden), CSP derived from the sanitiser's own remote-image decision. Embed provenance: the takeover mints a one-time nonce into the frame URL and every handshake message must echo it (`content.js`), closing "any Gmail script can embed app.html on its own terms". `Alt+Shift+M` requires a trusted event (`isTrustedChord`). Sanitiser is the allow-list DOM walk, with per-property CSS filtering, cid resolution that scheme-checks *its own resolver's output*, and a fail-closed path that says so rather than rendering a blank mail. The vulnerable areas from 28 are all closed (§3). A 10 requires a live adversarial pass in a real browser — the thing F8 gates. |
| 2 | Auth & credential hygiene | **9** | Every 28 finding closed: the token lives in `chrome.storage.session` with a documented local fallback (`tokenArea()`), `gmail.send` is in `SCOPES` with the essay updated and forced re-consent named, `web_accessible_resources` narrowed from `src/*` to exactly `app.html`. State verification, single-flighted renewal, session-epoch guard against renewal-losing-to-sign-out (reproduced in a test), server-side revoke on sign-out, revoked-vs-transient taxonomy so a wifi blip is not a sign-out, six-setup-error table where every code carries its remedy, zero shipped secrets enforced by a test that greps the tree. Per-user OAuth project means no shared credential exists to leak. The remaining point is lost to Google's platform (implicit flow is the weakest available design, argued honestly in the header), not to this code; the last point needs the live consent screen. |
| 3 | Correctness & data integrity | **9** | Cursor read *before* listing; cursor advanced only after every history page drains and every add is fetched; inbox-only anchoring (`anchorHistory:false` for other mailboxes); `reduceHistory`'s single ordered fate-map makes add/remove disjointness true by construction; >500 adds or >10 pages degrade to resync rather than losing mail; a batch whose parts all died throws instead of painting an empty inbox. The cross-tab outbox double-send race was *reproduced from a bug report about a real duplicate, then fixed* by making the worker the sole dispatcher (round 62 M3, `outbox-crosstab.test.mjs`). Cancel-race re-checked against live storage between iterations. A 10 requires mileage (F8) — replay and reorder bugs are exactly the class that only a live mailbox produces. |
| 4 | Gmail API integration — sync & send | **9** | Two round trips per 100 messages via real multipart batch; metadata header allow-list widened to To/Cc/List headers so `audienceOf` sees real data; every fetch carries its own 30s abort budget; retry honours `Retry-After` and tells quota-403 from permission-403 *by body text*; 401 owns its renew-once path (and a fresh-token 401 throws `AUTH_REVOKED` instead of returning an error body as data). Send now works as configured (F4-of-28 closed), drafts page to 10,000 with a repeat-token hang guard, label creation races re-list, inline images are byte-budgeted on the *fetched* size because a hostile part can lie in metadata. Gmail `watch` push remains deliberately absent — an MV3 worker cannot hold a channel; pull deltas + the 15-minute worker sweep are the correct substitute, documented (F7). A 10 requires the live API's long tail: throttling shapes, historyId cliff behaviour at scale, real attachment oddities. |
| 5 | Testing & CI | **9** | 1,537 cases / 27,767 lines — one line of test per line of source, and the zero-skip rule means the suite cannot silently shrink. Eight CI shards with printed manifests whose union is the whole suite ("no test can hide between shards"), `fail-fast: off` so all shards report, action SHAs pinned. The gate set is institutional memory: contrast, bench, generated-file sync (because a hand-edit once lost 802 of 891 keys), coverage floors set just *below* measured values as regression fences, sabotage-verified tests ("a test that has never been seen to fail is a hypothesis"), failure injection across all 18 persistence entry points. The axe suite runs structural rules in CI, not just ARIA greps. Caps: F2 (the one gate measuring *paint* is soft), mutation runner exists but is not wired into CI, no browser E2E (F8). |
| 6 | Performance | **8** | Bench: 2000 messages classify+store in 46ms, one render per settled state (the invariant exists as a measured assertion, not a wish), 100 searches in 20ms. The render bench now exists and measures the four things a mail client is judged on (boot-to-rows, per-page render, scroll p50/p95, keystroke latency) in headless Chromium. List reuses real DOM nodes via id-diffing; a 3-mail delta touches 3 nodes. Known ceiling, honestly re-confirmed: the list is still full-DOM, so deep history is O(inbox) in nodes; `CACHE_MAX` 500 and the 10MB storage budget keep the cache shallow (IndexedDB migration, TODO #4, still open). A 10 requires windowing behind the same honesty invariant, and the render bench promoted from soft to hard gate (F2). |
| 7 | Code quality & documentation | **10** | The standard this project sets and still meets at 4e9e73d: comments are decision records naming the incident, the rejected alternatives, and why the weaker fix failed ("delete the line break welds the payload", "replace with space delivers to the attacker", "the cap dropped 12 recipients — caught by measuring"). Retracted claims stay retracted in place; the audits report their own false alarms. `git blame` on any non-obvious line lands on a reason, not a shrug. Zero TODO rot in `src/` — debt lives in `TODO.md` ordered by risk×impact, and even that file records what the *finished work* found. The 10 survives F4 because the criterion is "would a new maintainer make the right change": in the code, yes — every guardrail is enforced near the change, not in prose. |
| 8 | Architecture & modularity | **9** | Up from 8: the two structural findings of the earlier era are now measured closed — **0 cycles** and **0 unreachable modules** (audit 20/22's "eleven modules built and tested with no interface" is gone; wiring happened). The five-layer model in `docs/ARCHITECTURE.md` is enforced by tests, not described in hope; `platform/storage.js` is the single `chrome.*` seam (18 dependents, live-binding Proxy so test mocks can't leak); `STATE-BOUNDARY.md` pins worker≠app runtime state so no future agent "helpfully" unifies it. One storage registry, one reset registry — both with their own suites. The remaining point: `app.js` is still the control tower (47 imports, 3,459 lines — though down from 27% of the codebase at audit 09 to 12.5%), deliberately so per house rule 5 ("do not rewrite; extract proven tenants"). A 10 is the last two or three extractions landing without breaking the render invariant. |
| 9 | Accessibility | **8** | axe-core runs in CI on the booted DOM with the rule set chosen by regression history; every theme×surface pair is contrast-gated at AA (AAA theme exists); the `hidden`-vs-`display` class of bug is dead because a test asserts computed display, not the property; the listbox tree, `aria-activedescendant`, hit floors, focus restoration, and reduced-motion incl. *delays* are all tested; the takeover inerts Gmail so its dialogs can't steal focus. Two honest caps, both named by the project itself: no screen reader has ever run against it (TODO #10), and F8 means even the structural tests have never been corroborated on a live Gmail DOM. |
| 10 | UX & product completeness | **9** | The full mail lifecycle is implemented and verb-tested: seven mailboxes, threading with a strip, spam report *and rescue*, trash restore, undo-everything including send (outbox `held` state), snooze with catch-up sweeps, crash-surviving drafts, 14-operator search with server fallback (a confidently-wrong "no results" being worse than a slow one), command palette with your real labels, saved views, bulk with per-chunk reconcile named by id, rule engine *with a dry run*, activity log, backup. States are the strongest surface: six empty-state branches including the one that refuses to say "all caught up" when a mute rule hid the mail. The cap is the same as everywhere: "implemented + unit-proven" has one final conversion left — "observed working" (F8). |
| 11 | Design system & visual craft | **9** | New way, earned by rounds 21–63. Themes are data (six objects in `themes.js`), which is what makes the contrast gate possible; that gate's first run found the *main text colour* failing AA in both original themes — the strongest possible argument for the approach. CSS is 1,156 token uses against 16 hex literals, with a test failing on any literal that bypasses tokens. Type scale 120/120 tokenised; motion on four tokenised durations with a distance language matched to mass; the entrance/exit asymmetry ("23 entrances and one exit") measured and fixed; the ellipsis pattern that could never fire (missing `min-width: 0`) found by table, not eye; a 64-image real-browser screenshot matrix (6 themes × 3 densities × 4 widths) committed as reviewable evidence. A 10 requires an outside design critique and a public styleguide page; this is self-authored design held to engineering rigour — excellent, not yet externally tested taste. |
| 12 | Resilience & degraded-mode design | **9** | New way, and the project's quiet masterpiece. The in-page fallback keeps the extension a full mail client when the service worker won't register — with **verb-for-verb parity** against the worker, the same MIME parser (moved so both can share it), the same bulk chunking contract, the same label-cache clear on sign-out, governed by a probe with timeout. Alarms are nudges with catch-up sweeps so a missed timer is a late message, never a lost one. The outbox demotes a crash-interrupted `sending` to visible `failed` rather than re-sending blindly; held-first dispatch; batch-capped pumps inside the verb's time budget. Every layer of "what if this piece is dead" has a written, tested answer. One point withheld: the fallback *exists because of an unexplained production failure* — SW registration "Status code: 2" — whose root cause is still unknown (the diagnostic branch `copilot/service-worker-registration-fix`, commit `38b6a3a`, "a two-file probe, because I have guessed twice and should stop", sits unmerged). Mitigated, not solved. |
| 13 | Maintainability & operational risk | **7** | The honest weak way, unchanged and correctly self-assessed. Bus factor one: 293 commits, one author, no merged PRs from a second person. The two credential rotations the repo's own TODO ranks above *all code* — the v1 OAuth client secret in public history and the PATs — are still outstanding, and F1 shows the credential-handling pattern recurring. The timetable pipeline is deterministic but fed by hand-kept documents; the classifier's accuracy against real BITS mail is unmeasured (corrections UI is the corpus-generating fix). `npm run doctor`, `why`, `verify`, the preview tool and the docs genuinely derisk a handover — a new maintainer can *reason* here — but reasoning is not running. A 10 requires a second merged contributor, the rotations done, and one month of the live-inbox ritual. |
| 14 | Privacy & least privilege | **9** | Exactly two scopes, each tied to a shipped feature; per-user OAuth project (no embedded client to abuse); metadata-only list fetches, bodies lazy; remote images blocked by default with a per-sender allow-list — strictly stronger than Gmail's proxy, which confirms the read; no telemetry of any kind (scanned: zero analytics, beacons, or third-party calls beyond Google's own endpoints); notification cards control-char-scrubbed and sender-truncated; sign-out deletes the label-name cache, the dedupe list, the history cursor — account-scoped data named as private and scrubbed, each with a test. Host permission over `tabs` so the extension can't see your other tabs. The last point: an independent privacy pass on a live profile (what actually persists at rest after a week of real use), which needs F8. |
| 15 | Repo & process hygiene | **9** | New way. The `.gitignore` documents the v1 secret incident *in the file that prevents its recurrence*. `push.sh` solves the real measured problem (intermittent egress throttling: probe cheaply, push in a window) and redacts any PAT from git's output before it can reach a log. CI pins action SHAs. Generated classifier files carry a no-op-regeneration gate. History is 293 small, titled, numbered commits whose messages admit error ("shipped only the test fix under a too-early message"). 65 audit documents form a public record including retractions. Deductions: F3 (`playwright-core` in `dependencies`), F5 (no LICENSE), one stale investigation branch unmerged (§12), and the doc-drift of F4 sitting in the project's most-read files. |

**Unweighted mean: 132/15 = 8.80.**
**Weighted toward the ways this project itself ranks first** (security ×2,
correctness ×2, auth ×1.5, sync ×1.5, testing ×1.5): **159/18 = 8.83.**

## 2 · Findings

Ranked by risk × user impact, matching the house ordering.

**F1 · Severe (process, recurring — the same class as audit 28's F1): a live
GitHub PAT was pasted into a chat channel on 2026-08-12 to commission this
audit.** Audit 28 found the identical event on 2026-08-10. Twice in three
days, through two channels, means the weakness is not a lapse but a *pattern*:
the fastest path to "push this for me" is pasting a credential. The repo's
own TODO has carried "Revoke the GitHub PATs" since the v1 incident; the code
has never been the problem. **Rotate this token before merging this PR, and
close the class rather than the instance**: a stored `GH_TOKEN` env var or
credential-helper entry the agent can *use but never see* would make the next
paste structurally unnecessary. Recorded here rather than softened because 28
recorded its instance and the recurrence is the finding.

**F2 · Moderate: the one CI gate that measures paint can pass while red.**
`.github/workflows/ci.yml` runs `npm run render:bench || echo "…unavailable…"`.
The `|| echo` is the right answer for "Chromium could not install on this
runner" — and the wrong answer for "the scroll p95 regressed 3×": a real
failure of the benchmark exits non-zero, the echo swallows it, the check turns
green. The fix is to separate the two exits: soft-fail only when the browser
cannot launch (a named exit code from `render-bench.mjs`), hard-fail on every
threshold breach. Until then, "rendering benchmark" in the CI checks list
overstates what is gated.

**F3 · Low (hygiene): `playwright-core` is in `dependencies`.** Only
`tools/render-bench.mjs` and `tools/visual-regression.mjs` import it; nothing
in `src/` does. Every `npm ci` — including each of the nine CI jobs —
downloads a browser-automation library the extension never ships. It belongs
in `devDependencies` beside `jsdom`. (The extension remains runtime
dependency-free; the manifest ships no `node_modules`. This is developer-
surface hygiene, not a product defect.)

**F4 · Low (documentation drift, in the files this project is proudest of):**
the README still says "ten audits" and FIXING-era "633 automated tests" (the
tree holds 65 audit docs and ~1,537 cases); `audits/README.md`'s table stops
at audit 28; `docs/README.md` sends newcomers to "start at `39-*`" and no
`39-*` file exists; `TODO.md`'s "Still open" section lists threading,
undo-send and background sync as unbuilt while items 3 and 5 mark the first
and third DONE and `outbox.js`'s `held` state *is* undo-send. Small —
every one of these is one edit — but this is the codebase that treats a stale
comment as a bug everywhere else, and its documentation *is* its onboarding
surface. One consistency sweep, or a tiny doc-lint the way the CSS got one,
closes it.

**F5 · Low: no LICENSE.** The repository is public; default copyright applies,
which contradicts the inviting tone of CONTRIBUTING.md. Any OSI licence is a
one-file fix.

**F6 · Informational (carried from 28): full-DOM list.** Re-measured at this
commit: the count invariant still means every fetched row is a real node. Fine
at the current `CACHE_MAX` of 500; it is the ceiling the IndexedDB migration
(TODO #4) and windowing would raise. Not a defect; recorded so the trade
stays conscious.

**F7 · Informational: Gmail `watch` push is absent by design.** Recorded in
full so it is never re-litigated: an MV3 worker cannot hold a notification
channel, so the design is 15-minute worker deltas (which keep the cursor
fresh so absence never forces a resync) + app-open polling + alarm-driven
snooze sweeps. Polling here is the *correct* engineering, not a shortcut.

**F8 · Moderate (carried, and still the cap on half the table): the extension
has never run against a live inbox.** TODO #1, sixty-three rounds old. Every
browser-seam behaviour — OAuth consent on a real account, the takeover over
live Gmail, Brave's service-worker registration, real notification delivery —
is inference backed by contracts and jsdom, not observation. The project knows
this and ranks it first; it is repeated here because every 9 above has an
asterisk until it happens, and because the fallback's *raison d'être* (SW
registration "Status code: 2") remains undiagnosed — mitigated superbly,
understood not at all.

## 3 · Audit 28's findings — status at 4e9e73d

| 28 finding | Status | Proof |
|---|---|---|
| F1 PAT in chat | **recurred** | F1 above — second instance, 2026-08-12 |
| F2 token in `storage.local` | **fixed** | `auth.js tokenArea()` → `chrome.storage.session`, local fallback documented; `SIGN_OUT` and `forceRenew` clear the *same area* they wrote (the exact drift bug-hunt #3/#4 caught) |
| F3 `decodeEntities` six entities | **fixed** | now handles numeric (`&#39;`, `&#x27;`), `&apos;`, `&nbsp;`, and decodes `&amp;` last so one pass means one decode (bug-hunt #9 comment) |
| F4 compose can't send under `gmail.modify` | **fixed** | `SCOPES` adds `gmail.send`; essay rewritten to name the audit (V2 C-01) and the forced re-consent the scope addition triggers |
| F5 `web_accessible_resources: src/*` | **fixed** | manifest now exposes exactly `app.html`; module subresources load fine from the extension's own document — they never needed WAR |
| F6 full-DOM list | open | F6 above; unchanged ceiling |
| C-1 (audit 22): 11 wired-in-tests-only modules | **fixed** | import-graph walk at this commit: 0 modules unreachable from the four entries |

## 4 · What I would merge next, in order

1. **Rotate the PAT from F1** (and the v1 OAuth secret while the console is
   open) — the only things on any list that are already-compromised assets.
2. **TODO #1: the live-browser soak.** Everything capped at "needs a browser"
   moves the day this happens; the render bench, axe suite and fallback all
   get their final corroboration from the same ritual.
3. **F2: split the render-bench gate** — named exit code for "browser won't
   launch" (soft) vs "threshold breached" (hard).
4. **F4's doc sweep** — README/audits-index/docs-index/TODO counts made true
   again; ideally a `tools/check-docs.mjs` so the next drift is a build
   failure, because that is how this project solves *every other* class.
5. F3 and F5 (two-line fixes), then the IndexedDB migration (TODO #4) behind
   the existing platform seam — it is the one that unblocks windowing (F6),
   deeper cache, and offline reading simultaneously.

## 5 · Comprehensive rating

Fifteen ways: one 10, eight 9s, two 8s, one 7; nothing below 7. Against audit
28's twelve ways, the nine overlapping scores moved +1 on auth (two findings
closed, one platform-capped), +1 on architecture (cycles and orphan modules
measured at zero), +1 on sync integration (send works as configured), and the
rest held — no way regressed, which thirty-five rounds of change makes its
own evidence.

The thirty-five rounds since 28 were not feature accretion. They converted
the project's claims into *gates*: the render benchmark exists, the shard
manifests make the suite un-shrinkable, the coverage floors fence the modules
whose bugs were historically silent, the reader-frame contract is data that
tests assert, the state boundary has a document whose entire job is to stop a
future agent from "fixing" it. The codebase's defining trait is intact:
**comments as audit trail, CI as institutional memory, retracted findings as
evidence.**

The gaps are equally clear, and they are not craft: two credentials pending
rotation, one of them re-leaked through the same channel twice (F1); a paint
gate that can pass while red (F2); an unexplained service-worker failure
mitigated rather than diagnosed (§12); and the browser seam never lived in
(F8) — which caps every 9 on the table and is why this is 8.8 and not 9.3.

**Comprehensive rating: 8.8 / 10 — exceptional, and improving.**
Up from 8.6. The remaining distance to a 10 is the same shape as before —
a rotation, a soak, a second pair of hands — plus one new small thing the
last 35 rounds added: the project now has more gates than its documentation
remembers. Make the docs as gated as the code and the gap closes further.

## 6 · Disproved suspicions (recorded, not deleted)

- **`innerHTML` in `list.js` (rows, skeletons) looked like XSS.** Both uses
  build static literal skeletons — row chrome (`r-pick`, `r-mid`, `r-right`)
  and seven grey skeleton bars — with zero interpolated data; all
  mail-derived text lands via `setText`/text nodes/`<mark>` construction in
  `setHighlighted`, which deliberately refuses operator queries. Not a
  finding.
- **`postMessage(..., '*')`-adjacent risk in the takeover bridge.** Every
  listener source-checks *and* the app/back-channel adds origin-plus-nonce;
  the app iframe's `BMM_SHOWN` listener requires `e.source === parent`.
  A foreign embedder cannot complete the handshake because it never receives
  the nonce. Not a finding.
- **The session-storage token (28-F2's fix) looked fragile under MV3 worker
  eviction** — like the token would vanish whenever the worker dies and force
  hourly re-consent. `chrome.storage.session` is per-browser-session, not
  per-worker; eviction doesn't clear it, and the `authorized` flag stays in
  local so a browser restart is a silent renewal, not a consent popup. The
  comment in `auth.js` argues exactly this and is correct. Not a finding.
- **The 1000-char subject cap in `safeSubject` looked like data loss.** The
  cap is post-line-break cut; RFC 5322 folding means no honest Subject
  approaches it, and Gmail's API enforces its own limit at the wire. Length
  was never the attack; CRLF was, and it is stripped first. Not a finding.
- **`fallback.js` re-exposing verbs looked like a second router to keep in
  sync forever.** It is kept in sync by construction parity tests
  (`behavior-parity`, `worker-dispatch`) that caught real drift (bug-hunts
  #20–24 each named in comments). The risk is real; the control exists.
  Not a finding.
- **The soft `render:bench` CI line looked fine** ("it's just an install
  fallback"). Reading the exit semantics shows it also swallows real
  threshold failures. That one *is* a finding — F2 — recorded here as the
  one suspicion that survived measurement.
