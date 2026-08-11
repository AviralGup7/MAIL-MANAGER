/*
 * PART TWO OF THE INTEGRATION SUITE.
 *
 * Split from app.integration.test.mjs for MEMORY, not for organisation.
 *
 * Every boot() builds a full JSDOM document -- DOM tree, CSSOM, timers,
 * listeners, an ES module graph. The harness calls win.close() so each becomes
 * collectable, and that bought headroom to ~195 tests. Past that the file
 * aborted with SIGABRT on a machine with 1984 MB of RAM, which surfaces as a
 * test failure with no assertion attached and sends you hunting a logic bug
 * that is not there.
 *
 * Node runs each test FILE in its own process, so splitting halves the peak
 * live set. Measured before splitting: a 900MB heap died at 111 tests, 1100MB
 * at 143, 1400MB at ~190. Growth, not GC pressure -- a bigger flag was not the
 * answer.
 *
 * The header is duplicated deliberately. Sharing it through an import would
 * put both halves back into one module graph and undo the split.
 */

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
async function boot({ signedIn = true, messages = MESSAGES, storageSeed = {}, bodyOverride = {}, syncLatency = 0, perLabel = false, emptyLabels = [], labels = [], timetableData = null, storageTimetable = undefined, deadWorker = false, failVerbs = [], draftAttachments = false, failHydration = false } = {}) {
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
    bodyOverride, failVerbs, draftAttachments, failHydration,
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


test('IMAGES: no bar appears for a message with no remote images', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // A privacy notice on a plain-text mail is noise that trains people to
  // ignore the notice when it matters.
  const { doc, settle, restore } = await boot({
    bodyOverride: { html: '<p>just text</p>' },
  });
  try {
    rows(doc)[0].click();
    await settle();
    assert.equal(doc.getElementById('r-images').hidden, true);
  } finally {
    restore();
  }
});

test('READER: actions that cannot work are hidden, not left dead', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle();
    const archive = doc.querySelector('#r-actions [data-act="archive"]');
    assert.equal(archive.hidden, false, 'archive is meaningful in the inbox');

    doc.querySelector('.cat[data-mailbox="trash"]').click();
    await settle();
    // Archiving something already deleted does nothing; the control must go.
    assert.equal(archive.hidden, true, 'archive must be hidden in Trash');
  } finally {
    restore();
  }
});

/* ========================================================================== *
 * INCREMENTAL RENDER
 *
 * The store emits `{changed, structural}` and `scheduleRender` has a per-id
 * fast path for non-structural changes. The subscriber used to DISCARD that
 * payload, so every change fell back to `structural: true` and re-filled the
 * whole list. Measured at 2000 rows: starring one message cost 549ms of render
 * work; forwarding the detail brought it to 8ms and made it constant-time.
 * ========================================================================== */

test('PERF: a content-only change touches ONE row, not the whole list', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    win.__bmmIngest(bulk(60));
    await settle();
    assert.ok(rows(doc).length >= 60, 'need a list worth measuring');

    /*
     * Count how many rows are VISITED, not how many DOM writes happen.
     *
     * The first version of this test spied on `textContent` and passed even
     * with the O(n) path restored -- because `setText` already guards on
     * equality, so re-filling 2000 unchanged rows performs zero writes. It
     * measured a no-op and proved nothing.
     *
     * The real cost is the WALK: reading every message out of the store and
     * running fillRow against it. `dataset` is touched once per fillRow, so a
     * setter on it counts visits exactly.
     */
    const visited = new Set();
    for (const row of rows(doc)) {
      const star = row.querySelector('.r-star');
      if (!star) continue;
      const real = star.getAttribute.bind(star);
      star.getAttribute = (name) => {
        if (name === 'aria-pressed') visited.add(row.id);
        return real(name);
      };
    }

    win.__bmmStore.patch(win.__bmmStore.idsFor('all')[3], { starred: true });
    await settle();

    assert.ok(
      visited.size <= 1,
      `a one-message change walked ${visited.size} rows; it must visit at most 1`
    );
  } finally {
    restore();
  }
});

test('PERF: the subscriber forwards the change detail rather than dropping it', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Guards the exact regression: `s.subscribe(() => scheduleRender())` silently
  // re-enables the O(n) path because the parameter defaults to structural.
  const src = readFileSync(join(ROOT, 'src/app/app.js'), 'utf8');
  assert.match(
    src, /s\.subscribe\(\(detail\) => \{[\s\S]{0,160}scheduleRender\(detail\)/,
    'the store payload must reach scheduleRender'
  );
});

test('PERF: a structural change still re-renders the list', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The optimisation must not break the case it is an optimisation OF: new
  // mail changes the id list and has to produce new rows.
  const { doc, win, settle, restore } = await boot();
  try {
    const before = rows(doc).length;
    win.__bmmIngest(bulk(5).map((m) => ({ ...m, id: `fresh${m.id}`, subject: 'brand new' })));
    await settle();
    assert.equal(rows(doc).length, before + 5, 'new messages must appear');
    assert.ok(rowText(doc).includes('brand new'));
  } finally {
    restore();
  }
});

/* ========================================================================== *
 * CONCURRENCY — per-mailbox load state
 *
 * `state.loading` was a single global boolean guarding work that is
 * per-mailbox. Switching to Sent and then immediately to Trash while Sent was
 * still in flight made Trash's load return early, and because selectMailbox
 * only loads `if (!mbState(id).loaded)`, NOTHING ever retried it — the mailbox
 * stayed permanently empty for the rest of the session, with no error and no
 * spinner.
 * ========================================================================== */

const clickMailbox = (doc, id) => doc.querySelector(`.cat[data-mailbox="${id}"]`).click();
const subjects = (doc) => [...doc.querySelectorAll('#list .r-subj')].map((e) => e.textContent);
const currentMailbox = (doc) =>
  doc.querySelector('.cat[data-mailbox][aria-current="true"]')?.dataset.mailbox;

test('RACE: switching away mid-load still loads the second mailbox', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, restore } = await boot({ syncLatency: 60, perLabel: true });
  try {
    clickMailbox(doc, 'sent');
    await new Promise((r) => setTimeout(r, 10)); // before Sent responds
    clickMailbox(doc, 'trash');
    await new Promise((r) => setTimeout(r, 400));
    await settle(12);

    assert.equal(currentMailbox(doc), 'trash');
    const rows = subjects(doc);
    assert.ok(rows.length > 0, 'Trash never loaded — the global flag swallowed its fetch');
    assert.ok(
      rows.every((s) => s.startsWith('trash')),
      `cross-mailbox leak: ${JSON.stringify(rows.slice(0, 3))}`
    );
  } finally {
    restore();
  }
});

test('RACE: a mailbox skipped once can still be loaded later', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The permanent half of the bug: `loaded` was never set, but nothing retried.
  const { doc, settle, restore } = await boot({ syncLatency: 60, perLabel: true });
  try {
    clickMailbox(doc, 'sent');
    await new Promise((r) => setTimeout(r, 10));
    clickMailbox(doc, 'trash');
    await new Promise((r) => setTimeout(r, 400));
    await settle(10);

    clickMailbox(doc, 'inbox');
    await settle(6);
    clickMailbox(doc, 'trash');
    await new Promise((r) => setTimeout(r, 400));
    await settle(10);

    assert.ok(subjects(doc).length > 0, 'Trash is permanently empty after being skipped once');
  } finally {
    restore();
  }
});

test('RACE: rapid switching across every mailbox ends consistent', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, restore } = await boot({ syncLatency: 40, perLabel: true });
  try {
    for (const m of ['sent', 'spam', 'trash', 'drafts', 'starred', 'inbox']) {
      clickMailbox(doc, m);
      await new Promise((r) => setTimeout(r, 12));
    }
    await new Promise((r) => setTimeout(r, 600));
    await settle(14);

    assert.equal(currentMailbox(doc), 'inbox');
    const rows = subjects(doc);
    assert.ok(rows.length > 0, 'the final mailbox must be populated');
    assert.ok(
      rows.every((s) => s.startsWith('inbox')),
      `stale rows from another mailbox: ${JSON.stringify(rows.slice(0, 3))}`
    );
  } finally {
    restore();
  }
});

test('RACE: the busy indicator clears only when nothing is loading', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Derived from every mailbox's flag, so a fast mailbox finishing cannot
  // switch off the spinner belonging to a slow one still in flight.
  const { doc, settle, restore } = await boot({ syncLatency: 60, perLabel: true });
  try {
    clickMailbox(doc, 'sent');
    await new Promise((r) => setTimeout(r, 10));
    clickMailbox(doc, 'trash');
    await new Promise((r) => setTimeout(r, 500));
    await settle(12);
    assert.equal(
      doc.getElementById('shell').getAttribute('aria-busy'), 'false',
      'the spinner must clear once every load has settled'
    );
  } finally {
    restore();
  }
});

test('RACE: loading state is derived, never assigned from two places', async () => {
  // The root cause was one boolean standing for several independent
  // operations. Assert there is exactly one writer.
  const src = readFileSync(join(ROOT, 'src/app/app.js'), 'utf8');
  const writes = [...src.matchAll(/state\.loading\s*=/g)].length;
  assert.equal(writes, 1, `state.loading is assigned in ${writes} places; it must be derived once`);
  assert.match(src, /state\.loading = \[\.\.\.mailboxState\.values\(\)\]\.some/);
});

/* ========================================================================== *
 * LONG SESSION — resource stability
 *
 * The takeover is a long-lived page: a user may keep it open all day. Menus,
 * overlays and mailbox switches each build DOM, and anything that appends
 * without replacing accumulates invisibly until the tab is slow.
 * ========================================================================== */

test('LEAK: 100 mixed interactions do not grow the DOM', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot({ perLabel: true });
  try {
    const nodes = () => doc.body.querySelectorAll('*').length;
    const transient = () =>
      doc.querySelectorAll('.snooze-menu, .cat-menu, .ac-list:not([hidden])').length;

    // Warm every surface once, so one-time construction is not counted as growth.
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: '?', bubbles: true }));
    await settle(2);
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(2);
    const baseline = nodes();

    for (let i = 0; i < 20; i++) {
      for (const m of ['sent', 'trash', 'inbox']) {
        doc.querySelector(`.cat[data-mailbox="${m}"]`).click();
        await settle(1);
      }
      doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: '?', bubbles: true }));
      await settle(1);
      doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(1);
    }

    assert.equal(transient(), 0, 'a transient menu survived its dismissal');
    assert.equal(
      nodes(), baseline,
      `DOM grew from ${baseline} to ${nodes()} across 100 interactions`
    );
  } finally {
    restore();
  }
});

test('LEAK: reopening the help overlay replaces its content', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Appending instead of replacing is the classic version of this bug and is
  // invisible until the overlay is opened dozens of times.
  const { doc, win, settle, restore } = await boot();
  try {
    let previous = null;
    for (const round of [1, 2, 3]) {
      doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: '?', bubbles: true }));
      await settle(2);
      const count = doc.querySelectorAll('#help-body dt').length;
      if (previous !== null) {
        assert.equal(count, previous, `help content grew on open ${round}`);
      }
      previous = count;
      doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(2);
    }
    assert.ok(previous > 10, 'the overlay should actually have content');
  } finally {
    restore();
  }
});

/* ========================================================================== *
 * SIGN-OUT MUST ERASE THE WHOLE ACCOUNT
 *
 * `resetView()` called `store.clear()`, but `store` is a live binding onto the
 * ACTIVE mailbox. Signing out while viewing the inbox therefore cleared the
 * inbox and left Sent, Trash, Spam and Drafts fully populated in memory: the
 * gate appeared, and one click showed the previous account's mail.
 *
 * The per-mailbox store refactor introduced this. `resetView` was written when
 * there was one store, and "clear the store" quietly stopped meaning "clear
 * everything".
 *
 * A second defect compounded it: `state.signedIn` was assigned in three places
 * and READ NOWHERE, so clicking a mailbox behind the gate issued a fresh
 * SYNC_PAGE and repainted mail for a session that had ended.
 * ========================================================================== */

test('SIGNOUT: no mailbox retains the previous account', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, restore } = await boot({ perLabel: true });
  try {
    // Populate several mailboxes before signing out.
    for (const m of ['sent', 'trash']) {
      doc.querySelector(`.cat[data-mailbox="${m}"]`).click();
      await settle(4);
    }
    doc.querySelector('.cat[data-mailbox="inbox"]').click();
    await settle(4);
    assert.ok(rows(doc).length > 0, 'need populated mailboxes to test the reset');

    doc.getElementById('btn-signout').click();
    await settle(12);
    assert.equal(doc.getElementById('gate').hidden, false, 'the gate must be shown');

    for (const m of ['sent', 'trash', 'inbox', 'spam', 'drafts']) {
      doc.querySelector(`.cat[data-mailbox="${m}"]`).click();
      await settle(4);
      assert.equal(
        rows(doc).length, 0,
        `${m} still shows the previous account's mail after signing out`
      );
    }
  } finally {
    restore();
  }
});

test('SIGNOUT: no network request is issued for an ended session', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, calls, settle, restore } = await boot({ perLabel: true });
  try {
    doc.getElementById('btn-signout').click();
    await settle(12);
    const before = calls.filter((c) => c.type === 'SYNC_PAGE').length;

    for (const m of ['sent', 'trash', 'spam']) {
      doc.querySelector(`.cat[data-mailbox="${m}"]`).click();
      await settle(4);
    }
    doc.getElementById('btn-refresh').click();
    await settle(6);

    assert.equal(
      calls.filter((c) => c.type === 'SYNC_PAGE').length, before,
      'a signed-out session must not fetch'
    );
  } finally {
    restore();
  }
});

test('SIGNOUT: state is reset to the inbox with no stale query', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Leaving the rail pointing at Trash, or a query applied, would greet the
  // NEXT user with the previous session's view.
  const { doc, win, settle, restore } = await boot({ perLabel: true });
  try {
    const search = doc.getElementById('search');
    search.value = 'registration';
    search.dispatchEvent(new win.Event('input'));
    await settle(4);
    doc.querySelector('.cat[data-mailbox="trash"]').click();
    await settle(4);

    doc.getElementById('btn-signout').click();
    await settle(12);

    assert.equal(search.value, '', 'a stale query survived sign-out');
    assert.equal(
      doc.querySelector('.cat[data-mailbox][aria-current="true"]')?.dataset.mailbox,
      'inbox',
      'the rail must return to the inbox'
    );
  } finally {
    restore();
  }
});

test('SIGNOUT: signing back in still works', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The guards must not wedge the app shut: `state.signedIn` gates fetching,
  // so a sign-in that failed to clear it would leave a permanently empty app.
  const { doc, settle, restore } = await boot({ perLabel: true });
  try {
    doc.getElementById('btn-signout').click();
    await settle(12);
    assert.equal(rows(doc).length, 0);

    doc.getElementById('btn-signin').click();
    await settle(14);

    assert.equal(doc.getElementById('gate').hidden, true, 'the gate should close');
    assert.ok(rows(doc).length > 0, 'mail must load again after signing back in');
  } finally {
    restore();
  }
});

/* ========================================================================== *
 * CROSS-MODULE INTERACTIONS
 *
 * Each module is now well covered in isolation. These exercise the SEAMS —
 * selection against rules, search against mute, bulk actions against a list
 * that changed underneath the selection.
 * ========================================================================== */

test('SEAM: a bulk action never touches mail hidden by a mute rule', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * Select everything, THEN mute a category. The selection still holds ids
   * that are no longer rendered. Acting on invisible mail would be
   * unrecoverable from the user's point of view: they archived things they
   * could not see and were never shown.
   *
   * `bulkAct` resolves through `selection.live(store, renderedIds)`, and
   * renderedIds is the VISIBLE list — so the safety comes from the data flow
   * rather than from a special case. This pins it.
   */
  const { doc, win, calls, settle, restore } = await boot();
  try {
    const total = rows(doc).length;
    assert.ok(total >= 3, 'need several messages');

    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    await settle(4);

    // Mute the first non-"all" category that actually has messages.
    const cat = [...doc.querySelectorAll('.cat[data-cat]')]
      .find((b) => b.dataset.cat !== 'all' && b.lastElementChild.textContent.trim() !== '');
    if (!cat) return; // nothing classified into a mutable category in this fixture

    cat.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await settle(4);
    const muteOption = doc.querySelector('.cat-menu .snooze-opt');
    assert.ok(muteOption, 'the category rule menu should open');
    muteOption.click();
    await settle(8);

    const visible = new Set([...doc.querySelectorAll('#list .row')].map((r) => r.dataset.id));
    doc.getElementById('bulk-archive')?.click();
    await settle(10);

    const bulk = calls.filter((c) => c.type === 'BULK').flatMap((c) => c.ids || []);
    for (const id of bulk) {
      assert.ok(visible.has(id), `bulk acted on ${id}, which the mute rule had hidden`);
    }
  } finally {
    restore();
  }
});

test('SEAM: an explicit search overrides a mute rule', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * Muting means "stop competing for my attention", never "hide from me when
   * I ask directly". A search that silently omitted muted mail would be the
   * feature quietly losing the user's messages.
   *
   * The first version searched for a broad substring and proved nothing; this
   * one identifies the exact subjects the mute removed and asserts THOSE come
   * back.
   *
   * A note on why deleting `applyMute`'s `if (state.query) return ids` guard
   * does NOT fail this test: `visibleIds()` only calls `applyMute` on the
   * no-query branch, so the search path never reaches that line. The guard is
   * defensive redundancy against a future caller, not the mechanism — the
   * mechanism is the branch in `visibleIds`. Verified by tracing both paths
   * rather than assumed, after the mutation appeared to survive.
   */
  const { doc, win, settle, restore } = await boot();
  try {
    const before = rowText(doc);
    const cat = [...doc.querySelectorAll('.cat[data-cat]')]
      .find((b) => b.dataset.cat !== 'all' && b.lastElementChild.textContent.trim() !== '');
    if (!cat) return;

    cat.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await settle(4);
    doc.querySelector('.cat-menu .snooze-opt')?.click();
    await settle(8);

    const afterMute = rowText(doc);
    const hidden = before.filter((s2) => !afterMute.includes(s2));
    assert.ok(hidden.length > 0, 'the mute should actually hide something');

    // Search for a word taken from a message the mute removed.
    const term = hidden[0].split(/\s+/).find((w) => w.length > 4) || hidden[0];
    const search = doc.getElementById('search');
    search.value = term;
    search.dispatchEvent(new win.Event('input'));
    await settle(6);

    assert.ok(
      rowText(doc).some((s2) => s2 === hidden[0]),
      `searching "${term}" did not surface the muted message "${hidden[0]}" — ` +
      'muted mail became unfindable'
    );
  } finally {
    restore();
  }
});

test('SEAM: selection does not survive a mailbox switch', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Carrying a selection into another mailbox means the bulk bar reports a
  // count for messages that are not on screen, and acting is unpredictable.
  const { doc, win, settle, restore } = await boot({ perLabel: true });
  try {
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    await settle(4);

    doc.querySelector('.cat[data-mailbox="sent"]').click();
    await settle(8);

    const bar = doc.getElementById('bulk-bar');
    assert.ok(!bar || bar.hidden, 'the bulk bar survived a mailbox switch');
  } finally {
    restore();
  }
});

/* ========================================================================== *
 * ARCHITECTURAL BOUNDARIES
 *
 * `ctx` is the declared contract between app.js and features.js. It is the
 * only sanctioned path across that boundary, so its correctness is structural
 * rather than cosmetic.
 * ========================================================================== */

test('ARCH: ctx.store follows the active mailbox, it is not frozen to the inbox', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * `store` is a `let` rebound on every mailbox switch, but `ctx` was built
   * once with `store,` — capturing the INBOX store by value forever. Every
   * consumer in features.js then read the inbox regardless of what the user
   * was looking at: the deadline radar scanned inbox mail while Trash was
   * open, and contact autocomplete suggested inbox senders while composing
   * from Sent.
   *
   * Publishing a live binding through a frozen object is the general form of
   * this error; the getter is the general fix.
   */
  const { doc, win, settle, restore } = await boot({ perLabel: true });
  try {
    doc.querySelector('.cat[data-mailbox="sent"]').click();
    await settle(8);

    doc.getElementById('btn-compose').click();
    await settle(6);

    const to = doc.getElementById('c-to');
    const suggestionsFor = async (text) => {
      to.value = text;
      to.dispatchEvent(new win.Event('input'));
      await settle(6);
      return [...doc.querySelectorAll('#c-to-list .ac-opt')].length;
    };

    // The `perLabel` fixture names senders after their mailbox.
    assert.ok(await suggestionsFor('sent') > 0, 'Sent contacts should be offered');
    assert.equal(
      await suggestionsFor('inbox'), 0,
      'inbox contacts were offered while composing from Sent — ctx.store is stale'
    );
  } finally {
    restore();
  }
});

test('ARCH: the test seam exposes the active store too', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // `window.__bmmStore` had the identical capture-by-value flaw, which would
  // have made future tests silently assert against the wrong collection.
  const { doc, win, settle, restore } = await boot({ perLabel: true });
  try {
    const inboxSize = win.__bmmStore.size;
    doc.querySelector('.cat[data-mailbox="sent"]').click();
    await settle(8);
    const sentIds = win.__bmmStore.idsFor('all');
    assert.ok(sentIds.length > 0, 'the seam should see the Sent store');
    assert.ok(
      sentIds.every((id) => id.startsWith('sent')),
      `the seam still reports the inbox: ${JSON.stringify(sentIds.slice(0, 3))}`
    );
    assert.ok(inboxSize >= 0);
  } finally {
    restore();
  }
});

test('ARCH: the theme is owned by the settings module, not written ad hoc', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * `theme` was declared in the settings schema while `setTheme` wrote
   * `chrome.storage.local` directly and `boot()` read it directly — two
   * writers for one concept, and a schema entry that was decorative.
   *
   * Routing it through the module exposed an ordering bug: `settings.get()`
   * is synchronous, so `loadSettings()` has to run before the first read.
   * It was running much later, which would have made every launch silently
   * fall back to the default theme.
   */
  const { doc, restore } = await boot({ storageSeed: { theme: 'nord' } });
  try {
    assert.equal(
      doc.documentElement.dataset.theme, 'nord',
      'a persisted theme must survive a reload'
    );
  } finally {
    restore();
  }
});

test('ARCH: settings are loaded before anything reads one', async () => {
  // The synchronous-read contract only holds if the cache is warm first.
  // Comments blanked first, preserving offsets: the doc comment on boot()
  // explains the contract and mentions `settings.get()`, which would other-
  // wise match before the real call. Same trap as the header-parser lint.
  const src = readFileSync(join(ROOT, 'src/app/app.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  const bootAt = src.indexOf('async function boot()');
  assert.ok(bootAt > 0);
  const loadAt = src.indexOf('await settings.loadSettings()', bootAt);
  const firstGet = src.indexOf('settings.get(', bootAt);
  assert.ok(loadAt > 0, 'boot() must load settings');
  assert.ok(loadAt < firstGet, 'loadSettings() must precede the first settings.get()');
});

/* ========================================================================== *
 * DELIGHT — rows leave, they do not vanish
 *
 * Archiving is the most repeated gesture in the product and had NO motion:
 * rows animated in with a staggered cascade and disappeared mid-frame on the
 * way out. Somebody designed arrival; nobody designed departure.
 *
 * The correctness risk in animating a removal is stranding the node, so these
 * pin both halves: it must linger long enough to be seen, and it must always
 * be cleaned up.
 * ========================================================================== */

test('DELIGHT: an archived row animates out instead of vanishing', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    const before = rows(doc).length;
    rows(doc)[0].click();
    await settle(4);

    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    await settle(6);

    const leaving = doc.querySelectorAll('#list .row.leaving');
    assert.equal(leaving.length, 1, 'the departing row should be marked and still present');
    assert.ok(
      doc.getElementById('list').contains(leaving[0]),
      'it must remain IN the list while animating, or the motion is invisible'
    );
    assert.equal(rows(doc).length, before, 'it has not been removed yet');
  } finally {
    restore();
  }
});

test('DELIGHT: the departing row is always cleaned up', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The failure mode of animated removal is a stranded node. `dismissRow` uses
  // a timeout as the real mechanism and `animationend` only as an
  // optimisation, because animations do not fire in a background tab or under
  // reduced motion.
  const { doc, win, settle, restore } = await boot();
  try {
    const before = rows(doc).length;
    rows(doc)[0].click();
    await settle(4);
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'e', bubbles: true }));

    await new Promise((r) => setTimeout(r, 350));
    await settle(4);

    assert.equal(rows(doc).length, before - 1, 'the row must actually go');
    assert.equal(doc.querySelectorAll('.leaving').length, 0, 'no stranded nodes');
  } finally {
    restore();
  }
});

test('DELIGHT: a departing row cannot be addressed by the keyboard', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The row lingers in the DOM but is removed from `nodeById` immediately, so
   * `move()` (j/k), `patchRow()` and the selection can never target something
   * on its way out. Without that, pressing `j` during the animation would
   * select a message that no longer exists.
   */
  const { doc, win, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle(4);
    const archivedSubject = doc.getElementById('r-subject').textContent;

    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    await settle(6);
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    await settle(4);

    assert.notEqual(
      doc.getElementById('r-subject').textContent, archivedSubject,
      'j selected the message that was being archived'
    );
  } finally {
    restore();
  }
});

test('DELIGHT: bulk archive does not strand any of its rows', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Several rows depart at once; each gets its own timer.
  const { doc, win, settle, restore } = await boot();
  try {
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    await settle(4);
    doc.getElementById('bulk-archive')?.click();

    await new Promise((r) => setTimeout(r, 400));
    await settle(6);

    assert.equal(rows(doc).length, 0, 'every selected row should be gone');
    assert.equal(doc.querySelectorAll('.leaving').length, 0, 'no stranded nodes');
  } finally {
    restore();
  }
});

/* ========================================================================== *
 * DELIGHT — the toast becomes a real feedback channel
 *
 * One flat pill carried 21 messages in one style: success, failure and
 * undoable actions were visually identical, so every toast had to be read
 * rather than glanced at. And universal undo — the product's best idea — was
 * communicated as a text suffix.
 * ========================================================================== */

test('DELIGHT: an undoable action offers a button, not just a keyboard hint', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    const before = rows(doc).length;
    rows(doc)[0].click();
    await settle(4);
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    await settle(6);

    const toastEl = doc.getElementById('toast');
    assert.equal(toastEl.hidden, false);
    assert.equal(toastEl.dataset.kind, 'undo', 'undoable actions get their own kind');

    const action = doc.getElementById('toast-action');
    assert.equal(action.hidden, false, 'an Undo button must be offered');
    assert.equal(action.textContent, 'Undo');

    // And it must actually work — clicking restores the message.
    action.click();
    await settle(8);
    assert.equal(rows(doc).length, before, 'clicking Undo restores the row');
  } finally {
    restore();
  }
});

test('DELIGHT: failures are visually distinct from successes', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * An error that looks exactly like a success is a small betrayal of trust.
   * The kind drives a 2px edge, so the difference is peripheral rather than
   * something the user has to read for.
   */
  const { doc, win, settle, restore } = await boot();
  try {
    // The save-view flow goes through the in-app dialog (audit 39 P1), not
    // a browser prompt — the dialog must accept a name and land a success.
    const search = doc.getElementById('search');
    search.value = 'zzz-unique-query';
    search.dispatchEvent(new win.Event('input'));
    await settle(4);
    doc.getElementById('btn-save-view').click();
    await settle(4);

    const input = doc.querySelector('.prompt-box input');
    assert.ok(input, 'the in-app dialog opens instead of prompt()');
    input.value = 'My view';
    input.dispatchEvent(new win.Event('input'));
    doc.querySelector('.prompt-actions button.primary').click();
    await settle(8);

    assert.equal(doc.getElementById('toast').dataset.kind, 'success');
    assert.equal(doc.getElementById('toast-action').hidden, true, 'no action on a plain success');
    assert.equal(doc.querySelector('.prompt-box'), null, 'dialog closes after saving');
  } finally {
    restore();
  }
});

test('DELIGHT: a duplicate view name stays INSIDE the dialog, not a toast', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    const search = doc.getElementById('search');
    search.value = 'is:unread';
    search.dispatchEvent(new win.Event('input'));
    await settle(4);
    doc.getElementById('btn-save-view').click();
    await settle(4);
    const input = doc.querySelector('.prompt-box input');
    input.value = 'Mine';
    doc.querySelector('.prompt-actions button.primary').click();
    await settle(8);
    // Save the same name again — the validation error must appear in the
    // dialog, which stays open, not as a dismissive toast.
    doc.getElementById('btn-save-view').click();
    await settle(4);
    const input2 = doc.querySelector('.prompt-box input');
    input2.value = 'Mine';
    doc.querySelector('.prompt-actions button.primary').click();
    await settle(8);
    assert.ok(doc.querySelector('.prompt-box'), 'dialog stays open on a duplicate name');
    assert.match(doc.querySelector('.prompt-err').textContent, /already exists/);
  } finally {
    restore();
  }
});

test('UNDO-SEND: cancelling restores the body, signature is not stamped over it', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The outbox item's draft carries the body the user typed. Reopening it
  // must restore that body EXACTLY — a signature auto-inserted on top of a
  // restored body (or worse, replacing it) is data loss the user sees only
  // after sending (audit 40-ENG 9.2).
  const { doc, win, settle, restore } = await boot({
    storageSeed: { settings: { signature: 'Aviral Gupta' } },
  });
  try {
    doc.getElementById('btn-compose').click();
    await settle(4);
    doc.getElementById('c-to').value = 'augsd@pilani.bits-pilani.ac.in';
    doc.getElementById('c-subject').value = 'Test';
    const body = 'This is the message body I typed.';
    doc.getElementById('c-text').value = body;
    doc.getElementById('c-send').click();
    await settle(12);

    // Undo the send — the outbox cancel path reopens compose from the draft.
    doc.getElementById('toast-action').click();
    await settle(8);

    assert.equal(doc.getElementById('compose').hidden, false, 'compose reopens');
    assert.equal(
      doc.getElementById('c-text').value, body,
      'the typed body comes back exactly, with no signature stamped over it'
    );
  } finally {
    restore();
  }
});

test('DELIGHT: sending names the recipient rather than confirming a mechanism', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The fear after sending is "who did that go to", not "did the button work".
  const { doc, win, settle, restore } = await boot();
  try {
    doc.getElementById('btn-compose').click();
    await settle(4);
    doc.getElementById('c-to').value = 'augsd@pilani.bits-pilani.ac.in';
    doc.getElementById('c-subject').value = 'Test';
    doc.getElementById('c-send').click();
    await settle(12);

    /*
     * The toast now appears BEFORE the wire, not after, and its kind changed
     * from 'success' to 'undo'.
     *
     * Both follow from sending being queued. There is nothing to confirm yet
     * -- the message is held, not sent -- so claiming success would be a lie,
     * and the toast's job changed from confirmation to offering the recall.
     * 'undo' is the kind that carries an action button and a longer dwell.
     *
     * The property this test exists to protect is unchanged and still checked:
     * the toast names the RECIPIENT rather than confirming a mechanism.
     */
    const text = doc.getElementById('toast-text').textContent;
    assert.match(text, /augsd@pilani/, `expected the recipient in "${text}"`);
    assert.equal(doc.getElementById('toast').dataset.kind, 'undo');
    assert.ok(!doc.getElementById('toast-action').hidden, 'and offers Undo');
  } finally {
    restore();
  }
});

test('DELIGHT: the drain line restarts on every toast', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Re-assigning the same animation does not replay it; the reflow between is
  // what does. Without that, a second toast shows a drain line already spent.
  // toast lives in toast.js after the round-46 extraction.
  const src = readFileSync(join(ROOT, 'src/app/toast.js'), 'utf8');
  const fn = src.slice(src.indexOf('export function toast('), src.indexOf('export function hideToast('));
  assert.ok(fn.includes("style.animation = 'none'"), 'must clear before re-applying');
  assert.ok(fn.includes('offsetWidth'), 'must force a reflow between');
});


/* ========================================================================== *
 * TIMETABLE — the builder driven through the real UI
 * ========================================================================== */

/** A two-course catalogue: one with an ambiguous lab, one with a single tutorial. */
const TT_DATA = {
  schemaVersion: 1,
  semester: 'FIRST SEMESTER 2026-2027',
  courses: [
    {
      comCode: '1008', courseNo: 'CS F111', title: 'COMPUTER PROGRAMMING',
      credits: ['3', '1', '-', '-', '4'],
      sections: [
        // Exam dates mirror the real document: a numbered session is a midsem,
        // a bare one is a compre (legend sections 10 and 11).
        { section: 'L1', kind: 'lecture', instructors: ['VINTI AGARWAL'], room: '5105',
          daysHours: 'M W 3', unresolved: [], inCharge: 'VINTI AGARWAL',
          midsem: '09/10 AN2', compre: '02/12 AN',
          meetings: [
            { day: 'M', dayName: 'Monday', hour: 3, startMin: 600, endMin: 650 },
            { day: 'W', dayName: 'Wednesday', hour: 3, startMin: 600, endMin: 650 }] },
        { section: 'L2', kind: 'lecture', instructors: ['Yash Sinha'], room: '5105',
          daysHours: 'T 8', unresolved: [],
          meetings: [{ day: 'T', dayName: 'Tuesday', hour: 8, startMin: 900, endMin: 950 }] },
        { section: 'P1', kind: 'practical', instructors: ['Manasvi Singh(RS)'], room: '6117',
          daysHours: 'M 6', unresolved: [],
          meetings: [{ day: 'M', dayName: 'Monday', hour: 6, startMin: 780, endMin: 830 }] },
        { section: 'P2', kind: 'practical', instructors: ['Radhika Bohra(RS)'], room: '6118',
          daysHours: 'F 6', unresolved: [],
          meetings: [{ day: 'F', dayName: 'Friday', hour: 6, startMin: 780, endMin: 830 }] },
      ],
    },
    {
      comCode: '2863', courseNo: 'BIO F101', title: 'INTRO TO BIO SCI',
      credits: ['2', '1', '-', '-', '3'],
      sections: [
        { section: 'L1', kind: 'lecture', instructors: ['SHASHI PRAKASH SINGH'], room: '5102',
          daysHours: 'Th 2', unresolved: [],
          meetings: [{ day: 'Th', dayName: 'Thursday', hour: 2, startMin: 540, endMin: 590 }] },
        { section: 'T1', kind: 'tutorial', instructors: ['Shashi Prakash Singh'], room: '6103',
          daysHours: 'F 7', unresolved: [],
          meetings: [{ day: 'F', dayName: 'Friday', hour: 7, startMin: 840, endMin: 890 }] },
      ],
    },
  ],
  changes: [],
};

const openTT = async (doc, win, settle) => {
  doc.getElementById('btn-timetable').click();
  await settle(6);
  return doc.getElementById('tt-panel');
};

const ttSearch = async (doc, win, settle, q) => {
  const input = doc.getElementById('tt-q');
  input.value = q;
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  await settle(4);
  return [...doc.querySelectorAll('#tt-results .tt-result')];
};

test('TIMETABLE: the panel opens and offers to add a course', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot({ timetableData: TT_DATA });
  try {
    const panel = await openTT(doc, win, settle);
    assert.ok(panel, 'the timetable panel should open');
    assert.equal(panel.getAttribute('role'), 'dialog');
    assert.ok(doc.getElementById('tt-q'), 'an empty timetable offers a course search');

    const results = await ttSearch(doc, win, settle, 'CS F111');
    assert.equal(results.length, 1);
    assert.match(results[0].textContent, /COMPUTER PROGRAMMING/);
  } finally {
    restore();
  }
});

test('TIMETABLE: building a course auto-attaches a single tutorial', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * BIO F101 has exactly one tutorial, so there is no choice to make and
   * attaching it is deterministic. This is the ONLY case where a linked
   * section may be added without asking.
   */
  const { doc, win, settle, restore } = await boot({ timetableData: TT_DATA });
  try {
    await openTT(doc, win, settle);
    const results = await ttSearch(doc, win, settle, 'BIO F101');
    results[0].querySelector('button').click();
    await settle(4);

    doc.querySelector('.tt-chooser .tt-section').click();
    await settle(8);

    const { getTimetableState } = await import('../src/app/timetable-ui.js');
    const st = getTimetableState();
    assert.equal(st.entries.length, 2, 'the lecture and its only tutorial');
    assert.deepEqual(st.entries.map((e) => e.section).sort(), ['L1', 'T1']);
  } finally {
    restore();
  }
});

test('TIMETABLE: an ambiguous lab is ASKED for, never chosen for you', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * THE CENTRAL GUARANTEE, driven through the UI. CS F111 L1 has two labs and
   * the official document states no mapping between them and the lecture. The
   * builder must add the lecture and then ask.
   */
  const { doc, win, settle, restore } = await boot({ timetableData: TT_DATA });
  try {
    await openTT(doc, win, settle);
    const results = await ttSearch(doc, win, settle, 'CS F111');
    results[0].querySelector('button').click();
    await settle(4);

    // Choose lecture L1.
    const lectures = [...doc.querySelectorAll('.tt-chooser .tt-section')];
    lectures.find((b) => b.textContent.startsWith('L1')).click();
    await settle(8);

    const { getTimetableState } = await import('../src/app/timetable-ui.js');
    assert.equal(getTimetableState().entries.length, 1, 'only the lecture so far');

    const chooser = doc.querySelector('.tt-chooser');
    assert.ok(chooser, 'the builder must ask which lab');
    assert.match(chooser.textContent, /does not say which of these/,
      'and must say WHY it is asking');
    const labs = [...chooser.querySelectorAll('.tt-section')];
    assert.equal(labs.length, 2, 'both labs offered');

    labs.find((b) => b.textContent.startsWith('P2')).click();
    await settle(8);
    const st = getTimetableState();
    assert.deepEqual(st.entries.map((e) => e.section).sort(), ['L1', 'P2']);
    assert.equal(st.entries.find((e) => e.section === 'P2').linkedTo, 'L1');
  } finally {
    restore();
  }
});

test('TIMETABLE: the built timetable survives a restart', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Persistence is the whole point: a timetable you rebuild every session is
  // not a timetable.
  const first = await boot({ timetableData: TT_DATA });
  let saved;
  try {
    await openTT(first.doc, first.win, first.settle);
    const r = await ttSearch(first.doc, first.win, first.settle, 'BIO F101');
    r[0].querySelector('button').click();
    await first.settle(4);
    first.doc.querySelector('.tt-chooser .tt-section').click();
    await first.settle(8);
    saved = first.storage.timetable;
    assert.ok(saved, 'the timetable must have been written to storage');
  } finally {
    first.restore();
  }

  const second = await boot({ timetableData: TT_DATA, storageTimetable: saved });
  try {
    await openTT(second.doc, second.win, second.settle);
    const rows = [...second.doc.querySelectorAll('#tt-panel .tt-entry')];
    assert.equal(rows.length, 2, 'the timetable came back');
    assert.ok(
      second.doc.querySelector('#tt-panel .tt-grid'),
      'and it shows the week rather than the build wizard'
    );
  } finally {
    second.restore();
  }
});

test('TIMETABLE: an overlap is detected and explained', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // CS F111 L1 (Mon hour 3) and a fixture course deliberately placed on top.
  const clash = {
    ...TT_DATA,
    courses: [
      TT_DATA.courses[0],
      {
        comCode: '9999', courseNo: 'ZZ F999', title: 'CLASH', credits: ['3'],
        sections: [{
          section: 'L1', kind: 'lecture', instructors: ['Someone'], room: '1111',
          daysHours: 'M 3', unresolved: [],
          meetings: [{ day: 'M', dayName: 'Monday', hour: 3, startMin: 600, endMin: 650 }],
        }],
      },
    ],
  };
  const { doc, win, settle, restore } = await boot({ timetableData: clash });
  try {
    await openTT(doc, win, settle);
    let r = await ttSearch(doc, win, settle, 'ZZ F999');
    r[0].querySelector('button').click();
    await settle(4);
    doc.querySelector('.tt-chooser .tt-section').click();
    await settle(8);

    r = await ttSearch(doc, win, settle, 'CS F111');
    r[0].querySelector('button').click();
    await settle(4);
    const lectures = [...doc.querySelectorAll('.tt-chooser .tt-section')];
    lectures.find((b) => b.textContent.startsWith('L1')).click();
    await settle(10);

    const conflicts = doc.querySelector('#tt-panel .tt-conflicts');
    assert.ok(conflicts, 'the overlap must be surfaced');
    assert.match(conflicts.textContent, /Monday/);
    assert.match(conflicts.textContent, /ZZ F999|CS F111/);
  } finally {
    restore();
  }
});

test('TIMETABLE: a room-change email is proposed, quoting the sentence', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The deterministic mail path, end to end. The mail must produce a PROPOSAL
   * carrying the verbatim sentence — never a silent edit.
   */
  const mail = [{
    id: 'tt1', threadId: 'tt1',
    from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>',
    subject: 'CS F111 L1 venue change',
    snippet: 'From next week CS F111 L1 will be held in room 6101.',
    date: Date.now(), unread: true, starred: false, labels: ['INBOX', 'UNREAD'],
  }];
  const { doc, win, settle, restore } = await boot({
    timetableData: TT_DATA, messages: mail,
  });
  try {
    await openTT(doc, win, settle);
    const r = await ttSearch(doc, win, settle, 'CS F111');
    r[0].querySelector('button').click();
    await settle(4);
    [...doc.querySelectorAll('.tt-chooser .tt-section')]
      .find((b) => b.textContent.startsWith('L1')).click();
    await settle(8);

    // Re-scan now that the course is in the timetable, then reopen.
    const { scanForUpdates, closeTimetable, openTimetable } =
      await import('../src/app/timetable-ui.js');
    scanForUpdates(mail);
    closeTimetable();
    await settle(4);
    openTimetable();
    await settle(6);

    const proposal = doc.querySelector('#tt-panel .tt-proposal');
    assert.ok(proposal, 'the email should produce a proposal');
    assert.match(proposal.textContent, /6101/);
    assert.match(
      proposal.querySelector('.tt-evidence').textContent,
      /will be held in room 6101/,
      'the user must see the actual sentence'
    );

    // Nothing has changed yet.
    const { getTimetableState } = await import('../src/app/timetable-ui.js');
    assert.equal(
      getTimetableState().entries.find((e) => e.section === 'L1').room, '5105',
      'a proposal must not have been applied silently'
    );

    /*
     * PRECEDENCE APPLIES HERE, and the UI must not pretend otherwise.
     *
     * Mail is below the official timetable, so this change cannot be applied
     * as "the email said so" -- that is the rule that stops a stray message
     * rewriting the schedule. The panel therefore says why, and offers to
     * record it as the USER's decision, which outranks everything.
     */
    assert.match(
      proposal.textContent, /Not applied automatically/,
      'the panel must explain that mail cannot override the official timetable'
    );

    proposal.querySelector('.primary').click();
    await settle(8);
    const after = getTimetableState().entries.find((e) => e.section === 'L1');
    assert.equal(after.room, '6101');
    assert.equal(
      after.provenance.room.source, 'manual',
      'accepted-from-mail is recorded as the user\'s own edit, not as the mail\'s'
    );
    assert.match(after.history[after.history.length - 1].detail, /room changed/);
  } finally {
    restore();
  }
});

test('TIMETABLE: the message that changed a class says so in the reader', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * THE LINK RUNS BOTH WAYS.
   *
   * The entry could always name the message that changed it. This is the
   * other direction, and it is the one users ask in: the room change is open
   * in front of them and the question is "has this already been applied, or
   * am I about to walk to the wrong room?"
   */
  const mail = [{
    id: 'tt1', threadId: 'tt1',
    from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>',
    subject: 'CS F111 L1 venue change',
    snippet: 'From next week CS F111 L1 will be held in room 6101.',
    date: Date.now(), unread: true, starred: false, labels: ['INBOX', 'UNREAD'],
  }];
  const { doc, win, settle, restore } = await boot({
    timetableData: TT_DATA, messages: mail,
  });
  try {
    await openTT(doc, win, settle);
    const r = await ttSearch(doc, win, settle, 'CS F111');
    r[0].querySelector('button').click();
    await settle(4);
    [...doc.querySelectorAll('.tt-chooser .tt-section')]
      .find((b) => b.textContent.startsWith('L1')).click();
    await settle(8);

    const { scanForUpdates, closeTimetable, openTimetable } =
      await import('../src/app/timetable-ui.js');
    scanForUpdates(mail);
    closeTimetable();
    await settle(4);
    openTimetable();
    await settle(6);

    // Before accepting, the message has changed nothing and must claim nothing.
    closeTimetable();
    await settle(4);
    doc.querySelector('#list .row')?.click();
    await settle(8);
    assert.equal(
      doc.getElementById('r-timetable').hidden, true,
      'a proposal that has not been accepted must not claim to have applied'
    );

    openTimetable();
    await settle(6);
    doc.querySelector('#tt-panel .tt-proposal .primary').click();
    await settle(8);
    closeTimetable();
    await settle(4);

    // Reopen the message: now it should account for itself.
    doc.querySelector('#list .row').click();
    await settle(8);

    const box = doc.getElementById('r-timetable');
    assert.equal(box.hidden, false, 'the applied change should be reported');
    assert.match(box.textContent, /CS F111 L1/, 'it must name the class');
    assert.match(box.textContent, /5105/, 'and what the room was');
    assert.match(box.textContent, /6101/, 'and what it is now');
  } finally {
    restore();
  }
});

test('TIMETABLE: every entry can show where each field came from', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot({ timetableData: TT_DATA });
  try {
    await openTT(doc, win, settle);
    const r = await ttSearch(doc, win, settle, 'BIO F101');
    r[0].querySelector('button').click();
    await settle(4);
    doc.querySelector('.tt-chooser .tt-section').click();
    await settle(8);

    const entry = doc.querySelector('#tt-panel .tt-entry');
    [...entry.querySelectorAll('button')].find((b) => b.textContent === 'Source').click();
    await settle(4);

    const prov = entry.querySelector('.tt-prov');
    assert.ok(prov, 'source traceability must be reachable from the entry');
    assert.match(prov.textContent, /official timetable/);
    assert.match(prov.textContent, /5102/, 'the room and its origin');
    assert.match(prov.textContent, /History/, 'and the change log');
  } finally {
    restore();
  }
});

test('TIMETABLE: the real parsed catalogue drives the real UI', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The fixtures above are hand-written, so they prove the UI works but not
   * that it works against the ACTUAL BITS documents. This one uses the real
   * generated data: 688 offerings parsed from the AUGSD PDF text.
   */
  const { doc, win, settle, restore } = await boot({ timetableData: 'real' });
  try {
    await openTT(doc, win, settle);
    const results = await ttSearch(doc, win, settle, 'CS F111');
    assert.ok(results.length >= 1, 'the real catalogue should contain CS F111');
    assert.match(results[0].textContent, /COMPUTER PROGRAMMING/);
    // 4 lectures and 21 labs in the real document; the point is that both
    // kinds were parsed and counted, not the exact figures.
    assert.match(results[0].textContent, /lectures? · \d+ labs?/);

    results[0].querySelector('button').click();
    await settle(4);
    const lectures = [...doc.querySelectorAll('.tt-chooser .tt-section')];
    assert.ok(lectures.length >= 2, 'the real course has several lecture sections');
    // Teacher chips come from the real instructor names.
    assert.ok(doc.querySelector('.tt-chooser .tt-chip'), 'teachers offered for selection');

    lectures.find((b) => b.textContent.startsWith('L1')).click();
    await settle(10);

    const { getTimetableState } = await import('../src/app/timetable-ui.js');
    const e = getTimetableState().entries.find((x) => x.section === 'L1');
    assert.equal(e.courseNo, 'CS F111');
    assert.equal(e.room, '5105', 'the real room from the real document');
    assert.ok(e.meetings.length >= 2, 'and the real meeting times');
  } finally {
    restore();
  }
});

test('TIMETABLE: signing out clears it from the screen', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The timetable belongs to the account. It stays on disk, but the next
  // person to sign in must not see the previous one's classes.
  const { doc, win, settle, restore } = await boot({ timetableData: TT_DATA });
  try {
    await openTT(doc, win, settle);
    const r = await ttSearch(doc, win, settle, 'BIO F101');
    r[0].querySelector('button').click();
    await settle(4);
    doc.querySelector('.tt-chooser .tt-section').click();
    await settle(8);

    const { getTimetableState } = await import('../src/app/timetable-ui.js');
    assert.ok(getTimetableState().entries.length > 0, 'precondition');

    doc.getElementById('btn-signout').click();
    await settle(12);
    assert.equal(
      getTimetableState().entries.length, 0,
      "the previous account's timetable stayed in memory"
    );
  } finally {
    restore();
  }
});

test('TIMETABLE: Escape closes the panel without leaving Gmail', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // It is a layer, so it must unwind before the takeover does.
  const { doc, win, settle, restore } = await boot({ timetableData: TT_DATA });
  try {
    let released = false;
    win.parent = { postMessage(m) { if (m?.type === 'BMM_RELEASE') released = true; } };

    await openTT(doc, win, settle);
    assert.ok(doc.getElementById('tt-panel'));

    press(doc, win, 'Escape');
    await settle(6);
    assert.equal(doc.getElementById('tt-panel'), null, 'the panel should close');
    assert.equal(released, false, 'and must not drop the user back into Gmail');
  } finally {
    restore();
  }
});

test('TIMETABLE: exams are listed with times converted from the legend', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The exam dates were parsed and stored from the first version and never
   * rendered, so the part of the timetable a student most needs to plan
   * around was invisible. The clock times come from the document's legend:
   * AN2 is 16:00-17:30, a bare AN is the three-hour 14:00-17:00 compre.
   */
  const { doc, win, settle, restore } = await boot({ timetableData: TT_DATA });
  try {
    await openTT(doc, win, settle);
    const r = await ttSearch(doc, win, settle, 'CS F111');
    r[0].querySelector('button').click();
    await settle(4);
    [...doc.querySelectorAll('.tt-chooser .tt-section')]
      .find((b) => b.textContent.startsWith('L1')).click();
    await settle(8);

    const rows = [...doc.querySelectorAll('#tt-panel .tt-exam')];
    assert.ok(rows.length >= 2, `expected a midsem and a compre, got ${rows.length}`);

    const text = rows.map((n) => n.textContent).join(' | ');
    assert.match(text, /Mid-sem/, 'the mid-semester exam must be labelled');
    assert.match(text, /Compre/, 'and the comprehensive separately');
    assert.match(text, /4:00 PM-5:30 PM/, 'AN2 converts to 16:00-17:30');
    assert.match(text, /2:00 PM-5:00 PM/, 'a bare AN is the three-hour compre');

    // Soonest first: 09/10 before 02/12 in an Aug-start academic year.
    assert.ok(
      rows[0].textContent.includes('09/10'),
      `exams out of order: ${text}`
    );
  } finally {
    restore();
  }
});

test('TIMETABLE: a course with no exam dates shows no exam block', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Project and thesis courses have none, and an empty "Exams" heading would
  // imply the data was missing rather than absent.
  const { doc, win, settle, restore } = await boot({ timetableData: TT_DATA });
  try {
    await openTT(doc, win, settle);
    const r = await ttSearch(doc, win, settle, 'CS F111');
    r[0].querySelector('button').click();
    await settle(4);
    // L2 carries no exam dates in the fixture.
    [...doc.querySelectorAll('.tt-chooser .tt-section')]
      .find((b) => b.textContent.startsWith('L2')).click();
    await settle(8);

    assert.equal(
      doc.querySelectorAll('#tt-panel .tt-exam').length, 0,
      'no dates means no exam rows'
    );
  } finally {
    restore();
  }
});

test('TIMETABLE: the instructor-in-charge is marked in the entry list', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Legend section 6: BLOCK CAPITALS marks the instructor-in-charge, who is
  // who you email about a clash or a makeup. It was being flattened away.
  const { doc, win, settle, restore } = await boot({ timetableData: TT_DATA });
  try {
    await openTT(doc, win, settle);
    const r = await ttSearch(doc, win, settle, 'CS F111');
    r[0].querySelector('button').click();
    await settle(4);
    [...doc.querySelectorAll('.tt-chooser .tt-section')]
      .find((b) => b.textContent.startsWith('L1')).click();
    await settle(8);

    const lead = doc.querySelector('#tt-panel .tt-lead');
    assert.ok(lead, 'the in-charge should be marked');
    assert.equal(lead.textContent, 'VINTI AGARWAL');
    assert.match(lead.getAttribute('title') || '', /instructor-in-charge/);
  } finally {
    restore();
  }
});

test('TIMETABLE: an official room-change notice applies without asking', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * PRECEDENCE, END TO END, FOR THE SOURCE THAT OUTRANKS THE DOCUMENT.
   *
   * A change notice sits ABOVE the official timetable, so unlike mail it does
   * not need the user to accept it as their own edit -- the button applies it
   * directly and the provenance records 'notice'.
   *
   * The notice prints From and To as two columns ("1008 L1 5105 6101"), and
   * until now the value was never read out of them, so the highest automatic
   * authority in the system could report a change but never make one.
   */
  const withNotice = {
    ...TT_DATA,
    changes: [{
      type: 'room', comCode: '1008', courseNo: 'CS F111', section: 'L1',
      raw: '1008   COMPUTER PROGRAMMING   L1   5105   6101 CS F111',
      effective: '05-Aug-2026',
    }],
  };
  const { doc, win, settle, restore } = await boot({ timetableData: withNotice });
  try {
    await openTT(doc, win, settle);
    const r = await ttSearch(doc, win, settle, 'CS F111');
    r[0].querySelector('button').click();
    await settle(4);
    [...doc.querySelectorAll('.tt-chooser .tt-section')]
      .find((b) => b.textContent.startsWith('L1')).click();
    await settle(8);

    const { getTimetableState, scanForUpdates, closeTimetable, openTimetable } =
      await import('../src/app/timetable-ui.js');
    assert.equal(
      getTimetableState().entries.find((e) => e.section === 'L1').room, '5105',
      'precondition: the official room'
    );

    scanForUpdates([]);
    closeTimetable();
    await settle(4);
    openTimetable();
    await settle(6);

    const proposal = doc.querySelector('#tt-panel .tt-proposal');
    assert.ok(proposal, 'the notice should raise a proposal');
    assert.match(proposal.textContent, /6101/, 'and name the NEW room');

    const apply = proposal.querySelector('.primary');
    assert.ok(apply, 'a notice outranks the document, so it must be applyable');
    assert.match(apply.textContent, /Change room to 6101/);
    apply.click();
    await settle(8);

    const after = getTimetableState().entries.find((e) => e.section === 'L1');
    assert.equal(after.room, '6101', 'the new room must be applied');
    assert.equal(
      after.provenance.room.source, 'notice',
      'and recorded as the notice\'s doing, not the user\'s'
    );
    assert.match(
      after.history[after.history.length - 1].from, /5105/,
      'the previous room must survive in history'
    );
  } finally {
    restore();
  }
});

test('TIMETABLE: a section can be switched without losing the course', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * Routine in the first fortnight of a semester, and the only route used to
   * be Remove-then-Add, which discarded the history of everything else on
   * the course.
   */
  const { doc, win, settle, restore } = await boot({ timetableData: TT_DATA });
  try {
    await openTT(doc, win, settle);
    const r = await ttSearch(doc, win, settle, 'CS F111');
    r[0].querySelector('button').click();
    await settle(4);
    [...doc.querySelectorAll('.tt-chooser .tt-section')]
      .find((b) => b.textContent.startsWith('L1')).click();
    await settle(8);

    const { getTimetableState } = await import('../src/app/timetable-ui.js');
    assert.ok(
      getTimetableState().entries.some((e) => e.section === 'L1'),
      'precondition: L1 is held'
    );

    const swap = [...doc.querySelectorAll('#tt-panel .tt-entry button')]
      .find((b) => b.textContent === 'Switch');
    assert.ok(swap, 'a course with another lecture section must offer a switch');
    swap.click();
    await settle(4);

    const opts = [...doc.querySelectorAll('#tt-panel .tt-switch .tt-section')];
    assert.ok(opts.length, 'the alternatives must be listed');
    const toL2 = opts.find((b) => b.textContent.startsWith('L2'));
    assert.ok(toL2, 'L2 should be offered');
    toL2.click();
    await settle(8);

    const after = getTimetableState().entries;
    assert.ok(!after.some((e) => e.section === 'L1'), 'L1 is gone');
    const l2 = after.find((e) => e.section === 'L2');
    assert.ok(l2, 'L2 is held');
    assert.match(l2.history[0].detail, /Switched from L1/, 'and the switch is recorded');
  } finally {
    restore();
  }
});

test('TIMETABLE: marking complete refuses while a clash remains', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * "Mark complete" that happily accepts two classes in the same slot would
   * mean nothing.
   *
   * The clash is CONSTRUCTED here rather than assumed. My first version relied
   * on the shared fixture happening to overlap -- it does not, BIO F101 L1 is
   * Th2 and CS F111 L1 is M/W3 -- so the precondition failed and the test was
   * never exercising the refusal at all.
   */
  const clashing = {
    ...TT_DATA,
    courses: TT_DATA.courses.map((c) => (c.courseNo !== 'BIO F101' ? c : {
      ...c,
      sections: c.sections.map((sec) => (sec.section !== 'L1' ? sec : {
        ...sec,
        daysHours: 'M 3',
        meetings: [{ day: 'M', dayName: 'Monday', hour: 3, startMin: 600, endMin: 650 }],
      })),
    })),
  };
  const { doc, win, settle, restore } = await boot({ timetableData: clashing });
  try {
    await openTT(doc, win, settle);
    for (const q of ['CS F111', 'BIO F101']) {
      const r = await ttSearch(doc, win, settle, q);
      r[0].querySelector('button').click();
      await settle(4);
      [...doc.querySelectorAll('.tt-chooser .tt-section')]
        .find((b) => b.textContent.startsWith('L1')).click();
      await settle(8);
    }

    const { getTimetableState } = await import('../src/app/timetable-ui.js');
    const blocking = getTimetableState().conflicts.filter((c) => c.severity === 'blocking');
    assert.ok(blocking.length, 'precondition: the two courses must clash');

    const done = [...doc.querySelectorAll('#tt-panel button')]
      .find((b) => b.textContent === 'Mark complete');
    assert.ok(done, 'the control must be offered');
    done.click();
    await settle(6);

    assert.equal(
      getTimetableState().finalisedAt, undefined,
      'a clashing timetable must not be marked complete'
    );
  } finally {
    restore();
  }
});

/* The in-app confirm primitive (dialog.js) replaces native confirm(): tests
   drive its buttons like a user would. Cancel is first, the action second. */
const dialogButtons = (doc) => [...doc.querySelectorAll('.prompt-backdrop .prompt-actions button')];
const acceptDialog = (doc) => { const b = dialogButtons(doc); return b[b.length - 1]; };
const declineDialog = (doc) => dialogButtons(doc)[0];

test('TIMETABLE: reset asks first, then clears everything', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Destructive and not covered by undo, so it confirms. Declining must be
  // a genuine no-op, not a delayed yes.
  const { doc, win, settle, restore } = await boot({ timetableData: TT_DATA });
  try {
    await openTT(doc, win, settle);
    const r = await ttSearch(doc, win, settle, 'CS F111');
    r[0].querySelector('button').click();
    await settle(4);
    [...doc.querySelectorAll('.tt-chooser .tt-section')]
      .find((b) => b.textContent.startsWith('L1')).click();
    await settle(8);

    const { getTimetableState } = await import('../src/app/timetable-ui.js');
    const before = getTimetableState().entries.length;
    assert.ok(before > 0, 'precondition: something to reset');

    const wipe = () => [...doc.querySelectorAll('#tt-panel button')]
      .find((b) => b.textContent === 'Reset');

    // The wipe asks through the in-app dialog (round 45 Phase 2).
    wipe().click();
    await settle(6);
    declineDialog(doc).click();
    await settle(6);
    assert.equal(
      getTimetableState().entries.length, before,
      'declining the dialog must change nothing'
    );

    wipe().click();
    await settle(6);
    acceptDialog(doc).click();
    await settle(8);
    assert.equal(getTimetableState().entries.length, 0, 'accepting clears it');
    assert.ok(
      doc.querySelector('#tt-q'),
      'and the build screen comes back so it can be rebuilt'
    );
  } finally {
    restore();
  }
});

test('TIMETABLE: the Pass 2 verification checklist, end to end', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * ONE TEST THAT WALKS THE WHOLE SPEC.
   *
   * The individual behaviours each have focused tests. This exists because a
   * checklist satisfied item-by-item can still fail as a sequence -- state
   * carried between steps is exactly where this kind of system breaks. It
   * runs the ten things Pass 2 says to verify, in order, against the REAL
   * parsed catalogue rather than a fixture.
   */
  const { doc, win, settle, restore, storage } = await boot({ timetableData: 'real' });
  try {
    const M = await import('../src/app/timetable-ui.js');

    // 1. Build from official data, choosing course -> section.
    await openTT(doc, win, settle);
    const hits = await ttSearch(doc, win, settle, 'CS F111');
    assert.ok(hits.length, '1. the official catalogue must be searchable');
    hits[0].querySelector('button').click();
    await settle(4);

    // 2. Teacher/section choice is offered deterministically, not guessed.
    const sections = [...doc.querySelectorAll('.tt-chooser .tt-section')];
    assert.ok(sections.length > 1, '2. the real course has several sections');
    sections.find((b) => b.textContent.startsWith('L1')).click();
    await settle(10);

    const held = () => M.getTimetableState().entries;
    assert.ok(held().some((e) => e.section === 'L1'), 'the lecture is held');

    /*
     * 3. Day/hour notation converted. CS F111 L1 is "M W 3 Th 9".
     *
     * NOTE ON WHAT THIS DOES AND DOES NOT PROVE. It reads the SHIPPED data,
     * so it verifies the conversion survived parse -> disk -> store -> UI. It
     * does NOT exercise the grammar: sabotaging the day-group rule in
     * parseDaysHours leaves this green, because data.json was generated
     * before the sabotage. The grammar itself is covered by the PARSE suite,
     * which does fail on that mutation. Recorded so nobody mistakes this
     * assertion for parser coverage.
     */
    const l1 = held().find((e) => e.section === 'L1');
    assert.deepEqual(
      l1.meetings.map((m) => `${m.day}${m.hour}`), ['M3', 'W3', 'Th9'],
      '3. Th 9 must not become Th 3'
    );
    assert.equal(l1.meetings[0].startMin, 600, 'slot 3 is 10:00 per the legend');

    // 4. Credit structure and in-charge are modelled from the legend.
    assert.equal(l1.credits.lecture, 3, '4. credits are named');
    assert.equal(l1.inCharge, 'VINTI AGARWAL', '4. the in-charge is identified');

    // Snapshot what was persisted, for the restart check at the end.
    await settle(6);
    const savedBlob = storage.timetable;
    assert.ok(savedBlob, 'the build must persist immediately');

    // 5. Exams are typed events with converted times.
    const exams = doc.querySelectorAll('#tt-panel .tt-exam');
    assert.ok(exams.length, '5. the compre must be listed');

    // 6. A manual edit is respected and recorded.
    const edited = M.getTimetableState();
    const r = (await import('../src/app/timetable.js'))
      .manualEdit(edited, l1.id, 'room', '9999');
    assert.equal(r.applied, true, '6. the user may always edit');
    assert.equal(r.entry.provenance.room.source, 'manual');

    // 7. A lower source cannot overwrite that edit.
    const mailTry = (await import('../src/app/timetable.js'))
      .applyFieldChange(r.entry, 'room', '1111', { source: 'mail', ref: 'm1' });
    assert.equal(mailTry.applied, false, '7. mail must not outrank the user');

    // 8. Every field can name its source.
    const lines = (await import('../src/app/timetable.js')).explainEntry(l1);
    assert.ok(lines.length, '8. every entry explains itself');
    assert.ok(lines.every((x) => x.sourceLabel), '8. with a readable source');

    // 9. Reset is the only route back, and it is explicit.
    // The panel is already open, so re-clicking the toolbar button is a no-op.
    // Re-render it instead, which is what any state change would have done.
    M.closeTimetable();
    await settle(4);
    M.openTimetable();
    await settle(6);
    const wipe = [...doc.querySelectorAll('#tt-panel button')]
      .find((b) => b.textContent === 'Reset');
    assert.ok(wipe, '9. reset must be reachable');
    wipe.click();
    await settle(6);
    acceptDialog(doc).click();
    await settle(8);
    assert.equal(M.getTimetableState().entries.length, 0, '9. and must clear');

    /*
     * 10. Persistence survives a restart.
     *
     * LAST, deliberately. Booting a second app re-runs the shared module
     * state teardown, so every assertion after it would be reading an empty
     * timetable -- which is how this step originally made step 10 fail with a
     * misleading "reset must be reachable".
     */
    assert.ok(savedBlob, '10. the timetable must have been written to disk');
    const second = await boot({ timetableData: 'real', storageTimetable: savedBlob });
    try {
      await second.settle(10);
      const M2 = await import('../src/app/timetable-ui.js');
      assert.ok(
        M2.getTimetableState().entries.some((e) => e.section === 'L1'),
        '10. the timetable must survive a restart'
      );
    } finally {
      second.restore();
    }
  } finally {
    restore();
  }
});

test('TIMETABLE: a section the catalogue dropped is flagged after reload', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * THE SEMESTER-TRANSITION CASE, end to end.
   *
   * Build against one catalogue, then reload against a revised one where the
   * held section no longer exists -- which is what `npm run timetable` against
   * a new document produces. The class must still be shown (it may carry
   * manual edits, and a revised document is not proof the user dropped it),
   * but the user must be told it is no longer offered.
   */
  const first = await boot({ timetableData: TT_DATA });
  let saved;
  try {
    await openTT(first.doc, first.win, first.settle);
    const r = await ttSearch(first.doc, first.win, first.settle, 'CS F111');
    r[0].querySelector('button').click();
    await first.settle(4);
    [...first.doc.querySelectorAll('.tt-chooser .tt-section')]
      .find((b) => b.textContent.startsWith('L1')).click();
    await first.settle(10);
    saved = first.storage.timetable;
    assert.ok(saved, 'precondition: the build persisted');
  } finally {
    first.restore();
  }

  // The revised catalogue: CS F111 now runs L2 only.
  const revised = {
    ...TT_DATA,
    courses: TT_DATA.courses.map((c) => (c.courseNo !== 'CS F111' ? c : {
      ...c,
      sections: c.sections.filter((sec) => sec.section !== 'L1'),
    })),
  };

  const { doc, win, settle, restore } = await boot({
    timetableData: revised, storageTimetable: saved,
  });
  try {
    await settle(10);
    await openTT(doc, win, settle);

    const { getTimetableState } = await import('../src/app/timetable-ui.js');
    assert.ok(
      getTimetableState().entries.some((e) => e.section === 'L1'),
      'the class must NOT be silently deleted'
    );

    const warnings = [...doc.querySelectorAll('#tt-panel .tt-conflict')]
      .map((n) => n.textContent).join(' | ');
    assert.match(
      warnings, /no longer offered/i,
      `the user must be told the section is gone: ${warnings}`
    );
    assert.match(warnings, /L1/);
  } finally {
    restore();
  }
});

test('TIMETABLE: a failed catalogue load does not condemn every class', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * loadSourceData degrades to an empty catalogue when the asset cannot be
   * fetched. If that counted as evidence, every class would be flagged as
   * withdrawn -- turning a transient load failure into a screenful of alarming
   * nonsense. No source means no opinion.
   */
  const built = await boot({ timetableData: TT_DATA });
  let saved;
  try {
    await openTT(built.doc, built.win, built.settle);
    const r = await ttSearch(built.doc, built.win, built.settle, 'CS F111');
    r[0].querySelector('button').click();
    await built.settle(4);
    [...built.doc.querySelectorAll('.tt-chooser .tt-section')]
      .find((b) => b.textContent.startsWith('L1')).click();
    await built.settle(10);
    saved = built.storage.timetable;
  } finally {
    built.restore();
  }

  const { doc, win, settle, restore } = await boot({
    timetableData: { schemaVersion: 1, semester: '', courses: [], changes: [] },
    storageTimetable: saved,
  });
  try {
    await settle(10);
    await openTT(doc, win, settle);
    const warnings = [...doc.querySelectorAll('#tt-panel .tt-conflict')]
      .map((n) => n.textContent).join(' | ');
    assert.doesNotMatch(
      warnings, /no longer offered|not in the current/i,
      `an empty catalogue must not condemn anything: ${warnings}`
    );
  } finally {
    restore();
  }
});

test('TIMETABLE: an unsaved change is visible, not silently pending', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * A PASS 3 NAMED CONDITION: "the visible schedule and stored schedule
   * disagree."
   *
   * persist() surfaced write failures as a toast, which is right but not
   * enough -- a toast is gone in three seconds and the panel then shows an
   * edit that will vanish on the next reload. The user believes their room
   * change is saved. It is not.
   *
   * The change is deliberately NOT rolled back. Discarding what someone just
   * typed because storage was briefly full is its own data loss, and the
   * write may well succeed next time. It is kept, shown, and marked unsaved
   * so the disagreement is visible rather than silent.
   */
  const { doc, win, settle, restore, storage } = await boot({ timetableData: TT_DATA });
  try {
    await openTT(doc, win, settle);
    const r = await ttSearch(doc, win, settle, 'CS F111');
    r[0].querySelector('button').click();
    await settle(4);
    [...doc.querySelectorAll('.tt-chooser .tt-section')]
      .find((b) => b.textContent.startsWith('L1')).click();
    await settle(10);
    assert.ok(storage.timetable, 'precondition: the build saved cleanly');
    assert.ok(
      !doc.querySelector('#tt-panel .tt-unsaved'),
      'and nothing claims to be unsaved yet'
    );

    // Now make every write fail, the way a full quota does.
    win.chrome.storage.local.set = () => Promise.reject(new Error('QUOTA_BYTES'));

    const lock = [...doc.querySelectorAll('#tt-panel .tt-entry button')]
      .find((b) => b.textContent === 'Lock');
    assert.ok(lock, 'precondition: a lock control to act on');
    lock.click();
    await settle(10);

    const warn = doc.querySelector('#tt-panel .tt-unsaved');
    assert.ok(warn, 'the panel must show that changes are not saved');
    assert.match(warn.textContent, /not saved|unsaved/i);
  } finally {
    restore();
  }
});

test('TIMETABLE: the unsaved warning clears once a write succeeds', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // A warning that never clears is worse than none: it trains the user to
  // ignore it. Recovery has to be visible too.
  const { doc, win, settle, restore } = await boot({ timetableData: TT_DATA });
  try {
    await openTT(doc, win, settle);
    const r = await ttSearch(doc, win, settle, 'CS F111');
    r[0].querySelector('button').click();
    await settle(4);
    [...doc.querySelectorAll('.tt-chooser .tt-section')]
      .find((b) => b.textContent.startsWith('L1')).click();
    await settle(10);

    const realSet = win.chrome.storage.local.set;
    win.chrome.storage.local.set = () => Promise.reject(new Error('QUOTA_BYTES'));
    [...doc.querySelectorAll('#tt-panel .tt-entry button')]
      .find((b) => b.textContent === 'Lock').click();
    await settle(10);
    assert.ok(doc.querySelector('#tt-panel .tt-unsaved'), 'precondition: warned');

    win.chrome.storage.local.set = realSet;
    [...doc.querySelectorAll('#tt-panel .tt-entry button')]
      .find((b) => b.textContent === 'Unlock').click();
    await settle(10);

    assert.ok(
      !doc.querySelector('#tt-panel .tt-unsaved'),
      'a successful write must clear the warning'
    );
  } finally {
    restore();
  }
});

test('MAIL: reporting spam removes the message and can be undone', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * CORE MAIL TRIAGE THAT DID NOT EXIST.
   *
   * You could browse the Spam mailbox but could not report a message into it,
   * and could not rescue one out. For a Gmail replacement that is a hole in
   * the four-verb core -- archive, delete, spam, star -- and spam was the
   * missing one. Verified before building: grep for SPAM across src/app found
   * nothing but the mailbox definition.
   *
   * Undo matters more here than for archive. Reporting the wrong sender as
   * spam trains Gmail against a correspondent you actually want, so it must be
   * as reversible as everything else in this product.
   */
  const { doc, win, calls, settle, restore } = await boot();
  try {
    const before = rows(doc).length;
    rows(doc)[0].click();
    await settle(4);

    press(doc, win, '!');
    assert.equal((await settled(doc, settle)).length, before - 1, 'the row must leave');

    const spam = calls.filter((c) => c.type === 'SPAM');
    assert.equal(spam.length, 1, 'exactly one SPAM call');

    press(doc, win, 'z', { ctrlKey: true });
    await settled(doc, settle);
    assert.equal(rows(doc).length, before, 'undo must bring it back');
    assert.equal(
      calls.filter((c) => c.type === 'NOT_SPAM').length, 1,
      'and must tell Gmail it was not spam'
    );
  } finally {
    restore();
  }
});

test('MAIL: a message can be rescued from the Spam mailbox', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The other half. A false positive you have to go and re-file by hand is
   * only half a rescue, so "Not spam" restores INBOX rather than merely
   * clearing the SPAM label.
   *
   * In the Spam mailbox the same key means the opposite thing, because
   * "report as spam" is meaningless on something already there.
   */
  const { doc, win, calls, settle, restore } = await boot({ perLabel: true });
  try {
    doc.querySelector('.cat[data-mailbox="spam"]').click();
    await settle(8);
    assert.ok(rows(doc).length, 'precondition: spam has messages');

    rows(doc)[0].click();
    await settle(4);
    press(doc, win, '!');
    await settled(doc, settle);

    assert.equal(
      calls.filter((c) => c.type === 'NOT_SPAM').length, 1,
      'in Spam, ! must rescue rather than report'
    );
    assert.equal(
      calls.filter((c) => c.type === 'SPAM').length, 0,
      'and must never re-report a message already in spam'
    );
  } finally {
    restore();
  }
});

test('MAIL: the spam control says what it will actually do', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * One button, two meanings, resolved by mailbox. "Report spam" on a message
   * already in Spam is a control that lies about what it will do, and a
   * separate second button would make the user choose between two things they
   * think of as one question: is this junk or not?
   */
  const { doc, settle, restore } = await boot({ perLabel: true });
  try {
    const btn = () => doc.querySelector('#r-actions button[data-act="spam"]');
    rows(doc)[0].click();
    await settle(6);
    assert.ok(btn(), 'the control must exist in the inbox');
    assert.equal(btn().hidden, false);
    assert.match(btn().textContent, /Report spam/);

    doc.querySelector('.cat[data-mailbox="spam"]').click();
    await settle(8);
    rows(doc)[0].click();
    await settle(6);
    assert.match(btn().textContent, /Not spam/, 'inside Spam it must offer the rescue');

    doc.querySelector('.cat[data-mailbox="sent"]').click();
    await settle(8);
    assert.equal(
      btn().hidden, true,
      'reporting your own sent mail as spam is nonsense and must not be offered'
    );
  } finally {
    restore();
  }
});

test('MAIL: a batch of junk can be reported in one action', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * Junk arrives in batches. Reporting it one message at a time is exactly
   * the friction this product exists to remove, and bulk had Mark read, Star,
   * Archive and Delete but not spam.
   *
   * One BULK call, not N -- and reversible like every other bulk action.
   */
  const { doc, win, calls, settle, restore } = await boot();
  try {
    const before = rows(doc).length;
    press(doc, win, 'a', { ctrlKey: true });
    await settle(6);

    const btn = doc.getElementById('bulk-spam');
    assert.ok(btn, 'bulk must offer a spam action');
    btn.click();
    await settled(doc, settle);

    const bulk = calls.filter((c) => c.type === 'BULK' && (c.add || []).includes('SPAM'));
    assert.equal(bulk.length, 1, 'one request for the whole batch, not one each');
    assert.deepEqual(
      bulk[0].remove, ['INBOX'],
      'reported mail must leave the inbox, or it claims to be spam while sitting in it'
    );
    assert.equal(rows(doc).length, 0, 'the rows must go');

    press(doc, win, 'z', { ctrlKey: true });
    await settled(doc, settle);
    assert.equal(rows(doc).length, before, 'and undo must bring the batch back');
  } finally {
    restore();
  }
});

test('MAIL: compose can Bcc, and the address reaches the wire', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The MIME builder already emitted a Bcc header and collectDraft never
   * populated it -- the capability existed end to end except for the one
   * input the user needed. Bcc is core mail: it is how you loop somebody in
   * without exposing their address to the thread.
   *
   * Verified before building: grep for bcc across src/app returned nothing.
   */
  const { doc, win, calls, settle, restore } = await bootSending();
  try {
    press(doc, win, 'c');
    await settle(6);

    const toggle = doc.getElementById('c-bcc-toggle');
    assert.ok(toggle, 'compose must offer a Bcc control');
    assert.equal(
      doc.getElementById('c-bcc-row').hidden, true,
      'and must keep it out of the way until asked for'
    );
    toggle.click();
    await settle(4);
    assert.equal(doc.getElementById('c-bcc-row').hidden, false);

    doc.getElementById('c-to').value = 'a@pilani.bits-pilani.ac.in';
    doc.getElementById('c-bcc').value = 'quiet@pilani.bits-pilani.ac.in';
    doc.getElementById('c-subject').value = 'Hello';
    doc.getElementById('c-text').value = 'Body';
    doc.getElementById('c-send').click();
    await settle(10);
    // Sending is queued behind the undo-send hold; drain it to reach the wire.
    await drainOutbox(win, settle);

    const sent = calls.find((c) => c.type === 'SEND');
    assert.ok(sent, 'the message must be sent');
    assert.equal(
      sent.draft.bcc, 'quiet@pilani.bits-pilani.ac.in',
      'the Bcc address must survive into the draft that goes to the worker'
    );
  } finally {
    restore();
  }
});

test('MAIL: a recovered draft reveals the recipients it actually has', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * Cc and Bcc are hidden until asked for. Restoring a crashed draft into a
   * panel that hides half its recipients is worse than not restoring it: the
   * user sees one addressee, believes that is the whole story, and sends.
   */
  const draft = {
    to: 'a@pilani.bits-pilani.ac.in',
    cc: 'b@pilani.bits-pilani.ac.in',
    bcc: 'c@pilani.bits-pilani.ac.in',
    subject: 'Recovered', body: 'text', title: 'New message',
  };
  // Restoring asks first through the in-app dialog; accept it.
  const { doc, settle, restore } = await boot({ storageSeed: { composeDraft: draft } });
  try {
    await settle(10);
    acceptDialog(doc).click();
    await settle(8);
    assert.equal(doc.getElementById('c-cc').value, draft.cc, 'Cc must be restored');
    assert.equal(doc.getElementById('c-bcc').value, draft.bcc, 'Bcc must be restored');
    assert.equal(
      doc.getElementById('c-cc-row').hidden, false,
      'a restored Cc must be visible, not hidden behind a toggle'
    );
    assert.equal(
      doc.getElementById('c-bcc-row').hidden, false,
      'and so must a restored Bcc'
    );
  } finally {
    restore();
  }
});

test('MAIL: new mail arrives without the user asking for it', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * THE DEFINING BEHAVIOUR OF A MAIL CLIENT, and it was absent.
   *
   * app.js said outright "Delta refresh. Never on a timer." The only alarm in
   * the worker is the snooze wake. So mail appeared solely when the user
   * pressed `r` or reopened the app -- which makes this a mail VIEWER, not a
   * mail client. Audit 12 C-1.
   *
   * The interval is deliberately short here via a settings override, so the
   * test measures the mechanism rather than waiting two minutes.
   */
  const { doc, win, calls, settle, restore } = await boot({
    storageSeed: { autoRefreshMs: 60 },
  });
  try {
    await settle(8);
    const before = calls.filter((c) => c.type === 'SYNC_DELTA').length;

    // Let the timer fire without any user action at all.
    await new Promise((r) => setTimeout(r, 220));
    await settle(6);

    const after = calls.filter((c) => c.type === 'SYNC_DELTA').length;
    assert.ok(
      after > before,
      `the app must poll for new mail on its own (${before} -> ${after})`
    );
  } finally {
    restore();
  }
});

test('MAIL: auto-refresh stops when the user signs out', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * A timer that keeps hitting Gmail after sign-out is both a bug and a
   * privacy problem -- it is a signed-out app still talking about somebody's
   * mailbox. It must also not fire while the takeover is closed.
   */
  const { doc, win, calls, settle, restore } = await boot({
    storageSeed: { autoRefreshMs: 60 },
  });
  try {
    await settle(8);
    doc.getElementById('btn-signout').click();
    await settle(12);

    /*
     * WAIT FOR THE TIMER TO BE GONE, then count -- rather than counting after
     * a fixed 260ms and hoping the teardown finished first.
     *
     * `autoRefreshMs` is 60 here, so the old form raced: under full-suite
     * load a couple more ticks could land between the click and the count,
     * and the assertion failed with 19 !== 13. It failed on scheduling, not
     * on behaviour -- the timer really had been cleared.
     *
     * `__bmmAutoRefreshPending()` is the deterministic seam the assertion
     * below already relies on. Using it here too removes the clock from a
     * test about whether polling stopped, without weakening what is checked:
     * the count is still taken AFTER the stop and must not move.
     */
    for (let i = 0; i < 40 && win.__bmmAutoRefreshPending(); i++) {
      await settle(2);
    }

    const atSignout = calls.filter((c) => c.type === 'SYNC_DELTA').length;
    await new Promise((r) => setTimeout(r, 260));
    await settle(6);

    assert.equal(
      calls.filter((c) => c.type === 'SYNC_DELTA').length, atSignout,
      'a signed-out app must not keep polling Gmail'
    );

    /*
     * ASSERT THE TIMER IS GONE, not merely that no request escaped.
     *
     * refresh() already returns early when signed out, so deleting
     * stopAutoRefresh() changes no observable request count -- sabotage proved
     * that, and the first version of this test passed against a timer that was
     * still firing every 60ms forever.
     *
     * Defence in depth is the point: the guard inside refresh() is the second
     * line, and this is the first. A live timer on a signed-out app is a
     * wakeup every interval for the life of the tab.
     */
    assert.equal(
      win.__bmmAutoRefreshPending?.(), false,
      'the poll timer itself must be cancelled, not just neutered downstream'
    );
  } finally {
    restore();
  }
});

test('MAIL: a file can be attached and travels with the message', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * AUDIT 12 C-3. "Send me the PDF" is table stakes, and a compose window
   * that cannot attach forces the user back to Gmail -- which defeats the
   * product entirely.
   */
  const { doc, win, calls, settle, restore } = await bootSending();
  try {
    press(doc, win, 'c');
    await settle(6);

    assert.ok(doc.getElementById('c-attach'), 'compose must offer Attach');
    assert.equal(
      doc.getElementById('c-files').hidden, true,
      'and must show nothing until a file is chosen'
    );

    const input = doc.getElementById('c-file');
    const file = new win.File(['hello'], 'notes.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new win.Event('change', { bubbles: true }));
    await settle(10);

    const box = doc.getElementById('c-files');
    assert.equal(box.hidden, false, 'the chosen file must be visible');
    assert.match(box.textContent, /notes\.txt/, 'named, so a mistake is obvious');

    doc.getElementById('c-to').value = 'a@pilani.bits-pilani.ac.in';
    doc.getElementById('c-subject').value = 'Report';
    doc.getElementById('c-text').value = 'See attached';
    doc.getElementById('c-send').click();
    await settle(10);
    // Sending is queued behind the undo-send hold; drain it to reach the wire.
    await drainOutbox(win, settle);

    const sent = calls.find((c) => c.type === 'SEND');
    assert.ok(sent, 'the message must be sent');
    assert.equal(sent.draft.attachments.length, 1, 'with the attachment');
    assert.equal(sent.draft.attachments[0].filename, 'notes.txt');
    assert.equal(
      sent.draft.attachments[0].data, 'aGVsbG8=',
      'base64 of "hello" -- the payload must survive the reader'
    );
  } finally {
    restore();
  }
});

test('MAIL: attachments do not leak into the next message', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * Attachments belong to ONE message. Carrying them into the next compose
   * would silently attach the previous file to an unrelated recipient, which
   * is a data-disclosure bug, not a tidiness one.
   */
  const { doc, win, calls, settle, restore } = await bootSending();
  try {
    press(doc, win, 'c');
    await settle(6);
    const input = doc.getElementById('c-file');
    Object.defineProperty(input, 'files', {
      value: [new win.File(['x'], 'secret.txt', { type: 'text/plain' })],
      configurable: true,
    });
    input.dispatchEvent(new win.Event('change', { bubbles: true }));
    await settle(10);
    assert.match(doc.getElementById('c-files').textContent, /secret\.txt/);

    // An attachment-only draft IS content now (bug-hunt 44 #23), so closing
    // asks before discarding. Accept the discard, then prove nothing leaked.
    doc.getElementById('compose-close').click();
    await settle(6);
    acceptDialog(doc).click();
    await settle(6);
    press(doc, win, 'c');
    await settle(6);

    assert.equal(
      doc.getElementById('c-files').hidden, true,
      'a new message must start with no attachments'
    );
    doc.getElementById('c-to').value = 'b@pilani.bits-pilani.ac.in';
    doc.getElementById('c-subject').value = 'Unrelated';
    doc.getElementById('c-text').value = 'hi';
    doc.getElementById('c-send').click();
    await settle(10);
    // Sending is queued behind the undo-send hold; drain it to reach the wire.
    await drainOutbox(win, settle);

    const sent = calls.filter((c) => c.type === 'SEND').pop();
    assert.deepEqual(
      sent.draft.attachments, [],
      'the previous file must not ride along to a different recipient'
    );
  } finally {
    restore();
  }
});

/* ================================================================ threading == */

/** Three messages in one conversation, plus two unrelated singles. */
const THREADED = [
  {
    id: 'c1', threadId: 'CONV',
    from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>',
    subject: 'Revised schedule',
    snippet: 'The revised schedule is attached.',
    date: Date.now() - 9000_000, unread: false, starred: false, labels: ['INBOX'],
  },
  {
    id: 'c2', threadId: 'CONV',
    from: 'Registrar <registrar@pilani.bits-pilani.ac.in>',
    subject: 'Re: Revised schedule',
    snippet: 'Corrigendum to the above.',
    date: Date.now() - 5000_000, unread: true, starred: false, labels: ['INBOX', 'UNREAD'],
  },
  {
    id: 'c3', threadId: 'CONV',
    from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>',
    subject: 'Re: Revised schedule',
    snippet: 'Final revised schedule.',
    date: Date.now() - 1000_000, unread: true, starred: false, labels: ['INBOX', 'UNREAD'],
  },
  {
    id: 's1', threadId: 'S1',
    from: 'Library <library@pilani.bits-pilani.ac.in>',
    subject: 'Book due',
    snippet: 'Your book is due.',
    date: Date.now() - 7000_000, unread: false, starred: false, labels: ['INBOX'],
  },
  {
    id: 's2', threadId: 'S2',
    from: 'GitHub <notifications@github.com>',
    subject: 'Run failed',
    snippet: 'The workflow failed.',
    date: Date.now() - 3000_000, unread: false, starred: false, labels: ['INBOX'],
  },
];

test('THREAD: a conversation occupies one row, not one per message', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The point of the whole feature. Five messages, three of them one
   * conversation, must render as THREE rows -- and the conversation must sit
   * where its newest message would, because a conversation is as recent as
   * its latest reply.
   */
  const { doc, settle, restore } = await boot({ messages: THREADED });
  try {
    await settle(8);
    const r = rows(doc);
    assert.equal(r.length, 3, `expected 3 rows, got ${rowText(doc).join(' | ')}`);

    // Newest first: CONV (c3) is newest, then s2, then s1.
    assert.deepEqual(
      r.map((x) => x.dataset.id), ['c3', 's2', 's1'],
      'the conversation row is its newest message'
    );
  } finally {
    restore();
  }
});

test('THREAD: the row shows the conversation, not just the last message', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * A collapsed conversation has to say it IS one, or the user cannot tell
   * three messages from one. Gmail shows a count and the participants; both
   * are what make a collapsed row readable rather than lossy.
   *
   * The subject is the ORIGINAL, not "Re: ..." -- a conversation is named for
   * what it is about.
   */
  const { doc, settle, restore } = await boot({ messages: THREADED });
  try {
    await settle(8);
    const conv = rows(doc).find((x) => x.dataset.id === 'c3');
    assert.ok(conv, 'the conversation row must exist');

    assert.equal(
      conv.querySelector('.r-subj').textContent, 'Revised schedule',
      'the original subject, with no Re: prefix'
    );
    const count = conv.querySelector('.r-count');
    assert.ok(count, 'a collapsed conversation must show how many it holds');
    assert.equal(count.textContent, '3');
    assert.match(
      conv.querySelector('.r-from').textContent, /AUGSD.*Registrar|Registrar.*AUGSD/,
      'and who is in it'
    );
  } finally {
    restore();
  }
});

test('THREAD: a conversation is unread if ANY message in it is', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * c1 is read, c2 and c3 are not. The row must read as unread -- a
   * conversation you have not finished reading is unread, and deriving that
   * from the newest message alone would hide an unread reply under a read one.
   */
  const { doc, settle, restore } = await boot({ messages: THREADED });
  try {
    await settle(8);
    const conv = rows(doc).find((x) => x.dataset.id === 'c3');
    assert.ok(conv.classList.contains('unread'), 'two unread replies means unread');

    const single = rows(doc).find((x) => x.dataset.id === 's1');
    assert.ok(!single.classList.contains('unread'), 'a read single stays read');
  } finally {
    restore();
  }
});

test('THREAD: opening a conversation shows every message in it', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * Collapsing must not lose access. Opening the row has to reveal the whole
   * exchange, oldest first, which is the order a conversation reads in.
   */
  const { doc, settle, restore } = await boot({ messages: THREADED });
  try {
    await settle(8);
    rows(doc).find((x) => x.dataset.id === 'c3').click();
    await settle(10);

    const parts = [...doc.querySelectorAll('#r-thread .r-msg')];
    assert.equal(parts.length, 3, 'all three messages must be reachable');
    assert.deepEqual(
      parts.map((p) => p.dataset.id), ['c1', 'c2', 'c3'],
      'oldest first -- the order a conversation reads in'
    );
  } finally {
    restore();
  }
});

test('THREAD: a single message still opens as a plain reader', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The 1-message case must not grow conversation furniture. Most mail is a
  // single message and it should look exactly as it always did.
  const { doc, settle, restore } = await boot({ messages: THREADED });
  try {
    await settle(8);
    rows(doc).find((x) => x.dataset.id === 's1').click();
    await settle(10);
    /*
     * The strip is HIDDEN, not populated with one entry. A one-item list of
     * alternatives is furniture with nothing to choose between, and most mail
     * is a single message -- the reader must look exactly as it always did.
     */
    assert.equal(
      doc.getElementById('r-thread').hidden, true,
      'no conversation strip on a single message'
    );
    assert.equal(
      doc.querySelectorAll('#r-thread .r-msg').length, 0,
      'and nothing rendered inside it'
    );
    const badge = doc.querySelector('#list .row[data-id="s1"] .r-count');
    assert.ok(!badge || badge.hidden, 'no count badge on a single message');
  } finally {
    restore();
  }
});

test('THREAD: clicking a message in the strip loads that message', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * Collapsing is only acceptable if every message stays one click away.
   * Selecting a part must load THAT body, mark it current, and leave the row
   * selection alone -- the conversation is still the selected row.
   */
  const { doc, calls, settle, restore } = await boot({ messages: THREADED });
  try {
    await settle(8);
    rows(doc).find((x) => x.dataset.id === 'c3').click();
    await settle(10);

    const before = calls.filter((c) => c.type === 'GET_BODY').map((c) => c.id);
    assert.equal(before[before.length - 1], 'c3', 'opens on the newest message');

    doc.querySelector('#r-thread .r-msg[data-id="c1"]').click();
    await settle(10);

    const after = calls.filter((c) => c.type === 'GET_BODY').map((c) => c.id);
    assert.equal(after[after.length - 1], 'c1', 'the chosen message is fetched');

    const cur = doc.querySelector('#r-thread .r-msg.current');
    assert.equal(cur.dataset.id, 'c1', 'and marked as current');
    assert.equal(cur.getAttribute('aria-pressed'), 'true');

    assert.equal(
      doc.querySelector('#list .row[aria-selected="true"]')?.dataset.id, 'c3',
      'the conversation stays the selected row'
    );
  } finally {
    restore();
  }
});

test('THREAD: opening a conversation marks only the message you read', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * READ STATE IS PER MESSAGE, NOT PER CONVERSATION.
   *
   * Marking a whole thread read because you glanced at the newest reply
   * destroys the one piece of triage the user cannot reconstruct -- and in a
   * long institutional thread the unread one is usually the one that matters.
   *
   * The row therefore stays unread while an unread reply remains.
   */
  const { doc, win, calls, settle, restore } = await boot({ messages: THREADED });
  try {
    await settle(8);
    rows(doc).find((x) => x.dataset.id === 'c3').click();
    // Long enough for the mark-read grace period to elapse.
    await new Promise((r) => setTimeout(r, 1400));
    await settle(8);

    const read = calls.filter((c) => c.type === 'MARK_READ').map((c) => c.id);
    assert.deepEqual(read, ['c3'], 'only the message actually displayed');

    const row = doc.querySelector('#list .row[data-id="c3"]');
    assert.ok(
      row.classList.contains('unread'),
      'c2 is still unread, so the conversation is still unread'
    );
  } finally {
    restore();
  }
});

test('THREAD: selecting a conversation selects every message in it', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * THE RULE FOR ACTIONS ON A COLLAPSED ROW.
   *
   * A row IS the conversation, so ticking it and pressing Archive must archive
   * the exchange, not just its newest message. Archiving one reply and leaving
   * two behind is the single most confusing thing a threaded client can do --
   * the row appears to survive the action.
   *
   * The tick is placed on the row; the selection resolves to the members.
   */
  const { doc, win, calls, settle, restore } = await boot({ messages: THREADED });
  try {
    await settle(8);
    const conv = rows(doc).find((x) => x.dataset.id === 'c3');
    pick(conv, win);
    await settle(6);

    assert.equal(
      doc.getElementById('bulk-count').textContent, '3 selected',
      'one tick on a 3-message conversation selects three messages'
    );

    doc.getElementById('bulk-archive').click();
    await settled(doc, settle);

    const bulkCall = calls.find((c) => c.type === 'BULK' && (c.remove || []).includes('INBOX'));
    assert.ok(bulkCall, 'the archive must reach Gmail');
    assert.deepEqual(
      [...bulkCall.ids].sort(), ['c1', 'c2', 'c3'],
      'every message in the conversation, not just the newest'
    );
    assert.ok(
      !rows(doc).some((r) => r.dataset.id === 'c3'),
      'and the row must leave'
    );
  } finally {
    restore();
  }
});

test('THREAD: a tick survives a reply arriving in the same conversation', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * REGRESSION FOUND BY AN EXISTING TEST.
   *
   * Threading broke "selection survives a re-render": ticking a row and then
   * receiving a NEWER message in that conversation replaces the rendered root,
   * so the ticked id is no longer a row and the tick visually vanished.
   *
   * Selection is per-conversation, so the tick has to move to the new root.
   * The user ticked a conversation; a reply arriving does not un-tick it.
   */
  const { doc, win, settle, restore } = await boot({ messages: THREADED });
  try {
    await settle(8);
    pick(rows(doc).find((x) => x.dataset.id === 'c3'), win);
    await settle(6);
    assert.equal(doc.querySelectorAll('.row.picked').length, 1);

    // A fourth message lands in the same conversation.
    win.__bmmIngest([{
      id: 'c4', threadId: 'CONV',
      from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>',
      subject: 'Re: Revised schedule', snippet: 'One more thing.',
      date: Date.now(), unread: true, starred: false, labels: ['INBOX', 'UNREAD'],
    }]);
    await settle(10);

    assert.equal(
      doc.querySelectorAll('.row.picked').length, 1,
      'the conversation must still read as ticked'
    );
    assert.equal(
      doc.querySelector('.row.picked').dataset.id, 'c4',
      'and the tick follows the conversation to its new newest message'
    );
  } finally {
    restore();
  }
});

test('THREAD: archiving from the reader archives the whole conversation', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * `e` on a collapsed row must behave like the tick does. Archiving only the
   * newest message would leave the conversation on screen -- the row simply
   * re-renders showing the next message down, which reads as the action having
   * failed.
   */
  const { doc, win, calls, settle, restore } = await boot({ messages: THREADED });
  try {
    await settle(8);
    rows(doc).find((x) => x.dataset.id === 'c3').click();
    await settle(8);
    press(doc, win, 'e');
    await settled(doc, settle);

    const archived = calls.filter((c) => c.type === 'ARCHIVE').map((c) => c.id);
    const bulked = calls.filter((c) => c.type === 'BULK' && (c.remove || []).includes('INBOX'));
    const all = [...archived, ...bulked.flatMap((c) => c.ids)].sort();
    assert.deepEqual(
      all, ['c1', 'c2', 'c3'],
      'the exchange goes, not just its newest message'
    );
    assert.ok(
      !rows(doc).some((r) => ['c1', 'c2', 'c3'].includes(r.dataset.id)),
      'and the row leaves the list'
    );
  } finally {
    restore();
  }
});

test('THREAD: undo restores the whole conversation', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // An action that takes three messages must give three back. Restoring only
  // the root would silently lose two replies.
  const { doc, win, settle, restore } = await boot({ messages: THREADED });
  try {
    await settle(8);
    const before = rows(doc).length;
    rows(doc).find((x) => x.dataset.id === 'c3').click();
    await settle(8);
    press(doc, win, 'e');
    await settled(doc, settle);
    assert.equal(rows(doc).length, before - 1);

    press(doc, win, 'z', { ctrlKey: true });
    await settled(doc, settle);

    assert.equal(rows(doc).length, before, 'the conversation row returns');
    const { getStore } = { getStore: () => win.__bmmStore };
    assert.equal(
      getStore().thread('CONV').count, 3,
      'with all three messages, not just the one that was showing'
    );
  } finally {
    restore();
  }
});

test('THREAD: search shows the matching message, not its conversation root', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The deliberate exception. Searching for text that appears only in the
   * middle of a conversation must surface THAT message -- collapsing would
   * show the newest reply instead, which does not contain what you searched
   * for. Gmail does collapse here and it is its most complained-about search
   * behaviour.
   */
  const { doc, win, settle, restore } = await boot({ messages: THREADED });
  try {
    await settle(8);
    /*
     * `from:registrar` matches ONLY the middle message of the conversation.
     * The local index covers subject and sender, not snippets, so the query
     * targets a sender -- what matters here is that a match inside a
     * conversation surfaces as itself rather than as its newest sibling.
     */
    const search = doc.getElementById('search');
    search.value = 'from:registrar';
    search.dispatchEvent(new win.Event('input'));
    await settle(10);

    const ids = rows(doc).map((r) => r.dataset.id);
    assert.deepEqual(ids, ['c2'], `expected the matching message, got ${ids}`);
    assert.equal(
      rows(doc)[0].querySelector('.r-subj').textContent, 'Re: Revised schedule',
      'and its own subject, not the conversation title'
    );
    assert.equal(
      rows(doc)[0].querySelector('.r-count')?.hidden !== false, true,
      'a search hit is a message, so it carries no conversation count'
    );
  } finally {
    restore();
  }
});

test('THREAD: j/k steps between conversations, not messages', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Keyboard navigation walks renderedIds, which is now the collapsed list.
  // Three presses of j must reach three different conversations rather than
  // crawling through the replies of the first.
  const { doc, win, settle, restore } = await boot({ messages: THREADED });
  try {
    await settle(8);
    const seen = [];
    for (let i = 0; i < 3; i++) {
      press(doc, win, 'j');
      await settle(6);
      seen.push(doc.querySelector('#list .row[aria-selected="true"]')?.dataset.id);
    }
    assert.deepEqual(seen, ['c3', 's2', 's1'], 'one stop per conversation');
  } finally {
    restore();
  }
});

test('THREAD: replying from a conversation threads the reply correctly', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * A reply must continue the conversation, not start a new one. It replies to
   * the message being READ, which is the one whose headers make In-Reply-To
   * correct -- replying to the root while reading a later message would attach
   * the reply to the wrong point in the exchange.
   */
  const { doc, win, calls, settle, restore } = await boot({ messages: THREADED });
  try {
    await settle(8);
    rows(doc).find((x) => x.dataset.id === 'c3').click();
    await settle(8);
    doc.querySelector('#r-thread .r-msg[data-id="c2"]').click();
    await settle(10);

    press(doc, win, 'R', { shiftKey: true });
    await settle(10);

    const bodies = calls.filter((c) => c.type === 'GET_BODY').map((c) => c.id);
    assert.equal(
      bodies[bodies.length - 1], 'c2',
      'the reply is built from the message actually on screen'
    );
  } finally {
    restore();
  }
});

test('THREAD: threading survives a reload from cache', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The cache stores threadId (field 2 of the packed record), so a warm start
   * must rebuild the same conversations. If it did not, the list would look
   * different for the first few hundred milliseconds of every session -- the
   * exact kind of flicker that makes a client feel unreliable.
   */
  const blob = {
    v: 1, t: Date.now(),
    m: THREADED.map((x) => [
      x.id, x.threadId, x.from, x.subject, x.snippet, x.date,
      (x.unread ? 1 : 0) | (x.starred ? 2 : 0), 'augsd', 0.9, 'sender', '',
    ]),
  };
  const { doc, settle, restore } = await boot({
    messages: THREADED,
    storageSeed: { msgCache: blob, historyId: '12345' },
  });
  try {
    await settle(12);
    assert.equal(
      rows(doc).length, 3,
      'a warm start must collapse exactly as a cold one does'
    );
    const conv = rows(doc).find((r) => r.dataset.id === 'c3');
    assert.equal(conv.querySelector('.r-count').textContent, '3');
  } finally {
    restore();
  }
});

test('THREAD: the strip is reachable and announced by keyboard', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The strip is the only route to the older messages in a conversation, so a
   * keyboard user who cannot reach it cannot read half their mail. Real
   * buttons in a labelled list, with the current one pressed rather than
   * selected -- selected would collide with the message list's listbox.
   */
  const { doc, settle, restore } = await boot({ messages: THREADED });
  try {
    await settle(8);
    rows(doc).find((x) => x.dataset.id === 'c3').click();
    await settle(10);

    const strip = doc.getElementById('r-thread');
    assert.equal(strip.getAttribute('role'), 'list');
    assert.ok(strip.getAttribute('aria-label'), 'the strip must name itself');

    const parts = [...strip.querySelectorAll('.r-msg')];
    for (const p of parts) {
      assert.equal(p.tagName, 'BUTTON', 'each part must be focusable natively');
      assert.equal(p.getAttribute('role'), 'listitem');
      assert.ok(p.hasAttribute('aria-pressed'), 'and report whether it is current');
    }
    assert.equal(
      parts.filter((p) => p.getAttribute('aria-pressed') === 'true').length, 1,
      'exactly one message is current'
    );
  } finally {
    restore();
  }
});

test('THREAD: a conversation spanning a category shows under one of them', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * EDGE CASE. The classifier runs per message, so a reply can land in a
   * different category from the message it answers. Filtering by category
   * then asks for a conversation that only partly belongs there.
   *
   * The rule that falls out of collapsing after filtering: the conversation
   * appears under a category if ANY of its messages is filed there, and the
   * row is the newest message that qualifies. That keeps the mail findable
   * where the user expects it rather than hiding it under a sibling's label.
   */
  const mixed = [
    { ...THREADED[0], id: 'x1', threadId: 'MIX', subject: 'Fee payment',
      from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>', date: Date.now() - 8000_000 },
    { ...THREADED[1], id: 'x2', threadId: 'MIX', subject: 'Re: Fee payment',
      from: 'Library <library@pilani.bits-pilani.ac.in>', date: Date.now() - 2000_000 },
  ];
  const { doc, settle, restore } = await boot({ messages: mixed });
  try {
    await settle(8);
    assert.equal(rows(doc).length, 1, 'one conversation in All mail');

    const cats = [...doc.querySelectorAll('#cats .cat[data-cat]')]
      .filter((b) => {
        const c = b.lastElementChild;
        return c && (c.textContent || '').trim() !== '';
      })
      .map((b) => b.dataset.cat);

    // Whichever categories the two messages landed in, clicking each must
    // show the conversation rather than nothing.
    for (const cat of cats.filter((c) => c !== 'all')) {
      doc.querySelector(`#cats .cat[data-cat="${cat}"]`).click();
      await settle(6);
      assert.ok(
        rows(doc).length >= 1,
        `category ${cat} counts a message but shows no row`
      );
    }
  } finally {
    restore();
  }
});

/* ========================================================== incompleteness == */

test('TRASH: a deleted message can be restored', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * AUDIT 13 I-1. A message in Trash had ZERO available actions -- every flag
   * in actionsFor('trash') is false and nothing consumed `restore`. UNTRASH
   * existed in the worker and was reachable only from the undo stack, so
   * "I deleted the wrong thing" was recoverable for five minutes and never
   * again.
   *
   * Gmail's Trash is a recovery surface. This one was a viewing gallery.
   */
  const { doc, calls, settle, restore: teardown } = await boot({ perLabel: true });
  try {
    doc.querySelector('.cat[data-mailbox="trash"]').click();
    await settle(10);
    assert.ok(rows(doc).length, 'precondition: trash has messages');

    rows(doc)[0].click();
    await settle(8);

    const btn = doc.querySelector('#r-actions button[data-act="restore"]');
    assert.ok(btn, 'Trash must offer a way out');
    assert.equal(btn.hidden, false, 'and it must be visible in this mailbox');

    const id = rows(doc)[0].dataset.id;
    btn.click();
    await settled(doc, settle);

    assert.equal(
      calls.filter((c) => c.type === 'UNTRASH' && c.id === id).length, 1,
      'restoring must reach Gmail'
    );
    assert.ok(
      !rows(doc).some((r) => r.dataset.id === id),
      'and the message must leave the Trash list'
    );
  } finally {
    teardown();
  }
});

test('TRASH: restore is offered only where it means something', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // A control that does nothing is how a UI teaches people not to trust it.
  // "Restore" on an inbox message is meaningless.
  const { doc, settle, restore } = await boot({ perLabel: true });
  try {
    rows(doc)[0].click();
    await settle(8);
    const btn = doc.querySelector('#r-actions button[data-act="restore"]');
    assert.ok(btn, 'the control exists in the toolbar');
    assert.equal(btn.hidden, true, 'but is hidden outside Trash');
  } finally {
    restore();
  }
});

test('SNOOZE: a snoozed message says when it wakes, and can be woken now', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * AUDIT 13 I-4. Every piece existed -- UNSNOOZE in the worker, removeSnooze
   * in the domain, `unsnooze` in the action matrix, and wakeLabel() imported
   * into app.js and never called. Nothing was wired.
   *
   * Snooze is a promise about the future. A list of messages that will return
   * at unstated times, with no way to change your mind, is worse than not
   * snoozing them at all.
   */
  const wakeAt = Date.now() + 86_400_000;
  const { doc, calls, settle, restore } = await boot({
    perLabel: true,
    storageSeed: { snoozed: { sent0: wakeAt } },
  });
  try {
    doc.querySelector('.cat[data-mailbox="snoozed"]').click();
    await settle(10);
    assert.ok(rows(doc).length, 'precondition: something is snoozed');

    rows(doc)[0].click();
    await settle(8);

    const btn = doc.querySelector('#r-actions button[data-act="unsnooze"]');
    assert.ok(btn, 'a snoozed message must be wakeable');
    assert.equal(btn.hidden, false);

    const id = rows(doc)[0].dataset.id;
    btn.click();
    await settled(doc, settle);

    assert.equal(
      calls.filter((c) => c.type === 'UNSNOOZE' && c.id === id).length, 1,
      'waking must reach Gmail'
    );
  } finally {
    restore();
  }
});

test('CLASSIFY: a miscategorised message can be corrected from the reader', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * AUDIT 13 I-3, and the most serious finding in it.
   *
   * correctSender() and clearCorrection() are both implemented and tested.
   * NEITHER WAS CALLED FROM ANYWHERE. applyCorrection() -- the read side --
   * runs on every ingest, so the product faithfully applied a correction store
   * that no user could write to.
   *
   * This is the headline differentiator: fifteen BITS categories, ~1000 rules,
   * and when it filed something wrong the user's only option was to live with
   * it. The README describes correcting the classifier as a feature.
   */
  const { doc, settle, restore, storage } = await boot();
  try {
    await settle(8);
    rows(doc)[0].click();
    await settle(8);

    const btn = doc.getElementById('r-recat');
    assert.ok(btn, 'the reader must offer a way to say "wrong category"');
    btn.click();
    await settle(6);

    const menu = doc.querySelector('.cat-menu');
    assert.ok(menu, 'and offer the categories to move it to');
    const target = [...menu.querySelectorAll('button')]
      .find((b) => /Library/i.test(b.textContent));
    assert.ok(target, 'every real category must be offered');
    target.click();
    await settle(10);

    const saved = storage.categoryRules?.corrections || {};
    assert.deepEqual(
      Object.values(saved), ['library'],
      'the correction must persist, keyed by sender'
    );
    assert.equal(
      doc.querySelector('#list .row[aria-selected="true"] .tag').textContent,
      'Library',
      'and the message must move immediately, not on next sync'
    );
  } finally {
    restore();
  }
});

test('CLASSIFY: a correction can be undone', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * clearCorrection() existed and was referenced NOWHERE -- zero times, not
   * even an unused import. Teaching a classifier something wrong and being
   * unable to un-teach it is worse than not being able to teach it.
   */
  const { doc, settle, restore, storage } = await boot();
  try {
    await settle(8);
    rows(doc)[0].click();
    await settle(8);
    doc.getElementById('r-recat').click();
    await settle(6);
    [...doc.querySelectorAll('.cat-menu button')]
      .find((b) => /Library/i.test(b.textContent)).click();
    await settle(10);
    assert.equal(Object.keys(storage.categoryRules.corrections).length, 1);

    // Re-open the menu: it must now offer to undo what was just taught.
    doc.getElementById('r-recat').click();
    await settle(6);
    const undo = [...doc.querySelectorAll('.cat-menu button')]
      .find((b) => /use the automatic|clear/i.test(b.textContent));
    assert.ok(undo, 'a taught sender must be un-teachable');
    undo.click();
    await settle(10);

    assert.deepEqual(
      storage.categoryRules.corrections, {},
      'the correction must be gone, not merely overwritten'
    );
  } finally {
    restore();
  }
});

test('DRAFTS: a draft can be opened, finished and re-saved', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * AUDIT 13 I-2. actionsFor('drafts') returned `edit: true` and nothing read
   * it. You could see your drafts and delete them. You could not continue
   * writing one -- and a draft exists ONLY to be finished.
   *
   * The product already had compose, autosave and crash recovery; this is the
   * single path that connects them to the Drafts mailbox.
   *
   * Re-saving must UPDATE the existing draft rather than create a second one,
   * or editing a draft twice leaves three copies in Gmail.
   */
  const { doc, win, calls, settle, restore } = await boot({ perLabel: true });
  try {
    doc.querySelector('.cat[data-mailbox="drafts"]').click();
    await settle(10);
    assert.ok(rows(doc).length, 'precondition: there are drafts');

    rows(doc)[0].click();
    await settle(8);

    const btn = doc.querySelector('#r-actions button[data-act="edit"]');
    assert.ok(btn, 'a draft must be openable');
    assert.equal(btn.hidden, false, 'and the control must be visible here');

    btn.click();
    await settle(12);

    assert.equal(
      doc.getElementById('compose').hidden, false,
      'editing must open compose'
    );
    assert.ok(
      calls.some((c) => c.type === 'GET_DRAFT'),
      'and must fetch the draft rather than guess at its contents'
    );

    doc.getElementById('c-text').value = 'Finished at last.';
    doc.getElementById('c-draft').click();
    await settle(12);

    const saves = calls.filter((c) => c.type === 'SAVE_DRAFT');
    assert.ok(saves.length, 'saving must reach Gmail');
    assert.ok(
      saves[saves.length - 1].draftId,
      're-saving must UPDATE the draft, not create a second copy'
    );
  } finally {
    restore();
  }
});

test('DRAFTS: attachments survive the edit -> save round trip (bug-hunt P0)', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * THE REGRESSION THIS PINS. Editing a Gmail draft used to rebuild the MIME
   * without the original attachments -- silent data loss rated Severe. The
   * fix carries attachment METADATA through compose and hydrates the bytes
   * at the wire. This test owns the app half of that contract:
   *   GET_DRAFT(metadata) -> chip on screen -> SAVE_DRAFT still lists it.
   * Hydration itself is unit-pinned in gmail.test.mjs; here we verify the
   * metadata never falls off between opening and saving.
   */
  const { doc, win, calls, settle, restore } = await boot({ perLabel: true, draftAttachments: true });
  try {
    doc.querySelector('.cat[data-mailbox="drafts"]').click();
    await settle(10);
    rows(doc)[0].click();
    await settle(8);
    doc.querySelector('#r-actions button[data-act="edit"]').click();
    await settle(10);

    const box = doc.getElementById('c-files');
    assert.equal(box.hidden, false, 'the preserved attachment must appear as a chip');
    assert.match(box.textContent, /report\.pdf/, 'named, so the user can see what is kept');

    doc.getElementById('c-text').value = 'Finished.';
    doc.getElementById('c-draft').click();
    await settle(12);

    const saves = calls.filter((c) => c.type === 'SAVE_DRAFT');
    assert.ok(saves.length, 'saving must reach Gmail');
    const atts = saves[saves.length - 1].draft.attachments;
    assert.ok(Array.isArray(atts) && atts.length === 1,
      'the saved draft must still list its attachment');
    assert.equal(atts[0].attachmentId, 'att-1', 'with the refetch source intact');
    assert.equal(atts[0].data, Buffer.from('bytes-of-att-1').toString('base64'),
      'and the worker-side hydration must have replaced metadata with bytes');
  } finally {
    restore();
  }
});

test('DRAFTS: a preserved attachment survives SEND through the outbox (bug-hunt P0)', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The send path: edited draft -> outbox -> OUTBOX_PUMP -> the wire. The
  // queued draft must carry the metadata so the pump's hydrator can refetch.
  // bootSending seeds undoSendSeconds: 0 so the item is due immediately.
  const { doc, win, calls, settle, restore } = await bootSending({ perLabel: true, draftAttachments: true });
  try {
    doc.querySelector('.cat[data-mailbox="drafts"]').click();
    await settle(10);
    rows(doc)[0].click();
    await settle(8);
    doc.querySelector('#r-actions button[data-act="edit"]').click();
    await settle(10);

    doc.getElementById('c-to').value = 'a@pilani.bits-pilani.ac.in';
    doc.getElementById('c-text').value = 'Sending the finished draft.';
    doc.getElementById('c-send').click();
    await settle(10);
    await drainOutbox(win, settle);

    const sent = calls.find((c) => c.type === 'SEND');
    assert.ok(sent, 'the message must be sent');
    const atts = sent.draft.attachments;
    assert.ok(Array.isArray(atts) && atts.length === 1,
      'the queued draft must carry its attachment');
    assert.equal(atts[0].attachmentId, 'att-1');
    assert.equal(atts[0].messageId, 'draft0', 'and the message to refetch it from');
  } finally {
    restore();
  }
});

test('DRAFTS: removing a preserved chip drops it from the save (bug-hunt P0)', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Preservation must stay a CHOICE: the user removes the chip, the save
  // respects it. (The opposite direction -- dropping without asking -- was
  // the original bug.)
  const { doc, calls, settle, restore } = await boot({ perLabel: true, draftAttachments: true });
  try {
    doc.querySelector('.cat[data-mailbox="drafts"]').click();
    await settle(10);
    rows(doc)[0].click();
    await settle(8);
    doc.querySelector('#r-actions button[data-act="edit"]').click();
    await settle(10);

    const rm = doc.querySelector('#c-files button');
    assert.ok(rm, 'the chip must be removable');
    rm.click();
    await settle(6);

    doc.getElementById('c-text').value = 'No attachment now.';
    doc.getElementById('c-draft').click();
    await settle(12);

    const saves = calls.filter((c) => c.type === 'SAVE_DRAFT');
    const atts = saves[saves.length - 1].draft.attachments;
    assert.ok(!atts || atts.length === 0, 'a removed chip must stay removed');
  } finally {
    restore();
  }
});

test('DRAFTS: attachment BYTES reach the wire on SEND (Phase 2 protection)', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The strongest guard on the P0 fix: metadata leaves GET_DRAFT, rides the
   * compose panel and the outbox, and the pump HYDRATES it -- the assertion
   * is on the bytes at the wire, not on the metadata in flight. The harness
   * substitutes deterministic fake bytes for the refetch, which is exactly
   * the contract being pinned: whatever the refetch returns is what ships.
   */
  const { doc, win, calls, settle, restore } = await bootSending({ perLabel: true, draftAttachments: true });
  try {
    doc.querySelector('.cat[data-mailbox="drafts"]').click();
    await settle(10);
    rows(doc)[0].click();
    await settle(8);
    doc.querySelector('#r-actions button[data-act="edit"]').click();
    await settle(10);
    doc.getElementById('c-to').value = 'a@pilani.bits-pilani.ac.in';
    doc.getElementById('c-text').value = 'Sending with its file.';
    doc.getElementById('c-send').click();
    await settle(10);
    await drainOutbox(win, settle);

    const sent = calls.find((c) => c.type === 'SEND');
    assert.ok(sent, 'the message must be sent');
    const att = sent.draft.attachments[0];
    assert.equal(att.filename, 'report.pdf');
    assert.equal(att.data, Buffer.from('bytes-of-att-1').toString('base64'),
      'the hydrated bytes -- not metadata -- must be what reaches the wire');
  } finally {
    restore();
  }
});

test('DRAFTS: attachment BYTES reach the wire on SAVE_DRAFT (Phase 2 protection)', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The save path rebuilds the MIME in the worker too; the bytes contract is
  // identical, so it gets its own test rather than sharing the SEND one.
  const { doc, calls, settle, restore } = await boot({ perLabel: true, draftAttachments: true });
  try {
    doc.querySelector('.cat[data-mailbox="drafts"]').click();
    await settle(10);
    rows(doc)[0].click();
    await settle(8);
    doc.querySelector('#r-actions button[data-act="edit"]').click();
    await settle(10);
    doc.getElementById('c-text').value = 'Saving with its file.';
    doc.getElementById('c-draft').click();
    await settle(12);

    const saves = calls.filter((c) => c.type === 'SAVE_DRAFT');
    assert.ok(saves.length, 'the save must reach Gmail');
    const att = saves[saves.length - 1].draft.attachments[0];
    assert.equal(att.data, Buffer.from('bytes-of-att-1').toString('base64'),
      'a re-saved draft must carry the refetched bytes');
  } finally {
    restore();
  }
});

test('OUTBOX: a permanently lost attachment goes stuck, not four identical retries (Phase 2 protection)', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * failHydration turns the refetch into the permanent-loss error. First
   * pump: failed, attempt 1, retry scheduled. Second identical failure must
   * short-circuit to STUCK (the bug-hunt 43 #33 rule), not burn the whole
   * backoff ladder over 16 minutes.
   */
  const { doc, win, settle, restore } = await bootSending({ perLabel: true, draftAttachments: true, failHydration: true });
  try {
    doc.querySelector('.cat[data-mailbox="drafts"]').click();
    await settle(10);
    rows(doc)[0].click();
    await settle(8);
    doc.querySelector('#r-actions button[data-act="edit"]').click();
    await settle(10);
    doc.getElementById('c-to').value = 'a@pilani.bits-pilani.ac.in';
    doc.getElementById('c-text').value = 'Doomed send.';
    doc.getElementById('c-send').click();
    await settle(10);
    await drainOutbox(win, settle);

    const read = async () => ((await win.chrome.storage.local.get('outbox')).outbox) || [];
    const queue = await read();
    assert.equal(queue.length, 1, 'the item stays queued');
    assert.equal(queue[0].state, 'failed');
    assert.match(queue[0].error, /Cannot recover attachment/);
    // A permanently lost attachment cannot heal by waiting (bug-hunt 43 #33):
    // the FIRST such failure goes straight to the cap instead of burning four
    // identical retries across 16 minutes.
    assert.equal(queue[0].attempts, 4, 'straight to stuck on the first loss');
  } finally {
    restore();
  }
});

test('DRAFTS: the edit control is offered only in Drafts', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // "Edit" on a received message is meaningless, and a control that does
  // nothing is how a UI teaches people not to trust it.
  const { doc, settle, restore } = await boot({ perLabel: true });
  try {
    rows(doc)[0].click();
    await settle(8);
    const btn = doc.querySelector('#r-actions button[data-act="edit"]');
    assert.ok(btn, 'the control exists in the toolbar');
    assert.equal(btn.hidden, true, 'but is hidden outside Drafts');
  } finally {
    restore();
  }
});

test('UNDO: a rolled-back action restores the message as it was', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * SABOTAGE EXPOSED THIS TEST AS MISSING.
   *
   * The optimistic helper snapshots BEFORE mutating. Taking the snapshot after
   * `store.remove(id)` instead changed no existing test -- undo still put a
   * row back, because the row came from the surviving reference. What broke
   * silently was the CONTENT: the restored message carried post-change field
   * values, so an undone star or an undone read-state came back wrong.
   *
   * This asserts the restored message equals the original field for field,
   * which is the only way the ordering is visible from outside.
   */
  /*
   * `markReadOnOpen` is DISABLED here, and that is not incidental.
   *
   * This test opens a message, archives it and undoes that. Opening also arms
   * the 1200ms mark-read timer. The test's own waits -- 260ms in `settled()`
   * twice, plus frames -- normally finish well inside that window, so the
   * timer is cancelled by teardown and never fires. Under load they do not:
   * the timer fires AFTER the undo has restored the snapshot, flips `unread`
   * back to false, and the field-by-field comparison fails on `unread`.
   *
   * That was a real intermittent failure (roughly one run in four on a busy
   * machine), and it failed for a reason that has nothing to do with what
   * this test is about. Turning the setting off removes the clock from the
   * measurement: what is left is purely whether the snapshot was taken
   * before or after the mutation, which is the thing under test.
   */
  const { doc, win, settle, restore } = await boot({
    storageSeed: { markReadOnOpen: false },
  });
  try {
    await settle(8);
    const before = win.__bmmStore.get(MESSAGES[0].id);
    assert.ok(before, 'precondition: the message is in the store');
    assert.equal(before.unread, true, 'precondition: it starts unread, so undo has something to restore');
    const original = { ...before };

    rows(doc)[0].click();
    await settle(6);
    press(doc, win, 'e');            // archive
    await settled(doc, settle);
    assert.equal(win.__bmmStore.get(original.id), undefined, 'it left the store');

    press(doc, win, 'z', { ctrlKey: true });
    await settled(doc, settle);

    const after = win.__bmmStore.get(original.id);
    assert.ok(after, 'undo must put the message back');
    for (const field of ['id', 'threadId', 'from', 'subject', 'snippet', 'date',
      'unread', 'starred', 'category']) {
      assert.deepEqual(
        after[field], original[field],
        `undo restored a different ${field}: the snapshot was taken too late`
      );
    }
  } finally {
    restore();
  }
});

/* ==========================================================================
 * SURVIVORS: the wired-in features (28, 29)
 *
 * These are the ones that touch app.js rather than living in a pure module,
 * so they can only be verified with the real DOM booted.
 * ========================================================================== */

test('the row snippet is CLEANED, not the raw institutional boilerplate', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, restore } = await boot({
    messages: [{
      id: 'x1', threadId: 'tx1',
      from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>',
      subject: 'Fee payment',
      snippet: 'Dear Students, Greetings from AUGSD. This is to inform you that the SBI counter closes at 5pm on Friday.',
      date: Date.now(), unread: true, starred: false, labels: ['INBOX', 'UNREAD'],
    }],
  });
  try {
    await settle();
    const snip = doc.querySelector('.r-snip').textContent;
    assert.doesNotMatch(snip, /Dear Students/, 'the salutation is gone');
    assert.doesNotMatch(snip, /Greetings from/, 'the throat-clearing is gone');
    assert.match(snip, /SBI counter/, 'the actual content survived');
  } finally {
    restore();
  }
});

test('a snippet that only restates the subject leaves the line blank', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, restore } = await boot({
    messages: [{
      id: 'x2', threadId: 'tx2',
      from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>',
      subject: 'Mid-semester exam schedule',
      snippet: 'Dear all, the mid semester examination schedule is attached.',
      date: Date.now(), unread: true, starred: false, labels: ['INBOX', 'UNREAD'],
    }],
  });
  try {
    await settle();
    // A blank second line is better than one that repeats the subject.
    assert.equal(doc.querySelector('.r-snip').textContent, '');
  } finally {
    restore();
  }
});

test('density is applied to the root element at boot', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, restore } = await boot();
  try {
    await settle();
    // Always stated, never absent -- a missing attribute and the default would
    // be indistinguishable when reading a screenshot.
    assert.equal(doc.documentElement.getAttribute('data-density'), 'comfortable');
  } finally {
    restore();
  }
});

test('a stored density is honoured at boot', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * Settings are stored as FLAT TOP-LEVEL KEYS, not nested under a `settings`
   * object -- `loadSettings` does `storage.get(Object.keys(SCHEMA))`. Seeding
   * `{settings: {density: 'compact'}}` writes a key nothing reads, and the
   * test failed with the default. Worth the note: the nested shape is the
   * obvious guess and it is wrong.
   */
  const { doc, settle, restore } = await boot({
    storageSeed: { density: 'compact' },
  });
  try {
    await settle();
    assert.equal(doc.documentElement.getAttribute('data-density'), 'compact');
  } finally {
    restore();
  }
});

test('changing density from the options page repaints without a reload', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, changeSetting, restore } = await boot();
  try {
    await settle();
    await changeSetting('density', 'cosy');
    await settle();
    assert.equal(doc.documentElement.getAttribute('data-density'), 'cosy');
  } finally {
    restore();
  }
});

/* ==========================================================================
 * UI COMPLETENESS (audit 22)
 *
 * Empty states and accessible names. Each of these was a surface that
 * rendered nothing, or a control with no name, where the rest of the product
 * already had an idiom for the same situation.
 * ========================================================================== */

test('the saved-views section explains itself when it has no views', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // A heading over blank space is the classic unfinished signal. #radar hides
  // when empty; #views did not, and had no copy either.
  const { doc, settle, restore } = await boot({ storageSeed: { savedViews: { views: [], hidden: ['sv-unread','sv-direct','sv-overdue','sv-week','sv-starred','sv-stale','sv-noise','sv-attach'] } } });
  try {
    await settle();
    const empty = doc.getElementById('views-empty');
    assert.ok(empty, 'the empty slot exists');
    assert.equal(empty.hidden, false, 'it shows when there are no views');
    assert.match(empty.textContent, /\S/, 'and it says something');
  } finally {
    restore();
  }
});

test('the saved-views empty line disappears once a view exists', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, restore } = await boot();
  try {
    await settle();
    // The built-in views ship enabled, so the list is non-empty by default.
    assert.ok(doc.querySelectorAll('#views-list li').length > 0, 'built-ins render');
    assert.equal(doc.getElementById('views-empty').hidden, true, 'the empty line is hidden');
  } finally {
    restore();
  }
});

test('the palette says so when nothing matches, and offers a way forward', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * A modal, keyboard-driven surface that renders nothing is worse than an
   * ordinary empty list: the user has committed to a flow and gets no signal
   * about whether they mistyped or the command does not exist.
   */
  const { doc, win, settle, restore } = await boot();
  try {
    await settle();
    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    await settle();

    const input = doc.getElementById('palette-input');
    assert.ok(input, 'the palette opened');
    input.value = 'zzzznotacommand';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    await settle();

    const rows = doc.querySelectorAll('#palette-list .palette-item');
    assert.equal(rows.length, 1, 'exactly one row: the empty state');
    assert.match(rows[0].textContent, /zzzznotacommand/, 'it quotes what was typed');
    assert.match(rows[0].textContent, /search/i, 'and offers the search fallback');
  } finally {
    restore();
  }
});

test('the undo button has an accessible name in the markup, not only from JS', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * #toast-action is the recovery control for every destructive action in the
   * product, and it was the one button in app.html with no text, no title and
   * no aria-label -- named only at runtime, so unnamed between first paint and
   * that assignment.
   */
  const { doc, restore } = await boot();
  try {
    const btn = doc.getElementById('toast-action');
    assert.ok(btn.getAttribute('aria-label'), 'the undo button is named before JS touches it');
  } finally {
    restore();
  }
});


/* ==========================================================================
 * NON-HAPPY-PATH STATES (audit 27)
 * ========================================================================== */

test('going offline shows a persistent banner, not a 2-second toast', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * `navigator.onLine` appeared nowhere, so a dropped connection fell to the
   * last branch of reportError() and surfaced as toast("Failed to fetch") --
   * browser jargon, styled as INFORMATION rather than a problem, gone in
   * 2200ms.
   *
   * Offline is not an event, it is a CONDITION: still true thirty seconds
   * later, which is the wrong shape for a toast entirely.
   */
  const { doc, win, settle, restore } = await boot();
  try {
    await settle();
    assert.equal(doc.getElementById('net-warn'), null, 'nothing while online');

    win.dispatchEvent(new win.Event('offline'));
    await settle();

    const bar = doc.getElementById('net-warn');
    assert.ok(bar, 'losing the connection must say so');
    assert.equal(bar.getAttribute('role'), 'alert', 'and interrupt for it');
    // The point is not "you are offline" -- the user knows. It is what STILL
    // WORKS, which is what stops them retrying by hand.
    assert.match(bar.textContent, /already downloaded/i, 'must say cached mail is readable');
    assert.match(bar.textContent, /queued/i, 'must say sends are not lost');
  } finally {
    restore();
  }
});

test('reconnecting clears the banner and catches up', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, calls, settle, restore } = await boot();
  try {
    await settle();
    win.dispatchEvent(new win.Event('offline'));
    await settle();
    assert.ok(doc.getElementById('net-warn'), 'precondition: banner is up');

    const before = calls.length;
    win.dispatchEvent(new win.Event('online'));
    await settle(6);

    assert.equal(doc.getElementById('net-warn'), null, 'the banner clears itself');
    assert.ok(calls.length > before, 'and the app catches up rather than waiting for the next poll');
  } finally {
    restore();
  }
});

test('the offline banner has no dismiss control', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * Unlike the worker banner, which describes something the user can do
   * nothing about and may last the session. This one clears itself the moment
   * the network returns, so a dismiss button would only let someone hide a
   * fact that is still true.
   */
  const { doc, win, settle, restore } = await boot();
  try {
    await settle();
    win.dispatchEvent(new win.Event('offline'));
    await settle();
    assert.equal(doc.querySelectorAll('#net-warn button').length, 0);
  } finally {
    restore();
  }
});

test('the gate explains why it wants a client ID, and only then', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The first screen a new user sees was asking for a Google Cloud OAuth
   * client ID with no explanation of what one is. A returning user whose
   * session merely expired must NOT see it -- they already have one, and
   * showing it always turns onboarding into permanent furniture.
   */
  const { doc, win, settle, restore } = await boot({ signedIn: false });
  try {
    await settle();
    const why = doc.getElementById('gate-why');
    assert.ok(why, 'the explanation must exist');

    win.__bmmShowGate?.('No OAuth client ID configured. Open the extension options.');
    await settle();
    assert.equal(why.hidden, false, 'shown for the error it explains');

    win.__bmmShowGate?.('Session expired. Sign in again.');
    await settle();
    assert.equal(why.hidden, true, 'hidden for every other reason');
  } finally {
    restore();
  }
});
