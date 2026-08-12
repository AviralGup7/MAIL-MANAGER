/**
 * The Reader — the Mail workspace's reading pane.
 *
 * RESPONSIBILITY  Show ONE conversation: head, tags, deadline and timetable
 *                 banners, thread strip, sandboxed body iframe, attachments,
 *                 remote-image policy, mark-read timing, reading position.
 * OWNS            the #reader / #reader-empty subtree; bodyToken, lastBody,
 *                 markReadTimer, openPart, imageAllowList, readPosition.
 * DOES NOT OWN    the message list (patchRow/reorientTo/rowDomId belong to
 *                 the shell), triage verbs (act), the snooze/follow-up/
 *                 deadline menus, selection, sidebar, sync.
 * DEPENDS ON      injected ctx (see wireReader) + pure module imports.
 *
 * Extracted per the round-46 modularity map's move #1 and the round-51
 * workspace architecture map: an agent editing the reader now holds this
 * file and a contract instead of the whole shell. Everything shared with
 * the shell crosses the ctx seam; nothing here imports app.js.
 */

import { Store } from './store.js';
import { sanitizeHtml, escapeHtml } from './sanitize.js';
import { getTheme } from './themes.js';
import { icon, middleTruncate } from './icons.js';
import { setAttr } from './dom.js';
import * as settings from './settings.js';
import { addressOf } from './contacts.js';
import { relativeLabel, urgency } from './deadlines.js';
import { timetableEffectsOf } from './timetable-ui.js';
import { CATEGORY_LABELS } from '../classify/categories.js';
import { actionsFor } from './mailboxes.js';
import { READER_TYPOGRAPHY, readerCsp } from './reader-frame.js';
import { overlayGet } from './server-search.js';
import { toast } from './toast.js';
import { openSnoozeMenu } from './snooze-menu.js';
import {
  CAT_COLOR, LOW_CONFIDENCE, displayName, shortDate, fullDate,
} from './display.js';
import { STORAGE } from '../platform/storage.js';

const $ = (id) => document.getElementById(id);

/*
 * Set by wireReader at boot. `storeOf` is a GETTER — the shell rebinds its
 * active store on every mailbox switch, so capturing the store by value here
 * would repeat the exact ctx bug documented in app.js.
 */
let ctx = null;
let el = null;
let state = null;
let storeOf = null;
let send = null;

/**
 * Wire the reader to the shell. Called once, at boot, before anything can
 * open or close the pane.
 *
 * @param {Object} c
 * @param {()=>import('./store.js').Store} c.store   live store getter
 * @param {Object} c.state        shared app state (selected, mailbox, theme)
 * @param {Object} c.el           cached DOM map
 * @param {Function} c.send       worker bridge
 * @param {(id:string)=>void} c.patchRow        repaint one list row
 * @param {(id:string)=>void} c.reorientTo      scroll the list back to a row
 * @param {(id:string)=>string} c.rowDomId      row element id
 * @param {(m:?Object)=>void} c.syncContextActions
 * @param {(msg:Object, anchor:Element)=>void} c.openRecategoriseMenu
 * @param {(verb:string, id:string)=>void} c.act
 * @param {(id:string, anchor:Element)=>void} c.followupMenu
 * @param {(id:string, anchor:Element)=>void} c.deadlineMenu
 * @param {(threadId:string, mailbox?:string)=>string} c.gmailUrl
 */
export function wireReader(c) {
  ctx = c;
  el = c.el;
  state = c.state;
  // WRAP, DO NOT RESOLVE. `c.store` is a getter onto the shell's live store
  // binding; evaluating it here would capture TODAY's store and survive a
  // mailbox switch. Re-reading it per call is the whole point of the getter.
  storeOf = () => c.store;
  send = c.send;

  el.reader.addEventListener('animationend', () => el.reader.classList.remove('swap'));

  /*
   * The conversation strip. Delegated, because the strip is rebuilt whenever
   * the open message changes and per-button listeners would leak with it.
   */
  el.rThread?.addEventListener('click', (e) => {
    const part = e.target.closest('.r-msg');
    if (part?.dataset.id) openThreadPart(part.dataset.id);
  });

  el.rAttachments.addEventListener('click', (e) => {
    const chip = e.target.closest('.att-chip');
    if (chip) downloadAttachment(chip);
  });

  $('r-actions').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b || !state.selected) return;
    // Snooze opens a picker instead of acting immediately, so it is not an
    // `act()` verb.
    if (b.dataset.act === 'snooze') {
      openSnoozeMenu(state.selected, b);
      return;
    }
    // Like snooze, these open a picker rather than acting immediately.
    if (b.dataset.act === 'followup') {
      ctx.followupMenu(state.selected, b);
      return;
    }
    if (b.dataset.act === 'deadline') {
      ctx.deadlineMenu(state.selected, b);
      return;
    }
    ctx.act(b.dataset.act, state.selected);
  });
}

// ------------------------------------------------------------------ state --

let bodyToken = 0;
/** The last body fetched, kept so a theme change can re-render it. */
let lastBody = null;
/** Pending "mark read" for the open message. Cancelled if the user moves on. */
let markReadTimer = 0;
/** When the last reader swap ran; a faster step skips the animation. */
let lastSwapAt = 0;

/**
 * Say what this message did to the timetable, if anything.
 *
 * THE LINK RUNS BOTH WAYS NOW. An entry could always name the message that
 * changed it; this is the direction a user actually asks in -- a room change
 * is open in front of them and the question is "has this already been applied,
 * or am I about to walk to the wrong room?"
 *
 * Hidden unless there is something to say. Almost no message changes the
 * timetable, and a permanently-present "no timetable changes" line would be
 * noise on every single mail to save a glance on one.
 */
/**
 * The open message's own deadline.
 *
 * WHY THIS EXISTS
 * ---------------
 * `extractDeadline` runs on every ingest and writes `dueAt`/`dueKind`/
 * `dueText` onto the message. Until now the ONLY consumer was the sidebar
 * radar, which shows the six most urgent. A message with a deadline outside
 * that top six had one the product knew about, had parsed, had cached -- and
 * never mentioned. Including on the one screen where the user is definitely
 * looking at that exact message.
 *
 * It deliberately reuses `relativeLabel` and `urgency`, the radar's own
 * functions, rather than formatting a date here. Two surfaces describing one
 * date in two different vocabularies is precisely the drift audit 15 was
 * about: "due tomorrow" in the rail and "12 Aug" in the reader would read as
 * two different facts.
 *
 * The quoted phrase is the same trick the radar item plays in its tooltip --
 * it turns "how did it know that?" into "of course, it read the line". Here
 * it is on the surface rather than in a title, because the reader has the
 * width for it and a tooltip is not reachable by touch or keyboard.
 */
/**
 * The reader's tag row: category, confidence (only when it matters), and the
 * correction affordance. Extracted from openMessage so a reclassification can
 * refresh the OPEN message in place — the message re-files itself the moment
 * the user picks a category, no reopen needed (round 61, P-1).
 *
 * The classifier's own confidence is DIAGNOSTIC, not something a reader needs
 * on every message. It is shown only when the classifier is unsure, or when a
 * human overrode it -- the two cases where "why is this here?" is a real
 * question. On a confident rule match it is noise competing with the subject.
 */
export function renderReaderTags(m) {
  const confident = (m.confidence ?? 1) >= LOW_CONFIDENCE && m.source !== 'you';
  /*
   * The category tag doubles as the correction affordance.
   *
   * Putting "wrong category?" next to the category itself is the only place a
   * user looks when the category is wrong. A separate control elsewhere in the
   * toolbar would be a second thing to find.
   */
  const recat = document.createElement('button');
  recat.id = 'r-recat';
  recat.type = 'button';
  recat.className = 'ghost small';
  recat.textContent = 'Wrong category?';
  recat.title = `File mail from ${displayName(m.from)} somewhere else`;
  recat.addEventListener('click', () => {
    const msg = storeOf().get(state.selected);
    if (msg) ctx.openRecategoriseMenu(msg, recat);
  });

  el.rTags.replaceChildren(
    tagNode(CATEGORY_LABELS[m.category] || m.category, CAT_COLOR[m.category]),
    ...(confident
      ? []
      : [tagNode(`${Math.round((m.confidence ?? 1) * 100)}% · ${m.source || 'rule'}`)]),
    ...(m.reason && !confident ? [tagNode(m.reason)] : []),
    recat
  );
}

function renderMessageDeadline(m) {
  const box = el.rDue;
  if (!box) return;

  if (!m || !m.dueAt) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }

  const now = Date.now();
  const band = urgency(m.dueAt, now);

  const when = document.createElement('span');
  when.className = 'r-due-when';
  // Capitalised because it opens the line: "Due tomorrow", not "due tomorrow".
  const label = relativeLabel(m.dueAt, now);
  when.textContent = label.charAt(0).toUpperCase() + label.slice(1);

  const frag = document.createDocumentFragment();
  frag.appendChild(when);

  /*
   * The evidence. `dueText` is the phrase the parser matched, so quoting it
   * lets the user judge whether the machine read the mail correctly -- which
   * matters, because a wrong deadline is worse than no deadline.
   */
  if (m.dueText) {
    const from = document.createElement('span');
    from.className = 'r-due-from';
    from.textContent = `Read from: “${m.dueText}”`;
    frag.appendChild(from);
  }

  box.className = `r-due r-due-${band}`;
  box.replaceChildren(frag);
  box.hidden = false;
}

function renderTimetableEffects(id) {
  const box = el.rTimetable;
  if (!box) return;

  let effects = [];
  try {
    effects = timetableEffectsOf(id);
  } catch {
    // The timetable is optional; the reader is not. A failure here must cost
    // the banner and nothing else.
    effects = [];
  }

  if (!effects.length) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }

  const frag = document.createDocumentFragment();
  for (const { entry, fields, current, previous } of effects) {
    const line = document.createElement('div');
    line.className = 'r-tt-line';

    const what = document.createElement('strong');
    what.textContent = `${entry.courseNo} ${entry.section}`;

    const detail = document.createElement('span');
    // "room 5105 → 6104" reads as a change; "room 6104" alone does not say
    // that anything moved, which is the only reason the banner exists.
    detail.textContent = previous
      ? ` · ${fields.join(' and ')} ${previous} → ${current}`
      : ` · ${fields.join(' and ')} set to ${current}`;

    line.append(what, detail);
    frag.appendChild(line);
  }

  const head = document.createElement('div');
  head.className = 'r-tt-head';
  head.textContent = 'Applied to your timetable';

  box.replaceChildren(head, frag);
  box.hidden = false;
}



/**
 * Load one message of the open conversation into the reader.
 *
 * Shares the body path with openMessage rather than duplicating it: same
 * token guard against a stale response, same inline-image prefetch, same
 * mark-read grace period. Duplicating that logic is how two readers drift.
 */
/**
 * Fetch and paint ONE message body into the reader frame.
 *
 * Extracted from openMessage so the conversation strip can reuse it verbatim.
 * Both paths need the same stale-response token, the same inline-image
 * prefetch and the same mark-read grace period; two copies of that is how two
 * readers drift apart.
 */
async function loadBody(id) {
  const token = ++bodyToken;
  el.rLoading.hidden = false;
  el.rBody.srcdoc = '';
  try {
    const body = await send('GET_BODY', { id });
    if (token !== bodyToken) return; // user moved on; drop the stale response

    /*
     * Inline images are fetched BEFORE the first paint of the body.
     *
     * Painting without them and substituting afterwards would reflow the
     * message under the reader's eyes, which is worse than a marginally later
     * paint -- and these parts come from the message we have already fetched,
     * so the extra round trip is small and predictable.
     */
    if (body.inline?.length) {
      try {
        const res = await send('GET_INLINE', { messageId: id, parts: body.inline });
        if (token !== bodyToken) return;
        body.inlineData = res.inline || [];
      } catch {
        body.inlineData = []; // placeholders rather than a failed message
      }
    }

    lastBody = body;
    renderAttachments(body);
    renderBodyInto(body);
  } catch (err) {
    if (token !== bodyToken) return;
    el.rBody.srcdoc = escapeDoc(`Could not load this message.\n\n${err.message}`);
  } finally {
    if (token === bodyToken) el.rLoading.hidden = true;
  }
}


async function openThreadPart(id) {
  const m = storeOf().get(id);
  if (!m || openPart === id) return;
  openPart = id;
  renderThreadStrip(state.selected || id);
  await loadBody(id);
}

/* ------------------------------------------------------- conversation strip -- */

/*
 * Which message inside the open conversation is being shown.
 *
 * Separate from `state.selected`, which is the ROW -- the conversation. A row
 * stays selected while you move between the messages inside it, exactly as
 * selection and the open message were kept separate for multi-select.
 */
let openPart = null;

/**
 * Render the strip of messages in the open conversation.
 *
 * Oldest first: a conversation reads in the order it happened. Hidden entirely
 * for a single message, so the overwhelmingly common case keeps the reader it
 * always had.
 *
 * Exported because the shell's delta path re-renders the strip when a reply
 * lands while the conversation is open (LIVE THREAD STRIP, round 45 M6).
 *
 * @returns {string[]} the message ids in the conversation, oldest first
 */
export function renderThreadStrip(rootId) {
  const box = el.rThread;
  const m = storeOf().get(rootId);
  if (!box || !m) return [rootId];

  const conv = settings.get('threaded') ? storeOf().thread(Store.threadOf(m)) : null;
  if (!conv || conv.count < 2) {
    box.hidden = true;
    box.replaceChildren();
    return [rootId];
  }

  // `thread()` returns newest-first, like every other order in the store.
  const ids = [...conv.ids].reverse();

  const frag = document.createDocumentFragment();
  for (const id of ids) {
    const msg = storeOf().get(id);
    if (!msg) continue;

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'r-msg';
    row.dataset.id = id;
    row.setAttribute('role', 'listitem');
    // The strip is a set of alternatives, so the current one is pressed rather
    // than selected -- selection here would collide with the list's listbox.
    row.setAttribute('aria-pressed', String(id === openPart));
    row.classList.toggle('current', id === openPart);
    row.classList.toggle('unread', !!msg.unread);

    const who = document.createElement('span');
    who.className = 'r-msg-from';
    who.textContent = displayName(msg.from);

    const when = document.createElement('span');
    when.className = 'r-msg-date';
    when.textContent = shortDate(msg.date);
    setAttr(when, 'title', fullDate(msg.date));

    const peek = document.createElement('span');
    peek.className = 'r-msg-snip';
    peek.textContent = msg.snippet || '';

    row.append(who, when, peek);
    row.title = `${msg.from} · ${fullDate(msg.date)}`;
    // A pressed/not-pressed state is not a name; name the alternative so a
    // screen reader can tell the conversation's messages apart (round 48).
    row.setAttribute('aria-label', `${displayName(msg.from)}, ${fullDate(msg.date)}`);
    frag.appendChild(row);
  }

  box.replaceChildren(frag);
  box.hidden = false;
  return ids;
}

export async function openMessage(id) {
  const m = storeOf().get(id) || overlayGet(id);
  if (!m) return;

  const prev = state.selected;
  state.selected = id;
  if (prev) ctx.patchRow(prev);
  ctx.patchRow(id);
  // Tell assistive tech which option is current. aria-selected on the row is
  // not enough on its own -- without this the listbox has no notion of a
  // focused child, so selection was written to the DOM and never announced.
  el.list.setAttribute('aria-activedescendant', ctx.rowDomId(id));
  ctx.syncContextActions(m);

  el.readerEmpty.hidden = true;
  el.reader.hidden = false;

  /*
   * SKIP THE SWAP WHEN THE USER IS MOVING FAST.
   *
   * The animation restarts on every open, so holding `j` produced a stack of
   * interrupted 200ms fades that never completed -- the reader flickered
   * instead of settling, which is the opposite of what the motion is for.
   *
   * The fix is not a longer or shorter animation. It is that a transition
   * explains a change the user is watching, and someone pressing `j` five
   * times is not watching -- they are scanning, and they want to ARRIVE. So a
   * step taken within one animation's length of the last one is instant, and a
   * deliberate single step still animates.
   *
   * `--dur-base` is 200ms; the threshold matches it, so the rule is exactly
   * "do not interrupt a swap that is still running".
   */
  const now = Date.now();
  const rapid = now - lastSwapAt < 200;
  lastSwapAt = now;

  el.reader.classList.remove('swap');
  if (!rapid) {
    void el.reader.offsetWidth; // reflow to reset the animation
    el.reader.classList.add('swap');
  }

  el.rSubject.textContent = m.subject;
  el.rFrom.textContent = m.from;
  el.rDate.textContent = fullDate(m.date);
  // The body frame must name what it shows; a titleless iframe is a blank to
  // a screen reader (round 48).
  el.rBody.setAttribute('title', m.subject);
  el.rBody.setAttribute('aria-label', `Message body: ${m.subject}`);
  /*
   * MAILBOX-AWARE (round 45 M1): the deep link lands where the message
   * LIVES. Snoozed has no Gmail fragment of its own, so it lands in All
   * Mail, where the message is actually reachable.
   */
  const urlMailbox = state.mailbox === 'snoozed' ? 'all' : state.mailbox;
  el.rOpen.href = ctx.gmailUrl(m.threadId, urlMailbox);

  renderReaderTags(m);

  renderMessageDeadline(m);
  renderTimetableEffects(id);

  /*
   * MARK READ, ON A DELAY.
   *
   * Unread is the one piece of triage state the user cannot reconstruct, and
   * a mis-click previously consumed it instantly. Waiting about a second means
   * arrowing past a message, or opening the wrong one and immediately leaving,
   * costs nothing. Gmail marks read almost immediately and is worse for it.
   *
   * The timer is cancelled by the same token that cancels the body fetch, so
   * moving on before it fires leaves the message unread.
   */
  clearTimeout(markReadTimer);
  if (m.unread && settings.get('markReadOnOpen')) {
    const delay = settings.get('markReadDelayMs');
    const markRead = () => {
      // Still looking at it?
      if (state.selected !== id) return;
      storeOf().patch(id, { unread: false });
      send('MARK_READ', { id }).catch(() => storeOf().patch(id, { unread: true }));
    };
    if (delay > 0) markReadTimer = setTimeout(markRead, delay);
    else markRead();
  }

  /*
   * The row is a conversation; the BODY shown is one message inside it.
   * Opening a conversation lands on its newest message, which is the one you
   * came to read -- the strip gives access to the rest.
   */
  openPart = id;
  renderThreadStrip(id);

  await loadBody(id);
}

/**
 * Attachment chips, rendered in the APP rather than the body iframe.
 *
 * The frame has no `allow-scripts`, so anything inside it can never respond to
 * a click. Attachments were a filename printed as text: named, visible, and
 * impossible to open. This is the only way they become actionable without
 * weakening the sandbox that protects against hostile mail.
 */
function renderAttachments(body) {
  const list = body.attachments || [];
  el.rAttachments.replaceChildren();
  el.rAttachments.hidden = list.length === 0;
  if (!list.length) return;

  for (const a of list) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'att-chip';
    chip.dataset.attachmentId = a.attachmentId;
    chip.dataset.filename = a.filename;
    chip.dataset.mime = a.mimeType || '';
    chip.dataset.size = String(a.size || 0);
    chip.title = `${a.filename} — ${formatBytes(a.size)}`;
    // title is not reliably read by screen readers; give the chip its own
    // name so a download control is never a nameless button (round 48).
    chip.setAttribute('aria-label', `Download ${a.filename}, ${formatBytes(a.size)}`);

    const name = document.createElement('span');
    name.className = 'att-name';
    // Middle-truncated so the extension survives; the chip's `title` above
    // carries the full name, so nothing is lost.
    name.textContent = middleTruncate(a.filename);

    const size = document.createElement('span');
    size.className = 'att-size';
    size.textContent = formatBytes(a.size);

    chip.append(icon('attachment', { size: 14 }), name, size);
    el.rAttachments.appendChild(chip);
  }
}

/** Human file size. Attachments are meaningless as a raw byte count. */
function formatBytes(n) {
  if (!n || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Download one attachment.
 *
 * The worker returns a data: URL because it has no DOM and therefore no
 * `URL.createObjectURL`. A synthetic anchor click is the only way to trigger a
 * download with a chosen filename from an extension page.
 */
async function downloadAttachment(chip) {
  const { attachmentId, filename, mime, size } = chip.dataset;
  if (!attachmentId || !state.selected) return;

  // C-15 / stress P11: the worker returns the whole attachment as a base64
  // data URL through the message channel. Past ~20MB that string is several
  // tens of megabytes across postMessage — it stalls the worker and the tab.
  // Gmail itself caps attachments at 25MB, so refuse the tail explicitly.
  const MAX_CHANNEL_BYTES = 20 * 1024 * 1024;
  const bytes = Number(size) || 0;
  if (bytes > MAX_CHANNEL_BYTES) {
    toast(`${filename} is ${formatBytes(bytes)} — too large to download in the takeover. Open it in Gmail instead.`, { kind: 'error' });
    return;
  }

  chip.disabled = true;
  chip.classList.add('loading');
  try {
    const { dataUrl } = await send('GET_ATTACHMENT', {
      messageId: state.selected,
      attachmentId,
      mimeType: mime,
    });
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename || 'attachment';
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(`Downloaded ${filename}`, { kind: 'success' });
  } catch (err) {
    toast(`Could not download: ${err.message}`, { kind: 'error' });
  } finally {
    chip.disabled = false;
    chip.classList.remove('loading');
  }
}

function tagNode(text, color) {
  const s = document.createElement('span');
  s.className = 'tag';
  s.textContent = text;
  if (color) s.style.borderColor = color;
  return s;
}

/**
 * Build the srcdoc for the body iframe.
 *
 * SECURITY: the iframe has no allow-scripts and no allow-same-origin, so this
 * content is inert by construction — that, not the string munging below, is
 * the actual defence. The sanitisation is defence in depth and, unlike the old
 * version's, it does not pretend a regex is a parser: we strip the tags that
 * can execute or exfiltrate, and we block remote images by default so opening
 * a mail does not confirm your address to a spammer.
 */
/**
 * Remote-image allow-list, keyed by sender address.
 *
 * Kept out of `settings.js` because it is unbounded user data rather than a
 * preference, and it is written from the reader rather than the options page.
 */
let imageAllowList = new Set();

export async function loadImageAllowList(storage = STORAGE) {
  try {
    const { imageAllow } = (await storage.get('imageAllow')) || {};
    imageAllowList = new Set(Array.isArray(imageAllow) ? imageAllow : []);
  } catch {
    imageAllowList = new Set();
  }
  return imageAllowList;
}

async function allowSenderImages(address, storage = STORAGE) {
  if (!address) return;
  imageAllowList.add(address);
  try {
    await storage.set({ imageAllow: [...imageAllowList] });
  } catch {
    // Session-only; the user can click again next time.
  }
}

/** The bare address out of a `Name <a@b>` header. */
// addressOf now lives in contacts.js; imported above.

/**
 * Decide whether this message may load remote images, and render it.
 *
 * Kept as one function because the CSP and the sanitiser MUST agree: if the
 * sanitiser emits an `https:` src, the CSP has to permit `https:` or we are
 * back to the invisible-blank-box defect. Both read `allowRemote` here.
 */
function renderBodyInto(body, forceRemote = false) {
  const policy = settings.get('remoteImages');
  const sender = addressOf(body.from);
  const allowRemote =
    forceRemote ||
    policy === 'always' ||
    (policy !== 'never' && imageAllowList.has(sender));

  const stats = {};
  el.rBody.srcdoc = renderBody(body, { allowRemote, stats });
  // Restore the remembered reading position once the frame has laid out
  // (round 46 #23), and surface the unfold-all control only while folded
  // quotes exist (round 46 #19).
  el.rBody.onload = () => {
    const at = readPosition.get(body.id);
    if (at) el.rBody.contentWindow?.scrollTo({ top: at });
    const doc = el.rBody.contentDocument;
    const folds = doc ? [...doc.querySelectorAll('details.quote-fold')] : [];
    const unfold = $('r-unfold');
    unfold.hidden = folds.length === 0;
    // Name the control with the count so its purpose is audible (round 48).
    unfold.setAttribute('aria-label', `Unfold ${folds.length} quoted ${folds.length === 1 ? 'section' : 'sections'}`);
    unfold.onclick = () => { for (const d of folds) d.open = true; unfold.hidden = true; };
  };

  // The bar only appears when there is something to unblock.
  const blocked = stats.blockedRemote || 0;
  el.rImages.hidden = blocked === 0;
  if (blocked > 0) {
    el.rImagesText.textContent =
      blocked === 1 ? '1 image was not loaded, to protect your privacy.'
        : `${blocked} images were not loaded, to protect your privacy.`;
    el.rImagesAlways.hidden = !sender;
    el.rImagesShow.onclick = () => {
      renderBodyInto(body, true);
      el.rBody.focus?.();
    };
    el.rImagesAlways.onclick = async () => {
      await allowSenderImages(sender);
      renderBodyInto(body, true);
      toast(`Images will load from ${sender}`, { kind: 'success' });
    };
  }
}

/** SECURITY BOUNDARY, not duplication (see background/index.js:extractBody). */
function renderBody(body, { allowRemote = false, stats = {} } = {}) {
  // cid -> data: URL, from the parts we just fetched.
  const cid = new Map();
  for (const p of body.inlineData || []) {
    if (p.contentId) cid.set(p.contentId, p.dataUrl);
    if (p.filename) cid.set(p.filename, p.dataUrl);
  }

  let html = body.html
    ? sanitizeHtml(body.html, document, { allowRemote, cid, stats })
    : `<pre>${escapeHtml(body.text || '(no content)')}</pre>`;

  /*
   * SECURE BLANK READER (roadmap Phase 1 / HIGH #3). If the sanitiser had
   * to fail closed, a blank body would read as an empty email — a safe
   * failure disguised as missing mail. Say what happened, leak nothing, and
   * point at the alternative: the message is intact in Gmail.
   */
  if (stats.failedClosed) {
    html = `<div class="bmm-failed-closed">
      <p><strong>This message could not be safely displayed here.</strong></p>
      <p>Its content is intact — BITS Mail chose not to guess at rendering
      it. Use “Open in Gmail” above to read it.</p>
    </div>`;
  }


  // The body iframe is a separate document and inherits nothing from us, so
  // the palette is interpolated in.
  //
  // Mail authors hard-code black-on-white constantly, and a dark chrome with a
  // blinding white body is worse than no dark theme at all. So on a dark theme
  // the body gets a dark surface and only UNSTYLED text follows our foreground
  // colour -- anything the sender coloured deliberately is left alone, because
  // overriding it would wreck legitimate design and can itself destroy
  // contrast.
  const t = getTheme(state.theme);
  const dark = t.scheme === 'dark';
  const surface = dark ? t.bgRaised : '#ffffff';
  const ink = dark ? t.fg : '#16181d';

  /*
   * READER DENSITY (round 45 H2), declared ONCE in the reader frame
   * contract module: the list obeys the density setting and the reader does
   * too, within reading bounds at every step.
   */
  const typo = READER_TYPOGRAPHY[settings.get('density')] || READER_TYPOGRAPHY.comfortable;

  // The CSP comes from the reader frame contract: one source of truth for
  // the decision the sanitiser already made (round 45, arch A2).
  const csp = readerCsp(allowRemote);

  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="${csp}">
<style>
  html{color-scheme:${t.scheme}}
  /*
   * READING TYPOGRAPHY.
   *
   * 15px/1.65 with a 68ch measure. The list is scanned, so it is dense; the
   * body is READ, so it gets the line-height and measure that long-form text
   * needs. Beyond ~70 characters the eye loses its place returning to the
   * next line, which is the single most common failure in mail rendering.
   */
  /* SPATIAL COMPRESSION O16 (audit 37): quoted history folds behind a
     native <details>; no script needed inside the sandbox. */
  details.quote-fold>summary{
    cursor:pointer;display:inline-block;margin:10px 0 4px;padding:3px 10px;
    font-size:13px;color:inherit;opacity:.72;border:1px solid currentColor;
    border-radius:6px;list-style:none;
  }
  details.quote-fold>summary::-webkit-details-marker{display:none}
  details.quote-fold>summary::before{content:"+ ";}
  details.quote-fold[open]>summary::before{content:"\\2212  ";}
  details.quote-fold blockquote{margin-top:6px}

  /* POLISH 18b: a link that leaves the message says so before the click. */
  a[target="_blank"]::after{
    content:"";display:inline-block;width:10px;height:10px;margin-inline-start:4px;
    background:currentColor;opacity:.55;
    -webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Cpath fill='none' stroke='black' stroke-width='2' d='M8 5H4v11h11v-4M12 4h4v4M16 4 9 11'/%3E%3C/svg%3E") no-repeat center/contain;
    mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Cpath fill='none' stroke='black' stroke-width='2' d='M8 5H4v11h11v-4M12 4h4v4M16 4 9 11'/%3E%3C/svg%3E") no-repeat center/contain;
  }
  body{
    font:${typo.size}px/${typo.line} -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
    color:${ink};background:${surface};
    margin:0;padding:${typo.pad};
    word-wrap:break-word;
    -webkit-font-smoothing:antialiased;
  }
  /* Only unstyled top-level text is constrained; a sender's own table layout
     is left exactly as they designed it. */
  body > p, body > div:not([style]), body > span, body > pre, body > ul, body > ol {
    max-width:68ch;
  }
  img{max-width:100%;height:auto;border-radius:6px}
  /*
   * BLOCKED AND UNRESOLVED IMAGES.
   *
   * An image with no usable src collapses to a 0x0 box in every browser, so
   * without this the user cannot tell the difference between "this mail has
   * no images" and "this mail's images were withheld". Giving the placeholder
   * a visible frame and the alt text room to show is what makes the reader
   * bar's offer make sense.
   */
  img[data-bmm-src], img[data-bmm-missing]{
    min-width:120px;min-height:44px;
    border:1px dashed ${t.line};border-radius:8px;
    background:${t.accentSoft};
    padding:8px 12px;box-sizing:border-box;
    font-size:12px;color:${t.fgDim};
  }
  pre{white-space:pre-wrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.92em;margin:0}
  table{max-width:100%!important}
  a{color:${t.accent};text-underline-offset:2px}
  a:hover{text-decoration-thickness:2px}
  p{margin:0 0 1em}
  h1,h2,h3{line-height:1.3;margin:1.4em 0 .5em;font-weight:600}
  blockquote{
    margin:1em 0 1em 2px;padding:2px 0 2px 14px;
    border-left:2px solid ${t.line};color:${t.fgDim};
  }
  hr{border:0;border-top:1px solid ${t.line};margin:1.6em 0}
  .att{
    margin-bottom:18px;padding:10px 13px;background:${t.accentSoft};
    color:${t.fgDim};border-radius:10px;font-size:13px;
  }
  .bmm-failed-closed{
    max-width:60ch;margin:24px 0;padding:16px 18px;
    border:1px dashed ${t.line};border-radius:10px;
    background:${t.accentSoft};color:${t.fg};
  }
  .bmm-failed-closed p{margin:0 0 8px}
  .bmm-failed-closed p:last-child{margin:0;color:${t.fgDim}}
</style></head><body>${html}</body></html>`;
}

function escapeDoc(text) {
  return `<!doctype html><meta charset="utf-8"><body style="font:13px system-ui;padding:20px;color:#5b6270"><pre style="white-space:pre-wrap">${escapeHtml(
    text
  )}</pre>`;
}

/** Remembered scroll per open message, so long mail reopens where you left
 *  it (round 46 #23). */
const readPosition = new Map();

export function closeReader() {
  const prev = state.selected;
  if (prev) {
    const sc = el.rBody.contentDocument?.scrollingElement;
    if (sc && sc.scrollTop > 0) readPosition.set(prev, sc.scrollTop);
  }
  state.selected = null;
  bodyToken++;
  lastBody = null;
  // Closing before the delay elapses leaves the message unread, which is the
  // whole point of the delay.
  clearTimeout(markReadTimer);
  markReadTimer = 0;
  if (prev) ctx.patchRow(prev);
  el.list.removeAttribute('aria-activedescendant');
  ctx.syncContextActions(null);
  el.reader.hidden = true;
  el.readerEmpty.hidden = false;
  el.rBody.srcdoc = '';
  el.rAttachments.hidden = true;
  el.rAttachments.replaceChildren();
  // R1: the eye returns to the row it was reading, not to the top.
  if (prev) ctx.reorientTo(prev);
  el.rImages.hidden = true;
}

/**
 * Which message inside the open conversation is being shown, or null when
 * nothing is open. The shell's compose path needs it: with threading the
 * selected row is a conversation, and a reply must answer the message being
 * READ, not necessarily the newest one.
 */
export function openPartId() {
  return openPart;
}

/**
 * Re-render the open body after a theme change. The body iframe is a separate
 * document with its colours baked into srcdoc, so it cannot follow a variable
 * change; the body is already in memory, so this costs no refetch.
 */
export function repaintBody() {
  if (state.selected && lastBody) el.rBody.srcdoc = renderBody(lastBody);
}

/**
 * Drop the pending mark-read without touching anything else. Called by the
 * shell when it cancels all in-flight work (sign-out, resync).
 */
export function cancelMarkRead() {
  clearTimeout(markReadTimer);
  markReadTimer = 0;
}

/**
 * Show only the actions that mean something in this mailbox.
 *
 * "Archive" in Trash does nothing useful, and "Delete" on an already-deleted
 * message is a control that lies about what it will do. Dead controls are how
 * a UI teaches people not to trust it.
 */
export function syncReaderActions() {
  const allowed = actionsFor(state.mailbox);
  const bar = $('r-actions');
  if (!bar) return;
  for (const btn of bar.querySelectorAll('button[data-act]')) {
    const act = btn.dataset.act;
    // `unread` is always available; the rest are mailbox-dependent.
    btn.hidden = act in allowed ? !allowed[act] : false;
  }

  /*
   * The spam control is one button with two meanings, resolved by mailbox.
   * "Report spam" on something already in Spam is a control that lies about
   * what it will do, and a second button for the inverse would make the user
   * choose between two things they think of as one.
   */
  const spamBtn = bar.querySelector('button[data-act="spam"]');
  if (spamBtn) {
    const rescuing = Boolean(allowed.notSpam);
    spamBtn.textContent = rescuing ? 'Not spam' : 'Report spam';
    spamBtn.title = rescuing ? 'Move back to the inbox (!)' : 'Report spam (!)';
  }
}
