/**
 * Saved views.
 *
 * The query language supported operators from the start and there was no way
 * to keep one, so a daily filter was retyped daily. These tests cover the
 * storage contract; the integration suite covers the UI.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadViews, saveView, removeView, restoreBuiltins, BUILTIN_VIEWS } from '../src/app/system/view-store.js';
import { fakeStorage } from './helpers/storage.mjs';


test('ships with built-in views that double as syntax examples', () => {
  // An empty saved-view list teaches nothing, and nobody discovers
  // `has:deadline` by staring at a text box.
  assert.ok(BUILTIN_VIEWS.length >= 4);
  for (const v of BUILTIN_VIEWS) {
    assert.ok(v.query.includes(':'), `"${v.name}" should demonstrate an operator`);
    assert.ok(v.builtin, 'built-ins must be flagged');
  }
});

test('a fresh install returns the built-ins', async () => {
  const views = await loadViews(fakeStorage());
  assert.equal(views.length, BUILTIN_VIEWS.length);
});

test('saving adds a view and it survives a reload', async () => {
  const s = fakeStorage();
  const res = await saveView('Morning triage', 'is:unread category:augsd', s);
  assert.equal(res.ok, true);

  const views = await loadViews(s);
  assert.equal(views.length, BUILTIN_VIEWS.length + 1);
  assert.equal(views[views.length - 1].name, 'Morning triage');
});

test('a duplicate name is rejected rather than silently created', async () => {
  // Two identical entries the user cannot tell apart is worse than an error.
  const s = fakeStorage();
  await saveView('Mine', 'is:unread', s);
  const dup = await saveView('mine', 'is:starred', s);
  assert.equal(dup.ok, false);
  assert.match(dup.error, /already exists/);
});

test('a name colliding with a built-in is rejected', async () => {
  const s = fakeStorage();
  const res = await saveView('Unread', 'from:x', s);
  assert.equal(res.ok, false);
});

test('an empty name or query is rejected with a usable message', async () => {
  const s = fakeStorage();
  assert.match((await saveView('  ', 'is:unread', s)).error, /name/i);
  assert.match((await saveView('X', '   ', s)).error, /no search/i);
});

test('names are trimmed and bounded', async () => {
  const s = fakeStorage();
  const res = await saveView('  ' + 'x'.repeat(90) + '  ', 'is:unread', s);
  assert.equal(res.view.name.length, 40, 'a 90-character name would break the sidebar');
});

test('the list is capped', async () => {
  const s = fakeStorage();
  for (let i = 0; i < 20; i++) await saveView(`v${i}`, `from:a${i}`, s);
  const over = await saveView('one more', 'from:z', s);
  assert.equal(over.ok, false);
  assert.match(over.error, /twenty/i);
});

test('removing a custom view deletes it', async () => {
  const s = fakeStorage();
  const { view } = await saveView('Temp', 'is:unread', s);
  await removeView(view.id, s);
  const views = await loadViews(s);
  assert.ok(!views.some((v) => v.id === view.id));
});

test('removing a BUILT-IN hides it, and it can be restored', async () => {
  // A user who removes "Overdue" and later wants it back should not have to
  // remember the syntax.
  const s = fakeStorage();
  await removeView('sv-overdue', s);
  let views = await loadViews(s);
  assert.ok(!views.some((v) => v.id === 'sv-overdue'));

  await restoreBuiltins(s);
  views = await loadViews(s);
  assert.ok(views.some((v) => v.id === 'sv-overdue'), 'built-ins are hidden, never destroyed');
});

test('a corrupt blob degrades to the defaults rather than throwing', async () => {
  // This runs during boot; an exception here is an app that will not start.
  for (const bad of [{ savedViews: 'nonsense' }, { savedViews: { views: 42 } }, { savedViews: null }]) {
    const views = await loadViews(fakeStorage(bad));
    assert.equal(views.length, BUILTIN_VIEWS.length);
  }
});

test('malformed entries are skipped, not fatal', async () => {
  const s = fakeStorage({
    savedViews: { views: [{ id: 'a' }, null, { id: 'b', name: 'Good', query: 'is:unread' }], hidden: [] },
  });
  const views = await loadViews(s);
  const custom = views.filter((v) => !v.builtin);
  assert.equal(custom.length, 1);
  assert.equal(custom[0].name, 'Good');
});

test('a storage failure on save reports rather than throwing', async () => {
  const broken = { async get() { return {}; }, async set() { throw new Error('quota'); } };
  const res = await saveView('X', 'is:unread', broken);
  assert.equal(res.ok, false);
});

/*
 * Mutation-testing gap: `blob && Array.isArray(blob.views)` -> `||` survived.
 *
 * With `||`, a null blob reaches `blob.views` and throws inside the try, so
 * loadViews silently returns only the built-ins — the user's saved views
 * vanish with no error. Storage is shared with older builds, so a blob of an
 * unexpected shape is reachable in practice.
 */
test('a blob of the wrong shape degrades to built-ins without throwing', async () => {
  for (const bad of [null, undefined, 0, 'text', 42, true, []]) {
    const s = { async get() { return { savedViews: bad }; }, async set() {} };
    const out = await loadViews(s);
    assert.ok(Array.isArray(out), `not an array for ${JSON.stringify(bad)}`);
    assert.ok(out.length > 0, 'built-ins must survive a corrupt blob');
  }
});

test('a valid blob still yields the user\'s custom views', async () => {
  // The negative test above passes if custom views are always dropped.
  const s = {
    async get() {
      return { savedViews: { views: [{ id: 'sv-1', name: 'Mine', query: 'is:unread', icon: 'search' }] } };
    },
    async set() {},
  };
  const out = await loadViews(s);
  assert.ok(out.some((v) => v.id === 'sv-1'), 'custom views must load');
});
