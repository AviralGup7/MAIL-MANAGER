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
