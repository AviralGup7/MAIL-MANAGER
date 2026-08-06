/**
 * End-to-end app tests in a real DOM.
 *
 * WHY THIS EXISTS
 * ---------------
 * Everything else in test/ is a unit test of a pure function. That is exactly
 * how v2 shipped three commits in which manifest.json and content.js both
 * referenced an `app.html` that did not exist: every unit test passed, and the
 * extension could not load.
 *
 * This boots the REAL app.html in jsdom with a stubbed `chrome.*` and a fake
 * service worker, then drives it the way a user would. It catches the class of
 * bug unit tests structurally cannot: wiring.
 *
 * jsdom is a devDependency loaded lazily — if it is not installed these tests
 * skip rather than fail, so `npm test` still works on a clean checkout.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  test('app integration (skipped: jsdom not installed)', { skip: true }, () => {});
}

/** Synthetic mail, deliberately spanning several BITS categories. */
const MESSAGES = [
  {
    id: 'm1', threadId: 't1',
    from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>',
    subject: 'Registration for Semester II',
    snippet: 'Course registration opens Monday.',
    date: Date.now() - 3600_000, unread: true, starred: false, labels: ['INBOX', 'UNREAD'],
  },
  {
    id: 'm2', threadId: 't2',
    from: 'Practice School Division <psd@pilani.bits-pilani.ac.in>',
    subject: 'PS-II station allotment',
    snippet: 'Confirm your preference within 48 hours.',
    date: Date.now() - 7200_000, unread: true, starred: false, labels: ['INBOX', 'UNREAD'],
  },
  {
    id: 'm3', threadId: 't3',
    from: 'GitHub <notifications@github.com>',
    subject: 'Run failed: CI on main',
    snippet: 'The workflow run failed. Unsubscribe from these notifications.',
    date: Date.now() - 10800_000, unread: false, starred: false, labels: ['INBOX'],
  },
];

/**
 * Boot app.html in jsdom.
 * Returns { win, doc, calls, settle } — `calls` records every worker message.
 */
async function boot({ signedIn = true, messages = MESSAGES, storageSeed = {} } = {}) {
  const html = readFileSync(join(ROOT, 'app.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'chrome-extension://test/app.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true, // gives us requestAnimationFrame
  });
  const { window: win } = dom;
  const calls = [];
  const storage = { ...storageSeed };

  win.chrome = {
    runtime: {
      id: 'test',
      lastError: null,
      openOptionsPage() {},
      sendMessage(msg, cb) {
        calls.push(msg);
        // Async, like the real thing — synchronous replies would hide
        // ordering bugs that only appear across a await boundary.
        setTimeout(() => cb(respond(msg)), 0);
      },
    },
    storage: {
      local: {
        async get(k) {
          if (Array.isArray(k)) {
            const o = {};
            for (const key of k) if (key in storage) o[key] = storage[key];
            return o;
          }
          if (typeof k === 'string') return k in storage ? { [k]: storage[k] } : {};
          return { ...storage };
        },
        async set(o) { Object.assign(storage, o); },
        async remove(k) { for (const key of [].concat(k)) delete storage[key]; },
      },
    },
  };

  function respond(msg) {
    switch (msg.type) {
      case 'AUTH_STATUS': return { ok: true, data: { signedIn } };
      case 'PROFILE': return { ok: true, data: { emailAddress: 'f20240294@pilani.bits-pilani.ac.in' } };
      case 'SYNC_PAGE':
        return { ok: true, data: { messages: msg.opts?.pageToken ? [] : messages, nextPageToken: '' } };
      case 'SYNC_DELTA':
        return { ok: true, data: { kind: 'delta', added: [], removed: [], patched: [] } };
      case 'GET_BODY':
        return { ok: true, data: { id: msg.id, html: '<p>body</p>', text: '', attachments: [] } };
      default: return { ok: true, data: {} };
    }
  }

  // jsdom has no matchMedia; app.css handles reduced motion, app.js does not
  // call it, but the store/classify modules must not trip over its absence.
  win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {} }));

  // Load the app as a real ES module graph, evaluated in the jsdom window.
  // We cannot use runScripts:'dangerously' with type=module in jsdom, so the
  // module is imported here and handed the window explicitly via globals.
  const prev = {};
  for (const k of ['window', 'document', 'chrome', 'requestAnimationFrame',
                   'cancelAnimationFrame', 'parent', 'setTimeout', 'clearTimeout',
                   'queueMicrotask', 'HTMLElement', 'Node']) {
    prev[k] = globalThis[k];
  }
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.chrome = win.chrome;
  globalThis.requestAnimationFrame = win.requestAnimationFrame.bind(win);
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Node = win.Node;
  globalThis.parent = win; // app.js posts BMM_READY to parent

  // Cache-bust so each boot gets a fresh module instance with its own Store.
  const url = pathToFileURL(join(ROOT, 'src/app/app.js')).href + `?t=${Math.random()}`;
  await import(url);

  const settle = async (frames = 4) => {
    for (let i = 0; i < frames; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => win.requestAnimationFrame(() => r()));
    }
  };
  await settle();

  return { win, doc: win.document, calls, storage, settle, restore: () => Object.assign(globalThis, prev) };
}

const rows = (doc) => [...doc.querySelectorAll('#list .row')];
const rowText = (doc) => rows(doc).map((r) => r.querySelector('.r-subj').textContent);

// --------------------------------------------------------------------------

test('app boots, signs in and renders the inbox', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, calls, restore } = await boot();
  try {
    assert.equal(doc.getElementById('gate').hidden, true, 'gate should be hidden when signed in');
    assert.equal(rows(doc).length, 3, 'all three messages should render');
    assert.ok(calls.some((c) => c.type === 'AUTH_STATUS'));
    assert.ok(calls.some((c) => c.type === 'SYNC_PAGE'));
  } finally {
    restore();
  }
});

test('messages are classified and tagged, newest first', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, restore } = await boot();
  try {
    // Newest first: m1 (1h) before m2 (2h) before m3 (3h).
    assert.deepEqual(rowText(doc), [
      'Registration for Semester II',
      'PS-II station allotment',
      'Run failed: CI on main',
    ]);
    const tags = rows(doc).map((r) => r.querySelector('.tag').textContent);
    assert.equal(tags[0], 'AUGSD');
    assert.equal(tags[1], 'Practice School');
    // Regression: the bare substring 'unsubscribe' used to send every GitHub
    // notification to Ext Promotions.
    assert.equal(tags[2], 'Ext Services', 'GitHub must not be a promotion');
  } finally {
    restore();
  }
});

test('the sidebar shows a live per-category unread count', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, restore } = await boot();
  try {
    const byCat = {};
    for (const b of doc.querySelectorAll('#cats .cat')) {
      byCat[b.dataset.cat] = b.lastElementChild.textContent;
    }
    assert.equal(byCat.all, '2', 'two unread overall');
    assert.equal(byCat.augsd, '1');
    assert.equal(byCat.ps, '1');
    assert.equal(byCat['external-services'], '1');
  } finally {
    restore();
  }
});

test('clicking a category filters the list', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, restore } = await boot();
  try {
    doc.querySelector('#cats .cat[data-cat="augsd"]').click();
    await settle();
    assert.deepEqual(rowText(doc), ['Registration for Semester II']);
    doc.querySelector('#cats .cat[data-cat="all"]').click();
    await settle();
    assert.equal(rows(doc).length, 3);
  } finally {
    restore();
  }
});

test('search filters by subject and by sender, and clears', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    const search = doc.getElementById('search');

    search.value = 'allotment';
    search.dispatchEvent(new win.Event('input'));
    await settle();
    assert.deepEqual(rowText(doc), ['PS-II station allotment']);

    // Sender local-part is indexed separately, so this must hit.
    search.value = 'augsd';
    search.dispatchEvent(new win.Event('input'));
    await settle();
    assert.deepEqual(rowText(doc), ['Registration for Semester II']);

    search.value = '';
    search.dispatchEvent(new win.Event('input'));
    await settle();
    assert.equal(rows(doc).length, 3);
  } finally {
    restore();
  }
});

test('opening a message shows it and optimistically marks it read', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, calls, settle, restore } = await boot();
  try {
    const first = rows(doc)[0];
    assert.ok(first.classList.contains('unread'));

    first.click();
    await settle();

    assert.equal(doc.getElementById('reader').hidden, false);
    assert.equal(doc.getElementById('r-subject').textContent, 'Registration for Semester II');
    // Optimistic: the row is already read, before the worker replied.
    assert.ok(!rows(doc)[0].classList.contains('unread'), 'row should be read immediately');
    assert.ok(calls.some((c) => c.type === 'MARK_READ' && c.id === 'm1'));
    assert.ok(calls.some((c) => c.type === 'GET_BODY' && c.id === 'm1'));
  } finally {
    restore();
  }
});

test('the star button toggles without waiting for the network', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, calls, settle, restore } = await boot();
  try {
    const star = rows(doc)[0].querySelector('.r-star');
    assert.equal(star.getAttribute('aria-pressed'), 'false');

    star.click();
    await settle();

    assert.equal(rows(doc)[0].querySelector('.r-star').getAttribute('aria-pressed'), 'true');
    const call = calls.find((c) => c.type === 'STAR');
    assert.deepEqual({ id: call.id, on: call.on }, { id: 'm1', on: true });
  } finally {
    restore();
  }
});

test('archiving removes the row and selects a neighbour', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, calls, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle();

    doc.querySelector('#r-actions button[data-act="archive"]').click();
    await settle();

    assert.equal(rows(doc).length, 2, 'archived row should be gone');
    assert.ok(!rowText(doc).includes('Registration for Semester II'));
    assert.ok(calls.some((c) => c.type === 'ARCHIVE' && c.id === 'm1'));
    // The reading pane should have moved on, not gone blank.
    assert.equal(doc.getElementById('r-subject').textContent, 'PS-II station allotment');
  } finally {
    restore();
  }
});

test('j/k move the selection and Escape closes the reader', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    const key = (k) => {
      doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }));
      return settle();
    };

    await key('j');
    assert.equal(doc.getElementById('r-subject').textContent, 'Registration for Semester II');

    await key('j');
    assert.equal(doc.getElementById('r-subject').textContent, 'PS-II station allotment');

    await key('k');
    assert.equal(doc.getElementById('r-subject').textContent, 'Registration for Semester II');

    await key('Escape');
    assert.equal(doc.getElementById('reader').hidden, true, 'Escape should close the reader');
  } finally {
    restore();
  }
});

test('the signed-out gate appears instead of the list', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, calls, restore } = await boot({ signedIn: false });
  try {
    assert.equal(doc.getElementById('gate').hidden, false);
    assert.equal(rows(doc).length, 0);
    assert.ok(!calls.some((c) => c.type === 'SYNC_PAGE'), 'must not sync while signed out');
  } finally {
    restore();
  }
});

test('an empty inbox shows the empty state rather than a blank pane', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, restore } = await boot({ messages: [] });
  try {
    assert.equal(rows(doc).length, 0);
    assert.equal(doc.getElementById('empty').hidden, false);
  } finally {
    restore();
  }
});

test('the app tells the content script it has painted', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // If BMM_READY never fires, the takeover animation waits out its 2s timeout
  // and the handover looks broken.
  const html = readFileSync(join(ROOT, 'app.html'), 'utf8');
  assert.ok(
    readFileSync(join(ROOT, 'src/app/app.js'), 'utf8').includes("postMessage({ type: 'BMM_READY' }"),
    'app.js must post BMM_READY to its parent'
  );
  assert.ok(html.includes('app.js'));
});

// -------------------------------------------- no cap on rendered rows ------

/** Build N synthetic messages, newest first. */
function bulk(n, over = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: `b${i}`,
    threadId: `bt${i}`,
    from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>',
    subject: `Bulk message ${i}`,
    snippet: 'x',
    date: Date.now() - i * 60_000,
    unread: false,
    starred: false,
    labels: ['INBOX'],
    ...over,
  }));
}

test('REGRESSION: every message renders — there is no 400-row cap', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // renderedIds is what j/k and archive-neighbour walk, so a truncated render
  // made rows 401+ unreachable by scroll, click AND keyboard, while the
  // sidebar still counted them.
  const { doc, restore } = await boot({ messages: bulk(600) });
  try {
    assert.equal(rows(doc).length, 600, 'all 600 rows must be in the DOM');
    // The last row is real and openable, not a placeholder.
    const last = rows(doc)[599];
    assert.equal(last.dataset.id, 'b599');
    assert.equal(last.querySelector('.r-subj').textContent, 'Bulk message 599');
  } finally {
    restore();
  }
});

test('REGRESSION: the count reads the whole truth, not "400 of 600"', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, restore } = await boot({ messages: bulk(600) });
  try {
    assert.equal(doc.getElementById('listcount').textContent, '600');
  } finally {
    restore();
  }
});

test('REGRESSION: a message past row 400 is reachable by keyboard', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot({ messages: bulk(450) });
  try {
    // Select the row that the old cap made unreachable, then confirm j/k can
    // actually move onto and off it.
    rows(doc)[430].click();
    await settle();
    assert.equal(doc.getElementById('r-subject').textContent, 'Bulk message 430');

    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    await settle();
    assert.equal(doc.getElementById('r-subject').textContent, 'Bulk message 431');

    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'k', bubbles: true }));
    await settle();
    assert.equal(doc.getElementById('r-subject').textContent, 'Bulk message 430');
  } finally {
    restore();
  }
});

// ------------------------------------------- the core render invariant -----

test('INVARIANT: one store notification and one render per sync', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The single most important property in the codebase, previously enforced by
  // convention only. bench.mjs PRINTED "renders triggered: 1" but did not
  // assert it, so a regression to per-mutation rendering -- the exact defect
  // that made v1 unusable -- would have passed green.
  //
  // BOTH halves are asserted, because each hides the other:
  //   - DOM writes alone pass even when the store is mutated unbatched,
  //     because the rAF coalescer collapses the notifications anyway. Verified
  //     by sabotaging upsertMany into a per-message loop: the DOM assertion
  //     still passed.
  //   - Notifications alone would not catch a render loop that writes twice
  //     for one notification.
  const { win, doc, restore } = await boot({ messages: [] });
  try {
    const list = doc.getElementById('list');
    let domWrites = 0;
    const obs = new win.MutationObserver(() => domWrites++);
    obs.observe(list, { childList: true });

    let notifications = 0;
    const unsub = win.__bmmStore.subscribe(() => notifications++);

    win.__bmmIngest(bulk(200));
    await new Promise((r) => win.requestAnimationFrame(() => r()));
    await new Promise((r) => setTimeout(r, 0));
    obs.disconnect();
    unsub();

    assert.equal(rows(doc).length, 200, 'all 200 must be rendered');
    assert.equal(notifications, 1, `store must notify once, got ${notifications}`);
    assert.equal(domWrites, 1, `list must be written once, got ${domWrites}`);
  } finally {
    restore();
  }
});

// ------------------------------------------------------ cache-first boot ---

/** Build the on-disk blob shape that cache.js writes. */
function cacheBlob(msgs) {
  return {
    v: 1,
    t: Date.now(),
    m: msgs.map((m) => [
      m.id, m.threadId, m.from, m.subject, m.snippet, m.date,
      (m.unread ? 1 : 0) | (m.starred ? 2 : 0),
      m.category || 'augsd', m.confidence ?? 0.9, m.source || 'sender', m.reason || '',
    ]),
  };
}

test('CACHE: a warm start paints from disk and asks only for a delta', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Before this, every takeover cold-fetched ~100 messages and the historyId
  // cursor had no local state to be a delta against, which made the whole
  // History API integration decorative.
  const cached = bulk(40).map((m) => ({ ...m, category: 'augsd', confidence: 0.9 }));
  const { doc, calls, restore } = await boot({
    messages: [],
    storageSeed: { msgCache: cacheBlob(cached), historyId: '12345' },
  });
  try {
    assert.equal(rows(doc).length, 40, 'cached rows must be on screen');
    assert.ok(calls.some((c) => c.type === 'SYNC_DELTA'), 'must ask for a delta');
    assert.ok(
      !calls.some((c) => c.type === 'SYNC_PAGE'),
      'must NOT cold-fetch a full page when the cache served'
    );
  } finally {
    restore();
  }
});

test('CACHE: a cold start with no cache still full-syncs', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, calls, restore } = await boot({ messages: MESSAGES });
  try {
    assert.equal(rows(doc).length, 3);
    assert.ok(calls.some((c) => c.type === 'SYNC_PAGE'), 'no cache means a full page');
  } finally {
    restore();
  }
});

test('CACHE: a corrupt cache falls back to a full sync, not a blank inbox', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, calls, restore } = await boot({
    messages: MESSAGES,
    storageSeed: { msgCache: { v: 99, m: 'garbage' } },
  });
  try {
    assert.equal(rows(doc).length, 3, 'must recover with a network sync');
    assert.ok(calls.some((c) => c.type === 'SYNC_PAGE'));
  } finally {
    restore();
  }
});

test('CACHE: the inbox is written to disk after a sync', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { win, storage, restore } = await boot({ messages: MESSAGES });
  try {
    // The saver defers to idle; give it room, then force the write the way
    // closing the takeover does.
    await new Promise((r) => win.setTimeout(r, 120));
    const blob = storage.msgCache;
    assert.ok(blob, 'a cache blob must exist after a sync');
    assert.equal(blob.v, 1);
    assert.equal(blob.m.length, 3);
    assert.equal(blob.m[0][0], 'm1', 'newest first');
  } finally {
    restore();
  }
});

test('CACHE: signing out erases the cached mailbox', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Otherwise the next person to open the extension sees the previous
  // account's inbox painted from cache before the gate appears.
  const { doc, win, storage, settle, restore } = await boot({
    messages: [],
    storageSeed: { msgCache: cacheBlob(bulk(10)) },
  });
  try {
    assert.equal(rows(doc).length, 10);
    doc.getElementById('btn-signout').click();
    await settle();
    await new Promise((r) => win.setTimeout(r, 50));

    assert.equal(storage.msgCache, undefined, 'cache must be gone');
    assert.equal(rows(doc).length, 0, 'and the list cleared');
    assert.equal(doc.getElementById('gate').hidden, false);
  } finally {
    restore();
  }
});

// ------------------------------------------------------------ a11y --------

test('A11Y: the listbox owns its options directly', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // This was `div role="listbox" > ul > li role="option"`. An intervening
  // `list` breaks ARIA ownership, so screen readers announced the message
  // list -- the central UI of the app -- as empty.
  const { doc, restore } = await boot();
  try {
    const listbox = doc.querySelector('[role="listbox"]');
    assert.ok(listbox, 'a listbox must exist');
    assert.equal(listbox.id, 'list');

    const options = [...doc.querySelectorAll('[role="option"]')];
    assert.equal(options.length, 3);
    for (const opt of options) {
      assert.equal(
        opt.parentElement,
        listbox,
        'every option must be a DIRECT child of the listbox'
      );
    }
    // Nothing may sit between them.
    assert.equal(doc.querySelector('#list ul'), null, 'no list wrapper');
    assert.equal(doc.querySelector('#list li'), null, 'no list items');
  } finally {
    restore();
  }
});

test('A11Y: the listbox is the tab stop and tracks the active option', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // aria-activedescendant is only meaningful on the focused element, so the
  // tab stop must be the listbox itself, not the scroll container.
  const { doc, settle, restore } = await boot();
  try {
    const listbox = doc.getElementById('list');
    assert.equal(listbox.getAttribute('tabindex'), '0');
    assert.equal(doc.getElementById('scroller').hasAttribute('tabindex'), false);
    assert.equal(listbox.hasAttribute('aria-activedescendant'), false, 'nothing selected yet');

    rows(doc)[1].click();
    await settle();

    const active = listbox.getAttribute('aria-activedescendant');
    assert.ok(active, 'must point at the open row');
    const target = doc.getElementById(active);
    assert.ok(target, `aria-activedescendant must reference a real element, got "${active}"`);
    assert.equal(target.getAttribute('aria-selected'), 'true');
    assert.equal(target.dataset.id, 'm2');
  } finally {
    restore();
  }
});

test('A11Y: activedescendant follows j/k and clears on close', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    const listbox = doc.getElementById('list');
    const key = (k) => {
      doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }));
      return settle();
    };

    await key('j');
    assert.equal(doc.getElementById(listbox.getAttribute('aria-activedescendant')).dataset.id, 'm1');
    await key('j');
    assert.equal(doc.getElementById(listbox.getAttribute('aria-activedescendant')).dataset.id, 'm2');

    await key('Escape');
    assert.equal(
      listbox.hasAttribute('aria-activedescendant'),
      false,
      'closing the reader must clear the active option'
    );
  } finally {
    restore();
  }
});

test('A11Y: exactly one option is aria-selected at a time', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, restore } = await boot();
  try {
    const selected = () => [...doc.querySelectorAll('[role="option"][aria-selected="true"]')];
    assert.equal(selected().length, 0);
    rows(doc)[0].click();
    await settle();
    assert.equal(selected().length, 1);
    rows(doc)[2].click();
    await settle();
    assert.equal(selected().length, 1, 'the previous row must be deselected');
    assert.equal(selected()[0].dataset.id, 'm3');
  } finally {
    restore();
  }
});

test('A11Y: the reading pane is not a live region', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // aria-live on the whole pane announced the subject, sender, date, every tag
  // chip and the action buttons on each open.
  const { doc, restore } = await boot();
  try {
    assert.equal(doc.getElementById('readpane').hasAttribute('aria-live'), false);
    const reader = doc.getElementById('reader');
    assert.equal(reader.getAttribute('role'), 'article');
    assert.equal(reader.getAttribute('aria-labelledby'), 'r-subject');
    // The toast IS a live region, and correctly scoped to transient text.
    assert.equal(doc.getElementById('toast').getAttribute('aria-live'), 'polite');
  } finally {
    restore();
  }
});

test('A11Y: every row id is unique and references resolve', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, restore } = await boot({ messages: bulk(50) });
  try {
    const ids = [...doc.querySelectorAll('[role="option"]')].map((n) => n.id);
    assert.equal(ids.length, 50);
    assert.equal(new Set(ids).size, 50, 'row DOM ids must be unique');
    assert.ok(ids.every((i) => i.startsWith('bmm-')), 'namespaced so Gmail ids cannot collide');
  } finally {
    restore();
  }
});

// ------------------------------------------------------------- themes -----

test('THEME: the picker lists every theme and marks the current one', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, restore } = await boot();
  try {
    const { THEMES } = await import('../src/app/themes.js');
    doc.getElementById('btn-theme').click();
    await settle();

    const items = [...doc.querySelectorAll('.theme-item')];
    assert.equal(items.length, THEMES.length, 'every theme must be offered');
    assert.equal(
      items.filter((i) => i.getAttribute('aria-checked') === 'true').length,
      1,
      'exactly one theme is current'
    );
    assert.equal(doc.getElementById('btn-theme').getAttribute('aria-expanded'), 'true');
  } finally {
    restore();
  }
});

test('THEME: choosing one applies it and persists the choice', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, storage, settle, restore } = await boot();
  try {
    doc.getElementById('btn-theme').click();
    await settle();
    doc.querySelector('.theme-item[data-theme="pilani"]').click();
    await settle();

    const root = doc.documentElement;
    assert.equal(root.dataset.theme, 'pilani');
    assert.equal(root.dataset.scheme, 'dark', 'scheme drives native controls');
    assert.equal(storage.theme, 'pilani', 'the choice must survive a reload');
    assert.ok(root.style.getPropertyValue('--bg'), 'custom properties are written');
    assert.equal(doc.getElementById('thememenu').hidden, true, 'menu closes after choosing');
  } finally {
    restore();
  }
});

test('THEME: a saved theme is applied at boot', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, restore } = await boot({ storageSeed: { theme: 'nord' } });
  try {
    assert.equal(doc.documentElement.dataset.theme, 'nord');
    assert.equal(doc.documentElement.dataset.scheme, 'dark');
  } finally {
    restore();
  }
});

test('THEME: a stored value from the old binary toggle falls back cleanly', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Before the picker existed, this key held 'light' or 'dark'. Those are not
  // theme ids, and an unknown id must not leave the app unstyled.
  const { doc, restore } = await boot({ storageSeed: { theme: 'dark' } });
  try {
    assert.equal(doc.documentElement.dataset.theme, 'daylight');
    assert.ok(doc.documentElement.style.getPropertyValue('--bg'));
  } finally {
    restore();
  }
});

test('THEME: the menu is keyboard operable and Escape closes it', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    const btn = doc.getElementById('btn-theme');
    const menu = doc.getElementById('thememenu');
    btn.click();
    await settle();

    // Focus lands on the current theme, not the top of the list.
    assert.equal(doc.activeElement.getAttribute('aria-checked'), 'true');

    menu.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle();
    assert.ok(doc.activeElement.classList.contains('theme-item'));

    menu.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    assert.equal(menu.hidden, true);
    assert.equal(doc.activeElement.id, 'btn-theme', 'focus returns to the trigger');
  } finally {
    restore();
  }
});

test('THEME: switching theme re-renders the open message body', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The body iframe is a separate document with its colours baked into
  // srcdoc, so it cannot follow a custom-property change.
  const { doc, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle();
    const before = doc.getElementById('r-body').getAttribute('srcdoc');
    assert.ok(before, 'a body must be rendered');

    doc.getElementById('btn-theme').click();
    await settle();
    doc.querySelector('.theme-item[data-theme="midnight"]').click();
    await settle();

    const after = doc.getElementById('r-body').getAttribute('srcdoc');
    assert.notEqual(after, before, 'the body must be re-rendered for the new palette');
    assert.ok(after.includes('color-scheme:dark'), 'and pick up the dark scheme');
  } finally {
    restore();
  }
});

// ------------------------------------------------ contextual toolbar ------

test('CTX: message actions appear only when a message is open', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Archive/star/delete belong to a MESSAGE. A permanently visible row of
  // disabled buttons teaches nothing and occupies the most valuable strip of
  // the window; actions that arrive with their subject teach themselves.
  const { doc, settle, restore } = await boot();
  try {
    assert.equal(doc.getElementById('ctx-actions').hidden, true, 'hidden with nothing open');

    rows(doc)[0].click();
    await settle();
    assert.equal(doc.getElementById('ctx-actions').hidden, false, 'shown when a message opens');
    assert.equal(
      doc.querySelectorAll('#ctx-actions button svg').length,
      3,
      'archive, star and delete, each a real icon'
    );

    doc.dispatchEvent(new (doc.defaultView.KeyboardEvent)('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    assert.equal(doc.getElementById('ctx-actions').hidden, true, 'hidden again on close');
  } finally {
    restore();
  }
});

test('CTX: the star reflects reality on BOTH surfaces', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The same message is starrable from the row and from the toolbar. If the
  // two disagree the user cannot tell whether pressing will star or unstar.
  const { doc, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle();

    doc.getElementById('ctx-star').click();
    await settle();

    const ctxStar = doc.getElementById('ctx-star');
    const rowStar = doc.querySelector('.row[aria-selected="true"] .r-star');
    assert.equal(ctxStar.getAttribute('aria-pressed'), 'true');
    assert.equal(rowStar.getAttribute('aria-pressed'), 'true', 'the row must agree');
    assert.equal(ctxStar.getAttribute('aria-label'), 'Unstar', 'the label must say what it will do');
  } finally {
    restore();
  }
});

test('CTX: archive from the toolbar removes the row', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle();
    const before = rows(doc).length;

    doc.getElementById('ctx-archive').click();
    await settle();

    assert.equal(rows(doc).length, before - 1);
  } finally {
    restore();
  }
});

// -------------------------------------------------- keyboard traversal ----

test('A11Y: the tab order is constant, not proportional to message count', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // MEASURED KEYBOARD TRAP: every row's star was a tab stop. With 20 messages
  // that is 44 stops; at the 2000-message cap it is ~2024, so a keyboard user
  // pressing Tab from the sidebar to the reader would press it two thousand
  // times.
  //
  // ARIA authoring practice: a listbox is ONE stop, and movement inside is by
  // arrow keys — which this app already had via j/k and aria-activedescendant.
  const visible = (el, doc) => {
    for (let n = el; n && n !== doc.body; n = n.parentElement) if (n.hidden) return false;
    return true;
  };
  const stops = (doc) =>
    [...doc.querySelectorAll('a[href],button,input,textarea,select,[tabindex]')]
      .filter((e) => visible(e, doc) && e.tabIndex >= 0);

  const small = await boot({ messages: MESSAGES });
  const nSmall = stops(small.doc).length;
  small.restore();

  const large = await boot({ messages: bulk(200) });
  const nLarge = stops(large.doc).length;
  try {
    assert.equal(
      stops(large.doc).filter((e) => e.classList.contains('r-star')).length,
      0,
      'row stars must not be tab stops'
    );
    assert.ok(
      Math.abs(nLarge - nSmall) <= 1,
      `tab stops scale with message count: ${nSmall} for 3 vs ${nLarge} for 200`
    );
    assert.ok(nLarge < 20, `expected a small constant number of stops, got ${nLarge}`);
  } finally {
    large.restore();
  }
});

test('A11Y: the sidebar is one tab stop with arrow-key movement', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Roving tabindex. Sixteen categories were sixteen stops; a nav list should
  // be one. The arrow handler is the other half of the pattern — without it
  // the non-current categories become unreachable by keyboard entirely, which
  // is a worse bug than the stops it replaced.
  const { doc, win, settle, restore } = await boot();
  try {
    const cats = [...doc.getElementById('cats').children];
    assert.equal(cats.filter((c) => c.tabIndex === 0).length, 1, 'exactly one tabbable category');

    cats[0].focus();
    const fire = (key) =>
      doc.getElementById('cats').dispatchEvent(
        new win.KeyboardEvent('keydown', { key, bubbles: true })
      );

    fire('ArrowDown');
    await settle();
    assert.equal(doc.activeElement, cats[1], 'ArrowDown moves focus');

    fire('End');
    await settle();
    assert.equal(doc.activeElement, cats[cats.length - 1], 'End jumps to the last');

    fire('Home');
    await settle();
    assert.equal(doc.activeElement, cats[0], 'Home jumps to the first');

    // Focus movement must NOT select — that would render on every keypress and
    // fight the user as they scan.
    assert.equal(cats[0].getAttribute('aria-current'), 'true', 'arrows move focus, not selection');
  } finally {
    restore();
  }
});

test('A11Y: the star is still operable by keyboard after leaving the tab order', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Removing a tab stop is only correct if the action survives another way.
  const { doc, win, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle();
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 's', bubbles: true }));
    await settle();
    assert.equal(
      doc.querySelector('.row[aria-selected="true"] .r-star').getAttribute('aria-pressed'),
      'true'
    );
  } finally {
    restore();
  }
});

test('A11Y: truncated row text carries the full value in a title', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Institutional subjects are long and clip well before the useful part.
  // Without a title a clipped subject is simply unreadable, and the row shows
  // only a display name when the address is often what the user is checking.
  const { doc, restore } = await boot();
  try {
    for (const row of rows(doc)) {
      const subj = row.querySelector('.r-subj');
      const from = row.querySelector('.r-from');
      assert.equal(subj.getAttribute('title'), subj.textContent, 'subject title must be the full text');
      assert.ok(from.getAttribute('title')?.includes('@'), 'sender title must carry the address');
    }
  } finally {
    restore();
  }
});

// ------------------------------------------------------- multi-select ----

const pick = (row, win, opts = {}) =>
  (opts.shiftKey || opts.ctrlKey ? row : row.querySelector('.r-pick'))
    .dispatchEvent(new win.MouseEvent('click', { bubbles: true, ...opts }));

test('BULK: ticking a row selects without opening it', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Conflating selection with the open message means ticking twelve boxes
  // marks twelve messages read — the opposite of what a triage pass wants.
  const { doc, win, settle, restore } = await boot();
  try {
    assert.equal(doc.getElementById('bulkbar').hidden, true, 'no bar at rest');

    pick(rows(doc)[0], win);
    await settle();

    assert.equal(doc.getElementById('bulkbar').hidden, false);
    assert.equal(doc.getElementById('listhead').hidden, true, 'the bar REPLACES the header');
    assert.equal(doc.getElementById('bulk-count').textContent, '1 selected');
    assert.equal(doc.getElementById('reader').hidden, true, 'must not open the message');
  } finally {
    restore();
  }
});

test('BULK: shift-click selects a contiguous range', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Selecting 30 consecutive promotions one click at a time is the exact
  // drudgery this feature exists to remove.
  const { doc, win, settle, restore } = await boot({ messages: bulk(10) });
  try {
    pick(rows(doc)[1], win);
    await settle();
    pick(rows(doc)[5], win, { shiftKey: true });
    await settle();

    assert.equal(doc.getElementById('bulk-count').textContent, '5 selected');
    assert.equal(doc.querySelectorAll('.row.picked').length, 5);
  } finally {
    restore();
  }
});

test('BULK: select-all is tri-state and honest', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // A checkbox reading "checked" while half the list is selected is a lie.
  const { doc, win, settle, restore } = await boot({ messages: bulk(6) });
  try {
    pick(rows(doc)[0], win);
    await settle();
    const all = doc.getElementById('bulk-all');
    assert.equal(all.indeterminate, true, 'partial selection must be indeterminate');
    assert.equal(all.checked, false);

    all.checked = true;
    all.dispatchEvent(new win.Event('change'));
    await settle();
    assert.equal(doc.getElementById('bulk-count').textContent, '6 selected');
    assert.equal(doc.getElementById('bulk-all').indeterminate, false);
  } finally {
    restore();
  }
});

test('BULK: archiving many undoes as ONE step', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Forty separate undos would be unusable. This is the whole reason
  // UndoStack stores a thunk rather than a diff.
  const { doc, win, settle, restore } = await boot({ messages: bulk(8) });
  try {
    for (const i of [0, 1, 2]) pick(rows(doc)[i], win);
    await settle();

    doc.getElementById('bulk-archive').click();
    await settle();
    await settle();
    assert.equal(rows(doc).length, 5, 'three removed');
    assert.match(doc.getElementById('toast').textContent, /Archived 3 messages/);

    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await settle();
    await settle();
    assert.equal(rows(doc).length, 8, 'one undo restores all three');
  } finally {
    restore();
  }
});

test('BULK: Escape clears the selection before anything else', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Selection is the innermost transient state, so it unwinds first —
  // Escape must not release the takeover while a selection is pending.
  const { doc, win, settle, restore } = await boot();
  try {
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    await settle();
    assert.equal(doc.getElementById('bulkbar').hidden, false, 'x ticks a row');

    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    assert.equal(doc.getElementById('bulkbar').hidden, true);
  } finally {
    restore();
  }
});

test('BULK: selection survives a re-render', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Selection lives outside the store, so a delta arriving mid-triage must
  // not silently drop the ticks the user has already placed.
  const { doc, win, settle, restore } = await boot({ messages: bulk(6) });
  try {
    pick(rows(doc)[0], win);
    pick(rows(doc)[1], win);
    await settle();
    assert.equal(doc.querySelectorAll('.row.picked').length, 2);

    win.__bmmIngest(bulk(2).map((m) => ({ ...m, id: `new${m.id}`, subject: 'arrived later' })));
    await settle();

    assert.equal(doc.querySelectorAll('.row.picked').length, 2, 'ticks must survive');
    assert.equal(doc.getElementById('bulk-count').textContent, '2 selected');
  } finally {
    restore();
  }
});
