import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('reader contains an accessible message-facts region', () => {
  assert.match(read('app.html'), /<dl id="r-intel" aria-label="Message facts"/);
});

test('message facts are derived from real record state', () => {
  const src = read('src/app/mail/reader.js');
  for (const key of ['STATE', 'THREAD', 'SOURCE', 'CONFIDENCE']) assert.match(src, new RegExp(`'${key}'`));
  assert.doesNotMatch(src, /Math\.random/);
});

test('facts use textContent and never HTML interpolation', () => {
  const src = read('src/app/mail/reader.js');
  const block = src.slice(src.indexOf("const facts = ["), src.indexOf('el.rIntel.replaceChildren'));
  assert.match(block, /textContent/);
  assert.doesNotMatch(block, /innerHTML|insertAdjacentHTML/);
});

test('legacy and dossier-off modes remove the additive facts', () => {
  const css = read('src/styles/89-ui-innovation.css');
  assert.match(css, /data-reader-dossier='off'\] #r-intel/);
  assert.match(css, /data-ui-profile='legacy'\] #r-intel/);
});
