import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('visual regression derives every theme id from theme data', () => {
  const src = read('tools/visual-regression.mjs');
  assert.match(src, /const THEMES = THEMES_DATA\.map\(\(theme\) => theme\.id\)/);
  assert.doesNotMatch(src, /'high-contrast'/);
});

test('static HTML cannot bypass the no-wrong-theme first-paint guard', () => {
  const html = read('app.html');
  assert.match(html, /<html lang="en">/);
  assert.doesNotMatch(html, /<html[^>]+data-theme=/);
});

test('calm content removes the global scan sheet and restores it only to chrome', () => {
  const css = read('src/styles/88-cyberpunk.css');
  assert.match(css, /data-calm-content='on'\] body::after \{\n  display: none/);
  assert.match(css, /data-calm-content='on'\] #sidebar/);
  assert.match(css, /data-calm-content='on'\] #r-frame/);
});

test('thread current styling follows renderer state', () => {
  const css = read('src/styles/89-ui-innovation.css');
  assert.match(css, /#r-thread button\.current/);
  assert.match(css, /#r-thread button\[aria-pressed='true'\]/);
  assert.doesNotMatch(css, /#r-thread button\[aria-current/);
});
