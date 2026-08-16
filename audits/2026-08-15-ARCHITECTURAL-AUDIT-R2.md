# Architectural Audit R2 — the claims, tested

**Commit:** `0229ed6` (main, clean, in sync)
**Question:** not "is this well organised" — **do the architecture's own stated
rules hold in the code?**
**Method:** every number scripted against the tree. The scripts are inline so
each figure can be re-derived.

An architecture audit that lists opinions is worth nothing. This one takes the
rules the project has already written down — in `docs/ARCHITECTURE.md`, in
`platform/storage.js`'s header, in `test/architecture.test.mjs` — and checks
whether the code obeys them. **A rule that is claimed but not enforced is worse
than no rule**, because it is read as a guarantee.

---

## 0 · What is genuinely sound

Stated first, because it is the larger part of the finding and it is unusual.

| Property | Measured |
|---|---|
| Dependency cycles | **0** across 116 modules / 319 edges |
| Layer violations | **0** (domain→outward, platform→outward, worker→app, app→worker static, feature→app) |
| Modules unreachable from an entry point | **0** |
| Module-header docs | 114 of 116 |
| Largest fan-in | `platform/storage.js` (21) — the intended hub |

The four-layer split is real and the direction of dependency is correct. `classify/`
imports nothing outside itself; `platform/` is a leaf; the worker never reaches
into the app; the app reaches the worker only through dynamic import in the
documented fallback. `test/architecture.test.mjs` enforces the important ones,
and they pass. This is a better-layered codebase than most.

The findings below are all about the **gap between the documented architecture
and the enforced one**.

---

## A · Findings

### ARCH-R2-1 — the platform seam's central claim is false — **HIGH**

`src/platform/storage.js` opens:

> *"Platform seam — **the one module that owns `chrome.*` access** (audit 39/40
> ARCH R-7)… the permission surface is **greppable in one place**"*

Measured, with comments stripped so prose about an API is not counted as a
call:

```
  1  app/academic/timetable-store.js   chrome.runtime.getURL
  5  app/main.js                       chrome.runtime.* chrome.storage.local.remove
  1  app/overlays/settings-panel.js    chrome.runtime.openOptionsPage
  4  app/system/fallback.js            chrome.runtime.* chrome.storage
 13  background/auth.js                chrome.identity.* chrome.alarms chrome.storage.*
  1  background/diag.js                chrome.storage.local
 44  background/index.js               chrome.action/alarms/tabs/scripting/notifications
  3  background/sync.js                chrome.storage.local.*
  9  options/options.js                chrome.identity/runtime
  4  takeover/content.js               chrome.runtime.*
```

Ten modules, and **the seam is not one of them** — `storage.js` reaches
`globalThis.chrome` itself, which is correct, but the sentence claims exclusivity
it does not have.

Two different things are tangled here, and only one is a defect:

- **Legitimate.** `background/*`, `takeover/`, `options/` *must* touch
  `chrome.*` — alarms, identity, tabs, scripting have no storage-seam
  equivalent. The claim was never meant to cover them.
- **A real breach.** Four call sites in the **app layer** reach
  `chrome.storage` directly while `STORAGE` — the seam's own export, built for
  exactly this — sits imported two lines away in some of the same files.

No test enforces any of it, so the claim has been decorative since it was
written.

**Impact:** the stated benefit ("the permission surface is greppable in one
place") is not available. Anyone auditing what this extension can touch must
grep the whole tree and then hand-classify comments from calls, which is how
the 18-vs-10 discrepancy in my own first pass happened.

### ARCH-R2-2 — the `ctx` contract documents 12 of its 29 keys — **HIGH**

`docs/ARCHITECTURE.md §3` presents `ctx` as the sanctioned feature→shell path
and calls it *"deliberately small"*, listing ~12 members. The literal in
`main.js:3175` has **29**. Undocumented (17):

```
dueAtOf, dueFollowups, flushOutbox, ingest, openActivityLog, openMessageId,
openSettings, profileName, refreshContacts, reloadAutomationRules, renderList,
shape, toggleHelp, undoSendMs, viewsList, visibleIds, wireAutocomplete
```

`ctx` is consumed by ~12 modules (`category-menu` 32 references, `list` 25,
`compose` 21, `palette` 18…). It is the single widest coupling surface in the
app, it is **not typed**, and **no test pins its shape**. `tsconfig` does not
cover `main.js`, so the compiler cannot see it either.

**Impact:** this is the exact shape that produced the palette bug the linter
caught last session — a member used and never provided fails at *call time*, in
a rarely-exercised branch. Nothing in the build can tell a feature that it
asked for something the shell does not offer.

### ARCH-R2-3 — the invariant table cites enforcement that does not exist — **MEDIUM**

`ARCHITECTURE.md §6` is titled *"Invariants that must stay true"* and states
*"These are enforced by tests"*, with an "Enforced by" column naming
`source lint`, `ordering lint`, `CSS lint`, `seam test`.

There is no lint infrastructure by those names. ESLint arrived only last
session and is correctness-only; the CSS "lints" are assertions inside
`package.test.mjs`. Some invariants *are* genuinely covered (the history-cursor
one by `sync.test.mjs`, persistence degradation by `resilience.test.mjs`), but
the column is a description of an intent, not of a mechanism, and it reads as
the latter.

### ARCH-R2-4 — `OWNS / DOES NOT OWN` is used by 14 of 116 modules — **LOW**

The convention is one of the better ideas in the codebase — it forces a module
to state its boundary — and the modules that use it (`storage-registry`,
`deep-links`, `intents`, `list`…) are noticeably easier to reason about. At 12%
adoption it is not a convention, it is a habit a few files have.

Not worth a mass edit; worth applying to every *new* module and to any module
being substantially touched.

### ARCH-R2-5 — two modules have no header doc — **LOW**

`src/app/system/backup.js` and `src/app/system/theme-controller.js`, against
114 that do.

---

## B · What I checked and found clean

Recorded so a later pass does not re-litigate:

- **Cycles.** None, including indirect. The `graph`/DFS script is in the
  commit.
- **Layer direction.** All five declared rules hold with zero violations.
- **Dead modules.** Every module is reachable from one of the four entry
  points.
- **Fan-out.** `main.js` at 64 is the outlier and is *inherent* to being the
  shell; the next is `reader.js` at 21. No hidden god-module.
- **`app` → `background`.** Static imports: none. The only path is
  `fallback.js`'s dynamic import, which is the documented degraded mode.

---

## C · Disposition

| ID | Severity | Action |
|---|---|---|
| ARCH-R2-1 | HIGH | Fix the four app-layer bypasses; restate the claim to what is true; **enforce it with a test** |
| ARCH-R2-2 | HIGH | Type `ctx` and pin its shape, so a missing member is a build failure |
| ARCH-R2-3 | MEDIUM | Correct the table to name real mechanisms |
| ARCH-R2-4 | LOW | Apply to touched modules; not a mass edit |
| ARCH-R2-5 | LOW | Add the two headers |

The theme across 1–3 is identical: **the documentation describes an
architecture slightly better than the one that exists.** The fix is not to
weaken the docs — the rules are good — it is to make the code and the tests
match them, and to say plainly where a rule has boundaries.

*Audit only. Fixes land in the commits that follow.*
