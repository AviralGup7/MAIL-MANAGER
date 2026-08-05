/**
 * Service worker.
 *
 * Deliberately thin. In MV3 the worker is killed aggressively, so anything
 * stateful here is a bug waiting to happen. Its jobs:
 *   - route the toolbar click / keyboard shortcut into the Gmail tab
 *   - own OAuth (the app iframe never sees a token)
 *   - proxy Gmail API calls
 */

import { signIn, signOut, getToken, isSignedIn } from './auth.js';

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
    case 'GMAIL':
      return gmail(msg.path, msg.init);
    default:
      throw new Error(`Unknown message: ${msg?.type}`);
  }
}

/** Thin authenticated fetch against the Gmail REST API. */
async function gmail(path, init = {}) {
  const token = await getToken();
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Gmail API ${res.status} on ${path}`);
  }
  return res.json();
}
