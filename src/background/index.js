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
import { getFull, modify, batchModify, trash, profile } from './gmail.js';
import { syncPage, syncDelta } from './sync.js';

/** Toolbar click: tell the content script in THIS tab to toggle. */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  if (!tab.url?.startsWith('https://mail.google.com/')) {
    // The takeover only means anything on Gmail. Rather than fail silently,
    // open Gmail — the user clearly wanted their mail.
    await chrome.tabs.create({ url: 'https://mail.google.com/' });
    return;
  }
  await toggleIn(tab.id);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-takeover') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id && tab.url?.startsWith('https://mail.google.com/')) {
    await toggleIn(tab.id);
  }
});

async function toggleIn(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'BMM_TOGGLE' });
  } catch {
    // Content script not injected yet — happens if the extension was just
    // installed and Gmail has not been reloaded. Say so rather than no-op.
    await chrome.scripting
      .executeScript({
        target: { tabId },
        files: ['src/takeover/content.js'],
      })
      .then(() => chrome.tabs.sendMessage(tabId, { type: 'BMM_TOGGLE' }))
      .catch(() => {});
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
    case 'SYNC_PAGE':
      return syncPage(msg.opts || {});
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
  const out = { id: full.id, threadId: full.threadId, html: '', text: '', attachments: [] };
  walk(full.payload);
  return out;

  function walk(part) {
    if (!part) return;
    const mime = part.mimeType || '';
    const filename = part.filename || '';
    if (filename && part.body?.attachmentId) {
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
