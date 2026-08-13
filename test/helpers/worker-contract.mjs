/**
 * THE fake worker, defined ONCE (roadmap Phase 3 / bug-hunt 43 #39/#40).
 *
 * Both integration suites booted their own copy of this switch for a long
 * time, and every verb change had to be patched twice -- the halves had
 * already drifted (one knew about draft attachments, the other did not).
 * The suites now consume one contract: same verbs, same shapes, same
 * fail-injection knobs. A fix here lands in both suites at once.
 *
 * The knobs mirror the production behaviours worth emulating faithfully:
 *   - failVerbs        answer {ok:false} for a verb (rollback paths)
 *   - deadWorker is NOT here -- it is the transport's job (sendMessage),
 *     because Chrome's shape for a missing worker is about delivery.
 *   - draftAttachments GET_DRAFT carries preserved-attachment metadata
 *   - failHydration    the wire refetch fails permanently (stuck chain)
 *   - hydrate()        substitutes deterministic bytes for the refetch, so
 *                      tests can assert BYTES at the wire, not metadata.
 */

import { attemptsAfterFailure } from '../../src/app/compose/outbox.js';

export function makeFakeWorker({
  calls,
  storage,
  signedIn = true,
  messages = [],
  perLabel = false,
  emptyLabels = [],
  labels = [],
  bodyOverride = {},
  failVerbs = [],
  draftAttachments = false,
  failHydration = false,
}) {
/*
 * THE HARNESS HYDRATES LIKE THE WORKER (Phase 2 of the roadmap). The real
 * worker refetches preserved attachment bytes at the wire; the emulator
 * substitutes deterministic fake bytes so tests can assert that BYTES --
 * not just metadata -- reach the wire. `failHydration` turns the refetch
 * into the permanent-loss error, exercising the throw -> markFailed ->
 * stuck chain end to end.
 */
const hydrate = (draft) => {
  if (!draft || !Array.isArray(draft.attachments)) return draft;
  return {
    ...draft,
    attachments: draft.attachments.map((a) => {
      if (!a || typeof a.data === 'string') return a;
      if (failHydration) {
        throw new Error(`Cannot recover attachment \u201c${a.filename}\u201d: part is gone`);
      }
      return { ...a, data: Buffer.from(`bytes-of-${a.attachmentId}`).toString('base64') };
    }),
  };
};


  return function respond(msg) {
    /*
     * FAIL-INJECTION, so rollback paths can be exercised.
     *
     * Every optimistic action has a failure branch that rolls the local store
     * back, and none of them had a test: the harness always answered ok. A
     * rollback nobody exercises is a rollback nobody knows works -- and it is
     * exactly where the undo/failure interaction bug lived.
     */
    if (failVerbs.includes(msg.type)) {
      return { ok: false, error: `${msg.type} failed (injected)` };
    }
    switch (msg.type) {
      case 'AUTH_STATUS': return { ok: true, data: { signedIn } };
      case 'PROFILE': return { ok: true, data: { emailAddress: 'f20240294@pilani.bits-pilani.ac.in' } };
      case 'SYNC_PAGE': {
        if (msg.opts?.pageToken) return { ok: true, data: { messages: [], nextPageToken: '' } };
        if (!perLabel) return { ok: true, data: { messages, nextPageToken: '' } };
        // Distinct messages per mailbox, so a cross-mailbox leak is visible.
        const label = (msg.opts?.labelIds || [])[0] || msg.opts?.labelName || 'INBOX';
        // Some tests need a mailbox that is genuinely empty rather than one
        // holding three synthetic messages.
        if (emptyLabels.includes(label)) {
          return { ok: true, data: { messages: [], nextPageToken: '' } };
        }
        const tag = { INBOX: 'inbox', SENT: 'sent', TRASH: 'trash', SPAM: 'spam',
          DRAFT: 'draft', STARRED: 'star' }[label] || 'other';
        const out = Array.from({ length: 3 }, (_, i) => ({
          id: `${tag}${i}`, threadId: `t${tag}${i}`,
          // Sender encodes the mailbox, so a cross-store leak is detectable.
          from: `S${i} <${tag}${i}@pilani.bits-pilani.ac.in>`,
          subject: `${tag} message ${i}`, snippet: 's',
          date: Date.now() - i * 60000, unread: false, starred: false, labels: ['INBOX'],
        }));
        return { ok: true, data: { messages: out, nextPageToken: '' } };
      }
      case 'SYNC_DELTA':
        return { ok: true, data: { kind: 'delta', added: [], removed: [], patched: [] } };
      case 'GET_BODY':
        return {
          ok: true,
          data: { id: msg.id, html: '<p>body</p>', text: '', attachments: [], ...bodyOverride },
        };
      case 'GET_ATTACHMENT':
        return { ok: true, data: { dataUrl: 'data:application/pdf;base64,JVBER' } };
      case 'LIST_LABELS':
        return { ok: true, data: labels };
      case 'GET_DRAFT':
        // The worker resolves a MESSAGE id to a DRAFT id; the draftId is what
        // makes a re-save an update rather than a second copy.
        //
        // ATTACHMENTS ride along as METADATA (bug-hunt P0): filename/type/size
        // plus the ids needed to refetch the bytes at send. The harness also
        // records the metadata so tests can verify what the worker would have
        // hydrated.
        return {
          ok: true,
          data: {
            draftId: `d-${msg.id}`, to: 'someone@pilani.bits-pilani.ac.in',
            cc: '', bcc: '', subject: 'Half-written', text: 'Unfinished thought',
            threadId: msg.id,
            id: msg.id,
            attachments: draftAttachments ? [
              { filename: 'report.pdf', mimeType: 'application/pdf', size: 1234,
                attachmentId: 'att-1', messageId: msg.id },
            ] : [],
          },
        };
      case 'OUTBOX_PUMP': {
        /*
         * Emulate the worker's SOLE-OWNER pump (bug-hunt P1): the app no
         * longer dispatches per item, it asks the worker to drain the queue.
         * The harness reads the queue from storage, dispatches what is due,
         * and records one synthetic SEND per message -- what the worker would
         * hand to sendMessage -- so wire assertions stay honest.
         */
        const items = Array.isArray(storage.outbox) ? storage.outbox : [];
        const now = Date.now();
        let sent = 0;
        let failed = 0;
        const sentIds = [];
        const next = [];
        // HELD FIRST, like the production pump (bug-hunt 43 #1).
        const due = items.filter((it) =>
          (it.state === 'held' && (it.releaseAt || 0) <= now) ||
          (it.state === 'failed' && (it.attempts || 0) < 4 && (it.nextAttempt || 0) <= now));
        due.sort((a, b) => ((a.state === 'held' ? 0 : 1) - (b.state === 'held' ? 0 : 1)));
        const notDue = items.filter((it) => !due.includes(it));
        next.push(...notDue);
        for (const it of due) {
          if (failVerbs.includes('SEND') || failVerbs.includes('OUTBOX_PUMP')) {
            next.push({
              ...it, state: 'failed', attempts: (it.attempts || 0) + 1,
              nextAttempt: now + 15000, error: 'injected',
            });
            failed++;
            continue;
          }
          // HYDRATE AT THE WIRE, as the worker does (bug-hunt P0). A failed
          // refetch mirrors markFailed, including the same-error-twice
          // short-circuit to stuck (bug-hunt 43 #33).
          let draft;
          try {
            draft = hydrate(it.draft);
          } catch (err) {
            const message = String(err.message).slice(0, 200);
            // The SAME predicate the runner uses (roadmap Phase 4): the
            // harness no longer carries its own copy of the failure rules.
            const attempts = attemptsAfterFailure(it, String(err.message));
            next.push({ ...it, state: 'failed', attempts, nextAttempt: now + 15000, error: message });
            failed++;
            continue;
          }
          calls.push({ type: 'SEND', draft });
          sentIds.push(`g:sent-${it.id}`); // g: prefix per the PumpResult contract
          sent++;
        }
        storage.outbox = next;
        return { ok: true, data: { sent, failed, skipped: false, sentIds } };
      }
      case 'SAVE_DRAFT': {
        // The worker hydrates preserved attachments before building the MIME;
        // mutate the recorded draft in place so wire assertions see the bytes.
        try {
          Object.assign(msg.draft, hydrate(msg.draft));
          return { ok: true, data: { draftId: msg.draftId || 'd-new' } };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      }
      default: return { ok: true, data: {} };
    }
  };
}
