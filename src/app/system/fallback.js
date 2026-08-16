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

import { MAX_INLINE_BYTES, MAX_INLINE_PARTS, BULK_CHUNK } from '../../shared/limits.js';
/* The storage seam (ARCH-R2-1). This module reached `chrome.storage.local`
   directly while the seam existed for exactly that; `localArea()` resolves the
   area at CALL time, so the harness swapping globalThis.chrome per boot keeps
   working, and STORAGE is the same area behind a live-binding proxy. */
import { STORAGE, localArea } from '../../platform/storage.js';

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
    const [auth, gmail, sync, snooze, outbox, mime] = await Promise.all([
      import('../../background/auth.js'),
      import('../../background/gmail.js'),
      import('../../background/sync.js'),
      import('../../features/snooze/model.js'),
      import('../../features/outbox/model.js'),
      import('../../background/mime.js'),
    ]);
    handler = makeHandler({ auth, gmail, sync, snooze, outbox, mime });
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
function makeHandler({ auth, gmail, sync, snooze, outbox, mime }) {
  /* Same ACCOUNT_CHANGED duty as the worker router (AUD-C1): auth.js ends
     its own set; the label cache is the account-scoped piece THIS context
     owns, and the page-context gmail.js instance has its own. */
  const clearOnAccountChange = (err) => {
    if (String(err?.message || err).includes('ACCOUNT_CHANGED')) gmail._clearLabelCache();
    throw err;
  };
  return async function handleInPage(msg) {
    return dispatch(msg).catch(clearOnAccountChange);
  }

  async function dispatch(msg) {
    const { type } = msg;
    switch (type) {
      case 'AUTH_STATUS': return { signedIn: await auth.isSignedIn() };
      case 'SIGN_IN': return auth.signIn();
      case 'SIGN_OUT': {
        await auth.signOut();
        // Label ids are account-scoped (bug-hunt #22): the worker's handler
        // clears its cache at this moment; the in-page path must too, or a
        // different account signing in inherits the previous one's ids.
        gmail._clearLabelCache();
        return { signedIn: false };
      }
      case 'PROFILE': return gmail.profile();

      case 'SYNC_PAGE': {
        // Keep the fallback contract identical to the worker router. syncPage
        // accepts label IDs, not the user-facing labelName used by Snoozed.
        // Passing labelName through silently falls back to INBOX.
        const opts = { ...(msg.opts || {}) };
        if (opts.labelName) {
          try {
            opts.labelIds = [await gmail.ensureLabel(opts.labelName)];
          } catch (err) {
            if (!/Could not create/.test(String(err?.message || err))) throw err;
            return { messages: [], nextPageToken: '' };
          }
          delete opts.labelName;
        }
        return sync.syncPage(opts);
      }
      // syncDelta() takes NO arguments -- it reads the cursor from storage.
      // Passing one suggested a contract the function does not have
      // (bug-hunt #23).
      case 'SYNC_DELTA': return sync.syncDelta();
      case 'SYNC_COMMIT': return { historyId: await sync.commitHistoryId(msg.historyId) };

      /*
       * SIGNATURES MATTER, AND I GOT THEM WRONG FIRST TIME.
       *
       * gmail.js uses POSITIONAL arrays:
       *   modify(id, addLabelIds = [], removeLabelIds = [])
       *   batchModify(ids, addLabelIds = [], removeLabelIds = [])
       *   trash(id)                       -- no second argument
       *
       * The first version of this file passed `{ removeLabelIds: [...] }`
       * objects, copying the shape of the Gmail REST body rather than the
       * shape of our own wrapper. Every mutation would have been a silent
       * no-op: the request goes out with no labels to change, Gmail returns
       * 200, and the optimistic UI update stands while the server never
       * moved. Read as "it works" until a reload put everything back.
       *
       * Mirrored from src/background/index.js verb for verb.
       */
      case 'MARK_READ': return gmail.modify(msg.id, [], ['UNREAD']);
      case 'MARK_UNREAD': return gmail.modify(msg.id, ['UNREAD'], []);
      case 'STAR':
        return gmail.modify(msg.id, msg.on ? ['STARRED'] : [], msg.on ? [] : ['STARRED']);
      case 'ARCHIVE': return gmail.modify(msg.id, [], ['INBOX']);
      case 'UNARCHIVE': return gmail.modify(msg.id, ['INBOX'], []);
      case 'TRASH': return gmail.trash(msg.id);
      case 'UNTRASH':
        return gmail.api(`/messages/${encodeURIComponent(msg.id)}/untrash`, { method: 'POST' });
      case 'SPAM': return gmail.modify(msg.id, ['SPAM'], ['INBOX']);
      case 'NOT_SPAM': return gmail.modify(msg.id, ['INBOX'], ['SPAM']);
      case 'BULK': {
        /*
         * SAME CONTRACT AS THE WORKER (bug-hunt #21): chunk at Gmail's
         * 1000-id limit and answer `{ failed }`, because reconcileBulk on
         * the app side restores exactly those ids. The old shape (one raw
         * request, raw 204 back) 400'd past a thousand ids and gave the
         * reconciler nothing to work with.
         */
        const ids = msg.ids || [];
        if (ids.length === 0) return { failed: [] };
        const failed = [];
        for (let i = 0; i < ids.length; i += BULK_CHUNK) {
          try {
            await gmail.batchModify(ids.slice(i, i + BULK_CHUNK), msg.add || [], msg.remove || []);
          } catch {
            failed.push(...ids.slice(i, i + BULK_CHUNK));
          }
        }
        if (failed.length === ids.length) throw new Error('bulk action failed for all messages');
        return { failed };
      }

      /*
       * READING A MESSAGE. Without this the fallback lists mail and cannot
       * open it, which is not a mail client.
       *
       * Uses the SAME parser as the worker. `extractBody` was moved out of
       * index.js into mime.js precisely so this could reuse it: index.js
       * registers six chrome.* listeners at load, so importing it from a page
       * to borrow one pure function would attach a second set of handlers.
       * One parser, two callers, no drift.
       */
      case 'GET_BODY': return mime.extractBody(await gmail.getFull(msg.id));

      /*
       * INLINE IMAGES degrade rather than fail.
       *
       * The worker fetches each cid: part and inlines it as a data URI under
       * a byte budget. Reimplementing that here would be a second copy of a
       * budgeted loop for a cosmetic feature. Returning an empty list means
       * the message renders with its inline images missing, which is exactly
       * what happens today when a part is over budget -- a path the reader
       * already handles.
       */
      case 'SNOOZE': {
        // Capability parity with the worker (cross-audit H5): Gmail-side
        // label move in-page; the local schedule was already written by the
        // caller's optimistic() `before` hook.
        const labelId = await gmail.ensureLabel(snooze.SNOOZE_LABEL);
        await gmail.modify(msg.id, [labelId], ['INBOX']);
        return { ok: true };
      }
      case 'UNSNOOZE': {
        const labelId = await gmail.ensureLabel(snooze.SNOOZE_LABEL);
        await gmail.modify(msg.id, ['INBOX', 'UNREAD'], [labelId]);
        return { ok: true };
      }
      case 'WAKE_DUE':
        // Due snoozes are woken at boot and on every refresh in-page; the
        // verb degrades to a no-op rather than a silent hole.
        return { woke: 0 };
      case 'GET_INLINE': {
        // Parity with the worker (V2 code audit): silently empty inline
        // resolution made the fallback render image-less bodies forever.
        // Same bounds as the worker: part cap plus a byte budget.
        // Limits come from the shared seam, not literals (bug-hunt #24):
        // this path and the worker's must never drift apart.
        const parts = Array.isArray(msg.parts) ? msg.parts.slice(0, MAX_INLINE_PARTS) : [];
        const out = [];
        let budget = MAX_INLINE_BYTES;
        for (const part of parts) {
          if (!part?.attachmentId || !part?.contentId) continue;
          // Declared size is a pre-flight filter; the ACTUAL fetched bytes are
          // the enforcement (bug-hunt #7), exactly as in the worker.
          if ((part.size || 0) > budget) continue;
          try {
            const dataUrl = await gmail.getAttachment(msg.messageId || msg.id, part.attachmentId, part.mimeType);
            const b64 = String(dataUrl).slice(String(dataUrl).indexOf(',') + 1);
            const actual = Math.floor(b64.length * 3 / 4);
            if (actual > budget) continue;
            budget -= actual;
            out.push({ contentId: part.contentId, filename: part.filename || '', dataUrl });
          } catch { /* one bad part must not blank the body */ }
        }
        // { inline }, not a bare array (bug-hunt #20): the app reads
        // `res.inline`, so the old shape meant inline images rendered as
        // placeholders forever in fallback mode.
        return { inline: out };
      }

      /*
       * DEGRADED-MODE DISPATCH. When the worker is alive it is the sole
       * dispatcher (bug-hunt P1); when it is dead, this page runs the queue
       * itself with the existing claim guard -- a weaker, multi-tab-safe
       * fallback, because degraded mode already lost the stronger guarantee.
       */
      case 'OUTBOX_PUMP': {
        /* Owner gate parity with the worker pump (AUD-C2). */
        const { accountEmail } = (await STORAGE.get('accountEmail')) || {};
        return outbox.flushOutbox({
          send: async (draft) => {
            const d = await gmail.hydrateDraftAttachments(draft);
            return gmail.sendMessage(gmail.buildMime(d), d.threadId);
          },
          storage: localArea(),
          accountEmail,
        });
      }

      case 'LIST_LABELS': return gmail.listLabels();
      case 'CREATE_LABEL': return gmail.createLabel(msg.name);
      case 'GET_ATTACHMENT':
        // Same arg contract and response shape as the worker (V2 code audit).
        return { dataUrl: await gmail.getAttachment(msg.messageId || msg.id, msg.attachmentId, msg.mimeType) };
      case 'GET_DRAFT': {
        // Same shape as the worker: parsed beside extractBody, never a
        // second parser.
        const d = await gmail.getDraftForMessage(msg.id || msg.messageId);
        if (!d) return null;
        const body = mime.extractBody(d.message);
        // Preserved-attachment parity with the worker (bug-hunt P0): stamp
        // the owning message id so a re-save can refetch the bytes.
        body.attachments = (body.attachments || []).map((a) => ({
          ...a,
          messageId: body.id || msg.id,
        }));
        return { draftId: d.draftId, ...body };
      }

      // Compose verbs: the fallback used to lack the product's core mail
      // operations entirely (V2 C-class). Same builders as the worker.
      case 'SEND': {
        const draft = await gmail.hydrateDraftAttachments(msg.draft);
        return gmail.sendMessage(gmail.buildMime(draft), draft.threadId);
      }
      case 'SAVE_DRAFT': {
        const draft = await gmail.hydrateDraftAttachments(msg.draft);
        return gmail.saveDraft(gmail.buildMime(draft), draft.threadId, msg.draftId);
      }

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
