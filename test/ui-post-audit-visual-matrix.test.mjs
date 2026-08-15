import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const vr = readFileSync(new URL('../tools/visual-regression.mjs', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles/89-ui-innovation.css', import.meta.url), 'utf8');

test('cyberpunk visual matrix covers intensity and texture authority', () => {
  for (const value of ['calm', 'balanced', 'maximum']) assert.match(vr, new RegExp(`intensity: '${value}'`));
  assert.match(vr, /textures: false/);
  assert.match(vr, /textures: true/);
});

test('variant identity is preserved in screenshot filenames', () => {
  assert.match(vr, /variantTag/);
  assert.match(vr, /variant\.intensity/);
  assert.match(vr, /textures \? 'textures' : 'plain'/);
});

test('forced-colors mode preserves target source and failure signals', () => {
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /\.r-cursor/);
  assert.match(css, /\.r-origin/);
  assert.match(css, /\.outbox-track/);
  assert.match(css, /Highlight/);
});
