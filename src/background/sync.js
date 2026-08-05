/**
 * Sync orchestration.
 *
 * DESIGN: THE WORKER PULLS, THE APP DECIDES WHEN
 * ----------------------------------------------
 * The old version pushed: a background loop streamed messages into the store
 * as they arrived and every arrival re-rendered. The audit's own verdict was
 * that this was the main source of the lag.
 *
 * Here the app asks for one page at a time (`syncPage`). One page = one list
 * call + one batch call = exactly two HTTP round trips for 100 messages, and
 * on the app side exactly ONE store batch and therefore ONE render.
 *
 * The worker keeps no message state. MV3 kills the worker whenever it likes;
 * anything cached in a module variable here would be a heisenbug. The only
 * persisted thing is `historyId`, and that lives in chrome.storage.
 */

import { listIds, batchMetadata, history, profile, BATCH_SIZE } from './gmail.js';

const HISTORY_KEY = 'historyId';

export async function getHistoryId() {
  const { [HISTORY_KEY]: id } = await chrome.storage.local.get(HISTORY_KEY);
  return id || null;
}

export async function setHistoryId(id) {
  if (id) await chrome.storage.local.set({ [HISTORY_KEY]: String(id) });
}

/**
 * One page of the inbox, fully hydrated.
 *
 * @param {{pageToken?:string, max?:number, q?:string, labelIds?:string[]}} opts
 * @returns {Promise<{messages:object[], nextPageToken:string}>}
 */
export async function syncPage({ pageToken = '', max = BATCH_SIZE, q = '', labelIds } = {}) {
  const { ids, nextPageToken } = await listIds({
    pageToken,
    max: Math.min(max, BATCH_SIZE),
    q,
    labelIds: labelIds || (q ? [] : ['INBOX']),
  });
  if (ids.length === 0) return { messages: [], nextPageToken: '' };
  const messages = await batchMetadata(ids);
  // Only anchor the history cursor on the first page of a fresh sync — the
  // profile call is cheap and its historyId is the only one guaranteed to be
  // consistent with "everything we have just read".
  if (!pageToken) {
    try {
      const p = await profile();
      await setHistoryId(p.historyId);
    } catch {
      /* a missing cursor only costs us a full resync later */
    }
  }
  return { messages, nextPageToken };
}

/**
 * Delta sync since the stored cursor.
 *
 * Returns one of:
 *   { kind: 'delta', added:[msg], removed:[id], patched:[{id,unread,starred}] }
 *   { kind: 'resync' }   — cursor expired, caller must do a full syncPage run
 *   { kind: 'none' }     — no cursor yet
 */
export async function syncDelta() {
  const start = await getHistoryId();
  if (!start) return { kind: 'none' };

  const res = await history(start);
  if (res.tooOld) {
    await chrome.storage.local.remove(HISTORY_KEY);
    return { kind: 'resync' };
  }

  const addedIds = new Set();
  const removed = new Set();
  /** @type {Map<string,{id:string,unread?:boolean,starred?:boolean}>} */
  const patched = new Map();

  for (const h of res.changes) {
    for (const { message } of h.messagesAdded || []) {
      if ((message.labelIds || []).includes('INBOX')) addedIds.add(message.id);
    }
    for (const { message } of h.messagesDeleted || []) {
      removed.add(message.id);
      addedIds.delete(message.id);
    }
    for (const { message, labelIds } of h.labelsAdded || []) {
      const p = patched.get(message.id) || { id: message.id };
      if (labelIds.includes('UNREAD')) p.unread = true;
      if (labelIds.includes('STARRED')) p.starred = true;
      // Archiving = INBOX removed. Adding INBOX back means it is inbox again.
      patched.set(message.id, p);
    }
    for (const { message, labelIds } of h.labelsRemoved || []) {
      const p = patched.get(message.id) || { id: message.id };
      if (labelIds.includes('UNREAD')) p.unread = false;
      if (labelIds.includes('STARRED')) p.starred = false;
      if (labelIds.includes('INBOX')) removed.add(message.id);
      patched.set(message.id, p);
    }
  }

  const ids = [...addedIds].slice(0, BATCH_SIZE);
  const added = ids.length ? await batchMetadata(ids) : [];
  await setHistoryId(res.historyId);

  return {
    kind: 'delta',
    added,
    removed: [...removed],
    patched: [...patched.values()].filter((p) => 'unread' in p || 'starred' in p),
  };
}
