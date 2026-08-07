/**
 * Rule engine tests.
 *
 * THE DANGEROUS DIRECTION IS "MATCHES MORE THAN THE USER MEANT". A rule that
 * matches too little is a disappointment; a rule that matches too much
 * archives mail from a Dean. Every ambiguous case here is asserted in the
 * conservative direction, and the catch-all rejection is tested hardest.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStorage } from './helpers/storage.mjs';

const {
  normaliseRuleList, loadRuleList, saveRuleList, makeRule, validateRule,
  compileCondition, idsMatching, evaluate, dryRun, batchPlan, planFor,
  ACTIONS, DESTRUCTIVE,
} = await import('../src/app/rule-engine.js');

const msg = (o = {}) => ({ id: 'x', subject: '', from: '', snippet: '', date: 0, labels: [], ...o });
const rule = (o = {}) => makeRule({ name: 'r', query: 'from:x', actions: [{ type: 'archive' }], ...o });

// ------------------------------------------------------------ normalising --

test('a corrupt blob degrades to an empty list rather than throwing', () => {
  for (const bad of [null, undefined, 'x', 7, {}, [null], [{}], [{ query: '' }]]) {
    assert.deepEqual(normaliseRuleList(bad), []);
  }
});

test('a rule with no valid actions is dropped, not kept as a no-op', () => {
  // An enabled row in the editor that provably does nothing is worse than absent.
  assert.deepEqual(normaliseRuleList([{ query: 'from:x', actions: [{ type: 'nonsense' }] }]), []);
});

test('a label action without a value is dropped', () => {
  assert.deepEqual(normaliseRuleList([{ query: 'from:x', actions: [{ type: 'label' }] }]), []);
});

test('unknown action types are stripped but valid siblings survive', () => {
  const [r] = normaliseRuleList([
    { query: 'from:x', actions: [{ type: 'bogus' }, { type: 'star' }] },
  ]);
  assert.deepEqual(r.actions, [{ type: 'star' }]);
});

test('missing ids and names are filled', () => {
  const [r] = normaliseRuleList([{ query: 'from:x', actions: [{ type: 'star' }] }]);
  assert.ok(r.id);
  assert.equal(r.name, 'from:x');
  assert.equal(r.enabled, true);
});

// -------------------------------------------------------------- validation --

test('THE CATCH-ALL IS REJECTED', () => {
  // An empty condition matches every message. For an archive rule that is
  // "archive the entire inbox", so it must never be saveable by accident.
  for (const q of ['', '   ', '""']) {
    const r = { query: q, actions: [{ type: 'archive' }] };
    assert.equal(validateRule(r).ok, false, JSON.stringify(q));
  }
});

test('a rule with no actions is rejected', () => {
  assert.equal(validateRule({ query: 'from:x', actions: [] }).ok, false);
});

test('a valid rule passes', () => {
  assert.equal(validateRule(rule()).ok, true);
});

test('rejection always carries a reason the user can act on', () => {
  const r = validateRule({ query: '', actions: [{ type: 'archive' }] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /\S/);
});

// -------------------------------------------------------------- conditions --

test('free text in a condition is honoured, not dropped', () => {
  /*
   * parseQuery splits free text into `terms` for the store's index. A rule has
   * no index, so if the terms were ignored `from:x urgent` would match ALL of
   * x's mail -- more than the user asked for, in the one engine where that is
   * dangerous.
   */
  const test1 = compileCondition('from:augsd urgent');
  assert.equal(test1(msg({ from: 'augsd@bits.ac.in', subject: 'URGENT fee notice' })), true);
  assert.equal(test1(msg({ from: 'augsd@bits.ac.in', subject: 'routine notice' })), false);
});

test('conditions inherit the OR grammar for free', () => {
  const t = compileCondition('category:clubs OR category:events');
  assert.equal(t(msg({ category: 'events' })), true);
  assert.equal(t(msg({ category: 'admin' })), false);
});

test('conditions inherit negation for free', () => {
  const t = compileCondition('category:academics -from:bot');
  assert.equal(t(msg({ category: 'academics', from: 'prof@x' })), true);
  assert.equal(t(msg({ category: 'academics', from: 'bot@x' })), false);
});

// ---------------------------------------------------------------- matching --

test('idsMatching returns only the matches', () => {
  const db = { a: msg({ id: 'a', from: 'x@y' }), b: msg({ id: 'b', from: 'z@y' }) };
  assert.deepEqual(idsMatching('from:x@y', ['a', 'b'], (i) => db[i]), ['a']);
});

test('idsMatching skips ids the store does not have', () => {
  assert.deepEqual(idsMatching('from:x', ['ghost'], () => undefined), []);
});

// -------------------------------------------------------------- evaluation --

test('a disabled rule does nothing', () => {
  const r = rule({ enabled: false });
  assert.deepEqual(evaluate([r], msg({ from: 'x@y' })).actions, []);
});

test('a broken rule does nothing rather than matching everything', () => {
  // Hand-built to bypass makeRule's validation, as a corrupt storage blob would.
  const broken = { id: 'b', name: 'b', query: '', actions: [{ type: 'archive' }], enabled: true, created: 0 };
  assert.deepEqual(evaluate([broken], msg({ from: 'anything' })).actions, []);
});

test('two rules matching the same message merge their actions', () => {
  const r1 = makeRule({ name: '1', query: 'from:x', actions: [{ type: 'star' }] });
  const r2 = makeRule({ name: '2', query: 'from:x', actions: [{ type: 'archive' }] });
  const out = evaluate([r1, r2], msg({ from: 'x@y' }));
  assert.deepEqual(out.actions.map((a) => a.type).sort(), ['archive', 'star']);
  assert.equal(out.matched.length, 2);
});

test('a duplicated action is applied once', () => {
  const r1 = makeRule({ name: '1', query: 'from:x', actions: [{ type: 'archive' }] });
  const r2 = makeRule({ name: '2', query: 'from:x', actions: [{ type: 'archive' }] });
  assert.equal(evaluate([r1, r2], msg({ from: 'x@y' })).actions.length, 1);
});

test('stopProcessing halts later rules', () => {
  const r1 = makeRule({ name: '1', query: 'from:x', actions: [{ type: 'star' }], stopProcessing: true });
  const r2 = makeRule({ name: '2', query: 'from:x', actions: [{ type: 'archive' }] });
  const out = evaluate([r1, r2], msg({ from: 'x@y' }));
  assert.deepEqual(out.actions.map((a) => a.type), ['star']);
});

test('same-type actions with different values both survive', () => {
  const r1 = makeRule({ name: '1', query: 'from:x', actions: [{ type: 'label', value: 'A' }] });
  const r2 = makeRule({ name: '2', query: 'from:x', actions: [{ type: 'label', value: 'B' }] });
  assert.equal(evaluate([r1, r2], msg({ from: 'x@y' })).actions.length, 2);
});

// ----------------------------------------------------------------- dry run --

test('the dry run counts and samples what would be touched', () => {
  const db = {};
  const ids = [];
  for (let i = 0; i < 30; i++) {
    db[`m${i}`] = msg({ id: `m${i}`, from: i < 20 ? 'spam@x' : 'prof@y', subject: `s${i}` });
    ids.push(`m${i}`);
  }
  const out = dryRun(rule({ query: 'from:spam@x' }), ids, (i) => db[i]);
  assert.equal(out.ok, true);
  assert.equal(out.count, 20);
  assert.equal(out.sample.length, 12, 'a sample, not the whole set');
  assert.ok(out.sample[0].subject, 'the sample carries enough to identify a message');
});

test('the dry run refuses an invalid rule instead of matching everything', () => {
  const out = dryRun({ query: '', actions: [{ type: 'archive' }] }, ['a'], () => msg());
  assert.equal(out.ok, false);
  assert.equal(out.count, 0);
});

test('a rule matching most of the mailbox produces a warning', () => {
  const db = { a: msg({ id: 'a', from: 'x@y' }), b: msg({ id: 'b', from: 'x@y' }), c: msg({ id: 'c', from: 'z@y' }) };
  const out = dryRun(rule({ query: 'from:x@y' }), ['a', 'b', 'c'], (i) => db[i]);
  assert.ok(out.warning, 'two of three matched should warn');
});

test('a narrow rule produces no warning', () => {
  const db = { a: msg({ id: 'a', from: 'x@y' }), b: msg({ id: 'b', from: 'z@y' }), c: msg({ id: 'c', from: 'z@y' }) };
  const out = dryRun(rule({ query: 'from:x@y' }), ['a', 'b', 'c'], (i) => db[i]);
  assert.equal(out.warning, null);
});

test('the dry run flags a destructive rule', () => {
  const db = { a: msg({ id: 'a', from: 'x@y' }) };
  assert.equal(dryRun(rule({ query: 'from:x@y', actions: [{ type: 'archive' }] }), ['a'], (i) => db[i]).destructive, true);
  assert.equal(dryRun(rule({ query: 'from:x@y', actions: [{ type: 'star' }] }), ['a'], (i) => db[i]).destructive, false);
});

test('THE DRY RUN AND THE REAL PLAN USE THE SAME MATCHER', () => {
  /*
   * The audit's whole objection to a rule engine is that the preview and the
   * operation can disagree. They cannot here, and this asserts it rather than
   * trusting the comment.
   */
  const db = {};
  const ids = [];
  for (let i = 0; i < 15; i++) {
    db[`m${i}`] = msg({ id: `m${i}`, from: i % 3 === 0 ? 'a@x' : 'b@x' });
    ids.push(`m${i}`);
  }
  const r = rule({ query: 'from:a@x' });
  const preview = dryRun(r, ids, (i) => db[i]);
  const real = planFor([r], ids.map((i) => db[i]));
  assert.deepEqual(preview.ids.sort(), real.plans.map((p) => p.id).sort());
});

// ------------------------------------------------------------------ batching --

test('a plan is grouped into one batch per action', () => {
  const plans = [
    { id: 'a', actions: [{ type: 'archive' }, { type: 'star' }] },
    { id: 'b', actions: [{ type: 'archive' }] },
  ];
  const out = batchPlan(plans);
  const archive = out.find((g) => g.type === 'archive');
  assert.deepEqual(archive.ids, ['a', 'b'], 'one request for both, not one each');
  assert.equal(out.length, 2);
});

test('labels with different values are separate batches', () => {
  const out = batchPlan([{ id: 'a', actions: [{ type: 'label', value: 'A' }, { type: 'label', value: 'B' }] }]);
  assert.equal(out.length, 2);
});

test('planFor reports how many messages each rule fired on', () => {
  const r = rule({ query: 'from:x@y' });
  const out = planFor([r], [msg({ id: 'a', from: 'x@y' }), msg({ id: 'b', from: 'x@y' }), msg({ id: 'c', from: 'z@y' })]);
  assert.equal(out.fired[r.id], 2);
});

// ---------------------------------------------------------------- storage --

test('rules round-trip through storage', async () => {
  const s = fakeStorage();
  const r = rule({ query: 'from:x@y' });
  assert.equal(await saveRuleList([r], s), true);
  const back = await loadRuleList(s);
  assert.equal(back.length, 1);
  assert.equal(back[0].query, 'from:x@y');
});

test('a failing storage write reports false instead of throwing', async () => {
  const s = fakeStorage()._fail();
  assert.equal(await saveRuleList([rule()], s), false);
});

test('a corrupt stored blob loads as empty', async () => {
  const s = fakeStorage({ automationRules: 'not an array' });
  assert.deepEqual(await loadRuleList(s), []);
});

test('every declared action is either destructive or not, with no gaps', () => {
  for (const a of ACTIONS) assert.equal(typeof DESTRUCTIVE.has(a), 'boolean');
  assert.ok(DESTRUCTIVE.has('archive'));
  assert.ok(!DESTRUCTIVE.has('star'));
});
