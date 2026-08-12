/**
 * Overlay layer stack.
 *
 * WHY THIS EXISTS
 * ---------------
 * Four overlays — the theme menu, the category rule menu, the snooze picker
 * and the help dialog — each implemented open/close/focus/dismiss by hand.
 * Every `close*` function repeated the same two or three teardown steps, and
 * two of the four independently wired their own document-level outside-click
 * listener.
 *
 * The visible symptom was a NINE-BRANCH hand-maintained `Escape` ladder in the
 * global keydown handler:
 *
 *     if (help open)      { closeHelp();      return; }
 *     if (snoozeMenu)     { closeSnoozeMenu(); return; }
 *     if (catMenu)        { closeCategoryMenu(); return; }
 *     if (palette open)   { closePalette();   return; }
 *     ...
 *
 * That ladder is the only place in this codebase where correctness depends on
 * the ORDER STATEMENTS APPEAR IN A FUNCTION. Everything else is data-driven.
 * Adding a fifth overlay meant remembering to insert it at the right depth,
 * and nothing enforced it — the ordering was prose in a comment.
 *
 * A stack makes the ordering structural: the last thing opened is the first
 * thing closed, which is what "innermost first" actually means.
 *
 * DESIGN
 *
 *   - NO DOM ASSUMPTIONS BEYOND `node`. The primitive does not create, style
 *     or position anything. Overlays keep full control of their own markup;
 *     they hand over only their LIFECYCLE.
 *
 *   - FOCUS IS CAPTURED ON OPEN, restored on close, and only if the original
 *     element is still in the document. A modal that drops focus on <body> is
 *     the classic version of this bug: the user presses Escape and their next
 *     keystroke goes nowhere.
 *
 *   - OUTSIDE-CLICK IS OPT-IN and wired once per layer, on `mousedown` rather
 *     than `click`. Click fires after blur, by which point a menu that closes
 *     on blur has already gone and the selection is lost.
 *
 *   - CLOSING IS IDEMPOTENT. Overlays are closed from several directions —
 *     Escape, an outside click, a button, a selection being made — and
 *     double-closing must not run teardown twice.
 *
 *   - A CLOSED LAYER IS REMOVED FROM WHEREVER IT SITS in the stack, not just
 *     from the top. A menu can be dismissed by clicking outside it while a
 *     dialog above it is still open.
 */

/** @typedef {{node?:Element, onClose?:Function, restoreFocusTo?:Element|null,
 *             dismissOnOutsideClick?:boolean, name?:string}} LayerOptions */

/** @type {Array<{id:number, opts:LayerOptions, teardown:Function, closed:boolean}>} */
const stack = [];
let nextId = 1;

/**
 * Push a layer onto the stack.
 *
 * @param {LayerOptions} opts
 * @param {Document} [doc]
 * @returns {{id:number, close:Function}}
 */
export function openLayer(opts = {}, doc = globalThis.document) {
  const id = nextId++;

  // Captured BEFORE anything moves focus into the overlay.
  const returnFocus =
    opts.restoreFocusTo !== undefined ? opts.restoreFocusTo : doc?.activeElement || null;

  /*
   * FOCUS TRAP BY DEFAULT (round 46, arch #6). role=dialog promises Tab stays
   * inside; making the trap the default (opt out with trap:false) means every
   * FUTURE layer inherits the contract instead of each call site remembering
   * to ask. The untrap dies with the node, so there is nothing to clean up.
   */
  const untrap = opts.trap === false ? null : trapFocus(opts.node, doc);

  let onDocDown = null;
  if (opts.dismissOnOutsideClick && opts.node && doc) {
    onDocDown = (e) => {
      if (!opts.node.contains(e.target)) closeLayer(id, doc);
    };
    // `true` = capture phase, so a handler that stops propagation inside the
    // overlay cannot accidentally suppress dismissal of a layer beneath it.
    doc.addEventListener('mousedown', onDocDown, true);
  }

  const teardown = () => {
    if (onDocDown && doc) doc.removeEventListener('mousedown', onDocDown, true);
    untrap?.();
    try {
      opts.onClose?.();
    } finally {
      // Restore focus only if the node still exists. After a re-render the
      // original element may be gone, and focusing a detached node silently
      // moves focus to <body>.
      if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') {
        returnFocus.focus();
      }
    }
  };

  stack.push({ id, opts, teardown, closed: false });
  return { id, close: () => closeLayer(id, doc) };
}

/**
 * Close one layer by id, wherever it sits in the stack.
 *
 * @returns {boolean} whether a layer was actually closed
 */
export function closeLayer(id, doc = globalThis.document) {
  const i = stack.findIndex((l) => l.id === id);
  if (i === -1) return false;
  const layer = stack[i];
  /*
   * Belt and braces. The `splice` below already makes a second call a no-op
   * (findIndex returns -1), so mutation testing correctly shows this flag is
   * not load-bearing today. It is kept because idempotency is a CONTRACT here
   * — overlays are closed from Escape, an outside click, a button and a
   * selection — and a future reordering that ran teardown before the splice
   * would silently double-fire without it.
   */
  if (layer.closed) return false;
  layer.closed = true;
  stack.splice(i, 1);
  layer.teardown();
  return true;
}

/**
 * Close the topmost layer. This is what `Escape` does.
 *
 * @returns {boolean} true if something was closed, so the caller knows whether
 *   to keep unwinding (reader, then the takeover itself)
 */
export function closeTopLayer(doc = globalThis.document) {
  const top = stack[stack.length - 1];
  if (!top) return false;
  return closeLayer(top.id, doc);
}

/** Is anything open? */
export function hasLayers() {
  return stack.length > 0;
}

/** Depth, for tests and for reasoning about nesting. */
export function layerCount() {
  return stack.length;
}

/** The name of the topmost layer, for tests and debugging. */
export function topLayerName() {
  return stack[stack.length - 1]?.opts.name || null;
}

/**
 * Close everything, outermost last.
 *
 * Used on teardown and sign-out: leaving a layer open across a session change
 * strands its listener and its focus-restoration target.
 */
export function closeAllLayers(doc = globalThis.document) {
  let n = 0;
  while (stack.length) {
    if (!closeTopLayer(doc)) break;
    n++;
  }
  return n;
}

/** Test seam: forget everything without running teardown. */
export function _resetLayers() {
  stack.length = 0;
}

/* ========================================================================== *
 * EXIT MOTION
 * ========================================================================== */

/**
 * Hide an overlay through its exit animation.
 *
 * WHY THIS IS ONE HELPER AND NOT A FLAG ON EACH CLOSE PATH
 *
 * Overlays are closed from Escape, an outside click, a button, and a selection
 * being made. Every one previously set `hidden = true` directly, so adding an
 * exit surface-by-surface would have meant finding all four paths for each --
 * and missing one produces a surface that animates out on Escape and vanishes
 * on click, which is worse than no exit at all.
 *
 * `hidden` IS SET IMMEDIATELY. THIS IS THE IMPORTANT PART.
 *
 * My first version deferred `hidden` until the animation finished, and the
 * suite caught it at once: `assert.equal(help.hidden, true)` after Escape
 * failed, because for 140ms the overlay reported itself as open.
 *
 * The tests were right and the implementation was wrong. `hidden` is the
 * observable state of an overlay -- it is what Escape handling, focus
 * restoration and outside-click dismissal all key off. An overlay that is
 * logically closed but still reports `hidden === false` is lying, and the lie
 * is reachable: a second Escape during the fade would find the layer still on
 * the stack and unwind the wrong surface.
 *
 * So the container closes instantly and the ANIMATION RUNS ON A CLONE-FREE
 * BASIS: `.closing` is applied to the container for one frame before `hidden`
 * lands, which lets the CSS animate the inner box while the container is
 * already logically shut. Motion is presentation; `hidden` is state; state
 * does not wait for presentation.
 *
 * @param {Element} node
 * @param {() => void} [after] runs once the node is hidden
 */
export function closeWithMotion(node, after) {
  if (!node || node.hidden) return;

  node.classList.add('closing');

  /*
   * Hide on the next frame, not this one. One frame is enough for the browser
   * to start the exit animation on the inner box; hiding synchronously in the
   * same tick would cancel it before a single frame rendered.
   *
   * Everything that READS the overlay's state -- the layer stack, focus
   * restoration -- has already run by the time this returns, because the
   * caller's teardown is synchronous. Only the pixels are deferred.
   */
  const hide = () => {
    node.classList.remove('closing');
    node.hidden = true;
    after?.();
  };

  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(hide));
  } else {
    hide();
  }
}

/**
 * Abandon an in-flight exit, for a surface being re-opened before it finished.
 *
 * Called by every open path. Cheap when nothing is closing.
 */
export function cancelExit(node) {
  if (!node) return;
  node.classList.remove('closing');
  delete node.dataset.closing;
}

/**
 * Keyboard focus trap for a layer node (round 45 Phase 2).
 *
 * role=dialog promises that Tab stays inside; without this the timetable
 * panel (and any future modal surface) walked focus out into the app chrome
 * behind it. Attach once per open; the listener dies with the node, so there
 * is nothing to clean up on re-render. Returns an explicit untrap for the
 * rare caller that swaps the node out from under the trap.
 */
export function trapFocus(node, doc = globalThis.document) {
  if (!node || !doc) return () => {};
  const SELECTOR =
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  const onDown = (e) => {
    if (e.key !== 'Tab' || !node.contains(e.target)) return;
    const items = [...node.querySelectorAll(SELECTOR)].filter((el) => !el.disabled);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && doc.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && doc.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  node.addEventListener('keydown', onDown);
  return () => node.removeEventListener('keydown', onDown);
}

import { registerReset } from './reset-registry.js';
// Self-registered test seam (reset-registry.js, roadmap M-2). NOTE: this is
// the raw wipe; the integration harness closes layers WITH teardown first,
// because tenants null their cached layer handles inside onClose.
registerReset('layers', _resetLayers);
