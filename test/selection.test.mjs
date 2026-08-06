/**
 * Selection semantics.
 *
 * `selection.js` had NO unit tests, which is how the shift-range bug shipped:
 * a range could grow but never shrink, so correcting an overshoot was
 * impossible and the only way out was to clear everything and start again.
 *
 * These pin the behaviour against Gmail's, which is also Finder's and
 * Explorer's: the live range is TRANSIENT and recomputed from the anchor on
 * every shift-click, while selections made before the anchor survive.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { Selection, selectionLabel } = await import('../src/app/selection.js');

const IDS = ['a', 'b', 'c', 'd', 'e', 'f'];
const sel = (s) => [...s.ids].sort().join(',');

// ------------------------------------------------------------------ basics --

test('toggle adds, removes, and sets the anchor', () => {
  const s = new Selection();
  s.toggle('b');
  assert.equal(sel(s), 'b');
  assert.equal(s.anchor, 'b');
  s.toggle('b');
  assert.equal(sel(s), '');
  assert.equal(s.active, false);
});

test('a range with no anchor just selects the clicked row', () => {
  const s = new Selection();
  s.range('c', IDS);
  assert.equal(sel(s), 'c');
});

test('a range selects everything between the anchor and the target', () => {
  const s = new Selection();
  s.toggle('b');
  s.range('e', IDS);
  assert.equal(sel(s), 'b,c,d,e');
});

test('a range works backwards as well as forwards', () => {
  const s = new Selection();
  s.toggle('e');
  s.range('b', IDS);
  assert.equal(sel(s), 'b,c,d,e');
});

// ------------------------------------------------------------- THE BUG -----

/*
 * The regression this file exists for.
 *
 * Shift-click `e`, realise you went one too far, shift-click `d`. The range
 * must SHRINK. Before the fix the loop only ever added, so `e` stayed ticked,
 * the count never came back down, and the user had to clear and restart.
 */
test('shift-clicking back SHRINKS the range', () => {
  const s = new Selection();
  s.toggle('b');
  s.range('e', IDS);
  assert.equal(sel(s), 'b,c,d,e');

  s.range('d', IDS);
  assert.equal(sel(s), 'b,c,d', 'correcting an overshoot must deselect the row you passed');
  assert.ok(!s.ids.has('e'));
});

test('the anchor does not move as the range is adjusted', () => {
  // Repeated shift-clicks extend from the same origin. An anchor that crept
  // along would make the range depend on click history, not on the two ends.
  const s = new Selection();
  s.toggle('b');
  s.range('e', IDS);
  s.range('d', IDS);
  s.range('f', IDS);
  assert.equal(s.anchor, 'b');
  assert.equal(sel(s), 'b,c,d,e,f');
});

test('a range can flip across the anchor', () => {
  const s = new Selection();
  s.toggle('d');
  s.range('f', IDS);
  assert.equal(sel(s), 'd,e,f');
  s.range('b', IDS);
  assert.equal(sel(s), 'b,c,d', 'crossing the anchor replaces, never unions both sides');
});

// --------------------------------------------- selections outside the range --

test('rows selected before the anchor survive the range', () => {
  // Ctrl-click f, then shift-select b..d. Losing f would destroy work the
  // user had already done.
  const s = new Selection();
  s.toggle('f');
  s.toggle('b');
  s.range('d', IDS);
  assert.equal(sel(s), 'b,c,d,f');
});

test('those rows survive the range SHRINKING too', () => {
  const s = new Selection();
  s.toggle('f');
  s.toggle('b');
  s.range('d', IDS);
  s.range('c', IDS);
  assert.equal(sel(s), 'b,c,f', 'f is outside the range and must be untouched');
});

test('a plain click after a range starts a new origin', () => {
  // Otherwise the next shift-click would recompute against a stale snapshot
  // and resurrect rows the user had moved past.
  const s = new Selection();
  s.toggle('b');
  s.range('d', IDS);
  s.toggle('e');
  assert.equal(s.anchor, 'e');
  s.range('f', IDS);
  assert.equal(sel(s), 'b,c,d,e,f', 'the earlier range is now ordinary selection');
});

test('clear resets the range origin as well as the ids', () => {
  const s = new Selection();
  s.toggle('b');
  s.range('e', IDS);
  s.clear();
  assert.equal(sel(s), '');
  assert.equal(s.anchor, null);
  // A stale snapshot here would reappear on the next shift-click.
  s.toggle('c');
  s.range('d', IDS);
  assert.equal(sel(s), 'c,d');
});

test('selectAll then a range does not resurrect the whole list', () => {
  const s = new Selection();
  s.selectAll(IDS);
  assert.equal(sel(s), 'a,b,c,d,e,f');
  s.toggle('b'); // deselects b and becomes the anchor
  s.range('d', IDS);
  assert.ok(s.ids.has('d'));
  assert.ok(s.ids.has('f'), 'rows outside the range keep their state');
});

// ---------------------------------------------------------------- filtering --

test('a range never picks up rows hidden by a filter', () => {
  // The user is selecting what they can SEE. Silently including filtered-out
  // messages in a bulk delete is unrecoverable.
  const s = new Selection();
  const visible = ['a', 'c', 'e'];
  s.toggle('a');
  s.range('e', visible);
  assert.equal(sel(s), 'a,c,e');
  assert.ok(!s.ids.has('b'), 'b is filtered out and must not be selected');
  assert.ok(!s.ids.has('d'));
});

test('a range to a row that is no longer rendered degrades safely', () => {
  // A delta sync can remove the anchor between clicks.
  const s = new Selection();
  s.toggle('zzz'); // not in IDS
  s.range('c', IDS);
  assert.equal(sel(s), 'c,zzz', 'falls back to selecting the clicked row');
});

// ------------------------------------------------------------ notification --

test('subscribers are told when the size changes', () => {
  const s = new Selection();
  const seen = [];
  s.subscribe((n) => seen.push(n));
  s.toggle('a');
  s.range('c', IDS);
  s.clear();
  assert.deepEqual(seen, [1, 3, 0]);
});

test('clearing an empty selection does not notify', () => {
  const s = new Selection();
  let calls = 0;
  s.subscribe(() => calls++);
  s.clear();
  assert.equal(calls, 0, 'a no-op must not repaint the bulk bar');
});

/* ---------------------------------------------------- live() reconciliation --

 * Found by mutation testing: changing `has(id) && store.get(id)` to `||`
 * survived the whole suite, so the reconciliation this method exists for was
 * never verified.
 *
 * It matters because Gmail's `batchModify` is all-or-nothing: one dead id
 * fails the ENTIRE request. A delta sync can remove a message between the
 * user ticking it and pressing Archive, so the set must be reconciled against
 * the store rather than trusted.
 */

/** Minimal store stand-in: only `get` is used by `live()`. */
const fakeStore = (ids) => ({ get: (id) => (ids.includes(id) ? { id } : undefined) });

test('live() drops ids the store no longer has', () => {
  const s = new Selection();
  s.toggle('a');
  s.toggle('b');
  s.toggle('c');
  // 'b' was removed by a delta sync while the user was choosing.
  const out = s.live(fakeStore(['a', 'c']), IDS);
  assert.deepEqual(out, ['a', 'c'], 'a dead id would fail the whole batch request');
});

test('live() drops ids that exist but are not selected', () => {
  const s = new Selection();
  s.toggle('b');
  assert.deepEqual(s.live(fakeStore(IDS), IDS), ['b'], 'must not act on unselected mail');
});

test('live() returns rendered order, not selection order', () => {
  // Ordering matters for the undo snapshot, which replays in list order.
  const s = new Selection();
  s.toggle('e');
  s.toggle('a');
  s.toggle('c');
  assert.deepEqual(s.live(fakeStore(IDS), IDS), ['a', 'c', 'e']);
});

test('live() is empty when everything selected has vanished', () => {
  const s = new Selection();
  s.toggle('a');
  s.toggle('b');
  assert.deepEqual(s.live(fakeStore([]), IDS), [], 'must not send an empty-but-dead batch');
});

test('the selection label reads naturally at one and at many', () => {
  assert.equal(selectionLabel(1), '1 selected');
  assert.equal(selectionLabel(2), '2 selected');
  assert.equal(selectionLabel(0), '0 selected');
});
