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
