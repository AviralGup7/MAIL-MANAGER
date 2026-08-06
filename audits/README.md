# Audits

Eight audits of the v2 codebase. The first six were written after the build was
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

Actions are consolidated and prioritised in [`../TODO.md`](../TODO.md).

## Two notes on method

**Disproved suspicions are recorded, not deleted.** `03-PERFORMANCE.md`
documents two findings I raised and then measured away (`unreadCounts` per
render, prefix-search scanning). An audit that reports only confirmations is
not an audit, and the next person to have the same suspicion should be able to
see it was already checked.

**This follows a round of four retracted claims.** Four "bugs" previously
reported in the v1 classifier were all wrong, retracted in
[`../notes/CLASSIFIER_CORRECTION.md`](../notes/CLASSIFIER_CORRECTION.md). Every
finding here therefore carries the command or measurement that produced it.
