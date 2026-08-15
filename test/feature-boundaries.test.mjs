import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('cross-context outbox and snooze models are feature-owned', () => {
  for (const path of ['src/features/outbox/model.js', 'src/features/snooze/model.js']) {
    assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), path);
  }
  assert.equal(existsSync(new URL('../src/app/compose/outbox.js', import.meta.url)), false);
  assert.equal(existsSync(new URL('../src/app/system/snooze.js', import.meta.url)), false);
});

test('worker imports feature models and never app presentation', () => {
  const worker = read('src/background/index.js');
  assert.match(worker, /from '\.\.\/features\/outbox\/model\.js'/);
  assert.match(worker, /from '\.\.\/features\/snooze\/model\.js'/);
  assert.doesNotMatch(worker, /from '\.\.\/app\//);
});

test('audience classification has a responsibility-revealing filename', () => {
  assert.ok(existsSync(new URL('../src/app/system/audience.js', import.meta.url)));
  assert.equal(existsSync(new URL('../src/app/system/direct.js', import.meta.url)), false);
  assert.match(read('src/app/system/audience.js'), /export function audienceOf/);
});

test('theme transition policy is outside the composition root', () => {
  const controller = read('src/app/system/theme-controller.js');
  const main = read('src/app/main.js');
  assert.match(controller, /export function applyInitialTheme/);
  assert.match(controller, /export function chooseTheme/);
  assert.match(main, /chooseTheme\(id, \{ state, toast \}\)/);
  assert.doesNotMatch(main, /function setTheme\(id\) \{[^}]*settings\.set\('theme'/s);
});
