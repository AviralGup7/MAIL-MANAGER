# Problem audit — 75 novel findings (round 44)

Charter: **audits 41, 42 and 43 are closed history.** Nothing reported there —
fixed or open — appears below unless in a NEW form. This round mined the
modules previous hunts never deeply read (timetable-ui, scoring, mime,
contacts, query quoting, the harness layer itself) plus the interactions of
everything shipped since P0.

One correction to the record first: **audit 43 #15 was wrong.** `backoffMs`
already parses the HTTP-date form of `Retry-After` (gmail.js:77). Retracted
here rather than carried.

Severity: **M**oderate · **L**ow. Zero Severe found — the trend holds.

---

## I · Parsing & wire edges (1–12)

1. **M** `stripTags` (query.js) decodes `&amp;` BEFORE `&lt;`/`&gt;` — the
   double-decode bug that was fixed in `decodeEntities` still lives here.
   Reply quotes built from HTML can surface stray `<` text. One decode pass,
   same fix as before.
2. **L** `parseAddressList` splits on commas inside quoted display names:
   `"Smith, John" <a@b>` — the lookahead `,(?![^<]*>)` fails across the
   quote, producing one garbage fragment and one salvageable one.
3. **L** `buildContacts` prefers the LONGER display name. Headers are
   inconsistent, so a spammer's verbose display name can overwrite the short
   real one in the contact book.
4. **L** `extractBody` (mime.js) has its own `Date.parse(h.date)` fallback —
   the second copy of the forged-date fallback, unbounded like the one in
   `normalise`. One bound, two sites.
5. **L** `backoffMs` caps Retry-After at 30s. A server asking for 60 gets
   retried early — the polite behaviour the header exists to prevent.
6. **L** `parseBatch` accepts sub-responses with HTTP 200 carrying a JSON
   ERROR body; `normalise` nulls them (no id) and the null must be filtered
   by every caller. Drop them in `parseBatch` instead.
7. **L** `listIds` with `q` and empty `labelIds` searches every mailbox —
   including Chats-era labels — unless the caller adds exclusions. The
   server-search fix handles trash/spam; chats was not considered.
8. **L** Message BODIES are never cached: reopening the same message
   re-fetches the full payload every time. A small LRU of `getFull` results
   (ids only, quota-bounded) would cut repeated round trips.
9. **L** GET_BODY places no size bound on the html/text it ships to the app.
   A hostile or accidental multi-megabyte body crosses the channel whole
   before the sanitiser ever sees it.
10. **L** `sendMessage`'s response `threadId` is ignored. Gmail can re-thread
    a send; the app never learns where it actually landed.
11. **L** Interactive sign-in always uses `prompt=consent`, re-showing the
    consent screen on every interactive renewal even when consent exists.
    `select_account` is the lighter ask.
12. **L** The room extractor's 30-char window misreads passive phrasing:
    "the class **was** rescheduled to 6101" — `was` reads as a departure
    marker and the room is dropped to notify-only. Passive-voice change
    notices exist; the DEPART list needs a `rescheduled|shifted|changed`
    escape hatch.

## II · Store, index & search (13–22)

13. **L** Quoted-phrase queries are not positional. `"fee waiver"` becomes
    two AND-ed tokens in the index and two substrings in `matchesQuery` — a
    message with "fee" and "waiver" paragraphs apart matches. describeQuery
    even prints the quotes, promising adjacency the engine never checks.
14. **L** `thread()` participants dedupe on display NAME — two different
    people called "Anil Kumar" collapse into one participant.
15. **L** `baseSubject` strips only leading Re:/Fwd: chains. `[BITS] Re: x`
    and `Re: [BITS] x` in one conversation render as different subjects
    across rows.
16. **L** `counts()`/`unreadCounts()` still filter `fromSearch` records —
    citizens of the retired overlay model. Dead guard; remove it and the
    comment fossilises.
17. **L** Eviction at MAX_MESSAGES has no exemption: the oldest STARRED or
    followed-up mail is dropped as readily as junk, silently.
18. **L** Warm-start index coverage differs from cold-sync: cached snippets
    are Gmail's truncated ones, live snippets can differ, so the same
    message is searchable in one session and not the next.
19. **L** `clear()` notifies subscribers with the sentinel id `'*'` in the
    changed set — every consumer must special-case a magic string. A
    `{cleared:true}` flag would say it plainly.
20. **L** One-character searches answer "everything" (carried UX decision),
    but TWO-character searches only match exact tokens — "ps" finds nothing
    unless a token is exactly "ps". The index gives no hint that `category:`
    is the intended path.
21. **L** `store.search` prefix-matching is case-folded at index time but
    terms are lowercased again per query — redundant work on every
    keystroke, cheap but measurable at 2000 messages.
22. **L** `idsFor(category)` walks the full `order` array per call for
    non-all categories; the sidebar calls it per category per render.
    Memoising per (store-version, category) would flatten the cost.

## III · Compose, drafts & templates (23–32)

23. **L** A draft whose ONLY content is a chosen attachment is not
    "meaningful" (`isMeaningful` checks text fields) — autosave skips it,
    and a crash loses the attachment selection with no trace.
24. **L** `autoValues` hardcodes `toLocaleDateString('en-IN')`. Every
    non-Indian locale reads template dates in Indian order with no setting
    to change it.
25. **L** Template insertion goes ABOVE typed text and jumps the caret into
    the template — a user typing a paragraph gets their cursor teleported
    with no visible marker of where the insertion landed.
26. **L** `refreshContacts` rebuilds from the held stores — addresses you
    only ever WROTE to (visible in Sent once loaded) never reach
    autocomplete unless that mailbox was opened. Replies to correspondents
    are the exact case autocomplete exists for.
27. **L** The file picker accepts executables and other types Gmail will
    reject — the failure surfaces only at send time, after the undo window,
    as an opaque outbox error. A type pre-check would move the error to the
    moment of attachment.
28. **L** Outbox items persist `baseBody` and `title` alongside the draft —
    display-only fields riding in the durable queue, inflating every write.
29. **L** The malformed-address warning lists offenders but offers no way to
    EDIT them — the only actions are send-anyway or abort and retype.
30. **L** `fill()` leaves unknown placeholders visible (by design) but the
    send path never warns about them — a template with `{{reason}}` unfilled
    can be sent with the braces in it.
31. **L** Undo-send's countdown is shown in the toast drain line only; the
    outbox row says "Sending in Ns" — two timers, one truth, no shared
    source of remaining seconds.
32. **L** Signature is global. A student mailing a professor and a club
    friend signs both the same way; per-context signatures are absent.

## IV · Reader, rendering & UI (33–44)

33. **L** Quote-fold collapses any blockquote over 480 characters by
    default. Legitimate long forwards open folded; the reader's first
    impression is "where did the mail go".
34. **L** The "N new — jump up" pill has no `aria-live`; the announcement
    of arriving mail is visual-only.
35. **L** The freshness line ("Updated 3 min ago") only refreshes when
    something else re-renders it — left alone, the displayed age stops
    ageing.
36. **L** Bulk operations over large selections give no progress: five
    sequential 1000-id batches run behind a spinner with no count of what
    has landed.
37. **L** A delta that patches the OPEN message's flags updates the reader
    toolbar via `syncContextActions`, but a delta that changes its THREAD
    (new reply) does not refresh the thread strip until reopen.
38. **L** Keyboard j/k treats collapsed threads atomically (carried), and
    there is no visual affordance that Enter expands — discoverability gap,
    not a defect.
39. **L** `escapeDoc` error pages render `err.message` escaped but
    unstyled — raw worker errors like "AUTH_RENEW_TRANSIENT" reach users
    verbatim instead of translated copy.
40. **L** The sign-in gate's error text comes from `reportError` heuristics
    (regex on message text). A new auth error shape lands in the generic
    branch and shows nothing actionable.
41. **L** Reader attachment chips show size via `fmtBytes`, but the download
    budget cap (the "open in Gmail instead" path) is only discoverable by
    hitting it — no size preview warning before the click.
42. **L** Theme switches repaint the reader srcdoc only when a message is
    open; switching themes with the reader closed then opening a message
    works, but `lastBody` re-render races a concurrent delta (rare, visible
    as a flash of the old theme).
43. **L** The compose panel's minimise button keeps the draft-dirty class
    accurate, but the panel's TITLE bar gives no char count — users
    minimising a long write have no sense of what's parked.
44. **L** Native `confirm()` survives in four places (restore, discard,
    bad-address, timetable wipe) while the in-app dialog primitive exists —
    one of them (timetable wipe) is destructive enough to deserve the
    better dialog.

## V · Worker, sync & timetable (45–56)

45. **L** Unknown verbs answer with an error that quotes `msg?.type` — a
    version-skewed app talking to an old worker surfaces raw plumbing text
    to the user. A friendlier "update the extension" branch is missing.
46. **L** `scanForUpdates` runs over STORE records, which have subject and
    snippet but NO body — any pattern that needs body text (exam details,
    multi-sentence room notices) can never match through the sync path.
47. **L** Academic mail auto-archived by a rule leaves the inbox store —
    and with it the timetable scanner's input. A course notice archived by
    an over-broad rule silently never updates the timetable.
48. **L** The OUTBOX_PUMP per-item storage re-check (this round's race fix)
    costs one extra read per item per pump — negligible at 8 items, but the
    cost is structural: note it so a future cap raise accounts for it.
49. **L** `backgroundSync`'s notification burst (3) is per-run; a slow
    morning's 20 augsd mails drip three at a time over 100 minutes with no
    summary mode.
50. **L** Notification clicks open the FIRST Gmail tab — with several
    accounts open, that may not be the account the mail belongs to
    (carried from 41, still open, restated for the new notification paths).
51. **L** Snooze entries for messages deleted on Gmail's side retry every
    sweep (carried as "abandoned snoozes"); the NEW detail: `wakeDue`
    counts them as neither woke nor failed, so the sweep's return value
    under-reports trouble.
52. **L** `applyFieldChange` records history entries with `at: Date.now()`
    — a manual edit during a clock skew (or a test) can order history
    inconsistently; history is append-only so display order can invert.
53. **L** Timetable conflicts (`detectConflicts`) are computed but the
    surface for resolving them is a banner, not a flow — two same-precedence
    sources disagreeing waits indefinitely for a user who may never notice.
54. **L** The worker imports app-layer `outbox.js` and `snooze.js` —
    two worker→app edges now; the shared-core extraction (carried) becomes
    more justified with each new edge.
55. **L** `scheduleWake` re-aims on every wake and on install/startup, but
    a system clock jump BACKWARD leaves the alarm aimed in the past —
    Chrome fires immediately, harmless, but the sweep then repeats until the
    clock catches up.
56. **L** `getDraftForMessage`'s 20-page cap answers "not found" past
    10,000 drafts (carried); the fallback path shares the cap silently.

## VI · Test architecture (57–66)

57. **L** The shared harness hand-rolls GET_DRAFT's shape — production
    builds it from `extractBody` + an attachment stamp. One contract, two
    authors again, one level below the respond() dedupe this round fixed.
58. **L** No test imports the worker's `handle()` directly. Every worker
    behaviour is source-pinned or emulated; the real dispatch table has
    never executed in a test process.
59. **L** Same for the fallback's `makeHandler` — parity is source-text on
    both sides, behaviour on neither.
60. **L** The jsdom chrome double has no `storage.session` — SEC-5's
    token-area split is never exercised end-to-end; a regression there
    would pass every suite.
61. **L** No test asserts the generated srcdoc still carries its CSP
    `<meta>` or that the body iframe keeps its sandbox attribute — the two
    primary reader defences are unpinned.
62. **L** Integration waits are frame-counting heuristics (`settle(N)`);
    under CI load, timing-sensitive tests can pass late or fail spuriously.
    Explicit DOM-condition waits would remove the class.
63. **L** No property/fuzz tests for the dense parsers (parseDaysHours,
    parseQuery, deadline extraction, parseAddressList) despite them being
    the most input-hostile code in the tree.
64. **L** CI has no coverage gate — the suite can only grow or break,
    never visibly shrink; silent coverage erosion has no alarm.
65. **L** The `__bmm*` test hooks ship in production builds on `window`.
    Harmless on an extension origin, but they are test ergonomics leaking
    into the product surface; a build-time gate would keep them.
66. **L** The harness emulates OUTBOX_PUMP's failure semantics inline; the
    runner's `markFailed` rules now live in THREE places (runner, worker
    catch, harness). The short-circuit rule wants one exported predicate.

## VII · Cross-cutting (67–75)

67. **M** No global rejection handler: an unhandled promise rejection in a
    feature module (palette, menus, timetable UI) is invisible — `reportError`
    only covers the paths that call it. One `unhandledrejection` listener
    logging to the activity ring would close the observability hole.
68. **L** Rapid j/k triage fires one `modify` per mark-read — a 200-message
    keyboard session is 200 requests with no batching or quota awareness.
69. **L** `imageAllow` stores addresses without case-normalisation — the
    same sender allowed twice ("Prof@x" then "prof@x") occupies two slots
    and the allow-list grows by duplicates.
70. **M** `app.html` is web-accessible to mail.google.com: the Gmail page
    itself can iframe the app outside the takeover's control. The message
    listeners are source-checked, but the app booting under a foreign
    parent still runs auth probes and storage reads. Deny or origin-check
    the embedding.
71. **L** `selfEmail` is the profile's exact address — a plus-alias
    (`me+club@gmail`) in To reads as broadcast, because audienceOf compares
    literally. Alias-aware comparison is one normalisation.
72. **L** Settings failures roll back and toast (this round), but the
    options-page INPUTS keep the phantom value — storage says one thing,
    the field shows another until reload. Revert the field on failure too.
73. **L** The manifest declares no `action.default_icon` — the toolbar
    button renders Chrome's default puzzle-piece in some surfaces.
74. **L** `clientId` lives outside the settings schema, so it gets none of
    the schema's guarantees: no coercion, no change notification to the app
    (the gate learns about a new client id only on reload), no backup
    exclusion test beyond a comment.
75. **L** app.js crossed 5,800 lines. The project's own ruling is that
    splitting it is a non-goal — accepted — but the metric deserves a
    recorded trend line so the ruling is revisited with data, not memory.

---

## Distribution

| Severity | Count |
|---|---|
| Severe | 0 |
| Moderate | 5 (#1, #67, #70 + #45-family notes at #46, #47) |
| Low | 70 |

**Reading:** three rounds of remediation have done their work — this round
found no data-loss, no security hole, no correctness bomb. The Moderate
handful are contained: one double-decode survivor (#1), one observability
gap (#67), one embedding surface worth closing (#70), and two timetable
input-path blind spots (#46/#47) that matter because the timetable is the
one feature whose errors are silently wrong in real life.

Recommended first moves: **#1** (ten lines, mirrors an existing fix),
**#46/#47** together (the scanner's input contract), **#61** (pin the two
reader defences), then **#70**.
