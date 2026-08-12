/**
 * The 20-improvement polish round: contracts that can rot silently.
 * Each mirrors a decision above; the behavioural halves live in Chrome.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const js = read('src/app/app.js')
  // The tab-title stamp moved with the sidebar (round 52).
  + read('src/app/sidebar.js');
// The list cluster moved out of app.js in the round-52 workspace extraction.
const list = read('src/app/list.js');
const css = read('src/app/app.css');
const html = read('app.html');

test('search highlighting is built from text nodes, never innerHTML', () => {
  const fn = list.slice(list.indexOf('function setHighlighted('), list.indexOf('function setHighlighted(') + 1200);
  assert.match(fn, /document\.createElement\('mark'\)/);
  assert.ok(!fn.includes('innerHTML'), 'query text must never become markup');
  assert.match(fn, /\/\[:"]\//, 'operator queries must not highlight');
});

test('deadline views carry urgency colours from tokens', () => {
  assert.match(css, /\.cat\.hot-danger \.c-unread \{ color: var\(--danger\); \}/);
  assert.match(css, /\.cat\.hot-warm \.c-unread \{ color: var\(--warning\); \}/);
  assert.match(js, /classList\.toggle\('hot-danger', key === 'sv-overdue' && u > 0\)/);
});

test('the coach mark is one-time and schema-backed', () => {
  assert.match(read('src/app/settings.js'), /coachDone: \{ type: 'bool', def: false \}/);
  assert.match(js, /if \(!settings\.get\('coachDone'\)\)/);
});

test('menus flip inside the viewport for all four menus at once', () => {
  // Round 64.5: menus mount into #overlay-root with position: fixed and the
  // flip is a simple measure-after-mount decision -- if the menu would cross
  // the viewport's lower edge it opens above the anchor instead. The old pin
  // matched raf-clamp arithmetic from when menus lived inside the anchor's
  // (clipping, stacking) context; that whole failure class is gone.
  const menu = read('src/app/menu.js');
  assert.match(menu, /top \+ mh > vh - 8/, 'the flip decision must remain');
  assert.match(menu, /overlay-root/, 'menus mount in the overlay root');
  assert.match(menu, /position:\s*'fixed'|position:\s*"fixed"|\.fixed\b|style\.position = 'fixed'/, 'menus are fixed-position');
  assert.ok(!/scroll-snap/.test(menu));
});

test('first run honours the OS colour scheme; a saved choice wins', () => {
  assert.match(js, /prefers-color-scheme: dark/);
  assert.match(js, /applyTheme\(theme \|\| \(osDark \? 'midnight' : DEFAULT_THEME\)\)\.id/);
});

test('freshness is a real sync control', () => {
  assert.match(html, /<button id="freshness"/);
  assert.match(js, /\$\('freshness'\)\.addEventListener\('click', \(\) => refresh\(\)\)/);
});

test('the tab agrees with the rail', () => {
  assert.match(js, /document\.title = totalUnread/);
});
