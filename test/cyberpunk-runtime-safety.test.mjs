import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const audio = readFileSync(new URL('../src/app/system/cyberpunk-audio.js', import.meta.url), 'utf8');
const fx = readFileSync(new URL('../src/app/system/cyberpunk-fx.js', import.meta.url), 'utf8');
const motion = readFileSync(new URL('../src/app/system/cyberpunk-motion.js', import.meta.url), 'utf8');

test('layered cues reserve every voice before allocation', () => {
  assert.match(audio, /const needed = spec\.noise \? 2 : 1/);
  assert.match(audio, /voices\.size \+ needed > MAX_VOICES/);
});

test('synthetic change cannot create an audio context', () => {
  assert.match(fx, /gesture: e\.isTrusted === true/);
});

test('expanded popup state chooses open versus close correctly', () => {
  assert.match(fx, /expanded === 'true'\) return 'close'/);
  assert.match(fx, /expanded === 'false'[^\n]+return 'open'/);
});

test('ordinary text and search fields are excluded from voiced controls', () => {
  const voiced = fx.match(/const VOICED = ([^;]+);/)?.[1] || '';
  assert.doesNotMatch(voiced, /input,|type="text"|type="search"/);
  assert.match(voiced, /type="checkbox"/);
});

test('master changes are smoothed through a limiter', () => {
  assert.match(audio, /createDynamicsCompressor/);
  assert.match(audio, /setTargetAtTime/);
  assert.match(audio, /master\.connect\(limiter\)/);
});

test('motion cleanup removes stale listener and checks generation', () => {
  assert.match(motion, /removeEventListener\('animationend'/);
  assert.match(motion, /mine !== generation/);
  assert.match(motion, /event\.target !== root/);
});
