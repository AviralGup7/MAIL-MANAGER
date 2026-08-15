/**
 * Service worker.
 *
 * Deliberately thin. In MV3 the worker is killed aggressively, so anything
 * stateful here is a bug waiting to happen. Its jobs:
 *   - route the toolbar click / keyboard shortcut into the Gmail tab
 *   - own OAuth (the app iframe never sees a token)
 *   - proxy Gmail API calls
 */

import { signIn, signOut, isSignedIn, AUTH_RETRY_ALARM, runAuthRetry } from './auth.js';
import { bump, persistDiag } from './diag.js';
import { pickGmailTab } from './tab-pick.js';
import {
  getFull, modify, batchModify, trash, profile,
  buildMime, sendMessage, saveDraft, getDraftForMessage,
  listLabels, createLabel, getAttachment, ensureLabel, headerMap, normalise,
  _clearLabelCache, hydrateDraftAttachments,
} from './gmail.js';
import { classify } from '../classify/index.js';
import { selectNotifiable, mergeNotified, cardText } from './notify.js';
import { SNOOZE_LABEL } from '../shared/labels.js';
import { MAX_INLINE_BYTES, MAX_INLINE_PARTS, BULK_CHUNK } from '../shared/limits.js';
import { loadSnoozed, removeSnooze, due, nextWakeAt } from '../app/system/snooze.js';
// Pure queue helpers (state machine, backoff, normalisation). The RUNNER
// lives here in the worker now: one dispatcher for every tab (bug-hunt P1).
import { loadOutbox, saveOutbox, dueItems, markFailed, markUncertain, prioritizeDue, dispatchable } from '../app/compose/outbox.js';
import { syncPage, syncDelta, commitHistoryId } from './sync.js';
import { api } from './gmail.js';
// The MIME parser lives in its own module so the in-page fallback can reuse
// it without importing this file, which registers listeners at load.
import { extractBody, b64url } from './mime.js';

// Inline-image budget constants live in src/shared/limits.js now: the
// in-page fallback enforces the SAME budget, and two copies of a number
// like this are two copies of policy (bug-hunt #24).

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
  /* AUD-M2 (audit 2026-08-15): the first Gmail tab used to win outright,
     and Gmail query order is OPEN order — the session's account lost to
     whichever tab opened first. The takeover frame reports its /mail/u/N/
     (stored by the app as activeAuthUser); pickGmailTab prefers the match
     and keeps the first-tab law as the fallback, so an unknown or stale
     stamp degrades to exactly the old behavior. */
  const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
  const { activeAuthUser } = await chrome.storage.local
    .get('activeAuthUser')
    .catch(() => ({}));
  const existing = pickGmailTab(tabs, activeAuthUser);
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
  if (sender?.id !== chrome.runtime.id) return false;
  handle(msg)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => {
      /* AUD-C1 (2026-08-15): a silent renewal proved the browser's account
         moved. auth.js already ended its own session set; the label-id
         cache is this module's piece of account-scoped state, dropped here
         so ACCOUNT_CHANGED is never followed by a stale id. */
      if (String(err?.message || err).includes('ACCOUNT_CHANGED')) _clearLabelCache();
      sendResponse({ ok: false, error: String(err?.message || err) });
    });
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
        } catch (err) {
          /* AUD-M1 (audit 2026-08-15): the catch used to swallow EVERY
             failure class, so a network blip or a lapsed token resolving
             the label answered an EMPTY PAGE — the snoozed mailbox read as
             empty while offline, and the app then upserted that "truth".
             Only "could not create" is honest-empty (the label simply does
             not exist yet); everything else is reported as the failure it
             is, and the caller's real error path keeps the cached page. */
          if (!/Could not create/.test(String(err?.message || err))) throw err;
          return { messages: [], nextPageToken: '' };
        }
        delete opts.labelName;
      }
      return syncPage(opts);
    }
    case 'SYNC_DELTA':
      return syncDelta();
    case 'SYNC_COMMIT':
      return { historyId: await commitHistoryId(msg.historyId) };

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
      for (let i = 0; i < ids.length; i += BULK_CHUNK) {
        try {
          await batchModify(ids.slice(i, i + BULK_CHUNK), msg.add || [], msg.remove || []);
        } catch {
          failed.push(...ids.slice(i, i + BULK_CHUNK));
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
    case 'SEND': {
      // Preserved draft attachments are hydrated at the wire, not carried in
      // memory (bug-hunt P0). A part that cannot be recovered throws -- the
      // outbox surfaces that as a retryable failure instead of sending a
      // message silently missing its files.
      const draft = await hydrateDraftAttachments(msg.draft);
      return sendMessage(buildMime(draft), draft.threadId);
    }
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
      const body = extractBody(d.message);
      /*
       * PRESERVED ATTACHMENTS carry the id of the message that owns them
       * (bug-hunt P0): editing re-saves through a rebuilt MIME, and an entry
       * with no `data` must be refetchable or it silently disappears. The
       * bytes themselves stay server-side until send (see
       * hydrateDraftAttachments) -- chips need metadata, not megabytes.
       */
      body.attachments = (body.attachments || []).map((a) => ({
        ...a,
        messageId: body.id || msg.id,
      }));
      return { draftId: d.draftId, ...body };
    }
    case 'SAVE_DRAFT': {
      const draft = await hydrateDraftAttachments(msg.draft);
      return saveDraft(buildMime(draft), draft.threadId, msg.draftId);
    }

    // ---- outbox ----------------------------------------------------------
    /*
     * THE WORKER IS THE SOLE DISPATCHER (bug-hunt P1).
     *
     * The queue's state machine (held -> sending -> sent/failed) stays in
     * storage and in outbox.js's pure helpers, but the act of sending now has
     * exactly ONE owner. Two tabs flushing for themselves used to race on a
     * storage claim whose get-check-set is not atomic, and the prize for
     * winning that race is a duplicated email -- the worst failure mode of a
     * mail client. Every tab asks the worker to pump; the worker single-
     * flights, so the claim can no longer be contested.
     *
     * A crash mid-dispatch is covered by the existing semantics: a record
     * left in `sending` demotes to `failed` on next load, visible and
     * cancellable, never silently re-sent.
     */
    case 'OUTBOX_PUMP': {
      if (outboxPumping) return { sent: 0, failed: 0, skipped: true };
      outboxPumping = true;
      try {
        let items = await loadOutbox(chrome.storage.local);
        /* The session's identity ONCE per pump (AUD-C2): queued records
           carry their owner's accountEmail, and a record whose owner is not
           this session is skipped — left armed for the account that made
           the promise, never fired by the one that didn't. */
        const { accountEmail } = await chrome.storage.local.get('accountEmail');
        let wrongAccount = 0;
        // HELD FIRST (bug-hunt 43 #1): a fresh send must not wait behind a
        // backlog of automatic retries for a slot in the batch.
        const allDue = prioritizeDue(dueItems(items));
        if (allDue.length === 0) return { sent: 0, failed: 0, skipped: false };
        // Eligibility is decided BEFORE the batch slice. Foreign rows must not
        // consume all eight slots and permanently starve this account's mail.
        const blockedIds = allDue
          .filter((item) => !dispatchable(item, accountEmail))
          .map((item) => item.id);
        const eligible = allDue.filter((item) => dispatchable(item, accountEmail));
        wrongAccount = blockedIds.length;
        const due = eligible.slice(0, MAX_PUMP_BATCH);
        const more = eligible.length > due.length;

        let sent = 0;
        let failed = 0;
        // Which messages actually left: the activity log exists to answer
        // "what actually changed", and a send entry with no id cannot
        // (bug-hunt #27). Gmail's send response carries the message id.
        const sentIds = [];
        for (const item of due) {
          /*
           * CANCEL RACE (bug-hunt 43 #11): the queue was loaded once, but
           * cancel() writes to storage between iterations. An item the user
           * just cancelled must not be resurrected by this pump's next
           * saveOutbox -- re-check it against live storage before doing
           * anything with it.
           */
          const live = await loadOutbox(chrome.storage.local);
          if (!live.some((x) => x.id === item.id)) {
            items = items.filter((x) => x.id !== item.id);
            continue;
          }
          // Persist `sending` from the freshest queue snapshot. This preserves
          // rows enqueued while an earlier Gmail request was in flight instead
          // of overwriting storage with the pump's original snapshot.
          items = await loadOutbox(chrome.storage.local);
          items = items.map((x) => (x.id === item.id ? { ...x, state: 'sending' } : x));
          await saveOutbox(items, chrome.storage.local);
          try {
            // Preserved draft attachments hydrate at the wire (bug-hunt P0);
            // an unrecoverable part fails THIS item, loudly, not the batch.
            const draft = await hydrateDraftAttachments(item.draft);
            const res = await sendMessage(buildMime(draft), draft.threadId);
            // NAMESPACED per the PumpResult contract in outbox.js: `g:` marks
            // a real Gmail message id, distinct from the fallback's `q:` ids.
            if (res?.id) sentIds.push(`g:${res.id}`);
            items = await loadOutbox(chrome.storage.local);
            items = items.filter((x) => x.id !== item.id);
            sent++;
          } catch (err) {
            items = await loadOutbox(chrome.storage.local);
            items = items.map((x) => {
              if (x.id !== item.id) return x;
              return err?.code === 'OUTCOME_UNKNOWN'
                ? markUncertain(x, err)
                : markFailed(x, err?.message || err);
            });
            failed++;
          }
          await saveOutbox(items, chrome.storage.local);
        }
        return { sent, failed, skipped: false, sentIds, more,
          ...(wrongAccount ? { wrongAccount, blockedIds } : {}) };
      } finally {
        outboxPumping = false;
      }
    }

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
        // The DECLARED size is a pre-flight filter only -- a hostile part can
        // lie about it. The real enforcement happens on the fetched bytes
        // (bug-hunt #7): the base64 payload length tells the truth.
        if ((p.size || 0) > budget) continue;
        try {
          const dataUrl = await getAttachment(msg.messageId, p.attachmentId, p.mimeType);
          const b64 = String(dataUrl).slice(String(dataUrl).indexOf(',') + 1);
          const actual = Math.floor(b64.length * 3 / 4);
          if (actual > budget) continue; // fetched more than we can spend
          budget -= actual;
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
 * TEST SEAM (roadmap Phase 4 / bug-hunt 44 #58). The dispatch table used to
 * be verified only by source pins and emulations -- the real function never
 * executed in a test process. Exported so the worker's actual verb handler
 * runs under stubbed chrome/fetch; the underscore marks it as non-product.
 */
export const _testHandle = handle;




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
// Containment for CAN-SYNC-1: the notification sweep and the app used the
// same cursor, so observing mail in the background consumed changes the warm
// cache had not committed. Keep the alarm name for cleanup/migration, but do
// not run or schedule this consumer until it has an independent cursor or a
// transactional change journal.
const BACKGROUND_SYNC_ENABLED = false;

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
    } catch (err) {
      const message = String(err?.message || err);
      if (/Gmail (404|410)\b/.test(message)) {
        // The resource is permanently gone (or belongs to a different
        // account). Keeping it due would re-arm this alarm forever.
        await removeSnooze(id, chrome.storage.local);
      }
      // Transient/auth/network failures stay queued for the next real wake.
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
  /* AUD-L1 (audit 2026-08-15): the selection arithmetic moved to pure,
     pinned `nextWakeAt` in the snooze module. The old inline version
     filtered `typeof t === 'number'` — NaN passes that filter — so a
     damaged row reached alarms.create({when: NaN}) after the modify had
     already succeeded: an armed-looking snooze nothing could wake. */
  const at = nextWakeAt(all);
  if (at == null) {
    await chrome.alarms.clear(WAKE_ALARM);
    return;
  }
  await chrome.alarms.create(WAKE_ALARM, { when: at });
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
/* AUD-M3 (audit 2026-08-15): a sweep that outlives its own 15-minute slot
   was re-entered by the next alarm, and both runs read the SAME bgNotifiedIds
   before either wrote — the notify dedupe's read-modify-write was only ever
   safe inside a single turn. One flag, whole-run scope: the worker's async
   turns interleave, its runs must not. */
let bgSyncRunning = false;

async function backgroundSync() {
  if (bgSyncRunning) return; // overlapped runs notify twice; the next slot retries
  bgSyncRunning = true;
  try {
    await backgroundSyncRun();
  } finally {
    bgSyncRunning = false;
  }
}

async function backgroundSyncRun() {
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
  // setting back on cannot re-notify an already-seen message. The merge is
  // pure and pinned (mergeNotified, AUD-M3): freshest-first, capped,
  // duplicate-free even if the stored list was not.
  const merged = mergeNotified(fresh.map((m) => m.id), bgNotifiedIds);
  await chrome.storage.local.set({ bgNotifiedIds: merged }).catch(() => {});

  if (bgNotify === false) return;
  // A Gmail tab is already on screen: the user is looking at mail. A
  // notification on top of that is noise, not service.
  const open = await chrome.tabs.query({ url: 'https://mail.google.com/*' }).catch(() => []);
  if (open.length) return;

  bump('notifications', fresh.length); // AUD-Q1: the card count has a number
  for (const m of fresh) {
    await chrome.notifications
      .create(`bmm-${m.id}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        // Bug-hunt #50 scrubbed the SENDER; AUD-L2 (audit 2026-08-15)
        // found the subject riding unwashed — control chars and unbounded
        // length straight into the OS card. Both pass cardText now.
        title: `${m.category === 'augsd' ? 'AUGSD' : 'Academics'} — ${shortSender(m.from)}`,
        message: cardText(m.subject),
      })
      .catch(() => {});
  }
}

/** Display name, control-char-scrubbed and truncated (bug-hunt #50). */
function shortSender(from, max = 40) {
  // The gate is notify.js's cardText; this adds the name-or-fallback rule.
  return cardText(from, max) || 'BITS mail';
}

/** Single-flight guard for OUTBOX_PUMP: one dispatch loop at a time. */
let outboxPumping = false;

/** Per-run dispatch cap; see OUTBOX_PUMP. */
const MAX_PUMP_BATCH = 8;

function scheduleBackgroundSync() {
  if (!chrome.alarms) return;
  if (!BACKGROUND_SYNC_ENABLED) {
    void chrome.alarms.clear(SYNC_ALARM).catch(() => {});
    return;
  }
  void chrome.alarms
    .create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MIN })
    .catch(() => {});
}

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === WAKE_ALARM) {
      await wakeDue();
      await scheduleWake(); // re-aim at whatever is next
    } else if (alarm.name === SYNC_ALARM) {
      if (!BACKGROUND_SYNC_ENABLED) {
        await chrome.alarms.clear(SYNC_ALARM).catch(() => {});
        return;
      }
      // Guarded (bug-hunt #27): a throw inside the sweep -- a storage get
      // failing, say -- must not surface as an unhandled worker rejection.
      backgroundSync().catch(() => {});
      void persistDiag();
    } else if (alarm.name === AUTH_RETRY_ALARM) {
      /* AUD-M4 (audit 2026-08-15): the silent-renewal retry auth.js arms on
         AUTH_RENEW_TRANSIENT. Exactly one attempt (runAuthRetry frees the
         flag regardless), and the alarm never re-arms itself — a dead
         network is retried by the NEXT transient, not looped on this one. */
      await runAuthRetry();
    }
  });
}

chrome.notifications?.onClicked.addListener((id) => {
  // Clicking a background notification opens the takeover; the notification
  // is dismissed either way.
  chrome.notifications.clear(id).catch?.(() => {});
  void openGmailTab().catch((err) => {
    console.error('[BMM] could not open notification target:', err);
  });
});

// The catch-up sweep. Both hooks, because onStartup does not fire when the
// extension is enabled mid-session or reloaded during development.
chrome.runtime.onStartup?.addListener(() => {
  void wakeDue().then(scheduleWake).catch((err) => {
    console.error('[BMM] startup wake scheduling failed:', err);
  });
  scheduleBackgroundSync();
});
chrome.runtime.onInstalled?.addListener(() => {
  void wakeDue().then(scheduleWake).catch((err) => {
    console.error('[BMM] install wake scheduling failed:', err);
  });
  scheduleBackgroundSync();
});
