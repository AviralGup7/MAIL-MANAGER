/**
 * The anchored menu primitive.
 *
 * WHY THIS EXISTS
 * ---------------
 * Three menus in app.js — category rules, recategorise, snooze — each built
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
export function _resetMenu() {
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
 * @returns {{node: Element, layer: object} | null}
 */
export function openMenu({ name, label, anchor, items, className = '', mountTo }) {
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
    b.className = 'snooze-opt';

    // `checked` present at all — including false — means this is a toggle.
    const checkable = Object.prototype.hasOwnProperty.call(item, 'checked');
    b.setAttribute('role', checkable ? 'menuitemcheckbox' : 'menuitem');
    if (checkable) b.setAttribute('aria-checked', String(!!item.checked));

    const left = document.createElement('span');
    const name_ = document.createElement('span');
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
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Without this, one Escape closes the menu AND the reader behind it,
      // which reads as the app losing your place.
      e.stopPropagation();
      closeMenu();
    }
  });

  const layer = openLayer({
    name,
    node,
    dismissOnOutsideClick: true,
    restoreFocusTo: anchor || document.activeElement,
    onClose: () => {
      node.remove();
      current = null;
    },
  });
  current = { node, layer };

  const host = mountTo || anchor || document.body;
  // Anchored menus position against their host, which needs a containing block.
  if (host !== document.body && !host.style.position) host.style.position = 'relative';
  host.appendChild(node);
  node.querySelector('.snooze-opt')?.focus();

  return current;
}
