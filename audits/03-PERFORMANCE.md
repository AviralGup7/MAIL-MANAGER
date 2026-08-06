# Audit 3 — Performance

Scope: the paths that run on every keystroke, every frame, and every sync.
Method: measured, not reasoned about. Every number below came from running the
real `Store` and the real classifier on this machine (2 cores). Numbers move
between machines; the *shapes* do not.

**Verdict: the data layer is genuinely fast and the headline claim holds. The
one real risk is a rendering cost that no test currently measures, because it
lives in the DOM and every benchmark here is headless.**

---

## What was measured

| Operation | Scale | Result | Budget | Verdict |
|---|---|---|---|---|
| `classify()` | 2000 msgs | **11.2 ms** | — | fine |
| `classify()` realistic mix | 5000 msgs | **90 ms** (18 µs each) | — | fine |
| `upsertMany` | 100-msg page | **0.89 ms** | 16 ms | fine |
| 20 pages ingested | 2000 msgs | **17.8 ms total** | — | fine |
| `idsFor('all')` | 2000 msgs | **0.053 ms** | 16 ms | fine |
| `idsFor(category)` | 2000 msgs | **0.030 ms** | 16 ms | fine |
| `counts()` + `unreadCounts()` | 2000 msgs | **0.047 ms** | 16 ms | fine |
| `search('reg')` prefix | 2000 msgs, 5997 tokens | **0.42 ms** | 16 ms | fine |
| `remove()` ×100 worst case | 2000 msgs | **0.7 ms** | — | fine |
| Renders per 200-msg sync | — | **1** | — | claim holds |

The central architectural claim of this rewrite — *one render per settled
state, not one per mutation* — is verified. Ingesting 2000 messages triggers
exactly one render.

---

## Two suspicions I raised and then disproved

Recording these because a performance audit that only reports confirmations is
not an audit.

**`unreadCounts()` on every render.** It iterates every id in every category
set, and `renderSidebar()` runs on every notification including single-row
patches. Looked like an obvious per-frame O(n) cost. Measured: **0.047 ms at
2000 messages** — 0.3% of a frame budget. Not worth optimising, and caching it
would add invalidation bugs for no gain. **No action.**

**Prefix search scanning the whole token index.** `store.js:307` walks every
token in `searchIndex` for each search term, which is O(tokens) per keystroke
and looked like the classic incremental-search mistake. Measured at 5997
tokens: **0.42 ms**. Twenty-five keystrokes per frame budget. A trie would be
faster and is not justified. **No action** until the index exceeds ~50k tokens,
which needs roughly 15,000 messages — well past the 2000 cap.

My initial reading of "33.6 ms" for search was 100 iterations misread as
per-call. Corrected above.

---

## P-1 — MODERATE — no rendering benchmark exists, and rendering is the untested half

Every number in this audit is headless. `test/bench.mjs` measures classify and
store; the jsdom integration tests assert correctness, not timing. **Nothing
measures the actual cost of `renderList()` against a real layout engine**, and
that is precisely where the old version died.

This matters because the design deliberately leans on a CSS feature to avoid
writing a virtualiser:

```css
.row {
  contain: layout paint style;
  content-visibility: auto;
  contain-intrinsic-size: var(--row-h);
}
```

`content-visibility: auto` is the entire reason a 2000-row list is claimed to
scroll at 60 fps. If it underperforms — or if a future CSS change causes a row
to be measured rather than skipped — the regression is invisible to all 121
tests and shows up only as the exact symptom that made v1 unusable.

Also unmeasured: `fillRow()` runs `li.querySelector()` six times per row per
update. At 400 rows that is 2400 selector queries per full render. Guarded
`textContent` writes avoid the style recalc, but the queries themselves are not
free and could be replaced with cached child references captured in `buildRow`.

**Fix:** add a Playwright or headless-Chrome timing harness that loads
`preview.html` with 2000 synthetic rows and asserts (a) time to first paint,
(b) scroll frame duration stays under 16 ms, (c) `renderList()` wall time for a
full category switch. Until that exists, the 60 fps claim in `README.md` is an
expectation, not a measurement, and should be worded that way.

---

## P-2 — LOW — `remove()` is O(n), and the delta path can call it in a loop

`store.js:207`

```js
const i = this.order.indexOf(id);
if (i !== -1) this.order.splice(i, 1);
```

Linear scan plus a splice per removal. Measured at 2000 messages: 100 removals
worst-case (oldest first) costs **0.7 ms** — completely fine, and the common
case is 1–5 removals from a delta.

It becomes O(n·m) only if a delta removes hundreds at once, which happens after
a bulk archive on another device. At 2000 × 1000 that is roughly two million
comparisons plus a thousand array shifts — enough to be felt, though still not
catastrophic.

**Fix:** low priority. If touched, maintain a `Map<id, index>` alongside
`order`, or mark removed entries and compact lazily. Do not do this
speculatively — measure a bulk-archive delta first.

---

## P-3 — LOW — the 400-row cap is a performance guard that is no longer needed

`app.js:181` truncates the rendered list to 400. Its justification is render
cost, but `content-visibility: auto` already skips off-screen rows, which is
the documented reason no virtualiser was written. The cap therefore defends
against a cost the CSS removed — while causing a **correctness** bug: messages
401+ become unreachable by scroll, click and keyboard (see
`audits/01-CORRECTNESS.md`, C-1).

This is the one place where a performance decision actively broke behaviour.
Resolve it as a correctness fix, and let P-1's harness prove the cap is
unnecessary rather than assuming it either way.

---

## Standing constraints worth preserving

These are the properties that make the current numbers possible. A future
change that violates one should be treated as a regression even if tests pass.

- **No `MutationObserver`, no `setInterval`, no polling.** Verified absent from
  `src/`. v1 had an undebounced re-entrant observer plus a 300 ms refresh timer.
- **No permanent `requestAnimationFrame` loop.** The takeover animation runs
  once and stops. v1 ran an 840-line canvas rAF loop forever, on every mount.
- **Classification is synchronous.** No promise per message, no concurrency
  semaphore for work that never blocks.
- **Three transition durations, two easings.** v1 had eleven and twelve.
- **Only `transform` and `opacity` are animated.** Nothing in the animation
  path touches layout.
- **Indexes are incremental.** No `rebuild()` in the hot path.
