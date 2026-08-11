/**
 * Compose: the panel, recipients, attachments, drafts and sending.
 *
 * The largest of the five things features.js was holding, and the one that
 * most benefits from being findable. Owns four module-level bindings --
 * pendingFiles, composeCtx, composeMeta, draftSaver -- none of which anything
 * outside compose ever touched.
 */

import { buildReply } from './query.js';
import { openMenu } from './menu.js';
import { middleTruncate } from './icons.js';
import { closeWithMotion, cancelExit } from './layers.js';
import * as outbox from './outbox.js';
import * as templates from './templates.js';
import { createDraftSaver, loadDraft, isMeaningful } from './draft-store.js';
import * as settings from './settings.js';
import { invalidAddresses } from './contacts.js';

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
  pendingFiles = Array.isArray(prefill.attachments)
    ? prefill.attachments.filter((f) => f && typeof f.filename === 'string' && typeof f.data === 'string')
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
  cancelExit(panel);
  panel.hidden = false;
  panel.classList.remove('minimised');
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
    const r = buildReply(body, ctx.state.email || '', mode);
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
  if (!confirm(`Restore your unsent message${what}${who}?`)) {
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
    panel.classList.toggle('minimised');
    // O7: quieting follows the TASK. A minimised compose is writing no
    // longer; the inbox comes back up.
    document.body.classList.toggle('composing', !panel.classList.contains('minimised'));
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
  $('c-file')?.addEventListener('change', async (e) => {
    await addFiles(ctx, e.target.files);
    // Reset, or choosing the same file twice in a row fires no change event.
    e.target.value = '';
  });

  $('c-send').addEventListener('click', () => doSend(ctx));
  $('c-draft').addEventListener('click', () => doDraft(ctx));
  $('c-template')?.addEventListener('click', (e) => openTemplateMenu(ctx, e.currentTarget));

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
  // Bcc gets the same check (bug-hunt #34): a typo there fails just as
  // silently, and the warning exists precisely for silent failures.
  const bad = [...invalidAddresses(draft.to), ...invalidAddresses(draft.cc), ...invalidAddresses(draft.bcc)];
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
    });
    const queue = await outbox.loadOutbox();
    await outbox.saveOutbox([...queue, item]);

    await ensureDraftSaver().discard();
    closeCompose();

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
  const values = templates.autoValues({
    profileName: ctx.profileName?.() || '',
    message: composeMeta.replyTo || null,
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
 * Module state outlives a jsdom boot -- only app.js is re-imported with a
 * cache-busting URL -- so it would otherwise point at a torn-down document.
 * Each module resets its OWN state rather than one function reaching into
 * four files' internals.
 */
export function _resetCompose() {
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
