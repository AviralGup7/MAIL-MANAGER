import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('options status uses semantic tones rather than JS colour literals', () => {
  const src = read('src/options/options.js');
  assert.doesNotMatch(src, /style\.color/);
  assert.match(src, /function setTone/);
  for (const tone of ['error', 'success', 'neutral']) assert.match(src, new RegExp(`'${tone}'`));
});

test('options tone styles are centralized', () => {
  const html = read('options.html');
  for (const tone of ['error', 'success', 'neutral']) assert.match(html, new RegExp(`data-tone='${tone}'`));
});

test('wide options page becomes a two-column property workspace', () => {
  const html = read('options.html');
  assert.match(html, /min-width: 900px/);
  assert.match(html, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});

test('narrow options controls retain large targets', () => {
  const html = read('options.html');
  assert.match(html, /max-width: 560px/);
  assert.match(html, /min-height: 44px/);
});
