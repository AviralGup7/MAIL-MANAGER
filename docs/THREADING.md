# Conversation threading

The last major architectural feature. Shipped in three steps — store, then
list and reader, then the remaining subsystems — because every later part
reads from the one before it.

---

## The model

`byThread` is a third **incremental** index beside `byCategory` and
`searchIndex`, maintained in `_index`/`_deindex`. Rebuilding a thread map per
render is the obvious implementation and is O(n) on every keystroke; nothing
in this store is recomputed wholesale and threading is not the exception.

```
Store.threadOf(msg)    threadId, falling back to the message id
store.threadIds(tid)   members, newest first
store.thread(tid)      the conversation as an object, or null
store.rootIds(ids)     one id per conversation — what the list renders
```

`thread()` is computed on demand rather than cached. A conversation is a
handful of messages, and a cached summary is one more thing that can drift
from what it describes. The expensive part — finding the members — *is*
indexed.

Measured at **2000 messages / 667 conversations**: ingest 16ms, `rootIds()`
0.14ms, `thread()` 0.04ms.

---

## The rules

These are the decisions that make threading coherent rather than a pile of
special cases. Each one is enforced by a test.

| Question | Rule | Why |
|---|---|---|
| Where does collapsing happen? | **`visibleIds()`, once** | Every render path already goes through it — list, counts, bulk, `j`/`k` — so each inherits threading with no special case. |
| What does a row show? | The **original** subject, participants, count | A conversation is named for what it is about, not for the last reply, which is almost always "Re: …". |
| When is a conversation unread? | If **any** message in it is | Deriving it from the newest message hides an unread reply under a read one. |
| What does opening one do? | Lands on the **newest** message | That is the one you came to read; the strip gives the rest. |
| What does read state apply to? | **One message** | Marking a thread read because you glanced at the newest reply destroys the one piece of triage a user cannot reconstruct. |
| What does a tick mean? | The **conversation** | The row *is* the conversation. |
| What does archive/delete/spam do? | The **whole exchange** | Archiving one reply leaves the row on screen showing the next message down, which reads as the action having failed. |
| What about star and mark-unread? | **One message** | Both are per-message judgements. Starring three messages because you starred one throws away information the user deliberately created. |
| What does reply answer? | The message **on screen** | Replying to the root while reading a later message attaches the reply to the wrong point and quotes the wrong text. |
| What does search show? | **Individual messages** | See below. |

### Search is deliberately not collapsed

When you search you want a **message**. Hiding the match behind a newer reply
in its conversation is the wrong answer — you would see *"Revised schedule"*
after searching for a phrase that appears only in the corrigendum.

Gmail collapses search results and it is the most complained-about thing it
does.

This needed a second fix beyond `visibleIds()`. The row was uncollapsed but
`fillRow` still dressed it in the conversation's subject, participants and
count, so the result *did not contain what was searched for*. Rows only wear
conversation clothing when no query is active.

---

## Two regressions that shaped the design

Neither was predicted. Both changed the design rather than being patched
around.

**Selection had to become per-conversation.** Threading broke the existing
test *"selection survives a re-render"*: tick a row, receive a newer message
in that conversation, and the rendered root is replaced — so the ticked id is
no longer a row and the tick visually vanished. The user ticked a conversation
and a reply silently un-ticked it. Hence `hasThread()` and `liveThreaded()`.

**One existing test was wrong, not the code.** It reused a fixture whose
`threadId`s collided with rows it had already ticked, so the "new" mail joined
those conversations and displaced them. That is correct product behaviour — it
has its own test now — but this test is about *unrelated* mail arriving
mid-triage, so its arrivals got distinct threads.

---

## Why the reader uses a strip

One entry per message feeding the **single** sandboxed body frame, rather than
a stack of expanded bodies.

Each body is an origin-less sandboxed document. Five of them would be five
sanitiser passes and five layouts for four bodies nobody is reading. The strip
is hidden entirely on a single-message conversation, so most mail keeps
exactly the reader it always had.

`loadBody()` was extracted from `openMessage` so both paths share one
stale-response token, one inline-image prefetch and one mark-read grace
period. Two copies of that is how two readers drift.

---

## What it did not need

**The IndexedDB migration was assumed to be a prerequisite. It was not.**
Threading needed an index over messages already in memory, not more of them on
disk. The migration matters for *how many* messages can be held, which is a
separate question — and blocking on it would have deferred this indefinitely.

---

## Edge cases covered

- **Thread merge/split.** Gmail reassigns `threadId` when it decides two
  conversations are one; a delta then re-upserts the same id with a new
  thread. Without cleaning the old Set the message lives in both forever.
- **A conversation spanning two categories.** The classifier runs per message,
  so a reply can be filed differently from the message it answers. Collapsing
  happens *after* filtering, so the conversation appears under any category
  holding one of its messages, rooted at the newest that qualifies — findable
  where you expect rather than hidden under a sibling's label.
- **A reply arriving into a ticked conversation.** The tick follows.
- **Warm start from cache.** `threadId` is field 2 of the packed record, so a
  cached start collapses identically — no flicker on the first paint.
- **A message with no `threadId`.** Falls back to its own id, so locally-built
  and older cached records stay separate rather than collapsing into one bogus
  conversation keyed on `undefined`.

---

## Turning it off

`threaded` in settings, on by default, with a control in Options. The store
keeps both views cheap from one index: `order` is the flat list and
`rootIds()` is the collapsed one. Some people genuinely prefer strict
chronological order, and search behaves identically either way.
