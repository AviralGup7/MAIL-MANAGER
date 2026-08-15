/**
 * Shared harness for the app integration suites (audit R3-01).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `test/app.mail.integration.test.mjs` booted 108 real jsdom documents in ONE
 * process and died with
 *
 *   FATAL ERROR: Ineffective mark-compacts near heap limit
 *   JavaScript heap out of memory   (SIGABRT)
 *
 * -- which made `npm test`, the command the README points at, RED on a clean
 * clone. It had been reported (EXT-H2 / AUD-I08) and answered by raising
 * --max-old-space-size; the file then grew past the new ceiling too, and at
 * the CI budget of 3072 MB it was still killed after 94 boots. Raising a
 * ceiling is a countdown, not a fix.
 *
 * The real constraint is measured and unavoidable: jsdom retains memory per
 * document even after close() and an explicit gc(). The only durable answer
 * is to BOUND THE NUMBER OF DOCUMENTS PER PROCESS, so the suite is split into
 * parts that each boot a third of them. `node --test` runs each file in its
 * own process, and the CI sharder deals them to different jobs, so the split
 * bounds peak heap by construction rather than by budget.
 *
 * The harness lives here so the parts cannot drift: one boot(), one restore(),
 * one set of DOM helpers. A helper declared beside its first caller does not
 * survive a split -- that lesson is already written into this file's history.
 *
 * NOT a test file: no test() calls, so the runner does not treat it as a
 * suite and the skip-proof gate does not count it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { makeFakeWorker } from './worker-contract.mjs';

/* ../.. because this module sits in test/helpers/, one level deeper
   than the suites that used to own this line. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/* jsdom is an optional devDependency. The harness only reports its absence;
   each suite decides how to skip, because a test() call here would make this
   helper a suite of its own. */
let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = undefined;
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
async function boot({ signedIn = true, messages = MESSAGES, storageSeed = {}, bodyOverride = {}, syncLatency = 0, slowVerbs = {}, perLabel = false, emptyLabels = [], labels = [], timetableData = null, storageTimetable = undefined, deadWorker = false, failVerbs = [] } = {}) {
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
        const delay = msg.type === 'SYNC_PAGE' ? syncLatency : (slowVerbs[msg.type] || 0);
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
  const url = pathToFileURL(join(ROOT, 'src/app/main.js')).href + `?t=${Math.random()}`;
  await import(url);
  // Round 59 (roadmap M-2): stateful modules SELF-REGISTER their resets
  // (reset-registry.js), so the harness runs one call instead of seven
  // hand-maintained captures. layers.js is special: close WITH teardown
  // FIRST — tenants null their cached handles inside onClose — then the
  // registered raw wipe runs with the rest.
  ({ resetAll: resetRegistered } = await import('../../src/app/core/reset-registry.js'));
  ({ closeAllLayers: layersCloseAll } = await import('../../src/app/overlays/layers.js'));
  const ttStore = await import('../../src/app/academic/timetable-store.js');
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
     * are cached -- so stateful modules keep their state across tests, still
     * pointing at the document we are about to discard. Left alone it produces
     * tests that pass on a previous test's data. Each module SELF-REGISTERS
     * its reset (reset-registry.js, roadmap M-2); layers close WITH teardown
     * first so tenants null their cached handles, then the registered wipe
     * runs with the rest.
     */
    try {
      layersCloseAll?.();
      resetRegistered?.();
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
     * LATE-CHROME NO-OP: the same hazard, one API along.
     *
     * A deferred app callback (the post-sync cache flush, an intent drain)
     * can land after restore() has swapped `globalThis.chrome` back to
     * undefined, and `chrome.runtime.sendMessage` then throws
     * "Cannot read properties of undefined (reading 'runtime')". node:test
     * attributes that to whichever test is running — or, when nothing is,
     * fails the FILE with no assertion attached. That is exactly the
     * misleading shape the RAF guard above was written for, so it gets the
     * same treatment: an inert stub, only when the real one is gone.
     *
     * This is a HARNESS concern, not a product bug being papered over: the
     * app's own teardown cancels its work, but a promise already resolved
     * cannot be un-queued, and in a browser `chrome` never disappears
     * mid-flight the way it does between two tests in one process.
     */
    const noop = () => {};
    if (globalThis.chrome === undefined) {
      const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
      globalThis.chrome = {
        runtime: { sendMessage: noop, lastError: null, getURL: (p) => p, id: 'test' },
        storage: { local: area, session: area, onChanged: { addListener: noop, removeListener: noop } },
      };
    }
    /*
     * `window` and `document` go the same way. A late callback that reaches
     * `window.addEventListener` (the online/offline re-arm) or reads
     * `document` finds `undefined` between tests, because the previous
     * globals were restored above and node:test has no DOM of its own.
     * These stubs absorb the call and DROP it — deliberately inert, so a
     * leftover cannot mutate anything or resurrect a listener on the next
     * boot's document.
     */
    if (globalThis.window === undefined) {
      globalThis.window = {
        addEventListener: noop, removeEventListener: noop,
        matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
        requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
        postMessage: noop, location: { href: '', search: '' },
      };
    }
    if (globalThis.document === undefined) {
      globalThis.document = {
        addEventListener: noop, removeEventListener: noop,
        querySelector: () => null, querySelectorAll: () => [],
        getElementById: () => null,
        documentElement: { style: { setProperty: noop }, setAttribute: noop, classList: { add: noop, remove: noop, toggle: noop } },
        body: { classList: { add: noop, remove: noop, toggle: noop } },
        hidden: true,
      };
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

/** Reset-registry runner + layers teardown, captured at boot. See restore(). */
let resetRegistered = null;
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




/* ---- fixtures and helpers shared across the parts ------------------------
 * These were declared in the middle of the original single file, beside
 * their first caller. The three-way split (audit R3-01) severed them from
 * later callers -- `cacheBlob is not defined` -- which is precisely the
 * failure the file's own history warned about when it was split in two.
 * They live here now so there is ONE definition and no part can drift.
 * -------------------------------------------------------------------------- */

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
  const { _setLabels } = await import('../src/app/overlays/palette.js');
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

/* ---- exports ------------------------------------------------------------
 * Everything the parts need. Kept explicit rather than `export *` so an
 * accidental new global in one part cannot silently become shared state.
 * -------------------------------------------------------------------------- */
export {
  JSDOM, ROOT,
  boot, bootSending, drainOutbox,
  MESSAGES,
  rows, rowText, settled, countParts,
  bulk, pick, press,
  NOON_TODAY, DUE_MESSAGES, cacheBlob, seedLabels, openPaletteWith, paletteLabels,
};
