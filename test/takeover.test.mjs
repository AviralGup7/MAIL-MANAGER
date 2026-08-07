/**
 * Takeover tests.
 *
 * WHY THIS IS THE MOST IMPORTANT TEST FILE IN THE REPO
 * ---------------------------------------------------
 * content.js is 266 lines implementing the feature the extension is named for,
 * and it had zero tests. Its worst failure mode is not "the animation looks
 * wrong" -- it is that `restoreGmail()` fails to put back exactly what
 * `suspendGmail()` took away, leaving the user's Gmail tab permanently blank
 * after a single toggle. That is unrecoverable without a reload, and no unit
 * test elsewhere in this repo can see it.
 *
 * The script is a classic content script, not a module: it has no exports and
 * runs on load. So it is executed inside a jsdom window with `chrome` stubbed,
 * and driven exactly the way the service worker drives it -- by dispatching
 * BMM_TOGGLE through the onMessage listener it registers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  test('takeover (skipped: jsdom not installed)', { skip: true }, () => {});
}

const SRC = readFileSync(join(ROOT, 'src/takeover/content.js'), 'utf8');

/**
 * A stand-in for Gmail's page.
 *
 * Deliberately includes elements that already carry inline styles, because the
 * round-trip bug this file exists to catch only shows up when there is a prior
 * value to clobber. Gmail does set inline styles of its own.
 */
const GMAIL_HTML = `<!doctype html><html><body>
  <div id="gmail-root-a">inbox</div>
  <div id="gmail-root-b" style="display: flex;">threads</div>
  <div id="gmail-root-c" style="visibility: visible; display: block;">compose</div>
  <script>/* gmail's own script tag */</script>
</body></html>`;

/**
 * Load content.js into a fresh fake-Gmail window.
 * Returns helpers that mirror how the extension actually drives it.
 */
function mount({ reducedMotion = false, url = 'https://mail.google.com/mail/u/0/' } = {}) {
  const dom = new JSDOM(GMAIL_HTML, {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window: win } = dom;

  /** @type {Array<(msg:any, sender:any, respond:Function)=>void>} */
  const messageListeners = [];

  win.chrome = {
    runtime: {
      id: 'test',
      getURL: (p) => `chrome-extension://test/${p}`,
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
    },
  };

  win.matchMedia = (q) => ({
    matches: reducedMotion && q.includes('prefers-reduced-motion'),
    addEventListener() {},
    removeEventListener() {},
  });

  // Execute the content script in this window.
  win.eval(SRC);

  const send = (msg) => {
    let reply = null;
    for (const fn of messageListeners) fn(msg, {}, (r) => (reply = r));
    return reply;
  };

  /** Let timers and rAF callbacks drain. */
  const tick = async (ms = 0) => {
    await new Promise((r) => win.setTimeout(r, ms));
    await new Promise((r) => win.requestAnimationFrame(() => r()));
    await new Promise((r) => win.setTimeout(r, 0));
  };

  /** The app iframe reporting first paint. */
  const appReady = () => {
    const frame = win.document.getElementById('bmm-takeover-frame');
    win.dispatchEvent(
      new win.MessageEvent('message', {
        data: { type: 'BMM_READY' },
        source: frame?.contentWindow || null,
      })
    );
  };

  const roots = () =>
    [...win.document.body.children].filter(
      (el) => el.id !== 'bmm-takeover-host' && el.tagName !== 'SCRIPT'
    );

  /** Snapshot the inline styles the takeover is allowed to touch. */
  const styleSnapshot = () =>
    roots().map((el) => ({
      id: el.id,
      visibility: el.style.visibility,
      display: el.style.display,
      cssText: el.getAttribute('style') || '',
    }));

  return { win, doc: win.document, send, tick, appReady, roots, styleSnapshot };
}

const host = (doc) => doc.getElementById('bmm-takeover-host');

/** Press Alt+Shift+M in the page, the way a user does with no worker alive. */
function pressToggle(h) {
  h.win.dispatchEvent(new h.win.KeyboardEvent('keydown', {
    key: 'm', altKey: true, shiftKey: true, bubbles: true, cancelable: true,
  }));
}

/** Drive a full enter, the way the worker + app do. */
async function enter(h) {
  h.send({ type: 'BMM_TOGGLE' });
  await h.tick();
  h.appReady();
  await h.tick();
  await h.tick(400); // past ENTER_MS
}

// ---------------------------------------------------------------------------

test('mounting the takeover injects a host and an app iframe', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const h = mount();
  await enter(h);

  const el = host(h.doc);
  assert.ok(el, 'host must exist');
  assert.equal(el.getAttribute('role'), 'dialog');
  assert.equal(el.getAttribute('aria-modal'), 'true');

  const frame = h.doc.getElementById('bmm-takeover-frame');
  assert.ok(frame, 'iframe must exist');
  // The account index rides along in the query string; see the dedicated test.
  assert.ok(
    frame.src.startsWith('chrome-extension://test/app.html?u='),
    `unexpected frame src: ${frame.src}`
  );
  // Least privilege: the frame is an extension origin and must not be granted
  // access to the Gmail document.
  assert.ok(!frame.getAttribute('sandbox')?.includes('allow-same-origin'));
});

test('Gmail is suspended while the takeover is up', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const h = mount();
  await enter(h);

  for (const el of h.roots()) {
    assert.equal(el.style.display, 'none', `${el.id} must be out of layout`);
  }
});

test('CRITICAL: release restores every inline style byte-identically', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The unrecoverable bug. If this round trip is lossy, the user's Gmail tab
  // is blank after one toggle and only a reload fixes it.
  const h = mount();
  const before = h.styleSnapshot();

  await enter(h);
  h.send({ type: 'BMM_TOGGLE' }); // release
  await h.tick(400);

  assert.deepEqual(h.styleSnapshot(), before, 'inline styles must round-trip exactly');
  assert.equal(host(h.doc), null, 'host must be removed');
});

test('CRITICAL: repeated toggles do not accumulate damage', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // A lossy restore often only shows up on the second or third cycle.
  const h = mount();
  const before = h.styleSnapshot();

  for (let i = 0; i < 3; i++) {
    await enter(h);
    h.send({ type: 'BMM_TOGGLE' });
    await h.tick(400);
  }

  assert.deepEqual(h.styleSnapshot(), before, 'three cycles must leave no residue');
  assert.equal(h.doc.querySelectorAll('#bmm-takeover-host').length, 0);
});

test('a toggle mid-animation is ignored rather than half-mounting', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const h = mount();

  h.send({ type: 'BMM_TOGGLE' }); // -> entering
  const reply = h.send({ type: 'BMM_TOGGLE' }); // must be ignored
  assert.equal(reply.state, 'entering', 'still entering, not toggled away');

  h.appReady();
  await h.tick();
  await h.tick(400);

  assert.equal(h.doc.querySelectorAll('#bmm-takeover-host').length, 1, 'exactly one host');
});

test('the frame is revealed even if the app never signals readiness', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // waitForAppReady has a 2s fallback so a crashed app cannot leave the user
  // staring at a hidden frame over a hidden Gmail.
  const h = mount();
  h.send({ type: 'BMM_TOGGLE' });
  await h.tick(2100); // never call appReady()
  await h.tick(400);

  const el = host(h.doc);
  assert.ok(el, 'host must still be present');
  assert.ok(
    el.classList.contains('bmm-active') || el.classList.contains('bmm-enter'),
    `expected a revealed state, got "${el.className}"`
  );
});

test('BMM_RELEASE from the app iframe releases; a forged one does not', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const h = mount();
  await enter(h);

  // Forged: right message, wrong source.
  h.win.dispatchEvent(
    new h.win.MessageEvent('message', { data: { type: 'BMM_RELEASE' }, source: null })
  );
  await h.tick();
  assert.ok(host(h.doc), 'a message from an unknown source must be ignored');

  // Genuine: from the app frame.
  const frame = h.doc.getElementById('bmm-takeover-frame');
  h.win.dispatchEvent(
    new h.win.MessageEvent('message', {
      data: { type: 'BMM_RELEASE' },
      source: frame.contentWindow,
    })
  );
  await h.tick(400);
  assert.equal(host(h.doc), null, 'the app may close itself');
});

test('pagehide restores Gmail so a crash cannot strand a blank tab', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const h = mount();
  const before = h.styleSnapshot();

  await enter(h);
  // Simulate the tab going away mid-takeover, with no release.
  h.win.dispatchEvent(new h.win.Event('pagehide'));

  assert.deepEqual(h.styleSnapshot(), before, 'Gmail must be visible again');
});

test('reduced motion cuts instead of animating, and still round-trips', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const h = mount({ reducedMotion: true });
  const before = h.styleSnapshot();

  h.send({ type: 'BMM_TOGGLE' });
  await h.tick();
  h.appReady();
  await h.tick();

  const el = host(h.doc);
  assert.ok(el.classList.contains('bmm-instant'), 'must cut, not animate');
  assert.ok(!el.classList.contains('bmm-enter'));

  h.send({ type: 'BMM_TOGGLE' });
  await h.tick();
  assert.deepEqual(h.styleSnapshot(), before);
});

test('the takeover never touches Gmail obfuscated class names', () => {
  // Gmail's class names change without notice. Roots are found via
  // document.body.children, and this asserts nobody "improves" that later.
  assert.ok(!/querySelector\(\s*['"`]\./.test(SRC), 'no class-based root lookup');
  assert.ok(SRC.includes('document.body.children'), 'roots come from body children');
});

test('no polling, no observers, no permanent animation loop', () => {
  // The three mechanisms that made v1 slow. v1 started a permanent rAF canvas
  // loop on every mount and never stopped it.
  //
  // Strips comments first. The first version of this test grepped raw source
  // and tripped on the word "MutationObserver" inside a comment -- which was
  // useful exactly once, because that comment claimed the file used "exactly
  // ONE MutationObserver" when it uses none. The comment was wrong and is now
  // fixed; the test should assert about code.
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!code.includes('setInterval'), 'no setInterval');

  // EXACTLY ONE MutationObserver is now permitted, and the constraints below
  // are the reason it is safe where v1's was not.
  //
  // v1 ran an observer whose callback WROTE to the DOM, re-triggering itself
  // in a loop, with no filter and no disconnect. Ours watches only childList
  // on <body>, ignores anything that is not a new element, and is disconnected
  // on release. It exists because the alternative -- inerting document.body --
  // silently disabled every click in the application.
  const observers = (code.match(/new MutationObserver/g) || []).length;
  assert.equal(observers, 1, `expected exactly 1 MutationObserver, found ${observers}`);
  assert.ok(code.includes('lateObserver.disconnect()'), 'the observer must be disconnected on release');
  assert.ok(
    /observe\(document\.body, \{ childList: true \}\)/.test(code),
    'the observer must be narrowly scoped to childList on body'
  );
  // rAF is allowed only as the two nested calls that commit the enter class.
  const rafs = code.match(/requestAnimationFrame/g) || [];
  assert.ok(rafs.length <= 2, `expected at most 2 rAF calls, found ${rafs.length}`);
});

test('the app frame is told which Gmail account this tab is showing', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Gmail multiplexes accounts by path: /mail/u/0/, /mail/u/1/ ... The app
  // runs on an extension origin and cannot read this page's URL, so the index
  // is passed in the frame's query string. Without it, "Open in Gmail" always
  // deep-linked to the FIRST account -- the same wrong-account family of bug
  // as the toolbar button opening a fresh tab on the browser default.
  for (const [path, expected] of [
    ['/mail/u/0/', '0'],
    ['/mail/u/1/', '1'],
    ['/mail/u/3/', '3'],
    ['/mail/', '0'],
  ]) {
    const h = mount({ url: `https://mail.google.com${path}#inbox` });
    await enter(h);
    const src = h.doc.getElementById('bmm-takeover-frame').src;
    assert.ok(
      src.includes(`?u=${expected}`),
      `${path} should yield ?u=${expected}, got ${src}`
    );
  }
});

test('CRITICAL: the takeover UI is never inert — clicks must work', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // THE WORST BUG THIS PROJECT HAS SHIPPED.
  //
  // A previous version marked `document.body` inert to cover Gmail nodes added
  // after mount, then called `host.removeAttribute('inert')` to exempt our own
  // UI. That does not work: `inert` INHERITS to every descendant and cannot be
  // cancelled on a child. Removing the attribute from the host was a no-op,
  // because the host never had it — it was inheriting from body.
  //
  // Result: the takeover rendered perfectly and no click anywhere did
  // anything. Every one of the 279 tests passed, because they assert on DOM
  // state and none asked whether the UI could receive input.
  const h = mount();
  await enter(h);

  const host = h.doc.getElementById('bmm-takeover-host');
  assert.equal(h.doc.body.hasAttribute('inert'), false, 'body must never be inert');
  assert.equal(host.hasAttribute('inert'), false, 'the host must never be inert');

  // Walk the ancestor chain: inert anywhere above us disables everything below.
  for (let el = host; el; el = el.parentElement) {
    assert.equal(
      el.hasAttribute?.('inert'),
      false,
      `${el.tagName || el.nodeName} is inert, which disables the whole takeover`
    );
  }
});

test('Gmail nodes added AFTER mount are inerted, and only those', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Gmail is a SPA and keeps appending top-level nodes. They must not be able
  // to steal focus from our search box — but covering them by inerting body
  // is what broke the app, so each is handled individually.
  const h = mount();
  await enter(h);

  const late = h.doc.createElement('div');
  late.id = 'late-gmail-dialog';
  h.doc.body.appendChild(late);
  await h.tick();

  assert.equal(late.hasAttribute('inert'), true, 'a late Gmail node must be inerted');
  assert.equal(
    h.doc.getElementById('bmm-takeover-host').hasAttribute('inert'),
    false,
    'our host must stay interactive'
  );

  h.send({ type: 'BMM_TOGGLE' });
  await h.tick(400);
  assert.equal(late.hasAttribute('inert'), false, 'release must undo it');
});

test("release does not clear an inert attribute Gmail set itself", async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const h = mount();
  const own = h.doc.createElement('div');
  own.id = 'gmail-own-inert';
  own.setAttribute('inert', '');
  h.doc.body.appendChild(own);

  await enter(h);
  h.send({ type: 'BMM_TOGGLE' });
  await h.tick(400);

  assert.equal(own.hasAttribute('inert'), true, "Gmail's own inert must survive");
});

test('the host is pointer-interactive in every revealed state', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The host starts `pointer-events: none` so it cannot intercept clicks
  // before it is visible. Every class that reveals it MUST restore
  // interactivity — a revealed-but-unclickable overlay is the same user-facing
  // failure as the inert bug, arriving by a different route.
  const css = readFileSync(join(ROOT, 'src/takeover/takeover.css'), 'utf8');
  for (const state of ['bmm-enter', 'bmm-active', 'bmm-instant']) {
    const block = css.match(new RegExp(`#bmm-takeover-host\\.${state}\\s*\\{[^}]*\\}`));
    assert.ok(block, `${state} rule must exist`);
    assert.match(
      block[0],
      /pointer-events:\s*auto/,
      `${state} reveals the host but leaves it click-through`
    );
  }
});

test('LONG SESSION: 15 round trips with late Gmail nodes leave no residue', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The existing repeated-toggle test runs three clean cycles. Gmail is a SPA
   * that keeps appending top-level nodes, so a real session interleaves late
   * arrivals with toggles — and the late-node observer is the one piece of
   * state that is created and destroyed on every cycle.
   *
   * Residue here would mean permanently inert Gmail chrome: the user's real
   * Gmail becomes unclickable after using the extension for a while, and
   * nothing short of a reload fixes it.
   */
  const h = mount();
  const before = h.styleSnapshot();
  const lateNodes = [];

  for (let i = 0; i < 15; i++) {
    await enter(h);

    // Gmail appends something while the takeover is up.
    const late = h.doc.createElement('div');
    late.id = `late-${i}`;
    h.doc.body.appendChild(late);
    lateNodes.push(late);
    await h.tick();

    h.send({ type: 'BMM_TOGGLE' });
    await h.tick(400);
  }

  assert.equal(h.doc.querySelectorAll('#bmm-takeover-host').length, 0, 'a host was stranded');
  assert.equal(
    h.doc.querySelectorAll('[data-bmm-inerted]').length, 0,
    'an inert marker survived release'
  );
  for (const node of lateNodes) {
    assert.ok(!node.hasAttribute('inert'), `${node.id} was left inert — Gmail stays unclickable`);
  }

  // The original roots must be byte-identical, ignoring the late nodes we added.
  const originals = new Set(before.map((s) => s.id));
  assert.deepEqual(
    h.styleSnapshot().filter((s) => originals.has(s.id)),
    before,
    '15 cycles drifted the inline styles'
  );
});

test('LONG SESSION: the late-node observer is not duplicated across cycles', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * `watchForLateNodes` guards with `if (lateObserver) return`, and release
   * disconnects. If a cycle ever leaked one, each subsequent takeover would
   * add another observer on <body> — every Gmail mutation then costs N
   * callbacks, which is exactly the unbounded-observer problem this codebase
   * was rewritten to remove.
   *
   * Counted by observing how many times a single added node is processed.
   */
  const h = mount();
  for (let i = 0; i < 5; i++) {
    await enter(h);
    h.send({ type: 'BMM_TOGGLE' });
    await h.tick(400);
  }

  await enter(h);
  let marks = 0;
  const probe = h.doc.createElement('div');
  probe.id = 'probe';
  // dataset writes are what the observer performs; count them.
  Object.defineProperty(probe, 'dataset', {
    value: new Proxy({}, { set: (o, k, v) => { if (k === 'bmmInerted') marks++; o[k] = v; return true; } }),
  });
  h.doc.body.appendChild(probe);
  await h.tick();

  assert.equal(marks, 1, `the node was processed ${marks} times — duplicate observers`);
  h.send({ type: 'BMM_TOGGLE' });
  await h.tick(400);
});


/* ========================================================================== *
 * THE WORKER-FREE ENTRY POINT
 * ========================================================================== */

test('TAKEOVER: Alt+Shift+M opens the takeover without any worker message', async () => {
  /*
   * THE SECOND HALF OF THE REGISTRATION BUG.
   *
   * When the service worker would not register, removing it from the manifest
   * made the error disappear and left an extension where, in the user's
   * words, "nothing happens on clicking it".
   *
   * That was not a separate defect. The ONLY route into the takeover was a
   * BMM_TOGGLE message, and only the worker sends one -- from the toolbar
   * click and from chrome.commands. Both are worker-side events. The content
   * script was already injected and already able to do the entire job; it
   * simply had no way to be asked.
   *
   * This proves the page can now open it alone.
   */
  const h = mount();
  assert.equal(host(h.doc), null, 'precondition: no takeover yet');

  pressToggle(h);
  await h.tick();
  h.appReady();
  await h.tick();
  await h.tick(400);

  assert.ok(host(h.doc), 'Alt+Shift+M must open the takeover with no worker involved');
});

test('TAKEOVER: the key fallback does not double-toggle alongside the worker', async () => {
  /*
   * The risk of adding a second entry point is that both fire and the
   * takeover opens then immediately closes.
   *
   * In a real browser chrome.commands consumes the chord before the page sees
   * a keydown, so the two can never both run. That cannot be reproduced in
   * jsdom, so this asserts the property that actually protects us: toggle()
   * is idempotent while a transition is in flight. Whichever path arrives
   * second is ignored, exactly as two rapid BMM_TOGGLEs already are.
   */
  const h = mount();

  h.send({ type: 'BMM_TOGGLE' });   // the worker's route
  pressToggle(h);                   // and the page's, in the same turn
  await h.tick();
  h.appReady();
  await h.tick();
  await h.tick(400);

  assert.ok(host(h.doc), 'the takeover must be open, not opened-then-closed');
  assert.equal(
    h.doc.querySelectorAll('#bmm-takeover-host').length, 1,
    'and mounted exactly once'
  );
});
