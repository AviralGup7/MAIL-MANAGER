# Novel-defect audit — 50 findings (post-remediation round)

Explicit charter for this round, per the triage: **all historical findings are
considered fixed and are NOT re-reported.** Everything below is either (a) a
defect introduced or exposed by the post-P0/P1/P2 work, or (b) a genuinely
new observation in code previous audits did not reach.

Severity: **S**evere · **M**oderate · **L**ow. Nothing in this round is
Critical — the codebase has matured; the distribution below is the proof.

---

## I · Outbox, pump & dispatch (the newest code)

1. 🆕 **M — Held sends queue BEHIND failed retries.** `dueItems` answers in
   storage order and the pump takes the first 8. A queue saturated with
   retrying failures defers a fresh user send to the next batch. Priority
   should be: `held` (a human just pressed send) before `failed` retries.
   `src/background/index.js` OUTBOX_PUMP.

2. 🆕 **L — The 250ms `more` re-arm races the running pump.** While the
   worker is still mid-batch, the re-armed pump fires and answers
   `{skipped:true}` from the single-flight guard — a wasted round trip per
   batch. Re-arm from pump COMPLETION, not a fixed delay. `src/app/app.js`
   pumpOutbox.

3. 🆕 **L — The repeated-error short-circuit compares TRUNCATED strings.**
   `markFailed` slices errors at 200 chars before storing AND before
   comparing; two DIFFERENT long errors sharing their first 200 characters
   read as "the same failure twice" and go stuck early. Compare full, store
   truncated. `src/app/outbox.js`.

4. 🆕 **L — `retryNow` keeps the previous error.** When the forced retry
   fails identically, the short-circuit sends it straight to stuck and
   `statusOf` shows "attempt 4 of 4" — the user pressed Retry and got
   zero visible attempts. Correct mechanics, broken impression; reset the
   stored error on retryNow. `src/app/outbox.js`.

5. 🆕 **L — `sentIds` mixes two id spaces.** The worker path contributes
   Gmail message ids; the fallback runner falls back to outbox QUEUE ids.
   The activity log cannot tell which space an entry lives in. Prefix or
   namespace them. `src/background/index.js`, `src/app/outbox.js`.

6. 🆕 **L — No integration path simulates a hydration failure.** The harness
   pump never throws inside dispatch, so the throw → `markFailed` → stuck
   chain introduced with P0 has unit pins only. Add a `failHydration` knob.
   `test/app.integration2.test.mjs`.

7. 🆕 **L — Crash restore silently drops chosen attachments.** The filter in
   `openCompose` correctly discards data-only entries on restore, but the
   "Restored from your last session" toast never mentions the loss. One
   clause of honesty is cheaper than the support question.
   `src/app/compose.js`.

8. 🆕 **L — GET_DRAFT argument drift between verb tables.** The worker reads
   `msg.id`; the fallback reads `msg.id || msg.messageId`. Two shapes for one
   verb is how a caller eventually feeds one table the wrong key.
   `src/background/index.js` vs `src/app/fallback.js`.

9. 🆕 **L — The `messageId` stamp's fallback is unpinned.**
   `messageId: body.id || msg.id` — if `extractBody` ever regresses to omit
   `id`, the stamp silently reuses the REQUEST id and hydration fetches the
   wrong message's parts. Pin the stamp to the draft's own id.

10. 🆕 **M — The pump budget pair is verified by no test.** `MAX_PUMP_BATCH
    = 8` and `VERB_TIMEOUT_MS.OUTBOX_PUMP = 300000` are a matched pair —
    eight worst-case sends must fit inside the timeout — and nothing asserts
    the relationship. Either constant can drift and degrade whole sessions
    to fallback (the exact failure the cap exists to prevent).

## II · Wire & auth edges

11. 🆕 **M — Cancel can be resurrected by the pump (race).** The worker
    pump loads the queue once, then walks it with awaits between items.
    A `cancel()` that lands between the pump's load and the item's
    `sending` write removes the record from storage — and the pump's next
    `saveOutbox(items)` writes its stale in-memory array back, reviving the
    cancelled message and sending it. Narrow window, but the prize is a
    message sent AFTER the user cancelled it. Mitigated this round by
    re-checking each item against storage immediately before dispatch; the
    irreducible remainder needs transactional storage to close fully.
    `src/background/index.js` OUTBOX_PUMP vs `src/app/outbox.js` cancel().

12. 🆕 **M — Room-change extraction takes the FIRST room mentioned.** A
    notice saying "leaving 5105, class will be held in 6101" yields 5105 —
    the OLD room. The extractor should prefer the room nearest the change
    verb ("held in / shifted to"), not the first digit in the text.
    `src/app/timetable-mail.js`.

13. 🆕 **L — Send-path peak memory is ~4× the payload.** `buildMime` builds
    the whole MIME string, then `b64urlEncode` re-encodes it, then
    `JSON.stringify` wraps it — a 25MB attachment peaks well over 100MB in
    the worker, which MV3 can kill mid-send. Chunked encoding would bound
    it. `src/background/gmail.js`.

14. 🆕 **L — `history()` forces a resync when page 11 exists, even if it was
    the last page.** Safe (resync loses nothing) but after a busy week away
    the app pays a full resync that one more page would have avoided. Raise
    the cap or stream-and-continue. `src/background/gmail.js`.

15. 🆕 **L — `backoffMs` honours `Retry-After` as seconds only.** The
    HTTP-date form (legal, and what some proxies emit) is ignored, falling
    back to exponential — a polite server's explicit date gets guessed
    around. `src/background/gmail.js`.

16. 🆕 **L — MIME construction is per-byte string concatenation.** Combined
    with #13, the send path's worst case is both CPU- and memory-bound on
    the largest legal attachment. Same fix family. `src/background/gmail.js`.

## III · Persistence & storage

17. 🆕 **M — `settings.set()` swallows storage-write failures.** The cache
    updates, the write dies, and the value silently REVERTS at next boot —
    the user changed a setting and it "didn't take", with no signal anywhere.
    The cache-quota path grew an `onError` reporter (P-7); settings have
    nothing. `src/app/settings.js`.

18. 🆕 **L — `outboxClaims` accumulates dead entries forever.**
    `releaseClaim` runs only on the success path; a failed or crashed dispatch
    leaves its claim in the map permanently. The TTL gates freshness but
    nothing garbage-collects the corpses. `src/app/outbox.js`.

19. 🆕 **L — `imageAllow` grows without bound.** One sender per
    "always load images" click, nothing ever trims; a year of clicking is a
    permanent list. Cap or prune by last-used. `src/app/app.js`.

20. 🆕 **L — Saved views are unbounded in COUNT.** Names are capped at 40
    characters; the collection itself is not. Hundreds of views inflate
    storage and every palette walk. `src/app/saved-views.js`.

21. 🆕 **L — Abandoned snoozes retry forever.** If the snooze label is
    deleted on Gmail's side, `wakeDue`'s modify fails and the entry stays,
    retried on every sweep — permanent silent churn. After N failures,
    surface it. `src/background/index.js`.

22. 🆕 **L — Restoring a backup on a DIFFERENT account resurrects snoozes
    for message ids that don't exist there.** `wakeDue` then retries 404s
    per sweep (sibling of #21, reached via backup). Validate ids against
    the account on import, or scope the snoozed key by account.
    `src/app/backup.js`.

23. 🆕 **L — Query history dedupes by exact string.** Case variants
    ("Fee" vs "fee") both persist; history slowly fills with near-duplicates.
    Normalise the key. `src/app/suggest.js`.

24. 🆕 **L — The crash-draft slot never expires.** A draft abandoned last
    semester is offered on every boot until dismissed. Age it out (with a
    way back via backup) or timestamp the offer. `src/app/draft-store.js`.

## IV · UI state & interaction

25. 🆕 **M — Worker recovery does not remove the degradation banner.** The
    probe sets `workerDown = false` and toasts "Background worker
    recovered", but the amber `sw-warn` bar stays until hand-dismissed — the
    UI simultaneously claims the service is dead and recovered. Remove the
    bar on recovery. `src/app/app.js` scheduleWorkerProbe/showWorkerWarning.

26. 🆕 **L — The new-mail pill accumulates across deltas while scrolled
    down.** A user reading mid-list sees "12 new — jump up" grow with every
    refresh, counting mail they already watched arrive. Reset on visibility,
    not only on reaching the top. `src/app/app.js`.

27. 🆕 **L — No keyboard path into a collapsed conversation.** j/k treats a
    thread atomically; reaching the second message requires the mouse.
    Enter-to-expand (or right-arrow) would close it. `src/app/app.js`.

28. 🆕 **L — Attachment chips wrap without bound.** A draft with 20 files
    inflates the compose panel indefinitely; no scroll or collapse.
    `src/app/compose.js` renderFiles.

29. 🆕 **L — Unknown icon names render empty, silently.** `PATHS[name] || ''`
    means a typo in an icon name is an invisible blank button with no
    console signal. Warn once in dev. `src/app/icons.js`.

30. 🆕 **L — Density never reaches the reader iframe.** The list obeys the
    setting; the body frame's typography is fixed at 15px/1.65. Compact-mode
    users get a mismatched reading surface. `src/app/app.js` renderBody.

31. 🆕 **L — Snooze offers presets only.** No custom date/time — "after
    exams" means picking the nearest preset and re-snoozing. Gmail parity
    gap, cheap to add beside the presets. `src/app/app.js` snooze menu.

32. 🆕 **L — The activity viewer has no filter.** Answering "what did the
    rules do" means eyeballing up to 500 lines. A verb filter is one input.
    `src/app/activity-ui.js`.

33. 🆕 **L — Success toasts replace failure toasts within one episode.** A
    pump that fails then succeeds in quick succession shows only the
    success; the "Outbox paused" warning is overwritten, not resolved.
    Drain or queue distinct kinds. `src/app/app.js`.

34. 🆕 **L — Compose still uses native `confirm()`** while the rest of the
    app moved to the in-app `dialog.js` primitive. Same action, two voices.
    `src/app/compose.js`.

## V · Classifier & academic pipeline

35. 🆕 **L — Score-tie resolution is untested.** Two rules finishing level
    go through `resolveConflict`; no test pins the tiebreak's determinism.
    A tie that flips between syncs would reclassify the same mail twice.
    `src/classify/index.js`.

36. 🆕 **L — Timetable entry history is unbounded.** Every mail-driven
    change appends; a semester of revisions inflates the single storage
    blob. Cap per-entry history like the activity log does.
    `src/app/timetable.js`.

37. 🆕 **L — `parseDaysHours` assumes `S` = Saturday.** The day-token map is
    asserted against nothing in the source legend; a document using `S` for
    Sunday would be silently mis-slotted. Verify against the document or
    mark `S` ambiguous (unresolved). `src/app/timetable.js`.

38. 🆕 **L — Notice surfacing caps at 3 per batch.** `scanForNotices` with
    `limit: 3` drops a fourth legitimate notice from the same sync without a
    trace. Overflow should queue, not vanish. `src/app/notices.js`.

## VI · Test architecture

39. 🆕 **L — Two integration harnesses duplicate `respond()`.** Every verb
    change must now be patched in TWO files (OUTBOX_PUMP and sentIds both
    needed double edits this round). Extract the shared fake worker into
    `test/helpers/` before the halves drift.

40. 🆕 **L — The harnesses drifted at birth.** Part two's GET_DRAFT carries
    the attachment contract; part one's does not. Same verb, two shapes —
    the exact class of defect the parity suite polices in production.

41. 🆕 **L — Integration can only ever assert attachment METADATA.** The
    harness records the pre-hydration draft, so "the bytes reached the wire"
    is unit-pinned only. A fake `hydrate` hook would let integration see the
    full flow.

42. 🆕 **L — `platform/storage.js` has zero direct tests.** The STORAGE
    proxy's this-binding and session-fallback behaviour is exercised only
    indirectly; a regression there touches every module at once. One small
    suite would pin the seam the whole tree now stands on.

43. 🆕 **L — Behavioural parity exists for no verb.** All parity pins are
    source-text. A table-driven "same input → same observable output across
    both handlers" harness would have caught GET_INLINE's shape bug without
    anyone writing a pin first.

44. 🆕 **L — This round's new tests were never sabotaged.** The autosave-size
    and preservation-flow tests shipped without the mutation pass the project
    applies elsewhere; only the four pins were sabotage-verified.

45. 🆕 **L — `bench.mjs` is not wired to CI.** Classification/store cost can
    regress invisibly; the benchmark runs only by hand. Add a threshold job.

46. 🆕 **L — The live-binding lint's paren/brace carve-out is ad hoc.** Each
    new false positive grows the special case; the rule wants a real
    scope-aware check before it becomes its own source of bugs.
    `test/architecture.test.mjs`.

## VII · Contracts & semantics

47. 🆕 **L — Two-character searches only match exact tokens.** "ps" — a real
    category name — finds nothing unless some message literally tokenises
    "ps". The index says nothing, the overlay needs 3+ chars, and no hint
    points at `category:`. `src/app/store.js`, `src/app/server-search.js`.

48. 🆕 **L — `describeQuery` hides the calendar-month semantics.** The
    under-search summary prints `older_than:1m` raw; after the bug-hunt #8
    fix that means a CALENDAR month, and the user has no way to know.
    Render the effective cutoff date. `src/app/query.js`.

49. 🆕 **L — `normalise` falls back to the forged Date header when
    internalDate is "0".** Documented as the lesser evil, but nothing BOUNDS
    it: a header from 1970 or 2090 sorts the message anywhere. Clamp the
    fallback to a plausible window. `src/background/gmail.js`.

50. 🆕 **L — OUTBOX_PUMP's response shape has no schema pin.** `{sent,
    failed, skipped, sentIds, more}` is defined independently by the worker,
    the fallback runner, and both harnesses — four authors, one contract,
    zero tests tying them together. Specific instance of #39/#43, named
    because this verb carries mail.

---

## Distribution

| Severity | Count |
|---|---|
| Severe | 0 |
| Moderate | 6 (#1, #10, #11, #12, #17, #25) |
| Low | 44 |

**Read plainly:** the P0 era is over. No finding here destroys or duplicates
mail. Of the Moderate six, two were fixed in the accompanying commit:
**#11** (cancel-vs-pump resurrection — mitigated by a per-item storage
re-check before dispatch, pin sabotage-verified) and **#25** (banner
recovery — the probe now removes the bar it made true, pin
sabotage-verified). #1, #10, #12 and #17 remain: small, contained, and
recommended in that order.

## Deliberately absent

Every fixed item from audits 41/42 (subject scrub, 401 renew, token-area
removals, draft attachments, worker-owned dispatch, inline budget, autosave
base64, sender scrub, parseDate validation, overlay lifecycle, and the rest
of the 32) is treated as CLOSED per the triage and appears nowhere above.
