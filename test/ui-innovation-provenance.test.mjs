import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('canonical Gmail records carry truthful provenance', () => {
  const src = read('src/app/main.js');
  assert.match(src, /_provenance: m\._provenance \|\| 'gmail'/);
});

test('warm-cache records are explicitly local', () => {
  const src = read('src/app/main.js');
  assert.match(src, /_provenance: 'local'/);
});

test('remote server-search overlay is explicitly remote', () => {
  const src = read('src/app/search/server-search.js');
  assert.match(src, /_provenance: 'remote'/);
});

test('message rows publish source and operation without changing text', () => {
  const src = read('src/app/mail/list.js');
  assert.match(src, /li\.dataset\.source/);
  assert.match(src, /li\.dataset\.operation = operation/);
  assert.match(src, /delete li\.dataset\.operation/);
});
