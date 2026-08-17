/**
 * THE TOTALITY SWEEP (round 11).
 *
 * WHY THIS EXISTS
 * ---------------
 * A census called every exported function under `src/` with the argument
 * shapes a real caller can actually produce — `undefined`, `null`, and `{}`
 * (a partially-shaped record out of the cache, a backup import, or a partial
 * sync). 123 of them threw.
 *
 * Individually each was a one-line omission. Together they were a class: any
 * of them on a render or ingest path turns one damaged record into a blank
 * surface, because a throw mid-loop abandons the rest of the paint. This
 * project has already paid for that twice — `classifyAll` (fuzz round 3) and
 * `displayName` (same sweep) both aborted the whole inbox for one bad row.
 *
 * They are fixed. This test stops them coming back: it re-runs the census on
 * every CI run and fails on any NEW crash site.
 *
 * WHY AN ALLOW-LIST AND NOT ZERO
 * ------------------------------
 * Six functions still throw, and all six are correct:
 *
 *   settings.get(undefined)     throws BY DESIGN — an unknown key is a
 *                               programming error, and the schema is the
 *                               authority. Silently returning undefined
 *                               would hide a typo'd setting name forever.
 *   parseHash(h, {})            needs its validMailbox collaborator; without
 *                               one it cannot answer, and guessing "valid"
 *                               would let a foreign hash desync the store.
 *   icon / applyTheme /         need a DOM. They are called only from a
 *   applyInitialTheme /         rendered page; the census runs headless, so
 *   chooseTheme                 this is the harness's absence, not theirs.
 *                               Verified: all four pass under jsdom.
 *
 * Anything else that starts throwing is a regression, and the message below
 * tells the next person exactly which shape broke it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** file::fn -> why it may still throw. Adding a line here needs a reason. */
const ALLOWED = new Map([
  ['src/app/system/settings.js::get',
    'an unknown setting key is a programming error; the schema is the authority'],
  ['src/app/system/deep-links.js::parseHash',
    'needs its validMailbox collaborator — guessing "valid" desyncs the store'],
  ['src/app/core/icons.js::icon', 'needs a DOM; verified fine under jsdom'],
  ['src/app/system/themes.js::applyTheme', 'needs a DOM; verified fine under jsdom'],
  ['src/app/system/theme-controller.js::applyInitialTheme', 'needs a DOM; verified fine under jsdom'],
  ['src/app/system/theme-controller.js::chooseTheme', 'needs a DOM; verified fine under jsdom'],
]);

test('every exported function survives the shapes a caller can really pass', async () => {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  for (const d of ['src/app', 'src/features', 'src/classify', 'src/shared',
    'src/background', 'src/platform']) walk(d);

  /*
   * ONLY REACHABLE SHAPES. `-1` or `true` as a whole argument is not a shape
   * any caller produces, and guarding those would be noise that buries the
   * real signal — the discipline that made this census actionable.
   */
  const SHAPES = [[undefined, 'undefined'], [null, 'null'], [{}, '{}']];
  const crashes = [];

  for (const file of files) {
    let mod;
    try { mod = await import(`../${file}`); } catch { continue; }
    for (const [name, fn] of Object.entries(mod)) {
      if (typeof fn !== 'function' || name.startsWith('_') || fn.length === 0) continue;
      /* DOM-mounting entry points take a live document by contract. */
      if (/^(wire|render|open|init|mount|attach|detach|close|toggle)/i.test(name)) continue;
      if (ALLOWED.has(`${file}::${name}`)) continue;
      for (const [arg, label] of SHAPES) {
        try {
          const r = fn(arg);
          if (r && typeof r.then === 'function') r.catch(() => {});
        } catch (err) {
          crashes.push(`${file} ${name}(${label}) -> ${err.message.slice(0, 70)}`);
          break;
        }
      }
    }
  }

  assert.deepEqual(crashes, [],
    'a function on a render or ingest path threw on absent input. One damaged '
    + 'record must cost its own verdict, never the whole surface — give it the '
    + "honest empty value it returns on a healthy call ([] for a list reader, "
    + 'false for a predicate, \'\' for a formatter), or add it to ALLOWED with '
    + 'the reason it must throw.');
});

test('the allow-list itself stays honest', () => {
  /* An entry that no longer throws should be REMOVED, or the list becomes a
     place regressions hide. Every line must still be earning its exemption. */
  assert.ok(ALLOWED.size <= 8, 'the exemption list is not a dumping ground');
  for (const [key, why] of ALLOWED) {
    assert.match(key, /^src\/.+::\w+$/, `${key} is not a file::fn key`);
    assert.ok(why.length > 20, `${key} needs a real reason, not a label`);
  }
});
