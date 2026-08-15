import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/app/system/cyberpunk-fx.js', import.meta.url), 'utf8');

test('controller uses delegation instead of per-control listeners', () => {
  assert.match(src, /addEventListener\('click', onClick, true\)/);
  assert.match(src, /addEventListener\('pointerover', onHover, true\)/);
  assert.doesNotMatch(src, /querySelectorAll/);
});

test('disabled controls never produce interaction cues', () => {
  assert.match(src, /control\.disabled/);
  assert.match(src, /aria-disabled/);
});

test('semantic feedback maps success error and undo separately', () => {
  assert.match(src, /kind === 'success' \? 'success'/);
  assert.match(src, /kind === 'error' \? 'error'/);
  assert.match(src, /kind === 'undo' \? 'warning'/);
});

test('controller has explicit teardown for listeners motion and audio', () => {
  assert.match(src, /export function disposeCyberpunkFx/);
  assert.match(src, /removeEventListener/);
  assert.match(src, /disposeCyberpunkMotion/);
  assert.match(src, /disposeCyberpunkAudio/);
});
