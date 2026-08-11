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
import { fakeStorage } from './helpers/storage.mjs';

const {
  emptyRules, normaliseRules, loadRules, saveRules,
  toggleMute, toggleAutoArchive, isMuted, isAutoArchived,
  addressOf, correctSender, clearCorrection, applyCorrection,
  filterMuted, mutedCount,
} = await import('../src/app/rules.js');

const app = readFileSync(new URL('../src/app/app.js', import.meta.url), 'utf8');


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
// applyMute moved to src/app/selectors.js (audit R-6); the guards it
// enforces are pinned against the selector's source now.
const selSrc = readFileSync(new URL('../src/app/selectors.js', import.meta.url), 'utf8');

test('mute never applies outside the inbox', () => {
  const fn = selSrc.slice(selSrc.indexOf('export function applyMute'));
  assert.ok(fn.slice(0, 600).includes("mailbox !== 'inbox'"));
});

test('opening a muted category by name still shows it', () => {
  const fn = selSrc.slice(selSrc.indexOf('export function applyMute'));
  assert.ok(
    fn.slice(0, 600).includes("category !== 'all'"),
    'asking for a category by name must override its mute'
  );
});

test('search overrides mute', () => {
  const fn = selSrc.slice(selSrc.indexOf('export function applyMute'));
  assert.ok(fn.slice(0, 600).includes('query'));
});

test('an all-muted list explains itself and offers a way out', () => {
  // "You're all caught up" over hidden mail would be a lie.
  assert.ok(app.includes('Everything here is muted'));
  assert.ok(app.includes('Show muted mail'));
  assert.ok(app.includes('function mutedHiddenCount'));
});

test('auto-archive reports what it did and can be undone', () => {
  /*
   * SCOPED TO THE FUNCTION, not to a character count.
   *
   * This used `fn.slice(0, 1400)` -- a fixed window from the declaration --
   * and broke when a comment explaining the failure-path fix pushed `toast(`
   * past 1400 characters. The behaviour was unchanged; the ruler was too
   * short. A test that fails when you document the code trains people to
   * delete comments.
   *
   * Bounded by the next top-level declaration instead, so it measures the
   * function rather than an arbitrary prefix of it.
   */
  const fn = app.slice(app.indexOf('function autoArchive('));
  const end = fn.indexOf('\nfunction ', 1);
  const body = end === -1 ? fn : fn.slice(0, end);

  assert.ok(body.includes('toast('), 'silent removal is indistinguishable from lost mail');
  assert.ok(body.includes('recordUndo('), 'must be reversible');

  /*
   * And both must sit in the SUCCESS branch. Recording the undo at dispatch
   * time meant a failed request still left an entry, so Ctrl+Z sent the
   * inverse BULK for an archive that never happened -- adding INBOX back to
   * mail that was never removed.
   */
  const thenAt = body.indexOf('.then(');
  const undoAt = body.indexOf('recordUndo(');
  assert.ok(thenAt !== -1, 'the request result must be branched on');
  assert.ok(
    undoAt > thenAt,
    'recordUndo must be inside the success handler, not fired at dispatch'
  );
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


// ==========================================================================
// THREAD MUTE  (Feature 83)
//
// Same guarantee as category mute: a feature that hides mail must never hide
// it without trace, and must never hide more than it was asked to.
// ==========================================================================

const {
  toggleThreadMute, isThreadMuted, mutedThreadCount, pruneThreadMutes,
} = await import('../src/app/rules.js');

const tmsg = (id, threadId, category = 'admin') => ({ id, threadId, category });

test('muting a thread hides every message in it', () => {
  const r = toggleThreadMute(emptyRules(), 't1');
  const msgs = [tmsg('a', 't1'), tmsg('b', 't1'), tmsg('c', 't2')];
  assert.deepEqual(filterMuted(r, msgs).map((m) => m.id), ['c']);
});

test('muting a thread does NOT hide the rest of its category', () => {
  // The whole reason this exists rather than reusing the category mute.
  const r = toggleThreadMute(emptyRules(), 't1');
  const msgs = [tmsg('a', 't1', 'administration'), tmsg('b', 't2', 'administration')];
  assert.deepEqual(filterMuted(r, msgs).map((m) => m.id), ['b']);
});

test('unmuting restores the thread immediately', () => {
  let r = toggleThreadMute(emptyRules(), 't1');
  r = toggleThreadMute(r, 't1');
  assert.equal(isThreadMuted(r, 't1'), false);
  assert.equal(filterMuted(r, [tmsg('a', 't1')]).length, 1);
});

test('category mutes and thread mutes both apply', () => {
  let r = toggleMute(emptyRules(), 'clubs');
  r = toggleThreadMute(r, 't1');
  const msgs = [tmsg('a', 't1', 'admin'), tmsg('b', 't2', 'clubs'), tmsg('c', 't3', 'admin')];
  assert.deepEqual(filterMuted(r, msgs).map((m) => m.id), ['c']);
});

test('thread mutes are counted separately from category mutes', () => {
  // A single merged number cannot tell the user which rule to lift.
  let r = toggleMute(emptyRules(), 'clubs');
  r = toggleThreadMute(r, 't1');
  const msgs = [tmsg('a', 't1', 'admin'), tmsg('b', 't2', 'clubs')];
  assert.equal(mutedCount(r, msgs), 1);
  assert.equal(mutedThreadCount(r, msgs), 1);
});

test('a message with no threadId is never hidden by a thread mute', () => {
  const r = toggleThreadMute(emptyRules(), 't1');
  assert.equal(filterMuted(r, [{ id: 'a', category: 'admin' }]).length, 1);
});

test('toggling a falsy thread id is a no-op, not a mute of undefined', () => {
  const r = toggleThreadMute(emptyRules(), '');
  assert.deepEqual(r.mutedThreads, []);
  assert.equal(isThreadMuted(r, ''), false);
});

test('pruning forgets threads that have left the mailbox', () => {
  let r = toggleThreadMute(emptyRules(), 't1');
  r = toggleThreadMute(r, 't2');
  const pruned = pruneThreadMutes(r, new Set(['t2']));
  assert.deepEqual(pruned.mutedThreads, ['t2']);
});

test('pruning returns the SAME object when nothing changed', () => {
  // Storage writes are not free; an unchanged prune must not trigger one.
  const r = toggleThreadMute(emptyRules(), 't1');
  assert.equal(pruneThreadMutes(r, new Set(['t1'])), r);
});

test('a corrupt mutedThreads list degrades to empty', () => {
  for (const bad of [null, 'x', 7, {}]) {
    assert.deepEqual(normaliseRules({ mutedThreads: bad }).mutedThreads, []);
  }
  assert.deepEqual(normaliseRules({ mutedThreads: ['t1', 42, null] }).mutedThreads, ['t1']);
});

test('thread mutes survive a normalise round trip', () => {
  const r = toggleThreadMute(emptyRules(), 't1');
  assert.deepEqual(normaliseRules(r).mutedThreads, ['t1']);
});
