# Audit 1 — Correctness

Scope: does the code do what it claims, on paths the test suite does not reach.
Method: read every file in `src/`, then verify each suspicion by running it.
Nothing below is a guess; each finding has the command that proved it.

**Verdict: 3 confirmed defects, one of them silently hides mail.**

---

## C-1 — SEVERE — the list silently caps at 400 rows and there is no way past it

`src/app/app.js:181`

```js
const next = ids.length > 400 ? ids.slice(0, 400) : ids;
```

`renderedIds` is set to this truncated array, and `renderedIds` is what
`move()` (j/k) and `selectNeighbourThen()` walk. So messages 401+ are not
merely unrendered — they are **unreachable by every input path**: not by
scrolling, not by keyboard, not by click.

Proved:

```
store size: 600
idsFor('augsd'): 600
=> UI shows 400. 200 messages exist, are classified, are counted in the
   sidebar, and cannot be opened.
```

The sidebar count says 600. The list header says "400 of 600". Neither
explains that the remaining 200 are not merely below the fold.

Worse, this interacts badly with **Load more**: the button fetches another 100
into the store, the store grows to 700, and the list still shows 400. The
button appears to do nothing while quietly increasing the hidden set.

The 400 was chosen as a rendering guard, but `content-visibility: auto` already
makes off-screen rows nearly free — that is the documented justification for
not writing a virtualiser. The cap is therefore defending against a cost the
CSS already removed.

**Fix:** remove the slice, render all of `visibleIds()`, and rely on
`content-visibility`. If a guard is still wanted, make it a windowed virtual
list, not a truncation. Verify with 2000 rows before and after.

---

## C-2 — SEVERE — nothing is ever persisted, so every takeover refetches the inbox

`src/app/store.js:30` states as one of the three headline design fixes:

```
 *   3. DELTA PERSISTENCE. Only changed message IDs are written, and only after
 *      the batch settles.
```

There is no persistence. The only `chrome.storage.local.set` calls in the whole
codebase are:

```
src/app/app.js:727        theme
src/background/auth.js:151 tokens
src/background/sync.js:29  historyId
src/options/options.js:60  clientId
```

`boot()` reads `theme` and nothing else. There is no cache read, no cache
write, no `messages` key.

Consequences:

- Every single takeover does a cold `SYNC_PAGE`: one list call plus one batch
  call, ~100 messages, before anything appears. The user watches an empty list
  on every open.
- The `historyId` cursor is persisted, so the machinery for a cheap delta is
  present and working — but there is no local state for it to be a delta
  *against*. On the very next open we throw the messages away and full-sync
  anyway, which makes the History API integration mostly decorative.
- The v1 comparison table in `README.md` claims v2 writes "changed ids, after
  the batch settles" versus v1's "whole array rewritten per mutation". v2
  writes nothing at all, which is faster but is not what is documented.

**Fix:** persist message headers on a debounced idle write, keyed by id; hydrate
the store in `boot()` before the first render, then run `SYNC_DELTA` instead of
`SYNC_PAGE`. That is what makes the historyId cursor pay for itself, and it is
the difference between "opens instantly" and "opens in a second and a half".
Either implement it or delete the claim from the comment and the README.

---

## C-3 — MODERATE — no retry on 429 or 5xx; a rate-limit reads as a hard error

`src/background/gmail.js:40` and `:96`

```js
if (!res.ok) throw new Error(`Gmail ${res.status} ${path} ...`);
```

Every non-2xx is fatal and identical. Gmail returns `429` with a `Retry-After`
header and `403 rateLimitExceeded` under per-user quota, and `503` during
maintenance. All are transient and all are expected on a normal sync of a busy
inbox — a 100-message batch is a burst by definition.

The user sees a toast reading `Gmail 429 /messages` and the sync stops. There
is no automatic recovery; they must click Refresh, which issues the same burst
and is likely to fail again.

Confirmed absent:

```
$ grep -n "429\|503\|retry\|backoff\|Retry-After" src/background/*.js
(only an unrelated comment in auth.js)
```

**Fix:** wrap `api()` in bounded exponential backoff — 3 attempts, honour
`Retry-After` when present, jitter the delay — and only surface an error to the
UI once the retries are exhausted. Distinguish retryable (`429`, `500`, `502`,
`503`, `504`) from terminal (`400`, `401`, `403 insufficient scope`, `404`).

---

## Verified correct

These were suspected and checked; each is sound.

| Area | Result |
|---|---|
| PKCE `state` verification | Present and enforced (`auth.js:116`), aborts on mismatch |
| Token refresh concurrency | Single-flight via `inFlight` promise (`auth.js:174`) — no thundering herd |
| `reduceHistory` last-event-wins | 20 tests, add/remove sets provably disjoint |
| Batch sub-response failures | Dropped individually, one bad message cannot empty the inbox |
| `internalDate` over `Date:` header | Correct; the header is attacker-controlled |
| Optimistic triage rollback | Every action restores prior state on rejection |
| `Store` index consistency | Incremental, no `rebuild()` in the hot path, verified by shuffled-input tests |
| Empty `catch` blocks | None. Every catch either recovers or comments why it is safe to ignore |
