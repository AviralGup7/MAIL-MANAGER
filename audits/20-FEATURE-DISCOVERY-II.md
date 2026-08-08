# Audit 20 — Exhaustive Feature Discovery, second pass

**Mode:** discovery only. Nothing here is ranked, costed, or rejected. The
elimination pass is a separate document, as it was for audits 16 → 17.

**This is not a re-run of audit 16.** That pass ran against a product with 27
background verbs, a query language, a classifier and a radar. Since then
thirteen new modules shipped, and *each one creates its own adjacent surface*.
A rule engine makes rule-adjacent features possible. An outbox makes send-time
features possible. An activity log makes history features possible. The
interesting question this time is not "what does a mail client have?" but
**"what is now one step away that was two steps away before?"**

Ideas that duplicate a survivor from audit 17 are excluded by construction —
those are already built or already scheduled. Where an idea *extends* one, the
entry says so explicitly.

## What exists now, stated once

- **27 background verbs**, including `BULK`, `CREATE_LABEL`, `LIST_LABELS`,
  `GET_RAW`-adjacent `GET_BODY`/`GET_ATTACHMENT`, `SNOOZE`/`WAKE_DUE`.
- **A query AST** with operators, negation, OR groups and parentheses.
- **A rule engine** (`rule-engine.js`) with conditions expressed in that AST,
  a dry run over the local corpus, batched plans and merged action sets.
- **An activity log** (`activity.js`) — append-only, ring-buffered, actor-tagged.
- **An outbox** (`outbox.js`) with held/sending/failed states and bounded retry.
- **Templates**, **follow-ups**, **deadline overrides**, **enrolment scoping**,
  **class-change detection**, **triage lanes**, **audience detection**,
  **snippet cleaning**, **search suggestions**, **versioned backup**.
- **9 settings keys**, six themes, a 15-category classifier with per-sender
  corrections, a parsed timetable (688 courses / 1681 sections).

## The four seams this pass mined

1. **The rule engine is a general execution surface.** It currently runs at
   ingest. It could run at send, on a schedule, on demand, or against history.
2. **The activity log is an untapped data source.** It records every mutation
   with an actor. Nothing reads it yet.
3. **The outbox is a general deferred-work queue**, not just a send queue.
4. **Audience + lanes + enrolment are now three independent signals** that have
   never been combined with each other.

**Format per idea:** what · problem · why possible *here* · where it lives ·
value · implementation direction · dependencies · tier.

---

## A · The rule engine as an execution surface (1–14)

*The engine currently fires at ingest only. Every entry here is a different
**moment** or **target** for machinery that already exists.*

### 1 · Rules that run on send, not just on receive
**What:** outbound rules — "if the recipient is a professor, use the formal
signature"; "if the body says *attached* and nothing is attached, block".
**Problem:** every safety and consistency check today lives in the compose UI as
bespoke code, so adding one means editing compose.
**Why possible:** `evaluate()` takes any record with the fields a condition
names. A draft has `to`, `subject`, `body` — the same shape a message has.
**Where:** the send path, ahead of the outbox hand-off.
**Value:** one mechanism for every outbound check, user-extensible.
**Implementation:** a `direction: 'out'` flag on the rule record; call
`evaluate()` in `sendDraft` before enqueueing. **Depends on:** #14's outbound
condition vocabulary. **Tier: important.**

### 2 · Scheduled rules ("every Sunday, archive read newsletters")
**What:** a rule with a cadence rather than a trigger, run by the existing
`chrome.alarms` tick that already drives snooze wake-ups.
**Problem:** cleanup is a chore people intend to do and never do. A rule that
only fires on arrival cannot tidy what already accumulated.
**Why possible:** `WAKE_DUE` proves the alarm plumbing; `idsMatching()` already
selects over the whole local corpus rather than one message.
**Where:** a cadence field in the rule editor; a "last run" line in the log.
**Value:** the inbox maintains itself between sessions.
**Implementation:** store `cadence: 'daily'|'weekly'`, keep `lastRunAt`, run at
most once per period on the next alarm. **Depends on:** #4 for safety.
**Tier: important.**

### 3 · Retroactive rule application
**What:** after saving a rule, offer "apply to the 312 existing messages that
match" — the dry run's own result set, executed.
**Problem:** a new rule only helps future mail, so the mess that motivated
writing it stays exactly as it was.
**Why possible:** `dryRun()` already returns `ids`, and `batchPlan()` already
groups them into one request per verb with one undo entry.
**Where:** the confirm step of the rule editor.
**Value:** the rule pays off immediately instead of in a week.
**Implementation:** feed `dryRun().ids` straight into the bulk path. **Depends
on:** #37's progress reporting for large sets. **Tier: important.**

### 4 · A rule budget / circuit breaker
**What:** a hard ceiling on how many messages one rule may touch in a run;
exceeding it pauses the rule and reports rather than proceeding.
**Problem:** a rule that matches more than intended is the failure mode with
the worst blast radius, and the dry run only protects the moment of authoring —
not a rule that becomes over-broad when the mailbox changes.
**Why possible:** the plan is materialised before dispatch, so its size is
known in advance.
**Where:** enforced in `planFor`; surfaced as a paused-rule banner.
**Value:** makes it safe to leave automation running unattended.
**Implementation:** compare `plan.length` against a per-rule cap; on breach
write a `RULE_PAUSED` activity entry. **Depends on:** #6. **Tier: important.**

### 5 · Rule ordering with drag-to-reorder and explicit precedence
**What:** rules evaluate in a user-visible order, with `stopProcessing`
surfaced as a "stop here" toggle on each row.
**Problem:** `stopProcessing` exists in the record and has no UI, so the one
mechanism for resolving conflicts between rules is unreachable.
**Why possible:** `evaluate()` already walks the list in order and honours the
flag — this is pure surfacing of implemented behaviour.
**Where:** rule editor.
**Value:** conflicts become expressible instead of mysterious.
**Implementation:** an `order` field; drag handle; render the flag.
**Depends on:** none. **Tier: important.**

### 6 · Rule health dashboard
**What:** per rule: how many messages it has touched, when it last fired, how
many times the user undid its work, and a "never fired" warning.
**Problem:** a rule that silently stopped matching — because a sender changed
their address — is invisible. So is a rule the user keeps undoing.
**Why possible:** `planFor()` already returns `fired` counts per rule id, and
the activity log records actor `'rule'` with the rule name in `detail`.
**Where:** a column in the rule editor.
**Value:** turns automation from set-and-forget into set-and-verify.
**Implementation:** aggregate the activity log by `detail`; store `lastFiredAt`
on the rule. **Depends on:** #15. **Tier: important.**

### 7 · Rule templates for common student workflows
**What:** a starter gallery — "file placement mail", "mute club spam during
exams", "star anything from my instructors" — each one click to install and
fully editable afterwards.
**Problem:** the rule editor is a blank page, and a blank page is why rule
engines go unused. The smart-views defaults proved the pattern works.
**Why possible:** a rule is a serialisable record; a template is that record
with a description attached.
**Where:** an "Add a rule" gallery.
**Value:** first-run value, and it teaches the condition grammar by example.
**Implementation:** a constant array; `makeRule()` already validates.
**Depends on:** none. **Tier: important.**

### 8 · Conditions on message *age at evaluation time*
**What:** `age_at_match:>3d` — a condition that becomes true with the passage
of time rather than on arrival.
**Problem:** the most wanted cleanup rule is "archive it if I haven't opened it
in a week", which no arrival-triggered engine can express.
**Why possible:** scheduled rules (#2) supply the re-evaluation moment; the
query grammar already has `older_than:`.
**Where:** the condition grammar.
**Value:** unlocks the whole class of "if I ignored it, it didn't matter" rules.
**Implementation:** no new operator needed — `older_than:` already works, it
just needs a recurring trigger. **Depends on:** #2. **Tier: optional.**

### 9 · Rules that act on threads rather than messages
**What:** a `scope: 'thread'` flag so an action applies to the whole
conversation, matching what `act()` already does for archive/trash/spam.
**Problem:** a rule archiving one message of a five-message thread leaves the
row on screen showing the next message down, which reads as failure — a bug the
manual path already fixed and the rule path repeats.
**Why possible:** `store.threadIds()` is the same lookup `act()` uses.
**Where:** rule editor toggle; expansion inside `planFor`.
**Value:** rule behaviour matches manual behaviour, which is the consistency
audit's whole standard.
**Implementation:** expand ids through the thread index before `batchPlan`.
**Depends on:** none. **Tier: important.**

### 10 · A "why did this happen to this message?" inspector
**What:** on any message, show which rules evaluated against it, which matched,
which action each contributed, and which rule stopped processing.
**Problem:** with more than three rules, the merged action set is opaque, and
the user cannot tell which rule to edit.
**Why possible:** `evaluate()` already returns `matched` — the rule ids that
fired — and simply discards it at the call site.
**Where:** a row in the message's context menu.
**Value:** automation becomes debuggable by the person who wrote it.
**Implementation:** persist `matched` alongside the activity entry.
**Depends on:** #15. **Tier: optional.**

### 11 · Conditions on attachment properties
**What:** `filename:*.pdf`, `attachment_count:>2`, `attachment_type:image`.
**Problem:** "file every PDF from the exam cell" is a natural rule and is
currently inexpressible.
**Why possible:** attachment metadata arrives with the message and is already
parsed by `extractBody`.
**Where:** the query grammar, which the rule engine inherits from.
**Value:** attachment-driven filing, which Gmail also cannot do well.
**Implementation:** new `buildCheck` cases reading `m.attachments`.
**Depends on:** attachment metadata retention on the store record.
**Tier: optional.**

### 12 · A rule that sets a follow-up
**What:** add `followUp: '3d'` to the action vocabulary.
**Problem:** the follow-up feature requires the user to remember to set one,
which is the exact cognitive load it exists to remove.
**Why possible:** `setFollowup()` is a pure function over a list; adding it to
the action table is a few lines.
**Where:** the action picker.
**Value:** "anything I send to the placement unit, chase in three days" becomes
automatic.
**Implementation:** extend `ACTIONS`; wire in the dispatcher. **Depends on:**
#1 for the outbound half. **Tier: optional.**

### 13 · Rule import and export as shareable snippets
**What:** copy a rule to the clipboard as a short JSON blob; paste to install,
with a dry run shown before it is saved.
**Problem:** one person works out the right filter for the placement mailing
list and has no way to give it to a friend.
**Why possible:** rules are already serialisable and already validated on the
way in by `normaliseRuleList`.
**Where:** rule editor overflow menu.
**Value:** the only feature here with a distribution effect.
**Implementation:** reuse `validateBackup`'s envelope discipline — version it,
refuse anything newer. **Depends on:** #3's dry-run-before-apply.
**Tier: optional.**

### 14 · An outbound condition vocabulary
**What:** operators that only make sense before sending: `recipient_count:>10`,
`recipient_is_new`, `external_domain`, `no_attachment_but_mentions_one`.
**Problem:** the safety checks the elimination pass rated highest are exactly
these, and hard-coding them means the user cannot tune the thresholds.
**Why possible:** `contacts.js` knows who has been written to before; the draft
carries everything else.
**Where:** the grammar, gated to outbound rules.
**Value:** reply-all catastrophes become preventable and configurable.
**Implementation:** a second `buildCheck` table for the outbound direction.
**Depends on:** #1. **Tier: important.**

---

## B · The activity log as a data source (15–24)

*The log records every mutation with an actor and an outcome. Nothing reads it
yet. Everything here is a reader.*

### 15 · The activity log viewer
**What:** the screen itself — a filterable, searchable list of what happened,
grouped by day, with actor and outcome badges.
**Problem:** the log is written and cannot be read. That is strictly worse than
not having it, because the storage cost is paid for no benefit.
**Why possible:** `describe()` already renders a one-line summary and is tested.
**Where:** options, and a palette command.
**Value:** the answer to "what happened to that message" stops being a shrug.
**Implementation:** render `loadLog()`; resolve ids against the store for
subjects at display time, since the log deliberately stores none.
**Depends on:** none. **Tier: core.**

### 16 · Undo from history
**What:** revert an individual logged action, not just the top of the undo
stack, with a clear warning when the target has changed since.
**Problem:** the mistake is usually three actions back, and `Ctrl+Z` only
reverses one.
**Why possible:** the log records the verb and the ids; `BULK_ACTIONS` derives
the inverse of every verb already.
**Where:** a button per row in the log viewer.
**Value:** the deepest recovery guarantee in the product.
**Implementation:** re-derive the inverse; refuse when the message's current
state does not match what the entry implies. **Depends on:** #15.
**Tier: important.**

### 17 · Session summary
**What:** on closing, or on the next open: "Last session: 34 archived, 6
replied, 2 rules fired, 1 send failed."
**Problem:** triage feels endless because finishing produces no signal.
**Why possible:** it is one aggregation query over the log.
**Where:** a dismissible strip on the empty-inbox state.
**Value:** closure, and it surfaces failures the user may have dismissed.
**Implementation:** group entries since the last session boundary.
**Depends on:** #15. **Tier: optional.**

### 18 · Failure digest
**What:** a persistent, dismissible banner listing actions that failed and were
never retried — a send that gave up, a star that did not stick.
**Problem:** a failure shown once in a toast and then forgotten is a silent
divergence between what the user believes and what Gmail holds.
**Why possible:** the log records `outcome: 'failed'` for exactly these.
**Where:** the header status area.
**Value:** closes the trust gap the outbox opened for sends, for every verb.
**Implementation:** query `outcome === 'failed'` since last acknowledged.
**Depends on:** #15. **Tier: important.**

### 19 · Personal triage statistics
**What:** median time-to-first-action, per-category volume over time, the ratio
of read-to-archived, and how much of the week's mail was `is:direct`.
**Problem:** the user cannot tell whether the tool is helping or whether their
inbox is getting worse.
**Why possible:** timestamps and verbs are in the log; categories are on the
store records.
**Where:** a stats panel behind the log viewer.
**Value:** motivational, and it points directly at which rule to write next.
**Implementation:** code-generated SVG charts, matching the project's stated
preference for deterministic assets. **Depends on:** #15. **Tier: optional.**

### 20 · Undo-rate feedback on the classifier
**What:** when the user recategorises a sender repeatedly, or undoes the same
rule's work three times, say so and offer to disable the rule or lock the
correction.
**Problem:** the product notices nothing about its own wrongness.
**Why possible:** corrections and undos are both logged with a target.
**Where:** an inline prompt.
**Value:** the classifier's error rate becomes visible instead of tolerated.
**Implementation:** count corrections per sender in a rolling window.
**Depends on:** #15, #6. **Tier: optional.**

### 21 · "What changed while I was away"
**What:** on opening after more than a few hours, a summary of what arrived,
what a rule did in the background, and what snoozed mail woke up.
**Problem:** returning to a changed inbox with no explanation of the changes is
disorienting, particularly once automation is doing work unattended.
**Why possible:** the log distinguishes actor `'rule'` from `'user'`.
**Where:** a boot card.
**Value:** the difference between automation feeling helpful and feeling spooky.
**Implementation:** entries since `lastSeenAt`, grouped by actor. **Depends
on:** #15. **Tier: important.**

### 22 · Export the log as CSV
**What:** download the activity log for analysis outside the tool.
**Problem:** the ring buffer discards after 500 entries or 14 days, so anyone
who wants a longer record has no way to keep one.
**Why possible:** the entries are flat records already.
**Where:** the log viewer's overflow menu.
**Value:** small, but it is the honest answer to a capped buffer.
**Implementation:** one serialiser; reuse `filenameFor`'s dated-name pattern.
**Depends on:** #15. **Tier: optional.**

### 23 · Log-driven regression detection
**What:** a self-check comparing this week's failure rate against the trailing
average, warning when errors spike.
**Problem:** a token that has half-expired, or a network that is failing 20% of
requests, presents as "the app feels flaky" with no diagnosis.
**Why possible:** outcomes are recorded per verb, so the rate is derivable.
**Where:** folded into the sync transparency panel.
**Value:** turns "it's being weird" into a specific, reportable fact.
**Implementation:** compare failure counts across two windows.
**Depends on:** #15. **Tier: optional.**

### 24 · Per-message provenance trail
**What:** on any message, the full list of what has happened to it — arrived,
classified as X, matched rule Y, archived by you, restored by undo.
**Problem:** the log is global; the question is almost always per-message.
**Why possible:** entries carry the ids they touched.
**Where:** the message's context menu.
**Value:** the single most useful debugging view, for the user and for bug
reports. **Implementation:** an index from message id to log entries, built on
demand. **Depends on:** #15. **Tier: important.**

---

## C · The outbox as a general deferred-work queue (25–32)

*It holds items with a state machine, a release time and bounded retry. Sends
are only the first payload type.*

### 25 · Deferred bulk operations
**What:** a 400-message archive is queued and drained in the background,
surviving a tab close, rather than blocking on a foreground loop.
**Problem:** large bulk operations currently must complete while the tab is
open, and closing it mid-run leaves the mailbox half-changed.
**Why possible:** the queue already persists, claims items before awaiting, and
retries with backoff.
**Where:** transparent; the outbox row reports progress.
**Value:** makes the big cleanup safe to start and walk away from.
**Implementation:** a second item type with `{verb, ids}` instead of a draft.
**Depends on:** #26. **Tier: important.**

### 26 · A typed queue with multiple payload kinds
**What:** generalise the record to `{kind: 'send'|'bulk'|'label'|'export', …}`.
**Problem:** every future deferred operation will otherwise grow its own queue,
its own retry policy and its own recovery bug.
**Why possible:** the state machine is already payload-agnostic — only
`flushOutbox`'s dispatcher knows what a draft is.
**Where:** `outbox.js`.
**Value:** one place where "work that must survive a tab close" is solved.
**Implementation:** a dispatcher table keyed by `kind`. **Depends on:** none.
**Tier: important.**

### 27 · Send-time recipient confirmation for large audiences
**What:** when a queued send has more than N recipients, the hold window
extends and the toast names the count and the largest domain.
**Problem:** the undo window is uniform, but the cost of a mistake scales with
the audience.
**Why possible:** the hold is already per-item (`releaseAt`), not global.
**Where:** the enqueue path.
**Value:** proportionate caution — more time to catch the worst mistakes.
**Implementation:** compute the hold from the recipient count.
**Depends on:** none. **Tier: optional.**

### 28 · Draft conflict detection
**What:** if the same thread is edited in Gmail on another device while a draft
is held here, warn before sending.
**Problem:** two half-written replies to the same thread is a real
multi-device failure with no current detection.
**Why possible:** delta sync sees the thread change; the queue knows which
thread the held draft belongs to.
**Where:** the outbox row.
**Value:** prevents a duplicate or contradictory reply.
**Implementation:** compare the thread's `historyId` at hold time and at
release. **Depends on:** #26. **Tier: optional.**

### 29 · Attachment upload resumption
**What:** a large attachment uploads once into the queue, and a failed send
retries the *send* without re-reading the file.
**Problem:** retrying a 20MB attachment over hostel wifi from scratch is how a
retry loop becomes an infinite loop.
**Why possible:** the queue persists the item; the base64 payload is already
part of the draft record.
**Where:** the outbox internals.
**Value:** makes retry viable at the sizes where it matters most.
**Implementation:** cap what is persisted and re-read from a
`FileSystemFileHandle` where available. **Depends on:** storage budgeting —
`chrome.storage.local` is not sized for 25MB payloads. **Tier: optional.**

### 30 · Scheduled digest sending
**What:** hold non-urgent outbound mail and release it in a morning batch —
the polite version of scheduled send, applied automatically by rule.
**Problem:** students write at 2am; mail from a student at 2am reads a
particular way to faculty.
**Why possible:** `releaseAt` already does exactly this per item.
**Where:** an outbound rule action.
**Value:** tone management with zero ongoing effort.
**Implementation:** an action that sets `releaseAt` to the next morning.
**Depends on:** #1. **Tier: optional.**

### 31 · Offline queue for reads
**What:** queue `GET_BODY` requests made while offline and prefetch them on
reconnect, so the messages opened during a dead spell are ready.
**Problem:** the queue currently protects writes only; reading offline simply
fails.
**Why possible:** the same queue, a different payload kind.
**Where:** the reader's error state — "will load when you reconnect".
**Value:** the app degrades gracefully instead of stopping.
**Implementation:** `kind: 'prefetch'`, drained on `navigator.onLine`.
**Depends on:** #26. **Tier: optional.**

### 32 · A visible queue panel
**What:** one place showing everything pending — sends, bulk operations,
prefetches — with per-item cancel and retry.
**Problem:** the outbox is currently only visible when a send fails, so
deferred work is otherwise invisible.
**Why possible:** the queue is a list with states and status lines already
written by `statusOf`.
**Where:** a rail entry that appears only when non-empty.
**Value:** nothing the app is doing on the user's behalf is hidden.
**Implementation:** render `loadOutbox()`; subscribe to `onChange`.
**Depends on:** #26. **Tier: important.**

---

## D · Combining audience, lanes and enrolment (33–46)

*Three signals now exist that have never been crossed with each other.*

### 33 · Audience-aware notification filtering
**What:** notify only on `is:direct`, or on `is:direct` plus a detected class
change — never on broadcast.
**Problem:** a client that notifies on everything is muted within a day and
never re-enabled, which wastes the permission prompt.
**Why possible:** `audience` is stamped at ingest and now survives the cache.
**Where:** notification settings, as the default.
**Value:** the filter that makes notifications survivable.
**Implementation:** the worker checks the stamp before raising anything.
**Depends on:** the `notifications` permission. **Tier: important.**

### 34 · Per-lane retention rules
**What:** a default policy per lane — "auto-archive read newsletters after 14
days", "never touch needsReply".
**Problem:** the right cleanup policy differs sharply by lane, and expressing
that as four separate rules duplicates the lane logic in the condition grammar.
**Why possible:** `laneOf()` is a pure function that could back a `lane:`
operator.
**Where:** a `lane:` query operator plus a per-lane default in settings.
**Value:** one setting replaces four hand-written rules.
**Implementation:** add `lane:` to `buildCheck`, calling `laneOf`. **Depends
on:** #2. **Tier: important.**

### 35 · Lane-aware unread counts in the rail
**What:** the rail badge counts `needsReply` only, with the rest available on
hover.
**Problem:** a total unread count is the number that never changes and
therefore conveys nothing — the exact objection raised against the toolbar badge.
**Why possible:** `laneCounts()` exists and already counts unread only.
**Where:** the sidebar.
**Value:** a number that means "work to do" rather than "mail exists".
**Implementation:** swap the count source. **Depends on:** none.
**Tier: important.**

### 36 · Instructor-priority lane promotion
**What:** mail from a matched instructor for an enrolled course jumps to the
top of `needsReply`, regardless of read state.
**Problem:** the highest-consequence mail a student receives is
indistinguishable from a club announcement in a flat list.
**Why possible:** enrolment gives the course, the timetable gives the
instructor name, `contacts.js` gives the address.
**Where:** lane ordering.
**Value:** the strongest priority signal available, and it is BITS-specific.
**Implementation:** propose name↔address matches and require confirmation — a
wrong instructor badge is worse than none. **Depends on:** #58 in audit 16
(enrolment, now built). **Tier: important.**

### 37 · "Only my courses" filter
**What:** a toggle restricting the list to mail mentioning an enrolled course.
**Problem:** during registration or exam weeks, course mail for 682 courses the
user is not taking is pure noise.
**Why possible:** `mineAmong()` already narrows detected courses to enrolment.
**Where:** a rail toggle and a `course:mine` operator.
**Value:** collapses academic noise the way `is:direct` collapses list noise.
**Implementation:** a `course:` operator reading the cached detection.
**Depends on:** detection results cached on the record. **Tier: important.**

### 38 · Course chips that filter on click
**What:** clicking the chip on a row runs `course:CS F111`.
**Problem:** the chip currently identifies but does not navigate, so the
obvious next action needs the search box.
**Why possible:** the chip already knows its course number.
**Where:** the row.
**Value:** one click from "this is about CS F111" to "show me all of it".
**Implementation:** a click handler setting the query. **Depends on:** #37's
operator. **Tier: important.**

### 39 · Cross-signal smart views
**What:** views that combine the three signals — "direct mail about my courses",
"broadcast mail with a deadline", "instructor mail I haven't answered".
**Problem:** each signal is individually useful and the interesting questions
are intersections.
**Why possible:** the query grammar already has AND, OR and negation; these are
one query each.
**Where:** the shipped smart-view set.
**Value:** demonstrates the grammar's power on questions users actually have.
**Implementation:** additions to `BUILTIN_VIEWS`. **Depends on:** #34, #37.
**Tier: important.**

### 40 · Deadline density warning
**What:** when three or more deadlines fall in the same 48 hours, say so as a
distinct radar state rather than as three ordinary rows.
**Problem:** the radar lists six items linearly, so a brutal Thursday looks
exactly like an easy fortnight.
**Why possible:** the radar already holds dated items and now merges multiple
sources.
**Where:** a radar header line.
**Value:** the planning signal, without building the calendar that was cut.
**Implementation:** bucket by day and compare against a threshold.
**Depends on:** none. **Tier: optional.**

### 41 · Class-change acknowledgement
**What:** a detected room or cancellation notice gets "Got it" / "Not about my
class", and the second answer feeds the detector's precision.
**Problem:** the notice card is read-only by design, so a wrong one has no exit
and no learning path.
**Why possible:** the correction mechanism already exists for classifiers and
for deadlines; this is the same shape.
**Where:** the pinned notice card.
**Value:** dismissal without guilt, plus a labelled corpus.
**Implementation:** store the verdict against the message id.
**Depends on:** none. **Tier: important.**

### 42 · Section-aware notice filtering
**What:** a notice naming L2 is suppressed for a student enrolled in L1.
**Problem:** every section's changes reach every student on the course list, so
most notices are irrelevant to any given reader.
**Why possible:** `sectionsIn()` extracts section tokens; enrolment records the
user's section.
**Where:** the promotion threshold in `shouldPromote`.
**Value:** the difference between a useful pin and a noisy one.
**Implementation:** demote when a section is named and it is not the user's.
**Depends on:** enrolment carrying sections. **Tier: important.**

### 43 · Mail-derived enrolment suggestion
**What:** notice that the user consistently receives mail about CS F111 and
offer to add it to their courses.
**Problem:** the enrolment picker is a setup step, and setup steps are skipped.
**Why possible:** course detection runs over all mail regardless of enrolment.
**Where:** a dismissible prompt after enough evidence.
**Value:** the scoping primitive fills itself in.
**Implementation:** count detections per course over a window; suggest above a
threshold. **Depends on:** #37. **Tier: important.**

### 44 · Broadcast digest
**What:** collapse the day's broadcast mail into one expandable row —
"14 announcements" — instead of fourteen rows.
**Problem:** broadcast mail is the bulk of the volume and almost none of the
value, but it still must be scannable rather than hidden.
**Why possible:** the audience stamp partitions the list cleanly.
**Where:** the announcements lane.
**Value:** the inbox shrinks to the size of the work in it.
**Implementation:** a collapsed group header, expandable in place.
**Depends on:** the grouping mechanism from lanes. **Tier: important.**

### 45 · Sender-audience mismatch flag
**What:** flag a message that arrived as broadcast but names the user
personally in the body — a mail-merge, or a genuine request buried in a blast.
**Problem:** the audience heuristic is structural and misses the case where a
list mail actually is for you.
**Why possible:** the profile name is known; the body is fetched.
**Where:** a row badge that promotes out of the announcements lane.
**Value:** closes the one gap in the audience signal that costs the user
something. **Implementation:** search the body for the display name on
fetch. **Depends on:** body availability. **Tier: optional.**

### 46 · Exam-window deadline weighting
**What:** during a parsed exam window, deadlines for enrolled courses outrank
everything else in the radar automatically.
**Problem:** the exam-mode feature was cut for being a seasonal mode; this is
the same value as a continuous weighting, with no mode to maintain.
**Why possible:** exam dates are in the timetable rows (`02/12 AN`).
**Where:** the radar's sort comparator.
**Value:** the benefit of exam mode without the dead-eleven-months objection.
**Implementation:** a weight term, not a branch. **Depends on:** enrolment.
**Tier: optional.**

---

## E · Reading, composing and the message surface (47–62)

### 47 · Snippet expansion on demand
**What:** a caret on a row expands the cleaned snippet to the first full
paragraph, inline, without opening the message.
**Problem:** the snippet is one line by design; sometimes two would decide it.
**Why possible:** `cleanSnippet` already takes a `max`; the row can re-render
with a larger one.
**Where:** the list row.
**Value:** the hover card's value without the hover card's machinery.
**Implementation:** re-call with `max: 400` and expand the row height.
**Depends on:** none. **Tier: optional.**

### 48 · Show the boilerplate that was stripped
**What:** "…and 3 lines of boilerplate" as a subtle affordance in the reader,
expandable.
**Problem:** the snippet cleaner is invisible and therefore unverifiable — if
it strips something real, the user cannot tell.
**Why possible:** the cleaner knows exactly what it removed.
**Where:** the reader header.
**Value:** trust in a feature that silently modifies what you see.
**Implementation:** return the removed spans alongside the result.
**Depends on:** none. **Tier: optional.**

### 49 · Reply with quoted selection
**What:** selecting text in the reader and pressing `R` quotes only that
selection.
**Problem:** replying to one point in a long announcement means manually
copying, quoting and trimming.
**Why possible:** the reader renders into a sandboxed iframe; selection is
readable from it.
**Where:** reader → compose.
**Value:** precise replies at no cost, a genuine Gmail weakness.
**Implementation:** read the selection, wrap in `>`. **Depends on:** iframe
selection access. **Tier: important.**

### 50 · Template variables filled from the open message
**What:** `{{course}}`, `{{sender}}` and `{{subject}}` auto-fill from the
message being replied to.
**Problem:** `autoValues()` supports these and nothing calls it with a message.
**Why possible:** the wiring is the only missing part — the function exists.
**Where:** the template picker in a reply context.
**Value:** turns templates from stationery into context-aware replies.
**Implementation:** pass the open message to `autoValues`. **Depends on:**
none. **Tier: important.**

### 51 · Template placeholder prompting
**What:** on insert, focus the first `{{unfilled}}` and offer tab-to-next.
**Problem:** `applyTemplate` returns `_unfilled` and nothing consumes it, so
the user hunts for the gaps manually.
**Why possible:** the list of gaps is already computed and returned.
**Where:** compose.
**Value:** the difference between a template that helps and one that creates
proofreading work. **Implementation:** map placeholders to text ranges.
**Depends on:** none. **Tier: important.**

### 52 · Per-recipient template suggestions
**What:** when the recipient is a professor, surface the formal templates
first; for a peer, the short ones.
**Problem:** the template list is flat and grows; the right one is
context-dependent.
**Why possible:** the classifier and contacts both know who the recipient is.
**Where:** the template picker's ordering.
**Value:** the right template without scrolling. **Implementation:** a `match`
field per template, scored against the recipient. **Depends on:** #50.
**Tier: optional.**

### 53 · Draft branching
**What:** keep two drafts for the same thread and choose at send.
**Problem:** for a difficult mail — a complaint, a request to a Dean — people
genuinely write two versions.
**Why possible:** `draft-store.js` is keyed by thread; keying by draft id
instead is a small change.
**Where:** compose, a "duplicate this draft" action.
**Value:** narrow but deeply felt when it applies. **Implementation:** allow
multiple drafts per thread with a picker. **Depends on:** draft-store schema
change. **Tier: optional.**

### 54 · Reader font and width controls
**What:** three widths and two type sizes for the reading pane specifically,
independent of density.
**Problem:** density optimises the list; long-form institutional mail wants a
narrower measure and larger type, which are opposite requirements.
**Why possible:** the reader is one grid cell driven by tokens.
**Where:** reader toolbar.
**Value:** long notices become readable. **Implementation:** a
`data-reading` attribute remapping two tokens. **Depends on:** none.
**Tier: optional.**

### 55 · Plain-text reading mode
**What:** render the text/plain part instead of the HTML, on demand or by
default per sender.
**Problem:** heavily-designed institutional HTML is often less readable than
the plain alternative sitting in the same message and already parsed.
**Why possible:** `extractBody` already returns both `html` and `text`.
**Where:** a reader toggle.
**Value:** faster, calmer reading, and it sidesteps remote-image prompts
entirely. **Implementation:** switch the render source. **Depends on:** none.
**Tier: important.**

### 56 · Link inventory
**What:** list every link in the message with its true destination, flagging
mismatched anchor text and lookalike domains.
**Problem:** phishing that impersonates the placement unit or the registrar is
the highest-value attack on this user base, and the sandboxed iframe hides the
target until hover.
**Why possible:** `sanitize.js` already parses and rewrites the HTML, so it
already sees every href.
**Where:** a collapsible reader footer.
**Value:** a security feature Gmail does not offer this directly.
**Implementation:** collect hrefs during sanitisation; compare anchor text to
host. **Depends on:** none. **Tier: important.**

### 57 · Attachment risk hints
**What:** a warning on executable and macro-bearing extensions, and on double
extensions like `results.pdf.exe`.
**Problem:** the same phishing surface, delivered as a file.
**Why possible:** filenames are already parsed and already sanitised for MIME
safety.
**Where:** the attachment chip.
**Value:** cheap, and the failure it prevents is severe. **Implementation:** an
extension deny-list plus a double-extension check. **Depends on:** none.
**Tier: important.**

### 58 · Sender authentication display
**What:** show SPF/DKIM/DMARC results as a pass/fail chip, prominently on any
message claiming to be from an institutional domain.
**Problem:** "is this really from AUGSD?" is unanswerable in the current UI.
**Why possible:** `Authentication-Results` is a header; `headerMap` already
parses headers.
**Where:** reader header, beside the sender.
**Value:** the single most reliable anti-phishing signal that exists.
**Implementation:** parse the header; show a chip only when it fails, so the
common case stays quiet. **Depends on:** the header being retained through
sync. **Tier: important.**

### 59 · First-contact banner
**What:** "You have never received mail from this address before" on a first
message from an unknown sender.
**Problem:** an impersonation attempt is almost always a first contact, and
nothing marks it.
**Why possible:** `contacts.js` holds the corpus of prior senders.
**Where:** reader header.
**Value:** context at the moment of judgement. **Implementation:** check the
contact index on open. **Depends on:** none. **Tier: optional.**

### 60 · Lookalike-domain detection
**What:** flag a sender whose domain is one edit away from a known
institutional domain — `bits-pilani.co.in` against `bits-pilani.ac.in`.
**Problem:** the highest-effort phishing targets exactly this.
**Why possible:** the classifier's sender map is a list of known-good domains;
an edit-distance check against it is cheap.
**Where:** a reader warning.
**Value:** catches what SPF alone will not. **Implementation:** Levenshtein
against the known-domain list, over the registrable domain only.
**Depends on:** #58 to avoid duplicate warnings. **Tier: optional.**

### 61 · Read receipt and tracker stripping report
**What:** report how many tracking pixels were blocked and by whom.
**Problem:** remote images are blocked by default and the user never learns
what that prevented, so the setting feels like friction rather than protection.
**Why possible:** the sanitiser already identifies and holds back remote images.
**Where:** the existing remote-image prompt.
**Value:** makes an invisible protection legible. **Implementation:** count
1×1 images and known tracker hosts. **Depends on:** none. **Tier: optional.**

### 62 · Message size and load-cost indicator
**What:** show when a message is unusually large before fetching its body,
with a "load anyway" affordance on a metered connection.
**Problem:** a 15MB HTML newsletter on hostel wifi stalls the reader with no
explanation.
**Why possible:** `sizeEstimate` comes back with the message metadata.
**Where:** the reader's loading state. **Value:** an explanation instead of a
hang. **Implementation:** threshold on the metadata. **Depends on:**
retaining `sizeEstimate`. **Tier: optional.**

---

## F · Search, navigation and retrieval (63–74)

### 63 · Saved searches with change alerts
**What:** a saved view that reports when its result set grows — "3 new matches
for `from:placement is:unread`".
**Problem:** a saved view is passive; the user must remember to look at it.
**Why possible:** view counts already recompute on a settled store change, so
the delta is one subtraction away.
**Where:** the rail badge, plus an optional notification.
**Value:** turns saved views from bookmarks into monitors.
**Implementation:** store the last-seen count per view. **Depends on:** #33 for
the notification half. **Tier: important.**

### 64 · Search within results
**What:** a second query applied to the current result set, shown as a chip
chain that can be popped back one step at a time.
**Problem:** narrowing currently means editing one long query string and
retyping it when the narrowing was wrong.
**Why possible:** predicates compose — running a second parse over the first
result set is trivial.
**Where:** the search bar as a breadcrumb.
**Value:** exploratory search becomes iterative instead of all-or-nothing.
**Implementation:** a query stack. **Depends on:** none. **Tier: optional.**

### 65 · Recently-searched-for senders in autocomplete
**What:** the compose recipient autocomplete learns from search history, not
just from who has been mailed.
**Problem:** `autocomplete.js` and `suggest.js` maintain separate notions of
"people you care about".
**Why possible:** both read local data; merging the ranking signal is small.
**Where:** compose. **Value:** fewer keystrokes on the addresses that matter.
**Implementation:** blend the two frequency tables. **Depends on:** none.
**Tier: optional.**

### 66 · Sort control
**What:** sort by date, sender, subject, size or deadline, ascending or
descending, persisted per view.
**Problem:** the list is date-ordered always. "Show me the biggest attachments"
and "group this sender's mail" are both sorts, not searches.
**Why possible:** the list renders from an id array; sorting it is a comparator.
**Where:** the list header.
**Value:** a basic capability whose absence is felt immediately by anyone
cleaning up. **Implementation:** a comparator table; keep the threaded
collapse stable under each. **Depends on:** none. **Tier: important.**

### 67 · Jump to date
**What:** `Shift+G` opens a date input that scrolls the list to that point,
loading more pages if needed.
**Problem:** finding "that mail from around mid-September" means scrolling
through 400 rows or guessing a search term.
**Why possible:** the store is date-ordered, so the target index is a binary
search. **Where:** the list. **Value:** direct navigation through time.
**Implementation:** find the index, scroll, page in if beyond what is loaded.
**Depends on:** none. **Tier: optional.**

### 68 · Result count and "load all matches"
**What:** show how many messages match locally versus how many the server
reports, with an explicit action to fetch the rest.
**Problem:** a search that silently covers only the 2000 cached messages tells
the user "no results" when it means "no results here".
**Why possible:** `MAX_MESSAGES` is known; the server search returns a total.
**Where:** under the search bar. **Value:** removes a silent correctness gap.
**Implementation:** compare local matches against the server estimate.
**Depends on:** none. **Tier: important.**

### 69 · Search operator chips
**What:** render a parsed query as removable chips rather than raw text.
**Problem:** a long query is hard to edit and hard to read back, and removing
one clause means careful cursor work.
**Why possible:** `parseQuery` returns a structured `operators` array — the
chips are already computed.
**Where:** the search bar. **Value:** makes complex queries approachable.
**Implementation:** render `operators`; rebuild the string on removal.
**Depends on:** the AST being serialisable back to text. **Tier: important.**

### 70 · Fuzzy sender matching in search
**What:** `from:vinti` finds "Vinti Agarwal" and `from:agarwal` does too, with
initials and reversed-name forms handled.
**Problem:** institutional addresses are `f20240294@…`, so people search by
the name they know rather than the address they do not.
**Why possible:** display names are indexed alongside addresses in contacts.
**Where:** the `from:` operator. **Value:** search matches how people think.
**Implementation:** match against display name tokens as well as the address.
**Depends on:** none. **Tier: important.**

### 71 · Thread-scoped operators
**What:** `thread:unanswered`, `thread:participants>3`, `thread:longer_than:5`.
**Problem:** threading is complete, and none of the query language reaches it.
**Why possible:** the thread index is maintained incrementally by the store.
**Where:** the grammar. **Value:** finds the runaway conversations worth
muting, and the ones awaiting an answer. **Implementation:** operators reading
`store.threadIds`. **Depends on:** none. **Tier: optional.**

### 72 · Query linting
**What:** warn on a query that cannot match — `is:read is:unread`, or a
`category:` value that does not exist.
**Problem:** a typo in an operator value silently returns nothing, and the user
concludes the mail is missing.
**Why possible:** the operator vocabulary and the category list are both
enumerable; the drift checker already walks them.
**Where:** under the search bar. **Value:** distinguishes "no results" from
"bad query", which the user cannot currently tell apart.
**Implementation:** check values against known sets; detect contradictory
pairs. **Depends on:** none. **Tier: important.**

### 73 · Bookmarkable result sets
**What:** freeze the current result set as a static list that does not change
when new mail arrives — a working set for a cleanup session.
**Problem:** working through search results while the query keeps re-evaluating
means rows move underneath the cursor.
**Why possible:** the list renders from an id array, which can simply be held.
**Where:** a "pin these results" action. **Value:** makes long triage sessions
stable. **Implementation:** freeze the array; show a "frozen" indicator.
**Depends on:** none. **Tier: optional.**

### 74 · Keyboard-navigable search results with peek
**What:** `j`/`k` through results while the query stays focused, with the
reader previewing each without marking read.
**Problem:** searching then reviewing currently requires leaving the search
field. **Why possible:** the cursor and the mark-read delay both exist.
**Where:** the search interaction. **Value:** search becomes a browsing mode.
**Implementation:** suppress the mark-read timer while the query has focus.
**Depends on:** none. **Tier: optional.**

---

## G · Trust, state and the long tail (75–86)

### 75 · Scheduled automatic backups
**What:** write a backup to the downloads folder weekly, keeping the last four.
**Problem:** manual export protects only the people who remember to run it,
which is nobody.
**Why possible:** the backup is a pure function over storage, and the alarm
plumbing exists.
**Where:** a settings toggle. **Value:** the configuration investment becomes
durable without discipline. **Implementation:** `chrome.downloads` on an
alarm; rotate by filename date. **Depends on:** the `downloads` permission.
**Tier: optional.**

### 76 · Backup diffing before import
**What:** show a field-level diff, not just counts, for the keys that are small
enough to diff meaningfully — rules, corrections, enrolment.
**Problem:** `previewImport` reports "12 rules → 5 rules", which is not enough
to approve destroying seven rules.
**Why possible:** these are small structured records with stable ids.
**Where:** the import preview. **Value:** makes import safe to accept.
**Implementation:** id-keyed three-way listing: added, removed, changed.
**Depends on:** none. **Tier: important.**

### 77 · Selective import
**What:** tick which sections of a backup to restore.
**Problem:** wanting someone's rules without their theme, or restoring only
corrections after a classifier mishap, is currently impossible.
**Why possible:** the backup is already a per-key map.
**Where:** the import preview. **Value:** turns backup into a
configuration-sharing mechanism. **Implementation:** filter `EXPORTED_KEYS` by
selection. **Depends on:** #76. **Tier: optional.**

### 78 · Storage budget monitor
**What:** show how much of `chrome.storage.local` is used, by category, with a
prune action.
**Problem:** the cache, the log, the timetable and the queue all grow; quota
exhaustion presents as unrelated failures — a failed rule save, a lost draft.
**Why possible:** `getBytesInUse` exists and every writer is enumerable.
**Where:** the sync transparency panel. **Value:** diagnoses a class of bug
that is otherwise baffling. **Implementation:** per-key byte counts.
**Depends on:** none. **Tier: important.**

### 79 · A repair / self-heal action
**What:** one button that rebuilds derived state — re-stamp audiences,
re-classify, re-extract deadlines, rebuild the thread index — without a full
re-sync.
**Problem:** the audience-stamp bug needed exactly this, and the only remedy
available was "wait for the next full sync".
**Why possible:** every derivation is a pure function over records already held.
**Where:** the sync panel. **Value:** a general remedy for the whole class of
"derived data is stale after an upgrade" bug. **Implementation:** re-run the
ingest transforms over the store in one batch. **Depends on:** none.
**Tier: important.**

### 80 · Schema version stamping on derived data
**What:** record which version of the classifier and the extractors produced
each record, and re-derive automatically when the version changes.
**Problem:** #79 done automatically. Today, improving the classifier leaves
every existing message categorised by the old one, indefinitely.
**Why possible:** ingest is the single place derivation happens.
**Where:** the record shape and the boot path. **Value:** improvements apply
retroactively instead of only to new mail. **Implementation:** a version
integer per derivation, checked at hydrate. **Depends on:** #79.
**Tier: important.**

### 81 · Corrections review queue
**What:** a screen listing every sender correction and deadline override, with
the original value, for bulk review or reversion.
**Problem:** corrections accumulate silently and one made in error is invisible
forever after.
**Why possible:** both stores keep the original — `wasText`, `wasAt`, and the
prior category.
**Where:** options. **Value:** makes the corpus reviewable, which is what makes
it trustworthy as training data. **Implementation:** render both maps.
**Depends on:** none. **Tier: important.**

### 82 · Export the correction corpus
**What:** download `corpus()` plus sender corrections as labelled training data.
**Problem:** the corpus is the mechanism for improving the classifier and the
extractor, and it is currently locked inside one browser profile.
**Why possible:** `corpus()` is written, tested, and has no consumer.
**Where:** options, beside the backup. **Value:** the only path from "the
classifier is wrong for me" to "the classifier is better for everyone".
**Implementation:** serialise; strip addresses to domains for safety.
**Depends on:** #81. **Tier: important.**

### 83 · Deletion protection for starred and follow-up mail
**What:** confirm before trashing a message that carries a follow-up or a
correction the user invested in.
**Problem:** bulk operations do not know that a message is special to the user.
**Why possible:** both stores are keyed by message id and are cheap to check.
**Where:** the bulk confirm. **Value:** protects the state the user built by
hand. **Implementation:** intersect the target ids with the two maps.
**Depends on:** none. **Tier: optional.**

### 84 · Trash and spam review before permanent loss
**What:** a weekly prompt listing what the rules auto-archived or the classifier
marked spam, for a quick scan.
**Problem:** automation moving mail out of sight is only safe if there is a
review path; otherwise the first missed message destroys trust permanently.
**Why possible:** the log records rule actions with their targets.
**Where:** a card, weekly. **Value:** the safety valve that makes aggressive
rules acceptable. **Implementation:** query the log by actor and date.
**Depends on:** #15. **Tier: important.**

### 85 · Local encryption for the notes and corpus stores
**What:** encrypt the user-authored stores at rest with a passphrase.
**Problem:** `chrome.storage.local` is plaintext on disk; on a shared lab
machine that is a real exposure for corrections and follow-up notes.
**Why possible:** WebCrypto is available; the stores are small and rarely read.
**Where:** a settings option, off by default. **Value:** matters specifically
on shared machines, which is a normal situation on campus.
**Implementation:** derive a key with PBKDF2; encrypt on write.
**Depends on:** a session unlock flow. **Tier: optional.**

### 86 · A panic / privacy screen
**What:** a keystroke that instantly blanks the reader and list — for a lecture
hall or a shared screen.
**Problem:** mail is opened in public constantly on a campus.
**Why possible:** it is a root-level class toggle over an existing layout.
**Where:** a global shortcut. **Value:** small, immediate, and repeatedly
useful. **Implementation:** a blur overlay above the compose layer, dismissed
by any key. **Depends on:** none. **Tier: optional.**

---

## H · Platform, presence and interoperability (87–100)

### 87 · Calendar export for deadlines
**What:** emit detected and manual deadlines as an `.ics` file or feed.
**Problem:** the deadline calendar view was cut as out-of-identity, but the
*data* is genuinely valuable outside the mailbox — in the calendar the user
already keeps.
**Why possible:** the deadline store is a list of dated records with titles and
source links.
**Where:** an export action in the radar.
**Value:** delivers the calendar's value without building a calendar.
**Implementation:** an `.ics` serialiser; the `UID` is the message id so
re-import updates rather than duplicates. **Depends on:** none.
**Tier: important.**

### 88 · Timetable export as `.ics`
**What:** the same for the user's enrolled sections, as recurring events.
**Problem:** students maintain their timetable in a phone calendar by hand from
a PDF, every semester.
**Why possible:** meetings are structured with days and start/end minutes.
**Where:** the timetable screen. **Value:** high perceived value, one
serialiser, and it never has to sync. **Implementation:** `RRULE` weekly per
meeting. **Depends on:** enrolment. **Tier: important.**

### 89 · Share a message as a permalink
**What:** copy a link that opens this message in the extension, falling back to
Gmail's own URL when the extension is absent.
**Problem:** referencing a specific mail in a chat with a classmate currently
means a screenshot.
**Why possible:** the message id is stable, and Gmail's URL scheme accepts it.
**Where:** the context menu. **Value:** makes the mailbox referenceable.
**Implementation:** build both URLs; copy the Gmail one for portability.
**Depends on:** deep-link routing for the extension form. **Tier: optional.**

### 90 · Import a `.eml` file
**What:** open a saved message file in the reader.
**Problem:** forwarded evidence and archived mail arrive as `.eml`, and there
is nowhere to open one.
**Why possible:** `extractBody` parses a MIME tree; a local file is the same
tree from a different source. **Where:** a drop target.
**Value:** the reader becomes generally useful, not only for the live mailbox.
**Implementation:** parse the file into the payload shape `extractBody`
expects. **Depends on:** a raw MIME parser, which does not exist yet —
`extractBody` consumes Gmail's parsed JSON. **Tier: optional.**

### 91 · Print-friendly single-message view
**What:** a clean print stylesheet for one message or thread.
**Problem:** printing a notice or an approval currently prints the whole app UI.
Cut once as a maintenance burden across six themes — worth revisiting scoped to
*one surface*. **Why possible:** the reader is one container; a print media
query scoped to it is far smaller than a whole-app one.
**Where:** reader overflow. **Value:** a real institutional need.
**Implementation:** `@media print` scoped to the reader subtree.
**Depends on:** none. **Tier: optional.**

### 92 · Keyboard shortcut for "mark all in lane as read"
**What:** clear an entire lane's unread state in one keystroke, undoable.
**Problem:** the announcements lane accumulates unread that will never be read
individually, and its count then devalues every other count.
**Why possible:** `laneCounts` and the bulk path both exist.
**Where:** the lane header. **Value:** the counts stay meaningful.
**Implementation:** bulk `MARK_READ` over the lane's ids.
**Depends on:** none. **Tier: important.**

### 93 · Per-sender notification overrides
**What:** "always notify me about mail from my project supervisor", regardless
of the global filter.
**Problem:** a global filter is either too noisy or misses the handful of
senders that genuinely warrant an interruption.
**Why possible:** the rule engine can carry a `notify` action.
**Where:** the sender's context menu, and as a rule action.
**Value:** makes notifications precise rather than merely quiet.
**Implementation:** a `notify` action consulted by the worker.
**Depends on:** #33. **Tier: important.**

### 94 · Focus-time suppression driven by the timetable
**What:** suppress notifications during the user's own enrolled class meetings.
**Problem:** a buzz during a lecture is the reason people disable notifications
permanently. Distinct from plain quiet hours, which cannot know that Tuesday
11am is a lab.
**Why possible:** `myMeetings()` returns the exact windows.
**Where:** notification settings. **Value:** the reason notifications survive
the first week. **Implementation:** test the current time against the meeting
list. **Depends on:** #33, enrolment. **Tier: optional.**

### 95 · A read-only shared view
**What:** export a filtered set as a static HTML file — a club secretary
sharing the term's announcements.
**Problem:** there is no way to hand someone a curated slice of a mailbox.
**Why possible:** the renderer already produces sanitised HTML.
**Where:** an export action on a result set. **Value:** a genuinely novel
capability. **Implementation:** inline the styles; no scripts.
**Depends on:** #73's frozen sets. **Tier: optional.**

### 96 · Command palette macros with arguments
**What:** palette entries that take a parameter — `label:Thesis`, `snooze 3d` —
typed inline rather than chosen from a submenu.
**Problem:** the palette is a fixed command list, so every parameterised action
needs its own menu.
**Why possible:** the palette already filters typed text; parsing a trailing
argument is a small extension. **Where:** the palette.
**Value:** the fastest possible path for the actions used most.
**Implementation:** a command grammar with an argument parser.
**Depends on:** context-aware palette. **Tier: optional.**

### 97 · Onboarding that imports rather than asks
**What:** offer to derive initial enrolment, muted categories and a first rule
set from the last 500 messages, showing what it inferred before applying.
**Problem:** setup asks the user for information the app could work out.
**Why possible:** course detection, category volumes and sender frequencies are
all computable at first sync. **Where:** first run.
**Value:** a configured product on day one instead of an empty one.
**Implementation:** run detectors over the first page; present as suggestions.
**Depends on:** #43. **Tier: important.**

### 98 · A diagnostics bundle for bug reports
**What:** one button producing a redacted report — versions, settings, storage
sizes, recent failures, no message content.
**Problem:** "it's being weird" is unactionable, and this project has spent
whole sessions on exactly that.
**Why possible:** `doctor.mjs` already assembles most of it; the activity log
supplies failures. **Where:** options. **Value:** turns vague reports into
diagnosable ones. **Implementation:** reuse the doctor's checks; apply the
backup's allow-list discipline so nothing sensitive travels.
**Depends on:** #15, #78. **Tier: important.**

### 99 · Extension update notes in-app
**What:** on first run after an update, a short "what changed" card.
**Problem:** features ship and nobody discovers them — this roadmap has already
produced several that are invisible without a pointer.
**Why possible:** the manifest version is readable and comparable to a stored
one. **Where:** a boot card. **Value:** the discovery mechanism for everything
else built. **Implementation:** a per-version notes array; show once.
**Depends on:** none. **Tier: important.**

### 100 · A headless rules-only mode for a second device
**What:** install on a lab machine with the UI suppressed, running only rules
and notifications against the same account.
**Problem:** automation stops when the tab is closed, so a rule that files mail
only works when the user is already looking at the mail.
**Why possible:** the worker holds the sync loop and the alarms; the takeover is
a separate surface entirely.
**Where:** a settings mode. **Value:** automation becomes continuous rather
than session-bound. **Implementation:** skip the content script; keep the
worker. **Depends on:** rules running in the worker rather than in the page —
a real architectural move, since `rule-engine.js` currently lives in the app
layer. **Tier: optional.**

---

## Cross-cutting observations

*Not features. Patterns worth carrying into the elimination pass.*

1. **The activity log has ten readers and zero implementations.** It is written
   on every mutation and read by nothing. Whatever else survives elimination,
   #15 unlocks the largest cluster in this document for the least work.

2. **ELEVEN OF THE THIRTEEN NEW MODULES ARE NOT IMPORTED ANYWHERE.** This was
   checked, not assumed, and it is the largest finding in this document.

   | Module | Imported by the app? |
   |---|---|
   | `snippet.js` | yes — `app.js` row rendering |
   | `direct.js` | yes — `app.js` ingest, `query.js` |
   | `lanes.js` `suggest.js` `templates.js` `followups.js` `my-courses.js` `notices.js` `deadline-store.js` `rule-engine.js` `outbox.js` `activity.js` `backup.js` | **no** |

   All eleven are complete, tested (1245 tests pass) and reachable from nothing
   but their test files. The audit-17 roadmap tracked them as "built", and by
   the standard that document set — its own Build Plan lists them as
   `✅ built + tested` — they are. But a user running the extension today has
   no outbox, no rule engine, no templates and no activity log, because no code
   path reaches them.

   This reframes most of this document. Ideas #15–#24 read as "the activity log
   has no readers"; the sharper statement is that the log has no *writers*
   either, because nothing calls `record()`. Ideas #1–#14 extend a rule engine
   that never runs.

   **The single highest-value work item is not on this list of 100.** It is
   wiring what already exists. Every entry here that depends on one of those
   eleven modules is gated behind that, and the elimination pass should treat
   "wire the module" as a prerequisite line item rather than as an implicit
   assumption.

   It is the same failure as audit 16's "three verbs implemented and
   unreachable", one layer up, and it recurs for the same reason: building the
   logic and wiring the UI happen in different sessions, and the test suite is
   green either way. A test that imports a module directly cannot tell you the
   application does not.

3. **Security is now a coherent theme, not a scattering.** #56, #57, #58, #59
   and #60 together form an anti-phishing surface aimed at exactly the attack
   this user base faces: impersonation of the placement unit and the registrar.
   Audit 19 found a header-injection bug on the *outbound* side; these are the
   inbound counterpart, and no equivalent existed in audits 16 or 17.

4. **The outbox wants to become a job queue** (#26). Five separate ideas —
   deferred bulk, prefetch, scheduled digest, upload resumption, background
   export — are all the same infrastructure with different payloads.

5. **Derived-data versioning (#80) is the general form of a bug already
   shipped.** The audience stamp was missing from the cache and only
   self-corrected on the next full sync. Every future improvement to the
   classifier, the extractor or the detector has the same shape.

6. **Export beats building the destination.** The calendar view was cut on
   identity grounds and was right to be; `.ics` export (#87, #88) delivers the
   same user value with a serialiser instead of a screen. This is worth
   generalising as a principle: when a feature wants to become another product,
   export to that product instead.

7. **Notifications are the one gate with a permission cost.** #33, #93, #94 and
   #63 all depend on it, and it triggers a re-consent prompt on update. If it
   is taken, it should be taken once and used for all four.
