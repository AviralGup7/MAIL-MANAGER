/**
 * Category rule tests.
 *
 * Mute is the risky one: a feature that hides mail must never be able to hide
 * it WITHOUT TRACE, and must never hide it from someone who asked for it
 * directly. Most of these tests are about those two guarantees.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  emptyRules, normaliseRules, loadRules, saveRules,
  toggleMute, toggleAutoArchive, isMuted, isAutoArchived,
  addressOf, correctSender, clearCorrection, applyCorrection,
  filterMuted, mutedCount,
} = await import('../src/app/rules.js');

const app = readFileSync(new URL('../src/app/app.js', import.meta.url), 'utf8');

function fakeStorage(initial = {}) {
  let data = { ...initial };
  return {
    async get(k) { return typeof k === 'string' ? { [k]: data[k] } : { ...data }; },
    async set(o) { data = { ...data, ...o }; },
    _data: () => data,
  };
}

// ------------------------------------------------------------ normalising ---

test('a corrupt rules blob degrades to empty rather than throwing', () => {
  for (const bad of [null, 'x', 7, [], { muted: 'clubs' }, { corrections: [] }]) {
    const r = normaliseRules(bad);
    assert.deepEqual(r.muted, []);
    assert.deepEqual(r.autoArchive, []);
    assert.deepEqual(r.corrections, {});
  }
});

test('non-string entries are stripped, good ones kept', () => {
  const r = normaliseRules({ muted: ['clubs', 42, null, 'events'] });
  assert.deepEqual(r.muted, ['clubs', 'events']);
});

test('correction keys are lowercased on the way in', () => {
  const r = normaliseRules({ corrections: { 'A@B.COM': 'academics' } });
  assert.equal(r.corrections['a@b.com'], 'academics');
});

// ---------------------------------------------------------------- toggles ---

test('muting toggles and is queryable', () => {
  let r = emptyRules();
  r = toggleMute(r, 'clubs');
  assert.ok(isMuted(r, 'clubs'));
  r = toggleMute(r, 'clubs');
  assert.equal(isMuted(r, 'clubs'), false);
});

/*
 * Mute and auto-archive are contradictory: one hides locally, the other
 * removes upstream. Leaving both set means two rules that disagree about the
 * same category, and whichever runs last wins -- which is indistinguishable
 * from a bug.
 */
test('muting clears auto-archive for the same category', () => {
  let r = toggleAutoArchive(emptyRules(), 'clubs');
  assert.ok(isAutoArchived(r, 'clubs'));
  r = toggleMute(r, 'clubs');
  assert.ok(isMuted(r, 'clubs'));
  assert.equal(isAutoArchived(r, 'clubs'), false, 'contradictory rules must not coexist');
});

test('auto-archiving clears mute for the same category', () => {
  let r = toggleMute(emptyRules(), 'events');
  r = toggleAutoArchive(r, 'events');
  assert.ok(isAutoArchived(r, 'events'));
  assert.equal(isMuted(r, 'events'), false);
});

test('toggling returns a new object rather than mutating', () => {
  const r = emptyRules();
  const next = toggleMute(r, 'clubs');
  assert.notEqual(r, next);
  assert.deepEqual(r.muted, [], 'the original must be untouched');
});

// ------------------------------------------------------------ corrections ---

test('addresses are extracted from a display-name header', () => {
  assert.equal(addressOf('AUGSD <augsd@pilani.bits-pilani.ac.in>'), 'augsd@pilani.bits-pilani.ac.in');
  assert.equal(addressOf('plain@x.com'), 'plain@x.com');
  assert.equal(addressOf('  MiXeD@X.CoM '), 'mixed@x.com');
  assert.equal(addressOf(''), '');
  assert.equal(addressOf(undefined), '');
});

test('a correction overrides the classifier and says who decided', () => {
  let r = correctSender(emptyRules(), 'Clubs <clubs@x.com>', 'academics');
  const msg = { from: 'Clubs <clubs@x.com>', category: 'clubs', confidence: 0.6, source: 'rule' };
  const out = applyCorrection(r, msg);
  assert.equal(out.category, 'academics');
  assert.equal(out.confidence, 1, 'the user is not guessing');
  assert.equal(out.source, 'you');
  assert.match(out.reason, /you/i);
});

test('a correction keyed on one address does not affect another sender', () => {
  const r = correctSender(emptyRules(), 'a@x.com', 'academics');
  const msg = { from: 'b@x.com', category: 'clubs' };
  assert.equal(applyCorrection(r, msg).category, 'clubs');
});

test('applying a no-op correction returns the same object', () => {
  const r = correctSender(emptyRules(), 'a@x.com', 'clubs');
  const msg = { from: 'a@x.com', category: 'clubs' };
  assert.equal(applyCorrection(r, msg), msg, 'no needless copy');
});

test('a correction can be cleared', () => {
  let r = correctSender(emptyRules(), 'a@x.com', 'academics');
  r = clearCorrection(r, 'a@x.com');
  assert.equal(applyCorrection(r, { from: 'a@x.com', category: 'clubs' }).category, 'clubs');
});

test('a correction survives a storage round trip', async () => {
  const s = fakeStorage();
  await saveRules(correctSender(emptyRules(), 'A@X.com', 'academics'), s);
  const r = await loadRules(s);
  assert.equal(r.corrections['a@x.com'], 'academics');
});

// --------------------------------------------------------------- filtering ---

test('muted categories are filtered out', () => {
  const r = toggleMute(emptyRules(), 'clubs');
  const msgs = [{ category: 'clubs' }, { category: 'augsd' }, { category: 'clubs' }];
  assert.equal(filterMuted(r, msgs).length, 1);
  assert.equal(mutedCount(r, msgs), 2);
});

test('with no rules, filtering is a pass-through', () => {
  const msgs = [{ category: 'clubs' }];
  assert.equal(filterMuted(emptyRules(), msgs), msgs, 'must not copy for nothing');
  assert.equal(mutedCount(emptyRules(), msgs), 0);
});

// ----------------------------------------------------------- app behaviour ---

/*
 * THE TRUST GUARANTEES.
 *
 * A mute that hides mail from an explicit request, or hides it with no
 * indication at all, is a feature that makes people distrust the whole app.
 */
test('mute never applies outside the inbox', () => {
  const fn = app.slice(app.indexOf('function applyMute('));
  assert.ok(fn.slice(0, 500).includes("state.mailbox !== 'inbox'"));
});

test('opening a muted category by name still shows it', () => {
  const fn = app.slice(app.indexOf('function applyMute('));
  assert.ok(
    fn.slice(0, 500).includes("state.category !== 'all'"),
    'asking for a category by name must override its mute'
  );
});

test('search overrides mute', () => {
  const fn = app.slice(app.indexOf('function applyMute('));
  assert.ok(fn.slice(0, 500).includes('state.query'));
});

test('an all-muted list explains itself and offers a way out', () => {
  // "You're all caught up" over hidden mail would be a lie.
  assert.ok(app.includes('Everything here is muted'));
  assert.ok(app.includes('Show muted mail'));
  assert.ok(app.includes('function mutedHiddenCount'));
});

test('auto-archive reports what it did and can be undone', () => {
  const fn = app.slice(app.indexOf('function autoArchive('));
  const body = fn.slice(0, 1400);
  assert.ok(body.includes('toast('), 'silent removal is indistinguishable from lost mail');
  assert.ok(body.includes('recordUndo('), 'must be reversible');
});

test('auto-archive only touches newly-arrived unread mail', () => {
  const fn = app.slice(app.indexOf('function autoArchive('));
  assert.ok(
    fn.slice(0, 900).includes('m.unread'),
    're-archiving mail the user already dealt with would fight them'
  );
});

test('rules load before the first ingest', () => {
  // Otherwise page one is classified without corrections and auto-archive
  // silently skips it.
  const boot = app.slice(app.indexOf('const { signedIn } = await send('));
  const loadAt = boot.indexOf('rules = await loadRules()');
  const startAt = boot.indexOf('await start()');
  assert.ok(loadAt > 0 && loadAt < startAt, 'rules must be loaded before start()');
});

test('muted categories are visibly marked in the rail', () => {
  assert.ok(app.includes("classList.toggle('is-muted'"));
});

/* ------------------------------------------------- mutation-testing gaps ----
 *
 * Found by tools/mutate.mjs: two behaviours nothing verified.
 */

test('a correction with a non-string value is discarded, not stored', () => {
  /*
   * `typeof k === 'string' && typeof v === 'string'` -> `||` survived the
   * suite. It matters: a non-string category reaches `applyCorrection`, which
   * assigns it to `msg.category`, and the sidebar then keys a lookup on an
   * object. Storage is shared with older builds, so this is reachable.
   */
  const r = normaliseRules({
    corrections: { 'a@x.com': 'academics', 'b@x.com': 42, 'c@x.com': null, 'd@x.com': {} },
  });
  assert.deepEqual(Object.keys(r.corrections), ['a@x.com'], 'only string values survive');
  assert.equal(r.corrections['a@x.com'], 'academics');
});

test('a correction whose value is an object cannot reach a message', () => {
  const r = normaliseRules({ corrections: { 'a@x.com': { evil: true } } });
  const msg = { from: 'a@x.com', category: 'clubs' };
  assert.equal(applyCorrection(r, msg).category, 'clubs', 'the bad correction must not apply');
});

test('saveRules reports success and failure distinguishably', () => {
  // `return true` -> `return false` survived: nothing checked the result, so
  // a caller could not tell a persisted rule from a lost one.
  const ok = { async get() { return {}; }, async set() {} };
  const bad = { async get() { return {}; }, async set() { throw new Error('quota'); } };
  return Promise.all([
    saveRules(emptyRules(), ok).then((r) => assert.equal(r, true, 'success must report true')),
    saveRules(emptyRules(), bad).then((r) => assert.equal(r, false, 'failure must report false')),
  ]);
});
