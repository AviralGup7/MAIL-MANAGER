import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('theme preview owns a full wrapped flex row', () => {
  const settings = read('src/styles/87-settings.css');
  const ui = read('src/styles/89-ui-innovation.css');
  assert.match(settings, /\.set-theme \{[^}]*flex-wrap: wrap/s);
  assert.match(ui, /\.set-theme-preview \{[^}]*flex: 1 0 100%/s);
});

test('reader dossier has explicit wide and narrow grid maps', () => {
  const css = read('src/styles/89-ui-innovation.css');
  assert.match(css, /grid-template-areas:[^;]*'subject nav'[^;]*'intel intel'/s);
  assert.match(css, /grid-template-areas: 'subject' 'meta' 'nav' 'tags' 'intel'/);
});

test('system strip scrolls rather than silently clipping large text', () => {
  const css = read('src/styles/89-ui-innovation.css');
  const strip = css.slice(css.indexOf('#system-strip {'), css.indexOf('}', css.indexOf('#system-strip {')));
  assert.match(strip, /overflow-x: auto/);
  assert.doesNotMatch(strip, /overflow: hidden/);
});

test('options disabled delay state is class-driven', () => {
  const js = read('src/options/options.js');
  const html = read('options.html');
  assert.doesNotMatch(js, /style\.opacity/);
  assert.match(js, /classList\.toggle\('delay-disabled'/);
  assert.match(html, /fieldset\.delay-disabled/);
});

test('background notification worker default is fail-closed', () => {
  const worker = read('src/background/index.js');
  assert.match(worker, /\{ bgNotify = false/);
  assert.match(worker, /if \(bgNotify !== true\) return/);
});
