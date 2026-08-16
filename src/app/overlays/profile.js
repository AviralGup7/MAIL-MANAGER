/**
 * The profile page — who is signed in, and what this install knows about them.
 *
 * RESPONSIBILITY  Render an account summary from data the app ALREADY holds,
 *                 and offer the account-level actions that belong next to it.
 * OWNS            the profile overlay's DOM and its open/close call. Nothing
 *                 durable: every figure is read at open time and thrown away.
 * DOES NOT OWN    identity (background/auth.js), the mail corpus (mail/store),
 *                 settings (system/settings.js), or the layer lifecycle
 *                 (overlays/layers.js).
 *
 * EVERY NUMBER ON THIS PAGE IS MEASURED, NEVER ESTIMATED
 * -----------------------------------------------------
 * A profile page is where dashboards go to invent things — "productivity
 * scores", streaks, a response-time average computed from data we do not
 * have. This one refuses. Each stat below is either read straight from the
 * live store, counted from the storage registry, or taken from a setting the
 * user themselves chose. If a figure cannot be computed honestly it is not
 * shown at all: `stat()` drops any row whose value is null, so an unknown
 * renders as *absence* rather than as a confident zero.
 *
 * That is the same standard the rest of the app holds — `fmtTime` returns ''
 * rather than "NaN:NaN AM", the reader will not claim a cached body is live —
 * and it matters more here, because a summary screen is read as authoritative.
 *
 * WHY IT IS A LAYER AND NOT A ROUTE
 * ---------------------------------
 * The app is one page with a list and a reader; there is no router, and
 * inventing one for a single screen would add a navigation model the other
 * twelve overlays do not use. `layers.js` already owns focus trapping, Escape,
 * scrim and exit motion, so a profile "page" that is a layer inherits all of
 * it and stays consistent with settings, help and the palette.
 */
import { openLayer, closeWithMotion, cancelExit } from './layers.js';
import { icon, setIcon } from '../core/icons.js';
import { displayName } from '../core/display.js';
import * as settings from '../system/settings.js';
import { getTheme } from '../system/themes.js';
import { ACCOUNT_SCOPED_KEYS } from '../system/storage-registry.js';

const $ = (id) => document.getElementById(id);

/** The open profile layer, or null. Lifecycle belongs to layers.js. */
let profileLayer = null;

/**
 * Initials for the avatar, from the display name or the address.
 *
 * Two letters at most: "Aviral Gupta" -> AG, "f20240294@..." -> F2. Falls back
 * to a single glyph rather than empty, because an avatar with no content
 * collapses and takes the header layout with it.
 */
export function initialsOf(email, name) {
  const named = String(name || '').trim();
  /* WITH NO DISPLAY NAME, ONLY THE LOCAL PART COUNTS. Splitting the whole
     address gave `f20240294@pilani.bits-pilani.ac.in` the initials "FB" — the
     F of the roll number and the B of *bits*, which is the domain, not the
     person. Everyone at one institution would share the second letter. */
  const source = named || String(email || '').trim().split('@')[0];
  if (!source) return '?';
  const words = source.replace(/[^\p{L}\p{N}\s._-]/gu, ' ')
    .split(/[\s._-]+/u)
    .filter(Boolean);
  /* Two words only make two initials when BOTH start with a letter: a roll
     number like `f2024.0294` is one identifier split by punctuation, not a
     first and last name. */
  if (words.length >= 2 && /^\p{L}/u.test(words[0]) && /^\p{L}/u.test(words[1])) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return (words[0] || source).slice(0, 2).toUpperCase();
}

/**
 * The mailbox figures, straight from the live store.
 *
 * Returns null for a figure the store cannot answer, so the caller can omit
 * the row instead of printing a zero that reads as "you have no mail".
 */
export function mailboxStats(store) {
  if (!store) return { total: null, unread: null, categories: null };
  let total = null;
  let unread = null;
  let categories = null;
  try {
    total = typeof store.size === 'number' ? store.size : null;
    const counts = store.counts?.() || null;
    const unreadCounts = store.unreadCounts?.() || null;
    if (unreadCounts) {
      unread = Object.values(unreadCounts).reduce((a, b) => a + b, 0);
    }
    if (counts) categories = Object.keys(counts).length;
  } catch {
    /* A damaged store must not take the profile page down with it — the
       whole point of this screen is to be readable when things are odd. */
  }
  return { total, unread, categories };
}

/** How many storage keys follow this account, from the registry itself. */
export function accountScopedKeyCount() {
  try {
    return ACCOUNT_SCOPED_KEYS.length;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * RENDERING. DOM calls, never innerHTML — the house rule shortcuts.js *
 * set and every overlay since has kept.                               *
 * ------------------------------------------------------------------ */

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

/**
 * One statistic. Returns null when the value is unknown, and the caller drops
 * it — an omitted row is honest, a zero is a claim.
 */
function stat(doc, label, value, note) {
  if (value == null || value === '') return null;
  const cell = el(doc, 'div', 'pf-stat');
  cell.appendChild(el(doc, 'span', 'pf-stat-v', value));
  cell.appendChild(el(doc, 'span', 'pf-stat-k', label));
  if (note) cell.appendChild(el(doc, 'small', 'pf-stat-n', note));
  return cell;
}

function renderIdentity(doc, body, data) {
  const head = el(doc, 'div', 'pf-identity');

  const av = el(doc, 'div', 'pf-avatar');
  av.setAttribute('aria-hidden', 'true');
  av.appendChild(el(doc, 'span', 'pf-avatar-t', data.initials));
  head.appendChild(av);

  const who = el(doc, 'div', 'pf-who');
  who.appendChild(el(doc, 'h3', 'pf-name', data.name || 'Signed in'));
  const addr = el(doc, 'p', 'pf-addr', data.email || 'Not signed in');
  addr.id = 'pf-addr';
  who.appendChild(addr);

  const badges = el(doc, 'div', 'pf-badges');
  /* The BITS badge is a fact about the address, derived the same way the
     classifier derives it — not a decoration the user can be flattered by. */
  if (data.isBits) {
    const b = el(doc, 'span', 'pf-badge is-bits', 'BITS account');
    badges.appendChild(b);
  }
  badges.appendChild(el(doc, 'span', 'pf-badge', data.signedIn ? 'Connected' : 'Signed out'));
  who.appendChild(badges);

  head.appendChild(who);
  body.appendChild(head);
}

function renderStats(doc, body, data) {
  const grid = el(doc, 'div', 'pf-stats');
  const rows = [
    stat(doc, 'messages held', data.total, 'in this mailbox view'),
    stat(doc, 'unread', data.unread),
    stat(doc, 'categories in use', data.categories),
    stat(doc, 'keys scoped to you', data.scopedKeys, 'cleared on sign-out'),
  ].filter(Boolean);

  if (!rows.length) {
    /* Nothing measurable yet — say so plainly rather than draw an empty grid
       of zeroes, which is the failure mode this page is written against. */
    body.appendChild(el(doc, 'p', 'pf-empty',
      'No mail has loaded yet, so there is nothing to summarise. This page fills in once the first sync lands.'));
    return;
  }
  for (const r of rows) grid.appendChild(r);
  body.appendChild(grid);
}

function renderPrefs(doc, body, data) {
  const sec = el(doc, 'section', 'pf-section');
  sec.appendChild(el(doc, 'h4', 'pf-h', 'This install'));

  const dl = el(doc, 'dl', 'pf-defs');
  const pairs = [
    ['Theme', data.themeName],
    ['Density', data.density],
    ['Undo-send hold', data.undoHold],
  ];
  for (const [k, v] of pairs) {
    if (!v) continue;
    dl.appendChild(el(doc, 'dt', null, k));
    dl.appendChild(el(doc, 'dd', null, v));
  }
  sec.appendChild(dl);
  body.appendChild(sec);
}

function renderActions(doc, body, ctx) {
  const sec = el(doc, 'section', 'pf-section');
  sec.appendChild(el(doc, 'h4', 'pf-h', 'Account'));

  const row = el(doc, 'div', 'pf-actions');
  const add = (id, label, iconName, run, danger) => {
    const b = el(doc, 'button', 'ghost' + (danger ? ' danger' : ''));
    b.type = 'button';
    b.id = id;
    if (iconName) {
      /* icons.js builds through the GLOBAL document (createElementNS), which
         is right in the app and wrong for a caller that passed its own doc —
         a headless render has no global. The glyph is decoration; losing it
         must not cost the page, so the label always ships and the icon is
         best-effort. */
      try {
        const g = icon(iconName, { size: 15 });
        if (g) b.appendChild(g);
      } catch { /* no global document: label-only button */ }
    }
    b.appendChild(el(doc, 'span', null, label));
    b.addEventListener('click', run);
    row.appendChild(b);
  };

  add('pf-settings', 'Settings', 'settings', () => {
    closeProfile();
    ctx.openSettings?.();
  });
  add('pf-activity', 'Activity log', 'clock', () => {
    closeProfile();
    ctx.openActivityLog?.();
  });
  sec.appendChild(row);
  body.appendChild(sec);
}

/** Gather everything the page shows. Pure read — nothing here writes. */
function collect(ctx) {
  const email = String(ctx?.state?.selfEmail || '').trim();
  const name = email ? displayName(ctx.profileName?.() || email) : '';
  const stats = mailboxStats(ctx?.store);
  const themeId = settings.get('theme') || 'daylight';
  let themeName = themeId;
  try {
    themeName = getTheme(themeId)?.name || themeId;
  } catch { /* an unknown id still prints as itself */ }

  const holdMs = Number(ctx?.undoSendMs?.());
  return {
    email,
    name,
    initials: initialsOf(email, name),
    signedIn: !!email,
    /* Derived from the address, using the same suffix rule the classifier
       uses — never a bare `includes`, which round 10's H-1 showed accepts
       `…bits-pilani.ac.in.attacker.com`. */
    isBits: /(^|[.@])bits-pilani\.ac\.in$/.test(email.split('@')[1] || ''),
    total: stats.total,
    unread: stats.unread,
    categories: stats.categories,
    scopedKeys: accountScopedKeyCount(),
    themeName,
    density: settings.get('density') || 'comfortable',
    undoHold: Number.isFinite(holdMs) && holdMs > 0 ? `${Math.round(holdMs / 1000)}s` : null,
  };
}

export function renderProfile(body, ctx, doc = document) {
  body.replaceChildren();
  const data = collect(ctx);
  renderIdentity(doc, body, data);
  renderStats(doc, body, data);
  renderPrefs(doc, body, data);
  renderActions(doc, body, ctx);
  return data;
}

export function openProfile(ctx = {}) {
  const node = $('profile');
  if (!node || profileLayer) return;

  renderProfile($('profile-body'), ctx, node.ownerDocument || document);
  /* The close glyph is painted, not typed into the HTML — same as settings,
     so one icon set owns every overlay's chrome. */
  setIcon($('profile-close'), 'close', { size: 15 });

  cancelExit(node);
  node.hidden = false;
  profileLayer = openLayer({
    name: 'profile',
    node,
    onClose: () => {
      closeWithMotion(node);
      profileLayer = null;
    },
  });
  $('profile-close')?.focus();
}

export function closeProfile() {
  profileLayer?.close();
}

export function profileOpen() {
  return !!profileLayer;
}

export function toggleProfile(ctx = {}) {
  if (profileLayer) closeProfile();
  else openProfile(ctx);
}

/** Test seam: drop the layer reference without touching the DOM. */
export function _resetProfile() {
  profileLayer = null;
}
