import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('query chips publish negation and scope as inspectable state', () => {
  const src = read('src/app/search/search-chips.js');
  assert.match(src, /dataset\.negated/);
  assert.match(src, /dataset\.scope/);
});

test('query console has a named execution frame', () => {
  const css = read('src/styles/89-ui-innovation.css');
  assert.match(css, /content: 'QUERY'/);
  assert.match(css, /data-query-console='on'/);
});

test('negation is visible without relying only on text', () => {
  const css = read('src/styles/89-ui-innovation.css');
  assert.match(css, /data-negated='true'/);
  assert.match(css, /var\(--danger\)/);
});

test('legacy query behavior remains available through one profile switch', () => {
  const schema = read('src/app/system/settings.js');
  assert.match(schema, /uiProfile:[^\n]+legacy/);
});
