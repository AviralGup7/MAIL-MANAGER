import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('outbox renders four bounded transaction phases', () => {
  const src = read('src/app/workspace/rails.js');
  assert.match(src, /\['queued', 'held', 'dispatch', 'settled'\]/);
  assert.match(src, /track\.dataset\.state = it\.state === 'failed'/);
  assert.match(src, /aria-hidden/);
});

test('uncertain delivery is visually distinct from ordinary failure', () => {
  const css = read('src/styles/89-ui-innovation.css');
  assert.match(css, /data-state='uncertain'/);
  assert.match(css, /repeating-linear-gradient/);
  assert.match(css, /var\(--warning\)/);
});

test('ledger appears only in modern operation-center mode', () => {
  const css = read('src/styles/89-ui-innovation.css');
  assert.match(css, /data-ui-profile='modern'\]\[data-operation-center='on'\] \.outbox-track/);
  assert.match(css, /\.outbox-track \{[^}]*display: none/s);
});

test('system operation entry delegates to the existing activity log', () => {
  const src = read('src/app/main.js');
  assert.match(src, /openOperations: \(\) => \$\('btn-activity'\)\?\.click\(\)/);
});
