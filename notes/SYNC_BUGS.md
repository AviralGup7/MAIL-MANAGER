# Four bugs found reviewing `syncDelta()` before it ever ran

`src/background/sync.js` was written in the same pass as the rest of the sync
layer and never exercised. Reading it back against the Gmail History API docs
turned up four defects, three of which lose mail silently. Notes kept because
"silently loses mail" is the exact failure class the old version had and the
reason this rewrite exists.

---

## Bug 1 — history pagination ignored, and the cursor advances anyway

`history()` requests `maxResults=500` and returns `data.history`, but never
follows `data.nextPageToken`.

```js
const data = await api(`/history?${params}`);
return { changes: data.history || [], historyId: data.historyId };
```

On its own that is only "we miss some changes". What makes it data loss is the
next step: `syncDelta()` then writes `res.historyId` as the new cursor.
`data.historyId` is the **mailbox's current** history ID, not the ID of the
last record we actually read. So the unread pages are not merely skipped — the
cursor jumps past them and they can never be requested again.

Triggered by: coming back to a busy inbox after a few days, or any bulk label
operation. Symptom: mail that is in Gmail simply never appears, and a refresh
does not help, forever.

**Fix:** page until `nextPageToken` is exhausted, with a page cap so a
pathological mailbox cannot spin. If the cap is hit, return `tooOld` and force
a full resync rather than advancing the cursor over unread records.

---

## Bug 2 — un-archiving never brings a message back

`labelsAdded` carried this comment:

```js
// Archiving = INBOX removed. Adding INBOX back means it is inbox again.
```

…and then did nothing about it. Only `UNREAD` and `STARRED` were read from
`labelIds`. A message that gains the `INBOX` label — un-archived by the user in
another client, or a thread that receives a reply and is pulled back into the
inbox — produces a `labelsAdded` record, never a `messagesAdded` record.
`messagesAdded` fires only when a message first arrives in the mailbox.

So the comment described the correct behaviour and the code implemented the
opposite. Un-archived mail stayed invisible until a full resync.

**Fix:** `labelsAdded` containing `INBOX` is treated as an add.

---

## Bug 3 — add and remove of the same message resolved in the wrong order

History records are chronological, and one message can appear many times
across them. The old loop accumulated into two independent sets:

```js
removed.add(message.id);
addedIds.delete(message.id);   // in messagesDeleted only
```

`messagesDeleted` removed the id from `addedIds`, but `labelsRemoved`
(archive) did not. So archive-then-unarchive left the id in **both** sets. The
app then did:

```js
ingestInto(res.added);                        // put it in
for (const id of res.removed) store.remove(id); // take it straight back out
```

Final state: gone, despite being in the inbox. The reverse sequence
(unarchive-then-archive) produced the opposite error.

The underlying mistake is modelling this as two sets at all. What the History
API describes is a **sequence of events per message**; only the last one for
each message matters.

**Fix:** a single `Map<id, 'add'|'remove'>` written in record order, so the
last event wins by construction. The returned `added` and `removed` are
disjoint, which also means the app no longer depends on applying them in a
particular order.

---

## Bug 4 — added messages past 100 were dropped on the floor

```js
const ids = [...addedIds].slice(0, BATCH_SIZE);
```

`BATCH_SIZE` is Gmail's limit on one `/batch` request, not a limit on how many
messages can arrive between two syncs. `slice` silently discarded the rest,
and the cursor still advanced past them.

**Fix:** chunk into groups of 100 and issue the batches, rather than truncating.
A cap remains, but it is explicit and it forces a resync instead of pretending
the extra mail does not exist.

---

## Bug 5 (minor) — a deleted message could still carry a pending patch

`messagesDeleted` added to `removed` but left any entry in `patched`. The app
would then call `store.patch()` on an id it had just removed. `Store.patch()`
no-ops for an unknown id, so this was harmless in practice — but it is
harmless by luck, not by design.

**Fix:** patches for ids whose final state is `remove` are dropped in
`syncDelta`.

---

# Two more, found by the jsdom integration harness

`test/app.integration.test.mjs` boots the real `app.html` in a real DOM and
drives it as a user would. It found both of these on its first run. Neither was
reachable by a unit test, because both are about how two correct pieces are
wired together.

## Bug 6 — archiving updated the store and never updated the screen

`Store.idsFor('all')` returned `this.order` — the live internal array, not a
copy. The app stores that result as `renderedIds`, the baseline it diffs the
next render against. So `renderedIds` and `store.order` became **the same
object**.

Every later render then did:

```js
if (sameOrder(next, renderedIds))   // next IS renderedIds
```

…comparing the array against itself, always true, always taking the fast path
that only patches existing rows. Removing a message mutated `store.order`,
which mutated `renderedIds` at the same time, so the diff could never observe
a difference.

Symptom: archive or delete a message and nothing happens. The store is correct,
Gmail is correct, the DOM is stale forever. The kind of bug that gets described
as "it became extremely slow and unusual".

**Fix:** `idsFor` returns `this.order.slice()`. A few microseconds for a few
thousand strings, against an aliasing hazard that silently breaks the render
loop. Two regression tests, including one that mutates the returned array to
confirm the store is unaffected.

## Bug 7 — an empty inbox showed a blank pane with no explanation

Two independent causes, both of which had to be fixed:

1. `el.empty.hidden` was assigned only at the **end** of `renderList`, after
   the fast-path `return`. With zero messages `next` and `renderedIds` are both
   `[]`, `sameOrder` is true, and the function returned before ever revealing
   "Nothing here."
2. More fundamentally, `renderList()` was only ever called from a store
   notification, and the store does not notify when nothing changed. An account
   that syncs zero messages produced **no render at all**.

Symptom: a new user, an empty inbox, or any category with no mail gets an empty
grey rectangle and no indication whether it is loading, broken, or genuinely
empty.

**Fix:** set the empty state on both paths, and call `renderList()` once during
boot so the first paint is always explicit.
