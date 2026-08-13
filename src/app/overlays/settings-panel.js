/**
 * Settings panel — the schema's own dialog.
 *
 * WHY SETTINGS LIVE IN THE APP NOW
 * --------------------------------
 * Every knob this product offers used to live on TWO surfaces, both worse
 * than this one: the extension options page (chrome://-adjacent, a different
 * window, styled by nobody, invisible until discovered) and scattered menu
 * entries that each reach one setting. The options page still exists — it
 * owns the rule editor's dry run, backup export/import, and the OAuth client
 * ID, all of which are workflows, not toggles — but "what can I control?"
 * should be answerable one click from the mail, not one migration away.
 *
 * THE LIST IS THE SCHEMA
 * ----------------------
 * settings.js declares that "a schema entry is a promise". This panel is
 * where every promise is KEPT: SECTIONS below covers every user-facing key,
 * and a test walks the schema to prove none is missing and none of the three
 * deliberate absences sneaks in:
 *
 *   - `clientId`       auth plumbing; belongs to the options page's guided
 *                      setup, linked from the footer, not duplicated here.
 *   - `coachDone`      a dismissal receipt, not a preference.
 *   - `paletteRecents` usage history the machine observes; the schema itself
 *                      states a habit is not a knob to polish.
 *
 * Writes go through `settings.set` and ONLY there — so coercion, persistence
 * rollback, and the subscriber that repaints density/threading/lanes are the
 * same code path the options page and the theme menu already use. A failed
 * write rolls the cache back AND re-emits; the live-binding below repaints
 * the control to the truth, and the toast says why.
 *
 * LIFECYCLE belongs to layers.js (Escape, focus trap, focus restore), the
 * same primitive every overlay here uses. This module owns: building the
 * controls from the descriptor, binding them live while open, and closing.
 */

import { openLayer, closeWithMotion, cancelExit } from './layers.js';
import { toast } from './toast.js';
import * as settings from '../system/settings.js';
import { THEMES } from '../system/themes.js';
import { setIcon } from '../core/icons.js';
import { registerReset } from '../core/reset-registry.js';

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ *
 * THE DESCRIPTOR. One entry per control; `key` must be a schema key.  *
 * ------------------------------------------------------------------ */

const fmtSeconds = (ms) => `${(ms / 1000).toFixed(1).replace(/\.0$/, '')} s`;
const fmtUndo = (s) => (s === 0 ? 'Off — sends immediately' : `${s} s`);
const fmtEvery = (ms) => {
  if (ms === 0) return 'Off — press r to refresh';
  const m = ms / 60000;
  return m < 1 ? `${ms / 1000} s` : `${m % 1 ? m.toFixed(1) : m} min`;
};

const SECTIONS = [
  {
    title: 'Appearance',
    items: [
      /* Themes are painted by ctx.setTheme — the one path the topbar swatch
         menu takes — so state, storage and the success toast cannot fork. */
      { kind: 'themes', key: 'theme', label: 'Theme' },
      {
        kind: 'select', key: 'density', label: 'Row density',
        options: [
          ['comfortable', 'Comfortable — the default'],
          ['cosy', 'Cosy'],
          ['compact', 'Compact — more mail on screen'],
        ],
        hint: 'Compact also hides the preview line, so every remaining character stays at full size.',
      },
      {
        kind: 'check', key: 'railOpen', label: 'Show the For-you rail',
        hint: 'Due soon, needs you, snoozed and the outbox, parked on the right. Below 1240px it becomes a slide-in drawer instead of a column.',
      },
    ],
  },
  {
    title: 'Reading',
    items: [
      {
        kind: 'check', key: 'threaded', label: 'Group messages into conversations',
        hint: 'A reply and the message it answers share one row. Off is a flat list in strict date order; search is unaffected either way.',
      },
      {
        kind: 'check', key: 'lanes', label: 'Group the inbox by what needs doing',
        hint: 'Needs reply, deadlines, announcements and newsletters, instead of one date-ordered run. Off by default — grouping is an opinion.',
      },
      { kind: 'check', key: 'markReadOnOpen', label: 'Mark a message read when I open it' },
      {
        kind: 'range', key: 'markReadDelayMs', label: 'Wait before marking read',
        min: 0, max: 5000, step: 200, format: fmtSeconds,
        hint: 'Unread is the one bit of triage you cannot reconstruct, so a mis-click should not consume it. 0 behaves like Gmail.',
      },
      {
        kind: 'select', key: 'remoteImages', label: 'Images from the internet',
        options: [
          ['ask', 'Ask each time (most private)'],
          ['always', 'Always load'],
          ['never', 'Never load'],
        ],
        hint: 'Remote images tell the sender when and where you read their mail.',
      },
    ],
  },
  {
    title: 'Sending',
    items: [
      {
        kind: 'range', key: 'undoSendSeconds', label: 'Undo window',
        min: 0, max: 30, step: 1, format: fmtUndo,
        hint: 'How long a sent message waits before it actually goes. A message that fails waits in the Outbox either way — nothing is lost.',
      },
      {
        kind: 'textarea', key: 'signature', label: 'Signature', wide: true,
        hint: 'Added when you open a new message, above any quoted text, with the standard -- marker mail clients use to detect it.',
      },
    ],
  },
  {
    title: 'Sync and notifications',
    items: [
      {
        kind: 'range', key: 'autoRefreshMs', label: 'Check for new mail every',
        min: 0, max: 600000, step: 30000, format: fmtEvery,
        hint: 'A delta check is one small request against a stored historyId, not a reload. Applies as soon as you let go of the slider.',
      },
      {
        kind: 'check', key: 'bgNotify', label: 'Notify me about AUGSD and academics mail when it arrives',
        hint: 'While the app is closed, every ~15 minutes. No other category ever notifies.',
      },
    ],
  },
];

/* ------------------------------------------------------------------ *
 * LIVE BINDINGS. While the panel is open, settings.subscribe repaints *
 * every mounted control from the cache: a rolled-back write, a theme  *
 * picked from the topbar menu, a rail toggled by its own button — all *
 * arrive here through the same event. The focused control is skipped, *
 * so a slider mid-drag is never yanked from under the pointer.        *
 * ------------------------------------------------------------------ */

/** @type {Map<string, Array<{el:Element, apply:(v:any)=>void}>>} */
let live = new Map();
let stopLive = null;

function track(key, el, apply) {
  const arr = live.get(key) || [];
  arr.push({ el, apply });
  live.set(key, arr);
}

function startLive() {
  stopLive?.();
  stopLive = settings.subscribe((key, value) => {
    for (const b of live.get(key) || []) {
      if (document.activeElement !== b.el) b.apply(value);
    }
  });
}

/**
 * The single write path. The toast names the failure in plain words because
 * `settings.set` already threw with the storage detail in its message — the
 * user needs "it did not save", and the subscriber reverts the control.
 */
async function commit(key, value) {
  try {
    await settings.set(key, value);
  } catch {
    toast('That setting could not be saved — storage is unavailable.', { kind: 'error' });
  }
}

/* ------------------------------------------------------------------ *
 * CONTROL BUILDERS. DOM calls, never innerHTML: the strings are ours, *
 * but shortcuts.js established the rule and this file keeps it.       *
 * ------------------------------------------------------------------ */

function buildCheck(doc, item) {
  const input = doc.createElement('input');
  input.type = 'checkbox';
  input.checked = settings.get(item.key) === true;
  input.setAttribute('aria-label', item.label);
  input.addEventListener('change', () => commit(item.key, input.checked));
  track(item.key, input, (v) => { input.checked = v === true; });
  return input;
}

function buildSelect(doc, item) {
  const sel = doc.createElement('select');
  sel.setAttribute('aria-label', item.label);
  for (const [value, text] of item.options) {
    const opt = doc.createElement('option');
    opt.value = value;
    opt.textContent = text;
    sel.appendChild(opt);
  }
  sel.value = settings.get(item.key);
  sel.addEventListener('change', () => commit(item.key, sel.value));
  track(item.key, sel, (v) => { sel.value = v; });
  return sel;
}

function buildRange(doc, item) {
  const wrap = doc.createElement('span');
  wrap.className = 'set-range';

  const input = doc.createElement('input');
  input.type = 'range';
  input.min = String(item.min);
  input.max = String(item.max);
  input.step = String(item.step);
  input.setAttribute('aria-label', item.label);

  const out = doc.createElement('b');
  out.className = 'set-val';
  const show = () => { out.textContent = item.format(Number(input.value)); };
  input.value = String(settings.get(item.key));
  show();

  /* `input` for the live label, `change` for the write — dragging a slider
     must not fire a storage round trip per pixel. The options page follows
     the same convention for the same reason. */
  input.addEventListener('input', show);
  input.addEventListener('change', () => commit(item.key, Number(input.value)));
  track(item.key, input, (v) => { input.value = String(v); show(); });

  wrap.append(input, out);
  return wrap;
}

function buildTextarea(doc, item) {
  const area = doc.createElement('textarea');
  area.rows = 3;
  area.spellcheck = true;
  area.setAttribute('aria-label', item.label);
  area.value = settings.get(item.key);
  area.addEventListener('change', () => commit(item.key, area.value));
  track(item.key, area, (v) => { area.value = v; });
  return area;
}

/**
 * Real radio inputs, not divs with aspirations: arrow keys, screen-reader
 * grouping and the checked state are the browser's problem, which is the
 * only way they are always solved. `radiogroup` semantics come free from
 * the shared `name`.
 */
function buildThemes(doc, item, ctx) {
  const grid = doc.createElement('div');
  grid.className = 'set-themes';
  grid.setAttribute('role', 'radiogroup');
  grid.setAttribute('aria-label', item.label);

  for (const t of THEMES) {
    const tile = doc.createElement('label');
    tile.className = 'set-theme';

    const radio = doc.createElement('input');
    radio.type = 'radio';
    radio.name = 'set-theme';
    radio.value = t.id;
    radio.checked = settings.get('theme') === t.id;
    radio.addEventListener('change', () => ctx.setTheme(t.id));

    const dot = doc.createElement('span');
    dot.className = 'set-swatch';
    dot.style.background = t.swatch;

    const name = doc.createElement('span');
    name.className = 'set-theme-name';
    name.textContent = t.name;

    const scheme = doc.createElement('span');
    scheme.className = 'set-theme-scheme';
    scheme.textContent = t.scheme === 'dark' ? 'Dark' : 'Light';

    tile.append(radio, dot, name, scheme);
    grid.appendChild(tile);
    track(item.key, radio, (v) => { radio.checked = v === t.id; });
  }
  return grid;
}

/* ------------------------------------------------------------------ *
 * THE PANEL ITSELF                                                    *
 * ------------------------------------------------------------------ */

/** The open layer, or null. The lifecycle belongs to layers.js. */
let panelLayer = null;
let wired = false;

/**
 * Self-wired once, on first open, so main.js pays exactly one line for this
 * feature (the invoker). Close has two routes: the button, and the dim —
 * a mousedown that lands ON the backdrop itself, never inside the box
 * (e.target === node is the backdrop-equality rule #help already uses).
 */
function wireOnce() {
  if (wired) return;
  wired = true;
  $('settings-close')?.addEventListener('click', () => closeSettings());
  $('settings')?.addEventListener('mousedown', (e) => {
    if (e.target === $('settings')) closeSettings();
  });
  $('settings-options')?.addEventListener('click', () => openFullOptions());
}

function renderBody(body, ctx, doc) {
  live = new Map();
  body.replaceChildren();

  for (const section of SECTIONS) {
    const sec = doc.createElement('section');
    sec.className = 'set-section';

    const h = doc.createElement('h3');
    h.textContent = section.title;
    sec.appendChild(h);

    for (const item of section.items) {
      const row = doc.createElement('div');
      row.className = 'set-row' + (item.wide ? ' wide' : '');

      const head = doc.createElement('div');
      head.className = 'set-label';
      const label = doc.createElement('span');
      label.textContent = item.label;
      head.appendChild(label);
      if (item.hint) {
        const hint = doc.createElement('small');
        hint.textContent = item.hint;
        head.appendChild(hint);
      }
      row.appendChild(head);

      const control =
        item.kind === 'themes' ? buildThemes(doc, item, ctx) :
        item.kind === 'check' ? buildCheck(doc, item) :
        item.kind === 'select' ? buildSelect(doc, item) :
        item.kind === 'range' ? buildRange(doc, item) :
        buildTextarea(doc, item);

      const cell = doc.createElement('div');
      cell.className = 'set-control' + (item.kind === 'themes' || item.wide ? ' wide' : '');
      cell.appendChild(control);
      row.appendChild(cell);
      sec.appendChild(row);
    }
    body.appendChild(sec);
  }
}

export function openSettings(ctx = {}) {
  const node = $('settings');
  if (!node || panelLayer) return;

  wireOnce();
  renderBody($('settings-body'), ctx, node.ownerDocument || document);
  setIcon($('settings-close'), 'close', { size: 15 });
  startLive();

  cancelExit(node);
  node.hidden = false;
  panelLayer = openLayer({
    name: 'settings',
    node,
    onClose: () => {
      stopLive?.();
      stopLive = null;
      closeWithMotion(node);
      panelLayer = null;
    },
  });
  $('settings-close')?.focus();
}

export function closeSettings() {
  panelLayer?.close();
}

export function settingsOpen() {
  return !!panelLayer;
}

export function toggleSettings(ctx = {}) {
  if (panelLayer) closeSettings();
  else openSettings(ctx);
}

/** Full options page: rules dry-run, backup, and the OAuth client ID. */
export function openFullOptions() {
  /* In the extension this is the canonical hand-off; in a file:// preview
     there is no runtime, so the page itself is the fallback. */
  if (globalThis.chrome?.runtime?.openOptionsPage) {
    globalThis.chrome.runtime.openOptionsPage();
  } else {
    globalThis.open?.('options.html', '_blank');
  }
}

/** Test seam: close without ceremony and forget the handle. */
export function _resetSettingsPanel() {
  panelLayer = null;
  stopLive?.();
  stopLive = null;
  live = new Map();
  wired = false; // listeners sit on a document the boot may replace
  const node = $('settings');
  if (node) node.hidden = true;
}
registerReset('settings-panel', _resetSettingsPanel);
