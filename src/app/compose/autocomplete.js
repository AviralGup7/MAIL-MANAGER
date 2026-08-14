/**
 * Contact autocomplete for the compose recipient fields.
 *
 * Split out of features.js -- see radar.js for why. The address book is built
 * from mail already in the store, so this module needs the store and nothing
 * else from the app.
 */

import {
  buildContacts, matchContacts, currentFragment, completeValue,
} from '../core/contacts.js';
import { registerReset } from '../core/reset-registry.js';

const $ = (id) => document.getElementById(id);

/* ========================================================================== *
 * CONTACT AUTOCOMPLETE
 * ========================================================================== */

/**
 * Contacts are rebuilt when compose OPENS, not on every keystroke.
 *
 * The store can hold 2000 messages; walking it per keystroke would be the one
 * genuinely expensive thing in the compose path. Building once per open is
 * imperceptible and the address book cannot meaningfully change while a single
 * message is being written.
 */
let contactBook = [];

export function refreshContacts(ctx) {
  try {
    const ids = ctx.store.idsFor('all');
    const msgs = [];
    for (const id of ids) {
      const m = ctx.store.get(id);
      if (m) msgs.push(m);
    }
    contactBook = buildContacts(msgs, { selfAddress: ctx.state?.email || '' });
  } catch {
    contactBook = [];
  }
  return contactBook;
}

/** Wire one recipient input to its suggestion list. */
/** Wire one recipient input to its suggestion list. */
export function wireAutocomplete(inputId, listId) {
  const input = $(inputId);
  const list = $(listId);
  if (!input || !list) return;

  let active = -1;

  const close = () => {
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const choose = (address) => {
    const caret = input.selectionStart;
    input.value = completeValue(input.value, address, caret);
    close();
    input.focus();
    // Caret to the end so the next recipient can be typed straight away.
    const end = input.value.length;
    input.setSelectionRange(end, end);
    // The value changed programmatically, which does not fire `input`; the
    // draft autosave listens for that, so tell it explicitly.
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const render = (matches) => {
    list.replaceChildren();
    matches.forEach((c, i) => {
      const li = document.createElement('li');
      li.id = `${listId}-opt-${i}`;
      li.className = 'ac-opt';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.dataset.address = c.address;

      const name = document.createElement('span');
      name.className = 'ac-name';
      name.textContent = c.name || c.address;
      const addr = document.createElement('span');
      addr.className = 'ac-addr';
      addr.textContent = c.name ? c.address : '';

      li.append(name, addr);
      // mousedown, not click: click fires after blur, by which point the list
      // has already been closed and the selection lost.
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        choose(c.address);
      });
      list.appendChild(li);
    });
    list.hidden = matches.length === 0;
    input.setAttribute('aria-expanded', String(matches.length > 0));
    active = -1;
  };

  const setActive = (i) => {
    const opts = [...list.querySelectorAll('.ac-opt')];
    if (!opts.length) return;
    active = (i + opts.length) % opts.length;
    opts.forEach((o, n) => o.setAttribute('aria-selected', String(n === active)));
    input.setAttribute('aria-activedescendant', opts[active].id);
    opts[active].scrollIntoView?.({ block: 'nearest' });
  };

  input.addEventListener('input', () => {
    const frag = currentFragment(input.value, input.selectionStart);
    if (frag.length < 2) return close();
    render(matchContacts(contactBook, frag));
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    const opts = [...list.querySelectorAll('.ac-opt')];
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter' || e.key === 'Tab') {
      // Only intercept when something is actually highlighted, so Enter still
      // submits and Tab still moves on when the user ignored the list.
      if (active >= 0 && opts[active]) {
        e.preventDefault();
        e.stopPropagation();
        choose(opts[active].dataset.address);
      }
    } else if (e.key === 'Escape') {
      // Close the list without closing compose.
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });

  input.addEventListener('blur', () => setTimeout(close, 120));
}

/**
 * Test seam: drop the cached address book.
 *
 * Module state outlives a jsdom boot -- only app.js is re-imported with a
 * cache-busting URL -- so a book built from one test's messages would leak
 * into the next. Self-registered below (S2 dissolved the barrel's composite
 * 'features' entry into per-module registrations, the list/bulk pattern).
 */
function _resetContacts() {
  contactBook = [];
}

registerReset('autocomplete', _resetContacts);
