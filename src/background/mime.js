/**
 * Pulling a displayable body out of Gmail's MIME tree.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * It used to live in src/background/index.js, which is fine while the only
 * caller is the service worker. It stopped being fine when the app needed an
 * in-page fallback for browsers where the worker will not register (Brave,
 * currently).
 *
 * index.js cannot simply be imported by a page: it registers six chrome.*
 * listeners at module load. Importing it to borrow one pure function would
 * attach a second set of handlers to the page, which is a worse bug than the
 * one being fixed.
 *
 * So the pure part moves here. No imports, no chrome.* access, no side
 * effects at load -- safe from the worker and from a page. index.js and
 * fallback.js both import it, which also means one MIME parser rather than
 * two that drift.
 */

// The header lookup lives in gmail.js, which is a pure API wrapper with no
// listeners, so importing it here is safe from both the worker and a page.
import { headerMap } from './gmail.js';

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
export function extractBody(full) {
  // Headers needed to REPLY correctly, not just to display.
  //
  // Without Message-ID and References a reply arrives as a brand-new
  // conversation in the recipient's client -- the single most visible way a
  // mail client looks broken, and invisible to the person sending it.
  const h = headerMap(full.payload?.headers);

  const out = {
    id: full.id,
    threadId: full.threadId,
    html: '',
    text: '',
    attachments: [],
    // Inline parts referenced by the HTML as `cid:`. Kept separate from
    // `attachments` so they do not appear as download chips: they are part of
    // the message body, not things the user attached.
    inline: [],
    // For threading and for pre-filling reply-all.
    messageId: h['message-id'] || '',
    references: h.references || '',
    from: h.from || '',
    to: h.to || '',
    cc: h.cc || '',
    replyTo: h['reply-to'] || '',
    subject: h.subject || '',
    // internalDate is authoritative; the Date: header is sender-controlled and
    // routinely wrong. Needed for the reply attribution line.
    date: Number(full.internalDate) || Date.parse(h.date) || 0,
    listUnsubscribe: h['list-unsubscribe'] || '',
  };
  walk(full.payload, 0);
  return out;

  /**
   * @param {any} part        Gmail payload node — its shape is Gmail's
   * @param {number} depth
   *
   * DEPTH IS BOUNDED, AND THIS WAS A REAL DENIAL OF SERVICE.
   *
   * `walk` recursed with no limit. A message whose MIME tree nests ~5000 deep
   * overflows the stack, and this runs in the SERVICE WORKER handling
   * GET_BODY -- so one crafted message killed the worker, taking snooze
   * wake-ups and the toolbar shortcut with it until Chrome restarted it. The
   * body is entirely sender-controlled, so the trigger is "someone mails you".
   *
   * Measured before fixing: fine at 2000, overflow at 5000. Real mail nests
   * three to five deep (mixed > alternative > related > text), so 64 is two
   * orders of magnitude of headroom over anything legitimate.
   *
   * A cyclic tree -- which the Gmail API should never produce, but which costs
   * nothing to defend against -- is caught by the same bound.
   */
  function walk(part, depth) {
    if (!part || depth > 64) return;
    const mime = part.mimeType || '';
    const filename = part.filename || '';

    /*
     * INLINE vs ATTACHED.
     *
     * A part is inline when it carries a Content-ID that the HTML references,
     * or when it is explicitly `Content-Disposition: inline`. Those must NOT
     * become download chips -- a signature logo listed as an attachment is
     * noise, and it is why some clients show "3 attachments" on a message that
     * visibly has none.
     */
    const ph = headerMap(part.headers);
    const contentId = (ph['content-id'] || '').trim().replace(/^<|>$/g, '');
    const disposition = (ph['content-disposition'] || '').toLowerCase();
    const isInline = mime.startsWith('image/') &&
      (!!contentId || disposition.startsWith('inline'));

    if (isInline && part.body?.attachmentId) {
      out.inline.push({
        contentId,
        filename,
        mimeType: mime,
        size: part.body.size || 0,
        attachmentId: part.body.attachmentId,
      });
    } else if (filename && part.body?.attachmentId) {
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
    /*
     * BREADTH IS DELIBERATELY *NOT* BOUNDED, AND THAT DECISION WAS MEASURED.
     *
     * A 500-part cap was added here on the theory that a shallow-but-huge tree
     * is the same denial of service without the recursion. Sabotage showed the
     * cap was doing nothing a test could detect, so it was measured properly:
     * a ONE MILLION part tree walks in 92ms without it. That is not a hang.
     *
     * Against that, the cap had a real cost: a legitimate message with 600
     * parts would silently lose the last hundred attachments, with no error
     * anywhere. Dropping a user's attachments to save 90ms on an attack that
     * does not work is the wrong trade, so the cap is gone.
     *
     * Depth is different and stays bounded -- recursion overflows the stack and
     * kills the worker, which is a real failure with a real trigger.
     */
    for (const child of part.parts || []) walk(child, depth + 1);
  }
}

/** Gmail returns base64url with no padding. atob wants base64 with padding. */
export function b64url(data) {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  try {
    // Round-trip through bytes so UTF-8 (e.g. curly quotes, INR) survives.
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}
