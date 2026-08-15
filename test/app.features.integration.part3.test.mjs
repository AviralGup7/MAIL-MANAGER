/*
 * THE FEATURES INTEGRATION SUITE, IN FOUR PARTS.
 *
 * Split for MEMORY, not for organisation.
 *
 * Every boot() builds a full JSDOM document -- DOM tree, CSSOM, timers,
 * listeners, an ES module graph -- and jsdom retains some of it even after
 * win.close() and an explicit gc(). At 115 boots in one process this file
 * crossed the V8 ceiling and aborted with SIGABRT, which surfaces as a test
 * failure with no assertion attached and sends you hunting a logic bug that
 * is not there (audit R3-01).
 *
 * Node runs each test FILE in its own process, so parts bound the peak live
 * set by construction. Earlier measurements on the mail suite: a 900MB heap
 * died at 111 tests, 1100MB at 143, 1400MB at ~190 -- growth, not GC
 * pressure, which is why a bigger flag was never the answer. tools/
 * ci-selfcheck.mjs now caps boots per file so this cannot creep back.
 *
 * This harness is duplicated across the four parts deliberately: sharing it
 * through an import would put every part back into one module graph and
 * undo the split. (The mail parts CAN share test/helpers/app-harness.mjs
 * because that module is imported per-process, once per file.)
 */

/**
 * End-to-end app tests in a real DOM — features part 3 of 4: compose, outbox and sending.
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

