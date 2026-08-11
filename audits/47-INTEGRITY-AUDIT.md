# Round 47 — Extraction Integrity & Residual Correctness audit

Scope. Rounds 45–46 changed the highest-risk surfaces (theme/flash, touch,
focus contract, contrast, visual/coverage tooling) and performed the first
two selective extractions (dom.js, toast.js). This audit does NOT re-litigate
already-fixed findings; it audits (a) the extraction seams those rounds
created, (b) the pin/test infrastructure that this round proved can go stale,
and (c) a fresh sweep of untouched modules for residual correctness bugs.

Charter honoured: every finding classified a PROBLEM below is FIXED in the
accompanying commit. Items the owner deliberately deferred (reader
extraction, outbox shared core, storage registry) are CARRIED, not problems,
and are listed at the end with their reason.

Severity: **M**oderate · **L**ow. Zero Severe.

---

## Problems found — ALL FIXED

1. **M — a toast fired before `initToast` was silently dropped.**
   toast.js no-oped when `el` was unset, so a boot-time error toast could be
   lost to boot ordering. FIXED: a one-slot early queue replays on
   `initToast`. Pinned (round47-integrity).

2. **L — `dom.js` guards assumed a live node.** A row evicted between lookup
   and write would throw. FIXED: setAttr/setText null-guard. Pinned.

3. **M — the pin infrastructure can go stale silently.** Four pins read
   functions from modules that moved (toast→toast.js, etc.) and failed only
   when re-run. This is the round's meta-finding: guards that assume a fixed
   shape are the same class as the bugs they guard. FIXED: a pin-path
   integrity guard fails if any pin suite references a src path that does not
   exist, so a future move cannot strand a pin.

4. **L — reader `#r-body` onload reassignment was unaudited.** Each
   `renderBodyInto` overwrites `onload`; a superseded load cannot restore a
   stale scroll because `srcdoc` replacement supersedes the event. Verified
   NOT a bug; documented so the next reader extraction inherits the reasoning.

## Carried (deliberately deferred, NOT problems)

- **reader.js extraction** — the documented next extraction; highest-value
  modularization. Deferred per the strategy ("extract one, test, commit");
  dom/toast prove the pattern. Not a defect; a planned move.
- **outbox shared core / storage registry** — deferred by the owner in round
  46; re-deferred here. Not justified by current evidence.

## Residual correctness sweep of untouched modules

Radar, saved-views, views, selection, snippet, suggest, autocomplete,
my-courses, notices, themes: pattern sweep (no console.log, no loose `==`,
no direct localStorage, innerHTML only static/skeleton/icon) found no new
correctness bugs. These modules are mature and self-audited.

---

## Verification

- round47-integrity 3/3 (dom guards, toast queue, pin-path guard).
- integration 209/209 after jsdom reinstall (env had pruned it).
- guard/contract suites green; contrast advisory-clean; coverage gate green;
  vr token-guard green.

## Read plainly

Round 47 confirms the codebase has reached the state round 46 predicted:
no severe defects, and the remaining work is (a) one planned extraction and
(b) two deferred architectural investments. The new failure class this round
found was *guards going stale*, and the fix is a guard over the guards. The
extracted seams (dom/toast) are clean; the next extraction (reader) is the
single highest-value remaining move and is deliberately sequenced after this
settles.
