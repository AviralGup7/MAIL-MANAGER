/**
 * Search suggestions — the combobox under the topbar's search field.
 *
 * RESPONSIBILITY  Offer completions drawn from the live mailbox (senders,
 *                 labels, categories, saved views, history), drive the
 *                 combobox contract (aria-expanded/activedescendant, arrow
 *                 keys, Enter, Escape), and remember run queries.
 * OWNS            #search-suggest rendering; suggestions, suggestIndex,
 *                 queryHistory, suggestBlurTimer; the field's focus/blur/
 *                 keydown wiring and the popup's mousedown wiring.
 * DOES NOT OWN    the search itself — the shell's input handler owns
 *                 state.query, the local filter, the server search and the
 *                 saved-view affordance; it merely asks this module to
 *                 re-render. Run-query execution belongs to the shell too.
 * DEPENDS ON      injected ctx (store getter, el, runQuery) + suggest.js,
 *                 contacts.js, palette.js (label names), saved-views.js
 *                 (current views), the category vocabulary.
 *
 * Extracted in the round-52 workspace sequence (map §6 step 3): a
 * self-contained cluster with one seam back to the shell.
 */

import * as suggest from './suggest.js';
import { addressOf } from './contacts.js';
import { labelNames } from './palette.js';
import { currentViews } from './saved-views.js';
import { SIDEBAR_ORDER } from '../classify/categories.js';

const $ = (id) => document.getElementById(id);

/** Set by wireSuggestUI at boot. */
let ctx = null;
let el = null;
let storeOf = null;

/** The live suggestion list, and which row the arrow keys are on. */
let suggestions = [];
let suggestIndex = -1;
let queryHistory = [];

/** Close-on-blur is delayed; see the blur listener. */
let suggestBlurTimer = 0;

/**
 * Wire the combobox to the shell. Called once, at boot.
 *
 * @param {Object} c
 * @param {()=>import('./store.js').Store} c.store  live store getter
 * @param {Object} c.el          cached DOM map (el.search)
 * @param {(q:string)=>void} c.runQuery  execute a complete query
 */
export function wireSuggestUI(c) {
  ctx = c;
  el = c.el;
  // WRAP, DO NOT RESOLVE: the store getter must stay live across mailbox
  // switches (same discipline as every other tenant).
  storeOf = () => c.store;

  el.search.addEventListener('focus', () => renderSuggestions());

  /*
   * Close on blur, but on a delay: a click on a suggestion blurs the input
   * BEFORE the click lands, so hiding synchronously eats the selection. This
   * is the standard combobox hazard and the reason the delay is not a smell.
   */
  el.search.addEventListener('blur', () => {
    clearTimeout(suggestBlurTimer);
    suggestBlurTimer = setTimeout(() => {
      suggestBlurTimer = 0;
      const box = $('search-suggest');
      if (box && !box.contains(document.activeElement)) {
        box.hidden = true;
        // Keep the combobox contract honest: the popup is gone, so the field
        // must stop announcing it.
        el.search.setAttribute('aria-expanded', 'false');
        el.search.removeAttribute('aria-activedescendant');
      }
    }, 120);
  });

  el.search.addEventListener('keydown', (e) => {
    const box = $('search-suggest');
    const open = box && !box.hidden && suggestions.length > 0;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) return;
      e.preventDefault();
      moveSuggestion(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      if (open && suggestIndex >= 0) {
        e.preventDefault();
        acceptSuggestion(suggestIndex);
      } else {
        // A plain Enter with nothing highlighted runs what was typed, which
        // is what a search field is expected to do.
        rememberQuery(el.search.value);
        if (box) box.hidden = true;
      }
    } else if (e.key === 'Escape') {
      /*
       * Escape closes the SUGGESTIONS first and the takeover second. Without
       * stopping propagation here, dismissing a dropdown would throw the user
       * back to Gmail -- the same layered-Escape hazard the palette hit.
       *
       * preventDefault ALWAYS, open or closed (accessibility audit A-A6):
       * this field is type="search", and Blink NATIVELY clears a search
       * input on un-cancelled Escape, firing native input+search events. The
       * probe trail (plain page, CDP keys, zero app code): Escape emptied the
       * field, the shell's input listener re-rendered suggestions against the
       * now-EMPTY query, and the box "reopened" over the ladder's unreached
       * blur rung -- one keystroke both closed the dropdown and destroyed the
       * query. No JS setter or dispatch anywhere in that path. Escape here
       * means "walk the layer stack", never "browser, delete my query"; the
       * chips row's Clear button stays the explicit way to empty the field.
       */
      e.preventDefault();
      if (open) {
        e.stopPropagation();
        box.hidden = true;
        suggestIndex = -1;
        // Same honesty as the blur-close path below: the popup is gone, so
        // the field must stop announcing it. Escape closed the box with focus
        // still inside; only the attribute can carry the news.
        el.search.setAttribute('aria-expanded', 'false');
        el.search.removeAttribute('aria-activedescendant');
      }
    }
  });

  $('search-suggest')?.addEventListener('mousedown', (e) => {
    // mousedown, not click: the input's blur fires first otherwise.
    const li = e.target.closest('.suggest-item');
    if (!li) return;
    e.preventDefault();
    acceptSuggestion(Number(li.dataset.index));
  });

  suggest.loadHistory().then((h) => { queryHistory = h; });
}

/** Drop the pending blur-close. Called when the shell cancels all work. */
export function cancelSuggestBlur() {
  clearTimeout(suggestBlurTimer);
  suggestBlurTimer = 0;
}

/**
 * Values are drawn from what is ACTUALLY IN THE MAILBOX.
 *
 * A suggestion that produces no results is worse than no suggestion: it reads
 * as the search being broken rather than the query being wrong. Senders come
 * from the store, labels from the fetched label list, categories from the
 * classifier's own vocabulary.
 */
function suggestContext() {
  const senders = new Set();
  for (const id of storeOf().idsFor('all').slice(0, 400)) {
    const m = storeOf().get(id);
    if (m?.from) senders.add(addressOf(m.from));
  }
  return {
    history: queryHistory,
    views: currentViews(),
    senders: [...senders].filter(Boolean).slice(0, 40),
    labels: labelNames(),
    categories: SIDEBAR_ORDER.map((key) => ({ key })),
    limit: 8,
  };
}

export function renderSuggestions() {
  const box = $('search-suggest');
  if (!box) return;

  // Only while the field has focus. A list hanging under an unfocused input is
  // a dropdown nobody opened.
  if (document.activeElement !== el.search) {
    box.hidden = true;
    return;
  }

  suggestions = suggest.suggest(el.search.value, suggestContext());
  suggestIndex = -1;
  el.search.setAttribute('aria-expanded', 'false');
  el.search.removeAttribute('aria-activedescendant');

  if (suggestions.length === 0) {
    box.hidden = true;
    return;
  }

  const frag = document.createDocumentFragment();
  suggestions.forEach((sg, i) => {
    const li = document.createElement('li');
    li.className = 'suggest-item';
    li.id = `suggest-opt-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.dataset.index = String(i);

    const label = document.createElement('span');
    label.className = 'suggest-label';
    label.textContent = sg.label;

    const hint = document.createElement('span');
    hint.className = 'suggest-hint';
    hint.textContent = sg.hint || '';

    li.append(label, hint);
    frag.appendChild(li);
  });
  box.replaceChildren(frag);
  box.hidden = false;
  // Combobox contract (40-ENG section 8): the field announces the popup and
  // names the list it controls, so a screen reader treats this as one widget.
  el.search.setAttribute('aria-expanded', 'true');
}

export function moveSuggestion(delta) {
  if (suggestions.length === 0) return;
  suggestIndex = (suggestIndex + delta + suggestions.length) % suggestions.length;
  const box = $('search-suggest');
  [...box.children].forEach((li, i) => {
    li.classList.toggle('active', i === suggestIndex);
    li.setAttribute('aria-selected', String(i === suggestIndex));
  });
  // aria-activedescendant moves with the arrow keys — the field is the
  // combobox, so the reader must hear the option as the field's own value.
  el.search.setAttribute('aria-activedescendant', `suggest-opt-${suggestIndex}`);
}

/**
 * Accept a suggestion.
 *
 * An INCOMPLETE one -- `from:` with no value yet -- leaves the caret in the
 * field and re-runs the list against the new prefix, because the user is
 * mid-thought. A complete one runs the query. Getting this backwards makes the
 * control feel broken in a way people cannot articulate.
 */
export function acceptSuggestion(i) {
  const sg = suggestions[i];
  if (!sg) return;
  el.search.value = sg.value;
  if (suggest.isComplete(sg)) {
    ctx.runQuery(sg.value);
    rememberQuery(sg.value);
    $('search-suggest').hidden = true;
  } else {
    el.search.focus();
    renderSuggestions();
  }
}

/** Keep the query history, so the empty box can offer what was searched before. */
export function rememberQuery(q) {
  queryHistory = suggest.addToHistory(queryHistory, q);
  suggest.saveHistory(queryHistory);
}
