/**
 * Timetable camera takeover (animation overhaul P6d).
 *
 * WHY THESE PINS EXIST
 * --------------------
 * The camera keeps a LEVEL counter (motion/camera.js); a push without a
 * pop strands the whole app 1.5% smaller forever, and two pushes on one
 * open double the recession. The pairing's only reliable anchor is the
 * same boolean both functions gate on — #tt-workspace's hidden bit — so
 * these pins freeze the seam: push exactly on the hidden→shown edge, pop
 * exactly on the shown→hidden edge, and NO third writer of that bit
 * anywhere in the product (source pins, fx-consumers precedent; the live
 * behavior is the P7 walk's job).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'src/app/academic/timetable-ui.js'), 'utf8');

test('push rides the real hidden→shown edge, never a re-render', () => {
  const open = src.slice(src.indexOf('export function openTimetable'));
  const earlyReturn = open.indexOf('if (!host.hidden) { render(); return; }');
  const flip = open.indexOf('host.hidden = false;');
  const push = open.indexOf('cameraPush()');
  assert.ok(earlyReturn !== -1 && earlyReturn < push,
    're-opening an OPEN workspace renders and returns BEFORE any push');
  assert.ok(flip !== -1 && push !== -1 && flip < push,
    'the workspace is real before the camera moves');
});

test('pop rides the shown→hidden edge, guarded by the same bit', () => {
  const close = src.slice(src.indexOf('export function closeTimetable'));
  assert.match(close, /if \(!host \|\| host\.hidden\) return;/,
    'already-closed never pops — the level cannot drift below the truth');
  const flip = close.indexOf('host.hidden = true;');
  const pop = close.indexOf('cameraPop()');
  assert.ok(flip !== -1 && pop !== -1 && flip < pop,
    'state settles synchronously; the camera reads settled state');
});

test('the hidden bit has exactly TWO writers and they are the seam above', () => {
  const writers = src.match(/host\.hidden = (?:true|false);/g) || [];
  assert.equal(writers.length, 2,
    'a third writer anywhere in this file would break the push/pop pairing');
  assert.match(src, /import \{ cameraPush, cameraPop \} from '\.\/motion\/camera\.js'/);
});
