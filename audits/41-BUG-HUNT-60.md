# Bug-hunt audit — 64 findings

Scope: full source read of `src/` (24,857 lines), manifest, HTML shells.
Method: close reading of every high-risk module (wire layer, sync, auth,
store, outbox, cache, compose, sanitize, takeover, fallback, backup, query,
deadlines, server-search) plus pattern sweeps (swallowed catches, unguarded
parses, timer leaks, innerHTML, regex-from-input, storage-key drift,
response-shape parity).

Severity: **S**evere (security / silent data loss) · **M**oderate (wrong
behavior on a reachable path) · **L**ow (edge case, latent, perf, docs).

Status: ✅ fixed in the accompanying commit · 📋 reported only (needs design
or is user-side).

---

## Security

1. **S ✅ Subject header not CRLF-scrubbed in `buildMime`.** Every other
   header goes through the safe*Header scrubbers (added after a verified
   Bcc-injection exploit), but Subject uses `encodeHeader` alone, which
   passes pure-ASCII subjects through unchanged. An ASCII subject containing
   CR/LF — typed, or inherited by Reply from an attacker-crafted inbound
   subject (`buildReply` copies it) — injects arbitrary headers at the wire.
   `src/background/gmail.js` buildMime/encodeHeader.

2. **M ✅ `api()`'s 401 renewal path is dead code.** `fetchRetrying` throws
   on every non-ok status not in RETRYABLE — 401 included — so
   `if (res.status === 401)` in `api()` can never execute. The V2 P1-10
   renew-once-on-401 fix never fires; a server-side revocation with a locally
   unexpired token surfaces as `Gmail 401 …` and signs the user out
   interactively instead of renewing silently. `src/background/gmail.js`.

3. **M ✅ `forceRenew()` removes the token from the wrong storage area.**
   SEC-5 moved the token to `tokenArea()` (session storage), but forceRenew
   still removes `accessToken/expiresAt` from `chrome.storage.local`. Even
   if the 401 branch ran, the stale token would survive and `getToken` would
   hand it back. Two independently-correct commits, one integration bug.
   `src/background/auth.js`.

4. **M ✅ `renew()`'s revocation path has the same area bug.** On an explicit
   Google rejection it removes the token keys from local storage; the revoked
   token lingers in session storage until its local expiry (up to an hour).
   `src/background/auth.js`.

5. **M ✅ `getAttachment` interpolates the part's `mimeType` into a `data:`
   URL unvalidated.** The MIME type is attacker-controlled; a hostile value
   can carry parameters or break the URL shape. Now clamped to a safe token.
   `src/background/gmail.js`.

6. **M ✅ Server search spans Trash and Spam.** `SYNC_PAGE` with `q` passes
   `labelIds: []`, so Gmail searches every mailbox; trash/spam hits merge
   into the inbox overlay and can be archived/acted-on from the wrong
   context. Now excluded with `-in:trash -in:spam`.
   `src/app/server-search.js` / `src/background/sync.js`.

7. **L 📋 GET_INLINE budgets trust the DECLARED part size.** Actual fetched
   bytes can exceed `p.size`; the budget only subtracts the declaration.
   `src/background/index.js`.

8. **M ✅ `parseDate` accepts impossible dates by rollover.** `Date.UTC`
   normalises out-of-range fields: `after:32/13/2025` silently means
   1 Feb 2026, and US-style `11/20/2025` reads as 11 Aug 2026 rather than
   failing. `before:`/`after:` then filter on dates nobody wrote. Now
   validated (month 1–12, day within the month). `src/app/query.js`.

9. **L ✅ `decodeEntities` decodes `&amp;` first, so double-encoded entities
   decode twice** (`&amp;lt;` → `<`), and only six entities are handled.
   Order corrected (& first), numeric/apos forms added.
   `src/background/gmail.js`.

10. **M 📋 Outbox claim get→set is not atomic.** Two tabs flushing in the
    same window can both acquire the claim; the residual double-send risk is
    bounded by per-tab `dispatching` + persisted `sending` state but the
    "genuinely safe coordination" bar needs worker-side dispatch.
    `src/app/outbox.js` claim().

## Silent data loss

11. **S 📋 Editing a Gmail draft silently drops its attachments.**
    `editDraft` opens without them and the next SAVE_DRAFT/SEND rebuilds the
    MIME from the local draft — the PUT updates the draft with the
    attachments gone. Needs a design decision (re-fetch parts on save, or an
    explicit warning). `src/app/compose.js` editDraft.

12. **M ✅ Undo-send loses attachments.** The undo path reopens compose with
    `openCompose(ctx, cancelled.draft)`, but openCompose never consumes
    `prefill.attachments` and `pendingFiles` was already cleared — re-send
    goes out without the files. Now restored into the panel.
    `src/app/compose.js`.

13. **M ✅ Backup exports a key that does not exist.** `EXPORTED_KEYS`
    lists `'imageAllowList'`; the app stores `'imageAllow'`. The image
    allow-list silently never backed up — the exact defect class the
    settings fix documented. `src/app/backup.js` vs `src/app/app.js`.

14. **M ✅ Backup never exports the timetable.** The user-built timetable
    (storage key `'timetable'`, timetable-store.js) is exactly the
    "invested effort" the backup module exists to protect, and it is not in
    `EXPORTED_KEYS`. Now exported/imported.

15. **L ✅ `NEVER_EXPORT` lists `'messageCache'`; the real cache key is
    `'msgCache'`.** The allow-list already keeps it out, but the documented
    guarantee names a key that doesn't exist. Corrected.
    `src/app/backup.js`.

16. **L ✅ Cache `unpack` does not coerce `date`.** A corrupt row with a
    string date passes `loadCache`'s row check and breaks `_insertOrdered`'s
    comparisons. Row validation now requires a finite number.
    `src/app/cache.js`.

17. **L ✅ A held outbox item with a corrupt/missing `releaseAt` defaults to
    0 and sends immediately on next boot** — the undo window the user
    expected is skipped. Now re-defaults to `queuedAt + hold`.
    `src/app/outbox.js` normaliseOutbox.

18. **L 📋 Store eviction at 2000 drops unread/followed-up mail silently and
    leaves their overrides behind** (prune is disabled while `isFull`).
    Bounded and self-healing on resync, but worth a surfaced notice.
    `src/app/store.js`.

19. **L ✅ `store.patch()` reindex condition omits `snippet`** although
    `tokenize()` indexes it. Latent today ("no caller patches snippet" — the
    same coincidence that already cost this project the patch/date bug).
    Fixed by construction. `src/app/store.js`.

## Worker/fallback parity

20. **M ✅ Fallback GET_INLINE returns a bare array; the worker returns
    `{ inline }` and the app reads `res.inline`** — in fallback mode every
    inline image renders as a placeholder, forever. The parity comment
    claimed this was fixed; the shape says otherwise. Now `{ inline: out }`.
    `src/app/fallback.js`.

21. **M ✅ Fallback BULK does not chunk at Gmail's 1000-id limit and returns
    the raw 204 instead of `{ failed }`** — selections over 1000 fail whole
    in fallback mode and `reconcileBulk`'s contract breaks. Now mirrors the
    worker's chunk-and-reconcile. `src/app/fallback.js`.

22. **M ✅ Fallback SIGN_OUT does not clear the label-id cache.** The P1-12
    fix lives only in the worker's handler; in-page sign-out followed by a
    different account inherits stale label ids. Now cleared.
    `src/app/fallback.js`.

23. **L ✅ Fallback SYNC_DELTA passes `msg.historyId` to `syncDelta()`,
    which takes no arguments** (it reads the cursor from storage).
    Harmless, but parity tests should pin signatures. `src/app/fallback.js`.

24. **L ✅ Fallback GET_INLINE hardcodes `20` parts / 2MB instead of sharing
    the worker's constants** — drift bait. Now imports them.

25. **L ✅ `batchModify` trusts its ≤1000 contract with no guard**; only the
    worker's BULK verb chunks. The fallback now chunks too; the wrapper
    stays documented-contract. `src/background/gmail.js`.

26. **M ✅ `selectMailbox` clears the query but not the search overlay.**
    Stale inbox overlay records survive the switch; typing a query in Sent
    (where `scheduleServerSearch` returns early and never clears) merges old
    inbox hits into the wrong mailbox's results. Now cleared on switch.
    `src/app/app.js` / `src/app/server-search.js`.

## Lifecycle & races

27. **L ✅ `backgroundSync()` is fire-and-forget inside the alarm handler
    with no catch** — a throwing `chrome.storage.local.get` becomes an
    unhandled rejection in the worker. Now guarded.
    `src/background/index.js`.

28. **L 📋 Outbox failure path never releases the claim.** If the owning tab
    crashes after marking `failed`, other tabs are blocked from the retry
    for the full 180s TTL. Bounded by design (TTL backstop) but asymmetric
    with the success path. `src/app/outbox.js`.

29. **L ✅ `getDraftForMessage` loops `for(;;)` on `nextPageToken`** — a
    repeated token from the API is an infinite loop. Now capped at 20 pages
    (10,000 drafts). `src/background/gmail.js`.

30. **L 📋 content.js Escape-to-release only fires when the PARENT document
    has focus**; keystrokes inside the app iframe never reach the parent
    listener. The app's own BMM_RELEASE covers the normal path, but the
    top-level Esc story is half-true. `src/takeover/content.js`.

31. **L 📋 `scheduleRenewRetry` arms both an `online` listener and a 60s
    timeout that both call `fire()`** — harmless (getToken single-flights)
    but the double-arm is accidental. `src/background/auth.js`.

32. **L 📋 `workerDown` recovery re-probes on `online`/idle (good), but a
    session started in fallback never re-probes on its own schedule** — only
    after a degrade. Acceptable; noted for completeness. `src/app/app.js`.

## Compose & templates

33. **L ✅ `c-bcc-row` hidden state leaks across compose sessions.**
    `openCompose` re-derives `c-cc-row.hidden` at the end but not
    `c-bcc-row` — a bcc row left open by the previous message stays open.
    Now reset like its sibling. `src/app/compose.js`.

34. **L ✅ `doSend` validates To and Cc with `invalidAddresses` but skips
    Bcc** — the same typo risk the warning exists for. Now included.

35. **M ✅ `composeMeta.replyTo` is read by the template menu but never
    written** — `{{sender}}/{{subject}}/{{course}}` auto-values are always
    null, so templates that use them ship unfilled gaps. startReply now
    passes the source message through. `src/app/compose.js`.

36. **L ✅ `readAsBase64` does `slice(indexOf(',') + 1)` with no comma
    check** — a FileReader result without a comma yields the whole data URL
    as "base64". Guarded. `src/app/compose.js`.

37. **L 📋 `encodeHeader` emits one RFC 2047 encoded-word with no length
    folding** — very long non-ASCII subjects exceed the 75-char line guidance
    and some clients render them badly. `src/background/gmail.js`.

38. **L 📋 `b64urlEncode` builds the send body with per-byte string
    concatenation** — quadratic-ish on 25MB attachments; chunked conversion
    would bound it. Perf only. `src/background/gmail.js`.

## Store / search semantics

39. **L 📋 A single-character search returns the ENTIRE mailbox.**
    `Store.search` drops terms shorter than 2 chars; with no surviving terms
    it returns `idsFor(category)` — every message "matches". The overlay
    note may still say "searching", but the local list shows everything with
    a query active. Consider returning nothing with an explanatory note.
    `src/app/store.js`.

40. **L 📋 Prefix search walks the whole inverted index per keystroke for
    terms ≥3 chars** — fine at 2000 messages, worth a sorted-token structure
    if the cap grows. Perf only. `src/app/store.js`.

41. **L ✅ `normalise` falls back to the attacker-controlled Date header
    when `internalDate` is absent/zero** — the comment above it calls the
    Date header untrusted. Fallback kept (a 1970 date is worse) but now
    documented as the deliberate lesser evil. `src/background/gmail.js`.

42. **L 📋 `store.search` and `matchesQuery` agree on fields, but free-text
    terms still match raw strings, not tokens** — "reg" matches
    "registration" in matchesQuery (substring) but only via prefix rules in
    the index (≥3 chars). A rare result-set skew between local index hits
    and overlay filtering. `src/app/store.js` / `src/app/selectors.js`.

## Sync & worker

43. **L 📋 `history()` classifies an expired cursor by
    `String(err).includes('404')`** — string-matching an error message; a
    status code on the error object would be robust.
    `src/background/gmail.js`.

44. **L 📋 `syncPage` calls `profile()` for the anchor on every fresh
    inbox sync** — one extra round trip per cold load; the anchor could ride
    on the first batch response instead. Perf only. `src/background/sync.js`.

45. **L 📋 `backgroundSync` classifies up to 500 messages per 15-minute
    run without a budget** — cheap (~4µs each) but uncoupled from the
    ingest budget discipline elsewhere. `src/background/index.js`.

46. **L 📋 Delta `patched` carries only unread/starred; label edits that
    matter for other mailboxes (e.g. SNOOZE label changes) are invisible to
    the inbox delta** — correct for inbox-only reconciliation, but the
    Snoozed view only refreshes on open. Noted.

## UI / a11y / docs

47. **L 📋 `TODO.md` item 1 says "859 tests pass"** — the suite has grown
    far past that; the number is historical but reads current. Docs only.

48. **L 📋 Reader Esc: `compose` stops propagation but other open layers
    (palette, menus, dialogs) each implement their own Esc contract** — one
    documented layer-stack Esc policy would prevent future drift.
    `src/app/layers.js`.

49. **L 📋 The body iframe is `sandbox="allow-popups
    allow-popups-to-escape-sandbox"`** — correct for link opening, but the
    escape clause means a clicked link's tab has no sandbox at all; the
    sanitiser's scheme allow-list is the only gate. It holds; noted as the
    dependency it is. `app.html`.

50. **L 📋 Notification titles use raw `m.from`** — chrome.notifications
    renders text only (no injection), but a 200-char display name pushes the
    subject off the card. Truncate the sender, keep the subject.
    `src/background/index.js`.

51. **L 📋 `openGmailTab` focuses the FIRST Gmail tab found** — with several
    accounts open, that may not be the account the notification belongs to
    (notifications carry no account index). `src/background/index.js`.

52. **L 📋 The prune-after-full-sync sweep is wired and gate-tested, but its
    three storage writes are independent** — a crash mid-sweep can persist
    pruned overrides and unpruned mutes. Each half is idempotent, so the
    next sweep converges; noted. `src/app/app.js`.

53. **L 📋 `cache.js` saver: `flush()` skips the `onError` reporter that
    scheduled writes get** — a quota failure during `pagehide` is invisible
    even when the app asked to know. Now reported. `src/app/cache.js`.

54. **L ✅ `cache.js` saver: the throttle re-arm calls `this.schedule()`
    from an arrow** — breaks if `schedule` is ever destructured off the
    saver. Now a closure call. `src/app/cache.js`.

55. **L 📋 `outbox.cancel`'s `item.state === 'sending'` branch is dead** —
    `normaliseOutbox` demotes stored `sending` to `failed` on load, so the
    check can never be true (the live `dispatching` set is the real guard).
    Harmless dead code; kept, noted. `src/app/outbox.js`.

56. **L 📋 Options import accepts an arbitrary-size JSON file straight into
    `JSON.parse`** — a multi-hundred-MB "backup" hangs the page. A size
    pre-check would bound it. `src/options/options.js`.

57. **L 📋 `query.js` day-first parsing is deliberate ("this is an Indian
    tool") but silent** — a pasted `03/04/2025` means 3 April, and there is
    nothing telling the user. A describe hint would close the loop. Docs/UX.

58. **L 📋 `timetable.js`'s unresolved-field discipline is excellent, but
    the change-log merge (`source: 'unresolved'` overwrite rules) has no
    property test for "a real value is never replaced by unresolved"** —
    the rule exists in prose; pinning it would keep it. `src/app/timetable.js`.

59. **L 📋 `selection.js` shift-range selection over COLLAPSED threads
    selects the visible rows, which is defensible, but bulk-then-undo on a
    mixed collapsed selection restores per-message, not per-thread** — the
    undo entry's granularity and the selection's granularity differ.
    Noted for the next bulk-UX pass.

60. **L 📋 The activity log caps at 500 entries / 14 days, but the viewer
    offers no export** — diagnostics disappear exactly when they'd be
    needed. Small feature gap, not a bug. `src/app/activity-ui.js`.

## Contract / test gaps found while hunting

61. **L ✅ The SEC-5 source-pin test pinned the sign-out removal list
    exactly** — any legitimate new key (e.g. `bgNotifiedIds`) breaks the
    build rather than extending it. Updated with the merge; consider pinning
    membership, not the literal list. `test/auth.test.mjs`.

62. **L ✅ The snooze "one alarm" test counted ALL `alarms.create` calls**
    and broke when the legitimate SYNC_ALARM shipped (caught this session).
    Narrowed to WAKE_ALARM. Pattern: pin the invariant, not the census.
    `test/snooze.test.mjs`.

63. **L ✅ No test pinned worker↔fallback RESPONSE SHAPES** — findings
    20/21 (GET_INLINE shape, BULK `{failed}`) survived because the parity
    suite pinned source markers, not shapes. Extended
    `test/parity.test.mjs` with shape pins for both handlers.

64. **M ✅ The R-6 selectors extraction silently broke `rules.test.mjs`.**
    Three source-text pins asserted `applyMute`'s guards inside app.js; the
    function moved to selectors.js in `dd28be3`, and the suite was not in
    that commit's affected run, so it has been red since. Repointed the pins
    at selectors.js (the behavior itself was already pinned green in
    selectors.test.mjs). Pattern: an extraction commit must run every suite
    that source-pins the moved code. `test/rules.test.mjs`.

---

## Fixed in the accompanying commit

Findings **1, 2, 3, 4, 5, 6, 8, 9, 12, 13, 14, 15, 16, 17, 19, 20, 21, 22,
23, 24, 26, 27, 29, 33, 34, 35, 36, 41(doc), 53, 54, 63, 64** — 32 fixes,
each with a targeted test or sabotage-verified pin (five core fixes
sabotage-verified: each revert fails its test).

Also found en route and fixed as part of #2: `api()`'s renew branch called
`auth.forceRenew()` with **no `auth` binding in the file** — a latent
ReferenceError that could never surface because the branch was unreachable.
Dead code hiding a crash; the named import is now the proof it is wired.

## Deliberately NOT fixed here

- 11 (draft attachments) and 63 (shape-parity harness) need a design
  decision larger than a bug fix.
- 10 (claim atomicity) needs worker-side dispatch — an architecture move,
  not a patch.
- 18, 39, 46, 59, 60 are product decisions, not defects.
