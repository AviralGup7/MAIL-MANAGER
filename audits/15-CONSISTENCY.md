# Audit 15 — Product Consistency

**Question asked:** not "does this work?" but "do similar things work the same
way?"

Every finding below was reached by putting two siblings side by side and
noticing they disagreed. None of them is a bug: each feature works exactly as
written. They are places where the product grew in two directions at once.

Seven findings. Six were real and are fixed. One was a suspicion that turned
out to be a deliberate design and is recorded rather than deleted.

---

## C-1 — Star and mark-unread had no undo, one message at a time

**Severity: high.** The clearest drift in the product.

Every single-message action routes through `optimistic()` and records a
reversal — archive, trash, spam, restore, unsnooze. Two do not. `star` and
`unread` predate the helper and were never migrated:

```js
case 'star': {
  const on = !m.starred;
  store.patch(id, { starred: on });
  send('STAR', { id, on }).catch(/* rollback */);
  break;                       // no recordUndo
}
```

Meanwhile `bulkAct` has recorded undo for **the same two verbs** all along. So:

| gesture | undo? |
|---|---|
| tick two rows → Star | ✅ "Starred 2 messages", Undo button |
| open one message → `s` | ❌ nothing at all |

Same intent, same user, recovery decided by how many rows happened to be
ticked. This is not a product judgement that starring is too trivial to
reverse — the product already ruled the other way, in the other path.

**Why they could not simply use `optimistic()`:** that helper is built around
taking a message *out* of the list. It snapshots, moves the selection to a
neighbour and calls `store.remove`. A starred message stays exactly where it
is, keeping its place.

**Fix:** `flagAction()`, the flag-shaped counterpart. Patch now, send after,
roll back on failure, record the reversal. The two helpers share the contract
the user can actually feel — recovery — and differ only where the DOM genuinely
differs.

---

## C-2 — Two of the three error channels were silent to assistive technology

**Severity: high.**

| surface | semantics | announced? |
|---|---|---|
| `#toast` | `role="status" aria-live="polite"` | ✅ |
| `#gate-error` | none | ❌ |
| `#c-status` | none | ❌ |

All three carry the same kind of message. `#c-status` says *"Add a
recipient"*, *"Check the address: …"* and whatever a failed send returned.
`#gate-error` carries every auth failure, including the multi-line one with
the `FIX:` paragraph.

A sighted user sees three channels. A screen-reader user hears one. The worst
case is pressing **Send** with an empty recipient: the mail does not go, and
the app appears to have ignored the keystroke entirely.

**Fix:** both get `role="alert"`. Assertive rather than polite is deliberate —
unlike the toast, which also narrates routine success, these appear *only*
when the user is blocked. The toast keeps `role="status"` for the same reason.

---

## C-3 — The gate was not a dialog, and took no focus

**Severity: high.** Two defects on one surface.

Four overlays declare themselves dialogs — compose, palette, help, timetable.
The gate, which covers the **entire application** and blocks all of it until
you sign in, declared nothing. It is the most modal thing in the product and
had the least semantics of any of them: to a screen reader, an unlabelled
`<div>` containing a button.

It also focused nothing on open, while all four others move focus in (help →
close button, palette → input, compose → first empty field). So a keyboard
user met a modal surface with focus parked on `<body>` behind it.

It is the **first screen a new user ever sees**, which makes it the worst place
in the product to drop focus.

**Fix:** `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, and
`showGate()` focuses the sign-in button.

---

## C-4 — Four reader buttons hid their own shortcuts

**Severity: medium.**

| button | shortcut | advertised? |
|---|---|---|
| Snooze | `z` | ✅ `title="Snooze (z)"` |
| Report spam | `!` | ✅ |
| Star | `s` | ❌ |
| Mark unread | `u` | ❌ |
| Archive | `e` | ❌ |
| Delete | `#` | ❌ |

The keys all work and the help overlay lists them. But the `ctx` toolbar two
inches above the reader bar shows `Archive (e)`, `Star (s)`, `Delete (#)` — so
**the same verb advertised its key on one toolbar and hid it on another**.

That is precisely how a keyboard-first product fails to teach itself.

**Fix:** all four now carry the hint. The test derives its expectation from the
shortcut registry (`when: 'reader'`) rather than from a hand-written list, so a
seventh action cannot be added silently.

---

## C-5 — Settings changed in Options never reached the running app

**Severity: high.** The one finding that is close to a functional defect.

`settings.get()` is a synchronous read of an in-memory cache filled once by
`loadSettings()` at boot. `settings.subscribe()` was exported, documented — and
had **zero callers**.

It could not have helped even if someone had registered one. The options page
is a *separate extension page* with its own module instances, so nothing it
writes can reach an in-process listener. Nothing listened to
`chrome.storage.onChanged`, which is the only channel that crosses pages.

The user-visible result: turn off *"mark read on open"* in Options, return to
the still-open mail tab, and it keeps marking mail read — silently, until the
tab is reloaded.

This is the same shape as the dead schema keys the suite already guards
against, and the project's own standard applies: *build it or delete it.*

**Fix, in two halves, because the two are genuinely different:**

- `settings.followExternalChanges()` listens to `chrome.storage.onChanged`,
  coerces through the same `coerce()` that `loadSettings` uses (so a corrupt
  stored value cannot enter the cache by the back door), and emits.
- A current cache is enough for `markReadOnOpen`, read at the moment a message
  opens. It is **not** enough for `threaded`, read in six render paths — the
  list was already drawn from the old value. That half subscribes and repaints.

Wiring the second half finally gave `subscribe()` a caller.

---

## C-6 — Five copies of `fakeStorage`, four different contracts

**Severity: medium** — test infrastructure, but the audit brief asks for it.

| file | `remove()` | missing key returns | accessor |
|---|---|---|---|
| `cache.test` | ✅ | `{}` | `.data` |
| `views.test` | ✅ | `{}` | `.d` |
| `draft-store.test` | ✅ | `{k: undefined}` | `_data()` + `writes` |
| `rules.test` | ❌ | `{k: undefined}` | `_data()` |
| `snooze.test` | ❌ | `{k: undefined}` | `_data()` + `_fail()` |

**Three of the five could never have caught a stray `storage.remove` call** —
the method does not exist on them, so the module under test would throw a
`TypeError` reading as an unrelated failure.

The missing-key disagreement is the interesting one. Chrome resolves
`get('k')` for an absent key to `{}` — the key is **not present** — not to
`{k: undefined}`. Two fakes were simply wrong about the API they impersonate.

**Checked whether that hid a bug: it does not.** Every consumer writes
`got[KEY]`, and both shapes yield `undefined`. Recorded rather than assumed,
and unified anyway — a fake that is wrong about its contract is a trap set for
the next person.

**Fix:** `test/helpers/storage.mjs`, modelling the real API once. Sabotaging it
fails all five files, which is the proof it is load-bearing rather than
decorative.

---

## C-7 — RETRACTED: the duplicated Escape handlers

**Suspicion:** compose and the palette each have their *own* Escape handler
*and* a branch in the document-level ladder. Two paths for one dismissal looked
exactly like the drift this audit was hunting.

**Disproved by measurement.** A focus probe shows the two fire in mutually
exclusive situations:

```
focus INSIDE compose  -> panel handler: 1, ladder: 0   (stopPropagation)
focus OUTSIDE compose -> panel handler: 0, ladder: 1
```

The panel handler serves the common case — you are typing in the message. The
ladder serves the case where compose is open but focus has moved elsewhere,
which the panel listener can never see. Both are reachable, both are needed,
and removing either would leave a dead spot.

Kept as written. Recorded because a future audit will notice the same shape and
should not have to re-derive this.

---

## Verification

Every fix was **sabotage-verified**: the new test was confirmed to fail when the
old behaviour is put back, not merely to pass against the new code.

Two of my own assertions were wrong and were corrected by the product rather
than the reverse:

- I asserted the auto-archive toast reads *"Auto-archived 3 messages"*. It
  reads *"Auto-archived 3"* plus an Undo affordance.
- I asserted pressing `u` on `m1` marks it unread. `m1` seeds **unread**, and
  `u` is a toggle, so it correctly marked it read. The test was wrong.

```
tests: 885 → 888, 0 skipped
all six themes still pass WCAG AA
```

---

## What was checked and found already consistent

Recorded so a later pass does not repeat the work:

- **Menus** — all four use the primitive. The three remaining arrow-key
  handlers are a roving-tabindex rail and two comboboxes: different patterns,
  correctly not forced through `openMenu`.
- **Icon-only buttons** — all seven carry `aria-label`.
- **Empty states** — one code path, six messages, consistent structure.
- **Bulk label deltas** — single-sourced in `BULK_ACTIONS` (audit 14).
- **Settings schema** — every declared key has both a writer and a reader.
- **Optimistic mutation** — every removal action routes through `optimistic()`;
  every flag action now routes through `flagAction()`.
