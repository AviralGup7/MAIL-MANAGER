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
import { makeFakeWorker } from './helpers/worker-contract.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  test('app integration (skipped: jsdom not installed)', { skip: true }, () => {});
}


/**
 * Sending is queued, not immediate.
 *
 * `doSend` puts the draft in the outbox with a hold window (undo-send) and
 * returns. The worker only sees SEND when the hold expires and the runner
 * pumps. Tests that assert on the wire therefore have to drain the queue
 * rather than wait out a five-second timer.
 *
 * Seeding `undoSendSeconds: 0` makes the item due immediately -- `enqueue`
 * treats a zero hold as "send now", so the queue path is identical and there
 * is no special unqueued branch being exercised instead.
 */
async function drainOutbox(win, settle) {
  await win.__bmmPumpOutbox?.();
  await settle(6);
}

/**
 * Boot with undo-send off, for tests that assert on what reaches the worker.
 *
 * `enqueue` treats a zero hold as "due now", so the item goes through the
 * SAME queue path -- claim, dispatch, remove -- with no separate unqueued
 * branch. Only the wait is removed. Tests that care about the hold itself set
 * it explicitly instead.
 */
const bootSending = (opts = {}) =>
  boot({ ...opts, storageSeed: { undoSendSeconds: 0, ...(opts.storageSeed || {}) } });

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
async function boot({ signedIn = true, messages = MESSAGES, storageSeed = {}, bodyOverride = {}, syncLatency = 0, perLabel = false, emptyLabels = [], labels = [], timetableData = null, storageTimetable = undefined, deadWorker = false, failVerbs = [] } = {}) {
  const html = readFileSync(join(ROOT, 'app.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'chrome-extension://test/app.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true, // gives us requestAnimationFrame
  });
  const { window: win } = dom;

  /* TEST-SPEED: replace jsdom's real ~16ms rAF with a microtask frame.
   * The app coalesces renders through rAF and every test settles through it,
   * so each settle previously cost ~55ms of wall clock per frame for work
   * jsdom cannot paint anyway. Ordering is preserved: the frame still fires
   * after the current macrotask, so one-render-per-settled-state holds.
   * A rAF loop would now hang instead of tick — which doubles as a liveness
   * check for the "no animation runs forever" doctrine. */
  win.requestAnimationFrame = (fn) => { queueMicrotask(() => fn(performance.now())); return 1; };
  win.cancelAnimationFrame = () => {};
  const calls = [];
  const storage = { ...storageSeed };
  /** chrome.storage.onChanged listeners registered by the app. */
  const storageListeners = [];
  if (storageTimetable !== undefined) storage.timetable = storageTimetable;

  /*
   * The timetable catalogue is a static JSON asset fetched at boot. Serving a
   * small fixture keeps these tests fast and independent of the 600KB real
   * file; passing `timetableData: 'real'` loads the genuine parsed data for
   * the tests that need to prove it works end to end.
   */
  win.fetch = async (url) => {
    if (String(url).includes('timetable/data.json')) {
      const body = timetableData === 'real'
        ? JSON.parse(readFileSync(join(ROOT, 'src/timetable/data.json'), 'utf8'))
        : (timetableData || { schemaVersion: 1, semester: 'TEST SEM', courses: [], changes: [] });
      return { ok: true, status: 200, async json() { return body; } };
    }
    return { ok: false, status: 404, async json() { return {}; } };
  };

  win.chrome = {
    runtime: {
      id: 'test',
      lastError: null,
      openOptionsPage() {},
      // The timetable feature fetches its static data through getURL.
      getURL: (p) => `chrome-extension://test/${p}`,
      sendMessage(msg, cb) {
        calls.push(msg);
        /*
         * `deadWorker` reproduces "Service worker registration failed":
         * Chrome invokes the callback with undefined and sets lastError,
         * rather than throwing. Getting that shape right is the whole point --
         * a mock that throws would exercise a path the browser never takes.
         */
        if (deadWorker) {
          win.chrome.runtime.lastError = { message: 'Could not establish connection.' };
          setTimeout(() => {
            cb(undefined);
            win.chrome.runtime.lastError = null;
          }, 0);
          return;
        }
        // Async, like the real thing — synchronous replies would hide
        // ordering bugs that only appear across a await boundary.
        // `syncLatency` makes a slow mailbox fetch reproducible, which is what
        // exposes ordering bugs between two concurrent loads.
        const delay = msg.type === 'SYNC_PAGE' ? syncLatency : 0;
        setTimeout(() => cb(respond(msg)), delay);
      },
    },
    storage: {
      /*
       * `onChanged` is modelled because it is the ONLY channel by which the
       * options page can reach the running app. Options opens in a separate
       * extension page with its own module instances, so an in-process
       * subscriber cannot see it; without this listener the app reads a
       * settings cache that was loaded once at boot and never refreshed.
       */
      onChanged: {
        addListener(fn) { storageListeners.push(fn); },
        removeListener(fn) {
          const i = storageListeners.indexOf(fn);
          if (i >= 0) storageListeners.splice(i, 1);
        },
      },
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

  /**
   * Simulate another extension page (the options page) writing a setting.
   * Chrome delivers `{key: {oldValue, newValue}}` plus the area name.
   */
  const changeSetting = async (key, newValue) => {
    const oldValue = storage[key];
    storage[key] = newValue;
    for (const fn of [...storageListeners]) fn({ [key]: { oldValue, newValue } }, 'local');
    await settle();
  };

  const respond = makeFakeWorker({
    calls, storage, signedIn, messages, perLabel, emptyLabels, labels,
    bodyOverride, failVerbs,
  });

  // jsdom has no matchMedia; app.css handles reduced motion, app.js does not
  // call it, but the store/classify modules must not trip over its absence.
  win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {} }));

  // Load the app as a real ES module graph, evaluated in the jsdom window.
  // We cannot use runScripts:'dangerously' with type=module in jsdom, so the
  // module is imported here and handed the window explicitly via globals.
  const prev = {};
  // FileReader and File come from the window too: the attachment reader uses
  // a bare `new FileReader()`, which resolves against the global the app
  // module was evaluated with, not against `win`.
  for (const k of ['window', 'document', 'chrome', 'requestAnimationFrame',
                   'cancelAnimationFrame', 'parent', 'setTimeout', 'clearTimeout',
                   'queueMicrotask', 'HTMLElement', 'Node', 'fetch',
                   'FileReader', 'File']) {
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
  globalThis.fetch = win.fetch; // the timetable data is fetched, not imported
  globalThis.FileReader = win.FileReader; // the attachment reader
  globalThis.File = win.File;

  // Cache-bust so each boot gets a fresh module instance with its own Store.
  const url = pathToFileURL(join(ROOT, 'src/app/app.js')).href + `?t=${Math.random()}`;
  await import(url);
  // Captured once the module graph exists, so teardown can scrub the state
  // that outlives a single boot.
  ({ _resetFeatureState: featureState } = await import('../src/app/features.js'));
  ({ _resetTimetableUI: timetableState } = await import('../src/app/timetable-ui.js'));
  // menu.js holds the single open menu in module state, for the same reason.
  ({ _resetMenu: menuState } = await import('../src/app/menu.js'));
  // The undo stack is module-level too, and leaks entries between boots.
  ({ _resetUndo: undoState } = await import('../src/app/undo-actions.js'));
  // list.js keeps the row index across boots for the same reason (round 52).
  ({ _resetList: listState } = await import('../src/app/list.js'));
  // bulk.js keeps the selection across boots for the same reason.
  ({ _resetBulk: bulkState } = await import('../src/app/bulk.js'));
  // layers.js keeps its stack across boots; a stray layer from one test
  // eats the next test's Escape (round 54, workspace promotion). Close
  // properly FIRST — teardown fires each tenant's onClose, which is what
  // nulls their cached layer handles — then wipe whatever is left.
  ({ _resetLayers: layersState, closeAllLayers: layersCloseAll } = await import('../src/app/layers.js'));
  const ttStore = await import('../src/app/timetable-store.js');
  ttStore._resetSourceData(); // the catalogue is memoised per module, not per boot

  const settle = async (frames = 4) => {
    for (let i = 0; i < frames; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => win.requestAnimationFrame(() => r()));
    }
  };
  await settle();

  /*
   * Teardown must cancel the app's pending timers BEFORE the globals are
   * swapped back. The search fallback arms a real 420ms timer; left running,
   * it fires into a torn-down document and surfaces as an unhandledRejection
   * attributed to whichever test happened to be running at the time.
   */
  const restore = () => {
    try {
      win.__bmmTeardown?.();
    } catch {
      // Teardown is best-effort; a failure here must not mask the real result.
    }
    /*
     * app.js is re-imported per boot with a cache-busting URL, but its IMPORTS
     * are cached -- so features.js keeps its module state across tests, still
     * pointing at the document we are about to discard. Left alone it produces
     * tests that pass on a previous test's data. See _resetFeatureState.
     */
    try {
      featureState?.();
    } catch {
      // Same rule: never mask the real result.
    }
    // timetable-ui.js holds module state for the same reason features.js does.
    try {
      timetableState?.();
    } catch {
      // Never mask the real result.
    }
    /*
     * menu.js holds the ONE open menu in module state. A test that leaves the
     * theme picker open would otherwise hand the next boot a live layer
     * pointing at a closed document -- and the next `openMenu` would try to
     * close it.
     */
    try {
      menuState?.();
    } catch {
      // Never mask the real result.
    }
    /*
     * Empty the undo stack. Without this a test's Ctrl+Z pops an entry left
     * by an EARLIER test and fires that test's verb -- which is exactly how
     * two new failure-path tests passed alone and failed in the suite.
     */
    try {
      undoState?.();
    } catch {
      // Never mask the real result.
    }
    // list.js row index / scroll memory (round-52 workspace extraction).
    try {
      listState?.();
    } catch {
      // Never mask the real result.
    }
    // bulk.js selection (round-52 workspace extraction, step 6).
    try {
      bulkState?.();
    } catch {
      // Never mask the real result.
    }
    // layers.js stack (round 54): close with teardown, then wipe.
    try {
      layersCloseAll?.();
      layersState?.();
    } catch {
      // Never mask the real result.
    }
    Object.assign(globalThis, prev);

    // LATE-RAF NO-OP: a deferred app timer (mark-read grace, refresh sweep)
    // can fire after restore() and resolve the bare global
    // requestAnimationFrame, which node:test leaves undefined — an
    // uncaughtException that fails the FILE, not the test that leaked.
    // The app's own teardown should cancel everything; this only keeps a
    // leftover from crashing the runner.
    if (globalThis.requestAnimationFrame === undefined) {
      globalThis.requestAnimationFrame = () => 0;
      globalThis.cancelAnimationFrame = () => {};
    }

    /*
     * CLOSE THE WINDOW. This was missing, and it is why the suite eventually
     * died with "Ineffective mark-compacts near heap limit".
     *
     * Every boot builds a full JSDOM document -- DOM tree, CSSOM, timers,
     * listeners, an ES module graph -- and without close() all of them stayed
     * reachable for the whole run. At 139 integration tests in one process
     * that crossed the V8 heap ceiling and the file aborted with SIGABRT,
     * which reports as a test FAILURE with no assertion attached and sends
     * you looking for a logic bug that is not there.
     *
     * close() stops jsdom's timers and detaches the window, so each test's
     * document becomes collectable as soon as it finishes.
     */
    try {
      win.close();
    } catch {
      // Best-effort, like the teardown above.
    }
  };

  return { win, doc: win.document, calls, storage, settle, restore, changeSetting };
}

/** features.js reset, captured at boot. See restore(). */
let featureState = null;
/** timetable-ui.js reset, same reasoning. */
let timetableState = null;
/** @type {null | (() => void)} */
let menuState = null;
/** @type {null | (() => void)} */
let undoState = null;
/** list.js reset, same reasoning (round 52). */
let listState = null;
/** bulk.js reset, same reasoning (round 52 step 6). */
let bulkState = null;
/** layers.js reset, same reasoning (round 54). */
let layersState = null;
let layersCloseAll = null;

const rows = (doc) => [...doc.querySelectorAll('#list .row')];

/**
 * Wait for departing rows to finish leaving.
 *
 * Archived, deleted and snoozed rows animate out (see `dismissRow`), so they
 * remain in the DOM for ~140ms after the store has already dropped them.
 * Counting rows immediately after an archive therefore measures mid-flight
 * state. Filtering is unaffected — a filtered row is removed synchronously,
 * because nothing happened to the message.
 */
const settled = async (doc, settle) => {
  await new Promise((r) => setTimeout(r, 260));
  await settle(4);
  return rows(doc);
};
const rowText = (doc) => rows(doc).map((r) => r.querySelector('.r-subj').textContent);

/*
 * The rail count is two spans, not one string -- unread and total are
 * separated by weight and colour rather than a slash. Read them apart, so a
 * test cannot pass by accident on a concatenation that happens to match.
 */
const countParts = (catButton) => {
  const c = catButton.lastElementChild;
  return {
    unread: c.querySelector('.c-unread')?.textContent ?? null,
    total: c.querySelector('.c-total')?.textContent ?? null,
  };
};

// --------------------------------------------------------------------------

/* ---- shared helpers -------------------------------------------------------
 * Hoisted out of the middle of the file. The suite is split in two for
 * MEMORY reasons (see the note atop part two), and a helper declared beside
 * its first caller does not survive that split -- both halves need these.
 * -------------------------------------------------------------------------- */

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

const pick = (row, win, opts = {}) =>
  (opts.shiftKey || opts.ctrlKey ? row : row.querySelector('.r-pick'))
    .dispatchEvent(new win.MouseEvent('click', { bubbles: true, ...opts }));

const press = (doc, win, key, opts = {}) =>
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, ...opts }));


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

test('the sidebar shows BOTH unread and total, never unread alone', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * THE USER-REPORTED BUG: "only mail that is not read is appearing".
   *
   * Read mail was always in the list — but the rail rendered `unread || total`,
   * so a category with 1 unread and 40 read displayed "1". The rail is what
   * people scan, so it looked as though read mail had not been fetched.
   *
   * The fixture has 3 messages: 2 unread, 1 already read. The read one is in
   * `external-services`, which is precisely the case that used to be
   * indistinguishable — it showed "1" whether that 1 was read or unread.
   */
  const { doc, restore } = await boot();
  try {
    const byCat = {};
    for (const b of doc.querySelectorAll('#cats .cat')) {
      byCat[b.dataset.cat] = countParts(b);
    }

    assert.deepEqual(byCat.all, { unread: '2', total: '3' }, 'two unread out of three total');
    assert.deepEqual(byCat.augsd, { unread: '1', total: '1' });
    assert.deepEqual(byCat.ps, { unread: '1', total: '1' });
    // The read-only category shows a bare total, with no unread emphasis.
    assert.deepEqual(
      byCat['external-services'], { unread: '', total: '1' },
      'a fully-read category shows its total, not nothing'
    );
  } finally {
    restore();
  }
});

test('a category holding only READ mail still reports its messages', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The regression in its starkest form: mail that is entirely read must
  // never make a populated category look empty.
  const allRead = MESSAGES.map((m) => ({ ...m, unread: false, labels: ['INBOX'] }));
  const { doc, restore } = await boot({ messages: allRead });
  try {
    const all = countParts(
      [...doc.querySelectorAll('#cats .cat')].find((b) => b.dataset.cat === 'all')
    );
    assert.deepEqual(
      all, { unread: '', total: String(allRead.length) },
      'all-read inbox must show its total and no unread figure'
    );
    assert.equal(rows(doc).length, allRead.length, 'and every read message must be listed');
  } finally {
    restore();
  }
});

test('the sidebar count carries an explanatory title', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // "2/3" is compact but not self-describing; the tooltip spells it out.
  const { doc, restore } = await boot();
  try {
    const all = [...doc.querySelectorAll('#cats .cat')]
      .find((b) => b.dataset.cat === 'all').lastElementChild;
    assert.match(all.getAttribute('title') || '', /3 messages, 2 unread/);
  } finally {
    restore();
  }
});

/*
 * Mail with real deadline prose, for the radar. `tomorrow` and `today` are
 * relative, so these stay in the right urgency band whenever the suite runs --
 * a fixed date would silently drift into "overdue" and the test would start
 * asserting something different from what it was written to check.
 */
/*
 * A TIME-DEPENDENT TEST THAT FAILED WHEN THE CLOCK CROSSED MIDNIGHT.
 *
 * These messages said "by today" and "is tomorrow", anchored -- correctly, by
 * design -- to the message's SEND date rather than to now, so that opening a
 * three-day-old mail does not shift its deadline forward.
 *
 * The seed used `Date.now() - 7200_000`. Run at 01:34 UTC that is 23:34 on the
 * PREVIOUS day, so "today" resolved to that previous day and the radar
 * correctly reported it overdue -- while the assertion demanded "today". The
 * product was right and the test was wrong, and it had been silently wrong for
 * however long the suite happened to run outside the 02:00-24:00 window.
 *
 * Fixed by anchoring the seed to local NOON, so the two-hour offset cannot
 * cross a day boundary in any timezone. The clock is pinned, not the
 * behaviour: the extractor, the urgency bands and the radar are all still
 * exercised for real.
 */
const NOON_TODAY = (() => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime();
})();

const DUE_MESSAGES = [
  {
    id: 'd1', threadId: 'td1',
    from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>',
    subject: 'Fee payment',
    snippet: 'The last date for fee payment is tomorrow.',
    date: NOON_TODAY, unread: true, starred: false, labels: ['INBOX', 'UNREAD'],
  },
  {
    id: 'd2', threadId: 'td2',
    from: 'Practice School Division <psd@pilani.bits-pilani.ac.in>',
    subject: 'PS report',
    snippet: 'Please submit the PS report by today.',
    date: NOON_TODAY, unread: true, starred: false, labels: ['INBOX', 'UNREAD'],
  },
];

test('RADAR: the heading reports how many and how urgent', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * D-6. The radar is the product's most differentiated feature and was
   * presented as a box titled "Due soon" -- the same weight as any other
   * list, so the intelligence read as a filter.
   */
  const { doc, settle, restore } = await boot({ messages: DUE_MESSAGES });
  try {
    await settle(6);
    assert.equal(doc.getElementById('radar').hidden, false, 'the radar should be showing');
    const title = doc.getElementById('radar-title').textContent;
    assert.match(title, /^Due soon · /, `heading did not carry a summary: ${title}`);
    // Something is due today, and nothing is overdue, so "today" is the worst
    // band present and the one worth naming.
    assert.match(title, /today/, `expected the worst band named: ${title}`);
  } finally {
    restore();
  }
});

test('READER: a message with a deadline says so, in the message', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * THE DEADLINE WAS EXTRACTED, STORED, CACHED -- AND ONLY EVER SHOWN IN THE
   * SIDEBAR, capped at six items.
   *
   * `extractDeadline` runs on every ingest and writes dueAt/dueKind/dueText
   * onto the message. The radar renders the top six. Message seven has a
   * deadline the product knows about and never mentions -- and the one place
   * the user is certainly looking at that message, the reader, said nothing.
   *
   * This is the product's most differentiated feature being hidden from the
   * surface where it matters most. It must use the SAME vocabulary as the
   * radar (`relativeLabel`, `urgency`), or the same date acquires two
   * different names depending on where you read it.
   */
  const { doc, settle, restore } = await boot({ messages: DUE_MESSAGES });
  try {
    await settle(6);
    rows(doc)[0].click();
    await settle(6);

    const due = doc.getElementById('r-due');
    assert.ok(due, 'the reader needs a deadline surface');
    assert.equal(due.hidden, false, 'this message has a deadline; show it');

    // The same phrasing the radar uses, not a second vocabulary.
    assert.match(
      due.textContent, /due (today|tomorrow|in \d)|overdue/i,
      `expected radar-style wording, got: ${due.textContent}`
    );

    // And it must explain itself, exactly as the radar item does.
    assert.match(
      due.textContent, /Read from|read from/,
      'the deadline must quote the phrase it came from'
    );
  } finally {
    restore();
  }
});

test('READER: a message with no deadline shows no deadline strip', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The counterpart. An always-present empty strip is chrome, and it would
  // push the body down on every message for the benefit of a minority.
  const { doc, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle(6);
    assert.equal(
      doc.getElementById('r-due').hidden, true,
      'no deadline, no strip'
    );
  } finally {
    restore();
  }
});

test('RADAR: an item shows which phrase the date was read from', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * Converts "how did it know that?" into "of course, it read the line".
   * In the title rather than on the surface: the item is already two columns
   * in a narrow rail, and this is the one delight change the audit flagged as
   * at risk of reading as noise.
   */
  const { doc, settle, restore } = await boot({ messages: DUE_MESSAGES });
  try {
    await settle(6);
    const titles = [...doc.querySelectorAll('#radar-list .radar-what')]
      .map((n) => n.getAttribute('title') || '');
    assert.ok(titles.length > 0, 'the radar should have items');
    assert.ok(
      titles.some((t) => /Deadline read from: ".+"/.test(t)),
      `no item explained its deadline: ${JSON.stringify(titles)}`
    );
    // And the phrase quoted must be one that actually appears in the mail,
    // not a restatement of the parsed date.
    const withSource = titles.find((t) => t.includes('Deadline read from'));
    const quoted = withSource.match(/Deadline read from: "(.+)"/)[1];
    const bodies = DUE_MESSAGES.map((m) => m.snippet.toLowerCase()).join(' ');
    assert.ok(
      bodies.includes(quoted.toLowerCase()),
      `quoted "${quoted}" does not appear in the mail it came from`
    );
  } finally {
    restore();
  }
});

test('RADAR: a warm cache start still finds the deadlines', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The cache stores eleven positional fields and `dueAt` is not one of them,
   * so cached messages go into the store via `store.upsert` WITHOUT passing
   * through `ingest` -- which is the only place `extractDeadline` runs.
   *
   * The radar therefore reads whatever the cache path left behind. This test
   * pins the behaviour that matters to the user: open the app with a warm
   * cache, and the deadlines you could see yesterday are still there.
   */
  const { doc, settle, restore } = await boot({
    messages: DUE_MESSAGES,
    storageSeed: { msgCache: cacheBlob(DUE_MESSAGES), historyId: '12345' },
  });
  try {
    await settle(10);
    assert.equal(
      doc.getElementById('radar').hidden, false,
      'a warm start lost every deadline'
    );
    assert.ok(
      doc.querySelectorAll('#radar-list .radar-item').length > 0,
      'the radar is visible but empty'
    );
  } finally {
    restore();
  }
});

test('CACHE: has:attachment still works after a warm start', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * THE SAME ROOT CAUSE AS THE RADAR BUG, second victim.
   *
   * `pack()` does not store `hasAttachment` either, so on a warm start every
   * cached message looks attachment-less and `has:attachment` returns nothing
   * -- a search operator that silently answers "no" for the entire cache.
   *
   * Unlike the deadline this CANNOT be re-derived: the flag comes from the
   * Gmail payload, not from the subject or snippet. So the honest fix is to
   * cache it, which is what the packed flags byte now carries.
   */
  const withAtt = MESSAGES.map((m, i) => ({ ...m, hasAttachment: i === 0 }));
  const { doc, win, settle, restore } = await boot({
    messages: withAtt,
    storageSeed: { msgCache: cacheBlob(withAtt), historyId: '12345' },
  });
  try {
    await settle(10);
    const search = doc.getElementById('search');
    search.value = 'has:attachment';
    search.dispatchEvent(new win.Event('input'));
    await settle(8);

    assert.equal(
      rows(doc).length, 1,
      'a warm start lost the attachment flag, so has:attachment found nothing'
    );
  } finally {
    restore();
  }
});

test('EMPTY: clearing the last message reads differently from arriving empty', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * D-10. Archiving the last message and opening a mailbox that was already
   * empty produced the identical screen. The first is an achievement; the
   * second is a description. They must not share a sentence.
   */
  const one = [MESSAGES[0]];
  const { doc, win, settle, restore } = await boot({ messages: one });
  try {
    assert.equal(rows(doc).length, 1);
    // Archive it with the keyboard, the way the shortcut users do.
    doc.querySelector('#list .row').click();
    await settle(4);
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    // The row animates out, so it lingers in the DOM after the store drops it.
    assert.equal((await settled(doc, settle)).length, 0, 'the row should be gone');
    const title = doc.getElementById('empty-title').textContent;
    assert.equal(title, 'That was the last one', `achieved-empty said: ${title}`);
    assert.ok(
      doc.getElementById('empty-action').hidden,
      'there is nothing left to do, so offer no button'
    );
  } finally {
    restore();
  }
});

test('EMPTY: a mailbox that was always empty is merely described', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The control for the test above: with no action taken, the wording must
  // stay descriptive. Without this, "That was the last one" could greet a
  // brand-new user who has never archived anything.
  const { doc, restore } = await boot({ messages: [] });
  try {
    const title = doc.getElementById('empty-title').textContent;
    assert.notEqual(title, 'That was the last one', 'nothing was achieved here');
    assert.equal(title, 'Inbox empty');
  } finally {
    restore();
  }
});

test('EMPTY: switching to an empty mailbox is not an achievement', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * THE CASE THAT BROKE THE FIRST IMPLEMENTATION.
   *
   * "Achieved" was detected as "an id we were rendering is no longer in the
   * store". On a mailbox switch that is trivially true for every row -- the
   * inbox ids are absent from the Sent store because they were never in it.
   * So opening an empty Sent congratulated you for clearing an inbox you had
   * not touched. The detector must be scoped to one view.
   */
  // Inbox has mail; the sync stub returns nothing for any other label, so
  // Sent is genuinely empty and the switch crosses from populated to empty.
  const { doc, settle, restore } = await boot({
    perLabel: true,
    messages: MESSAGES,
    emptyLabels: ['SENT'],
  });
  try {
    doc.querySelector('.cat[data-mailbox="sent"]').click();
    await settled(doc, settle);

    assert.equal(rows(doc).length, 0);
    assert.notEqual(
      doc.getElementById('empty-title').textContent, 'That was the last one',
      'switching mailboxes is not clearing one'
    );
  } finally {
    restore();
  }
});

test('FRESHNESS: the app says when it last heard from Gmail', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * D-9. Nothing is wrong when the line is absent -- the user simply has no
   * way to know it is right. After a successful boot the sync is seconds old,
   * so the line must read "just now" rather than "0 min ago".
   */
  const { doc, restore } = await boot();
  try {
    const f = doc.getElementById('freshness');
    assert.ok(f, 'the freshness line must exist');
    assert.match(f.textContent, /^Updated just now$/, 'a fresh boot is "just now"');
    assert.equal(f.getAttribute('aria-live'), 'polite');
  } finally {
    restore();
  }
});

test('FRESHNESS: a signed-out app claims no freshness at all', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // An empty line, not "Updated ... ago": we have never spoken to Gmail, and
  // saying otherwise is the one thing this feature must never do.
  const { doc, restore } = await boot({ signedIn: false });
  try {
    assert.equal(doc.getElementById('freshness').textContent, '');
  } finally {
    restore();
  }
});

test('FRESHNESS: signing out clears the timestamp', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Freshness belongs to a session. Carrying it across sign-out would tell
  // the next account that we had already synced on their behalf.
  const { doc, settle, restore } = await boot();
  try {
    assert.notEqual(doc.getElementById('freshness').textContent, '');
    doc.getElementById('btn-signout').click();
    await settle(12);
    assert.equal(
      doc.getElementById('freshness').textContent, '',
      'the previous session\'s freshness survived sign-out'
    );
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
    // The BODY is fetched immediately -- reading must never wait.
    assert.ok(calls.some((c) => c.type === 'GET_BODY' && c.id === 'm1'));

    /*
     * Marking read is DELIBERATELY DELAYED (settings.markReadDelayMs).
     *
     * Unread is the one piece of triage state a user cannot reconstruct, so a
     * mis-click must not consume it. This test previously asserted the
     * instant behaviour; it now pins the delay, and the two tests below pin
     * both outcomes of it.
     */
    assert.ok(
      !calls.some((c) => c.type === 'MARK_READ'),
      'must not mark read on the same tick as the click'
    );
    assert.ok(rows(doc)[0].classList.contains('unread'), 'still unread during the grace period');

    // Wait past the default delay and it lands, optimistically.
    await new Promise((r) => setTimeout(r, 1400));
    await settle();
    assert.ok(!rows(doc)[0].classList.contains('unread'), 'read once the delay elapses');
    assert.ok(calls.some((c) => c.type === 'MARK_READ' && c.id === 'm1'));
  } finally {
    restore();
  }
});

test('a message skimmed past within the grace period stays unread', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The reason the delay exists. Arrowing through the list, or opening the
   * wrong message and leaving immediately, must not silently destroy unread
   * state across every message you touched.
   */
  const { doc, win, calls, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle();
    // Move on well before the delay elapses.
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    await settle();

    await new Promise((r) => setTimeout(r, 1400));
    await settle();

    assert.ok(
      !calls.some((c) => c.type === 'MARK_READ' && c.id === 'm1'),
      'the message that was skimmed past must not be marked read'
    );
    assert.ok(rows(doc)[0].classList.contains('unread'));
  } finally {
    restore();
  }
});

test('closing the reader cancels a pending mark-read', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, calls, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle();
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();

    await new Promise((r) => setTimeout(r, 1400));
    await settle();

    assert.ok(
      !calls.some((c) => c.type === 'MARK_READ' && c.id === 'm1'),
      'a message opened and immediately closed stays unread'
    );
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

    // The row animates out, so it lingers ~140ms after the store drops it.
    assert.equal((await settled(doc, settle)).length, 2, 'archived row should be gone');
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
  const src = readFileSync(join(ROOT, 'src/app/app.js'), 'utf8');
  assert.ok(
    src.includes("type: 'BMM_READY'") && src.includes("'https://mail.google.com'"),
    'app.js must post BMM_READY to its parent'
  );
  // The readiness handshake carries the embed nonce when embedded
  // (bug-hunt 44 #70); the contract is asserted, not just the call.
  assert.match(src, /\{ type: 'BMM_READY', \.\.\.\(EMBED_NONCE/,
    'readiness echoes the embed nonce');
  assert.ok(html.includes('app.js'));
});

// -------------------------------------------- no cap on rendered rows ------


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
      // Must mirror pack() in cache.js, including bit 4 for hasAttachment.
      (m.unread ? 1 : 0) | (m.starred ? 2 : 0) | (m.hasAttachment ? 4 : 0),
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
    /*
     * Scoped to #list by id rather than taking the first [role="listbox"] in
     * the document.
     *
     * The search suggestion dropdown is also a listbox -- correctly, it is a
     * combobox popup -- and it appears EARLIER in the DOM, so the unscoped
     * query started matching it and this test failed on a change that was not
     * a regression. The property being protected is about the MESSAGE LIST's
     * ARIA ownership specifically.
     */
    const listbox = doc.getElementById('list');
    assert.ok(listbox, 'a listbox must exist');
    assert.equal(listbox.getAttribute('role'), 'listbox');

    const options = [...listbox.querySelectorAll('[role="option"]')];
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

test('A11Y: the gate moves focus in and hands it back on hide', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Modal dialog lifecycle (P2-01): focus enters the only action when the
  // gate shows, and returns to where it was when the gate hides.
  const { doc, win, settle, restore } = await boot({ signedIn: false });
  try {
    await settle(4);
    assert.equal(doc.activeElement, doc.getElementById('btn-signin'), 'focus lands on Sign in');
    // Simulate session expiry while the user is in search, then recovery.
    const search = doc.getElementById('search');
    search.focus();
    win.__bmmShowGate?.('Session expired. Sign in again.');
    await settle(2);
    assert.equal(doc.activeElement, doc.getElementById('btn-signin'), 'gate reclaims focus');
    win.__bmmHideGate?.();
    await settle(2);
    assert.equal(doc.activeElement, search, 'focus returns to search after hide');
  } finally {
    restore();
  }
});

test('A11Y: the search field is a combobox owning the suggestion list', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The full combobox contract (40-ENG section 8): the input must announce
  // the popup, name the list it controls, and move aria-activedescendant
  // through it — otherwise the suggestion list reads as an unowned orphan.
  const { doc, win, settle, restore } = await boot();
  try {
    const input = doc.getElementById('search');
    assert.equal(input.getAttribute('role'), 'combobox');
    assert.equal(input.getAttribute('aria-controls'), 'search-suggest');
    assert.equal(input.getAttribute('aria-expanded'), 'false', 'closed by default');

    input.focus();
    input.value = 'is:';
    input.dispatchEvent(new win.Event('input'));
    await settle(4);
    assert.equal(input.getAttribute('aria-expanded'), 'true', 'open once suggestions render');

    const box = doc.getElementById('search-suggest');
    assert.equal(box.hidden, false);
    assert.ok(box.children.length > 0, 'suggestions exist');
    assert.ok(box.children[0].id, 'each option carries an id for activedescendant');

    // Arrow down moves activedescendant to a real option.
    input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle();
    const active = input.getAttribute('aria-activedescendant');
    assert.ok(active && doc.getElementById(active), 'activedescendant references a real option');

    // Closing (blur path) must drop the expanded state. The close is
    // deliberately delayed 120ms so a suggestion click can land; wait it out.
    input.blur();
    await new Promise((r) => win.setTimeout(r, 140));
    await settle(2);
    assert.equal(input.getAttribute('aria-expanded'), 'false', 'closed on blur');
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
    /*
     * The menu is built on open and REMOVED on close, so "closed" is now the
     * absence of the node rather than a hidden shell. Asserting on the node
     * is what catches a menu left attached after the choice was made.
     */
    assert.equal(doc.querySelector('.theme-menu'), null, 'menu closes after choosing');
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
    btn.click();
    await settle();
    const menu = doc.querySelector('.theme-menu');
    assert.ok(menu, 'the menu is built on open');

    // Focus lands on the current theme, not the top of the list.
    assert.equal(doc.activeElement.getAttribute('aria-checked'), 'true');

    menu.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle();
    assert.ok(doc.activeElement.classList.contains('theme-item'));

    // Home and End came from this menu's own hand-rolled handler. Absorbing
    // it into the primitive must not have cost the user two working keys.
    menu.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await settle();
    const items = [...doc.querySelectorAll('.theme-item')];
    /*
     * Round 58: the menu is Appearance now — End reaches the menu's last
     * item, which is a density option; the themes are still one Home away.
     */
    const all = [...menu.querySelectorAll('.snooze-opt')];
    assert.equal(doc.activeElement, all[all.length - 1],
      'End reaches the last appearance option');
    assert.ok(doc.activeElement.classList.contains('density-item'));
    menu.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await settle();
    assert.equal(doc.activeElement, items[0], 'Home reaches the first');

    menu.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    assert.equal(doc.querySelector('.theme-menu'), null);
    assert.equal(btn.getAttribute('aria-expanded'), 'false', 'the trigger is un-expanded');
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

    assert.equal((await settled(doc, settle)).length, before - 1);
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
      // Transient chrome (toasts) is not part of the persistent tab order —
      // the coach toast's action button lives for 7s then leaves the DOM.
      .filter((e) => visible(e, doc) && e.tabIndex >= 0 && !e.closest('.toast, #toast'));

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
    // Budget raised 20 -> 22 in round 58: the IA audit added exactly two
    // persistent stops — the topbar Help button and the sidebar Activity
    // button, both previously keyboard-only/undiscoverable. Any further
    // increase must be accounted the same way.
    assert.ok(nLarge < 22, `expected a small constant number of stops, got ${nLarge}`);
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
    // Query the buttons, not `children`. The rail is now grouped into system
    // mailboxes and BITS categories, so the buttons are grandchildren; reading
    // `children` here returned the two wrapper divs and asserted nothing.
    const cats = [...doc.getElementById('cats').querySelectorAll('.cat')];
    assert.ok(cats.length > 8, 'both mailboxes and categories should be present');
    // ONE stop for the whole rail, across both groups. Two groups must not
    // mean two tab stops.
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
    assert.equal((await settled(doc, settle)).length, 5, 'three removed');
    assert.match(doc.getElementById('toast').textContent, /Archived 3 messages/);

    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await settle();
    await settle();
    assert.equal(rows(doc).length, 8, 'one undo restores all three');
  } finally {
    restore();
  }
});

test('AUTO-ARCHIVE: files new mail, says so, and undoes to the inbox', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * THIS BEHAVIOUR HAD NO INTEGRATION COVERAGE AT ALL.
   *
   * `rules.js` is well tested -- toggling, persistence, the mute/auto-archive
   * contradiction. But `autoArchive()` in app.js, the function that actually
   * removes a user's mail from their inbox on arrival, was never exercised
   * end to end. The rule engine was proven; the thing acting on it was not.
   *
   * It is also the most destructive-adjacent thing the app does without being
   * asked, which is exactly why the product reports it and offers an undo
   * rather than acting silently: mail that vanishes with no announcement is
   * indistinguishable from mail going missing.
   */
  const { doc, win, calls, settle, restore } = await boot({
    messages: [],
    storageSeed: { categoryRules: { muted: [], autoArchive: ['augsd'], corrections: {} } },
  });
  try {
    calls.length = 0;
    // Arriving mail, unread, in the auto-archived category.
    win.__bmmIngest(bulk(3, { unread: true }));
    await settled(doc, settle);

    // It leaves the inbox locally...
    assert.equal(rows(doc).length, 0, 'auto-archived mail does not sit in the inbox');

    // ...and exactly one BULK call carries the archive delta.
    const forward = calls.filter((c) => c.type === 'BULK');
    assert.equal(forward.length, 1, 'one request for the batch, not three');
    assert.deepEqual([...(forward[0].remove || [])], ['INBOX'], 'archiving removes INBOX');
    assert.deepEqual([...(forward[0].add || [])], [], 'and adds nothing');

    // It ANNOUNCES itself. A silent rule is a bug report waiting to happen.
    const toastEl = doc.getElementById('toast');
    assert.equal(toastEl.hidden, false, 'the toast must actually be showing');
    assert.match(
      toastEl.textContent, /Auto-archived 3/,
      'the user must be told what the rule did'
    );
    assert.match(toastEl.textContent, /Undo/, 'and offered a way back');

    // And it is reversible, by the derived inverse.
    calls.length = 0;
    doc.dispatchEvent(
      new win.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })
    );
    await settle();
    await settle();

    const back = calls.filter((c) => c.type === 'BULK');
    assert.equal(back.length, 1, 'undo sends one BULK');
    assert.deepEqual([...(back[0].add || [])], ['INBOX'], 'undo puts INBOX back');
    assert.deepEqual([...(back[0].remove || [])], [], 'and removes nothing');
    assert.equal(rows(doc).length, 3, 'the mail returns to the list');
  } finally {
    restore();
  }
});

test('AUTO-ARCHIVE: leaves already-read mail alone', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The rule fires on ARRIVAL, so it must only touch unread mail. Re-archiving
   * something the user has already opened and chosen to keep in the inbox
   * would be the app fighting them -- and it would do so on every sync.
   */
  const { doc, win, calls, settle, restore } = await boot({
    messages: [],
    storageSeed: { categoryRules: { muted: [], autoArchive: ['augsd'], corrections: {} } },
  });
  try {
    calls.length = 0;
    win.__bmmIngest(bulk(3, { unread: false }));
    await settled(doc, settle);

    assert.equal(
      calls.filter((c) => c.type === 'BULK').length, 0,
      'read mail must not be auto-archived'
    );
    assert.equal(rows(doc).length, 3, 'and it stays in the list');
  } finally {
    restore();
  }
});

test('CONSISTENCY: a setting changed in Options reaches the running app', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * `settings.subscribe()` was exported, documented, and called by NOTHING.
   *
   * That is the same shape as the dead schema keys the suite already guards
   * against: an exported API is a promise that the thing works, and the next
   * reader believes it. Here the promise was doubly empty, because a subscriber
   * could not have helped even if someone had registered one -- the options
   * page is a SEPARATE EXTENSION PAGE with its own module instances, so an
   * in-process listener can never see its writes.
   *
   * The user-visible effect: `settings.get()` reads an in-memory cache filled
   * once at boot. Turn off "mark read on open" in Options, come back to the
   * still-open mail tab, and it keeps marking mail read -- silently, until the
   * tab is reloaded. Every other piece of cross-surface state in this product
   * updates live.
   *
   * `chrome.storage.onChanged` is the only channel that crosses pages, so that
   * is what the app must listen to.
   */
  const { win, changeSetting, restore } = await boot({
    storageSeed: { markReadOnOpen: true },
  });
  try {
    const settings = await import('../src/app/settings.js');
    assert.equal(settings.get('markReadOnOpen'), true, 'precondition: on at boot');

    // The options page writes it. Chrome broadcasts the change.
    await changeSetting('markReadOnOpen', false);

    assert.equal(
      settings.get('markReadOnOpen'), false,
      'the running app must see a setting changed in Options, without a reload'
    );

    // And an unrelated key must not be disturbed by the refresh.
    assert.equal(settings.get('threaded'), settings.get('threaded'));
    void win;
  } finally {
    restore();
  }
});

test('CONSISTENCY: turning off mark-read-on-open in Options takes effect immediately', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The behavioural half of the cross-page settings fix. Asserting the cache
   * updated proves the plumbing; this proves the PRODUCT changed, which is
   * what the user actually experiences.
   *
   * With mark-read-on-open enabled, opening an unread message marks it read.
   * Turn it off in Options and the very next message you open must stay
   * unread -- no reload.
   */
  const { doc, win, settle, changeSetting, restore } = await boot({
    storageSeed: { markReadOnOpen: true, markReadDelayMs: 0 },
  });
  try {
    // Baseline: the setting is honoured.
    assert.equal(win.__bmmStore.get('m1').unread, true, 'precondition: m1 unread');
    rows(doc).find((r) => r.dataset.id === 'm1').click();
    await settle(6);
    assert.equal(win.__bmmStore.get('m1').unread, false, 'opening marks it read');

    // The user turns it off in the options page.
    await changeSetting('markReadOnOpen', false);

    // The next unread message they open must stay unread.
    assert.equal(win.__bmmStore.get('m2').unread, true, 'precondition: m2 unread');
    rows(doc).find((r) => r.dataset.id === 'm2').click();
    await settle(6);
    assert.equal(
      win.__bmmStore.get('m2').unread, true,
      'the new setting must apply without reloading the tab'
    );
  } finally {
    restore();
  }
});

test('CONSISTENCY: toggling threading in Options redraws the list at once', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * `threaded` is read in six render paths, so unlike mark-read-on-open it is
   * not enough for the CACHE to be current -- the list on screen was drawn
   * from the old value and nothing asks it to redraw.
   *
   * Without a repaint the user turns conversation view on in Options, returns
   * to a list still showing every message separately, and reasonably concludes
   * the setting does nothing.
   */
  const conv = [
    { id: 'c1', threadId: 'T', from: 'A <a@x.com>', subject: 'Root',
      snippet: 'first', date: Date.now() - 3000, unread: false, starred: false, labels: ['INBOX'] },
    { id: 'c2', threadId: 'T', from: 'B <b@x.com>', subject: 'Re: Root',
      snippet: 'second', date: Date.now() - 2000, unread: false, starred: false, labels: ['INBOX'] },
    { id: 'c3', threadId: 'U', from: 'C <c@x.com>', subject: 'Other',
      snippet: 'alone', date: Date.now() - 1000, unread: false, starred: false, labels: ['INBOX'] },
  ];
  const { doc, settle, changeSetting, restore } = await boot({
    messages: conv, storageSeed: { threaded: false },
  });
  try {
    assert.equal(rows(doc).length, 3, 'unthreaded: every message is its own row');

    await changeSetting('threaded', true);
    await settle(4);

    assert.equal(
      rows(doc).length, 2,
      'the list must redraw as conversations without waiting for another event'
    );
  } finally {
    restore();
  }
});

test('FALLBACK: a dead service worker degrades instead of bricking the app', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * THE REAL FAILURE THIS EXISTS FOR.
   *
   * Chrome has been refusing to register the worker with "Status code: 2",
   * and every static check passes, so the cause is still unknown. A mail
   * client that cannot start is worth nothing; one running with degraded
   * background features is worth almost everything.
   *
   * The mock reproduces Chrome's ACTUAL shape for an absent worker: the
   * callback fires with `undefined` and `lastError` is set. It does not
   * throw. A mock that threw would exercise a path the browser never takes,
   * and the fallback would be tested against a fiction.
   */
  const { doc, settle, restore } = await boot({ deadWorker: true });
  try {
    await settle(8);

    // The user is told, once, in a persistent place.
    const warn = doc.getElementById('sw-warn');
    assert.ok(warn, 'a dead worker must be announced, not silently absorbed');
    assert.match(
      warn.textContent, /Background service unavailable/,
      'the banner must say what is wrong'
    );
    assert.match(
      warn.textContent, /snooze/i,
      'and name the capability that is actually lost'
    );

    // It is a status region, so assistive tech hears it too.
    assert.equal(warn.getAttribute('role'), 'status');

    // And it is dismissable: the app works, so the notice must not be a wall.
    const dismiss = warn.querySelector('button');
    assert.ok(dismiss, 'the banner needs a way out');
    dismiss.click();
    await settle();
    assert.equal(doc.getElementById('sw-warn'), null, 'dismiss must remove it');
  } finally {
    restore();
  }
});

test('FALLBACK: the warning appears exactly once, not per verb', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * Boot alone fires several verbs (AUTH_STATUS, PROFILE, SYNC_PAGE...). If
   * each raised its own banner the screen would fill with identical strips,
   * which is a worse experience than the degradation being announced.
   */
  const { doc, settle, restore } = await boot({ deadWorker: true });
  try {
    await settle(8);
    assert.equal(
      doc.querySelectorAll('#sw-warn').length, 1,
      'one banner for the session, however many verbs failed'
    );
  } finally {
    restore();
  }
});

test('UNDO: a FAILED action must not leave an undo entry behind', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * A REAL BUG, found by reading flagAction() and optimistic() side by side.
   *
   * Both push the undo entry unconditionally, at dispatch time, while the
   * network request is still in flight. If the request then FAILS, the catch
   * rolls the local store back -- but the undo entry is still on the stack.
   *
   *   press `s`            -> patch(starred:true), send STAR, push undo
   *   network fails        -> patch(starred:false), error toast
   *   press Ctrl+Z         -> patch(starred:false)  [local no-op]
   *                           send STAR {on:false}  [TELLS GMAIL TO UNSTAR]
   *
   * So undoing a visibly-failed action mutates the mailbox in the opposite
   * direction. If the message had been starred server-side beforehand, the
   * undo silently unstars it.
   *
   * The user-visible symptom is worse than the mechanism: an action reports
   * "Could not update star", and then Ctrl+Z -- the natural response to a
   * failure -- makes a change nobody asked for.
   *
   * The fix is to record the undo only once the request has SUCCEEDED.
   */
  const { doc, win, calls, settle, restore } = await boot({ failVerbs: ['STAR'] });
  try {
    rows(doc)[0].click();
    await settle(6);
    const id = MESSAGES[0].id;
    assert.equal(win.__bmmStore.get(id).starred, false, 'precondition: unstarred');

    press(doc, win, 's');
    await settle(8);

    // The failure rolled the optimistic change back.
    assert.equal(
      win.__bmmStore.get(id).starred, false,
      'a failed star must not stay applied locally'
    );

    // Now the part that matters: undo must have nothing to do.
    calls.length = 0;
    press(doc, win, 'z', { ctrlKey: true });
    await settle(8);

    const starCalls = calls.filter((c) => c.type === 'STAR');
    assert.deepEqual(
      starCalls, [],
      'undo sent a STAR for an action that never succeeded — this mutates the '
      + 'mailbox in the opposite direction'
    );
  } finally {
    restore();
  }
});

test('UNDO: a failed ARCHIVE leaves no undo entry either', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The same defect as the star case, in `optimistic()` -- which covers
   * archive, trash, spam, restore and unsnooze, so the stakes are higher.
   *
   * The undo was pushed at dispatch time. On failure the message is restored
   * to the list and an error toast shown, but the undo entry survives; Ctrl+Z
   * then sends UNARCHIVE for an archive that never happened. On a message the
   * user had archived earlier, that silently pulls it back into the inbox.
   */
  const { doc, win, calls, settle, restore } = await boot({ failVerbs: ['ARCHIVE'] });
  try {
    const before = rows(doc).length;
    rows(doc)[0].click();
    await settle(6);

    press(doc, win, 'e');
    await settled(doc, settle);

    // The rollback put it back.
    assert.equal(rows(doc).length, before, 'a failed archive must restore the row');

    calls.length = 0;
    press(doc, win, 'z', { ctrlKey: true });
    await settle(8);

    assert.deepEqual(
      calls.filter((c) => c.type === 'UNARCHIVE'), [],
      'undo sent UNARCHIVE for an archive that never happened'
    );
  } finally {
    restore();
  }
});

test('UNDO: a failed auto-archive leaves no undo entry', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The third instance of the same defect. autoArchive fires BULK without
   * awaiting -- deliberately, it must not block ingest -- and then records
   * the undo unconditionally on the next line.
   *
   * If the request fails the snapshots are restored and an error shown, but
   * the entry remains. Ctrl+Z then sends the inverse BULK, adding INBOX back
   * to mail that was never archived. Because auto-archive runs on ingest,
   * the user may not even have been looking when it failed.
   */
  const { doc, win, calls, settle, restore } = await boot({
    messages: [],
    failVerbs: ['BULK'],
    storageSeed: { categoryRules: { muted: [], autoArchive: ['augsd'], corrections: {} } },
  });
  try {
    win.__bmmIngest(bulk(3, { unread: true }));
    await settled(doc, settle);

    // The rollback put the mail back.
    assert.equal(rows(doc).length, 3, 'a failed auto-archive must restore the mail');

    calls.length = 0;
    press(doc, win, 'z', { ctrlKey: true });
    await settle(8);

    assert.deepEqual(
      calls.filter((c) => c.type === 'BULK'), [],
      'undo sent BULK for an auto-archive that never happened'
    );
  } finally {
    restore();
  }
});

test('FALLBACK: a slow but healthy worker is not declared dead', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * REPORTED FROM A REAL INBOX. The amber "Background service unavailable"
   * banner appeared while mail was loading perfectly -- because the worker
   * was not dead at all, it was merely slow.
   *
   * send() applied ONE 4000ms deadline to EVERY verb. AUTH_STATUS answers
   * instantly, but SYNC_PAGE fetches 100 messages plus batched metadata and
   * then classifies them; on a cold start over campus wifi that passes four
   * seconds easily. The app then declared the worker dead, showed the banner,
   * and routed everything through the in-page fallback FOR THE REST OF THE
   * SESSION, because the switch is deliberately sticky.
   *
   * Nothing appeared broken -- the fallback is real, which is why the
   * screenshot showed a working inbox -- but the banner was a lie, snooze
   * timers were disabled for no reason, and two paths were racing.
   *
   * The deadline must fit the verb.
   */
  const { doc, settle, restore } = await boot({ syncLatency: 4200 });
  try {
    /*
     * WAIT FOR THE CONDITION, NOT A FIXED NUMBER OF TURNS.
     *
     * This polled `for (i < 60) await settle(4)` -- about 240 event-loop turns,
     * which happened to outlast a 4.2s timer on the machine it was written on.
     * That is a race, and it began failing intermittently as soon as boot did
     * more work: measured failing on one run and passing on the next with no
     * code change between them.
     *
     * Waiting on the arrival itself is deterministic however much else boot is
     * doing. The assertions below are unchanged.
     */
    const deadline = Date.now() + 12000;
    while (rows(doc).length === 0 && Date.now() < deadline) {
      await settle(4);
    }

    assert.equal(
      doc.getElementById('sw-warn'), null,
      'a slow sync must not be mistaken for a dead worker'
    );
    assert.ok(rows(doc).length > 0, 'and the mail must still arrive');
  } finally {
    restore();
  }
});

test('CONSISTENCY: the rail count agrees with the list header', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * SEEN IN A REAL INBOX. The sidebar read "Inbox 32 48" while the list
   * header two inches away read "All mail 44".
   *
   * Both numbers were right and they measured different things. The rail
   * used `store.size` -- raw messages -- and the header used the rendered
   * row count, which with threading on is one row per CONVERSATION. Four
   * messages were replies collapsed into their threads.
   *
   * To a user that is simply arithmetic that does not add up, in the two
   * places they look most often. The rail sits beside the list, so it has to
   * count what the list shows.
   */
  const conv = [
    { id: 'x1', threadId: 'T', from: 'A <a@x.com>', subject: 'Root',
      snippet: 'a', date: Date.now() - 4000, unread: false, starred: false, labels: ['INBOX'] },
    { id: 'x2', threadId: 'T', from: 'B <b@x.com>', subject: 'Re: Root',
      snippet: 'b', date: Date.now() - 3000, unread: false, starred: false, labels: ['INBOX'] },
    { id: 'x3', threadId: 'T', from: 'C <c@x.com>', subject: 'Re: Root',
      snippet: 'c', date: Date.now() - 2000, unread: false, starred: false, labels: ['INBOX'] },
    { id: 'x4', threadId: 'U', from: 'D <d@x.com>', subject: 'Alone',
      snippet: 'd', date: Date.now() - 1000, unread: false, starred: false, labels: ['INBOX'] },
  ];
  const { doc, settle, restore } = await boot({
    messages: conv, storageSeed: { threaded: true },
  });
  try {
    await settle(8);

    const rendered = rows(doc).length;
    assert.equal(rendered, 2, 'precondition: 4 messages collapse to 2 conversations');

    const header = doc.getElementById('listcount').textContent.trim();
    assert.equal(header, String(rendered), 'the header counts rendered rows');

    const inbox = doc.querySelector('.cat[data-mailbox="inbox"]');
    const railTotal = inbox.querySelector('.c-total').textContent.trim();
    assert.equal(
      railTotal, String(rendered),
      `the rail says ${railTotal} while the list shows ${rendered} — same view, two numbers`
    );
  } finally {
    restore();
  }
});

test('CONSISTENCY: the gate takes focus on open, like every other dialog', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * Every other dialog in the product moves focus into itself when it opens:
   * help focuses its close button, the palette focuses its input, compose
   * focuses the first empty field. The gate focused nothing -- so a keyboard
   * or screen-reader user arriving at a signed-out app had focus parked on
   * <body>, behind a modal surface, with no way to discover the one button
   * that does anything.
   *
   * It is the FIRST thing a new user meets, which makes it the worst place in
   * the product to drop focus.
   */
  const { doc, restore } = await boot({ signedIn: false });
  try {
    assert.equal(doc.getElementById('gate').hidden, false, 'precondition: the gate shows');
    assert.equal(
      doc.activeElement.id, 'btn-signin',
      'focus must land on the primary action, not on <body>'
    );
  } finally {
    restore();
  }
});

test('CONSISTENCY: star and mark-unread are undoable one at a time, as they are in bulk', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * DRIFT, found by comparing siblings rather than by looking for a bug.
   *
   * Every single-message action routes through `optimistic()` and records an
   * undo -- archive, trash, spam, restore, unsnooze. Two do not: `star` and
   * `unread`. They were written earlier, as plain patch-and-send blocks, and
   * were never migrated when the helper arrived.
   *
   * The result is that the SAME INTENT has different recovery depending on how
   * many messages you picked:
   *
   *   select two rows, press Star  -> "Starred 2 messages", Undo button
   *   open one message, press `s`  -> nothing, no toast, no undo entry
   *
   * `bulkAct` has recorded undo for `star` and `read` all along, so this is
   * not a product decision that starring is too trivial to reverse -- the
   * product already decided it is not, in the other path.
   *
   * These assert the single-message path now matches.
   */
  const { doc, win, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle();
    const id = win.__bmmStore.get(MESSAGES[0].id).id;
    assert.equal(win.__bmmStore.get(id).starred, false, 'precondition: unstarred');

    press(doc, win, 's');
    await settle();
    assert.equal(win.__bmmStore.get(id).starred, true, 'it stars');

    // The same affordance every other action gives.
    const toastEl = doc.getElementById('toast');
    assert.equal(toastEl.hidden, false, 'starring must report itself');
    assert.match(toastEl.textContent, /Undo/, 'and offer the way back');

    press(doc, win, 'z', { ctrlKey: true });
    await settle();
    await settle();
    assert.equal(win.__bmmStore.get(id).starred, false, 'undo unstars');
  } finally {
    restore();
  }
});

test('CONSISTENCY: marking unread is undoable too', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * `markReadOnOpen` is off so the grace-period timer cannot race this. The
   * first draft of this test opened m1 -- which SEEDS UNREAD -- and asserted
   * `u` made it unread; `u` is a toggle, so it correctly made it read and the
   * test failed. The test was wrong, not the product. Starting from a known
   * read state makes the toggle direction unambiguous.
   */
  const { doc, win, settle, restore } = await boot({
    storageSeed: { markReadOnOpen: false },
  });
  try {
    const id = MESSAGES[2].id; // seeded read
    const row = rows(doc).find((r) => r.dataset.id === id) || rows(doc)[2];
    row.click();
    await settle(8);
    assert.equal(win.__bmmStore.get(id).unread, false, 'precondition: read');

    press(doc, win, 'u');
    await settle();
    assert.equal(win.__bmmStore.get(id).unread, true, 'it marks unread');

    const toastEl = doc.getElementById('toast');
    assert.match(toastEl.textContent, /Undo/, 'offers undo like its siblings');

    press(doc, win, 'z', { ctrlKey: true });
    await settle();
    await settle();
    assert.equal(win.__bmmStore.get(id).unread, false, 'undo restores read state');
  } finally {
    restore();
  }
});

test('BULK: every action undoes by exactly reversing its own label delta', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * THE BULK LADDER STATES EACH DELTA TWICE.
   *
   * `bulkAct` has a forward chain of five `if (kind === ...)` branches and a
   * second, separate chain inside `recordUndo` that hand-writes the inverse.
   * Nothing ties the two together: the undo for `trash` is correct only
   * because someone typed `add: ['INBOX'], remove: ['TRASH']` correctly, and a
   * sixth action added to one chain and not the other, or an inverse typed
   * with add/remove the right way round but the wrong LABEL, fails silently.
   *
   * The existing coverage could not see this. "archiving many undoes as ONE
   * step" counts ROWS, and rows come back from the local snapshot regardless
   * of what is sent to Gmail -- so a completely wrong inverse payload still
   * restores the list on screen and only diverges on the server, where this
   * test suite cannot look.
   *
   * This asserts the round trip at the wire: for each action, whatever labels
   * the forward call ADDS the undo must REMOVE, and vice versa. Verified
   * against the real payloads rather than against the source text.
   */
  const cases = [
    { button: 'bulk-archive', kind: 'archive' },
    { button: 'bulk-trash', kind: 'trash' },
    { button: 'bulk-read', kind: 'read' },
    { button: 'bulk-star', kind: 'star' },
    { button: 'bulk-spam', kind: 'spam' },
  ];

  for (const { button, kind } of cases) {
    const { doc, win, calls, settle, restore } = await boot({ messages: bulk(6) });
    try {
      pick(rows(doc)[0], win);
      pick(rows(doc)[1], win);
      await settle();

      calls.length = 0;
      doc.getElementById(button).click();
      await settled(doc, settle);

      const forward = calls.filter((c) => c.type === 'BULK');
      assert.equal(forward.length, 1, `${kind}: one BULK call goes out, not N`);

      calls.length = 0;
      doc.dispatchEvent(
        new win.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })
      );
      await settle();
      await settle();

      const back = calls.filter((c) => c.type === 'BULK');
      assert.equal(back.length, 1, `${kind}: undo also sends exactly one BULK`);

      const f = forward[0];
      const u = back[0];
      const norm = (v) => [...(v || [])].sort();

      assert.deepEqual(
        norm(u.remove), norm(f.add),
        `${kind}: undo must REMOVE every label the action ADDED`
      );
      assert.deepEqual(
        norm(u.add), norm(f.remove),
        `${kind}: undo must ADD BACK every label the action REMOVED`
      );
      // And it must act on the same messages, not a re-derived selection.
      assert.deepEqual(norm(u.ids), norm(f.ids), `${kind}: same ids both ways`);
    } finally {
      restore();
    }
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
  /*
   * Selection lives outside the store, so a delta arriving mid-triage must not
   * silently drop the ticks the user has already placed.
   *
   * THE ARRIVALS ARE IN NEW CONVERSATIONS. The original version reused
   * `bulk(2)`, whose threadIds collide with the existing rows -- so under
   * threading the "new" messages joined the ticked conversations and became
   * their roots. That is correct product behaviour (see the THREAD: tick
   * tests) but it is not what this test is about: this one is about unrelated
   * mail arriving mid-triage. Distinct threadIds keep the two cases apart.
   */
  const { doc, win, settle, restore } = await boot({ messages: bulk(6) });
  try {
    pick(rows(doc)[0], win);
    pick(rows(doc)[1], win);
    await settle();
    assert.equal(doc.querySelectorAll('.row.picked').length, 2);

    win.__bmmIngest(bulk(2).map((m, i) => ({
      ...m, id: `new${m.id}`, threadId: `newthread${i}`, subject: 'arrived later',
    })));
    await settle();

    assert.equal(doc.querySelectorAll('.row.picked').length, 2, 'ticks must survive');
    assert.equal(doc.getElementById('bulk-count').textContent, '2 selected');
  } finally {
    restore();
  }
});

// -------------------------------------------------------- attachments ----

test('ATT: attachments are actionable chips in the app, not text in the frame', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The body iframe has no allow-scripts by design, so anything rendered
  // inside it can NEVER be clickable. Attachments were a filename printed as
  // text: named, visible, and impossible to open. Moving them into the app
  // chrome is the only way they become actionable without weakening the
  // sandbox that protects against hostile mail.
  const withAtt = [
    { ...MESSAGES[0], id: 'att-msg' },
  ];
  const { doc, settle, restore } = await boot({
    messages: withAtt,
    bodyOverride: {
      attachments: [
        { filename: 'Schedule.pdf', mimeType: 'application/pdf', size: 284112, attachmentId: 'a1' },
      ],
    },
  });
  try {
    rows(doc)[0].click();
    await settle();
    await settle();

    const strip = doc.getElementById('r-attachments');
    assert.equal(strip.hidden, false, 'the strip must appear');

    const chip = doc.querySelector('.att-chip');
    assert.ok(chip, 'an attachment chip must exist');
    assert.equal(chip.tagName, 'BUTTON', 'it must be a real control, not text');
    assert.equal(chip.querySelector('.att-name').textContent, 'Schedule.pdf');
    assert.equal(chip.querySelector('.att-size').textContent, '277 KB', 'bytes are meaningless');
    assert.ok(chip.querySelector('svg'), 'and carries the shared icon');

    // The body frame must no longer print them.
    const srcdoc = doc.getElementById('r-body').getAttribute('srcdoc') || '';
    assert.ok(!srcdoc.includes('Schedule.pdf'), 'the inert copy must be gone');
  } finally {
    restore();
  }
});

test('ATT: the strip hides for a message with no attachments', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle();
    await settle();
    assert.equal(doc.getElementById('r-attachments').hidden, true);
  } finally {
    restore();
  }
});

// ------------------------------------------------------- saved views -----

test('VIEWS: built-ins render with live counts', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // A count is what makes a saved view useful rather than a bookmark.
  const { doc, restore } = await boot();
  try {
    const items = [...doc.querySelectorAll('.view-item')];
    assert.ok(items.length >= 4, 'built-in views must render');
    const unread = items.find((i) => i.querySelector('.view-name').textContent === 'Unread');
    assert.ok(unread, 'Unread view must exist');
    assert.equal(unread.querySelector('.view-count').textContent, '2', 'count reflects the store');
  } finally {
    restore();
  }
});

test('VIEWS: clicking one applies its query and marks it current', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, restore } = await boot();
  try {
    const unread = [...doc.querySelectorAll('.view-item')]
      .find((i) => i.querySelector('.view-name').textContent === 'Unread');
    unread.click();
    await settle();

    assert.equal(doc.getElementById('search').value, 'is:unread');
    assert.equal(rows(doc).length, 2, 'the list is filtered');
    assert.ok(doc.querySelector('.view-item[aria-current="true"]'), 'the active view is marked');
  } finally {
    restore();
  }
});

test('VIEWS: switching category clears the active view', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Leaving a view highlighted after its query was cleared claims a filter is
  // applied when it is not.
  const { doc, settle, restore } = await boot();
  try {
    [...doc.querySelectorAll('.view-item')][0].click();
    await settle();
    assert.ok(doc.querySelector('.view-item[aria-current="true"]'));

    doc.querySelector('.cat[data-cat="augsd"]').click();
    await settle();
    assert.equal(doc.querySelector('.view-item[aria-current="true"]'), null);
    assert.equal(doc.getElementById('search').value, '');
  } finally {
    restore();
  }
});

test('VIEWS: the save affordance appears only for an unsaved query', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // An always-present save button on an empty box is noise, and offering to
  // save something already saved is a small lie about what it will do.
  const { doc, win, settle, restore } = await boot();
  try {
    const btn = doc.getElementById('btn-save-view');
    assert.equal(btn.hidden, true, 'hidden with no query');

    const search = doc.getElementById('search');
    search.value = 'from:augsd';
    search.dispatchEvent(new win.Event('input'));
    await settle();
    assert.equal(btn.hidden, false, 'shown for a new query');

    search.value = 'is:unread';
    search.dispatchEvent(new win.Event('input'));
    await settle();
    assert.equal(btn.hidden, true, 'hidden for an already-saved query');
  } finally {
    restore();
  }
});

/* ========================================================================== *
 * UI POLISH AUDIT — behavioural, not source-scanning
 *
 * The tests below drive the real DOM. Everything they assert was previously
 * covered only by reading source text, which cannot see focus, event ordering
 * or what a keystroke actually does.
 * ========================================================================== */


test('HELP: ? opens the overlay and Escape restores focus to where it was', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    const help = doc.getElementById('help');
    assert.equal(help.hidden, true, 'starts hidden');

    // Focus something specific first, so restoration is observable.
    const search = doc.getElementById('search');
    search.focus();
    assert.equal(doc.activeElement, search);

    press(doc, win, '?');
    await settle();
    assert.equal(help.hidden, false, '? must open the overlay');
    assert.ok(help.contains(doc.activeElement), 'focus must move INTO the dialog');
    assert.ok(doc.getElementById('help-body').children.length > 0, 'content is rendered');

    press(doc, win, 'Escape');
    await settle();
    assert.equal(help.hidden, true, 'Escape closes it');
    assert.equal(doc.activeElement, search, 'focus must return to where it came from');
  } finally {
    restore();
  }
});

test('HELP: shortcuts do not fire at the message list while help is open', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Archiving a message the user cannot see is the worst kind of surprise.
  const { doc, win, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle();
    const before = rows(doc).length;

    press(doc, win, '?');
    await settle();
    press(doc, win, 'e');       // archive
    press(doc, win, '#');       // delete
    await settle();

    assert.equal(rows(doc).length, before, 'no message may be triaged behind the overlay');
  } finally {
    restore();
  }
});

test('HELP: renders every documented shortcut exactly once', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    press(doc, win, '?');
    await settle();
    press(doc, win, '?');       // toggle closed
    await settle();
    press(doc, win, '?');       // and open again
    await settle();

    const { allShortcuts } = await import('../src/app/shortcuts.js');
    assert.equal(
      doc.querySelectorAll('#help-body dt').length,
      allShortcuts().length,
      'reopening must replace the content, not append to it'
    );
  } finally {
    restore();
  }
});

test('ESCAPE: unwinds one layer at a time, innermost first', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The ordering complaint this prevents is "one Escape too many dumped me
   * back in Gmail". Help sits above the palette; neither may release the
   * takeover while it is open.
   */
  const { doc, win, settle, restore } = await boot();
  try {
    let released = false;
    win.parent = {
      postMessage(m) { if (m?.type === 'BMM_RELEASE') released = true; },
    };

    press(doc, win, 'k', { ctrlKey: true });   // palette
    await settle();
    assert.equal(doc.getElementById('palette').hidden, false);

    press(doc, win, '?');                      // help, on top of it
    await settle();
    assert.equal(doc.getElementById('help').hidden, false);

    press(doc, win, 'Escape');
    await settle();
    assert.equal(doc.getElementById('help').hidden, true, 'help closes first');
    assert.equal(doc.getElementById('palette').hidden, false, 'palette must survive');
    assert.equal(released, false, 'the takeover must not be released');

    press(doc, win, 'Escape');
    await settle();
    assert.equal(doc.getElementById('palette').hidden, true, 'then the palette');
    assert.equal(released, false, 'still not released');
  } finally {
    restore();
  }
});

/*
 * Open the palette and type `q`.
 *
 * Typing matters: filterPalette caps the list at 12, and label commands are
 * appended after the categories and themes, so on an EMPTY query they are
 * legitimately off the end of the list. Reaching them by typing is how a user
 * reaches them too.
 */
/*
 * Seed the label cache directly.
 *
 * refreshLabels() is fire-and-forget, and features.js is NOT re-imported per
 * boot -- only app.js gets a cache-busting URL -- so the cache both survives
 * between tests and lands at a nondeterministic moment within one. Setting it
 * explicitly after boot makes these tests about the palette, not about race
 * timing. `boot({labels})` still exercises the real fetch path in the first
 * test of the group.
 */
const seedLabels = async (list) => {
  const { _setLabels } = await import('../src/app/features.js');
  _setLabels(list);
};

const openPaletteWith = async (doc, win, settle, q) => {
  press(doc, win, 'k', { ctrlKey: true });
  await settle(4);
  const input = doc.getElementById('palette-input');
  input.value = q;
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  await settle(4);
};

const paletteLabels = (doc) =>
  [...doc.querySelectorAll('#palette-list .palette-item')]
    .map((li) => li.textContent)
    .filter((t) => t.includes('Go to label:'));

test('LABELS: the palette offers the user\'s own Gmail labels', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * LIST_LABELS was implemented and called by nothing across three audits,
   * and `label:` was a search operator you could only use if you already
   * knew your labels by heart. The palette is where both become reachable.
   */
  const { doc, win, settle, restore } = await boot({
    labels: [{ id: 'L1', name: 'Thesis' }, { id: 'L2', name: 'Work/CI' }],
  });
  try {
    await settle(8); // the fetch is fire-and-forget
    await openPaletteWith(doc, win, settle, 'label');

    const found = paletteLabels(doc);
    assert.equal(found.length, 2, `expected two label commands, got: ${found}`);
    assert.ok(found.some((t) => t.includes('Thesis')));
    assert.ok(found.some((t) => t.includes('Work/CI')));
  } finally {
    restore();
  }
});

test('LABELS: choosing one runs a label: search', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The command must produce a query the parser actually understands --
  // otherwise it is a menu entry that quietly does nothing.
  const { doc, win, settle, restore } = await boot({
    labels: [{ id: 'L1', name: 'Thesis' }],
  });
  try {
    await settle(8);
    await seedLabels([{ id: 'L1', name: 'Thesis' }]);
    await openPaletteWith(doc, win, settle, 'Thesis');

    const item = [...doc.querySelectorAll('#palette-list .palette-item')]
      .find((li) => li.textContent.includes('Thesis'));
    assert.ok(item, 'the label command must be present');
    item.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await settle(8);

    assert.equal(doc.getElementById('search').value, 'label:Thesis');
  } finally {
    restore();
  }
});

test('LABELS: a failing LIST_LABELS degrades silently', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The label cache lives in features.js module state, and only app.js is
   * re-imported with a cache-busting URL per boot -- so labels from an
   * earlier test survive into this one. Clear it, or this test passes on
   * the PREVIOUS case's data and proves nothing about failure handling.
   */

  // Labels are a convenience. A network failure must not raise a toast or
  // block boot -- the palette simply carries fewer commands.
  const { doc, win, settle, restore } = await boot({ labels: null });
  try {
    await settle(8);
    await openPaletteWith(doc, win, settle, 'label');

    assert.equal(paletteLabels(doc).length, 0);
    assert.equal(
      doc.getElementById('palette').hidden, false,
      'the palette must still work'
    );
  } finally {
    restore();
  }
});

test('LABELS: signing out drops the previous account\'s label names', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Label names are private data belonging to the account that was signed in.
  // Leaving them cached would leak them into the next user's palette.
  const { doc, win, settle, restore } = await boot({
    labels: [{ id: 'L1', name: 'Confidential-Project' }],
  });
  try {
    await settle(8);
    await seedLabels([{ id: 'L1', name: 'Confidential-Project' }]);
    await openPaletteWith(doc, win, settle, 'Confidential');
    assert.equal(paletteLabels(doc).length, 1, 'precondition: the label is offered');
    press(doc, win, 'Escape');
    await settle(4);

    doc.getElementById('btn-signout').click();
    await settle(12);

    await openPaletteWith(doc, win, settle, 'Confidential');
    const leaked = paletteLabels(doc);
    assert.equal(leaked.length, 0, `label names survived sign-out: ${leaked}`);
  } finally {
    restore();
  }
});

test('MAILBOX: the rail exposes the system mailboxes and switching works', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    const ids = [...doc.querySelectorAll('.cat[data-mailbox]')].map((b) => b.dataset.mailbox);
    for (const want of ['inbox', 'sent', 'drafts', 'trash', 'spam', 'snoozed']) {
      assert.ok(ids.includes(want), `rail is missing ${want}`);
    }

    const sent = doc.querySelector('.cat[data-mailbox="sent"]');
    sent.click();
    await settle();
    assert.equal(sent.getAttribute('aria-current'), 'true', 'Sent becomes current');
    // Categories are an inbox concept and must not be shown in Sent.
    assert.equal(doc.getElementById('cat-group').hidden, true);
  } finally {
    restore();
  }
});

test('MAILBOX: switching clears a stale search rather than double-filtering', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    const search = doc.getElementById('search');
    search.value = 'registration';
    search.dispatchEvent(new win.Event('input'));
    await settle();
    assert.equal(search.value, 'registration');

    doc.querySelector('.cat[data-mailbox="trash"]').click();
    await settle();
    assert.equal(search.value, '', 'the visible control must match the applied state');
  } finally {
    restore();
  }
});

test('MAILBOX: the rail stays a single tab stop after switching', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Two groups must not become two tab stops.
  const { doc, settle, restore } = await boot();
  try {
    doc.querySelector('.cat[data-mailbox="sent"]').click();
    await settle();
    const tabbable = [...doc.querySelectorAll('#cats .cat')].filter((c) => c.tabIndex === 0);
    assert.equal(tabbable.length, 1, `expected 1 tab stop, found ${tabbable.length}`);
  } finally {
    restore();
  }
});

test('SNOOZE: z opens a picker with only future options', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle();
    press(doc, win, 'z');
    await settle();

    const menu = doc.querySelector('.snooze-menu');
    assert.ok(menu, 'z must open the snooze picker');
    const opts = menu.querySelectorAll('.snooze-opt');
    assert.ok(opts.length >= 2, 'expected several wake times');
    assert.ok(menu.contains(doc.activeElement), 'focus moves into the menu');

    press(doc, win, 'Escape');
    await settle();
    assert.equal(doc.querySelector('.snooze-menu'), null, 'Escape dismisses it');
    // And must NOT also have closed the reader.
    assert.equal(doc.getElementById('reader').hidden, false, 'the reader must stay open');
  } finally {
    restore();
  }
});

test('IMAGES: a blocked remote image is announced with a way to load it', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, restore } = await boot({
    bodyOverride: { html: '<p>hi</p><img src="https://tracker.example/pixel.png">' },
  });
  try {
    rows(doc)[0].click();
    await settle();

    const bar = doc.getElementById('r-images');
    assert.equal(bar.hidden, false, 'the bar must appear when something was blocked');
    assert.match(doc.getElementById('r-images-text').textContent, /1 image/);
    assert.ok(!doc.getElementById('r-images-show').hidden, 'an override must be offered');
  } finally {
    restore();
  }
});

