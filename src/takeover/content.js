/**
 * The takeover.
 *
 * Runs in the Gmail page. Its entire job is to mount our UI over Gmail,
 * animate the handover, and — critically — stop Gmail from doing work while we
 * are on top.
 *
 * ============================================================================
 * WHY AN IFRAME
 * ============================================================================
 *
 * Three ways to do this:
 *
 *   1. An overlay <div> in Gmail's DOM. Cheap, but our styles collide with
 *      Gmail's, Gmail's MutationObservers see our nodes, and Gmail keeps
 *      laying out and painting underneath. That last part is how you inherit
 *      Gmail's slowness and then add your own on top.
 *
 *   2. A full-page <iframe> of an extension page.  <-- chosen
 *      Complete CSS and DOM isolation. Gmail cannot see inside; we cannot
 *      break Gmail. And because it is a separate document, we can hide
 *      Gmail's root and Chrome will skip layout, paint and compositing for
 *      the entire Gmail tree.
 *
 *   3. Replace Gmail's DOM outright. Fastest in theory. In practice Gmail's
 *      own JavaScript keeps running, keeps querying for nodes we deleted, and
 *      throws continuously.
 *
 * ============================================================================
 * WHY THIS IS FAST — the specific mistakes being avoided
 * ============================================================================
 *
 * The previous version started a permanent requestAnimationFrame loop
 * (an 840-line canvas), a particle system, and mousemove tracking on every
 * mount, and never stopped them. That, more than the data layer, is what made
 * it feel "extremely slow and unusual".
 *
 * The rules here:
 *
 *   - The animation runs ONCE and then stops. No rAF loop survives it.
 *   - Only `transform` and `opacity` are animated. Both are composited on the
 *     GPU; neither triggers layout or paint. Animating width/height/top/left
 *     would force a layout on every frame.
 *   - `visibility: hidden` + `display: none` on Gmail's root once we are up,
 *     so Chrome skips the whole Gmail subtree.
 *   - ZERO MutationObservers. The old version had one that re-triggered itself
 *     by writing to the DOM inside its own callback. We do not need to watch
 *     Gmail at all: we hide its roots once and hand them back on release.
 *   - No polling, no intervals, no listeners left behind on release.
 */

const HOST_ID = 'bmm-takeover-host';
const FRAME_ID = 'bmm-takeover-frame';

/** Duration must match the CSS. Kept here so JS cleanup lines up with paint. */
const ENTER_MS = 380;
const EXIT_MS = 260;

let state = 'idle'; // idle | entering | active | leaving
let host = null;
let frame = null;
let hiddenNodes = [];
let escHandler = null;

/** Respect the OS setting. If motion is reduced we cut, we do not animate. */
const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Gmail's root container.
 *
 * Gmail's class names are obfuscated and change without notice, so we do NOT
 * depend on them. We take the direct children of <body> instead, which is
 * stable regardless of what Google reships, and skip our own node.
 */
function gmailRoots() {
  const out = [];
  for (const el of document.body.children) {
    if (el.id === HOST_ID) continue;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
    out.push(el);
  }
  return out;
}

/**
 * Stop Gmail rendering.
 *
 * `visibility: hidden` first (so the browser can skip paint immediately while
 * our animation runs over the top), then `display: none` once we are fully up
 * — which additionally removes it from layout entirely.
 *
 * Original inline values are recorded so release is exact. Gmail sets inline
 * styles of its own, and clobbering them permanently would break the tab.
 */
function suspendGmail() {
  hiddenNodes = gmailRoots().map((el) => ({
    el,
    visibility: el.style.visibility,
    display: el.style.display,
  }));
  for (const n of hiddenNodes) n.el.style.visibility = 'hidden';
}

function fullyHideGmail() {
  for (const n of hiddenNodes) n.el.style.display = 'none';
}

function restoreGmail() {
  for (const n of hiddenNodes) {
    n.el.style.visibility = n.visibility;
    n.el.style.display = n.display;
  }
  hiddenNodes = [];
}

/**
 * Wait for the app iframe to say it has painted.
 *
 * We do not reveal the frame until the app inside it has rendered its first
 * screen. Otherwise the animation lands on a white rectangle, which reads as
 * a flash of broken page — the single most common way a takeover feels cheap.
 *
 * Falls back on a timeout so a failure inside the app cannot leave the user
 * staring at a hidden frame forever.
 */
function waitForAppReady(timeoutMs = 2000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMsg);
      clearTimeout(timer);
      resolve();
    };
    const onMsg = (e) => {
      if (e.source === frame?.contentWindow && e.data?.type === 'BMM_READY') {
        finish();
      }
    };
    window.addEventListener('message', onMsg);
    const timer = setTimeout(finish, timeoutMs);
  });
}

async function takeOver() {
  if (state !== 'idle') return;
  state = 'entering';

  host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-modal', 'true');
  host.setAttribute('aria-label', 'BITS Mail Manager');

  frame = document.createElement('iframe');
  frame.id = FRAME_ID;
  frame.src = chrome.runtime.getURL('app.html');
  frame.setAttribute('title', 'BITS Mail Manager');
  // No allow-same-origin: the frame is an extension origin and does not need
  // access to the Gmail document. Least privilege.
  frame.setAttribute('allow', 'clipboard-write');

  host.appendChild(frame);
  document.body.appendChild(host);

  // Hide Gmail immediately so it stops painting behind the animation.
  suspendGmail();

  await waitForAppReady();

  if (prefersReducedMotion()) {
    host.classList.add('bmm-instant');
    onEntered();
    return;
  }

  // Two rAFs: the first lets the browser apply the initial class, the second
  // guarantees the transition starts from a committed style. One rAF is a
  // common source of "the animation sometimes doesn't play".
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      host.classList.add('bmm-enter');
      // A single timer, not a loop. When it fires the animation is over and
      // nothing of ours is still running.
      setTimeout(onEntered, ENTER_MS);
    });
  });
}

function onEntered() {
  if (state !== 'entering') return;
  state = 'active';
  // Now that we cover the viewport, drop Gmail out of layout entirely.
  fullyHideGmail();
  host.classList.add('bmm-active');

  escHandler = (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) release();
  };
  window.addEventListener('keydown', escHandler, true);

  frame.contentWindow?.postMessage({ type: 'BMM_SHOWN' }, '*');
}

function release() {
  if (state !== 'active' && state !== 'entering') return;
  state = 'leaving';

  if (escHandler) {
    window.removeEventListener('keydown', escHandler, true);
    escHandler = null;
  }

  // Bring Gmail back BEFORE we start fading out, so the user never sees an
  // empty white page between the two.
  //
  // This calls restoreGmail() rather than repeating the restore inline. It
  // used to duplicate it, which meant the un-hide logic existed in two places
  // that had to agree: the copy here, and the one `pagehide` uses. Only the
  // pagehide copy was covered by a test, so a bug introduced in this path --
  // the path taken by every single normal release -- would have gone
  // unnoticed. Proved by sabotaging restoreGmail(): the crash-recovery test
  // failed and both round-trip tests still passed.
  restoreGmail();

  const finish = () => {
    host?.remove();
    host = null;
    frame = null;
    state = 'idle';
  };

  if (prefersReducedMotion()) {
    finish();
    return;
  }

  host.classList.remove('bmm-enter', 'bmm-active');
  host.classList.add('bmm-leave');
  setTimeout(finish, EXIT_MS);
}

function toggle() {
  if (state === 'idle') takeOver();
  else if (state === 'active') release();
  // Deliberately ignored mid-animation: toggling during a transition is how
  // you end up with a half-mounted overlay and a hidden Gmail.
}

// ---------------------------------------------------------------- wiring ---

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'BMM_TOGGLE') {
    toggle();
    sendResponse({ ok: true, state });
  }
  return false;
});

// The app asks to be closed (its own back button).
window.addEventListener('message', (e) => {
  if (e.source !== frame?.contentWindow) return;
  if (e.data?.type === 'BMM_RELEASE') release();
});

// If the tab is torn down mid-takeover, put Gmail back. Without this a crash
// in our app could leave the user with a permanently blank Gmail tab.
window.addEventListener('pagehide', () => {
  if (hiddenNodes.length) restoreGmail();
});
