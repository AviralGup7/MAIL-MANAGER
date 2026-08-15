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
 * End-to-end app tests in a real DOM — features part 2 of 4: timetable and academic surfaces.
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
  const src = readFileSync(join(ROOT, 'src/app/overlays/toast.js'), 'utf8');
  const fn = src.slice(src.indexOf('export function toast('), src.indexOf('export function hideToast('));
  assert.ok(fn.includes("style.animation = 'none'"), 'must clear before re-applying');
  assert.ok(fn.includes('offsetWidth'), 'must force a reflow between');
});


/* ========================================================================== *
 * TIMETABLE — the builder driven through the real UI
 * ========================================================================== */

test('TIMETABLE: the panel opens and offers to add a course', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot({ timetableData: TT_DATA });
  try {
    const panel = await openTT(doc, win, settle);
    assert.ok(panel, 'the timetable panel should open');
    // Round 54: a WORKSPACE, not a dialog — the mail chrome steps aside and
    // the surface takes the main area, so aria-modal would be a lie.
    assert.equal(panel.getAttribute('role'), 'region');
    assert.equal(doc.getElementById('tt-workspace').hidden, false);
    assert.equal(doc.getElementById('panes').hidden, true,
      'the mail pane steps aside for the workspace');
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

    const { getTimetableState } = await import('../src/app/academic/timetable-ui.js');
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

    const { getTimetableState } = await import('../src/app/academic/timetable-ui.js');
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
      await import('../src/app/academic/timetable-ui.js');
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
    const { getTimetableState } = await import('../src/app/academic/timetable-ui.js');
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
      await import('../src/app/academic/timetable-ui.js');
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

    const { getTimetableState } = await import('../src/app/academic/timetable-ui.js');
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

    const { getTimetableState } = await import('../src/app/academic/timetable-ui.js');
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
  // Round 54: a workspace, so Esc steps back to mail — one rung of the
  // ladder, still above the takeover itself.
  const { doc, win, settle, restore } = await boot({ timetableData: TT_DATA });
  try {
    let released = false;
    win.parent = { postMessage(m) { if (m?.type === 'BMM_RELEASE') released = true; } };

    await openTT(doc, win, settle);
    assert.ok(doc.getElementById('tt-panel'));

    press(doc, win, 'Escape');
    await settle(6);
    assert.equal(doc.getElementById('tt-workspace').hidden, true, 'the workspace should close');
    assert.equal(doc.getElementById('panes').hidden, false, 'and mail comes back');
    assert.equal(released, false, 'and must not drop the user back into Gmail');
  } finally {
    restore();
  }
});

test('TIMETABLE EVAL: rooms with no content render no tab; counts ride full ones', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // CS F111 carries exam dates, so Schedule and Exams exist; nothing here
  // produces pending findings or conflicts, so those rooms stay unrendered —
  // a tab that says nothing is the heading-over-dead-whitespace problem.
  const { doc, win, settle, restore } = await boot({ timetableData: TT_DATA });
  try {
    await openTT(doc, win, settle);
    await buildCS(doc, win, settle);
    const labels = [...doc.querySelectorAll('#tt-panel .tt-tab')]
      .map((b) => b.textContent.replace(/\d+/g, '').trim());
    assert.deepEqual(labels, ['Schedule', 'Exams'],
      'only rooms with content get a tab');
  } finally {
    restore();
  }
});

test('TIMETABLE EVAL: tabs keep ONE tab stop and arrow keys switch rooms', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot({ timetableData: TT_DATA });
  try {
    await openTT(doc, win, settle);
    await buildCS(doc, win, settle);

    const tabstop = [...doc.querySelectorAll('#tt-panel .tt-tab')]
      .filter((b) => b.tabIndex === 0);
    assert.equal(tabstop.length, 1, 'roving tabindex: one stop for the tablist');

    // A real keydown targets the FOCUSED element and bubbles — press()
    // dispatches on the document, which never reaches the tablist.
    const arrow = (key) => doc.activeElement.dispatchEvent(
      new win.KeyboardEvent('keydown', { key, bubbles: true }));
    tabstop[0].focus();
    arrow('ArrowRight');
    await settle(4);
    let active = doc.querySelector('#tt-panel .tt-tab.active');
    assert.equal(active.dataset.tab, 'exams', 'right arrow enters the next room');
    assert.equal(doc.activeElement, active, 'and focus lands on it');

    arrow('ArrowLeft');
    await settle(4);
    active = doc.querySelector('#tt-panel .tt-tab.active');
    assert.equal(active.dataset.tab, 'schedule', 'left arrow returns');
  } finally {
    restore();
  }
});

test('TIMETABLE EVAL: a conflicted room carries its count on its tab', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
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
    await buildCS(doc, win, settle);
    const zz = await ttSearch(doc, win, settle, 'ZZ F999');
    zz[0].querySelector('button').click();
    await settle(4);
    doc.querySelector('.tt-chooser .tt-section').click();
    await settle(8);

    const tab = [...doc.querySelectorAll('#tt-panel .tt-tab')]
      .find((b) => b.textContent.startsWith('Conflicts'));
    assert.ok(tab, 'the conflicted room earns a tab');
    assert.ok(tab.querySelector('.tt-tab-count'), 'and its count rides the tab');
  } finally {
    restore();
  }
});

test('TIMETABLE EVAL: sidebar navigation returns to mail from the workspace', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The sidebar is mail's home turf: choosing a category while the workspace
  // is open is a request to be back in mail first (round-54 rule, pinned).
  const { doc, win, settle, restore } = await boot({ timetableData: TT_DATA });
  try {
    await openTT(doc, win, settle);
    assert.equal(doc.getElementById('tt-workspace').hidden, false);
    doc.querySelector('#cats .cat[data-cat="all"]').click();
    await settle(4);
    assert.equal(doc.getElementById('tt-workspace').hidden, true,
      'the workspace steps aside');
    assert.equal(doc.getElementById('panes').hidden, false,
      'and mail comes back');
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
      await import('../src/app/academic/timetable-ui.js');
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

test('TIMETABLE: accepting a change is reversible — undo restores and re-offers (P-5)', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * Round 61 P-5. An accepted finding used to be irreversible — the one
   * academic action with no instrument, while every mail triage verb has
   * one. The undo must be honest on BOTH sides: the entry reverts AND the
   * proposal returns, so undoing never strands the user without the choice.
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
      await import('../src/app/academic/timetable-ui.js');
    scanForUpdates([]);
    closeTimetable();
    await settle(4);
    openTimetable();
    await settle(6);

    const apply = doc.querySelector('#tt-panel .tt-proposal .primary');
    assert.ok(apply, 'precondition: the proposal is applyable');
    apply.click();
    await settle(8);
    assert.equal(
      getTimetableState().entries.find((e) => e.section === 'L1').room, '6101',
      'precondition: applied'
    );

    press(doc, win, 'z', { ctrlKey: true });
    await settle(8);

    assert.equal(
      getTimetableState().entries.find((e) => e.section === 'L1').room, '5105',
      'undo restores the previous room'
    );
    assert.ok(
      doc.querySelector('#tt-panel .tt-proposal'),
      'and the proposal returns to the Changes room — undo never strands the choice'
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

    const { getTimetableState } = await import('../src/app/academic/timetable-ui.js');
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

    const { getTimetableState } = await import('../src/app/academic/timetable-ui.js');
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

    const { getTimetableState } = await import('../src/app/academic/timetable-ui.js');
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
    const M = await import('../src/app/academic/timetable-ui.js');

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
    const r = (await import('../src/app/academic/timetable.js'))
      .manualEdit(edited, l1.id, 'room', '9999');
    assert.equal(r.applied, true, '6. the user may always edit');
    assert.equal(r.entry.provenance.room.source, 'manual');

    // 7. A lower source cannot overwrite that edit.
    const mailTry = (await import('../src/app/academic/timetable.js'))
      .applyFieldChange(r.entry, 'room', '1111', { source: 'mail', ref: 'm1' });
    assert.equal(mailTry.applied, false, '7. mail must not outrank the user');

    // 8. Every field can name its source.
    const lines = (await import('../src/app/academic/timetable.js')).explainEntry(l1);
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
      const M2 = await import('../src/app/academic/timetable-ui.js');
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

    const { getTimetableState } = await import('../src/app/academic/timetable-ui.js');
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

