/**
 * M3 — the dry-run before the auto-archive flip (2026-08-13).
 *
 * WHY THESE PINS
 * --------------
 * The auto-archive pipeline already existed (opt-in per category, unread
 * arrivals only, logged with actor 'rule'). What it lacked was TRUST
 * TOOLING: the toggle in the category menu flipped blind, and a rule that
 * removes mail without preview is a rule people learn to fear. The gate is
 * two pieces with separate failure modes, so both are pinned:
 *
 *   1. rules.js autoArchiveMatchSet mirrors the INGEST filter exactly
 *      (category ∧ unread ∧ not-search) — a preview that disagrees with
 *      the pipeline is worse than none.
 *   2. category-menu gates ONLY the ON flip through a confirmDialog that
 *      names the match set and restates the arrivals-only contract; the
 *      OFF flip stays one click.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const rulesSrc = read('src/app/mail/rules.js');
const menuSrc = read('src/app/overlays/category-menu.js');

test('the ON flip is gated; the OFF flip is not', () => {
  assert.match(menuSrc,
    /!isAutoArchived\(ctx\.getRules\(\), category\)\s*&&\s*!\(await confirmAutoArchive\(ctx, category, label\)\)\) return;/,
    'turning on asks first');
  assert.match(menuSrc, /import \{ confirmDialog \} from '\.\/dialog\.js';/, 'a real dialog, not a toast');
  /* Turning off puts out a fire: no dialog may be added to that path. The
     toggle line must be reachable without passing the gate. */
  assert.match(menuSrc, /ctx\.setRules\(toggleAutoArchive\(ctx\.getRules\(\), category\)\);/);
});

test('the dialog states the contract and names examples', () => {
  assert.match(menuSrc, /The rule acts on NEW arrivals only/, 'the arrivals-only promise is in the body');
  assert.match(menuSrc, /match this rule right now/, 'the count is in the body');
  assert.match(menuSrc, /confirmLabel: 'Turn on'/, 'the confirm names the consequential action');
});

test('the preview mirror cannot drift from the ingest filter', () => {
  /* main.js's autoArchive filter: targets.has(m.category) && m.unread &&
     !m.fromSearch. The mirror's three terms, pinned in one place. */
  assert.match(rulesSrc, /m\.category !== category \|\| !m\.unread \|\| m\.fromSearch/,
    'same three terms as the ingest filter');
  assert.match(rulesSrc, /export function autoArchiveMatchSet\(messages, category, cap = 3\)/);
});

test('autoArchiveMatchSet: the truth table', async () => {
  const { autoArchiveMatchSet } = await import('../src/app/mail/rules.js');
  const msg = (over) => ({ id: Math.random().toString(36).slice(2), category: 'events', unread: true, subject: 'A thing', ...over });
  const list = [
    msg({ subject: 'Fresh event' }),              // counts
    msg({ subject: 'Second event' }),             // counts
    msg({ unread: false }),                       // read — out
    msg({ fromSearch: true }),                    // search-stamped — out
    msg({ category: 'clubs' }),                   // other category — out
  ];
  const { count, samples } = autoArchiveMatchSet(list, 'events');
  assert.equal(count, 2);
  assert.deepEqual(samples, ['Fresh event', 'Second event']);
  /* samples cap without losing the count */
  const many = Array.from({ length: 9 }, (_, i) => msg({ subject: `s${i}` }));
  const big = autoArchiveMatchSet(many, 'events');
  assert.equal(big.count, 9);
  assert.equal(big.samples.length, 3, 'samples cap at 3');
  /* empty input is a clean zero, not a crash */
  assert.deepEqual(autoArchiveMatchSet([], 'events'), { count: 0, samples: [] });
});
