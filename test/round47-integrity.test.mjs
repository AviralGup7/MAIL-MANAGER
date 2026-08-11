/**
 * Round 47 — extraction integrity pins.
 *
 * This round's failures were all of one class: a pin or a guard that assumed
 * a fixed shape and went stale or silent when code moved. These pins make
 * that class fail loudly instead of quietly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('dom guards tolerate a missing node', async () => {
  const { setAttr, setText } = await import('../src/app/dom.js');
  // A row that was evicted between lookup and write must not throw.
  assert.doesNotThrow(() => setAttr(null, 'aria-label', 'x'));
  assert.doesNotThrow(() => setText(null, 'x'));
});

test('a boot-time toast is queued, not dropped', async () => {
  // Fresh module instance so initToast has not run yet.
  const toastMod = await import(`../src/app/toast.js?fresh=${Date.now()}`);
  const fakeNode = () => ({
    textContent: '', hidden: false, dataset: {}, style: {}, offsetWidth: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null,
  });
  const nodes = {
    toast: { dataset: {}, hidden: false, style: {}, offsetWidth: 0,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute() {} },
    toastText: fakeNode(), toastAction: fakeNode(), toastDrain: fakeNode(),
    toastIcon: fakeNode(), toastKbd: fakeNode(),
  };
  toastMod.toast('early', { ms: 10 });
  assert.equal(nodes.toastText.textContent, '', 'nothing rendered before init');
  toastMod.initToast(nodes);
  assert.equal(nodes.toastText.textContent, 'early', 'the queued toast replays on init');
});

test('every module path a pin suite reads actually exists', () => {
  // The stale-pin class of this round: a pin reading a function from a module
  // it no longer lives in. This guard fails if any pin suite references a
  // src path that does not exist, so a future move cannot strand a pin.
  const suites = ['layout-contract.test.mjs', 'reader-security.test.mjs',
    'round45-phase3.test.mjs', 'round46-phaseA.test.mjs', 'package.test.mjs'];
  for (const suite of suites) {
    const src = readFileSync(join(ROOT, 'test', suite), 'utf8');
    const rel = [...src.matchAll(/'\.\.\/(src\/[^']+\.js)'/g)].map((m) => m[1]);
    const read = [...src.matchAll(/read\('(src\/[^']+)'\)/g)].map((m) => m[1]);
    for (const p of [...new Set([...rel, ...read])]) {
      assert.ok(existsSync(join(ROOT, p)), `${suite} reads missing ${p}`);
    }
  }
});

test('reader controls carry accessible names (round 48)', () => {
  const app = readFileSync(join(ROOT, 'src/app/app.js'), 'utf8');
  assert.match(app, /aria-label', `Download \$\{a\.filename\}/, 'attachment chips named');
  assert.match(app, /aria-label', `Message body: /, 'body frame named per message');
  assert.match(app, /aria-label', `Unfold \$\{folds\.length\}/, 'unfold names its count');
  assert.match(app, /aria-label', `\$\{displayName\(msg\.from\)\}, /, 'strip rows named');
});

test('visual harness waits for the theme to land (round 48)', () => {
  const vr = readFileSync(join(ROOT, 'tools/visual-regression.mjs'), 'utf8');
  assert.match(vr, /hasAttribute\('data-theme'\)/, 'waits for the theme stamp');
});
