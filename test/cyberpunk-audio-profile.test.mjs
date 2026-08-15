import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const audio = readFileSync(new URL('../src/app/system/cyberpunk-audio.js', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../src/app/system/settings.js', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../src/app/overlays/settings-panel.js', import.meta.url), 'utf8');

test('audio detail has minimal semantic and full profiles', () => {
  assert.match(settings, /cyberpunkAudioProfile:[^\n]+\['minimal', 'semantic', 'full'\]/);
  assert.match(panel, /key: 'cyberpunkAudioProfile'/);
});

test('minimal profile carries only warning and error', () => {
  assert.match(audio, /profile === 'minimal'[^\n]+cue === 'warning' \|\| cue === 'error'/);
});

test('semantic profile removes navigation noise', () => {
  assert.match(audio, /profile === 'semantic'[^\n]+cue !== 'navigate'/);
});

test('polyphony is bounded and ended voices disconnect', () => {
  assert.match(audio, /MAX_VOICES = 12/);
  assert.match(audio, /voices\.size >= MAX_VOICES/);
  assert.match(audio, /osc\.onended/);
  assert.match(audio, /voices\.delete\(osc\)/);
  assert.match(audio, /filter\.disconnect\(\)/);
});
