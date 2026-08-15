import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const toast = readFileSync(new URL('../src/app/overlays/toast.js', import.meta.url), 'utf8');
const audio = readFileSync(new URL('../src/app/system/cyberpunk-audio.js', import.meta.url), 'utf8');
const fx = readFileSync(new URL('../src/app/system/cyberpunk-fx.js', import.meta.url), 'utf8');

test('toast emits kind-only semantic feedback without message content', () => {
  assert.match(toast, /new EventCtor\('bmm:feedback', \{ detail: \{ kind \} \}\)/);
  const event = toast.slice(toast.indexOf("new EventCtor('bmm:feedback"), toast.indexOf("new EventCtor('bmm:feedback") + 100);
  assert.doesNotMatch(event, /text/);
});

test('feedback cannot create an audio context outside a gesture', () => {
  assert.match(audio, /if \(!gesture && ctx === null\) return false/);
});

test('theme arrival is a trusted finite cue', () => {
  assert.match(fx, /cyberpunkArrival\(\)/);
  assert.match(fx, /playCyberpunkCue\('arrival', \{ gesture: true/);
});

test('pagehide releases audio and finite motion resources', () => {
  assert.match(fx, /addEventListener\?\.\('pagehide', onPageHide/);
  assert.match(fx, /disposeCyberpunkAudio/);
  assert.match(fx, /disposeCyberpunkMotion/);
});
