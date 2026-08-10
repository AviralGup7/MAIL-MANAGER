# 28 · Comprehensive Rating — every way, scored 1–10

An outside audit of the v2 codebase as of `e378df6`, in the house style:
every claim below carries the command or reading that produced it, and
disproved suspicions are recorded in §5 rather than deleted. Unlike audits
01–27, which each examined one way deeply, this one scores **every way**
1–10 and produces the single comprehensive rating the project has lacked.

## 0 · Method

Executed in a clean checkout:

- `npm ci && npm test` → **1276 tests, 1276 pass, 0 fail, 0 skipped**
  (156.8 s). The zero-skip count matters: `tools/ci-test.mjs` makes skips
  fatal, so the suite cannot quietly shrink.
- `npm run bench` → `classify 2000: 13.1ms`, `store 2000: 38.0ms`,
  `renders triggered: 1`, `100 searches: 19.4ms`.
- Static scans: `grep -rnE "eval\(|new Function|document\.write|outerHTML|insertAdjacentHTML" src/`
  → **zero hits**; `innerHTML` → 5 hits, each read and classified (§5);
  `TODO|FIXME|XXX|HACK` in `src/` → **zero**.
- Close reading of the trust-critical path: `background/auth.js`,
  `background/gmail.js`, `background/sync.js`, `background/index.js`,
  `app/sanitize.js`, the message router, the postMessage bridges in
  `takeover/content.js` and `app/app.js`, and the list-row renderer.

**Stated limitation, up front, because this project's own TODO ranks it
above everything:** this audit did not run the extension in a live browser
against a real inbox. Everything about the browser seam (OAuth consent on
a real account, the takeover against live Gmail DOM) remains unverified by
me — I inherit TODO #1 as-is and it caps two of the scores below.

## 1 · Scorecard

| # | Way | Score | Evidence & what a 10 requires |
|---|---|---|---|
| 1 | Security architecture | **9** | Token never leaves the worker (`index.js` router is the only Gmail path; `app.html` renders hostile mail without ever holding a credential). Body iframe has neither `allow-scripts` nor `allow-same-origin` (`app.js:1949`), and the sanitiser is a real allow-list walk, not a regex chain (`sanitize.js`). All three postMessage listeners are source-checked (`content.js:214,370`, `app.js:4561`) — audit 02's asymmetric-check finding is fully closed. CSP on extension pages; host permission instead of the blanket `tabs` permission (`index.js` comment). A 10 requires the token at rest to move to `chrome.storage.session` (§2 F2) and a documented threat model for `web_accessible_resources: src/*`. |
| 2 | Auth & credential hygiene | **8** | Implicit flow with state verification, silent renewal, server-side revoke on sign-out, and a session-epoch guard against cross-account token overwrite — each with a comment naming the incident that motivated it. The per-user client ID means there is no shipped secret to leak. The score is capped by reality: implicit OAuth puts the token in a redirect fragment and yields no refresh token; the trade is argued honestly (`auth.js` header essay) and is the least-bad option Google leaves a cross-browser extension, but it is still the weakest available design. A 10 is not currently buildable on Google's platform; the remaining point is lost to the platform, not to this code. |
| 3 | Correctness & data integrity | **9** | The sync cursor discipline is the best I have seen in an extension: anchor read *before* listing (`sync.js`), cursor advanced only after every history page drains (`gmail.js history()`), inbox-only cursor anchoring, idempotent upserts making replay free, and `reduceHistory` as a single ordered fate map whose add/remove disjointness is true by construction and exported for testing. 1276/1276 confirms the surrounding behaviour. A 10 requires the live-browser pass to find what static reading cannot. |
| 4 | Gmail API integration (push/pull sync) | **8** | Real multipart `/batch` (2 round trips per 100 messages), metadata-only header allow-list, lazy body fetch, retry that honours `Retry-After` and distinguishes quota-403 from permission-403, tolerant batch parsing that drops one bad part instead of poisoning a hundred, and `historyId` pagination handled with the failure mode written down. The pull-not-push redesign (`sync.js` header) is the architectural reason the app feels fast. Capped by F4: the compose path calls `/messages/send`, which needs a scope this build never requests — the sync half is excellent, the send half cannot work as configured. Gmail **push** (`watch`) is deliberately absent because MV3 workers cannot hold a channel; polling deltas are the correct substitute. |
| 5 | Performance | **8** | Bench evidence above: one render per settled state (the invariant the architecture exists for), 51 ms for classify+store of 2000 messages. The cap is the list: every fetched row is a real DOM node (`app.js` "the count is the whole truth"), so a 3000-mail inbox is 3000 nodes; paging to 100 keeps the common case honest, but deep history is O(inbox). A 10 requires windowing/virtualisation or a "rendered window" invariant with the same honesty the count got. |
| 6 | Testing & CI | **9** | 1276 tests, zero skips, skip-fatal CI, WCAG contrast gate, benchmark gate, and a generated-files sync gate that exists because a hand-edit once silently lost 802 of 891 keys — CI as institutional memory. Fuzz-found crashes are fixed at the boundary (`normalise`, `headerMap`) with the fuzz history in comments. A 10 requires browser-level E2E (TODO #1) and a mutation-testing run wired into CI (the tool exists: `npm run mutate`). |
| 7 | Code quality & documentation | **10** | The comments are decision records, not narration: every non-obvious choice names the incident, the rejected alternative, and the cost of the trade (`auth.js`, `sync.js`, `gmail.js`, `index.js` startup self-check). 27 prior audits, retracted findings kept in place, a `why` tooling binary. Zero TODO/FIXME rot in `src/` — the debt lives in `TODO.md`, ordered by risk×impact, which is where it belongs. I give 10s rarely; the criterion is "would a new maintainer make the right change here," and the answer is yes. |
| 8 | Architecture & modularity | **8** | Stateless worker, thin router, 40+ focused modules, feature flags, rule engine with a dry run. The known wart is measured, not vibes: audit 14 found `app.js` a "control tower with extractable tenants" (4 of 24 bindings span 3+ domains) — true on my reading too, and it is why this is 8 not 9. A 10 requires the remaining tenants (reader, palette, timetable-ui glue) extracted without breaking the render invariant. |
| 9 | Accessibility | **8** | `role=listbox/option` with `aria-activedescendant` row ids (`app.js buildRow`), `aria-modal` takeover, contrast checked in CI, reduced-motion handled in the motion system (audits 24, 11). A 10 requires a screen-reader pass on the threading strip and palette, which I could not run headless and which no audit has yet executed. |
| 10 | UX & product completeness | **9** | Full mail lifecycle including spam report/rescue, trash restore, undo-everything with a 5-minute window, snooze, threading, compose with RFC 2822 threading and crash-surviving drafts, saved views, command palette, 20 search operators. Audits 07/08/12/13 show the historical gaps closed one by one with re-tests. A 10 is reserved for after the live-browser pass converts "implemented" to "observed working." |
| 11 | Maintainability & operational risk | **7** | The honest weak way. Single maintainer; bus factor one; the extension has per TODO #1 never had a full real-browser soak; the timetable pipeline is deterministic but sourced from hand-kept documents. Documentation mitigates unusually well (a new maintainer can *reason* here), but reasoning is not running. A 10 requires a second contributor with merged PRs and a standing real-inbox smoke ritual. |
| 12 | Privacy & least privilege | **9** | `gmail.modify` only — no `gmail.send` scope requested by auth (compose sends via raw RFC 2822 under modify? no: send uses `messages.send`, which needs `gmail.send`… verified: `SCOPES` lists `gmail.modify` only, and compose exists — see F4, this is either a latent scope bug or send goes through a path I flag). Metadata-only fetches, no telemetry of any kind found by scan, per-user OAuth project. A 10 after F4 is resolved. |

**Unweighted mean: 8.5. Weighted toward the security/correctness ways this
project cares about most: 8.6.**

## 2 · Findings

**F1 · Severe (process, not code): a live GitHub PAT was pasted into an AI
chat on 2026-08-10 to commission this audit.** The repo's own `TODO.md`
already carries "Revoke the GitHub PATs used to push this repo" from the v1
incident; the pattern has now repeated through a new channel. Rotate the
token used for this push before merging this PR. The code itself did
nothing wrong; the credential pipeline did.

**F2 · Moderate: access token persists in `chrome.storage.local`.**
(`auth.js persist()`.) Anything that can read extension storage reads the
grant. `chrome.storage.session` + a re-mint-on-wake path would keep the
silent-renewal design while removing the at-rest credential. The hourly
expiry bounds the exposure, which is why this is Moderate not Severe.

**F3 · Low: `decodeEntities` handles six entities.** (`gmail.js`.) `&#x27;`,
`&#NN;` numeric forms and `&apos;` pass through literally into snippets.
Cosmetic — snippets render as text in a scriptless frame — but it is the
only boundary coercion in the codebase that is visibly incomplete.

**F4 · Moderate, verified: compose cannot send under the requested scopes.**
`auth.js SCOPES` requests `gmail.modify` only (its header essay still says
"this build does not compose"), but compose is shipped: the router handles
send (`index.js:269`) and `gmail.js sendMessage()` POSTs
`/messages/send`, which Google documents as requiring
`https://www.googleapis.com/auth/gmail.send`. First send will 403;
`isQuota403` correctly refuses to retry it, so the user gets a one-line
permissions error on a headline feature. Fix is one of: add `gmail.send`
to `SCOPES` (and update the essay), or gate compose behind a flag until
the scope ships. The `friendlyAuthError` table should also gain a
`insufficient authentication scopes` entry for the token-level variant.

**F5 · Low: `web_accessible_resources` exposes `src/*` to the Gmail origin.**
Necessary for the iframe, but the whole module graph becomes readable by
the hostile page's CSP-free fetches. Narrowing to the exact files the frame
loads (`app.html` + its module tree) would shrink the published surface.

**F6 · Informational: full-DOM list.** See way 5. Not a defect today; a
ceiling tomorrow.

## 3 · What I would merge next, in order

1. Rotate the PAT from F1; then move the token to `chrome.storage.session` (F2).
2. F4: add `gmail.send` to `SCOPES` (or gate compose), update the auth essay,
   extend `friendlyAuthError` for scope errors. One-line fix, headline feature.
3. TODO #1 — the live-browser soak. Every score capped at "needs a browser"
   moves the day this happens.
4. List windowing behind the existing render invariant (way 5).

## 4 · Comprehensive rating

Twelve ways, none below 7, four at 9, one at 10. The codebase treats
comments as an audit trail, CI as institutional memory, and retracted
findings as evidence — practices that are rare individually and unique in
combination at this scale. The gaps are real: one shipped feature that
cannot work under the requested scopes (F4), a credential that should be
session-scoped (F2), and a browser seam that has not been lived in.

**Comprehensive rating: 8.6 / 10 — exceptional.** Top percentile of
extension codebases I can compare against; the distance to a 10 is a scope
line, a storage area, and mileage, none of them craft.

## 5 · Disproved suspicions (recorded, not deleted)

- **`postMessage(..., '*')` looked exploitable.** All three listeners verify
  `e.source` against the frame handle or `parent`; `'*'` as a *target* on a
  scriptless/originless frame carries no payload risk. Not a finding.
- **`innerHTML` in `app.js:951/1017` looked like XSS.** Both build static
  skeletons; all mail-derived text lands via `textContent`/`fillRow`.
  Not a finding.
- **`chrome.runtime.onMessage` router looked open to the page.** Pages
  cannot call `runtime.sendMessage`; only the extension's own contexts can,
  and none of them relay page content. Not a finding.
- **The implicit OAuth flow looked like a mistake.** It is a documented,
  argued response to Google's client-type constraints, with the v1 leaked
  secret named as the cautionary alternative. Scored in way 2, not a finding.
