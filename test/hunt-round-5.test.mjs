/**
 * Bug hunt, round 5 of 10 (2026-08-17) — the rule engine and its executor.
 *
 * The theme of this round is DISAGREEMENT BETWEEN TWO MODULES THAT NEVER
 * SPEAK. The rule engine decides what a rule may say; `main.js` decides what
 * a rule can do; the activity log claims to explain what happened. All three
 * were out of step, and nothing asserted otherwise — so a user could save an
 * enabled rule that could never fire, watch a rule archive their mail, and
 * then read a log naming the wrong rule for it.
 *
 * Every finding here was reproduced by EXECUTING the real modules before a
 * line was changed; the measured numbers are in the fix comments.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as engine from '../src/app/academic/rule-engine.js';
import { normaliseLog, describe, OUTCOMES } from '../src/app/academic/activity.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Source with comments removed.
 *
 * THIS HELPER EXISTS BECAUSE THE FIRST VERSION OF THIS FILE FAILED ON ITSELF.
 * The R5-2 assertion "the hoisted single-name attribution is not back" greps
 * for `const who = Object.keys(fired)` — and the fix's own comment QUOTES that
 * line to explain what was wrong with it. The gate matched the explanation and
 * reported the bug as un-fixed.
 *
 * The same mistake (a source-grep gate matching prose rather than code) has
 * now cost this project three separate CI failures, so it is solved once here
 * rather than by hand-tuning each regex.
 */
function code(relPath) {
  return readFileSync(join(ROOT, relPath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const MAIN = code('src/app/main.js');

const msg = (o = {}) => ({ id: 'm', from: 'x@y.z', subject: 's', snippet: '', ...o });

/* ========================================================================
 * R5-1 · the grammar accepted four verbs the executor silently dropped
 * ==================================================================== */

test('R5-1: every declared action is either executable or documented as planned', () => {
  /*
   * MEASURED BEFORE THE FIX. A rule list of the kind `normaliseRuleList`
   * accepts, planned through `planFor`, against main.js's BULK_ACTIONS map:
   *
   *   pin        -> SILENTLY DROPPED   (`if (!spec) continue`)
   *   star       -> RUNS
   *   skipInbox  -> SILENTLY DROPPED
   *   label      -> SILENTLY DROPPED
   *
   * All four validated, saved, and rendered in both editors as enabled rows.
   *
   * This is the structural gate: the grammar and the executor are two lists
   * in two modules, and this asserts they are reconciled. A new verb must be
   * either wired up or written down — it cannot be quietly inert.
   */
  const union = new Set([...engine.EXECUTABLE, ...Object.keys(engine.PLANNED)]);

  for (const a of engine.ACTIONS) {
    assert.ok(
      union.has(a),
      `action "${a}" is in ACTIONS but is neither EXECUTABLE nor listed in PLANNED — ` +
      'it would save as an enabled rule and then do nothing'
    );
  }
  for (const a of union) {
    assert.ok(engine.ACTIONS.includes(a), `"${a}" is claimed but is not a declared action`);
  }
  // A planned verb must carry a real reason, not a placeholder.
  for (const [verb, reason] of Object.entries(engine.PLANNED)) {
    assert.equal(typeof reason, 'string');
    assert.ok(reason.length > 20, `PLANNED.${verb} needs a real reason, got "${reason}"`);
  }
});

test('R5-1: EXECUTABLE matches the verbs main.js can actually dispatch', () => {
  /*
   * The other half of the gate, and the one that catches DRIFT: BULK_ACTIONS
   * lives in bulk.js and is read by main.js. If someone removes `star` from
   * it, the engine must stop advertising `star` as executable in the same
   * commit — otherwise we are back to a rule that saves and does nothing.
   */
  const bulk = code('src/app/mail/bulk.js');
  const block = bulk.match(/export const BULK_ACTIONS = \{[\s\S]*?\n\};/);
  assert.ok(block, 'BULK_ACTIONS not found — this gate needs updating');

  for (const [action, bulkVerb] of Object.entries(engine.BULK_VERB)) {
    assert.ok(
      new RegExp(`^\\s*${bulkVerb}:`, 'm').test(block[0]),
      `engine says "${action}" dispatches as BULK_ACTIONS.${bulkVerb}, which does not exist`
    );
    assert.ok(engine.EXECUTABLE.has(action));
  }
  // And main.js must go through the engine's map rather than a second copy.
  assert.ok(
    /BULK_ACTIONS\[engine\.BULK_VERB\[batch\.type\]/.test(MAIN),
    'applyRules must resolve the verb through engine.BULK_VERB, not a local literal'
  );
});

test('R5-1: the dry run reports an inert rule instead of a reassuring count', () => {
  const inert = engine.makeRule({
    name: 'Pin the Dean', query: 'from:dean', actions: [{ type: 'pin' }],
  });
  const db = { m1: msg({ id: 'm1', from: 'dean@pilani.bits-pilani.ac.in' }) };
  const out = engine.dryRun(inert, ['m1'], (i) => db[i]);

  assert.equal(out.ok, true, 'the rule is well-formed; that is not what is wrong with it');
  assert.equal(out.count, 1, 'the condition really does match');
  assert.equal(out.inert, true, 'but the action cannot run, and the dry run must say so');
  assert.deepEqual(out.unsupported, ['pin']);
  assert.match(out.unsupportedReason, /cannot "pin"/);

  // A runnable rule must not be tarred with the same brush.
  const live = engine.makeRule({
    name: 'Star the Dean', query: 'from:dean', actions: [{ type: 'star' }],
  });
  const ok = engine.dryRun(live, ['m1'], (i) => db[i]);
  assert.equal(ok.inert, false);
  assert.deepEqual(ok.unsupported, []);
  assert.equal(ok.unsupportedReason, null);
});

test('R5-1: executability is per-action, and names every unsupported verb', () => {
  const mixed = engine.makeRule({
    name: 'both', query: 'from:x',
    actions: [{ type: 'star' }, { type: 'pin' }, { type: 'label', value: 'L' }],
  });
  const e = engine.executability(mixed);
  assert.equal(e.ok, false);
  assert.deepEqual(e.unsupported.sort(), ['label', 'pin'], 'star is fine and must not be listed');
  assert.match(e.reason, /"label"|"pin"/);

  /*
   * Total, like the rest of this module — and note WHAT the total answer is.
   * "No actions" means "no UNSUPPORTED actions", so executability says ok.
   * That is not a loophole: `validateRule` is what rejects an actionless
   * rule, and the two questions are deliberately separate ("is this
   * well-formed" vs "can this build run it"). My first version of this test
   * asserted false here and was wrong about the contract it was pinning.
   */
  for (const junk of [undefined, null, {}, { actions: [] }, { actions: 'no' }]) {
    assert.equal(engine.executability(junk).ok, true, `executability(${JSON.stringify(junk)})`);
  }
  assert.equal(engine.validateRule({ query: 'from:x', actions: [] }).ok, false,
    'the actionless rule is rejected — by validateRule, which is its job');
});

test('R5-1: both editors refuse to save a rule that cannot run', () => {
  for (const path of ['src/app/overlays/rules-editor.js', 'src/options/options.js']) {
    const src = code(path);
    assert.ok(
      /if \(out\.inert\)/.test(src) && /unsupportedReason/.test(src),
      `${path} must gate on the dry run's inert flag — otherwise it saves a dead rule`
    );
    // The gate must come BEFORE the count message, or the user reads
    // "would pin 12 messages" and believes it.
    assert.ok(
      src.indexOf('out.inert') < src.indexOf('out.count === 0'),
      `${path} must report inertness before reporting a count`
    );
  }
});

/* ========================================================================
 * R5-2 · the activity log named the wrong rule
 * ==================================================================== */

test('R5-2: attribution names the rule that owns the verb, not the first to fire', () => {
  /*
   * MEASURED BEFORE THE FIX. Two rules, two messages, one ingest:
   *   "Star the Dean"  (star)     matched dean@…
   *   "Archive digest" (archive)  matched digest@…
   * The archive entry was logged with detail "Star the Dean", because `who`
   * was computed once outside the loop as `Object.keys(fired)[0]`.
   *
   * The direction of the error is what makes it serious: the user goes to
   * disable the rule that ate their mail, disables an innocent one, and the
   * real culprit keeps running.
   */
  const rules = [
    engine.makeRule({ name: 'Star the Dean', query: 'from:dean', actions: [{ type: 'star' }] }),
    engine.makeRule({ name: 'Archive digest', query: 'from:digest', actions: [{ type: 'archive' }] }),
  ];
  const records = [
    msg({ id: 'm1', from: 'dean@pilani.bits-pilani.ac.in' }),
    msg({ id: 'm2', from: 'digest@pilani.bits-pilani.ac.in' }),
  ];
  const { batches, fired } = engine.planFor(rules, records);
  const named = new Map(rules.map((r) => [r.id, r.name]));

  // The shipped implementation, lifted from main.js.
  const whoFired = (type) => {
    const owners = rules
      .filter((r) => fired[r.id] && r.actions?.some((a) => a.type === type))
      .map((r) => named.get(r.id))
      .filter(Boolean);
    return owners.length > 1 ? `${owners[0]} +${owners.length - 1} more` : owners[0];
  };

  const byType = Object.fromEntries(batches.map((b) => [b.type, whoFired(b.type)]));
  assert.equal(byType.star, 'Star the Dean');
  assert.equal(byType.archive, 'Archive digest', 'the archive must not be blamed on the star rule');

  /*
   * AND THE SHIPPED CALL SITE MUST USE IT.
   *
   * My first version of this gate asserted only that `whoFired` was DECLARED
   * and that the old hoisted line was gone. Sabotage-testing caught it:
   * putting `Object.keys(fired)...[0]` back at the `detail:` call site while
   * leaving the declaration in place passed all eleven tests. A gate that
   * checks for the presence of a fix rather than its USE is not a gate.
   */
  assert.ok(
    /detail: whoFired\(batch\.type\),/.test(MAIN),
    'the per-verb attribution is declared but not used at the logging call site'
  );
  assert.ok(
    !/Object\.keys\(fired\)/.test(MAIN),
    'the one-name-for-every-batch attribution is back'
  );
});

test('R5-2: when several rules contribute one verb, the log says so', () => {
  const rules = [
    engine.makeRule({ name: 'A', query: 'from:x', actions: [{ type: 'archive' }] }),
    engine.makeRule({ name: 'B', query: 'subject:s', actions: [{ type: 'archive' }] }),
  ];
  const { fired } = engine.planFor(rules, [msg({ id: 'm1' })]);
  const named = new Map(rules.map((r) => [r.id, r.name]));
  const owners = rules
    .filter((r) => fired[r.id] && r.actions.some((a) => a.type === 'archive'))
    .map((r) => named.get(r.id));
  assert.equal(owners.length, 2, 'both rules genuinely fired');

  const label = owners.length > 1 ? `${owners[0]} +${owners.length - 1} more` : owners[0];
  assert.equal(label, 'A +1 more', 'silently naming only one of two is how R5-2 started');
});

/* ========================================================================
 * R5-3 · the log recorded rejected messages as successfully actioned
 * ==================================================================== */

test('R5-3: a partial failure never appears in a success entry', () => {
  /*
   * MEASURED BEFORE THE FIX, three ids with one rejected by Gmail:
   *   {verb:'RULE_ARCHIVE', ids:['m2'],            outcome:'partial'}
   *   {verb:'RULE_ARCHIVE', ids:['m1','m2','m3'],  outcome:'ok'}   <- m2 again
   *
   * m2 was never archived — the local store correctly left it alone — and the
   * activity log stated it had been. In the one feature whose entire job is
   * answering "why did this get archived".
   */
  assert.ok(
    /ids: applied,/.test(MAIN),
    'the success entry must log `applied`, not `batch.ids`'
  );
  assert.ok(
    /if \(applied\.length\) \{\s*activity\.record\(/.test(MAIN),
    'an all-rejected batch must log no success entry at all'
  );
  assert.ok(
    !/ids: batch\.ids,\s*actor: 'rule',\s*detail:/.test(MAIN),
    'the whole-batch success entry is back'
  );
});

/* ========================================================================
 * R5-4 · 'unsupported' had to become a real outcome, in one place
 * ==================================================================== */

test('R5-4: the outcome vocabulary is defined once and survives storage', () => {
  /*
   * The set was written out as a literal in `normaliseLog` and again as a
   * ternary chain in `describe`. Adding a sixth outcome to one and not the
   * other would have had the loader silently coerce it to 'ok' — precisely
   * the "the log lies" failure R5-3 fixes one module over.
   */
  assert.ok(OUTCOMES.includes('unsupported'));

  const [entry] = normaliseLog([
    { at: 1, verb: 'RULE_PIN', actor: 'rule', ids: ['m1'], outcome: 'unsupported' },
  ]);
  assert.equal(entry.outcome, 'unsupported', 'must not be coerced to ok');
  assert.match(describe(entry), /not supported/);

  // Every outcome must render distinctly; a silent one is an invisible one.
  const rendered = OUTCOMES.map((o) =>
    describe({ verb: 'ARCHIVE', actor: 'rule', ids: ['a'], count: 1, outcome: o })
  );
  assert.equal(new Set(rendered).size, OUTCOMES.length, 'two outcomes render identically');

  // Junk still lands on 'ok', as before.
  const [junk] = normaliseLog([{ at: 1, verb: 'X', ids: [], outcome: 'nonsense' }]);
  assert.equal(junk.outcome, 'ok');
});

test('R5-4: an unrunnable verb reaching the executor is logged, not swallowed', () => {
  // Storage is shared with older versions and with backup import, so an
  // inert rule can still arrive at applyRules even though the editors now
  // refuse to create one. When it does, it must be findable in the log.
  assert.ok(
    /outcome: 'unsupported'/.test(MAIN),
    'applyRules must record the verb it cannot run'
  );
  assert.ok(
    !/const spec = BULK_ACTIONS\[[^\]]*\];\s*if \(!spec\) continue;/.test(MAIN),
    'the bare `if (!spec) continue` swallow is back'
  );
});

/* ========================================================================
 * R5-5 · auto-archive and the rules pass fought over the same message
 * ==================================================================== */

test('R5-5: the category sweep claims its ids and the rules pass skips them', () => {
  /*
   * MEASURED BEFORE THE FIX with one unread `clubs` message, autoArchive
   * ['clubs'], and the natural rule `category:clubs -> archive`: autoArchive
   * removed it and fired a BULK; applyRules then planned an archive batch for
   * the same id and fired a SECOND, concurrent BULK.
   *
   * Two requests is the cheap half. The expensive half is that autoArchive
   * records an undo holding a snapshot while applyRules mutates the same id
   * underneath it, so Ctrl+Z restores a record the other path already removed.
   *
   * main.js's own comment always claimed rules act on "anything the category
   * sweep left behind". This makes that true.
   */
  assert.ok(
    /const swept = autoArchive\(records\);/.test(MAIN),
    'autoArchive must report what it claimed'
  );
  assert.ok(
    /applyRules\(swept\.size \? records\.filter\(\(m\) => !swept\.has\(m\.id\)\) : records\);/.test(MAIN),
    'the rules pass must exclude the swept ids'
  );
  // Both early returns must hand back a Set, or `.size` throws on the
  // overwhelmingly common "no auto-archive configured" path.
  const fn = MAIN.slice(MAIN.indexOf('function autoArchive(records) {'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const returns = body.match(/return [^;]+;/g) || [];
  assert.ok(returns.length >= 3, `expected the two guards and the claim, got ${returns.length}`);
  for (const r of returns) {
    assert.match(r, /new Set\(/, `autoArchive must always return a Set, found: ${r}`);
  }
});
