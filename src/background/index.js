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
  buildMime, sendMessage, saveDraft, getDraftForMessage,
  listLabels, createLabel, getAttachment, ensureLabel, headerMap, normalise,
  _clearLabelCache,
} from './gmail.js';
import { classify } from '../classify/index.js';
import { selectNotifiable } from './notify.js';
import { SNOOZE_LABEL } from '../shared/labels.js';
import { loadSnoozed, removeSnooze, due } from '../app/snooze.js';
import { syncPage, syncDelta } from './sync.js';
import { api } from './gmail.js';
// The MIME parser lives in its own module so the in-page fallback can reuse
// it without importing this file, which registers listeners at load.
import { extractBody, b64url } from './mime.js';

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
chrome.runtime.onInstalled?.addListener(async () => {
  const manifest = chrome.runtime.getManifest();
  const problems = [];

  if (!chrome.scripting) problems.push('chrome.scripting unavailable -- "scripting" permission missing');
  if (!(manifest.host_permissions || []).some((h) => h.includes('mail.google.com'))) {
    problems.push('no host permission for mail.google.com -- tab.url will be undefined');
  }

  const commands = await chrome.commands.getAll().catch(() => []);
  for (const c of commands) {
    // An empty shortcut means the browser refused it, usually a collision.
    if (c.name === 'toggle-takeover' && !c.shortcut) {
      problems.push(
        'the keyboard shortcut is unassigned -- set one at chrome://extensions/shortcuts'
      );
    }
  }

  if (problems.length) {
    console.warn('[BMM] startup problems:\n  - ' + problems.join('\n  - '));
  } else {
    console.info('[BMM] ready. Shortcut:', commands.find((c) => c.name === 'toggle-takeover')?.shortcut || '(none)');
  }
});

/*
 * Toolbar click: tell the content script in THIS tab to toggle.
 *
 * WHY THIS IS OPTIONAL-CHAINED, when the manifest declares `action`.
 *
 * A top-level `chrome.action.onClicked.addListener(...)` throws a TypeError
 * during module evaluation if `chrome.action` is undefined -- and that aborts
 * the WHOLE service worker. Chrome reports it as
 * "Service worker registration failed. Status code: 2", which names no file,
 * no line and no cause.
 *
 * `chrome.action` is undefined whenever the manifest's `action` key is absent
 * or malformed, which is easy to do by hand-editing and impossible to
 * diagnose from the error. The cost of one `?.` is nothing; the cost of the
 * unguarded form is an extension that appears completely dead. Every other
 * capability here already degrades rather than crashing -- see the alarms
 * block below, which has been guarded from the start.
 */
/**
 * Open the takeover in a Gmail tab, reusing an existing one.
 *
 * Shared by the toolbar button and notification clicks. Preferring an
 * existing tab over spawning a new one matters: repeated spawns resolved to
 * the browser's default account rather than the one the user was reading.
 */
async function openGmailTab() {
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
}

chrome.action?.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  if (isGmail(tab)) {
    await toggleIn(tab.id);
    return;
  }
  await openGmailTab();
});

// Same reasoning as chrome.action above: a missing `commands` key must cost
// the shortcut, not the entire worker.
chrome.commands?.onCommand.addListener(async (command) => {
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
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Cross-audit hardening: only first-party extension contexts may reach the
  // verb router. Anything else gets silence, not an error surface.
  if (sender?.id && sender.id !== chrome.runtime.id) return false;
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
      // Label ids are ACCOUNT-scoped (V2 P1-12). A different Google account
      // signing in within this worker's lifetime must never be handed the
      // previous account's ids -- that is a 404 at best, a silent write to
      // the wrong label space at worst. The cache goes with the account.
      _clearLabelCache();
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
    case 'BULK': {
      /*
       * CHUNK AT GMAIL'S 1000-ID LIMIT, RECONCILE PER CHUNK (cross-audit H6).
       * A 1200-message selection used to 400 as one request and roll the
       * whole operation back. Now each chunk stands alone: successes stay,
       * the failure report names exactly what didn't apply, and the app
       * restores only those.
       */
      const ids = msg.ids || [];
      // An empty selection is a no-op, not "failed for all messages" — the
      // app never sends one, but a stale click or a race that already
      // applied the action elsewhere must not surface as an error.
      if (ids.length === 0) return { failed: [] };
      const failed = [];
      for (let i = 0; i < ids.length; i += 1000) {
        try {
          await batchModify(ids.slice(i, i + 1000), msg.add || [], msg.remove || []);
        } catch {
          failed.push(...ids.slice(i, i + 1000));
        }
      }
      if (failed.length === ids.length) throw new Error('bulk action failed for all messages');
      return { failed };
    }
    case 'UNARCHIVE':
      // The inverse of archive, for undo. Gmail has no such button.
      return modify(msg.id, ['INBOX'], []);
    case 'UNTRASH':
      return api(`/messages/${encodeURIComponent(msg.id)}/untrash`, { method: 'POST' });

    /*
     * SPAM. Core mail triage that was missing entirely: you could BROWSE the
     * spam mailbox but not report a message into it, and not rescue one out.
     *
     * Reporting removes INBOX as well as adding SPAM. Gmail's own UI does the
     * same -- a message left in both places shows up in the inbox while
     * claiming to be spam, which is the worst of both.
     *
     * Rescuing restores INBOX, because a false positive you have to go and
     * re-file by hand is only half a rescue.
     */
    case 'SPAM':
      return modify(msg.id, ['SPAM'], ['INBOX']);
    case 'NOT_SPAM':
      return modify(msg.id, ['INBOX'], ['SPAM']);

    // ---- compose ---------------------------------------------------------
    case 'SEND':
      return sendMessage(buildMime(msg.draft), msg.draft.threadId);
    /*
     * Open a draft for editing. The Drafts mailbox is fetched by label, so the
     * app has a MESSAGE id and the drafts API wants a DRAFT id -- see
     * getDraftForMessage. Without this a draft could be listed and never
     * opened, which is where the product was.
     */
    case 'GET_DRAFT': {
      const d = await getDraftForMessage(msg.id);
      if (!d) return null;
      // Parsed HERE, beside extractBody, which already knows how to read a
      // Gmail payload. A second parser is how two readers drift apart.
      return { draftId: d.draftId, ...extractBody(d.message) };
    }
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
/** Background sync + notification sweep. See `backgroundSync`. */
const SYNC_ALARM = 'bmm-sync';
const SYNC_PERIOD_MIN = 15;

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
  // Reduce, not spread: a thousand snoozed messages would overflow the
  // argument list. Loop is O(n) either way and cannot throw.
  let next = Infinity;
  for (const t of times) if (t < next) next = t;
  // Never schedule in the past; Chrome fires those immediately and repeatedly.
  await chrome.alarms.create(WAKE_ALARM, { when: Math.max(next, Date.now() + 5000) });
}

/**
 * The background sweep (P-3 / repo TODO #5).
 *
 * Every 15 minutes, while the app may be closed: advance the history cursor
 * so a long absence never builds a delta backlog that forces a resync, and —
 * when the user opted in — notify on augsd/academics mail arriving in the
 * meantime. The worker is deliberately stateless, so the sweep writes
 * nothing but the cursor and the dedupe list; the app still paints from its
 * own cache + full sync when it opens.
 */
async function backgroundSync() {
  if (!(await isSignedIn().catch(() => false))) return;

  let res;
  try {
    res = await syncDelta();
  } catch {
    return; // quiet: the next 15-minute run retries; the freshness line in
    // the app is the honest status surface.
  }
  if (!res || res.kind !== 'delta' || !res.added?.length) return;

  const { bgNotify = true, bgNotifiedIds = [] } = await chrome.storage.local.get([
    'bgNotify', 'bgNotifiedIds',
  ]);

  const msgs = res.added.map(normalise).filter(Boolean).map((m) => ({
    ...m,
    category: classify(m).category,
  }));
  const fresh = selectNotifiable(msgs, bgNotifiedIds);
  if (!fresh.length) return;

  // Dedupe persists even when notifications are off, so toggling the
  // setting back on cannot re-notify an already-seen message.
  const merged = [...fresh.map((m) => m.id), ...(bgNotifiedIds || [])].slice(0, 100);
  await chrome.storage.local.set({ bgNotifiedIds: merged }).catch(() => {});

  if (bgNotify === false) return;
  // A Gmail tab is already on screen: the user is looking at mail. A
  // notification on top of that is noise, not service.
  const open = await chrome.tabs.query({ url: 'https://mail.google.com/*' }).catch(() => []);
  if (open.length) return;

  for (const m of fresh) {
    await chrome.notifications
      .create(`bmm-${m.id}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: `${m.category === 'augsd' ? 'AUGSD' : 'Academics'} — ${m.from || 'BITS mail'}`,
        message: m.subject,
      })
      .catch(() => {});
  }
}

function scheduleBackgroundSync() {
  if (!chrome.alarms) return;
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MIN }).catch?.();
}

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === WAKE_ALARM) {
      await wakeDue();
      await scheduleWake(); // re-aim at whatever is next
    } else if (alarm.name === SYNC_ALARM) {
      backgroundSync();
    }
  });
}

chrome.notifications?.onClicked.addListener((id) => {
  // Clicking a background notification opens the takeover; the notification
  // is dismissed either way.
  chrome.notifications.clear(id).catch?.(() => {});
  openGmailTab();
});

// The catch-up sweep. Both hooks, because onStartup does not fire when the
// extension is enabled mid-session or reloaded during development.
chrome.runtime.onStartup?.addListener(() => {
  wakeDue().then(scheduleWake);
  scheduleBackgroundSync();
});
chrome.runtime.onInstalled?.addListener(() => {
  wakeDue().then(scheduleWake);
  scheduleBackgroundSync();
});
