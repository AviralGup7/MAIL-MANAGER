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
 * End-to-end app tests in a real DOM — features part 1 of 4: triage, rules and automation.
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
  const src = readFileSync(join(ROOT, 'src/app/main.js'), 'utf8');
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
  const src = readFileSync(join(ROOT, 'src/app/main.js'), 'utf8');
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
  const src = readFileSync(join(ROOT, 'src/app/main.js'), 'utf8')
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

