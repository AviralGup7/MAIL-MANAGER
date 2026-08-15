import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('reader dossier is controlled by a root preference', () => {
  const css = read('src/styles/89-ui-innovation.css');
  assert.match(css, /data-reader-dossier='on'/);
  assert.match(css, /#reader-head/);
});

test('thread trajectory targets the real r-thread surface', () => {
  const html = read('app.html');
  const css = read('src/styles/89-ui-innovation.css');
  assert.match(html, /id="r-thread"/);
  assert.match(css, /#r-thread:not\(\[hidden\]\)/);
  assert.doesNotMatch(css, /#thread-strip/);
});

test('calm content covers both reading and writing surfaces', () => {
  const css = read('src/styles/89-ui-innovation.css');
  assert.match(css, /#r-frame/);
  assert.match(css, /#c-text/);
  assert.match(css, /background-image: none/);
});

test('dossier remains a semantic article rather than becoming a fake dialog', () => {
  const html = read('app.html');
  assert.match(html, /<article id="reader" role="article"/);
  assert.match(html, /aria-labelledby="r-subject"/);
});
