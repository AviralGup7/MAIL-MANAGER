/**
 * Search chips — the query as OBJECTS, not a string (round 65/e, F6, brief
 * §15).
 *
 * THE PROBLEM (F6). A typed query is one opaque run of text: `from:augsd
 * is:unread registration`. Editing scope #2 out of it means caret gymnastics
 * inside a single-line input, and there was no one-click clear and no "keep
 * this" from the result state — the saved-view button sits up in the
 * toolbar, away from the results it saves.
 *
 * THE FIX. While a query filters the list, the round-62 P-3 readout slot in
 * the list head becomes a chip strip: one chip per lexical token (a scope
 * pair like `from:augsd`, or one free-text run), each individually
 * removable, plus a Clear and a Save-view control. Chips EDIT THE QUERY
 * STRING through callbacks the shell supplies — they never touch the store,
 * the overlay, or the input element — because filter semantics already have
 * exactly one owner (query.js parse) and one application path (the search
 * input flow). This module owns only the lexical token model and the DOM.
 *
 * LEXICAL, NOT SEMANTIC, on purpose. parseQuery() interprets; chips must
 * round-trip, so they reuse query.js's `tokenize` — the same splitter the
 * parser starts from — and keep the RAW text of every token. Removing a
 * chip is string surgery, never re-interpretation, so a chip the parser
 * would reject still displays and still removes cleanly.
 *
 * POINTER-ONLY, on purpose (same doctrine as the row hover-verbs, 65/b):
 * every chip action mirrors a path the keyboard already owns — the search
 * input edits the same string, and the toolbar's "Save view" button is
 * tabbable whenever a save is possible. Mirrored affordances stay out of
 * the tab order so Tab doesn't pay for the same destination twice.
 */

import { tokenize } from './query.js';
import { currentViews } from './saved-views.js';

/** What a scope operator's chip calls itself. Free text has no entry. */
const SCOPE_LABELS = {
  from: 'from', to: 'to', subject: 'subject', category: 'category',
  label: 'label', is: 'is', has: 'has', before: 'before', after: 'after',
  older_than: 'older than', newer_than: 'newer than',
};

/**
 * The chip model for a query. Each entry: { raw, negated, key|null, value }.
 *
 * Free text is ONE chip even when it is several words — five single-word
 * "chips" are five deletion tariffs on what the user thinks of as one
 * thought, so consecutive scope-less tokens (and unknown `x:y` pairs, which
 * parse as free text) merge into a single run. Quoted phrases keep their
 * quote marks in `raw` so rejoining is exact; `value` strips one layer for
 * display.
 */
export function chipModel(query) {
  const chips = [];
  for (const raw of tokenize(query)) {
    const m = /^(-?)([a-z_]+):(.*)$/.exec(raw);
    if (m && Object.prototype.hasOwnProperty.call(SCOPE_LABELS, m[2])) {
      chips.push({ raw, negated: m[1] === '-', key: m[2], value: displayValue(m[3]) });
    } else if (chips.length && chips[chips.length - 1].key === null) {
      const prev = chips[chips.length - 1];
      prev.raw += ' ' + raw;
      prev.value += ' ' + displayValue(raw);
    } else {
      chips.push({ raw, negated: raw.startsWith('-'), key: null, value: displayValue(raw) });
    }
  }
  return chips;
}

/** A token's face: one layer of surrounding quotes off, '-' off free text. */
function displayValue(raw) {
  let v = raw;
  if (v.startsWith('-')) v = v.slice(1);
  const unq = /^"(.*)"$/.exec(v);
  return unq ? unq[1] : v;
}

/** What remains after one chip is removed. Pure — the shell applies it. */
export function queryWithout(query, rawToDrop) {
  const kept = [];
  let dropped = false;
  for (const raw of tokenize(query)) {
    if (!dropped && raw === rawToDrop) { dropped = true; continue; }
    kept.push(raw);
  }
  return kept.join(' ');
}

/** A view already holding exactly this query makes "Save view" a lie. */
function isSaved(query) {
  const q = query.trim();
  return currentViews().some((v) => v.query === q);
}

/**
 * Repaint the chip strip. Rebuilt wholesale, like the rows around it — the
 * strip is four-to-ten nodes and rebuild-on-change is the render doctrine
 * the whole list already follows.
 */
export function renderSearchChips(container, query) {
  container.textContent = '';

  const label = document.createElement('span');
  label.className = 'q-label';
  label.textContent = 'Searching:';
  container.appendChild(label);

  for (const chip of chipModel(query)) {
    const el = document.createElement('span');
    el.className = 'q-chip' + (chip.negated ? ' not' : '');
    el.dataset.negated = String(chip.negated);
    el.dataset.scope = chip.key || 'text';
    if (chip.key) {
      const k = document.createElement('span');
      k.className = 'q-k';
      k.textContent = `${chip.negated ? 'not ' : ''}${SCOPE_LABELS[chip.key]}:`;
      el.appendChild(k);
    }
    const v = document.createElement('span');
    v.className = 'q-v';
    v.textContent = chip.value;
    el.appendChild(v);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'q-x';
    x.dataset.removeChip = chip.raw;
    x.tabIndex = -1;
    x.setAttribute('aria-label', `Remove filter: ${chip.raw}`);
    x.innerHTML = '&times;';
    el.appendChild(x);
    container.appendChild(el);
  }

  /*
   * Save mirrors the toolbar affordance's rule exactly (updateSaveAffordance
   * in saved-views.js): offered only while the query is NOT already a view.
   * Two save buttons never coexist — visibility is derived, never counted.
   */
  if (!isSaved(query)) {
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'q-act';
    save.dataset.chipAction = 'save';
    save.tabIndex = -1;
    save.title = 'Save this search as a view';
    save.textContent = 'Save view';
    container.appendChild(save);
  }

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'q-act q-clear';
  clear.dataset.chipAction = 'clear';
  clear.tabIndex = -1;
  clear.title = 'Clear the search';
  clear.textContent = 'Clear';
  container.appendChild(clear);
}

/**
 * Wire the strip once, against the STABLE list head. The chip strip itself
 * is re-rendered per keystroke, so listeners hung on it would be hung on
 * moving sand; the head is fixed chrome. Related chips exist nowhere else,
 * and unrelated buttons do not exist inside #listquery, so a document-wide
 * or listhead-wide delegate both disambiguate on the same dataset keys.
 *
 * @param {Object} c
 * @param {Element} c.head                 #listhead — the stable ancestor
 * @param {Element} c.search               the search input (restored to after an edit)
 * @param {(q:string)=>void} c.applyQuery  apply an edited query string
 * @param {()=>void} c.clearQuery          clear the whole search
 * @param {()=>void} c.save                the shell's save-view flow
 */
export function wireSearchChips(c) {
  c.head.addEventListener('click', (e) => {
    const x = e.target.closest('[data-remove-chip]');
    if (x) {
      // Focus belongs back in the search box: the edit happened there in
      // spirit, and focus left on a removed node would drop to <body>.
      c.applyQuery(queryWithout(c.search.value, x.dataset.removeChip));
      c.search.focus();
      return;
    }
    const action = e.target.closest('[data-chip-action]');
    if (!action) return;
    if (action.dataset.chipAction === 'clear') {
      c.clearQuery();
      c.search.focus();
    } else if (action.dataset.chipAction === 'save') {
      // Field-first: the query is what is being saved, so the confirm dialog
      // should open from the field that owns the string.
      c.search.focus();
      c.save();
    }
  });
}
