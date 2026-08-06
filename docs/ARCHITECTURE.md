# Target architecture

**Status:** living document. Written at `c04eadb`, after audit
[`09-ARCHITECTURE-POST-CHANGE.md`](../audits/09-ARCHITECTURE-POST-CHANGE.md).

This is not a rewrite plan. The system has 11,600 lines under 639 tests and a
dependency graph with no cycles; discarding that would destroy far more value
than any redesign creates. What follows is the architecture the codebase is
*already most of the way toward*, stated explicitly so that the remaining gap
is visible and closeable in increments.

Every rule below is either **already true** (and now written down so it stays
true) or **a named gap** with the migration that closes it.

---

## 1 · The four layers

Dependencies point **downward only**. This is currently true and is enforced
by a test.

```
┌─────────────────────────────────────────────────────────┐
│  SHELL          app.js, app.html                        │
│                 owns: layout, render loop, routing      │
├─────────────────────────────────────────────────────────┤
│  FEATURES       features.js, and one module per surface │
│                 owns: self-contained UI + its own state │
│                 talks to the shell ONLY through `ctx`   │
├─────────────────────────────────────────────────────────┤
│  DOMAIN         store, query, classify, deadlines,      │
│                 rules, snooze, contacts, selection      │
│                 pure. no DOM, no chrome.*, no I/O       │
├─────────────────────────────────────────────────────────┤
│  PLATFORM       background/*, cache, settings, views,   │
│                 draft-store, sanitize                   │
│                 owns: network, credentials, persistence │
└─────────────────────────────────────────────────────────┘
```

**Why this order.** The app document renders content from strangers. It must
never hold a credential, so the platform layer lives in the service worker and
is reachable only through named verbs. The domain layer is pure so that the
classifier and the query language can be tested exhaustively without a
browser — which is why they *are* the best-tested parts of the system.

### Rules

1. **No upward imports.** `domain/` never imports from `features/` or the
   shell. Violations are a test failure.
2. **No sideways imports between features.** Two features that need the same
   thing share a *domain* module, never each other.
3. **The platform layer exposes verbs, not endpoints.** The app names
   `SYNC_PAGE`, never a URL. A generic passthrough was deleted once already
   because it let an XSS reach any Gmail endpoint.
4. **The domain layer is synchronous and pure.** If it needs storage, it takes
   a storage object as a parameter — which is what makes failure injection
   across all 18 persistence entry points possible.

---

## 2 · State ownership

Every piece of state has exactly one owner. This is the rule the codebase has
broken three times, always the same way.

| State | Owner | Published as |
|---|---|---|
| messages, per mailbox | `stores: Map<id, Store>` | `ctx.store` **getter** |
| which mailbox is active | `state.mailbox` | `state` (mutated in place) |
| load/pagination per mailbox | `mailboxState: Map` | derived: `state.loading` |
| preferences | `settings.js` | `settings.get()` |
| category rules | `rules.js` | `rules` (reloaded, not captured) |
| selection | `Selection` instance | `selection` |
| undo history | `UndoStack` instance | `undoStack` |

### The rule that keeps being broken

> **Never capture a rebindable reference into a long-lived object.**

Three defects, one cause:

- `ctx.store` captured the inbox `Store` and froze it there. Fixed with a
  getter.
- `window.__bmmStore` did the same. Fixed the same way.
- `resetView()` called `store.clear()` meaning "clear everything", but `store`
  is the *active* mailbox — sign-out left five other mailboxes populated.

All three appeared when the per-mailbox refactor turned a singleton into a
collection. **Every existing capture of a value is suspect the moment that
value becomes a collection.** When in doubt, publish a getter.

---

## 3 · The `ctx` contract

`ctx` is the only sanctioned path from a feature to the shell. It is
deliberately small, and everything on it is either a function or a getter —
never a captured value.

```js
ctx = {
  get store(),        // ACTIVE mailbox store — getter, not a value
  state,              // const object, mutated in place
  send(verb, args),   // the only way to reach the platform layer
  toast(text),
  act(kind, id),
  openMessage(id),
  refresh(), release(), setTheme(id),
  themes(), categoryList(), selectCategory(key), runQuery(q),
}
```

**A feature may not** reach into shell internals, import `app.js`, or hold a
reference to anything on `ctx` across an `await`.

---

## 4 · The overlay lifecycle — the current gap

**This is the one place the architecture is not yet real.**

Four overlays — the theme menu, the category rule menu, the snooze picker and
the help dialog — each implement their own open/close/focus/dismiss lifecycle
by hand, in the shell. Measured: each `close*` function repeats 2–3 of the
same teardown steps, and two of the four independently wire their own
document-level outside-click listener.

The consequence is a **nine-branch hand-maintained `Escape` ladder** in the
global keydown handler. Every new overlay must remember to insert itself at
the correct depth. Nothing enforces the order; it is prose in a comment.

### Target: one overlay primitive, one stack

```js
// domain-free UI primitive, owned by the feature layer
const layer = openLayer({
  node,                    // the element to show
  onClose,                 // teardown
  dismissOnOutsideClick,   // handled once, not per overlay
  restoreFocusTo,          // captured on open, restored on close
});
```

- `Escape` pops **the top of the stack**. No ladder, no ordering comment.
- Focus restoration is the primitive's job, not each overlay's.
- Outside-click dismissal is wired once.
- A test asserts the stack unwinds innermost-first, which today is asserted
  by reading source order.

**Why this matters more than the line count:** the ladder is the only place in
the system where correctness depends on *the order statements appear in a
function*. Everything else is data-driven.

---

## 5 · Module size and placement

| Rule | Rationale |
|---|---|
| A self-contained UI surface with its own state is a **feature module**, not a section of `app.js`. | `features.js` already holds palette, compose, radar, undo. Four more surfaces sit in the shell for no reason but history. |
| The shell keeps: render loop, list diffing, reader, sidebar, routing, keyboard dispatch. | These are genuinely coupled through `renderedIds` and `nodeById`. Splitting them would create hidden coupling. |
| A domain concept has **one** implementation. | "The address in a From header" once had four, two of which disagreed on 6 of 9 inputs. |

**Explicitly not a goal:** a line-count target for `app.js`. Splitting coupled
code to hit a number is how hidden coupling gets created.

---

## 6 · Invariants that must stay true

These are enforced by tests. Each exists because it was once violated.

| Invariant | Enforced by |
|---|---|
| One render per settled state | render-invariant test |
| `state.loading` is *derived*, assigned in exactly one place | source lint |
| Bulk actions resolve through `renderedIds`, never `idsFor('all')` | seam test |
| Only the inbox advances the history cursor | `anchorHistory` tests |
| Settings load before the first `settings.get()` | ordering lint |
| No colour literal bypasses the theme tokens | CSS lint |
| No selector defined twice in one CSS layer | CSS lint |
| Every persistence entry point degrades on failure | failure injection |
| The address regex lives in exactly one module | source lint |

---

## 7 · Migration plan

Each step keeps the suite green and is independently revertible.

| # | Step | Risk | Status |
|---|---|---|---|
| 1 | Write this document | none | **done** |
| 2 | Introduce the layer primitive; migrate the **help** overlay | low | |
| 3 | Migrate the **theme menu** | low | |
| 4 | Migrate the **category rule menu** | low | |
| 5 | Migrate the **snooze picker** | low | |
| 6 | Replace the `Escape` ladder with stack unwinding | medium | |
| 7 | Enforce the layering rules with a dependency test | low | |

**Order rationale:** help is the simplest (no anchor, no outside-click), so it
proves the primitive. The ladder is replaced *last*, once every overlay is on
the stack — replacing it first would mean maintaining both mechanisms.

Threading should not begin until step 6 lands, because threading enlarges the
render section, which is already the largest thing in the shell.
