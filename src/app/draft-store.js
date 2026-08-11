import { STORAGE } from '../platform/storage.js';

/**
 * Local draft persistence and crash recovery.
 *
 * THE BUG THIS FIXES
 * ------------------
 * Before this, everything typed into the compose panel lived only in the DOM.
 * Closing the panel, reloading the extension, a service-worker restart or a
 * browser crash all discarded it with no warning and no recovery. That is
 * silent data loss, and the audit ranked it above most feature work for that
 * reason: a mail client that eats a half-written message is not trusted again.
 *
 * WHY LOCAL AND NOT JUST GMAIL DRAFTS
 * -----------------------------------
 * Gmail's draft API is the durable store, but it is a network call: it is slow
 * (200-600ms), it fails offline, and firing one on every keystroke would be
 * abusive. So there are two tiers:
 *
 *   LOCAL  — debounced, every ~800ms, into chrome.storage.local. Cheap,
 *            synchronous-feeling, works offline. This is what survives a
 *            crash.
 *   REMOTE — Gmail's own draft, saved on an explicit action and on close.
 *            This is what survives the machine.
 *
 * This module owns the local tier only.
 *
 * ONE SLOT, NOT MANY. The compose panel is single-instance, so a keyed
 * collection of drafts would model a concurrency that cannot happen and would
 * quietly accumulate orphans. One slot, cleared on send or explicit discard.
 */

const KEY = 'composeDraft';

/** How long after the last keystroke to write. */
export const AUTOSAVE_MS = 800;

/** True when there is anything worth saving. */
export function isMeaningful(draft) {
  if (!draft) return false;
  return !!(
    draft.to?.trim() ||
    draft.cc?.trim() ||
    draft.subject?.trim() ||
    // A reply pre-fills the quoted original; that alone is not "typed
    // something". Compare against what the panel opened with.
    (draft.body || '').trim() !== (draft.baseBody || '').trim()
  );
}

export async function saveDraft(draft, storage = STORAGE, now = Date.now()) {
  try {
    await storage.set({ [KEY]: { ...draft, savedAt: now } });
    return true;
  } catch {
    // Quota or private mode. The in-memory panel is unaffected; the user
    // simply has no crash protection this session.
    return false;
  }
}

export async function loadDraft(storage = STORAGE) {
  try {
    const got = (await storage.get(KEY)) || {};
    const d = got[KEY];
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    // A draft with nothing in it is not worth offering to restore.
    return isMeaningful(d) ? d : null;
  } catch {
    return null;
  }
}

export async function clearDraft(storage = STORAGE) {
  try {
    await storage.remove(KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * A debounced autosaver.
 *
 * Mirrors `cache.js`'s `createSaver` deliberately: same shape, same `flush()`
 * contract, so there is one idea of "debounced persistence" in this codebase
 * rather than two that behave subtly differently.
 *
 * `flush()` is the important part. It is called on `pagehide`, where a
 * debounced timer would never fire because the page is already going away.
 */
export function createDraftSaver(collect, storage = STORAGE, opts = {}) {
  const delay = opts.delayMs ?? AUTOSAVE_MS;
  const setT = opts.setTimeout ?? setTimeout;
  const clearT = opts.clearTimeout ?? clearTimeout;
  let timer = null;
  let lastSerialised = null;

  async function write() {
    const draft = collect();
    if (!isMeaningful(draft)) return false;

    // Skip identical writes. Moving the caret fires input events on some
    // platforms, and rewriting the same bytes every 800ms is pure waste.
    const ser = JSON.stringify(draft);
    if (ser === lastSerialised) return false;
    lastSerialised = ser;

    return saveDraft(draft, storage);
  }

  return {
    schedule() {
      if (timer) clearT(timer);
      timer = setT(() => {
        timer = null;
        write();
      }, delay);
    },
    /** Write now, cancelling any pending debounce. */
    async flush() {
      if (timer) {
        clearT(timer);
        timer = null;
      }
      return write();
    },
    /** Forget the slot entirely — after a send, or an explicit discard. */
    async discard() {
      if (timer) {
        clearT(timer);
        timer = null;
      }
      lastSerialised = null;
      return clearDraft(storage);
    },
    get pending() {
      return timer !== null;
    },
  };
}
