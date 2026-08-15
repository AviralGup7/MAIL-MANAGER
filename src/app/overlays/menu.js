/**
 * The anchored menu primitive.
 *
 * WHY THIS EXISTS
 * ---------------
 * Three menus in main.js — category rules, recategorise, snooze — each built
 * the same container, wired the same `role="menu"`, and carried a byte-identical
 * arrow-key/Escape handler. The complexity audit counted three copies of
 * `items[(i + 1) % items.length]`.
 *
 * `layers.js` had already unified *dismissal*; nothing had unified
 * *construction*. So a fourth menu would have been a fourth copy, and a
 * keyboard fix would have had three places to miss — which is precisely the
 * class of drift that turns a consistent UI into an assembled one.
 *
 * This is not abstraction for its own sake. The three call sites disagreed on
 * exactly two things, and both are parameters here:
 *
 *   - the item ROLE. Category rules are toggles (`menuitemcheckbox` +
 *     `aria-checked`); snooze options are plain `menuitem`. Flattening them to
 *     one role would either lie about the toggles or bolt a meaningless
 *     aria-checked onto every snooze option.
 *   - where the node MOUNTS. The snooze menu hangs off the reader's action bar
 *     so it is not clipped by the row; the others hang off their anchor.
 *
 * Everything else was already identical and is now stated once.
 */

import { openLayer } from './layers.js';
import { registerReset } from '../core/reset-registry.js';
import { popFrom } from '../motion/morph.js';

/** The single open menu, or null. Two menus at once is never intended. */
let current = null;

/** Close whatever menu is open. Idempotent and safe before the first open. */
export function closeMenu() {
  if (current) current.layer.close();
}

/** Is a menu open? Used by callers that must not double-open. */
export function menuIsOpen() {
  return current !== null;
}


/** Test seam: module state outlives a jsdom boot, so tests must clear it. */
function _resetMenu() {
  if (current) {
    try { current.layer.close(); } catch { /* already gone */ }
  }
  current = null;
}

/**
 * @typedef {Object} MenuItem
 * @property {string}   text      the label
 * @property {string}  [hint]     secondary line under the label
 * @property {string}  [trailing] right-aligned text (a time, "On")
 * @property {boolean} [checked]  present ⇒ renders as a checkbox item
 * @property {boolean} [selected] present ⇒ renders as a RADIO item, and the
 *                                selected one takes focus when the menu opens
 * @property {Element} [prefix]   a node rendered before the label (a swatch)
 * @property {Element} [suffix]   a node rendered after the label (a tick)
 * @property {string}  [className] extra classes on the item button
 * @property {Object}  [data]     dataset entries to hang off the item
 * @property {() => void | Promise<void>} run
 */

/**
 * Open an anchored menu.
 *
 * @param {Object}      opts
 * @param {string}      opts.name       layer name, for the Escape stack
 * @param {string}      opts.label      accessible name — never omit it
 * @param {Element}     opts.anchor     what the menu belongs to
 * @param {MenuItem[]}  opts.items
 * @param {string}     [opts.className] extra classes on the container
 * @param {Element}    [opts.mountTo]   override the mount point
 * @param {() => void} [opts.onClose]   run when the menu goes away, however it
 *                                      goes away — chosen, Escaped or clicked
 *                                      past. A trigger with `aria-expanded`
 *                                      needs exactly one place to unset it.
 * @returns {{node: Element, layer: object} | null}
 */
export function openMenu({
  name, label, anchor, items, className = '', mountTo, onClose,
}) {
  closeMenu();

  /*
   * A menu with no choices is a dead surface that still traps focus and
   * swallows Escape. Opening nothing is the honest outcome.
   */
  if (!items || items.length === 0) return null;

  const node = document.createElement('div');
  node.className = `snooze-menu${className ? ` ${className}` : ''}`;
  node.setAttribute('role', 'menu');
  node.setAttribute('aria-label', label);

  for (const item of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `snooze-opt${item.className ? ` ${item.className}` : ''}`;
    if (item.data) Object.assign(b.dataset, item.data);

    /*
     * Three roles, because the menus mean three different things.
     *
     *   `checked`  present ⇒ menuitemcheckbox. Independent on/off (mute a
     *              category, auto-archive it). Several may be on at once.
     *   `selected` present ⇒ menuitemradio. One-of-many (which theme).
     *              Exactly one is current and choosing another unsets it.
     *   neither    ⇒ menuitem. A command (snooze until tomorrow).
     *
     * Collapsing radio into checkbox would announce "six independent
     * switches" to a screen reader when the truth is "one choice of six".
     */
    const checkable = Object.prototype.hasOwnProperty.call(item, 'checked');
    const selectable = Object.prototype.hasOwnProperty.call(item, 'selected');
    b.setAttribute(
      'role',
      checkable ? 'menuitemcheckbox' : selectable ? 'menuitemradio' : 'menuitem'
    );
    if (checkable) b.setAttribute('aria-checked', String(!!item.checked));
    if (selectable) b.setAttribute('aria-checked', String(!!item.selected));

    const left = document.createElement('span');
    /*
     * Named, so a caller that supplies a `prefix` can lay this out. It stays a
     * plain inline span by default -- the snooze and category menus stack a
     * hint under the label and would break if this became a flex row.
     */
    left.className = 'menu-label';
    if (item.prefix) left.appendChild(item.prefix);
    const name_ = document.createElement('span');
    name_.className = 'menu-name';
    name_.textContent = item.text;
    left.appendChild(name_);
    if (item.hint) {
      const hint = document.createElement('span');
      hint.className = 'sc-when';
      hint.textContent = item.hint;
      left.appendChild(hint);
    }

    const right = document.createElement('span');
    right.className = 'snooze-when';
    right.textContent = item.trailing || '';
    if (item.suffix) right.appendChild(item.suffix);

    b.append(left, right);
    b.addEventListener('click', async () => {
      /*
       * CLOSE FIRST, then run. The action may open another layer or re-render
       * the list underneath it; leaving a live menu attached to a node that is
       * about to be replaced strands an orphan in the layer stack.
       */
      closeMenu();
      await item.run();
    });
    node.appendChild(b);
  }

  node.addEventListener('keydown', (e) => {
    const opts = [...node.querySelectorAll('.snooze-opt')];
    if (!opts.length) return;
    const i = opts.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      opts[(i + 1) % opts.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      // `+ opts.length` so ArrowUp from the first item wraps to the last
      // rather than indexing -1. This is the part a re-implementation drops.
      opts[(i - 1 + opts.length) % opts.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      /*
       * The theme picker had these and the primitive did not — the drift was
       * already there when the fourth menu was found. Stated once, all four
       * menus get them and none can lose them separately.
       */
      e.preventDefault();
      opts[e.key === 'Home' ? 0 : opts.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Without this, one Escape closes the menu AND the reader behind it,
      // which reads as the app losing your place.
      e.stopPropagation();
      closeMenu();
    }
  });

  /*
   * VIEWPORT CLAMPING (was POLISH 17; rewritten V3). With fixed coordinates
   * the clamp is exact and synchronous: measure after mount, flip above the
   * anchor when the menu would cross the viewport's bottom edge, and clamp
   * sideways when it would cross the right one. The old marginTop pull is
   * gone -- it could fight the fixed top and double-shift.
   */

  const layer = openLayer({
    name,
    node,
    dismissOnOutsideClick: true,
    restoreFocusTo: anchor || document.activeElement,
    onClose: () => {
      /*
       * MENUS CLOSE INSTANTLY, AND THAT IS DELIBERATE.
       *
       * I gave them an exit animation and reverted it. A menu is REMOVED
       * rather than hidden, so animating out means leaving the node attached
       * for another 140ms -- and four tests caught that immediately:
       * `querySelector('.snooze-menu')` still found it, so by every observable
       * measure the menu was still open.
       *
       * The tests were encoding a real contract, not an implementation detail.
       * A menu that is visually present is one an outside click can hit and a
       * screen reader will announce. Making it inert while it fades is
       * possible, but it means "closed" and "gone" stop being the same thing
       * for the one surface where users dismiss by clicking somewhere else.
       *
       * The asymmetry is also less felt here than anywhere else: `menu-in` is
       * --dur-fast from -4px, a movement small and quick enough that its
       * absence on exit does not read as a glitch. Overlays that arrive over
       * --dur-base from further away do need the counterpart, and they have it.
       */
      node.remove();
      current = null;
      onClose?.();
    },
  });
  current = { node, layer };

  /*
   * ANCHORED POP (animation overhaul P4): the menu grows OUT of the control
   * that created it (directive §35), spring-driven, velocity-reversible.
   * Presentation only — state, focus, clamping and the layer stack all
   * settled above; this flight can never add 140ms to the truth. Exits stay
   * instant per the deliberate doctrine in onClose below.
   */
  if (anchor?.getBoundingClientRect) {
    const a = anchor.getBoundingClientRect();
    popFrom(node, { x: a.left + a.width / 2, y: a.top + a.height / 2 });
  }

  /*
   * MOUNT INTO THE OVERLAY ROOT (V3, docs/OVERHAUL-V3.md R5).
   *
   * Menus used to mount beside their anchor, inside whatever stacking context
   * the anchor happened to live in -- a sidebar row, the toolbar wrapper, the
   * reader -- which is the whole "the dropdown renders UNDER another pane"
   * class of bug (baseline D5). Layering is no longer a property of where
   * the trigger happens to sit: everything floating mounts under ONE root
   * and positions with viewport-fixed coordinates measured from the anchor.
   *
   * jsdom note: offsetWidth/Height are 0 there; the math still lands on the
   * anchor's rect, which is all the harness pins.
   */
  const root = document.getElementById('overlay-root') || mountTo || document.body;
  if (anchor && root !== mountTo) {
    node.style.position = 'fixed';
    node.style.left = '0px';
    node.style.top = '0px';
    /* Older menu classes declare `right: 0` (theme) as their anchoring half
       of the old host-mounted design. Once left AND top are pinned inline a
       surviving `right: 0` stretches the menu across the whole viewport and
       the measured width then clamps it to the left edge. Fixed placement
       owns all four insets. */
    node.style.right = 'auto';
    node.style.bottom = 'auto';
    root.appendChild(node);
    const ar = anchor.getBoundingClientRect();
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    const mw = node.offsetWidth || 0;
    const mh = node.offsetHeight || 0;
    let left = Math.max(8, Math.min(ar.left, vw - mw - 8));
    let top = ar.bottom + 8;
    if (top + mh > vh - 8) top = Math.max(8, ar.top - mh - 8);
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
  } else {
    const host = mountTo || document.body;
    // Anchored menus position against their host, which needs a containing block.
    if (host !== document.body && !host.style.position) host.style.position = 'relative';
    host.appendChild(node);
  }
  /*
   * Open ON the current choice when there is one, so a one-of-many menu opens
   * where the user already is rather than resetting them to the top of the
   * list. Command menus have no "current" and fall back to the first item.
   */
  const start = node.querySelector('[role="menuitemradio"][aria-checked="true"]')
    || node.querySelector('.snooze-opt');
  start?.focus();

  return current;
}

// Self-registered test seam (reset-registry.js, roadmap M-2): cached module
// state must not outlive a cache-busted main.js re-import in the harness.
registerReset('menu', _resetMenu);
