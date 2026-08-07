/**
 * Saved views: the searches the user chose to keep.
 *
 * Extracted from app.js as the second tenant. Less loosely coupled than server
 * search -- `renderViews()` is called from inside the rAF render loop, beside
 * renderList and renderSidebar -- so the split keeps that call in the shell
 * and moves only the rendering, the counting and the persistence handling.
 *
 * The live count is what makes a saved view useful rather than a bookmark, but
 * each one is a full query, so it runs only on a SETTLED store change. That is
 * the same discipline the render loop follows and the reason this module is
 * called FROM the loop rather than subscribing on its own.
 */

import { loadViews } from './views.js';
import { parseQuery } from './query.js';
import { icon } from './icons.js';

const $ = (id) => document.getElementById(id);

/** Set by wireViews at boot. */
let ctx = null;

/** The kept searches. Written in exactly one place: refreshViews. */
let savedViews = [];

export function wireViews(appCtx) {
  ctx = appCtx;
}

/** Test seam: module state outlives a jsdom boot. */
export function _resetViews() {
  savedViews = [];
  ctx = null;
}

/**
 * Render the saved-view list with live counts.
 *
 * Counts make a saved view genuinely useful rather than a bookmark — but each
 * one is a full query, so this runs only on a SETTLED store change, never per
 * keystroke. That is the same discipline the render loop follows.
 */
export function renderViews() {
  if (!ctx.viewsList()) return;
  const frag = document.createDocumentFragment();

  for (const v of savedViews) {
    const li = document.createElement('li');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'view-item';
    btn.dataset.viewId = v.id;
    btn.dataset.query = v.query;
    btn.title = v.query;
    btn.setAttribute('aria-current', String(ctx.state.query === v.query));

    const ico = document.createElement('span');
    ico.className = 'view-icon';
    ico.appendChild(icon(v.icon || 'search', { size: 14 }));

    const name = document.createElement('span');
    name.className = 'view-name';
    name.textContent = v.name;

    const count = document.createElement('span');
    count.className = 'view-count';
    const n = countFor(v.query);
    count.textContent = n ? String(n) : '';

    const del = document.createElement('span');
    del.className = 'view-remove';
    del.dataset.removeView = v.id;
    del.setAttribute('role', 'button');
    del.setAttribute('tabindex', '-1');
    del.setAttribute('aria-label', `Remove view ${v.name}`);
    del.appendChild(icon('close', { size: 12 }));

    btn.append(ico, name, count, del);
    li.appendChild(btn);
    frag.appendChild(li);
  }
  ctx.viewsList().replaceChildren(frag);
}

export async function refreshViews() {
  savedViews = await loadViews();
  renderViews();
}

/** How many messages a saved query currently matches. */
function countFor(query) {
  try {
    const parsed = parseQuery(query);
    const base = parsed.terms.length
      ? ctx.store.search(parsed.terms.join(' '), 'all')
      : ctx.store.idsFor('all');
    if (!parsed.predicate) return base.length;
    let n = 0;
    for (const id of base) {
      const m = ctx.store.get(id);
      if (m && parsed.predicate(m)) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A sensible default name, so the user is confirming rather than composing.
 *
 * `is:unread category:augsd` becomes "Unread AUGSD" — a blank prompt makes the
 * user do work the query has already described.
 */
export function suggestViewName(q) {
  const parsed = parseQuery(q);
  const bits = [];
  for (const o of parsed.operators) {
    if (o.key === 'is' || o.key === 'has') bits.push(cap(o.value));
    else if (o.key === 'category') bits.push(CATEGORY_LABELS[o.value] || cap(o.value));
    else if (o.key === 'from') bits.push(`From ${o.value}`);
  }
  if (parsed.terms.length) bits.push(`"${parsed.terms.join(' ')}"`);
  return bits.join(' ').slice(0, 40) || q.slice(0, 40);
}

export function updateSaveAffordance() {
  const btn = $('btn-save-view');
  if (!btn) return;
  const q = ctx.state.query.trim();
  const known = savedViews.some((v) => v.query === q);
  btn.hidden = !q || known;
}
