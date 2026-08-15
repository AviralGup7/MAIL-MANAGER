import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('outbox renders four bounded transaction phases', () => {
  const src = read('src/app/workspace/rails.js');
  assert.match(src, /\['queued', 'held', 'dispatch', 'settled'\]/);
  assert.match(src, /track\.dataset\.state = it\.state/);
  assert.match(src, /aria-hidden/);
});

test('uncertain delivery is visually distinct from ordinary failure', () => {
  const css = read('src/styles/89-ui-innovation.css');
  assert.match(css, /data-state='uncertain'/);
  assert.match(css, /repeating-linear-gradient/);
  assert.match(css, /var\(--warning\)/);
});

test('operation-center preference can remove the ledger', () => {
  const css = read('src/styles/89-ui-innovation.css');
  assert.match(css, /data-operation-center='off'\] \.outbox-track/);
});

test('system operation entry delegates to the existing activity log', () => {
  const src = read('src/app/main.js');
  assert.match(src, /openOperations: \(\) => \$\('btn-activity'\)\?\.click\(\)/);
});
