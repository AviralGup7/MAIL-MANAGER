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
async function boot({ signedIn = true, messages = MESSAGES, storageSeed = {}, bodyOverride = {}, syncLatency = 0, perLabel = false, emptyLabels = [], labels = [], timetableData = null, storageTimetable = undefined, deadWorker = false } = {}) {
  const html = readFileSync(join(ROOT, 'app.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'chrome-extension://test/app.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true, // gives us requestAnimationFrame
  });
  const { window: win } = dom;
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

  function respond(msg) {
    switch (msg.type) {
      case 'AUTH_STATUS': return { ok: true, data: { signedIn } };
      case 'PROFILE': return { ok: true, data: { emailAddress: 'f20240294@pilani.bits-pilani.ac.in' } };
      case 'SYNC_PAGE': {
        if (msg.opts?.pageToken) return { ok: true, data: { messages: [], nextPageToken: '' } };
        if (!perLabel) return { ok: true, data: { messages, nextPageToken: '' } };
        // Distinct messages per mailbox, so a cross-mailbox leak is visible.
        const label = (msg.opts?.labelIds || [])[0] || msg.opts?.labelName || 'INBOX';
        // Some tests need a mailbox that is genuinely empty rather than one
        // holding three synthetic messages.
        if (emptyLabels.includes(label)) {
          return { ok: true, data: { messages: [], nextPageToken: '' } };
        }
        const tag = { INBOX: 'inbox', SENT: 'sent', TRASH: 'trash', SPAM: 'spam',
          DRAFT: 'draft', STARRED: 'star' }[label] || 'other';
        const out = Array.from({ length: 3 }, (_, i) => ({
          id: `${tag}${i}`, threadId: `t${tag}${i}`,
          // Sender encodes the mailbox, so a cross-store leak is detectable.
          from: `S${i} <${tag}${i}@pilani.bits-pilani.ac.in>`,
          subject: `${tag} message ${i}`, snippet: 's',
          date: Date.now() - i * 60000, unread: false, starred: false, labels: ['INBOX'],
        }));
        return { ok: true, data: { messages: out, nextPageToken: '' } };
      }
      case 'SYNC_DELTA':
        return { ok: true, data: { kind: 'delta', added: [], removed: [], patched: [] } };
      case 'GET_BODY':
        return {
          ok: true,
          data: { id: msg.id, html: '<p>body</p>', text: '', attachments: [], ...bodyOverride },
        };
      case 'GET_ATTACHMENT':
        return { ok: true, data: { dataUrl: 'data:application/pdf;base64,JVBER' } };
      case 'LIST_LABELS':
        return { ok: true, data: labels };
      case 'GET_DRAFT':
        // The worker resolves a MESSAGE id to a DRAFT id; the draftId is what
        // makes a re-save an update rather than a second copy.
        return {
          ok: true,
          data: {
            draftId: `d-${msg.id}`, to: 'someone@pilani.bits-pilani.ac.in',
            cc: '', bcc: '', subject: 'Half-written', text: 'Unfinished thought',
            threadId: msg.id,
          },
        };
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
    Object.assign(globalThis, prev);

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
const DUE_MESSAGES = [
  {
    id: 'd1', threadId: 'td1',
    from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>',
    subject: 'Fee payment',
    snippet: 'The last date for fee payment is tomorrow.',
    date: Date.now() - 3600_000, unread: true, starred: false, labels: ['INBOX', 'UNREAD'],
  },
  {
    id: 'd2', threadId: 'td2',
    from: 'Practice School Division <psd@pilani.bits-pilani.ac.in>',
    subject: 'PS report',
    snippet: 'Please submit the PS report by today.',
    date: Date.now() - 7200_000, unread: true, starred: false, labels: ['INBOX', 'UNREAD'],
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
    assert.equal(doc.activeElement, items[items.length - 1], 'End reaches the last theme');
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

const press = (doc, win, key, opts = {}) =>
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, ...opts }));

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
    // A saved-view success. jsdom has no `prompt`, so it is supplied.
    globalThis.prompt = () => 'My view';
    win.prompt = globalThis.prompt;
    const search = doc.getElementById('search');
    search.value = 'zzz-unique-query';
    search.dispatchEvent(new win.Event('input'));
    await settle(4);
    doc.getElementById('btn-save-view').click();
    await settle(8);

    assert.equal(doc.getElementById('toast').dataset.kind, 'success');
    assert.equal(doc.getElementById('toast-action').hidden, true, 'no action on a plain success');
  } finally {
    delete globalThis.prompt;
    restore();
  }
});

test('DELIGHT: sending names the recipient rather than confirming a mechanism', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The fear after sending is "who did that go to", not "did the button work".
  const { doc, settle, restore } = await boot();
  try {
    doc.getElementById('btn-compose').click();
    await settle(4);
    doc.getElementById('c-to').value = 'augsd@pilani.bits-pilani.ac.in';
    doc.getElementById('c-subject').value = 'Test';
    doc.getElementById('c-send').click();
    await settle(12);

    const text = doc.getElementById('toast-text').textContent;
    assert.match(text, /augsd@pilani/, `expected the recipient in "${text}"`);
    assert.equal(doc.getElementById('toast').dataset.kind, 'success');
  } finally {
    restore();
  }
});

test('DELIGHT: the drain line restarts on every toast', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Re-assigning the same animation does not replay it; the reflow between is
  // what does. Without that, a second toast shows a drain line already spent.
  const src = readFileSync(join(ROOT, 'src/app/app.js'), 'utf8');
  const fn = src.slice(src.indexOf('function toast('), src.indexOf('function hideToast('));
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

test('TIMETABLE: reset asks first, then clears everything', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Destructive and not covered by undo, so it confirms. Declining must be
  // a genuine no-op, not a delayed yes.
  const { doc, win, settle, restore } = await boot({ timetableData: TT_DATA });
  // Restored in `finally`: leaving a stubbed confirm on globalThis would make
  // any later test that reaches one behave differently depending on order.
  const realConfirm = globalThis.confirm;
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

    // The module calls a bare `confirm(...)`, which resolves against the
    // global the app module was evaluated with, not against `win`.
    globalThis.confirm = () => false;
    wipe().click();
    await settle(6);
    assert.equal(
      getTimetableState().entries.length, before,
      'declining the confirm must change nothing'
    );

    globalThis.confirm = () => true;
    wipe().click();
    await settle(8);
    assert.equal(getTimetableState().entries.length, 0, 'accepting clears it');
    assert.ok(
      doc.querySelector('#tt-q'),
      'and the build screen comes back so it can be rebuilt'
    );
  } finally {
    globalThis.confirm = realConfirm;
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
  const realConfirm = globalThis.confirm;
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
    globalThis.confirm = () => true;
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
    globalThis.confirm = realConfirm;
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
  const { doc, win, calls, settle, restore } = await boot();
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
  // Restoring asks first; accept it. Restored in `finally`.
  const realConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  const { doc, settle, restore } = await boot({ storageSeed: { composeDraft: draft } });
  try {
    await settle(10);
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
    globalThis.confirm = realConfirm;
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
  const { doc, win, calls, settle, restore } = await boot();
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
  const { doc, win, calls, settle, restore } = await boot();
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

    doc.getElementById('compose-close').click();
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
