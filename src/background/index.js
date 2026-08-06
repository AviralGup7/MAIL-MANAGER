/**
 * Service worker.
 *
 * Deliberately thin. In MV3 the worker is killed aggressively, so anything
 * stateful here is a bug waiting to happen. Its jobs:
 *   - route the toolbar click / keyboard shortcut into the Gmail tab
 *   - own OAuth (the app iframe never sees a token)
 *   - proxy Gmail API calls
 */

import { signIn, signOut, isSignedIn } from './auth.js';
import {
  getFull, modify, batchModify, trash, profile,
  buildMime, sendMessage, saveDraft,
  listLabels, createLabel, getAttachment, ensureLabel,
} from './gmail.js';
import { SNOOZE_LABEL, loadSnoozed, removeSnooze, due } from '../app/snooze.js';
import { syncPage, syncDelta } from './sync.js';
import { api } from './gmail.js';

/**
 * Inline-image budget. See GET_INLINE.
 *
 * 2MB of source bytes becomes roughly 2.7MB of base64 in the srcdoc string,
 * which is a large but survivable document. 20 parts covers every legitimate
 * newsletter seen in the data pack with room to spare.
 */
const MAX_INLINE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_PARTS = 20;

/**
 * Is this a Gmail tab?
 *
 * `tab.url` is only populated when the extension holds either the broad `tabs`
 * permission or a host permission for that specific tab. We hold the host
 * permission for mail.google.com, which is the narrower of the two -- `tabs`
 * would expose the URL of EVERY tab the user has open.
 *
 * This being undefined is what broke the toolbar button: the check fell
 * through to the "not on Gmail" branch and opened a new tab on every click.
 */
function isGmail(tab) {
  return typeof tab?.url === 'string' && tab.url.startsWith('https://mail.google.com/');
}

/**
 * Startup self-check.
 *
 * Every one of the three bugs that made the first real browser run fail was a
 * manifest/code mismatch that produced SILENCE rather than an error: a missing
 * host permission left tab.url undefined, a missing `scripting` permission
 * made the injection path throw into an empty catch, and a shortcut that
 * collided with the browser's own was simply never delivered. None of it
 * appeared anywhere a user would look.
 *
 * This logs the actual granted state once at startup, so the next mismatch is
 * one glance at the service worker console instead of a debugging session.
 */
chrome.runtime.onInstalled.addListener(async () => {
  const manifest = chrome.runtime.getManifest();
  const problems = [];

  if (!chrome.scripting) problems.push('chrome.scripting unavailable — "scripting" permission missing');
  if (!(manifest.host_permissions || []).some((h) => h.includes('mail.google.com'))) {
    problems.push('no host permission for mail.google.com — tab.url will be undefined');
  }

  const commands = await chrome.commands.getAll().catch(() => []);
  for (const c of commands) {
    // An empty shortcut means the browser refused it, usually a collision.
    if (c.name === 'toggle-takeover' && !c.shortcut) {
      problems.push(
        'the keyboard shortcut is unassigned — set one at chrome://extensions/shortcuts'
      );
    }
  }

  if (problems.length) {
    console.warn('[BMM] startup problems:\n  - ' + problems.join('\n  - '));
  } else {
    console.info('[BMM] ready. Shortcut:', commands.find((c) => c.name === 'toggle-takeover')?.shortcut || '(none)');
  }
});

/** Toolbar click: tell the content script in THIS tab to toggle. */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  if (isGmail(tab)) {
    await toggleIn(tab.id);
    return;
  }

  // Not on Gmail. Prefer an existing Gmail tab over opening another one --
  // repeatedly spawning tabs is what the old behaviour did, and each new tab
  // resolved to the browser's default account rather than the one the user was
  // already reading.
  const [existing] = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId != null) {
      await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    }
    await toggleIn(existing.id);
    return;
  }

  // Genuinely no Gmail tab open. Opening the bare URL sends the user to
  // whichever account Chrome considers default, so this is a last resort.
  await chrome.tabs.create({ url: 'https://mail.google.com/' });
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-takeover') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (isGmail(tab) && tab.id) await toggleIn(tab.id);
});

/**
 * Send the toggle, injecting the content script first if it is not there.
 *
 * The injection path matters more than it looks: a content script declared in
 * the manifest is only present in tabs loaded AFTER the extension was
 * installed or reloaded. Without this, the button does nothing at all on every
 * Gmail tab that was already open -- which is the common case immediately
 * after installing.
 */
async function toggleIn(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'BMM_TOGGLE' });
    return;
  } catch {
    // No receiver. Fall through and inject.
  }

  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['src/takeover/takeover.css'],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/takeover/content.js'],
    });
    await chrome.tabs.sendMessage(tabId, { type: 'BMM_TOGGLE' });
  } catch (err) {
    // Previously this whole path was swallowed by `.catch(() => {})`, so a
    // missing `scripting` permission looked exactly like success and the
    // button silently did nothing. Surface it instead.
    console.error('[BMM] could not start the takeover:', err);
    await chrome.action.setBadgeText({ tabId, text: '!' }).catch(() => {});
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#c0392b' }).catch(() => {});
  }
}

/**
 * Message router for the app iframe.
 *
 * The app never holds an access token. It asks the worker, the worker calls
 * Gmail. That keeps the token out of a document that renders untrusted mail.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // keep the channel open for the async reply
});

async function handle(msg) {
  switch (msg?.type) {
    case 'AUTH_STATUS':
      return { signedIn: await isSignedIn() };
    case 'SIGN_IN':
      await signIn();
      return { signedIn: true };
    case 'SIGN_OUT':
      await signOut();
      return { signedIn: false };
    case 'PROFILE':
      return profile();

    // ---- sync ----------------------------------------------------------
    case 'SYNC_PAGE': {
      const opts = { ...(msg.opts || {}) };
      // A mailbox identified by label NAME (our snoozed label) has to be
      // resolved to an id before listing; Gmail's list API takes ids only.
      if (opts.labelName) {
        try {
          opts.labelIds = [await ensureLabel(opts.labelName)];
        } catch {
          // The label does not exist yet, which simply means nothing has ever
          // been put in it. An empty page is the honest answer.
          return { messages: [], nextPageToken: '' };
        }
        delete opts.labelName;
      }
      return syncPage(opts);
    }
    case 'SYNC_DELTA':
      return syncDelta();

    // ---- reading -------------------------------------------------------
    case 'GET_BODY':
      return extractBody(await getFull(msg.id));

    // ---- triage --------------------------------------------------------
    // Every one of these is fire-and-await from the app, but the app has
    // ALREADY applied the change optimistically. Gmail round trips are
    // 200-600ms; making the UI wait for them is what made the old version
    // feel dead on click.
    case 'MARK_READ':
      return modify(msg.id, [], ['UNREAD']);
    case 'MARK_UNREAD':
      return modify(msg.id, ['UNREAD'], []);
    case 'STAR':
      return modify(msg.id, msg.on ? ['STARRED'] : [], msg.on ? [] : ['STARRED']);
    case 'ARCHIVE':
      return modify(msg.id, [], ['INBOX']);
    case 'TRASH':
      return trash(msg.id);
    case 'BULK':
      return batchModify(msg.ids, msg.add || [], msg.remove || []);
    case 'UNARCHIVE':
      // The inverse of archive, for undo. Gmail has no such button.
      return modify(msg.id, ['INBOX'], []);
    case 'UNTRASH':
      return api(`/messages/${encodeURIComponent(msg.id)}/untrash`, { method: 'POST' });

    // ---- compose ---------------------------------------------------------
    case 'SEND':
      return sendMessage(buildMime(msg.draft), msg.draft.threadId);
    case 'SAVE_DRAFT':
      return saveDraft(buildMime(msg.draft), msg.draft.threadId, msg.draftId);

    // ---- labels ----------------------------------------------------------
    case 'LIST_LABELS':
      return listLabels();
    case 'CREATE_LABEL':
      return createLabel(msg.name);

    // ---- snooze ----------------------------------------------------------
    /*
     * Snoozing is two Gmail mutations in one step: out of the inbox, into the
     * snoozed label. Doing them as one `modify` call means there is no window
     * where the message is in neither place.
     */
    case 'SNOOZE': {
      const labelId = await ensureLabel(SNOOZE_LABEL);
      await modify(msg.id, [labelId], ['INBOX']);
      await scheduleWake();
      return { ok: true };
    }
    case 'UNSNOOZE': {
      const labelId = await ensureLabel(SNOOZE_LABEL);
      // Back to the inbox and unread, because a message that reappears
      // already-read will be scrolled past and never seen.
      await modify(msg.id, ['INBOX', 'UNREAD'], [labelId]);
      return { ok: true };
    }
    case 'WAKE_DUE':
      return { woke: await wakeDue() };

    // ---- attachments -----------------------------------------------------
    case 'GET_ATTACHMENT':
      return { dataUrl: await getAttachment(msg.messageId, msg.attachmentId, msg.mimeType) };

    /*
     * Inline images for one message, resolved in a single round trip.
     *
     * BOUNDED. A message can legitimately carry a dozen inline images, and a
     * hostile one can claim a hundred. Every resolved part is inlined into the
     * srcdoc as base64, which costs ~1.37x its byte size in the string, so an
     * unbounded fetch here is a memory and paint problem, not just a network
     * one. Oversized parts are skipped and render as placeholders.
     */
    case 'GET_INLINE': {
      const parts = Array.isArray(msg.parts) ? msg.parts.slice(0, MAX_INLINE_PARTS) : [];
      const out = [];
      let budget = MAX_INLINE_BYTES;
      for (const p of parts) {
        if (!p?.attachmentId || !p?.contentId) continue;
        if ((p.size || 0) > budget) continue;
        try {
          const dataUrl = await getAttachment(msg.messageId, p.attachmentId, p.mimeType);
          budget -= p.size || 0;
          out.push({ contentId: p.contentId, filename: p.filename || '', dataUrl });
        } catch {
          // One unfetchable part must not blank the whole message body.
        }
      }
      return { inline: out };
    }

    default:
      throw new Error(`Unknown message: ${msg?.type}`);
  }
}


/**
 * Pull a displayable body out of Gmail's MIME tree.
 *
 * Done in the WORKER, not in the app document, for one reason: the worker has
 * no DOM, so a malicious body cannot do anything here no matter how it is
 * shaped. The app receives inert strings and renders them into a sandboxed
 * iframe with no allow-scripts.
 *
 * Gmail nests parts arbitrarily deep (multipart/mixed > multipart/alternative
 * > text/html). The old version only looked one level down and therefore
 * showed "(no content)" for any mail with an attachment.
 */
function extractBody(full) {
  // Headers needed to REPLY correctly, not just to display.
  //
  // Without Message-ID and References a reply arrives as a brand-new
  // conversation in the recipient's client -- the single most visible way a
  // mail client looks broken, and invisible to the person sending it.
  const h = Object.create(null);
  for (const { name, value } of full.payload?.headers || []) {
    h[name.toLowerCase()] = value;
  }

  const out = {
    id: full.id,
    threadId: full.threadId,
    html: '',
    text: '',
    attachments: [],
    // Inline parts referenced by the HTML as `cid:`. Kept separate from
    // `attachments` so they do not appear as download chips: they are part of
    // the message body, not things the user attached.
    inline: [],
    // For threading and for pre-filling reply-all.
    messageId: h['message-id'] || '',
    references: h.references || '',
    from: h.from || '',
    to: h.to || '',
    cc: h.cc || '',
    replyTo: h['reply-to'] || '',
    subject: h.subject || '',
    listUnsubscribe: h['list-unsubscribe'] || '',
  };
  walk(full.payload);
  return out;

  function walk(part) {
    if (!part) return;
    const mime = part.mimeType || '';
    const filename = part.filename || '';

    /*
     * INLINE vs ATTACHED.
     *
     * A part is inline when it carries a Content-ID that the HTML references,
     * or when it is explicitly `Content-Disposition: inline`. Those must NOT
     * become download chips -- a signature logo listed as an attachment is
     * noise, and it is why some clients show "3 attachments" on a message that
     * visibly has none.
     */
    const ph = Object.create(null);
    for (const { name, value } of part.headers || []) {
      ph[name.toLowerCase()] = value;
    }
    const contentId = (ph['content-id'] || '').trim().replace(/^<|>$/g, '');
    const disposition = (ph['content-disposition'] || '').toLowerCase();
    const isInline = mime.startsWith('image/') &&
      (!!contentId || disposition.startsWith('inline'));

    if (isInline && part.body?.attachmentId) {
      out.inline.push({
        contentId,
        filename,
        mimeType: mime,
        size: part.body.size || 0,
        attachmentId: part.body.attachmentId,
      });
    } else if (filename && part.body?.attachmentId) {
      out.attachments.push({
        filename,
        mimeType: mime,
        size: part.body.size || 0,
        attachmentId: part.body.attachmentId,
      });
    } else if (mime === 'text/html' && part.body?.data && !out.html) {
      out.html = b64url(part.body.data);
    } else if (mime === 'text/plain' && part.body?.data && !out.text) {
      out.text = b64url(part.body.data);
    }
    for (const child of part.parts || []) walk(child);
  }
}

/** Gmail returns base64url with no padding. atob wants base64 with padding. */
function b64url(data) {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  try {
    // Round-trip through bytes so UTF-8 (e.g. curly quotes, ₹) survives.
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

// ============================================================================
// SNOOZE WAKE
// ============================================================================

/**
 * Waking snoozed mail.
 *
 * MV3 SERVICE WORKERS ARE KILLED AGGRESSIVELY, so a `setTimeout` for
 * "tomorrow at 8am" does not survive: the worker is gone within seconds of
 * going idle. `chrome.alarms` is the only timer that persists, and its
 * minimum granularity is one minute.
 *
 * The alarm is therefore a NUDGE, not a guarantee. The real correctness comes
 * from `wakeDue()` being run on startup and on install as well: anything
 * overdue is delivered late rather than lost. A snooze that silently eats
 * mail is worse than no snooze at all.
 */
const WAKE_ALARM = 'bmm-wake';

async function wakeDue(now = Date.now()) {
  let all;
  try {
    all = await loadSnoozed(chrome.storage.local);
  } catch {
    return 0;
  }

  const ready = due(all, now);
  if (!ready.length) return 0;

  let labelId;
  try {
    labelId = await ensureLabel(SNOOZE_LABEL);
  } catch {
    // Not signed in, or offline. Leave the entries alone so the next sweep
    // retries; dropping them here is how mail goes missing.
    return 0;
  }

  let woke = 0;
  for (const id of ready) {
    try {
      await modify(id, ['INBOX', 'UNREAD'], [labelId]);
      await removeSnooze(id, chrome.storage.local);
      woke++;
    } catch {
      // One failure must not stop the rest, and the entry stays put so the
      // next sweep tries again.
    }
  }
  return woke;
}

/**
 * Point the alarm at the NEXT wake time.
 *
 * One alarm, re-aimed, rather than one alarm per snoozed message: alarms are a
 * shared, limited resource and a hundred snoozed messages should not mean a
 * hundred registrations.
 */
async function scheduleWake() {
  if (!chrome.alarms) return;
  const all = await loadSnoozed(chrome.storage.local);
  const times = Object.values(all)
    .map((v) => v?.at)
    .filter((t) => typeof t === 'number');
  if (!times.length) {
    await chrome.alarms.clear(WAKE_ALARM);
    return;
  }
  const next = Math.min(...times);
  // Never schedule in the past; Chrome fires those immediately and repeatedly.
  await chrome.alarms.create(WAKE_ALARM, { when: Math.max(next, Date.now() + 5000) });
}

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== WAKE_ALARM) return;
    await wakeDue();
    await scheduleWake(); // re-aim at whatever is next
  });
}

// The catch-up sweep. Both hooks, because onStartup does not fire when the
// extension is enabled mid-session or reloaded during development.
chrome.runtime.onStartup?.addListener(() => { wakeDue().then(scheduleWake); });
chrome.runtime.onInstalled?.addListener(() => { wakeDue().then(scheduleWake); });
