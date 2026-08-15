import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const audio = readFileSync(new URL('../src/app/system/cyberpunk-audio.js', import.meta.url), 'utf8');
const fx = readFileSync(new URL('../src/app/system/cyberpunk-fx.js', import.meta.url), 'utf8');
const doc = readFileSync(new URL('../docs/CYBERPUNK-AUDIO-STUDY.md', import.meta.url), 'utf8');

test('studied taxonomy includes open close value and data flow', () => {
  for (const cue of ['open', 'close', 'valueUp', 'valueDown', 'data']) {
    assert.match(audio, new RegExp(`  ${cue}: \\[`));
  }
});

test('organic-digital translation layers generated noise with tone', () => {
  assert.match(audio, /function noiseLayer/);
  assert.match(audio, /createBuffer\(/);
  assert.match(audio, /createBufferSource\(/);
  assert.match(audio, /type = 'bandpass'/);
});

test('open close and value changes are routed by the controller', () => {
  assert.match(fx, /function cueFor/);
  assert.match(fx, /return 'open'/);
  assert.match(fx, /return 'close'/);
  assert.match(fx, /function onChange/);
  assert.match(fx, /'valueUp'/);
  assert.match(fx, /'valueDown'/);
});

test('escape receives a close cue for keyboard parity', () => {
  assert.match(fx, /e\.key === 'Escape'/);
  assert.match(fx, /playCyberpunkCue\('close'/);
});

test('research record forbids extracted or redistributed game audio', () => {
  assert.match(doc, /does \*\*not\*\* contain/);
  assert.match(doc, /No files were downloaded/);
  assert.match(doc, /No sampled game material ships/);
});
