/**
 * In-page fallback for when the service worker will not start.
 *
 * WHY THIS EXISTS
 * ---------------
 * The extension has been unloadable in Chrome with
 * "Service worker registration failed. Status code: 2" -- an error naming no
 * file, no line and no cause. Five rounds of static analysis found nothing:
 * the manifest is byte-identical to a build that worked, and the worker's five
 * modules evaluate cleanly in a worker-like global at every commit.
 *
 * Whatever the cause turns out to be, the product should not be a brick while
 * it is being found. A mail client that cannot start is worth nothing; a mail
 * client running with degraded background features is worth almost everything.
 *
 * WHAT MAKES THIS POSSIBLE
 * ------------------------
 * Measured, not assumed: `handle()` in src/background/index.js is 158 lines
 * and uses **zero** chrome.* APIs. It is pure async dispatch over gmail.js,
 * auth.js and sync.js. The only genuinely worker-bound code in that file is:
 *
 *   toggleIn()      chrome.tabs / chrome.scripting / chrome.action
 *   4 event hooks   onClicked, onCommand, onAlarm, onStartup/onInstalled
 *
 * And app.html runs on the chrome-extension:// origin, whose CSP already
 * permits `connect-src https://gmail.googleapis.com https://oauth2.googleapis.com`.
 * So the page can do everything the worker does except run while closed.
 *
 * WHAT IS LOST WHEN THIS IS ACTIVE
 * --------------------------------
 *   - Snoozed mail does not wake on a timer. chrome.alarms is worker-only.
 *     It still wakes on the catch-up sweep the next time the app opens, so
 *     mail is delivered LATE rather than lost -- which is the same guarantee
 *     the worker's own comment claims for a killed worker.
 *   - The toolbar button and Alt+Shift+M do nothing; both are worker events.
 *     The takeover still opens from Gmail itself.
 *   - The OAuth token lives in this page rather than in the worker. Still the
 *     extension origin, never Gmail's -- so the boundary that matters (the
 *     token must not share a document with Google's own scripts) still holds.
 *
 * This is a fallback, not a replacement. It says so, loudly, in the UI.
 */

/** Verbs that genuinely cannot work without a worker. */
const WORKER_ONLY = new Set(['TOGGLE_TAKEOVER']);

let handler = null;
let loadError = null;

/**
 * Build the in-page verb handler.
 *
 * The background modules are imported DYNAMICALLY and only when the fallback
 * is actually needed. Importing them eagerly would pull the Gmail API layer
 * into every page load for a path that should normally never run.
 */
async function buildHandler() {
  if (handler || loadError) return handler;
  try {
    const [auth, gmail, sync, snooze] = await Promise.all([
      import('../background/auth.js'),
      import('../background/gmail.js'),
      import('../background/sync.js'),
      import('./snooze.js'),
    ]);
    handler = makeHandler({ auth, gmail, sync, snooze });
  } catch (err) {
    loadError = err;
    handler = null;
  }
  return handler;
}

/**
 * The verb table, mirroring `handle()` in the worker.
 *
 * Deliberately a SUBSET. Only the verbs whose implementations live entirely in
 * the imported modules are re-exposed; anything needing chrome.tabs or
 * chrome.scripting is refused by name rather than failing obscurely, so the
 * caller gets "this needs the background worker" instead of a TypeError.
 */
function makeHandler({ auth, gmail, sync, snooze }) {
  return async function handleInPage(msg) {
    const { type } = msg;

    switch (type) {
      case 'AUTH_STATUS': return { signedIn: await auth.isSignedIn() };
      case 'SIGN_IN': return auth.signIn();
      case 'SIGN_OUT': return auth.signOut();
      case 'PROFILE': return gmail.profile();

      case 'SYNC_PAGE': return sync.syncPage(msg.opts || {});
      case 'SYNC_DELTA': return sync.syncDelta(msg.historyId);

      case 'MARK_READ': return gmail.modify(msg.id, { removeLabelIds: ['UNREAD'] });
      case 'MARK_UNREAD': return gmail.modify(msg.id, { addLabelIds: ['UNREAD'] });
      case 'STAR':
        return gmail.modify(msg.id, msg.on
          ? { addLabelIds: ['STARRED'] }
          : { removeLabelIds: ['STARRED'] });
      case 'ARCHIVE': return gmail.modify(msg.id, { removeLabelIds: ['INBOX'] });
      case 'UNARCHIVE': return gmail.modify(msg.id, { addLabelIds: ['INBOX'] });
      case 'TRASH': return gmail.trash(msg.id, true);
      case 'UNTRASH': return gmail.trash(msg.id, false);
      case 'SPAM': return gmail.modify(msg.id, { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] });
      case 'NOT_SPAM': return gmail.modify(msg.id, { addLabelIds: ['INBOX'], removeLabelIds: ['SPAM'] });
      case 'BULK':
        return gmail.batchModify(msg.ids, {
          addLabelIds: msg.add || [], removeLabelIds: msg.remove || [],
        });

      case 'LIST_LABELS': return gmail.listLabels();
      case 'CREATE_LABEL': return gmail.createLabel(msg.name);
      case 'GET_ATTACHMENT': return gmail.getAttachment(msg.id, msg.attachmentId);
      case 'GET_DRAFT': return gmail.getDraftForMessage(msg.messageId);

      default:
        if (WORKER_ONLY.has(type)) {
          throw new Error(`${type} needs the background worker, which did not start.`);
        }
        throw new Error(
          `${type} is unavailable in fallback mode. The background worker did not start.`
        );
    }
  };
}

/**
 * Is the service worker alive?
 *
 * `chrome.runtime.sendMessage` with no receiver does NOT reject -- it invokes
 * the callback with `undefined` and sets `chrome.runtime.lastError`. Reading
 * that property is what suppresses the "Unchecked runtime.lastError" console
 * noise, so it is read deliberately here even though the value is discarded.
 *
 * A timeout guards the case where the worker exists but never replies, which
 * is indistinguishable from absence from the caller's point of view.
 */
export function probeWorker(timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (alive) => {
      if (settled) return;
      settled = true;
      resolve(alive);
    };

    const timer = setTimeout(() => done(false), timeoutMs);

    try {
      chrome.runtime.sendMessage({ type: 'AUTH_STATUS' }, (res) => {
        clearTimeout(timer);
        // Must be read, or Chrome logs an unchecked-error warning.
        const err = chrome.runtime.lastError;
        done(!err && !!res);
      });
    } catch {
      clearTimeout(timer);
      done(false);
    }
  });
}

/**
 * Run a verb in this page.
 *
 * Shaped to match what `send()` resolves to, so the caller cannot tell which
 * path served it apart from the verbs that are genuinely missing.
 */
export async function runInPage(type, extra = {}) {
  const h = await buildHandler();
  if (!h) {
    throw new Error(
      `Fallback could not start: ${loadError?.message || 'unknown error'}`
    );
  }
  return h({ type, ...extra });
}

/** Test seam: forget the memoised handler between boots. */
export function _resetFallback() {
  handler = null;
  loadError = null;
}
