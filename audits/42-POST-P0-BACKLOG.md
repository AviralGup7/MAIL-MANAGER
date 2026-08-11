# Post-P0 audit — backlog & new findings (46 entries)

Fresh hunt after the triaged backlog's P0/P1/P2 were fixed
(commit `9f3abc9`) and the other agent's `321fe34` landed. This file is the
current engineering truth: what is DONE (so nobody re-opens it), what
REMAINS from the triage, and what is NEW.

Severity: **S**evere · **M**oderate · **L**ow.
Status: ✅ fixed · 🔁 carried (open) · 🆕 new (open).

---

## A · Fixed this round — DO NOT RE-OPEN

1. ✅ **(was P0, S) Editing a Gmail draft silently deleted its
   attachments.** Fixed: GET_DRAFT stamps attachment metadata with the owning
   message id; compose carries metadata-only chips; SEND/SAVE_DRAFT hydrate
   bytes at the wire via `hydrateDraftAttachments` (worker AND fallback); an
   unrecoverable part throws, and the outbox turns that into a visible,
   retryable failure. Sabotage-verified.
2. ✅ **(was P1, S) Cross-tab outbox claim was not atomic.** Fixed: dispatch
   has one owner — the app asks the worker to `OUTBOX_PUMP`; the worker
   single-flights and drains the queue through the existing state machine.
   Fallback mode runs the in-page runner with the claim guard (documented as
   the weaker, degraded-mode semantics). Dispatch-contract pin sabotage-
   verified.
3. ✅ **(was P2, M) GET_INLINE trusted the DECLARED part size.** Fixed in
   both handlers: the budget is enforced on the ACTUAL fetched bytes;
   declared size remains a pre-flight filter only. Sabotage-verified.
4. ✅ **(new, M) Draft autosave persisted full attachment base64.** The
   charter said "crash recovery restores the text and NOT the attachments";
   the code persisted the entire collected draft, megabytes included, on
   every 800ms autosave — quota hazard plus a perf hit stringifying
   megabytes per debounce. Fixed: `storable()` strips `data`, keeps metadata,
   so preserved draft parts survive a crash refetchable. Test-verified.
5. ✅ **(report #50, L) Notification titles used the raw From header.**
   Fixed by the other agent in `321fe34` (`shortSender` scrubs control
   chars, truncates at 40).

## B · Carried backlog from the triage (still open, in triage order)

6. 🔁 **(M) Failed-outbox claim blocks other tabs until TTL — FALLBACK PATH
   ONLY now.** The worker path no longer uses claims at all (see #2); the
   residual is confined to degraded mode, where a crashed dispatcher leaves
   its claim for up to 180s. Dissolves entirely if degraded-mode dispatch
   ever moves. Don't build a mechanism for it.
7. 🔁 **(M) Crash-mid-send can duplicate.** A record left in `sending`
   (worker killed by MV3 between request and bookkeeping) demotes to
   `failed` on next load and retries — if the original request actually
   landed, the retry is a second copy. Documented, judged lesser harm; the
   only real fix is server-side idempotency keys, which Gmail's API does not
   offer. Keep watching, do not patch.
8. 🔁 **(L) Takeover Escape focus asymmetry.** The parent's Esc handler only
   fires when the PARENT document has focus; keys inside the app iframe
   never reach it. The app's own BMM_RELEASE covers normal operation. Next
   accessibility pass.
9. 🔁 **(L) Renew-retry double trigger.** `scheduleRenewRetry` arms both an
   `online` listener and a 60s timeout; both can fire `getToken()`.
   Single-flight makes it harmless. Touch only inside an auth-lifecycle pass.
10. 🔁 **(L) Cold fallback session never self-reprobes.** A session that
    STARTS in fallback only gets recovery probes after a degrade event.
    State-machine asymmetry; fix with #8-era cleanup.
11. 🔁 **(L) RFC 2047: one encoded-word, no folding.** Very long non-ASCII
    subjects exceed the 75-char guidance and render badly in some clients.
    MIME polish pass.
12. 🔁 **(L) 25MB base64 conversion builds per-byte.** Quadratic-ish for
    the largest legal attachments. Perf pass.
13. 🔁 **(M, UX) One-character search returns the ENTIRE mailbox.** Terms
    <2 chars are dropped by the index; with nothing left, `idsFor(category)`
    answers "everything". Should return nothing with an explanatory note.
    Deferred to the focused UX pass by the triage.
14. 🔁 **(L) Index tokens vs `matchesQuery` substrings can disagree.** The
    index prefix-matches tokens ≥3 chars; the overlay filter substring-
    matches raw text. Rare skew between local hits and overlay hits.
    Semantic cleanup pass.
15. 🔁 **(L) Expired-cursor detection is `String(err).includes('404')`.**
    String-matching an error message. Put the status on the error object.
16. 🔁 **(L) Cold sync pays an extra `profile()` round trip** for the
    history anchor. Could ride the first batch response. Perf pass.
17. 🔁 **(L) Background classification has no explicit budget.** Up to 500
    messages per 15-minute sweep, uncoupled from the ingest budget. Cheap
    today; profile before touching.
18. 🔁 **(L) Snoozed view staleness.** The inbox delta patches only
    unread/starred; snooze-label changes surface when the view reopens.
    Product-consistency decision.
19. 🔁 **(L) Activity log has no export.** 500 entries / 14 days then gone.
    Feature gap, not a bug.
20. 🔁 **(L) Store eviction at 2000 is silent** and leaves overrides for
    evicted ids behind while `isFull` disables the prune. Product decision:
    surface it or own it.
21. 🔁 **(L) Options import reads an arbitrary-size file straight into
    `JSON.parse`.** A multi-hundred-MB "backup" hangs the page. Add a size
    pre-check.
22. 🔁 **(L) Backup merge mode shallow-merges objects.** `categoryRules`
    and similar nested shapes replace wholesale in merge mode. Documented
    ambiguity; decide per key if merge ever matters.
23. 🔁 **(M, design) Editing a draft loses its HTML and inline images.**
    Compose is a plain-text editor, so a Gmail draft's rich body and `cid:`
    images cannot round-trip — attachments now survive (#1), the body
    becomes text. Needs a product decision (read-only warning for HTML
    drafts, or a rich editor), not a patch.

## C · New findings this round

24. 🆕 **(M) `{{course}}` template auto-value is impossible.** `autoValues`
    reads `message?.course`, but the message comes from GET_BODY, whose
    shape has no `course` field. The shipped templates use `{{course}}`
    twice; it always ships unfilled even after the replyTo wiring fix.
    Derive it from the classified record or drop the placeholder.
25. 🆕 **(L) `saveFollowups` truncates first-200 in storage order.** The
    header promises "the oldest RESOLVED entries are dropped"; the code
    slices unconditionally. At 200 follow-ups an unresolved one can be
    evicted while resolved ones survive. Either implement the promise or
    fix the comment.
26. 🆕 **(L) `pumpOutbox` swallows pump failures silently.** The catch maps
    every error to `{skipped:true}` — a broken pump shows nothing. The
    freshness line degrades, but one toast on first failure would be honest.
27. 🆕 **(L) Send activity entries record no ids.** `activity.record({verb:
    'SEND', ids: []})` — the log that exists to answer "what actually
    changed" cannot say WHICH message was sent. The pump knows the ids;
    return them.
28. 🆕 **(L) `isAcademicSender` trusts the From header.** A spoofed
    `@pilani.bits-pilani.ac.in` passes gate 1 of the timetable scanner.
    Mitigated by design (findings are proposals the user confirms, never
    mutations) — recorded so the mitigation is not accidentally removed.
29. 🆕 **(L) `TOKEN_STORAGE` is exported and never consumed.** auth.js kept
    its own `tokenArea()`. Dead seam; delete it or migrate tokenArea to it.
30. 🆕 **(L) The integration harness EMULATES OUTBOX_PUMP.** Necessary, but
    the emulation and the worker's real pump can now drift (the harness
    ignores hydration, for one). Pin the harness to the worker contract —
    e.g. a test that diffs the two dispatch loops' observable guarantees.
31. 🆕 **(L) No integration coverage of the preservation path.** The
    harness's GET_DRAFT answer carries no attachments, so the P0 flow
    (meta chip -> hydrate -> wire) is unit-pinned only. Add a draft-with-
    attachment scenario to integration2.
32. 🆕 **(L) OUTBOX_PUMP has a 300s budget but an unbounded due set.** A
    pathological queue (many stuck items + retryNow) could exceed it; the
    timeout then degrades the WHOLE session to fallback mid-pump. Cap the
    per-pump batch (e.g. 8) and let the timer re-arm.
33. 🆕 **(L) A permanently-lost attachment burns all four retries.** If the
    Gmail part was deleted, hydration fails identically four times over ~16
    minutes before the item goes stuck. Detect the repeat error and go
    straight to stuck with the real reason.
34. 🆕 **(L) Mixed time bases in the query language.** `before:`/`after:`
    dates are UTC midnights (parseDate), while `older_than:`/`newer_than:`
    calendar months compute in LOCAL time. Both defensible; the combination
    is unexplained. Pick one basis and say so in describeQuery.
35. 🆕 **(L) `profile()` failure leaves `selfEmail` empty.** The audience
    stamp (`is:direct`) and template `{{name}}` then degrade. The no-hide
    bias covers safety; the profile name could fall back to the cached
    clientId-less state or a one-time retry.
36. 🆕 **(L) The room extractor only reads 4-digit rooms.** `\d{4}[A-Za-z]?`
    misses three-digit rooms and LT-style venues; those downgrade to
    notify-only (fail-closed, so safe) — a coverage gap, not a correctness
    hole.
37. 🆕 **(L) Timetable evidence quotes can start mid-sentence.** `quote()`
    splits on `[.!?]` — abbreviations ("Dr.", "No.") break sentences, so the
    quoted evidence occasionally opens with a fragment. Cosmetic.
38. 🆕 **(L) The scanner reads quoted-reply text too.** `scanMessage` joins
    subject+snippet+BODY; a forwarded thread quoting an OLD room change can
    propose it again. Confirm-gated, but consider stopping at the first
    quote header.
39. 🆕 **(L) `signIn` persists the token BEFORE setting `authorized`.** A
    failure between the two leaves a live token with no consent flag;
    getToken throws NOT_SIGNED_IN and the gate reappears. Self-healing on
    retry; swap the order anyway.
40. 🆕 **(L) `getDraftForMessage`'s 20-page cap says "not found".** Past
    10,000 drafts the toast is "Could not find that draft" — technically
    false. Rare; fix the message, not the cap.
41. 🆕 **(L) The worker now imports app-layer `outbox.js`.** Precedent
    exists (snooze.js), but two worker->app edges make the direction a
    habit. The queue's pure core wants a `src/shared/` or platform home.
42. 🆕 **(L) `coerce` accepts any string for `string` settings.** The
    signature preference is unbounded — megabytes of signature would ride
    every send and every storage write. Cap it (a signature past ~2KB is a
    mistake).
43. 🆕 **(L) Hydrated attachment order follows the stored order** — fine —
    but a user REMOVING a preserved chip mid-edit and then hitting Undo-send
    gets it BACK (the cancelled draft still lists it). Defensible (undo
    restores what was queued); say so in the toast or strip consciously.
44. 🆕 **(L) OUTBOX_PUMP's `dueItems` uses the worker's clock.** A tab with
    a skewed clock can no longer skew dispatch (good) — but the HELD undo
    window is computed app-side at enqueue with the TAB's clock and judged
    by the worker's. Two clocks one contract; drift is milliseconds in
    practice. Note only.
45. 🆕 **(L) The harness answers SEND synthetically inside OUTBOX_PUMP.**
    `failVerbs: ['SEND']` therefore fails items per-pump (correct), but a
    test injecting `SEND` failure expecting the OLD app-side rollback path
    would misread the new architecture. Update such tests as they are
    touched.
46. 🆕 **(L) `TODO.md` still lists the 859-test figure and pre-P0 state in
    places.** The other agent refreshed most of it in `321fe34`; the count
    and the "never run in a browser" framing survive. Docs-only.

---

## Recommended order if work continues

1. **#24** (`{{course}}`) — small, visible, templates already promise it.
2. **#31** (integration scenario for preservation) — protects the biggest
   fix of this round.
3. **#32** (cap the pump batch) — one line prevents a session-degrade.
4. **#27** (record sent ids) — the activity log's reason to exist.
5. Everything else belongs to the focused UX/perf/accessibility pass the
   triage prescribed — do NOT broad-refactor ahead of it.

## Explicitly not bugs (product decisions, named so they stop resurfacing)

store eviction policy (#20), one-char search semantics (#13), snoozed delta
freshness (#18), collapsed-thread undo granularity, activity export (#19),
draft HTML round-trip (#23), crash-duplicate tradeoff (#7).
