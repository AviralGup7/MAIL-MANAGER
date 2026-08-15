/**
 * The command palette (Ctrl+K).
 *
 * Split out of features.js -- see radar.js for the measurement that justified
 * it. Depends on compose and undo (it offers "Compose" and "Undo" as
 * commands) but nothing depends on the palette, so the edge is one-way and
 * there is no cycle.
 */

import { icon } from '../core/icons.js';
import { openLayer, closeWithMotion, cancelExit } from './layers.js';
import { cameraPush, cameraPop } from '../motion/camera.js';
import { openCompose } from '../compose/compose.js';
import { performUndo, undoStack } from '../mail/undo-actions.js';
import * as settings from '../system/settings.js';
import { registerReset } from '../core/reset-registry.js';

const $ = (id) => document.getElementById(id);

/* ========================================================================== *
 * COMMAND PALETTE
 * ========================================================================== */

let paletteCommands = [];
let paletteFiltered = [];
let paletteIndex = 0;
/** The live query, so the empty state can quote it and offer a fallback. */
let paletteQuery = '';
/** Untyped listings lead with this many recents; 0 while anything is typed. */
let paletteRecentCount = 0;

/* ========================================================================== *
 * RECENTS (round 65/f, F5)
 *
 * The palette used to open to the same flat dozen every time: the command
 * you ran five minutes ago could be fourteen rows away AGAIN. A palette is
 * a habit machine — the cost of a command is not finding it once but
 * finding it every time. The MRU is that memory: up to four ids, persisted
 * through settings as JSON (the schema has no array type, and ids embed
 * Gmail label names that may contain commas, so a delimiter would someday
 * split one). Withheld from backups as usage history, not preference.
 * ========================================================================== */
const RECENTS_MAX = 4;

/** The persisted list, decode-failures and all folded to empty. */
export function parseRecents(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Untyped order: what you used lately, then everything in canonical order.
 *
 * Recents resolve against TODAY's command list — an id whose command no
 * longer exists right now (a renamed label, a message context that went
 * away) drops out silently instead of rendering a row that lies. Exported
 * for tests; the render path consumes only the return value.
 */
export function orderForEmptyQuery(cmds, recentIds) {
  const recent = [];
  const seen = new Set();
  for (const id of recentIds) {
    if (recent.length >= RECENTS_MAX) break;
    const c = cmds.find((x) => x.id === id);
    if (c && !seen.has(c)) { recent.push(c); seen.add(c); }
  }
  return {
    ordered: [...recent, ...cmds.filter((c) => !seen.has(c))],
    recentCount: recent.length,
  };
}

/**
 * Remember an invocation. Fire-and-forget: a lost MRU write costs one
 * reordering, so a storage hiccup must never surface at the user. The
 * 'fallback' row (no-match → search mail) is a phrase, not a command, and
 * recording it would teach the MRU a key that resolves to nothing.
 */
function recordRecent(id) {
  if (!id || id === 'fallback') return;
  const next = [
    id,
    ...parseRecents(settings.get('paletteRecents')).filter((x) => x !== id),
  ].slice(0, RECENTS_MAX);
  settings.set('paletteRecents', JSON.stringify(next)).catch(() => {});
}

/**
 * Build the command list.
 *
 * Commands are rebuilt on open rather than cached, because half of them depend
 * on current state -- there is no "Archive" if nothing is selected, and
 * offering a command that then does nothing is worse than not offering it.
 */
function buildCommands(ctx) {
  const sel = ctx.state.selected;
  const cmds = [
    { id: 'compose', icon: 'compose', label: 'Compose new message', hint: 'c', run: () => openCompose(ctx) },
    { id: 'refresh', icon: 'refresh', label: 'Refresh inbox', hint: 'r', run: () => ctx.refresh() },
    /*
     * 65/f: Undo is the one command that CAN be offered while inert — an
     * empty undo stack used to invoke, do nothing, and say nothing. Now the
     * row stays but is disabled WITH the reason ("Nothing to undo" replaces
     * the shortcut where it sits), because an offered command that silently
     * no-ops teaches the user the palette lies. Selection-gated commands
     * still vanish whole — they were never state-ambiguous, just absent.
     */
    { id: 'undo', icon: 'back', label: 'Undo last action', hint: 'ctrl+z',
      disabled: undoStack.peek() ? '' : 'Nothing to undo',
      run: () => performUndo(ctx) },
    { id: 'search', icon: 'search', label: 'Search mail', hint: '/', run: () => $('search')?.focus() },
    { id: 'gmail', icon: 'back', label: 'Back to Gmail', hint: 'esc', run: () => ctx.release() },
    { id: 'shortcuts', icon: 'keyboard', label: 'Show keyboard shortcuts', hint: '?', run: () => ctx.toggleHelp?.() },
    { id: 'settings', icon: 'settings', label: 'Open settings', hint: '', run: () => ctx.openSettings?.() },
    { id: 'activity', icon: 'clock', label: 'Activity log', hint: '', run: () => ctx.openActivityLog?.() },
  ];

  if (sel) {
    cmds.unshift(
      { id: 'reply', icon: 'reply', label: 'Reply', hint: 'shift+r', run: () => startReply(ctx, 'reply') },
      { id: 'replyAll', icon: 'reply', label: 'Reply all', hint: 'shift+a', run: () => startReply(ctx, 'replyAll') },
      { id: 'forward', icon: 'reply', label: 'Forward', hint: 'shift+f', run: () => startReply(ctx, 'forward') },
      { id: 'archive', icon: 'archive', label: 'Archive this message', hint: 'e', run: () => ctx.act('archive', sel) },
      { id: 'star', icon: 'star', label: 'Star / unstar', hint: 's', run: () => ctx.act('star', sel) },
      { id: 'unread', icon: 'mail', label: 'Mark unread', hint: 'u', run: () => ctx.act('unread', sel) }
    );
  }

  // Jumping to a category is the most common navigation and deserves to be
  // in the palette rather than only in the sidebar.
  for (const [key, label] of ctx.categoryList()) {
    cmds.push({
      id: `cat:${key}`,
      icon: 'mail',
      label: `Go to ${label}`,
      hint: 'category',
      run: () => ctx.selectCategory(key),
    });
  }

  for (const t of ctx.themes()) {
    cmds.push({ id: `theme:${t.id}`, icon: 'palette', label: `Theme: ${t.name}`, hint: 'theme', run: () => ctx.setTheme(t.id) });
  }

  // Search shortcuts, so the operator syntax is discoverable instead of
  // something you have to already know exists.
  for (const [q, label] of [
    ['is:unread', 'Filter: unread only'],
    ['is:starred', 'Filter: starred'],
    ['has:deadline', 'Filter: has a deadline'],
    ['is:overdue', 'Filter: overdue'],
    ['has:attachment', 'Filter: has attachment'],
  ]) {
    cmds.push({ id: `q:${q}`, icon: 'search', label, hint: q, run: () => ctx.runQuery(q) });
  }

  /*
   * THE USER'S OWN GMAIL LABELS, AS JUMP TARGETS.
   *
   * This is what finally makes `LIST_LABELS` reachable. The verb has existed
   * and been called by nothing across three audits, which is the worst of both
   * worlds -- maintained code, dead to the user, and a `label:` operator that
   * you could only use if you already knew your labels by heart.
   *
   * Read from a cache that a background refresh fills (see refreshLabels), NOT
   * fetched here: buildCommands runs synchronously on every keystroke-open,
   * and a palette that waits on the network is a palette that feels broken.
   * An empty cache simply contributes no commands, which degrades to exactly
   * the behaviour that existed before.
   */
  for (const l of knownLabels) {
    cmds.push({
      id: `label:${l.id}`,
      icon: 'mail',
      label: `Go to label: ${l.name}`,
      hint: 'label',
      run: () => ctx.runQuery(`label:${l.name}`),
    });
  }

  return cmds;
}

/*
 * The user's Gmail labels, newest fetch wins. Empty until the first refresh
 * succeeds, and left alone on failure -- a transient network error should not
 * make the commands vanish from under someone mid-session.
 */
let knownLabels = [];

/**
 * The label cache, for other surfaces that need it.
 *
 * Search suggestions offer `label:` values and must draw them from what the
 * mailbox actually has -- a suggestion that returns nothing reads as the
 * search being broken. Exposed as a reader rather than copied into main.js so
 * there stays one owner of the cache.
 */
export function labelNames() {
  return knownLabels.map((l) => l.name).filter(Boolean);
}

/** Test seam: seed the label cache directly, bypassing the network. */
export function _setLabels(list) {
  knownLabels = Array.isArray(list) ? list : [];
}

/**
 * Refresh the label cache in the background.
 *
 * Deliberately fire-and-forget and deliberately silent. Labels are a
 * convenience in the palette, so a failure here must not raise a toast, block
 * boot, or leave a spinner running -- the palette just carries five fewer
 * commands, which nobody will notice.
 */
export async function refreshLabels(ctx) {
  try {
    const list = await ctx.send('LIST_LABELS');
    if (Array.isArray(list)) knownLabels = list.filter((l) => l && l.name);
  } catch {
    // Keep whatever we already had.
  }
}

/** Subsequence match, the behaviour every command palette has trained users on. */
function fuzzyScore(needle, hay) {
  if (!needle) return 1;
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  if (h.includes(n)) return 100 - h.indexOf(n); // contiguous beats scattered
  let i = 0;
  let score = 0;
  for (const ch of h) {
    if (ch === n[i]) {
      i++;
      score += 1;
      if (i === n.length) return score;
    }
  }
  return 0;
}

function renderPalette() {
  const list = $('palette-list');
  if (!list) return;
  const frag = document.createDocumentFragment();
  paletteFiltered.forEach((c, i) => {
    /*
     * Group labels exist only around an UNTYPED listing's recents: a typed
     * query is one ranked answer set, not sections, so separators appear
     * exactly when paletteRecentCount is non-zero and never mid-fuzzy.
     * role=presentation — the listbox's options stay the only children a
     * screen reader counts.
     */
    if (paletteRecentCount > 0 && (i === 0 || i === paletteRecentCount)) {
      const sep = document.createElement('li');
      sep.className = 'palette-sep';
      sep.setAttribute('role', 'presentation');
      sep.textContent = i === 0 ? 'Recent' : 'Everything';
      frag.appendChild(sep);
    }
    const li = document.createElement('li');
    li.className = 'palette-item' + (i === paletteIndex ? ' active' : '');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === paletteIndex));
    li.dataset.index = String(i);

    // An icon per command turns a wall of text into something scannable --
    // the eye finds a shape far faster than it reads a word.
    const ico = document.createElement('span');
    ico.className = 'palette-icon';
    ico.appendChild(icon(c.icon || 'palette', { size: 15 }));

    const label = document.createElement('span');
    label.className = 'palette-label';
    label.textContent = c.label;

    const hint = document.createElement('kbd');
    hint.className = 'palette-hint-key';
    /*
     * A disabled command states its reason IN the shortcut slot (65/f) —
     * the truth lives exactly where the affordance would. aria-disabled,
     * not the attribute: the row must stay discoverable to arrows/screen
     * readers, merely non-runnable.
     */
    if (c.disabled) {
      li.classList.add('disabled');
      li.setAttribute('aria-disabled', 'true');
      hint.textContent = c.disabled;
    } else {
      hint.textContent = c.hint || '';
    }

    li.append(ico, label, hint);
    frag.appendChild(li);
  });

  /*
   * NO MATCHES IS A STATE, NOT AN ABSENCE.
   *
   * Typing an unmatched string used to leave the list blank while the input
   * stayed focused: the palette did not close, did not explain, and offered no
   * way forward. That is worse than an ordinary empty list because the palette
   * is modal and keyboard-driven -- the user has committed to a flow and
   * received no signal about whether they mistyped or the command does not
   * exist.
   *
   * The row is not merely an apology. `ctx.runQuery` already exists and the
   * palette already knows the string, so the dead end becomes the thing the
   * user probably wanted: search the mail for it. Rendered as a real
   * `.palette-item` so Enter and click both reach it through the existing
   * handlers rather than needing a special case.
   */
  if (paletteFiltered.length === 0) {
    const q = paletteQuery.trim();
    const li = document.createElement('li');
    li.className = 'palette-item palette-empty active';
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'true');
    li.dataset.index = '0';

    const ico = document.createElement('span');
    ico.className = 'palette-icon';
    ico.appendChild(icon(q ? 'search' : 'palette', { size: 15 }));

    const label = document.createElement('span');
    label.className = 'palette-label';
    label.textContent = q ? `No command matches “${q}” — search mail instead` : 'No commands available';

    li.append(ico, label);
    frag.appendChild(li);

    // Make Enter and click work through the paths that already exist.
    paletteFiltered = q ? [{ id: 'fallback', label, run: () => ctx.runQuery(q) }] : [];
    paletteRecentCount = 0;
    paletteIndex = 0;
  }

  list.replaceChildren(frag);
}

function filterPalette(q) {
  paletteQuery = q;
  if (q.trim()) {
    /*
     * Typed intent outranks habit (65/f): fuzzy ranking only, no recents
     * injected — the user has SAID what they want, and reordering it toward
     * what they did yesterday would be second-guessing an explicit act.
     */
    paletteFiltered = paletteCommands
      .map((c) => ({ c, s: fuzzyScore(q, c.label) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 12)
      .map((x) => x.c);
    paletteRecentCount = 0;
  } else {
    const { ordered, recentCount } = orderForEmptyQuery(
      paletteCommands, parseRecents(settings.get('paletteRecents'))
    );
    paletteFiltered = ordered.slice(0, 12);
    paletteRecentCount = Math.min(recentCount, paletteFiltered.length);
  }
  /*
   * Land on the first RUNNABLE row. A recent Undo with a since-emptied
   * stack is exactly the case where the first row cannot run; starting the
   * highlight there would make Enter look broken.
   */
  paletteIndex = Math.max(0, paletteFiltered.findIndex((c) => !c.disabled));
  renderPalette();
}

/** The open palette layer, or null. */
let paletteLayer = null;

export function openPalette(ctx) {
  const box = $('palette');
  const input = $('palette-input');
  if (!box || !input || paletteLayer) return;
  paletteCommands = buildCommands(ctx);
  input.value = '';
  filterPalette('');
  // Strip any half-finished exit before showing, or a re-open during the
  // 140ms close leaves `.closing` on and the panel animates straight back out.
  cancelExit(box);
  box.hidden = false;
  /*
   * The palette is a dismissable overlay, so it belongs on the layer stack
   * like the other four. It was initially left off, which broke the Escape
   * chain: the global handler popped the stack, found nothing, and fell
   * through to the surfaces BELOW the palette.
   */
  paletteLayer = openLayer({
    name: 'palette',
    node: box,
    onClose: () => {
      closeWithMotion(box);
      paletteLayer = null;
      cameraPop(); // scene returns to the surface plane (P4 pairing)
    },
  });
  cameraPush(); // the backdrop recedes while the palette owns the eye (P4)
  input.focus();
}

export function closePalette() {
  // Idempotent, and safe to call when the palette was never opened (the
  // shell's Escape path and several command handlers both call it).
  if (paletteLayer) paletteLayer.close();
  else {
    closeWithMotion($('palette'));
  }
}

export function wirePalette(ctx) {
  const box = $('palette');
  const input = $('palette-input');
  const list = $('palette-list');
  if (!box || !input || !list) return;

  input.addEventListener('input', () => filterPalette(input.value));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!paletteFiltered.length) return;
      /*
       * Disabled rows are skipped, not merely unclickable (65/f): focus
       * landing on a row that cannot run would make the next Enter feel
       * broken. The walk is bounded, so a hypothetical all-disabled list
       * settles instead of spinning.
       */
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      let next = paletteIndex;
      for (let step = 0; step < paletteFiltered.length; step++) {
        next = (next + dir + paletteFiltered.length) % paletteFiltered.length;
        if (!paletteFiltered[next].disabled) break;
      }
      paletteIndex = next;
      renderPalette();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = paletteFiltered[paletteIndex];
      // A disabled row is a statement, not a button: Enter leaves the
      // palette OPEN, so the reason stays on screen instead of vanishing.
      if (!cmd || cmd.disabled) return;
      closePalette();
      recordRecent(cmd.id);
      cmd.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
    }
  });

  list.addEventListener('click', (e) => {
    const li = e.target.closest('.palette-item');
    if (!li) return;
    const cmd = paletteFiltered[Number(li.dataset.index)];
    if (!cmd || cmd.disabled) return;
    closePalette();
    recordRecent(cmd.id);
    cmd.run();
  });

  // Clicking the backdrop closes; clicking the box must not.
  box.addEventListener('click', (e) => {
    if (e.target === box) closePalette();
  });
}

/**
 * Test seam: drop this module's state (palette command list, filter and layer).
 *
 * Module state outlives a jsdom boot -- only main.js is re-imported with a
 * cache-busting URL -- so it would otherwise point at a torn-down document.
 * Each module resets its OWN state rather than one function reaching into
 * four files' internals.
 */
function _resetPalette() {
  paletteCommands = [];
  paletteFiltered = [];
  paletteIndex = 0;
  paletteQuery = '';
  paletteRecentCount = 0;
  knownLabels = [];
  // Close through the layer, not by nulling: the layer stack holds its own
  // reference, and an orphan there breaks the Escape chain.
  if (paletteLayer) {
    try { paletteLayer.close(); } catch { /* already gone */ }
  }
  paletteLayer = null;
}

// Self-registered test seam (reset-registry): this used to ride the
// features.js barrel's composite 'features' entry; the barrel is dissolved
// (S2) and each module registers its own reset, like list/bulk/menu already do.
registerReset('palette', _resetPalette);
