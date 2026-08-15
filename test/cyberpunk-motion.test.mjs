import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/app/system/cyberpunk-motion.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles/88-cyberpunk.css', import.meta.url), 'utf8');

test('visual signals are finite and never use an interval', () => {
  assert.match(src, /setTimeout\(done, duration\)/);
  assert.doesNotMatch(src, /setInterval/);
});

test('reduced motion and calm intensity suppress signals', () => {
  assert.match(src, /cpIntensity === 'calm'/);
  assert.match(src, /prefers-reduced-motion: reduce/);
});

test('one signal owns the root at a time', () => {
  assert.match(src, /clear\(root\)/);
  assert.match(src, /activeClass/);
});

test('signal keyframe is namespaced and transform-opacity only', () => {
  assert.match(css, /@keyframes cp-signal-kick/);
  const body = css.slice(css.indexOf('@keyframes cp-signal-kick'), css.indexOf('GATE SENTINEL'));
  assert.doesNotMatch(body, /width:|height:|filter:|background-position:/);
});
