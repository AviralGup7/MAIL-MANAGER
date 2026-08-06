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
function mount({ reducedMotion = false } = {}) {
  const dom = new JSDOM(GMAIL_HTML, {
    url: 'https://mail.google.com/mail/u/0/',
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
  assert.equal(frame.src, 'chrome-extension://test/app.html');
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
  assert.ok(!code.includes('MutationObserver'), 'no MutationObserver');
  // rAF is allowed only as the two nested calls that commit the enter class.
  const rafs = code.match(/requestAnimationFrame/g) || [];
  assert.ok(rafs.length <= 2, `expected at most 2 rAF calls, found ${rafs.length}`);
});
