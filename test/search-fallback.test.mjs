/**
 * Server search fallback.
 *
 * The local index covers subject and sender only. Without a fallback, a search
 * for a phrase the user remembers from the BODY returns nothing and they
 * conclude the mail is gone -- a confidently wrong answer, which is worse than
 * a slow one.
 *
 * The risks in this feature are all about ORDERING: a stale response
 * overwriting a newer one, and a timer outliving the document.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/app/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../app.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/app/app.css', import.meta.url), 'utf8');

function serverSearchFn() {
  const at = app.indexOf('async function runServerSearch');
  assert.ok(at > 0, 'runServerSearch not found');
  return app.slice(at, at + 2200);
}

test('the note element the code writes to actually exists', () => {
  // setSearchNote() looked up '#search-note' before the element existed, which
  // is a silent no-op: the feature works and never says anything.
  assert.ok(app.includes("$('search-note')"), 'setSearchNote should query it');
  assert.ok(html.includes('id="search-note"'), 'and app.html must define it');
});

test('the note is a live region so the result is announced', () => {
  assert.match(html, /id="search-note"[^>]*aria-live="polite"/);
  assert.match(html, /id="search-note"[^>]*role="status"/);
});

test('the note starts hidden', () => {
  assert.match(html, /id="search-note"[^>]*\bhidden\b/);
});

test('the note is inside the search wrapper, not a topbar flex child', () => {
  // #topbar is a single centred flex row; a block child there is squeezed
  // into the row and shifts the whole toolbar.
  const wrap = html.slice(html.indexOf('id="searchwrap"'), html.indexOf('id="toolbar"'));
  assert.ok(wrap.includes('id="search-note"'), 'must live inside #searchwrap');
});

test('the note is positioned out of flow so the toolbar cannot jump', () => {
  const rule = css.slice(css.indexOf('#search-note {'), css.indexOf('#search-note {') + 320);
  assert.match(rule, /position:\s*absolute/);
});

// ------------------------------------------------------------- behaviour ---

test('short queries never reach the network', () => {
  // One round trip per character while typing "a" would be abusive.
  assert.match(app, /SERVER_SEARCH_MIN\s*=\s*[3-9]/);
  const fn = app.slice(app.indexOf('function scheduleServerSearch'));
  assert.ok(fn.slice(0, 700).includes('q.length < SERVER_SEARCH_MIN'));
});

test('the fallback is debounced by a timer, not a frame', () => {
  // A frame debounce would fire a request per keystroke.
  assert.match(app, /SERVER_SEARCH_MS\s*=\s*\d{3}/);
  const fn = app.slice(app.indexOf('function scheduleServerSearch'));
  assert.ok(fn.slice(0, 700).includes('setTimeout(runServerSearch'));
});

test('a pending request is cleared before another is scheduled', () => {
  const fn = app.slice(app.indexOf('function scheduleServerSearch'));
  assert.ok(fn.slice(0, 300).includes('clearTimeout(serverSearchTimer)'));
});

/*
 * THE RACE.
 *
 * Type "reg", pause, type "istration". The first response can land after the
 * second. Without a token check the user sees results for a query they have
 * already moved on from -- and cannot tell that is what happened.
 */
test('a superseded response is dropped', () => {
  const fn = serverSearchFn();
  assert.ok(fn.includes('const token = ++serverSearchToken'), 'no request token');
  assert.ok(
    (fn.match(/token !== serverSearchToken/g) || []).length >= 2,
    'both the success and failure paths must check the token'
  );
});

test('cancelling bumps the token, not just the timer', () => {
  // Clearing the timer only stops requests that have not started yet.
  const fn = app.slice(app.indexOf('function cancelPendingWork'));
  const body = fn.slice(0, 400);
  assert.ok(body.includes('clearTimeout(serverSearchTimer)'));
  assert.ok(body.includes('serverSearchToken++'), 'in-flight responses must be neutralised');
});

test('teardown runs on pagehide AND on release', () => {
  // release() tears the iframe down without pagehide firing reliably.
  const ph = app.slice(app.indexOf("addEventListener('pagehide'"), app.indexOf("addEventListener('pagehide'") + 500);
  assert.ok(ph.includes('cancelPendingWork()'));
  const rel = app.slice(app.indexOf('function release()'), app.indexOf('function release()') + 400);
  assert.ok(rel.includes('cancelPendingWork()'));
});

test('a teardown seam is exposed for harnesses', () => {
  // A test that swaps the globals leaves timers pointing at a dead document.
  assert.match(app, /window\.__bmmTeardown = cancelPendingWork/);
});

test('the fallback never advances the history cursor', () => {
  // A search is not an inbox sync; advancing the cursor here would skip inbox
  // changes that were never fetched.
  assert.match(serverSearchFn(), /anchorHistory: false/);
});

test('results already on screen are not duplicated', () => {
  const fn = serverSearchFn();
  assert.ok(fn.includes('before.has(m.id)') || fn.includes('!before.has'), 'must diff against what is shown');
});

test('server results are marked so they are distinguishable later', () => {
  assert.match(serverSearchFn(), /fromSearch: true/);
});

test('a failed fallback does not read as "no results"', () => {
  // The local results are still valid and still on screen.
  const fn = serverSearchFn();
  const catchBlock = fn.slice(fn.indexOf('} catch'));
  assert.ok(
    /local results only|Could not search/i.test(catchBlock),
    'failure must be reported as a failure, not as emptiness'
  );
});

test('the fallback only runs where there is a local index to supplement', () => {
  const fn = app.slice(app.indexOf('function scheduleServerSearch'));
  assert.ok(fn.slice(0, 900).includes("state.mailbox !== 'inbox'"));
});
