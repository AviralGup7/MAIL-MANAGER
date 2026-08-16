/**
 * Compose: the panel, recipients, attachments, drafts and sending.
 *
 * The largest of the five things features.js was holding, and the one that
 * most benefits from being findable. Owns four module-level bindings --
 * pendingFiles, composeCtx, composeMeta, draftSaver -- none of which anything
 * outside compose ever touched.
 */

import { buildReply } from '../search/query.js';
import { openMenu } from '../overlays/menu.js';
import { middleTruncate } from '../core/icons.js';
import { closeWithMotion, cancelExit } from '../overlays/layers.js';
import { popFrom } from '../motion/morph.js';
import { burst as fxBurst } from '../motion/particles.js';
import * as outbox from '../../features/outbox/model.js';
import * as templates from './templates.js';
import { createDraftSaver, loadDraft, isMeaningful } from './draft-store.js';
import { confirmDialog } from '../overlays/dialog.js';
import * as settings from '../system/settings.js';
import { invalidAddresses } from '../core/contacts.js';
import { registerReset } from '../core/reset-registry.js';

const $ = (id) => document.getElementById(id);

/* ========================================================================== *
 * COMPOSE
 * ========================================================================== */

/*
 * Files chosen for the message being composed.
 *
 * Declared here, beside the other compose state, rather than next to the
 * functions that use it: closeCompose() sits above those and would hit the
 * temporal dead zone if it ever ran during module init.
 *
 * Held in module state rather than in the draft, deliberately. The autosaved
 * draft lives in chrome.storage.local, which has a ~10MB budget shared with
 * the message cache -- putting a 5MB PDF in it would evict the inbox to
 * recover a file the user still has on disk. Crash recovery therefore restores
 * the text and NOT the attachments.
 */
let pendingFiles = [];

/** Gmail rejects anything over 25MB; fail before the upload, not after. */
const MAX_ATTACH_BYTES = 25 * 1024 * 1024;

let composeCtx = null;
let composeMeta = {};
/** The panel title before minimisation rewrote it (round 45 M4). */
let baseTitle = '';

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
    // The message being answered, for template auto-values ({{sender}},
    // {{subject}}, {{course}}). Read by openTemplateMenu but NEVER WRITTEN
    // before bug-hunt #35 -- those placeholders always shipped unfilled.
    replyTo: prefill.replyTo || null,
    // What the panel STARTED with. Used to tell "typed something" from "a
    // reply pre-filled a quoted original".
    baseBody: prefill.quoted ? `\n\n${prefill.quoted}` : '',
    // Set when editing an existing Gmail draft, so saving updates it.
    draftId: prefill.draftId || '',
  };
  const panel = $('compose');
  if (!panel) return;

  /*
   * ATTACHMENTS RIDE WITH THE DRAFT (bug-hunt #12). The undo-send path
   * reopens compose with the cancelled draft; closeCompose had already
   * cleared pendingFiles, so the files used to vanish from the panel and the
   * re-send went out without them. Restoring them here puts them back on
   * screen and back in the MIME.
   */
  // Two citizens: freshly chosen files (with base64 `data`) and PRESERVED
  // draft attachments (metadata only, refetched at send). Both are valid;
  // dropping either is losing a file the user can see (bug-hunt P0/#12).
  pendingFiles = Array.isArray(prefill.attachments)
    ? prefill.attachments.filter((f) =>
        f && typeof f.filename === 'string' &&
        ((typeof f.data === 'string' && f.data) || (f.attachmentId && f.messageId)))
    : [];

  $('compose-title').textContent = prefill.title || 'New message';
  $('c-to').value = prefill.to || '';
  $('c-cc').value = prefill.cc || '';
  $('c-bcc').value = prefill.bcc || '';
  /*
   * Reveal Cc/Bcc when a RESTORED draft has one. Recovering a crashed draft
   * into a panel that hides half its recipients is worse than not recovering
   * it: the user sends believing they addressed two people.
   */
  if ($('c-cc').value) $('c-cc-row').hidden = false;
  if ($('c-bcc').value) $('c-bcc-row').hidden = false;
  $('c-subject').value = prefill.subject || '';

  /*
   * SIGNATURE (audit 40-ENG section 9: inserted, not merged).
   *
   * Inserted when the panel OPENS, not injected at send time — a signature
   * the user cannot see before sending is one they cannot edit. But it is
   * only for a FRESH message: a reply/forward already quotes a thread whose
   * footer may carry a signature (doubling them reads as a bug), and a
   * restored draft or an undone send must come back EXACTLY as the user left
   * it — re-inserting the signature there would resurrect text they deleted
   * for that message.
   */
  const isFresh = !prefill.quoted && !prefill.body && !prefill.draftId;
  const sig = isFresh ? settings.get('signature').trim() : '';
  const sigBlock = sig ? `\n\n-- \n${sig}` : '';
  $('c-text').value = prefill.quoted
    ? `\n\n${sigBlock ? `${sigBlock}\n` : ''}${prefill.quoted}`
    : (prefill.body || sigBlock);
  /* The body travels with the draft (outbox cancel, draft restore): if it
   * came in, the signature must not have been stamped over it. */
  composeMeta.baseBody = prefill.baseBody || composeMeta.baseBody || '';
  $('c-cc-row').hidden = !prefill.cc;
  // The bcc row needs the same reset (bug-hunt #33): without it a row left
  // open by the previous compose session stayed open for the next one.
  $('c-bcc-row').hidden = !prefill.bcc;
  $('c-status').textContent = '';

  // Rebuild the address book once per open, from mail already in the store.
  // Injected via ctx (R-4): compose must not import autocomplete as a sibling.
  ctx.refreshContacts?.(ctx);

  // Clear a half-finished exit: reply-to-reply reopens compose inside the
  // 140ms close window, and a stale `.closing` would animate it right back out.
  const wasHidden = panel.hidden;
  cancelExit(panel);
  panel.hidden = false;
  panel.classList.remove('minimised');
  /*
   * SEED MORPH (animation P5): a freshly-opened compose GROWS out of the
   * Compose button — the dialog is the button, expanded, one continuous
   * object. A restore from the minimised strip is a lift-back, not a birth,
   * so only a hidden→open transition seeds. popFrom clamps the anchor into
   * the box (P4 live finding), suspends any CSS entry for the flight, and
   * hands it back whole at rest; reduced motion and an absent frame clock
   * skip the seed entirely (P2 park doctrine).
   */
  if (wasHidden) {
    const bb = $('btn-compose')?.getBoundingClientRect?.();
    if (bb && bb.width > 0) {
      popFrom(panel, { x: bb.left + bb.width / 2, y: bb.top + bb.height / 2 });
    }
  }
  renderFiles();
  document.body.classList.add('composing');
  // Focus the first EMPTY field: a reply already has a recipient and a
  // subject, so landing in "To" would make the user tab past both.
  (prefill.to ? $('c-text') : $('c-to')).focus();
  if (prefill.quoted) $('c-text').setSelectionRange(0, 0);
}

export function closeCompose() {
  document.body.classList.remove('draft-dirty');
  document.body.classList.remove('composing');
  const panel = $('compose');
  if (panel) closeWithMotion(panel);
  composeMeta = {};
  // Attachments belong to ONE message. Carrying them into the next compose
  // would silently attach the previous file to an unrelated recipient.
  pendingFiles = [];
  renderFiles();
}


/**
 * Open an existing Gmail draft for editing.
 *
 * A draft exists ONLY to be finished, and this was the missing path: the
 * Drafts mailbox could list them and delete them, never open one. The product
 * already had compose, autosave and crash recovery -- this connects them.
 *
 * The draft ID travels with the draft so saving UPDATES it. The Drafts
 * mailbox is fetched by label, so the app holds a message id and the drafts
 * API wants a draft id; the worker resolves one to the other.
 */
export async function editDraft(ctx, id) {
  try {
    const d = await ctx.send('GET_DRAFT', { id });
    if (!d) {
      ctx.toast('Could not find that draft in Gmail', { kind: 'error' });
      return;
    }
    openCompose(ctx, {
      to: d.to || '',
      cc: d.cc || '',
      bcc: d.bcc || '',
      subject: d.subject || '',
      title: 'Edit draft',
      threadId: d.threadId,
      draftId: d.draftId,
      /*
       * PRESERVED ATTACHMENTS (bug-hunt P0). Metadata only -- the bytes stay
       * server-side until send, where the worker refetches them
       * (hydrateDraftAttachments). Carrying them through here is what stops
       * the next SAVE_DRAFT from rebuilding the MIME without them and
       * silently deleting the user's files.
       */
      attachments: d.attachments || [],
    });
    // Set directly rather than through `quoted`, which would re-wrap it as a
    // reply -- this is the user's own unfinished text, not somebody else's.
    $('c-text').value = d.text || '';
  } catch (err) {
    ctx.toast(`Could not open the draft: ${err.message}`, { kind: 'error' });
  }
}

/** Open compose pre-filled as a reply / reply-all / forward. */
export async function startReply(ctx, mode) {
  /*
   * REPLY TO THE MESSAGE ON SCREEN, not to the conversation's newest.
   *
   * With threading, `state.selected` is the ROW -- the conversation -- while
   * the reader may be showing an earlier message the user chose from the
   * strip. Replying to the root would attach the reply to the wrong point in
   * the exchange and quote the wrong text.
   *
   * `openMessageId()` falls back to the selection, so the untreaded and
   * single-message cases are unchanged.
   */
  const id = ctx.openMessageId?.() || ctx.state.selected;
  if (!id) return;
  try {
    const body = await ctx.send('GET_BODY', { id });
    /* Stale property, found 2026-08-15 while stamping outbox rows for
       AUD-C1: app state carries the signed-in address as `selfEmail`, and
       `state.email` never existed — so reply-all never received the self
       address here and could not strip it. Fixed at the reference. */
    const r = buildReply(body, ctx.state.selfEmail || '', mode);
    openCompose(ctx, {
      ...r,
      replyTo: body, // bug-hunt #35: template auto-values need the source
      title: mode === 'forward' ? 'Forward' : mode === 'replyAll' ? 'Reply all' : 'Reply',
    });
  } catch (err) {
    ctx.toast(`Could not open reply: ${err.message}`);
  }
}


/* ------------------------------------------------------------- attachments -- */

/*
 * Files chosen for the message being composed.
 *
 * Held in module state rather than in the draft, deliberately. The autosaved
 * draft lives in chrome.storage.local, which has a ~10MB budget shared with
 * the message cache -- putting a 5MB PDF in it would evict the inbox to
 * recover a file the user still has on disk. Crash recovery therefore restores
 * the text and NOT the attachments, and says so.
 */

function renderFiles() {
  const box = $('c-files');
  if (!box) return;
  box.replaceChildren();
  box.hidden = pendingFiles.length === 0;
  // aria-live narration for the count change (P2-09).
  const status = $('attach-status');
  if (status) {
    status.textContent = pendingFiles.length
      ? `${pendingFiles.length} file${pendingFiles.length === 1 ? '' : 's'} attached`
      : '';
  }

  /*
   * SIZE BUDGET METER (round 45 M3). Gmail's 25MB ceiling used to surface
   * only at send time, after the undo window, as an opaque outbox error.
   * Now the budget is visible while the user is still choosing files — the
   * same wire-size factor addFiles enforces, so the meter and the limit
   * cannot disagree.
   */
  if (pendingFiles.length) {
    const wire = (n) => Math.ceil(n * 1.37);
    const used = wire(pendingFiles.reduce((t, f) => t + (f.size || 0), 0));
    const pct = Math.min(100, Math.round((used / MAX_ATTACH_BYTES) * 100));
    const meter = document.createElement('span');
    meter.className = 'c-budget';
    meter.dataset.kind = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok';
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', '100');
    meter.setAttribute('aria-valuenow', String(pct));
    meter.setAttribute('aria-label', 'Attachment size against the 25MB limit');
    meter.title = `${fmtBytes(used)} of ${fmtBytes(MAX_ATTACH_BYTES)} (wire size)`;
    const fill = document.createElement('span');
    fill.className = 'c-budget-fill';
    // scaleX keeps the fill off the layout path (see the CSS note).
    fill.style.transform = `scaleX(${pct / 100})`;
    meter.appendChild(fill);
    box.appendChild(meter);
  }

  pendingFiles.forEach((f, i) => {
    const chip = document.createElement('span');
    chip.className = 'c-file';
    chip.setAttribute('role', 'listitem');

    const name = document.createElement('span');
    name.className = 'c-file-name';
    // See middleTruncate: end-truncation would hide the extension, which is
    // the part that says whether this is the right file.
    name.textContent = middleTruncate(f.filename);
    name.title = `${f.filename} · ${fmtBytes(f.size)}`;

    const size = document.createElement('span');
    size.className = 'c-file-size';
    size.textContent = fmtBytes(f.size);

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'ghost small';
    rm.textContent = 'Remove';
    rm.setAttribute('aria-label', `Remove ${f.filename}`);
    rm.addEventListener('click', () => {
      pendingFiles.splice(i, 1);
      renderFiles();
    });

    chip.append(name, size, rm);
    box.appendChild(chip);
  });
}

function fmtBytes(n) {
  if (!n || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Read one File into the base64 the MIME builder wants. */
function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error(`Could not read ${file.name}`));
    r.onload = () => {
      // The data URL is "data:<mime>;base64,<payload>" -- take the payload.
      const s = String(r.result || '');
      const at = s.indexOf(',');
      // No comma means the result is not a data URL at all; slicing at 0
      // would hand the whole string to the MIME builder as "base64"
      // (bug-hunt #36). That is a failed read, not an empty one.
      if (at === -1) return reject(new Error(`Could not read ${file.name}`));
      resolve(s.slice(at + 1));
    };
    r.readAsDataURL(file);
  });
}

async function addFiles(ctx, fileList) {
  for (const file of [...(fileList || [])]) {
    const total = pendingFiles.reduce((n, f) => n + f.size, 0);
    // Gmail's limit is on the MIME message: base64 inflates raw bytes by
    // 4/3 plus per-part headers, so the check must count that overhead or
    // the upload fails AFTER the user assembled the mail.
    const wire = (size) => Math.ceil(size * 1.37);
    if (wire(total + file.size) > MAX_ATTACH_BYTES) {
      ctx?.toast?.(
        `${file.name} would take this over Gmail's 25MB limit`,
        { kind: 'error' }
      );
      continue;
    }
    try {
      pendingFiles.push({
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        data: await readAsBase64(file),
      });
    } catch (err) {
      ctx?.toast?.(err.message, { kind: 'error' });
    }
  }
  renderFiles();
}

function collectDraft() {
  return {
    to: $('c-to').value.trim(),
    cc: $('c-cc').value.trim(),
    bcc: $('c-bcc').value.trim(),
    attachments: pendingFiles,
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
  const restore = await confirmDialog({
    title: 'Restore your unsent message?',
    body: `${what}${who}`.trim() || 'It was still in progress when the last session ended.',
    confirmLabel: 'Restore',
  });
  if (!restore) {
    await ensureDraftSaver().discard();
    return false;
  }

  openCompose(ctx, {
    to: d.to,
    cc: d.cc,
    // Was dropped here, so a recovered draft silently lost its Bcc -- the
    // user saw one addressee and sent believing that was the whole story.
    bcc: d.bcc,
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
    // Only warn if something was actually typed. A confirm on an untouched
    // panel is the kind of friction that makes people avoid the feature.
    if (isMeaningful(d)) {
      const discard = await confirmDialog({
        title: 'Discard this message?',
        body: 'What you have written will not be kept.',
        confirmLabel: 'Discard',
        danger: true,
      });
      if (!discard) return;
    }
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
  /*
   * POLISH 16: a minimised compose with words in it must not look identical
   * to an empty one -- that is state the user can currently only remember.
   */
  panel.addEventListener('input', () => {
    document.body.classList.toggle('draft-dirty', isMeaningful(collectDraft()));
  });

  // Bcc gets the same contact autocomplete as To and Cc. A recipient field
  // that cannot complete an address is a field people avoid.
  ctx.wireAutocomplete?.('c-to', 'c-to-list');
  ctx.wireAutocomplete?.('c-cc', 'c-cc-list');
  ctx.wireAutocomplete?.('c-bcc', 'c-bcc-list');

  $('compose-min').addEventListener('click', () => {
    const minimised = panel.classList.toggle('minimised');
    // O7: quieting follows the TASK. A minimised compose is writing no
    // longer; the inbox comes back up.
    document.body.classList.toggle('composing', !minimised);
    /*
     * A MINIMISED DRAFT KEEPS ITS IDENTITY (round 45 M4). The collapsed bar
     * used to be just a dirty dot — the user had to reopen to remember what
     * was parked there. The title bar now says who it is for and what it is
     * about; expanding restores the real panel title.
     */
    const title = $('compose-title');
    if (minimised) {
      if (!baseTitle) baseTitle = title.textContent;
      const to = ($('c-to').value || '').trim();
      const subj = ($('c-subject').value || '').trim();
      const who = to ? `To: ${to.split(',')[0].trim()}` : 'No recipient';
      // A parked draft with files must not look text-only (round 46 #40).
      const files = pendingFiles.length
        ? ` · ${pendingFiles.length} file${pendingFiles.length === 1 ? '' : 's'}`
        : '';
      title.textContent = `${subj ? `${who} — ${subj}` : who}${files}`;
    } else if (baseTitle) {
      title.textContent = baseTitle;
      baseTitle = '';
    }
  });
  for (const [toggleId, rowId, inputId] of [
    ['c-cc-toggle', 'c-cc-row', 'c-cc'],
    ['c-bcc-toggle', 'c-bcc-row', 'c-bcc'],
  ]) {
    $(toggleId)?.addEventListener('click', () => {
      const row = $(rowId);
      row.hidden = !row.hidden;
      if (!row.hidden) $(inputId).focus();
    });
  }

  $('c-attach')?.addEventListener('click', () => $('c-file')?.click());
  /*
   * DRAG-AND-DROP (round 46 #36): the panel is a drop target, so attaching
   * is a gesture, not a picker round trip. preventDefault on dragover is
   * what tells the browser a drop is welcome here.
   */
  panel.addEventListener('dragover', (e) => {
    if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) {
      e.preventDefault();
      panel.classList.add('dropping');
    }
  });
  panel.addEventListener('dragleave', () => panel.classList.remove('dropping'));
  panel.addEventListener('drop', async (e) => {
    panel.classList.remove('dropping');
    if (e.dataTransfer?.files?.length) {
      e.preventDefault();
      await addFiles(ctx, e.dataTransfer.files);
    }
  });

  $('c-file')?.addEventListener('change', async (e) => {
    await addFiles(ctx, e.target.files);
    // Reset, or choosing the same file twice in a row fires no change event.
    e.target.value = '';
  });

  $('c-send').addEventListener('click', () => doSend(ctx));
  $('c-draft').addEventListener('click', () => doDraft(ctx));
  $('c-template')?.addEventListener('click', (e) => openTemplateMenu(ctx, e.currentTarget));

  /* Ctrl+Enter sends -- the convention in every mail client -- gated on the
     schema's `ctrlEnterSend` promise: it is the only chord in the composer
     whose slip writes history, so its kill switch lives one click from the
     mail and is read at the moment the chord lands, not at open. */
  panel.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && settings.get('ctrlEnterSend') !== false) {
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
  // Bcc gets the same check (bug-hunt #34): a typo there fails just as
  // silently, and the warning exists precisely for silent failures.
  const bad = [...invalidAddresses(draft.to), ...invalidAddresses(draft.cc), ...invalidAddresses(draft.bcc)];
  if (bad.length) {
    const list = bad.join(', ');
    const sendAnyway = await confirmDialog({
      title: 'Some addresses look wrong',
      body: `${list} — send anyway?`,
      confirmLabel: 'Send anyway',
    });
    if (!sendAnyway) {
      setStatus(`Check the address: ${list}`, 'err');
      $('c-to').focus();
      return;
    }
  }
  /*
   * TEMPLATE GAPS MUST NOT RIDE ALONG (bug-hunt 44 #30). Unfilled
   * placeholders stay visible in the body BY DESIGN so the writer sees them
   * -- but the send path never looked, so a hurried user could mail
   * "{{reason}}" to a professor. Same warn-don't-block posture as the
   * bad-address check: name the gap, let the human decide.
   */
  /* Asked through templates.unfilled rather than re-writing its regex here
     (round 10, L-13/I-6). The copy that used to sit here had to be kept in
     step with templates.fill by hand, and a placeholder syntax the two
     disagreed about is exactly a gap that ships. */
  const gaps = templates.unfilled(`${draft.subject}\n${draft.body}`).map((p) => `{{${p}}}`);
  if (gaps.length) {
    const sendAnyway = await confirmDialog({
      title: 'Unfilled template fields',
      body: `${gaps.join(', ')} — send anyway?`,
      confirmLabel: 'Send anyway',
    });
    if (!sendAnyway) {
      setStatus('Fill the highlighted placeholders first', 'err');
      return;
    }
  }

  const btn = $('c-send');
  btn.disabled = true;
  setStatus('Sending…', '');

  /*
   * SENDING GOES THROUGH THE OUTBOX, NOT STRAIGHT TO THE WORKER.
   *
   * Two things fall out of that, and neither is possible with a direct call:
   *
   *   UNDO-SEND. The message sits in `held` for a few seconds and simply does
   *   not leave. That is a real recall, not a fake one -- the Gmail API cannot
   *   unsend, so the only honest implementation is to not have sent yet.
   *
   *   SURVIVING A FAILURE. A direct send that failed left the composed message
   *   in a panel the user had already been told to close, and a dropped
   *   connection lost it. Queued, it persists and retries with backoff.
   *
   * The panel closes immediately either way: the user's job is done, and
   * holding a modal open to watch a progress state is the thing the queue
   * exists to avoid.
   */
  try {
    const item = outbox.enqueue(draft, {
      holdMs: ctx.undoSendMs ? ctx.undoSendMs() : outbox.DEFAULT_HOLD_MS,
      threadId: composeMeta.threadId,
      /* AUD-C1 (2026-08-15): the row is stamped with the account that queued
         it, so a pump running under a DIFFERENT account's token refuses it
         instead of sending one account's mail as another. Legacy unstamped
         rows stay dispatchable — see outbox.dispatchable. */
      accountEmail: ctx.state?.selfEmail || '',
    });
    const queue = await outbox.loadOutbox();
    await outbox.saveOutbox([...queue, item]);

    await ensureDraftSaver().discard();
    /*
     * P6: the send burst. The rect is read BEFORE the panel leaves — after
     * closeCompose there is no Send button left to measure. The panel's job
     * ends here; the energy stays behind in the viewport for ~700ms to say
     * what the toast's words say slower. Reduced-motion politely no-ops
     * inside fxBurst, by its contract.
     */
    const sendAt = btn.getBoundingClientRect();
    closeCompose();
    fxBurst(sendAt.left + sendAt.width / 2, sendAt.top + sendAt.height / 2, { count: 46 });

    const who = draft.to.split(',')[0].trim();
    ctx.toast(`Sending to ${who}`, {
      kind: 'undo',
      // The toast contract is {label, run} -- checked against toast() rather
      // than assumed, after first writing an `actionLabel` that nothing reads.
      action: {
        label: 'Undo',
        run: async () => {
          const cancelled = await outbox.cancel(item.id);
          if (cancelled) {
            // Put the message back exactly as it was, rather than claiming
            // success on a send that is not going to happen.
            openCompose(ctx, cancelled.draft);
            /* Re-render the rail through the existing seam: cancel() only
               edits the queue, and without a pump the row kept counting the
               RECALLED message down ("Sending in 4s") until the hold's own
               timer fired — the rail lying for up to 8s about a send the
               user already took back. The pump on an empty queue just hides
               the section (G5, found by the undo-send smoke gate). */
            ctx.flushOutbox?.();
            ctx.toast('Send cancelled');
          } else {
            ctx.toast('Too late to cancel — it has gone', { kind: 'error' });
          }
        },
      },
    });
    ctx.flushOutbox?.();
  } catch (err) {
    setStatus(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

/**
 * The template picker.
 *
 * Built on the shared `menu.js` rather than a bespoke dropdown, so it inherits
 * focus management, Escape handling and the z-layer the other four menus use.
 *
 * Values are filled from the message being replied to where they are known --
 * `autoValues()` supports `subject`, `sender` and `course` and had no caller
 * until now, which is why the completeness audit listed it as shipped but
 * unreachable.
 */
async function openTemplateMenu(ctx, anchor) {
  const list = await templates.loadTemplates();
  /*
   * {{course}} DOES NOT COME OFF THE WIRE (bug-hunt #24). The GET_BODY
   * shape has no course field -- adding one just for templates would be a
   * second course-detection mechanism. The canonical CLASSIFIED record
   * already carries `courses` (stamped at ingest, same field the row chip
   * renders), so the store is where this reads it from.
   */
  const replyTo = composeMeta.replyTo || null;
  const rec = replyTo?.id ? ctx.store?.get?.(replyTo.id) : null;
  const values = templates.autoValues({
    profileName: ctx.profileName?.() || '',
    message: replyTo
      ? { ...replyTo, course: rec?.courses?.[0] || replyTo.course }
      : null,
  });

  openMenu({
    anchor,
    name: 'templates',
    label: 'Insert a template',
    // The menu contract is `text`, not `label` -- read from menu.js rather
    // than guessed, after first writing `label` and getting blank rows.
    items: list.map((t) => ({
      text: t.name,
      run: () => {
        const draft = collectDraft();
        const next = templates.applyTemplate(t, draft, values);
        $('c-subject').value = next.subject || '';
        $('c-text').value = next.body;

        /*
         * PUT THE CARET ON THE FIRST GAP.
         *
         * applyTemplate returns `_unfilled` and nothing consumed it, so the
         * user had to hunt for the {{reason}} themselves -- which is how a
         * template ends up sent with a placeholder still in it. Selecting the
         * first one makes the gap impossible to miss and typing replaces it.
         */
        const first = next._unfilled?.[0];
        const area = $('c-text');
        area.focus();
        if (first) {
          const needle = `{{${first}}}`;
          const at = area.value.indexOf(needle);
          if (at >= 0) area.setSelectionRange(at, at + needle.length);
        }
        if (next._unfilled?.length) {
          setStatus(`Fill in: ${next._unfilled.map((p) => `{{${p}}}`).join(', ')}`, '');
        }
      },
    })),
  });
}

async function doDraft(ctx) {
  const draft = collectDraft();
  setStatus('Saving…', '');
  try {
    /*
     * `draftId` is what makes a re-save an UPDATE. Without it, editing a
     * draft twice leaves three copies in Gmail -- the original plus one per
     * save. composeMeta carries it from openCompose.
     */
    await ctx.send('SAVE_DRAFT', { draft, draftId: composeMeta.draftId });
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

/**
 * Test seam: drop this module's state (compose context, meta, draft saver and chosen files).
 *
 * Module state outlives a jsdom boot -- only main.js is re-imported with a
 * cache-busting URL -- so it would otherwise point at a torn-down document.
 * Each module resets its OWN state rather than one function reaching into
 * four files' internals.
 */
function _resetCompose() {
  composeCtx = null;
  composeMeta = {};
  draftSaver = null;
  pendingFiles = [];
}

/** Compose status line, colour-coded by outcome. */
function setStatus(text, kind) {
  const el = $('c-status');
  if (!el) return;
  el.textContent = text;
  el.dataset.kind = kind || '';
}

// Self-registered test seam (reset-registry): the 'features' composite ended
// with the barrel's dissolution (S2); each module registers its own reset.
registerReset('compose', _resetCompose);
