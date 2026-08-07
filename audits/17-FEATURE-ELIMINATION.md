# Audit 17 — Ruthless Feature Elimination

The elimination pass over [`16-FEATURE-DISCOVERY.md`](16-FEATURE-DISCOVERY.md).
Same 100 items, same numbers, one verdict each. No new ideas.

**Result: 36 Keep · 24 Maybe · 40 Cut.**

## The filter that did most of the cutting

> *"A better Gmail that happens to understand student life, not a student
> platform with a mailbox bolted on."*

Applied literally, that sentence kills more of section E than any complexity
argument does. **An academic feature survives only if it changes what happens
to a message.** Detecting a room change and pinning that mail to the top is a
mail feature. Rendering a month calendar of deadlines is a calendar app.
Tracking placement pipeline stages is a CRM. Two of those got cut on identity
alone, and I would cut them again if they were free to build.

Ten of the eighteen academic ideas are gone. That is the correct ratio, and
the survivors (course chip, room-change detection, personal sections, deadline
correction, manual deadlines, category correction) are all *message
properties*, not *screens*.

## The second-biggest cutter: absorption

Nine items were cut not because they are bad but because they are **a line of
UI inside a feature already kept**. Inline label creation is a row in the label
picker. Bulk progress is a progress bar on bulk-by-rule. A "large attachment"
guard is a byte counter on the drag-drop attach. Query history is the first
section of the search suggestion list. Shipping these as roadmap entries
inflates the plan and makes it look like more work than it is. They are marked
**Cut (absorbed)** with a pointer, and the absorbing feature inherits the
requirement.

## The third: one feature killed a whole cluster

**#29 (a real snippet line, sender-aware, boilerplate-stripped) kills #30
(hover preview card).** If the row already tells you what the mail says, a
popover that tells you the same thing 500ms later is dead weight — plus a
hover-intent state machine and a positioning engine to maintain forever. This
is the single best trade in the document: one cheap always-visible feature
beats one expensive conditional one.

## Standing objection to the whole plan

Nothing below matters as much as two items that are not features:

- 🔴 **The OAuth client secret is still in public git history and the two
  GitHub PATs are still live.** This is the oldest unaddressed item in the
  project. It outranks every Keep on this list.
- **The classifier has never been validated against real mail.** #68 is on the
  Keep list, but the *first* action is not code — it is you telling me which
  categories in your real inbox are wrong.

---

## A · Labels, organisation, structure

**1 · Label write support — KEEP.**
The biggest functional hole against Gmail and the only item here that makes the
takeover self-sufficient. Read-only labels mean every organising action ejects
the user back to Gmail, which invalidates the product's core promise. Both
verbs exist; the work is a picker. Highest keep in section A by a distance.

**2 · Create-label inline — CUT (absorbed into #1).**
This is a row at the bottom of the picker, not a feature. `CREATE_LABEL` being
unreachable is embarrassing, so it ships — but tracking it separately doubles
the apparent size of #1.

**3 · Nested label tree in the rail — MAYBE.**
Only worth it if you actually have nested labels. Check first: if your Gmail has
fewer than ~8 labels, a flat list inside #1's picker is the whole feature and
the tree is decoration with expand/collapse state to persist. Becomes a Keep the
day the label count crosses ~15.

**4 · Colour chips for labels — CUT.**
Six themes × an AA contrast requirement × Gmail's arbitrary palette = a
permanent contrast-tooling burden for a decorative gain. The category system
already colour-codes the list. Adding a second colour language to the same row
makes scanning worse, not better.

**5 · Pin to top — CUT.**
Sits in the dead zone between star (already there, syncs to Gmail) and follow-up
(#6, which has a date and therefore actually escalates). A pin is a star that
does not sync — strictly worse. Three overlapping "remember this" mechanisms is
one of the ways mail clients rot.

**6 · Follow-up flag with a due date — KEEP.**
The strongest organisation idea in the section and the one Gmail genuinely does
not do. "I mailed a professor and never heard back" is the highest-cost silent
failure a student has. Threading makes the "did anything newer arrive" check
free, and the radar already renders dated urgency. Distinct from star, from
snooze (which hides), and from a deadline (which is external).

**7 · Per-message notes — CUT.**
Scope creep into a notes app. Low frequency, invisible to every other device,
needs its own search operator and its own index, and the payoff is an
annotation the user will forget they wrote. If context matters that much, reply
to yourself — that syncs.

**8 · Local-only tags — CUT.**
Directly duplicates #1. Shipping two labelling systems where one syncs and one
does not is a support nightmare and an explanation problem ("why did my tag
disappear on my phone?"). If Gmail label writes are too slow, fix that with
optimistic updates, not with a parallel taxonomy.

**9 · Smart grouping control — CUT (absorbed into #31).**
The partition-plus-section-header mechanism is real and required — by triage
lanes. As a *user-facing* "Group by" dropdown it is a worse, manual version of
the same thing. Build the mechanism, do not build the control.

**10 · Sender-centric view — MAYBE.**
The stream itself is one click producing `from:x`, which the query bar already
does — near-zero value over typing. The *stats* header (volume, reply latency)
is the actual idea and it is unproven decoration. Revisit only if #41's contact
card ships, where it becomes a "See all" link and costs nothing.

**11 · Thread timeline — CUT.**
Solves a problem at a thread length (20+ messages with changing participants)
that a student inbox reaches perhaps twice a semester. A rendering surface with
its own layout, scroll-sync and jump logic, maintained forever, for a rare case.

**12 · Attachment browser — MAYBE.**
The idea is genuinely good and Gmail is genuinely bad at it. The blocker is
factual, not conceptual: it depends on attachment metadata being retained for
all 2000 synced messages, which inflates the store and the sync payload. Becomes
a Keep once someone measures that cost. Until then, `has:attachment` plus #49's
`filename:` gets 70% of the value for 5% of the work.

---

## B · Composing, replying, sending

**13 · Undo send — KEEP.**
Highest-regret action in the product, zero recovery today. Cheap, because it is
just a delay on the queue that #14 builds anyway. The settings schema already
has a comment promising this key comes back on the commit that implements it —
this is that commit.

**14 · Outbox with retry — KEEP.**
The identity-defining feature for this user's actual network. A failed send
currently exists only as a toast, which means the message is silently lost.
That is not a missing feature, it is a data-loss bug wearing a feature's
clothes. Also the substrate for #13 and #15.

**15 · Scheduled send — MAYBE.**
Genuinely useful (nobody wants to mail a Dean at 2am) and nearly free once #14
exists — the only new part is a time picker and a dispatch check. But it is a
low-frequency convenience, so it waits for the queue to be proven in real use.
Cut the "after this class ends" preset regardless; that is timetable garnish on
a feature that does not need it.

**16 · Templates — KEEP.**
The highest time-saved-per-line-of-code item in the whole document for this
specific user base. Leave requests, extension requests, mess rebates,
recommendation follow-ups — the same four mails all semester, retyped every
time. Also absorbs #18 entirely.

**17 · Multiple signatures with recipient rules — CUT.**
One signature is enough. Match rules on top of that is configuration nobody will
ever open, and getting it wrong (informal signature to a Dean) is worse than
having one neutral signature. Classic clever-but-unused.

**18 · Reply presets — CUT (absorbed into #16 + #19).**
"Acknowledged" is a template. Sending it fast is inline reply. Two features
already kept cover this; a third chip row on the reader is UI debt.

**19 · Inline quick reply — KEEP.**
The largest perceived-speed win in the reading flow and the fix for a real
design flaw: the compose overlay covers the message you are answering. High
frequency, reuses compose's state machine, no new infrastructure.

**20 · "Nudge me if no reply" — CUT (absorbed into #6).**
A checkbox on the compose window that writes a follow-up record. Ships with #6
or not at all; it is not a roadmap item.

**21 · Recipient safety checks — MAYBE.**
Two of the checks are excellent and nearly free (empty subject; "attached" with
no attachment). The rest — reply-all size, external domain, never-mailed
recipient — are lower frequency and generate false positives that train the user
to dismiss the strip, which destroys the value of the two good checks. Ship the
two cheap ones inside #23's work; hold the rest.

**22 · Rich-text composing — MAYBE.**
Real need (applications, club announcements) but the cost is badly
underestimated: a constrained contenteditable with a whitelist serialiser is a
permanent XSS-adjacent maintenance surface, and paste handling from Word/Docs is
where every implementation dies. Revisit only if plain text demonstrably
embarrasses you in a real mail you had to go back to Gmail to send.

**23 · Paste-to-attach and drag-and-drop — KEEP.**
Screenshots are what students actually attach and the file picker is the slowest
possible path to one. Two event handlers into a pipeline that already exists.
Daily frequency, trivial cost.

**24 · Large-attachment guard — CUT (absorbed into #23).**
A byte counter and a red state on the attachment strip. Not a feature.

**25 · Draft autosave indicator — MAYBE.**
Cheap and real — persistence exists and is invisible, so the user does not trust
it. But it is a label, and it overlaps the status surfacing that #14's outbox
must build anyway. Fold it into that work rather than scheduling it.

**26 · Forward as digest — CUT.**
Sounds smart, would be used approximately twice. Rendering N messages into one
readable forward is fiddly formatting work with no daily payoff.

---

## C · Reading, triage, list

**27 · Layout modes — MAYBE.**
Four layouts is four CSS grid configurations × six themes × every panel that has
to reflow, maintained forever, and three of them will be used by nobody. If
this survives at all it survives as **two** options (split and full-width), and
only after #28 proves that density alone was not the actual problem.

**28 · Density control — KEEP.**
Cheap (spacing is entirely token-driven, and the 4px grid guard test already
exists), used every day by everyone, and it roughly doubles the visible inbox on
a laptop. The best value-per-hour item in section C.

**29 · Sender-aware snippet line — KEEP.**
The core triage feature. Deciding without opening is the entire job of a mail
list, and a generic snippet fails on institutional mail because every message
opens with the same salutation and disclaimer. Stripping that boilerplate is
exactly the kind of BITS-specific work that justifies this product existing —
and it is mail work, not academic work. **Kills #30.**

**30 · Hover preview card — CUT.**
Redundant with #29. If the row already shows the meaningful first line, a
popover showing more of the same is a hover-intent state machine, a positioning
engine and a fetch-on-hover policy for marginal gain. Cut the expensive
conditional surface, keep the cheap always-visible one.

**31 · Triage lanes — KEEP.**
The flagship. A flat list forces the user to re-derive priority on every look,
and the app already knows enough (classifier, deadline extractor, direct-vs-list)
to do it for them. This is the "obviously better than Gmail" moment, and it is
purely a mail feature. Absorbs #9's mechanism.

**32 · "Only addressed to me" — KEEP.**
Possibly the highest impact-to-cost ratio in the document. Campus mailing lists
dominate volume and almost never need action; one toggle collapses a
44-conversation inbox to the six that concern you. Local check, no new data,
no new API.

**33 · Bulk unsubscribe centre — MAYBE.**
Satisfying but it is a **one-off**. You will use it once, reduce your inbox, and
never open it again — and it needs `List-Unsubscribe` header retention plus a
mailto/URL dispatch path plus a whole screen. The recurring version of the same
value is #73's rule engine. Revisit after #73, when it might be a rules preset
rather than a screen.

**34 · Sender analytics dashboard — CUT.**
A dashboard you look at twice. It produces "insight", not action; the actions it
would motivate are already reachable via #33 and #73. Charts to build, charts to
maintain, no daily use.

**35 · Unread aging indicators — CUT.**
Guilt as a feature. #31's lanes and #32's filter fix the underlying problem
(actionable mail is buried); an escalating marker on old unread mail just makes
the list noisier and gets ignored within a week.

**36 · Bulk actions by rule — KEEP.**
"Archive all 37 from this sender" turns minutes of shift-clicking into one
click, and the existing `BULK_ACTIONS` inverse table makes the whole operation a
single undo entry — which is the only reason it is safe enough to ship.

**37 · Bulk progress and cancel — CUT (absorbed into #36).**
A mandatory part of #36, not a separate item. #36 does not ship without it; a
400-message operation that looks frozen is unusable.

**38 · Multi-select power gestures — KEEP.**
Shift-click ranges and "select all N matching this search" are the difference
between bulk actions being usable and being theatre. Gmail's most-used power
feature; its absence is felt immediately.

**39 · Keyboard cursor (j/k) — KEEP.**
The missing primitive that makes everything else keyboard-reachable. Without a
cursor concept, every action needs the mouse first to establish context, which
means the product *has* shortcuts but is not keyboard-first. Also the
prerequisite for #40.

**40 · Action-and-advance — KEEP.**
The single biggest structural cost in a triage session: today the reader empties
after every action and forces a return trip to the list. Fixing it turns triage
from a series of round trips into a rhythm. The departing-row animation and
260ms settle are already built and tested.

**41 · Contact hover card with avatars — MAYBE.**
`first.last@pilani.bits-pilani.ac.in` really is unreadable, and deterministic
initials avatars are cheap and privacy-clean. But #30 is cut, so this now has to
justify the popover primitive **on its own** — and the actual daily win is
smaller than it feels. Becomes a Keep if #64 (instructor recognition) ships,
because then the card has something to say that the row cannot.

**42 · Focus mode — CUT.**
The answer to "the UI is distracting" is a less distracting UI, not a second UI
mode. #31 and #40 already produce the calm one-at-a-time flow this describes.
A whole alternate render path for a mood.

---

## D · Search, query, retrieval

**43 · Search suggestions — KEEP.**
The query language is the product's best hidden asset and nobody will ever type
`deadline:overdue` unless something offers it. This is the feature that makes
every other query feature real. `autocomplete.js` already exists to generalise.
Absorbs #44 and #47.

**44 · Query history — CUT (absorbed into #43).**
The first section of the suggestion list when the field is empty. A ring buffer
and a render slot, not a roadmap item.

**45 · Search inside the thread — CUT.**
Ctrl+F already works on rendered DOM. The gap is only collapsed thread parts,
which is a narrow case, and overriding the browser's find shortcut is a fight
you lose with users. Cheaper fix: expand-all on a long thread.

**46 · Local full-text search — MAYBE.**
"Instant search" is a genuinely different product feel, but this is an inverted
index with incremental build, eviction, persistence and a merge policy against
server results — real infrastructure, and the cache only holds 500 bodies so
coverage is partial and therefore *confusing* ("why did it find that one and not
this one?"). Only worth it if the 420ms server search actually annoys you in
daily use. Measure before building.

**47 · Operator help sheet — CUT (absorbed into #43).**
The suggestion list teaches the operators at the moment of use, which is
strictly better than a reference panel behind `?`. If the sheet ships at all it
is generated from the parser table as a test artifact, not a feature.

**48 · Negation and OR — KEEP.**
Not really a search feature — it is the **automation language**. Rules, smart
views and bulk-by-rule all become expressible or inexpressible based on this.
"Everything academic except the timetable bot" is the shape of every real
filter, and implicit-AND cannot say it. Keep as infrastructure.

**49 · Size / age / attachment-type operators — MAYBE.**
`older_than:` and `filename:` are the two that matter and they make #36's
cleanup targetable. `larger:` depends on the same metadata retention question as
#12. Ship the two that need no new data; defer the rest.

**50 · Saved view badges and shortcuts — MAYBE.**
Saved views being inert in the rail is a real complaint, but the fix is a count
and an ordering field, not a shortcut-assignment UI. Depends on saved views
actually being used — which depends on #51. Sequence it after.

**51 · Default smart views — KEEP.**
An empty saved-views section teaches nothing. Good defaults ("Needs reply",
"Unread > 7 days", "From my instructors") deliver value on first run *and*
teach the query language by example, which is what makes #43 and #48 pay off.
Nearly free: each is one query.

**52 · Deep links / router — MAYBE.**
Sounds like plumbing and mostly is, but it unlocks #91 (session restore) and
fixes accidental-reload loss, which is a real daily annoyance. The blocker is
that it requires extracting state out of the welded core in `app.js` — the work
that has been explicitly deferred. Do it when that refactor happens, not before,
and not as a reason to start it.

**53 · Recently viewed — CUT.**
A back stack for a problem that #43's search and #40's flow already handle. Low
frequency, and the list will be full of things you deliberately finished with.

**54 · Search across drafts / snoozed / outbox — KEEP.**
A snoozed message currently *disappears* — search cannot find it, which is a
correctness problem disguised as a feature request. "It's in here somewhere"
must always resolve, or the user stops trusting snooze and stops using it.
Cheap: those stores are local and enumerable.

---

## E · Academic intelligence

*Ten of eighteen cut. The survivors all change what happens to a message.*

**55 · Course chip on the row — KEEP.**
The cheapest possible expression of the product's differentiator: detection
already runs, the result is currently thrown away, and rendering it as a
filterable chip costs a cache field and a span. Improves scanning of the mail
list, which is a mail improvement.

**56 · Course context panel — CUT.**
A panel restating the timetable inside the reader. Drifts toward a course
dashboard, and the specific question it answers ("what is CS F111 L2") is
answered by #55's chip plus the timetable screen that already exists. Panel real
estate is expensive; this earns it about once a week.

**57 · Room-change / cancellation detection — KEEP.**
The best academic idea in the document and the clearest "Gmail could never".
Highest-urgency, lowest-volume mail on campus, currently indistinguishable from
everything else in the list. Crucially it is a *mail* feature: it changes the
prominence and position of a message. `matchNotice()` already exists.
**Ships read-only** — surface the change, do not auto-apply it to a timetable.

**58 · Personal sections — KEEP.**
Not a feature, a **scoping primitive**. Without it, course intelligence runs
against all 688 courses and produces noise; with it, #55 and #57 become precise.
One picker, one stored array. Everything academic that survived depends on it.

**59 · Today strip — CUT.**
A schedule widget above the mailbox. This is the exact silhouette of "student
platform with a mailbox bolted on" — it improves no mail workflow, it just puts
a timetable in the mail window. The user has a timetable screen already (`T`).

**60 · Deadline correction — KEEP.**
Mandatory, not optional. A silently wrong radar entry is worse than an empty
radar because the user stops trusting the panel entirely, and `extractDeadline`
*will* be wrong. Corrections also build the labelled corpus that improves the
extractor. Mechanism already exists in `rules.js`.

**61 · Manual deadline creation — KEEP.**
Makes the radar complete instead of best-effort. The extractor can only ever
catch what it recognises; a manual path means the panel can be trusted as a
system rather than a bonus. Cheap — the radar reads a list, not a parser.

**62 · Deadline calendar view — CUT.**
A calendar. This is the brightest line in the identity filter. Six radar entries
answer "what is due"; a month grid answers "how is my semester shaped", which is
a different product.

**63 · Exam mode — CUT.**
Attractive and wrong. It is a seasonal mode — a whole conditional behaviour set,
suppression rules and a panel that is dead code for eleven months and untested
when it finally activates. The underlying need (only urgent mail is visible) is
what #31 and #32 do all year round.

**64 · Instructor recognition — MAYBE.**
Real value: "mail from someone who affects my grade" is the single most useful
priority signal a student inbox has, and it feeds #31's lanes directly. Real
risk: fuzzy name↔address matching against 1681 parsed instructor names, where a
wrong badge is worse than no badge. Needs a confirmation flow and needs #58.
Becomes a Keep if the match rate against your real inbox is high; measure it on
your actual senders first.

**65 · Timetable conflict checker — CUT.**
Requires event-time extraction (a new parser, new failure modes) to answer a
question asked a few times a semester, where being wrong causes the user to miss
something. Bad ratio on every axis.

**66 · Academic digest — CUT.**
A composite of features that mostly got cut, presented as a card. Digests are
the classic feature that is loved in the demo and dismissed unread by week
three. #31's lanes deliver the same prioritisation continuously.

**67 · Semester timeline / term archive — CUT.**
Retrieval by term is a `before:`/`after:` query with nicer words. Term metadata,
a switcher and an archive concept for a rare need.

**68 · Category correction UI — KEEP.**
The most important item in section E and arguably in the document. The
classifier drives the rail, the lanes and the rules, its real-inbox accuracy is
*unvalidated*, and `Naukri Campus Jobs → ADMINISTRATION` is already a known
suspect. Correction is the only mechanism by which any of that improves. The
"how many other messages would move" preview is what makes it worth using.

**69 · Classifier explainability — MAYBE.**
Excellent for *you* as the developer — it would make every future
misclassification report actionable instead of anecdotal. Weak for a user, who
wants the category fixed, not explained. Worth building as a debug surface
behind a flag while #68 is built; not worth a polished UI.

**70 · Auto-derived course folders — CUT.**
A rail section per course, duplicating what #55's chip filter already does in
one click. Rail entries are the most contested real estate in the app and 6
courses would take 6 of them.

**71 · Grade / result detection — CUT.**
A keyword table for a handful of messages a semester. If it matters, #73's rule
engine expresses it in one user-authored rule with no shipped code.

**72 · Placement pipeline tracker — CUT.**
A CRM inside a mail client. Stage detection, company inference, per-company
aggregation, a seasonal rail section. This is the single furthest item from
"a better Gmail" in the whole document — it is a separate product that happens
to read mail. The genuine underlying need (do not miss a placement deadline) is
covered by #60, #61 and the radar that already exists.

---

## F · Automation, rules, workflow

**73 · Rule engine — KEEP.**
`rules.js` currently supports two hardcoded behaviours per sender; everything
else must be done by hand forever. The condition language is #48's AST and the
action set is `BULK_ACTIONS` — both already exist, which makes this far cheaper
here than in most clients. Raises the ceiling of the whole product and absorbs
the recurring half of #33, #71 and #84.

**74 · Rule dry-run and audit log — KEEP.**
Non-negotiable, and it ships **with** #73 or #73 does not ship. Invisible
automation that silently archives a mail from a Dean is how a user uninstalls a
mail client permanently. The corpus is local, so the dry run is instant — there
is no excuse for shipping the unsafe version.

**75 · Create rule from this message — KEEP.**
The discovery path without which #73 is a settings page nobody opens. Rules are
written at the moment of annoyance, not later. The undo toast asking "always do
this?" is the whole feature.

**76 · Right-click context menu — KEEP.**
Every action in this product is currently gated behind a memorised shortcut or a
hover target. A context menu is where users *look* for capability, and `menu.js`
already unifies four menus with focus management. It is the discoverability
layer for everything else on this list.

**77 · Context-aware palette — KEEP.**
The palette is a fixed 11-command list, which means it stops being useful the
moment the app grows — and this roadmap grows it a lot. Adding `when(ctx)` and a
dynamic title turns it into the single keystroke that reaches every capability.
Small change, compounding return.

**78 · Repeat last action — MAYBE.**
Genuinely nice for repetitive triage and cheap given the undo stack already
records verb and target. But #40's action-and-advance removes most of the
repetition it exists to accelerate. Revisit after #40 ships and see if the need
survives.

**79 · Shortcut remapping — CUT.**
A settings screen with conflict detection, an override map and a printable
cheat sheet, for a single-user product where that user chose the defaults. If a
binding is wrong, change the default.

**80 · Workflow macros — CUT.**
Power-user depth for a user base of one, sitting on top of #73 and #77 which
already cover the real cases. Recording, storage, an editor, and a composite
undo story — permanent maintenance for an occasional convenience.

**81 · Snooze upgrades — MAYBE.**
Split the item. A **custom date/time picker** is a genuine gap and should ship
(fixed presets fail constantly). **Recurring snooze** is niche. **"Until next
class"** is timetable garnish on a mail feature and should be cut on identity
even though #58 makes it possible. Keep the picker, drop the rest.

**82 · Auto-triage suggestions — CUT.**
Requires the activity history (#86), a statistical threshold, and a card that
interrupts the user to propose automation. Too clever, too early, and the
failure mode (a wrong suggestion accepted in one click) is exactly what #74
exists to prevent.

**83 · Mute a thread — KEEP.**
`rules.js` mutes senders, but the actual unit of noise is one runaway thread on
a mailing list — a sender mute would silence the list entirely, including the
one message that mattered. Threading makes the check trivial. High frequency in
a campus inbox.

**84 · Auto-advance rules — CUT (absorbed into #73).**
"Archive newsletters when done" is one user-authored rule. Shipping a separate
per-category default mechanism duplicates the rule engine with a second,
weaker configuration surface.

---

## G · Trust, recovery, transparency

**85 · Undo history panel — MAYBE.**
The reasoning is sound (the mistake is usually three actions back, and
`Ctrl+Z` only reverses one), but the hard part is not the panel — it is
reverting an entry whose target has changed since, which is a correctness
minefield in exactly the area where this project has already found four undo
bugs. Worth building only after #86 exists, because the log makes the panel's
edge cases visible.

**86 · Activity log — KEEP.**
The debugging substrate for everything else. When the mailbox disagrees with
expectation there is currently no way to find out what happened, and this
project has spent entire sessions on exactly that class of mystery. Also the
prerequisite for #74's audit trail. Cheap: every mutation already funnels
through a small verb set.

**87 · Local export / backup — KEEP.**
This roadmap asks the user to invest real effort in rules, corrections,
templates and views. All of it currently lives in one browser profile and is one
reinstall from gone. Export makes the investment safe, which is a precondition
for asking for it. One JSON envelope over `chrome.storage.local`.

**88 · Message export (EML / PDF / view original) — MAYBE.**
"View original" is a legitimate small gap and comes nearly free with a `GET_RAW`
verb. Full PDF/EML export with print styling is a bigger job for a rare need.
Ship view-original if the verb gets added for another reason; do not schedule
the export suite.

**89 · Offline mode — MAYBE.**
Correct diagnosis (campus wifi drops constantly, and today a drop produces error
toasts and lost intent) but the honest scope is large: an idempotent action
queue, reconciliation against `SYNC_DELTA`, and conflict handling. **#14's
outbox delivers most of the real-world value** — the mutations users actually
care about losing are sends. Reassess after #14 has run in real use.

**90 · Conflict visibility — CUT.**
Depends on #89, which is itself deferred, to surface a situation (read on phone,
archived here) that in practice resolves harmlessly. Correctness theatre for a
rare, low-consequence divergence.

**91 · Session restore — MAYBE.**
Real annoyance, real fix, but it is gated behind #52's router, which is gated
behind the `app.js` state extraction that is explicitly deferred. Right idea,
wrong time. Comes free with that refactor whenever it happens.

**92 · Sync transparency panel — KEEP.**
Directly motivated by a bug that actually happened: the false "background
service unavailable" banner, where the user could not tell whether the app, the
worker or the network was at fault. The worker already tracks last sync, cache
size, quota and token expiry — this is surfacing, not building. The project's
`doctor.mjs` instinct pointed at the user instead of the developer.

---

## H · Notifications, presence, platform

**93 · Desktop notifications — KEEP.**
Without it the extension only helps while it is already open, which is the wrong
half of the day. The worker already runs a delta sync on an alarm. **Must ship
strictly filtered by default** (direct-to-me, deadline detected) — a client that
notifies on everything is muted within a day and then never re-enabled.
Note: needs the `notifications` permission, which triggers a re-consent prompt
on update. That is a real cost and it is worth it once, not twice.

**94 · Quiet hours / class-aware suppression — MAYBE.**
Plain **quiet hours** is a keeper-grade idea and should ship inside #93 as two
time fields. The **class-aware** half is timetable garnish that adds a #58
dependency and a whole batching-digest mechanism to a notification feature. Ship
the clock, skip the timetable.

**95 · Toolbar badge — KEEP.**
Persistent zero-cost awareness, no new permission, and the count is already
computed for the rail. Crucially it should badge **actionable** mail (via #32),
not total unread — a badge showing 1,482 is worse than no badge because it
conveys nothing and never changes.

**96 · Toolbar popup mini-inbox — CUT.**
A second, smaller rendering of the product to keep in sync with the first,
forever. #95's badge answers "is there anything?" and clicking through to the
full app answers "what?". The popup plumbing was already built and reverted once
during the service-worker saga; leave it reverted.

**97 · Onboarding — MAYBE.**
The verdict depends entirely on a question only you can answer: **is anyone
other than you ever going to install this?** If yes, this is a Keep and probably
a core one — demanding a Google Cloud client ID with no guidance is a wall. If
it stays personal, it is pure ceremony for someone who already knows the setup.

**98 · Multi-account — CUT.**
Namespacing the store, the token cache and every storage key by account, plus an
account switcher and a merged-read unified inbox — a structural change touching
every layer, in a codebase whose render/list/selection core is already welded
and explicitly deferred. The workaround (keep the personal account in a Gmail
tab) costs a tab. Revisit only after the core refactor, if ever.

**99 · Settings sync across devices — CUT.**
Solves a problem the user does not have. One laptop. `chrome.storage.sync`
brings an 8KB-per-item quota, a size budget to police forever, and a
local/remote merge policy — all for a second machine that does not exist. #87's
export covers the real need (not losing the configuration).

**100 · Print stylesheet — CUT.**
A genuine small need (printing notices and timetables) attached to a permanent
maintenance surface: `@media print` across six themes and every panel, silently
breaking on every layout change because nobody prints during development. The
browser's Ctrl+P on the reader is ugly but works.

---

## Survivors

### Keep (36)

**Foundations — build first, everything leans on them**
| # | Feature |
|---|---|
| 39 | Keyboard cursor (j/k) |
| 40 | Action-and-advance |
| 29 | Sender-aware snippet line |
| 32 | Only-addressed-to-me |
| 31 | Triage lanes |
| 28 | Density control |
| 76 | Right-click context menu |
| 77 | Context-aware palette |

**Mail completeness — the holes that send you back to Gmail**
| # | Feature |
|---|---|
| 1 | Label write support *(absorbs 2)* |
| 14 | Outbox with retry |
| 13 | Undo send |
| 19 | Inline quick reply |
| 23 | Paste / drag attachments *(absorbs 24, and 21's two cheap checks)* |
| 16 | Templates *(absorbs 18)* |
| 83 | Mute a thread |
| 54 | Search across drafts / snoozed / outbox |

**Search and automation — one AST, many features**
| # | Feature |
|---|---|
| 43 | Search suggestions *(absorbs 44, 47)* |
| 48 | Negation and OR |
| 51 | Default smart views |
| 38 | Multi-select power gestures |
| 36 | Bulk actions by rule *(absorbs 37)* |
| 73 | Rule engine *(absorbs 84)* |
| 74 | Rule dry-run + audit log |
| 75 | Create rule from this message |

**Academic — only what changes what happens to a message**
| # | Feature |
|---|---|
| 58 | Personal sections *(scoping primitive)* |
| 55 | Course chip on the row |
| 57 | Room-change detection *(read-only)* |
| 68 | Category correction |
| 60 | Deadline correction |
| 61 | Manual deadline creation |
| 6 | Follow-up flag *(absorbs 20)* |

**Trust and reach**
| # | Feature |
|---|---|
| 86 | Activity log |
| 87 | Local export |
| 92 | Sync transparency panel |
| 93 | Desktop notifications *(filtered; absorbs quiet hours from 94)* |
| 95 | Toolbar badge |

### Maybe (24) — and the one fact that decides each

| # | Feature | Unblocks when |
|---|---|---|
| 3 | Nested label tree | your Gmail label count exceeds ~15 |
| 10 | Sender view + stats | #41 ships and it becomes a free "See all" |
| 12 | Attachment browser | someone measures the metadata retention cost |
| 15 | Scheduled send | #14 is proven in real use |
| 21 | Recipient safety checks | ship the 2 cheap ones in #23; hold the rest |
| 22 | Rich-text compose | plain text visibly embarrasses you on a real mail |
| 25 | Draft autosave indicator | fold into #14's status work |
| 27 | Layout modes | #28 ships and density was *not* the real problem |
| 33 | Bulk unsubscribe | #73 ships; then it is a preset, not a screen |
| 41 | Contact card | #64 ships and gives the card something to say |
| 46 | Local full-text search | the 420ms server search actually annoys you |
| 49 | Size/age/filename operators | ship `older_than:`/`filename:` only |
| 50 | Saved view badges | #51 ships and views are actually used |
| 52 | Deep links / router | the `app.js` state extraction happens anyway |
| 64 | Instructor recognition | match rate measured on your real senders |
| 69 | Explainability | build as a debug flag alongside #68 |
| 78 | Repeat last action | the need survives #40 |
| 81 | Snooze custom picker | keep the picker, drop recurring + "next class" |
| 85 | Undo history panel | #86 exists to expose the stale-target cases |
| 88 | View original | a `GET_RAW` verb gets added for another reason |
| 89 | Offline mode | #14 runs in real use and gaps remain |
| 91 | Session restore | comes free with #52 |
| 94 | Class-aware quiet hours | never — ship the clock half inside #93 |
| 97 | Onboarding | **you decide anyone else will install this** |

### Cut (40)

2, 4, 5, 7, 8, 9, 11, 17, 18, 20, 24, 26, 30, 34, 35, 37, 42, 44, 45, 47, 53,
56, 59, 62, 63, 65, 66, 67, 70, 71, 72, 79, 80, 82, 84, 90, 96, 98, 99, 100

*(Of these, nine — 2, 9, 18, 20, 24, 37, 44, 47, 84 — were absorbed into a
survivor rather than rejected on merit; the surviving feature inherits the
requirement. The other thirty-one were rejected outright.)*

---

## What the cut list says about the product

**Every "screen" died.** Deadline calendar, sender analytics, semester
timeline, attachment browser (deferred), placement tracker, bulk-unsubscribe
centre, focus mode, popup mini-inbox. A mail client is a list and a reader;
every additional top-level surface is a thing to maintain, to theme six times,
to keyboard-navigate, and to explain. The features that survived almost all live
*inside* the list row, the reader, the rail or the palette.

**Every second taxonomy died.** Pins, local tags, colour chips, course folders.
The product already has stars, categories, labels and saved views. A fifth way
to organise does not organise better; it fragments the four that exist.

**The academic cuts were the easiest calls, not the hardest.** Once you ask
"does this change what happens to a message?", the calendar, the digest, the
today strip, the exam mode and the placement tracker all answer no. They are
good ideas for a different product. The six academic survivors all answer yes:
they change a message's position, prominence, category or deadline.

**Three items are load-bearing far beyond their size.** #48 (negation/OR) is the
automation language. #58 (personal sections) is what makes academic detection
precise instead of noisy. #86 (activity log) is what makes automation
debuggable. None of them is visible in the UI; all three should be built early.

**One pairing must not be split.** #73 without #74 is a feature that silently
archives mail from a Dean. If the dry run and the log are not in the same
commit, do not ship the rule engine.

## Suggested order

1. **#39 → #40 → #29 → #32** — the triage core. Four items, and the product
   feels twice as fast before a single new capability exists.
2. **#1, #14, #13, #19, #23** — close the holes that eject users to Gmail.
3. **#48 → #43 → #51 → #38 → #36** — the query/automation substrate and its
   payoffs.
4. **#31, #76, #77** — prioritisation and reach.
5. **#73 + #74 + #75 together** — the rule engine, safely.
6. **#58 → #55 → #57 → #68 → #60 → #61 → #6** — academic, scoped, after the
   mail product is strong. **#68 first if the classifier turns out to be wrong
   often** — that is a data question you can answer today.
7. **#86, #87, #92, #93, #95** — trust and ambient presence.

Before step 6, answer the question that has been open since the screenshot:
**which categories in your real inbox are wrong?** That determines whether #68
is a polish item or the most urgent thing on this page.
