import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/app/system/cyberpunk-audio.js', import.meta.url), 'utf8');

test('audio context is lazy and gesture-owned', () => {
  assert.ok(src.indexOf('new AudioCtor') > src.indexOf('function audio('));
  assert.match(src, /if \(!allowCreate/);
});

test('sound palette distinguishes navigation, action, success, warning and error', () => {
  for (const cue of ['navigate', 'activate', 'success', 'warning', 'error', 'arrival']) {
    assert.match(src, new RegExp(`  ${cue}: \\[`));
  }
});

test('calm intensity suppresses hover navigation audio', () => {
  assert.match(src, /cue === 'navigate' && rootData\(\)\.cpIntensity === 'calm'/);
});

test('audio is synthesized and has no sampled asset path', () => {
  assert.match(src, /createOscillator/);
  assert.match(src, /createBiquadFilter/);
  assert.doesNotMatch(src, /\.(mp3|wav|ogg|m4a)/i);
});
