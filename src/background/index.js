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
