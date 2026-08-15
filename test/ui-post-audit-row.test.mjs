import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('row pseudo-elements remain owned by the base list component', () => {
  const ui = read('src/styles/89-ui-innovation.css');
  assert.doesNotMatch(ui, /\.row(?:\[[^\]]+\])?::(?:before|after)/);
});

test('provenance and selected cursor are real row children', () => {
  const list = read('src/app/mail/list.js');
  assert.match(list, /class="r-cursor"/);
  assert.match(list, /class="r-origin"/);
  const css = read('src/styles/89-ui-innovation.css');
  assert.match(css, /\.r-cursor/);
  assert.match(css, /\.r-origin/);
});

test('row rendering resolves durable and overlay messages through one function', () => {
  const list = read('src/app/mail/list.js');
  assert.match(list, /function messageOf\(id\)/);
  assert.match(list, /storeOf\?\.\(\)\.get\(id\) \|\| overlayGet\(id\)/);
  assert.ok((list.match(/fillRow\([^\n]+messageOf\(id\)/g) || []).length >= 3);
});

test('additive dossier query and thread selectors are positively modern-gated', () => {
  const css = read('src/styles/89-ui-innovation.css');
  for (const attr of ['data-reader-dossier', 'data-thread-timeline', 'data-query-console']) {
    assert.match(css, new RegExp(`data-ui-profile='modern'\\]\\[${attr}`));
  }
});
