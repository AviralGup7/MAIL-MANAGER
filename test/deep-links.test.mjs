/**
 * Hash deep links (round 65/g, docs/UX-AUDIT-V4 F7, brief §20/21).
 *
 * Behavioural pins cover the round-trip (format ⇄ parse) and the apply
 * choreography against a fake shell; source pins guard the doctrine —
 * mirror-at-the-frame, push only for deliberate view navigation, and NO
 * history writes anywhere outside the module (j/k pollution must be
 * structurally impossible, not conventionally avoided).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const appjs = read('src/app/app.js');
const src = read('src/app/deep-links.js');

const {
  formatHash, parseHash, wireDeepLinks, navigateHash, mirrorHash, applyHash,
  checkPendingSelection, _resetDeepLinks,
} = await import('../src/app/deep-links.js');

const isMailbox = (v) => ['inbox', 'sent', 'drafts', 'snoozed', 'spam', 'trash'].includes(v);

test('format ⇄ parse round-trips, canonical and encoded', () => {
  assert.equal(formatHash({ mailbox: 'inbox', category: 'all', query: '', selected: null }),
    '#inbox/all', 'the default view has a canonical short form');
  assert.equal(
    formatHash({ mailbox: 'inbox', category: 'augsd', query: 'a & b', selected: 't0' }),
    '#inbox/augsd?q=a%20%26%20b&m=t0',
    'query text with an ampersand must not become a parameter boundary'
  );
  const parts = parseHash('#inbox/augsd?q=a%20%26%20b&m=t0', { validMailbox: isMailbox });
  assert.deepEqual(parts, { mailbox: 'inbox', category: 'augsd', q: 'a & b', m: 't0' });
  assert.deepEqual(parseHash('', { validMailbox: isMailbox }),
    { mailbox: null, category: null, q: '', m: null },
    'an empty hash means the default view');
  assert.equal(parseHash('#downloads/augsd', { validMailbox: isMailbox }), null,
    'a foreign mailbox is not ours to interpret');
  assert.deepEqual(parseHash('#inbox?q=x', { validMailbox: isMailbox }).q, 'x',
    'a partial link still contributes what it has');
});

/* A fake shell + fake window/history, the same seam the harness uses. */
function fakeHarness() {
  const calls = [];
  const writes = [];
  const popstate = [];
  const loc = {
    hash: '', pathname: '/app.html', search: '',
    get href() { return `https://ext.test${this.pathname}${this.search}${this.hash}`; },
  };
  const fakeHistory = {
    pushState: (_s, _t, url) => { writes.push(['push', url]); loc.hash = new URL(url, loc.href).hash; },
    replaceState: (_s, _t, url) => { writes.push(['replace', url]); loc.hash = new URL(url, loc.href).hash; },
  };
  const fakeWindow = {
    location: loc,
    history: fakeHistory,
    addEventListener: (type, fn) => { if (type === 'popstate') popstate.push(fn); },
  };
  const saved = globalThis.window;
  globalThis.window = fakeWindow;
  const state = { mailbox: 'inbox', category: 'all', query: '', selected: null, data: new Set(['t0']) };
  const cbs = {
    snapshot: () => ({ ...state }),
    validMailbox: isMailbox,
    applyMailbox: (mb) => { calls.push(['mailbox', mb]); state.mailbox = mb; },
    applyCategory: (cat) => { calls.push(['category', cat]); state.category = cat; },
    applyQuery: (q) => { calls.push(['query', q]); state.query = q; },
    trySelect: (id) => {
      calls.push(['select', id]);
      if (!state.data.has(id)) return false;
      state.selected = id;
      return true;
    },
    hasSelection: () => Boolean(state.selected),
    closeMessage: () => { calls.push(['close']); state.selected = null; },
  };
  wireDeepLinks(cbs);
  return {
    calls, writes, popstate, state, loc, cbs,
    restore() {
      globalThis.window = saved;
      _resetDeepLinks();
    },
  };
}

test('push is for view navigation; mirrors only replace; identical writes are skipped', () => {
  const h = fakeHarness();
  try {
    h.state.category = 'augsd';
    navigateHash();
    assert.deepEqual(h.writes, [['push', '#inbox/augsd']], 'a deliberate switch earns an entry');
    navigateHash();
    assert.equal(h.writes.length, 1, 'the same view twice is one entry — Back must visibly work');
    h.state.selected = 't0';
    mirrorHash();
    assert.deepEqual(h.writes.at(-1), ['replace', '#inbox/augsd?m=t0'],
      'selection rides along WITHOUT an entry');
    assert.equal(h.writes.filter(([w]) => w === 'push').length, 1);
  } finally {
    h.restore();
  }
});

test('popstate applies mailbox, category, query, message — with echoes suppressed', () => {
  const h = fakeHarness();
  try {
    assert.equal(h.popstate.length, 1, 'one listener, even across rewires');
    wireDeepLinks(h.cbs); // a second bind against the same window must not stack
    assert.equal(h.popstate.length, 1);
    // Reach apply through the popstate path, as the browser delivers it.
    h.state.mailbox = 'trash'; h.state.category = 'all';
    h.loc.hash = '#inbox/augsd?q=hostel&m=t0';
    const writesBefore = h.writes.length;
    h.popstate[0]();
    assert.deepEqual(h.calls, [
      ['mailbox', 'inbox'],
      ['category', 'augsd'],
      ['query', 'hostel'],
      ['select', 't0'],
    ]);
    assert.equal(h.state.selected, 't0');
    // The hash was already canonical, so NOTHING was written at all — proof
    // the apply path itself never pushes: Back must not fight the march
    // forward.
    assert.equal(h.writes.length, writesBefore, 'a canonical apply earns no entry');

    // A PARTIAL hash canonicalizes through the mirror instead.
    h.state.category = 'augsd'; h.state.query = 'x'; h.state.selected = 't0';
    h.calls.length = 0;
    h.loc.hash = '#inbox';
    h.popstate[0]();
    assert.equal(h.writes.at(-1)[0], 'replace');
    assert.equal(h.writes.at(-1)[1], '#inbox/all', 'partial links land in canonical form');
  } finally {
    h.restore();
  }
});

test('a deep-linked message that has not landed LATCHES until its data arrives', () => {
  const h = fakeHarness();
  try {
    applyHash('#inbox/all?q=&m=t9');
    assert.equal(h.state.selected, null, 't9 is not synced yet');
    assert.deepEqual(h.calls.filter(([k]) => k === 'select'), [['select', 't9']]);
    h.state.data.add('t9'); // a sync lands
    checkPendingSelection();
    assert.equal(h.state.selected, 't9', 'the latch opened the moment data existed');
    // And a hash without m closes what is open.
    applyHash('#inbox/all');
    assert.deepEqual(h.calls.at(-1), ['close']);
  } finally {
    h.restore();
  }
});

test('the doctrine holds in source: one mirror seam, no stray history writes', () => {
  // The frame mirror is the ONLY continuous writer.
  const frame = appjs.match(/renderNotices\(\);([\s\S]*?)\n  \}\);/)[1];
  assert.match(frame, /checkPendingSelection\(\)/);
  assert.match(frame, /mirrorHash\(\)/);
  // Deliberate navigations push: category, mailbox, settled view queries.
  for (const fn of ['function selectCategory', 'async function selectMailbox', 'runQuery: (q) =>']) {
    const at = appjs.indexOf(fn);
    assert.ok(at !== -1, fn);
    const body = appjs.slice(at, at + 1600);
    assert.match(body, /navigateHash\(\)/, `${fn} pushes one history entry`);
  }
  // Nothing outside deep-links.js touches the History API directly.
  assert.ok(!/history\.(pushState|replaceState)/.test(appjs),
    'app.js must never write history directly — that is how j/k pollution starts');
  assert.ok(!/history\.(pushState|replaceState)/.test(read('src/app/list.js')) &&
            !/history\.(pushState|replaceState)/.test(read('src/app/reader.js')) &&
            !/history\.(pushState|replaceState)/.test(read('src/app/bulk.js')),
    'neither may list, reader or selection modules');
  // Boot applies the bar; sign-out strips it. window.location, NEVER bare
  // location — the harness shims window only, and the bare form once broke
  // boot behind the sign-in gate.
  assert.match(appjs, /await start\(\);\s*\n\s*\/\*[\s\S]*?applyHash\(window\.location\.hash\);/);
  assert.ok(!/[^.]location\.hash/.test(src.split('window.location').join('')),
    'deep-links reaches location only through window');
  assert.match(appjs, /stopAutoRefresh\(\);\s*\n\s*clearHash\(\)/);
  assert.match(src, /window\.addEventListener\('popstate'/);
});
