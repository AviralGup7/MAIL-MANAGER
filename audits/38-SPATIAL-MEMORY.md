# Audit 38 — Spatial memory: the UI remembers where you were

Concept **#6**. Compact audit + implementation in one round, per the
standing process: whole-product survey first, constraints priced, noise
checked.

The feeling targeted: **"the UI remembers my place"** — returning from any
detour (reading, undo, new mail, switching mailboxes, searching) should
drop the eye back where it was, not at the top of a list that moved.

## 1 · Opportunity map

| # | Opportunity | value | cost | verdict |
|---|---|---|---|---|
| R1 | Closing the reader: last row scrolled into view + one soft pulse | high — every read cycle | tiny (scrollIntoView nearest + 600ms colour pulse) | **implement** |
| R2 | Undo restore: restored row pulses into view | high — recovery moments are exactly when orientation matters | tiny | **implement** |
| R3 | New mail while scrolled: "N new" pill; click scrolls to top | moderate-high — today the anchor holds but the arrival is invisible | small (one button + delta counter) | **implement** |
| R4 | Scroll position remembered per mailbox/category | moderate | tiny map | **implement** |
| R5 | Clearing a search restores pre-search scroll | moderate | tiny | **implement** |
| R6 | Reader body scroll per message | low — iframe realm, long mail is rare | high | reject |
| R7 | Pulse on every selection change | noise — the eye is ALREADY on the row | — | reject |

Constraints priced: the pulse is a background-colour keyframe (paint, not
layout — the layout-keyframe ban keeps its single exemption `row-out`);
reduced motion gets the scroll but not the pulse (information first,
decoration second); the pill is a real button with a live count.

Implemented as one system with one pulse primitive and one scroll-memory
map. Commit follows.

## IMPLEMENTATION RESULT #6

Shipped and verified in real Chrome 148:

| move | result |
|---|---|
| R1 reader-close reorient | pulse observed (1 row), row in view |
| R2 undo pulse | single + bulk restore pulse the first restored row |
| R3 new-mail pill | "1 new — jump up" while scrolled; click → top; survives the rebuild clamp |
| R4 per-category scroll | all→AUGSD→all restores 260px exactly |
| R5 search-exit restore | pre-query position restored |
| reduced motion | scroll kept, pulse dropped (ordered in reorientTo) |

Two real defects found and fixed while verifying:
1. **Structural renders yanked scrolled users to top** — the DOM rebuild
   clamps scrollTop inside its own task; fixed by capturing the position at
   the scroll event and restoring one frame late, cancellable by every
   explicit reset. This was silently breaking the product's own overflow
   anchor at the DOM level.
2. The rebuild's clamp emitted a spurious scrollTop-0 event that auto-hid
   the pill 4ms before the restore landed; the auto-hide now ignores
   scroll events while a restore is pending.

6 contract tests, 4 sabotages caught. R6 (per-message reader scroll) and
R7 (pulse on selection) rejected as documented.
