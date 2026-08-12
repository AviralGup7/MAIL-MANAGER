/**
 * Hash deep links — the view as a URL (round 65/g, F7, brief §20/21).
 *
 * THE PROBLEM (F7). View state — mailbox, category, query, open message —
 * lived in memory only. A reload (which the takeover iframe invites: it is
 * a page, pages get refreshed) dropped the user back at a bare inbox, and
 * Back/Forward stepped through nothing the app had done.
 *
 * THE SHAPE. `#inbox/augsd?q=from:a&m=t0` — readable, paste-proof,
 * round-trips through {@link parseHash}. Two update strengths, because two
 * kinds of intent exist:
 *
 *   PUSH  — deliberate VIEW navigation: category click, mailbox switch,
 *           running a saved view or palette query. Each is one Back step.
 *   MIRROR — continuous state riding along: typing a query keystroke by
 *           keystroke, j/k-ing through messages. replaceState only, so a
 *           refresh keeps the context and the history stack stays clean.
 *           "No per-keystroke entries" is the whole audit brief here — Back
 *           must walk views, never letters or rows.
 *
 * The mirror hangs off the render frame: whatever settled on screen is what
 * the URL says. That is one seam instead of twenty call sites growing URL
 * arguments, and it makes j/k pollution structurally impossible rather than
 * conventionally avoided.
 *
 * ALL WRITES ARE TRY/CAUGHT. This module is a progressive layer: file://
 * previews, odd embeds and jsdom all have opinions about the History API,
 * and none of them may take boot or navigation down with them.
 *
 * OWNS: the hash format, the popstate listener, the pending-selection
 * latch. DOES NOT OWN: any view state (the shell applies through its own
 * functions, with `applying` suppressing echoes), message data, or timing
 * of when data exists (the shell calls {@link checkPendingSelection} when
 * more mail has landed).
 */

import { registerReset } from './reset-registry.js';

/**
 * The window the one popstate handler is bound to. Re-bound when the window
 * object changes (the harness reboots into a fresh jsdom window), never
 * stacked onto the same one.
 */
let boundWindow = null;

/** Shell callbacks, set by wireDeepLinks. */
let cbs = null;
/** True while a hash application drives the shell, so no echo is emitted. */
let applying = false;
/** A deep-linked message id awaiting its data; cleared on apply or switch. */
let pendingSelection = null;

/**
 * state → hash. Always canonical: mailbox and category always present,
 * query only while filtering, message only while a message is open.
 */
export function formatHash({ mailbox, category, query, selected }) {
  let h = `#${mailbox || 'inbox'}/${category || 'all'}`;
  const params = [];
  if (query) params.push(`q=${encodeURIComponent(query)}`);
  if (selected) params.push(`m=${encodeURIComponent(selected)}`);
  return params.length ? `${h}?${params.join('&')}` : h;
}

/**
 * hash → { mailbox, category, q, m } — null when the shape is foreign to
 * us (an empty hash is not foreign; it means "the default view").
 * Unknown MAILBOXES are foreign: applying one would desync the store.
 */
export function parseHash(hash, { validMailbox }) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return { mailbox: null, category: null, q: '', m: null };
  const [path, qs = ''] = raw.split('?');
  const [mailbox, category] = path.split('/');
  if (mailbox && !validMailbox(mailbox)) return null;
  const params = new URLSearchParams(qs);
  return {
    mailbox: mailbox || null,
    category: category || null,
    q: params.get('q') || '',
    m: params.get('m'),
  };
}

/**
 * Wire the module to the shell, once per boot.
 *
 * @param {Object} c
 * @param {() => Object} c.snapshot       {mailbox, category, query, selected}
 * @param {(mb:string)=>boolean} c.validMailbox
 * @param {(mb:string)=>void} c.applyMailbox
 * @param {(cat:string)=>void} c.applyCategory
 * @param {(q:string)=>void} c.applyQuery       sync the input AND the filter
 * @param {(id:string)=>boolean} c.trySelect    open if the id exists; false else
 * @param {() => boolean} c.hasSelection
 * @param {() => void} c.closeMessage
 */
export function wireDeepLinks(c) {
  cbs = c;
  if (boundWindow === window) return;
  boundWindow = window;
  window.addEventListener('popstate', () => {
    if (!cbs) return;
    applyHash(window.location.hash);
  });
}

/** Push a history entry for a DELIBERATE view change. See module header. */
export function navigateHash() {
  if (applying || !cbs) return;
  write(formatHash(cbs.snapshot()), 'pushState');
}

/** Mirror the settled frame into the URL. Never pushes. See module header. */
export function mirrorHash() {
  if (applying || !cbs) return;
  write(formatHash(cbs.snapshot()), 'replaceState');
}

/** Signing out leaves a bare URL: the gate has no state to deep-link. */
export function clearHash() {
  if (!cbs) return;
  write(window.location.pathname + window.location.search, 'replaceState');
}

/**
 * Apply a hash to the shell — popstate and boot share this path. Echoes
 * are suppressed through `applying`: the shell's own navigation functions
 * re-run as if the user clicked, but they must not write history in reply.
 */
export function applyHash(hash) {
  if (!cbs) return;
  const parts = parseHash(hash, { validMailbox: cbs.validMailbox });
  if (!parts) return; // foreign hash: not ours to interpret
  applying = true;
  try {
    /*
     * A deep link names a WHOLE view: what it omits means the default, not
     * "leave whatever is there". '#inbox' with last session's category
     * still applied would be the URL saying one thing and the screen
     * showing another. No-op parts are cheap — the shell's appliers skip
     * anything already in effect, so repeats cost no render.
     */
    cbs.applyMailbox(parts.mailbox || 'inbox');
    cbs.applyCategory(parts.category || 'all');
    cbs.applyQuery(parts.q);
    if (parts.m) {
      // The message may not be synced yet (boot deep link); latch it, and
      // the shell re-asks after every landing of data.
      pendingSelection = parts.m;
      checkPendingSelection();
    } else if (cbs.hasSelection()) {
      pendingSelection = null;
      cbs.closeMessage();
    } else {
      pendingSelection = null;
    }
  } finally {
    applying = false;
  }
  // Land the canonical form even when the link was partial (#inbox → fills
  // the category), so copying the URL always yields the full deep link.
  mirrorHash();
}

/**
 * Retry a latched selection after new data landed. Cheap: one Map lookup;
 * a latch left pending across a mailbox switch dies with the apply that
 * caused it.
 */
export function checkPendingSelection() {
  if (!pendingSelection || !cbs) return;
  const id = pendingSelection;
  if (cbs.trySelect(id)) pendingSelection = null;
}

function write(url, how) {
  /*
   * `window.location`, never bare `location`: the harness evaluates app
   * modules with only `window`/`document` shimmed onto globalThis, where a
   * bare `location` is a ReferenceError — and this file's callers run on
   * the boot path, so that error once surfaced AS THE SIGN-IN GATE.
   */
  try {
    // Identical writes earn no entry either way: double-pushing the same
    // hash would make Back look like it did nothing.
    if (new URL(url, window.location.href).href === window.location.href) return;
    window.history[how](null, '', url);
  } catch {
    /*
     * file:// preview windows, sandboxed iframes and jsdom all restrict the
     * History API differently. Deep links are an enhancement layered over
     * navigation that already works; a refusal here must never break either.
     */
  }
}

/** Test seam: module state outlives a jsdom boot. */
export function _resetDeepLinks() {
  cbs = null;
  applying = false;
  pendingSelection = null;
}

registerReset('deep-links', _resetDeepLinks);
