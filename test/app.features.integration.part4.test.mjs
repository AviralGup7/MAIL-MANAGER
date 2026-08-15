/*
 * PART TWO OF THE INTEGRATION SUITE.
 *
 * Split from app.mail.integration.test.mjs for MEMORY, not for organisation.
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
 * End-to-end app tests in a real DOM — features part 4 of 4: threading, search and the rest.
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
  const url = pathToFileURL(join(ROOT, 'src/app/main.js')).href + `?t=${Math.random()}`;
  await import(url);
  // Round 59 (roadmap M-2): stateful modules SELF-REGISTER their resets
  // (reset-registry.js), so the harness runs one call instead of seven
  // hand-maintained captures. layers.js is special: close WITH teardown
  // FIRST — tenants null their cached handles inside onClose — then the
  // registered raw wipe runs with the rest.
  ({ resetAll: resetRegistered } = await import('../src/app/core/reset-registry.js'));
  ({ closeAllLayers: layersCloseAll } = await import('../src/app/overlays/layers.js'));
  const ttStore = await import('../src/app/academic/timetable-store.js');
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



/* ---- helpers shared by every part ---------------------------------------
 * Hoisted out of the middle of the file: the split (audit R3-01) puts
 * their callers in other parts, and a helper beside its first caller does
 * not survive that.
 * -------------------------------------------------------------------------- */

const clickMailbox = (doc, id) => doc.querySelector(`.cat[data-mailbox="${id}"]`).click();

const subjects = (doc) => [...doc.querySelectorAll('#list .r-subj')].map((e) => e.textContent);

const currentMailbox = (doc) =>
  doc.querySelector('.cat[data-mailbox][aria-current="true"]')?.dataset.mailbox;

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

/*
 * ROUND-57 PILOT EVALUATION (audits/56 §7). The workspace model is judged on
 * two questions — is the UI easier to navigate, and does an agent get a
 * bounded domain. These tests turn Q1 claims into contracts: honest rooms,
 * the roving keyboard pattern, and exits back to mail from every door.
 */
const buildCS = async (doc, win, settle) => {
  const results = await ttSearch(doc, win, settle, 'CS F111');
  results[0].querySelector('button').click();
  await settle(4);
  const lectures = [...doc.querySelectorAll('.tt-chooser .tt-section')];
  lectures.find((b) => b.textContent.startsWith('L1')).click();
  await settle(8);
  const labs = [...doc.querySelectorAll('.tt-chooser .tt-section')];
  labs.find((b) => b.textContent.startsWith('P2')).click();
  await settle(8);
};

const dialogButtons = (doc) => [...doc.querySelectorAll('.prompt-backdrop .prompt-actions button')];

const acceptDialog = (doc) => { const b = dialogButtons(doc); return b[b.length - 1]; };

const declineDialog = (doc) => dialogButtons(doc)[0];

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

/* SPLIT FOR HEAP (audit R3-01): 115 jsdom boots in one process crossed
   the V8 ceiling. node --test gives each FILE its own process, so parts
   bound peak heap by construction. ci-selfcheck caps boots per file. */
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
    // Round 61 P-1: the effect is SEEN in both places the user looks —
    // the open message re-files itself in place, and the toast names the
    // scope, so nobody infers what happened from the list behind them.
    assert.equal(
      doc.querySelector('#r-tags .tag').textContent,
      'Library',
      'the open message re-tags itself without a reopen'
    );
    assert.match(
      doc.getElementById('toast-text').textContent,
      /now files under Library — \d+ re-filed/,
      'and the toast reports the future rule with its measured scope'
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

