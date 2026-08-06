/**
 * Feature layer: command palette, compose, deadline radar, undo, multi-select.
 *
 * A SEPARATE MODULE ON PURPOSE. `app.js` is already the file every change
 * touches, and the architecture audit flagged it as the most likely place for
 * the coupling that made v1 slow to creep back. These features talk to the
 * app through an explicit `ctx` object rather than reaching into its
 * internals, so the render invariant stays enforceable in one place.
 *
 * @typedef {Object} Ctx
 * @property {import('./store.js').Store} store
 * @property {(type:string, extra?:object)=>Promise<any>} send
 * @property {(text:string)=>void} toast
 * @property {(id:string)=>void} openMessage
 * @property {()=>void} rerender
 * @property {object} state
 */

import { relativeLabel, urgency } from './deadlines.js';
import { buildReply } from './query.js';
import { UndoStack } from './undo.js';
import { icon } from './icons.js';
import { createDraftSaver, loadDraft, isMeaningful } from './draft-store.js';
import * as settings from './settings.js';
import { openLayer } from './layers.js';
import {
  buildContacts, matchContacts, currentFragment, completeValue, invalidAddresses,
} from './contacts.js';

const $ = (id) => document.getElementById(id);

/* ========================================================================== *
 * UNDO
 * ========================================================================== */

export const undoStack = new UndoStack();

/**
 * Wrap a destructive action so it can be reversed.
 *
 * Gmail can only undo a send. Because every action here already applies
 * optimistically to the local store, the reversal is instant on screen and the
 * network call is the part nobody waits for.
 */
export function recordUndo(ctx, label, undoFn) {
  undoStack.push(label, undoFn);
  /*
   * The single best reason to prefer this over Gmail used to be communicated
   * as a text SUFFIX: "Archived · Ctrl+Z to undo". A real button is what
   * people reach for in the half-second after a mistake, and the `undo` kind
   * gives the toast a drain line so the window is visible rather than guessed.
   *
   * The keyboard path is unchanged and still works for five minutes — far
   * longer than the toast. The `?` overlay says so.
   */
  ctx.toast(label, {
    kind: 'undo',
    action: { label: 'Undo', run: () => performUndo(ctx) },
  });
}

export async function performUndo(ctx) {
  try {
    const label = await undoStack.undo();
    if (!label) {
      ctx.toast('Nothing to undo', { kind: 'info' });
      return;
    }
    ctx.toast(`Undid: ${label}`, { kind: 'success' });
  } catch (err) {
    ctx.toast(err.message);
  }
}

/* ========================================================================== *
 * DEADLINE RADAR
 * ========================================================================== */

const RADAR_MAX = 6;

/**
 * Render the "due soon" list.
 *
 * Only overdue / today / soon / week are shown. A deadline three weeks out is
 * true but not actionable, and padding the list with those is how a useful
 * panel becomes decoration people stop reading.
 */
export function renderRadar(ctx) {
  const wrap = $('radar');
  const list = $('radar-list');
  if (!wrap || !list) return;

  const now = Date.now();
  const items = [];
  for (const id of ctx.store.idsFor('all')) {
    const m = ctx.store.get(id);
    if (!m?.dueAt) continue;
    const u = urgency(m.dueAt, now);
    if (u === 'later') continue;
    items.push({ m, u });
  }

  if (items.length === 0) {
    wrap.hidden = true;
    list.replaceChildren();
    return;
  }

  items.sort((a, b) => a.m.dueAt - b.m.dueAt);

  const frag = document.createDocumentFragment();
  for (const { m, u } of items.slice(0, RADAR_MAX)) {
    const li = document.createElement('li');
    li.className = `radar-item radar-${u}`;
    li.dataset.id = m.id;
    li.setAttribute('role', 'button');
    li.tabIndex = 0;

    const when = document.createElement('span');
    when.className = 'radar-when';
    when.textContent = relativeLabel(m.dueAt, now);

    const what = document.createElement('span');
    what.className = 'radar-what';
    what.textContent = m.subject;
    what.title = m.subject;

    li.append(when, what);
    frag.appendChild(li);
  }
  list.replaceChildren(frag);
  wrap.hidden = false;
}

export function wireRadar(ctx) {
  const list = $('radar-list');
  if (!list) return;
  const open = (e) => {
    const li = e.target.closest('.radar-item');
    if (li) ctx.openMessage(li.dataset.id);
  };
  list.addEventListener('click', open);
  list.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open(e);
    }
  });
}

/* ========================================================================== *
 * COMMAND PALETTE
 * ========================================================================== */

let paletteCommands = [];
let paletteFiltered = [];
let paletteIndex = 0;

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
    { id: 'undo', icon: 'back', label: 'Undo last action', hint: 'ctrl+z', run: () => performUndo(ctx) },
    { id: 'search', icon: 'search', label: 'Search mail', hint: '/', run: () => $('search')?.focus() },
    { id: 'gmail', icon: 'back', label: 'Back to Gmail', hint: 'esc', run: () => ctx.release() },
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

  return cmds;
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
    hint.textContent = c.hint || '';

    li.append(ico, label, hint);
    frag.appendChild(li);
  });
  list.replaceChildren(frag);
}

function filterPalette(q) {
  paletteFiltered = paletteCommands
    .map((c) => ({ c, s: fuzzyScore(q, c.label) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 12)
    .map((x) => x.c);
  paletteIndex = 0;
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
      box.hidden = true;
      paletteLayer = null;
    },
  });
  input.focus();
}

export function closePalette() {
  // Idempotent, and safe to call when the palette was never opened (the
  // shell's Escape path and several command handlers both call it).
  if (paletteLayer) paletteLayer.close();
  else {
    const box = $('palette');
    if (box) box.hidden = true;
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
      paletteIndex =
        (paletteIndex + (e.key === 'ArrowDown' ? 1 : -1) + paletteFiltered.length) %
        paletteFiltered.length;
      renderPalette();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = paletteFiltered[paletteIndex];
      closePalette();
      cmd?.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
    }
  });

  list.addEventListener('click', (e) => {
    const li = e.target.closest('.palette-item');
    if (!li) return;
    const cmd = paletteFiltered[Number(li.dataset.index)];
    closePalette();
    cmd?.run();
  });

  // Clicking the backdrop closes; clicking the box must not.
  box.addEventListener('click', (e) => {
    if (e.target === box) closePalette();
  });
}

/* ========================================================================== *
 * COMPOSE
 * ========================================================================== */

let composeCtx = null;
let composeMeta = {};

/**
 * Debounced local autosave. Created lazily on first compose so that a session
 * which never writes a message never touches storage.
 */
let draftSaver = null;

function ensureDraftSaver() {
  if (!draftSaver) draftSaver = createDraftSaver(collectDraft);
  return draftSaver;
}

export function openCompose(ctx, prefill = {}) {
  composeCtx = ctx;
  composeMeta = {
    threadId: prefill.threadId || '',
    inReplyTo: prefill.inReplyTo || '',
    references: prefill.references || '',
    // What the panel STARTED with. Used to tell "typed something" from "a
    // reply pre-filled a quoted original".
    baseBody: prefill.quoted ? `\n\n${prefill.quoted}` : '',
  };
  const panel = $('compose');
  if (!panel) return;

  $('compose-title').textContent = prefill.title || 'New message';
  $('c-to').value = prefill.to || '';
  $('c-cc').value = prefill.cc || '';
  $('c-subject').value = prefill.subject || '';

  /*
   * SIGNATURE.
   *
   * Inserted when the panel OPENS, not injected at send time. A signature the
   * user cannot see before sending is a signature they cannot edit, delete for
   * one message, or write above -- and the first they know of a mistake in it
   * is when it has gone out. Gmail does the same for the same reason.
   *
   * It goes ABOVE any quoted original, which is where a reply's signature
   * belongs.
   */
  const sig = settings.get('signature').trim();
  const sigBlock = sig ? `\n\n-- \n${sig}` : '';
  $('c-text').value = prefill.quoted
    ? `\n\n${sigBlock ? `${sigBlock}\n` : ''}${prefill.quoted}`
    : sigBlock;
  $('c-cc-row').hidden = !prefill.cc;
  $('c-status').textContent = '';

  // Rebuild the address book once per open, from mail already in the store.
  refreshContacts(ctx);

  panel.hidden = false;
  panel.classList.remove('minimised');
  // Focus the first EMPTY field: a reply already has a recipient and a
  // subject, so landing in "To" would make the user tab past both.
  (prefill.to ? $('c-text') : $('c-to')).focus();
  if (prefill.quoted) $('c-text').setSelectionRange(0, 0);
}

export function closeCompose() {
  const panel = $('compose');
  if (panel) panel.hidden = true;
  composeMeta = {};
}

/** Open compose pre-filled as a reply / reply-all / forward. */
export async function startReply(ctx, mode) {
  const id = ctx.state.selected;
  if (!id) return;
  try {
    const body = await ctx.send('GET_BODY', { id });
    const r = buildReply(body, ctx.state.email || '', mode);
    openCompose(ctx, {
      ...r,
      title: mode === 'forward' ? 'Forward' : mode === 'replyAll' ? 'Reply all' : 'Reply',
    });
  } catch (err) {
    ctx.toast(`Could not open reply: ${err.message}`);
  }
}

function collectDraft() {
  return {
    to: $('c-to').value.trim(),
    cc: $('c-cc').value.trim(),
    subject: $('c-subject').value.trim(),
    body: $('c-text').value,
    threadId: composeMeta.threadId,
    inReplyTo: composeMeta.inReplyTo,
    references: composeMeta.references,
    baseBody: composeMeta.baseBody || '',
    title: $('compose-title')?.textContent || 'New message',
  };
}

/**
 * Offer to restore a draft left over from a previous session.
 *
 * Deliberately NOT automatic. Silently reopening a compose panel on load is
 * startling, and if the user already sent that message from their phone the
 * restored copy is worse than useless. So: ask, once, and take a "no" as
 * permission to forget it.
 */
export async function restoreDraftIfAny(ctx) {
  const d = await loadDraft();
  if (!d || !isMeaningful(d)) return false;

  const who = d.to ? ` to ${d.to}` : '';
  const what = d.subject ? ` "${d.subject}"` : '';
  if (!confirm(`Restore your unsent message${what}${who}?`)) {
    await ensureDraftSaver().discard();
    return false;
  }

  openCompose(ctx, {
    to: d.to,
    cc: d.cc,
    subject: d.subject,
    title: d.title || 'Restored draft',
    threadId: d.threadId,
    inReplyTo: d.inReplyTo,
    references: d.references,
  });
  // Body is set directly: openCompose's `quoted` path would re-wrap it.
  $('c-text').value = d.body || '';
  composeMeta.baseBody = d.baseBody || '';
  setStatus('Restored from your last session', 'ok');
  return true;
}

/** Flush any pending draft write. Called on pagehide, where timers never run. */
export function flushDraft() {
  return draftSaver ? draftSaver.flush() : Promise.resolve(false);
}

export function wireCompose(ctx) {
  const panel = $('compose');
  if (!panel) return;

  $('compose-close').addEventListener('click', async () => {
    const d = collectDraft();
    // Only warn if something was actually typed. A confirm() on an untouched
    // panel is the kind of friction that makes people avoid the feature.
    if (isMeaningful(d) && !confirm('Discard this message?')) return;
    // An explicit discard means the crash-recovery copy must go too, or the
    // user is offered back the message they just chose to throw away.
    await ensureDraftSaver().discard();
    closeCompose();
  });

  /*
   * AUTOSAVE. One listener on the panel catches every field by delegation,
   * so adding a field later cannot forget to be saved.
   */
  panel.addEventListener('input', () => ensureDraftSaver().schedule());

  wireAutocomplete('c-to', 'c-to-list');
  wireAutocomplete('c-cc', 'c-cc-list');

  $('compose-min').addEventListener('click', () => panel.classList.toggle('minimised'));
  $('c-cc-toggle').addEventListener('click', () => {
    const row = $('c-cc-row');
    row.hidden = !row.hidden;
    if (!row.hidden) $('c-cc').focus();
  });

  $('c-send').addEventListener('click', () => doSend(ctx));
  $('c-draft').addEventListener('click', () => doDraft(ctx));

  // Ctrl+Enter sends, which is the convention in every mail client.
  panel.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      doSend(ctx);
    } else if (e.key === 'Escape') {
      e.stopPropagation(); // do not also release the takeover
      $('compose-close').click();
    }
  });
}

async function doSend(ctx) {
  const draft = collectDraft();
  if (!draft.to) {
    setStatus('Add a recipient.', 'err');
    $('c-to').focus();
    return;
  }

  /*
   * WARN, DO NOT BLOCK.
   *
   * A typo'd address is the most common way mail silently fails, but address
   * syntax is genuinely permissive and a client that refuses to send to
   * something it does not recognise is worse than one that asks. So: name the
   * suspect address and let the user decide.
   */
  const bad = [...invalidAddresses(draft.to), ...invalidAddresses(draft.cc)];
  if (bad.length) {
    const list = bad.join(', ');
    if (!confirm(`This does not look like an email address:\n\n${list}\n\nSend anyway?`)) {
      setStatus(`Check the address: ${list}`, 'err');
      $('c-to').focus();
      return;
    }
  }
  const btn = $('c-send');
  btn.disabled = true;
  setStatus('Sending…', '');
  try {
    await ctx.send('SEND', { draft });
    // Clear the recovery copy only AFTER the send is confirmed. Clearing
    // first and then failing would destroy the message.
    await ensureDraftSaver().discard();
    closeCompose();
    ctx.toast(`Sent to ${draft.to.split(',')[0].trim()}`, { kind: 'success' });
  } catch (err) {
    setStatus(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function doDraft(ctx) {
  const draft = collectDraft();
  setStatus('Saving…', '');
  try {
    await ctx.send('SAVE_DRAFT', { draft });
    // Saved to Gmail: the durable tier now has it, so the local crash copy is
    // redundant.
    await ensureDraftSaver().discard();
    // Success reads as success. A confirmation in the same grey as a hint is
    // indistinguishable from nothing having happened.
    setStatus('Draft saved to Gmail', 'ok');
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

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

function refreshContacts(ctx) {
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
function wireAutocomplete(inputId, listId) {
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

/** Compose status line, colour-coded by outcome. */
function setStatus(text, kind) {
  const el = $('c-status');
  if (!el) return;
  el.textContent = text;
  el.dataset.kind = kind || '';
}
