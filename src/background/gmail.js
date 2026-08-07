/**
 * Gmail REST layer. Lives in the service worker so the access token never
 * enters a document that renders untrusted mail HTML.
 *
 * WHY A REAL MULTIPART BATCH
 * --------------------------
 * Fetching 200 message headers one request at a time is 200 TLS round trips
 * and 200 chances to hit a per-request quota. Gmail's /batch endpoint takes up
 * to 100 sub-requests in ONE HTTP request. The old version used it too; this
 * is the one thing it got right about the network layer and it is carried over.
 *
 * We ask for `format=metadata` with an explicit header allow-list. That is a
 * fraction of the bytes of `format=full` and it is everything the list view
 * needs. Bodies are fetched lazily, one message at a time, only when the user
 * actually opens something.
 */

import { getToken } from './auth.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const BATCH_URL = 'https://gmail.googleapis.com/batch/gmail/v1';

/** Headers we need for the list view. Anything else is wasted bandwidth. */
const META_HEADERS = ['From', 'Subject', 'Date', 'List-Unsubscribe'];

/** Gmail's own limit. Do not raise it; the endpoint rejects >100. */
export const BATCH_SIZE = 100;

async function authHeaders(extra = {}) {
  const token = await getToken();
  return { Authorization: `Bearer ${token}`, ...extra };
}

/**
 * Statuses worth trying again.
 *
 * 429 is the important one and it is NOT an error condition here: Gmail
 * rate-limits per user, and a 100-message batch is a burst by definition, so a
 * healthy sync of a busy inbox produces these routinely. Treating one as fatal
 * showed the user `Gmail 429 /messages` and stopped the sync, and their only
 * recourse was Refresh, which reissued the same burst.
 *
 * 403 is deliberately NOT here. Gmail returns 403 both for `rateLimitExceeded`
 * (retryable) and for insufficient scope (never retryable), and retrying a
 * permissions failure three times just delays a clear error. It is
 * distinguished by body text below.
 */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** Cap on attempts, including the first. Keep small: the user is waiting. */
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * How long to wait before attempt N (1-indexed).
 *
 * Honours `Retry-After` when Google sends it -- guessing when we have been told
 * is how you get rate-limited harder. Otherwise exponential with jitter; the
 * jitter matters because several parallel batch requests will otherwise all
 * wake at the same instant and re-collide.
 */
function backoffMs(attempt, res) {
  const header = res?.headers?.get?.('Retry-After');
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs)) return Math.min(secs * 1000, 30_000);
    const when = Date.parse(header);
    if (!Number.isNaN(when)) return Math.max(0, Math.min(when - Date.now(), 30_000));
  }
  const base = 500 * 2 ** (attempt - 1); // 500, 1000, 2000
  return base + Math.random() * 250;
}

/** True for a 403 that is a quota problem rather than a permissions problem. */
function isQuota403(body) {
  return /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(body);
}

/**
 * Fetch with bounded retry. Shared by `api()` and the batch endpoint so both
 * behave identically under load.
 *
 * Returns the successful Response. Throws with the last status on give-up.
 */
async function fetchRetrying(url, init, label) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      // Network-level failure (offline, DNS, connection reset). Retryable.
      lastErr = new Error(`Network error on ${label}: ${err.message}`);
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(backoffMs(attempt, null));
      continue;
    }

    if (res.ok) return res;

    const body = await res.text().catch(() => '');
    const retryable = RETRYABLE.has(res.status) || (res.status === 403 && isQuota403(body));
    lastErr = new Error(`Gmail ${res.status} ${label} ${body.slice(0, 200)}`);

    if (!retryable || attempt === MAX_ATTEMPTS) break;
    await sleep(backoffMs(attempt, res));
  }
  throw lastErr;
}

/** Single authenticated call. `path` is relative to /users/me. */
export async function api(path, init = {}) {
  // The token is resolved once, outside the retry loop: getToken() already
  // single-flights refreshes, and an access token cannot expire inside the
  // ~3.5s worst-case retry window (it is refreshed 60s early).
  const headers = await authHeaders(init.headers || {});
  const res = await fetchRetrying(`${BASE}${path}`, { ...init, headers }, path);
  if (res.status === 204) return null;
  return res.json();
}

/**
 * One page of message ids.
 * Returns { ids, nextPageToken }.
 */
export async function listIds({ q = '', labelIds = ['INBOX'], max = 100, pageToken = '' } = {}) {
  const params = new URLSearchParams();
  params.set('maxResults', String(Math.min(max, 500)));
  for (const l of labelIds) params.append('labelIds', l);
  if (q) params.set('q', q);
  if (pageToken) params.set('pageToken', pageToken);
  const data = await api(`/messages?${params}`);
  return {
    ids: (data.messages || []).map((m) => m.id),
    nextPageToken: data.nextPageToken || '',
  };
}

/**
 * Metadata for up to BATCH_SIZE ids in ONE request.
 * Returns an array of normalised message records (see `normalise`).
 * Sub-requests that fail are dropped, not thrown -- one dead message must not
 * kill a sync of a hundred good ones.
 */
export async function batchMetadata(ids) {
  if (ids.length === 0) return [];
  if (ids.length > BATCH_SIZE) throw new Error(`batchMetadata: ${ids.length} > ${BATCH_SIZE}`);

  const boundary = `bmm_${Math.random().toString(36).slice(2)}_${Date.now()}`;
  const qs = new URLSearchParams();
  qs.set('format', 'metadata');
  for (const h of META_HEADERS) qs.append('metadataHeaders', h);

  const body =
    ids
      .map(
        (id, i) =>
          `--${boundary}\r\n` +
          `Content-Type: application/http\r\n` +
          `Content-ID: <bmm-${i}>\r\n\r\n` +
          `GET /gmail/v1/users/me/messages/${encodeURIComponent(id)}?${qs}\r\n\r\n`
      )
      .join('') + `--${boundary}--\r\n`;

  // Same retry policy as api(). The batch endpoint is the single most likely
  // request to be rate-limited, because it is 100 sub-requests at once.
  const res = await fetchRetrying(
    BATCH_URL,
    {
      method: 'POST',
      headers: await authHeaders({ 'Content-Type': `multipart/mixed; boundary=${boundary}` }),
      body,
    },
    '/batch'
  );
  const text = await res.text();
  return parseBatch(text).map(normalise).filter(Boolean);
}

/**
 * Parse a multipart/mixed batch response into JSON objects.
 *
 * Deliberately tolerant: Google has changed the exact header casing and line
 * endings in this response before, and a strict parser silently returns an
 * empty inbox when that happens. We find the JSON payload of each part by
 * looking for the last blank-line separator inside the part.
 */
export function parseBatch(text) {
  const m = text.match(/--([^\s-][^\r\n]*?)(?:\r?\n)/);
  if (!m) return [];
  const boundary = m[1].replace(/--$/, '');
  const out = [];
  for (const raw of text.split(`--${boundary}`)) {
    const part = raw.trim();
    if (!part || part === '--') continue;
    // part = <mime headers>\n\n<HTTP status + headers>\n\n<body>
    const chunks = part.split(/\r?\n\r?\n/);
    if (chunks.length < 3) continue;
    const status = chunks[1].split(/\r?\n/)[0] || '';
    if (!/\s2\d\d\s/.test(` ${status} `)) continue; // drop failed sub-requests
    const bodyText = chunks.slice(2).join('\n\n').trim();
    if (!bodyText.startsWith('{')) continue;
    try {
      out.push(JSON.parse(bodyText));
    } catch {
      /* one malformed part must not poison the batch */
    }
  }
  return out;
}

/**
 * Gmail's wire format -> our flat record.
 *
 * Flat on purpose. The old version kept Gmail's nested payload/headers array
 * in the store, which meant every render walked an array of ~20 header objects
 * per message just to find the subject.
 */
export function normalise(g) {
  if (!g?.id) return null;

  /*
   * THIS IS THE TRUST BOUNDARY for everything that comes off the network.
   *
   * It used to copy header values through verbatim, which broke two ways:
   *
   *   1. A header with no `name`, or a null entry in the array, threw here
   *      and killed the whole page of messages -- one malformed header meant
   *      an empty inbox.
   *   2. A non-string `value` was passed straight through, so `subject` could
   *      be a number and `from` an object. Downstream, `classify()` calls
   *      `.toLowerCase()` and `buildReply()` calls `.replace()`, both of which
   *      throw on a non-string. Fuzzing found both.
   *
   * Coercing HERE rather than defending in every consumer is the correct
   * layer: there is one place data enters, and dozens that read it. Every
   * field below is guaranteed to be the type its JSDoc claims.
   */
  const h = headerMap(g.payload?.headers);
  const labels = Array.isArray(g.labelIds) ? g.labelIds : [];
  return {
    id: str(g.id),
    threadId: str(g.threadId) || str(g.id),
    from: h.from || '',
    subject: h.subject || '(no subject)',
    snippet: decodeEntities(str(g.snippet)),
    // internalDate is ms-since-epoch as a STRING, and it is authoritative.
    // The Date: header is attacker-controlled and is routinely wrong.
    date: Number(g.internalDate) || Date.parse(h.date) || 0,
    unread: labels.includes('UNREAD'),
    starred: labels.includes('STARRED'),
    important: labels.includes('IMPORTANT'),
    labels,
  };
}

/**
 * Coerce any header/field value to a string.
 *
 * Gmail's API is well behaved, but "well behaved" is not a guarantee we can
 * enforce, and a single unexpected type used to crash the classifier for an
 * entire page of mail. Objects and arrays become '' rather than
 * "[object Object]", which would otherwise become searchable text.
 */
/**
 * Fold a Gmail header array into a lowercase-keyed object.
 *
 * Exported because THREE separate places parsed header arrays by hand
 * (`normalise` here, and `extractBody`'s message and part loops in
 * index.js), and all three used the same `for (const { name, value } of ...)`
 * shape that throws on a header with no `name` or a null entry. Fuzzing found
 * the crash independently in each.
 *
 * One malformed header used to cost an entire page of mail in `normalise`,
 * and a single unreadable message in `extractBody`. Both are now impossible
 * because there is one parser rather than three copies of an assumption.
 */
export function headerMap(headers) {
  const out = Object.create(null);
  if (!Array.isArray(headers)) return out;
  for (const entry of headers) {
    const name = entry?.name;
    if (typeof name !== 'string') continue;
    out[name.toLowerCase()] = str(entry.value);
  }
  return out;
}

function str(v) {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** Full body for one message, fetched only when the user opens it. */
export async function getFull(id) {
  return api(`/messages/${encodeURIComponent(id)}?format=full`);
}

/** Add/remove labels. Used for read, star, archive. */
export async function modify(id, addLabelIds = [], removeLabelIds = []) {
  return api(`/messages/${encodeURIComponent(id)}/modify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addLabelIds, removeLabelIds }),
  });
}

/** Bulk modify -- one request for up to 1000 ids. */
export async function batchModify(ids, addLabelIds = [], removeLabelIds = []) {
  if (!ids.length) return null;
  await api('/messages/batchModify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, addLabelIds, removeLabelIds }),
  });
  return { ok: true };
}

export async function trash(id) {
  return api(`/messages/${encodeURIComponent(id)}/trash`, { method: 'POST' });
}

export async function profile() {
  return api('/profile');
}

/**
 * Delta sync. Returns { changes, historyId } or { tooOld: true } when the
 * stored historyId has expired (Gmail keeps ~1 week) and a full resync is
 * required. Callers must handle `tooOld`; the old version did not, which is
 * why it silently stopped updating after a long absence.
 *
 * PAGINATION IS NOT OPTIONAL HERE.
 * The response's `historyId` is the mailbox's CURRENT id, not the id of the
 * last record on this page. So if we read page 1 and then store that value, we
 * have advanced the cursor past pages 2..n without ever reading them, and
 * those changes are unrecoverable. Either we drain every page, or we do not
 * move the cursor at all.
 */
const MAX_HISTORY_PAGES = 10; // 10 * 500 = 5000 records; past that, resync is cheaper

export async function history(startHistoryId) {
  const changes = [];
  let pageToken = '';
  let historyId = null;

  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const params = new URLSearchParams({
      startHistoryId: String(startHistoryId),
      maxResults: '500',
    });
    for (const t of ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved']) {
      params.append('historyTypes', t);
    }
    if (pageToken) params.set('pageToken', pageToken);

    let data;
    try {
      data = await api(`/history?${params}`);
    } catch (err) {
      // 404 = the cursor is older than Gmail's retention window.
      if (String(err).includes('404')) return { tooOld: true };
      throw err;
    }

    if (data.history) changes.push(...data.history);
    historyId = data.historyId || historyId;
    pageToken = data.nextPageToken || '';
    if (!pageToken) return { changes, historyId };
  }

  // Still paging after MAX_HISTORY_PAGES. Advancing the cursor now would skip
  // whatever is left, so treat it as a resync instead of losing mail.
  return { tooOld: true };
}


// ============================================================================
// COMPOSE
// ============================================================================

/**
 * RFC 2047 encoded-word, for header values containing non-ASCII.
 *
 * Subject lines carrying a rupee sign or a name with a diacritic are common in
 * BITS mail, and a raw 8-bit byte in a header is a protocol violation that
 * Gmail rejects outright. Base64 is used rather than quoted-printable because
 * it cannot produce a line that needs folding for a realistic subject.
 */
function encodeHeader(value) {
  const s = String(value ?? '');
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(s)) return s; // pure ASCII: leave it readable
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(bin)}?=`;
}

/** base64url, which is what the Gmail API wants for a raw RFC 2822 message. */
function b64urlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build an RFC 2822 message.
 *
 * Deliberately hand-built rather than pulled from a MIME library: the whole
 * extension has zero runtime dependencies, and a correct multipart/alternative
 * for this narrow case is about thirty lines. Anything a library would add
 * beyond that (attachments with content-disposition, nested multiparts) is not
 * something this build sends.
 *
 * @param {{to:string, cc?:string, bcc?:string, subject:string, body:string,
 *   inReplyTo?:string, references?:string, from?:string}} m
 */
export function buildMime(m) {
  const boundary = `bmm_${Math.random().toString(36).slice(2)}`;

  /*
   * EVERY HEADER VALUE IS SCRUBBED. THIS WAS A REAL, EXPLOITABLE BUG.
   *
   * `safeHeaderValue` and `safeFilename` existed and were applied to
   * ATTACHMENT metadata only. To, Cc, Bcc, From, In-Reply-To and References
   * were interpolated raw, so a CRLF in any of them injected an arbitrary
   * header -- classically a hidden `Bcc:`.
   *
   * WHY THIS IS WORSE THAN "THE USER COULD TYPE IT INTO THEIR OWN MESSAGE".
   *
   * `To` is not only typed. `buildReply()` fills it from the INBOUND message's
   * Reply-To or From header, which is entirely attacker-controlled. A crafted
   * message with
   *
   *     Reply-To: prof@bits.ac.in\r\nBcc: harvest@evil.com
   *
   * meant that hitting Reply -- an action with no warning attached -- silently
   * copied the reply to a third party. Verified end to end before fixing:
   * buildReply produced the poisoned string and buildMime emitted the Bcc.
   *
   * Scrubbing happens HERE, at the last gate before the wire, rather than in
   * buildReply. There are three producers of these fields (compose, reply,
   * the outbox replaying a stored draft) and one consumer; fixing the consumer
   * cannot be bypassed by a fourth producer added later.
   *
   * BARE LF COUNTS. Some MTAs and parsers accept a lone \n as a header
   * separator, so stripping only \r\n is not enough -- `safeHeaderValue`
   * already handles both, which is why it is reused rather than reinvented.
   */
  const headers = [
    m.from ? `From: ${safeAddressHeader(m.from)}` : null,
    `To: ${safeAddressHeader(m.to)}`,
    m.cc ? `Cc: ${safeAddressHeader(m.cc)}` : null,
    m.bcc ? `Bcc: ${safeAddressHeader(m.bcc)}` : null,
    `Subject: ${encodeHeader(m.subject)}`,
    // Threading. Without these two a reply starts a NEW conversation, which is
    // the single most visible way a mail client looks broken.
    m.inReplyTo ? `In-Reply-To: ${safeIdHeader(m.inReplyTo)}` : null,
    m.references ? `References: ${safeIdHeader(m.references)}` : null,
    'MIME-Version: 1.0',
  ].filter(Boolean);

  const plain = m.body;
  const html = plainToHtml(m.body);

  /*
   * The body is always multipart/alternative: a text/plain fallback beside the
   * HTML, so clients that do not render HTML still show something readable.
   */
  const altParts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    plain,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    '',
    `--${boundary}--`,
    '',
  ];

  const files = Array.isArray(m.attachments) ? m.attachments.filter(Boolean) : [];

  /*
   * NO ATTACHMENTS: EMIT EXACTLY WHAT WE ALWAYS DID.
   *
   * Wrapping every message in multipart/mixed "for consistency" would add a
   * layer to the 99% case to serve the 1%, and some clients render the extra
   * nesting badly. The common path is untouched.
   */
  if (!files.length) {
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ].join('\r\n') + `\r\n\r\n${altParts.join('\r\n')}`;
  }

  /*
   * WITH ATTACHMENTS: multipart/mixed WRAPPING the alternative, not replacing
   * it. Flattening the alternative away would lose the text/plain fallback.
   * The outer boundary must differ from the inner one or a parser cannot tell
   * where the nested part ends.
   */
  const outer = `${boundary}_mixed`;
  const body = [
    `--${outer}`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    ...altParts,
  ];

  for (const f of files) {
    const name = safeFilename(f.filename);
    body.push(
      `--${outer}`,
      `Content-Type: ${safeHeaderValue(f.mimeType || 'application/octet-stream')}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      // Already base64 from the reader; fold to 76 columns as RFC 2045 asks.
      String(f.data || '').replace(/\s+/g, '').replace(/(.{76})/g, '$1\r\n'),
      ''
    );
  }
  body.push(`--${outer}--`, '');

  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${outer}"`,
  ].join('\r\n') + `\r\n\r\n${body.join('\r\n')}`;
}

/**
 * Make a filename safe to sit inside a quoted MIME parameter.
 *
 * A filename is ATTACKER-CONTROLLED the moment you forward something. An
 * unescaped `"` closes the parameter early and a CRLF injects an entire new
 * header -- which turns a forward into a header-injection primitive capable of
 * adding a Bcc. Strip the line breaks, strip the quotes, and cap the length.
 */
function safeFilename(name) {
  return String(name || 'attachment')
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, '')
    .slice(0, 200)
    .trim() || 'attachment';
}

/** Same rule for any value we interpolate into a header. */
function safeHeaderValue(v, max = 200) {
  /*
   * Strips CR, LF and the quote character, then caps the length.
   *
   * The cap is a parameter because 200 is right for a filename or a MIME type
   * and WRONG for a recipient list: a reply-all on a project thread runs well
   * past 200 characters, and silently truncating it would drop recipients from
   * a message the user believes they sent to everyone. Address headers pass a
   * generous limit; the RFC 5322 line-length guidance is about folding, which
   * Gmail's API does for us.
   */
  return String(v || '').replace(/[\r\n\u2028\u2029"]+/g, '').slice(0, max);
}

/**
 * Address headers: the same scrubbing, with NO length cap.
 *
 * A generous cap was tried first (2000 characters) and was still wrong. A
 * reply-all to a 60-person project thread is ~2500 characters, and the cap
 * silently dropped twelve recipients -- caught by measuring it rather than by
 * reasoning about it.
 *
 * Truncating an address list is DATA LOSS in the direction the user cannot
 * see: the message sends, looks fine in Sent, and a third of the recipients
 * never receive it. The cap was defending against nothing -- length is not the
 * attack, CRLF is, and that is stripped regardless. Gmail's API rejects a
 * genuinely absurd header itself, which is the right place for that limit.
 */
function safeAddressHeader(v) {
  /*
   * ADDRESS HEADERS ARE REBUILT FROM PARSED TOKENS, NOT PATCHED.
   *
   * Two weaker fixes were tried first and both were wrong, which is why this
   * one is written the way it is.
   *
   *   DELETE the line break   -> "a@b.com\r\nBcc: x@evil.com" becomes
   *                              "a@b.comBcc: x@evil.com": no header is
   *                              injected, but the recipient is now one
   *                              malformed token.
   *
   *   REPLACE it with a space -> "a@b.com Bcc: x@evil.com": still on the To
   *                              line, and space-separated addresses ARE legal
   *                              in some parsers, so the attacker's address
   *                              may simply be delivered to.
   *
   * Neither is acceptable, because the goal is not "no extra header" -- it is
   * THE ATTACKER'S ADDRESS MUST NOT REACH THE WIRE AT ALL.
   *
   * So the value is split on line breaks and on commas, and every resulting
   * token is kept only if it looks like a real recipient: an optional display
   * name followed by one address, or a bare address. `Bcc: x@evil.com` matches
   * neither -- a header name with a colon is not an address -- so it is
   * discarded rather than reshaped.
   *
   * Regular commas are preserved, so a legitimate reply-all is untouched, and
   * there is no length cap: truncating a recipient list is silent data loss in
   * the direction the user cannot see.
   */
  const ADDRESS = /^(?:[^<>,:;"]{0,120}<[^<>@\s]+@[^<>@\s]+>|[^<>,:;"\s]+@[^<>,:;"\s]+)$/;

  return String(v || '')
    .split(/[\r\n\u2028\u2029,]+/)
    .map((tok) => tok.replace(/"/g, '').trim())
    .filter((tok) => tok && ADDRESS.test(tok))
    .join(', ');
}

/**
 * Message-ID style headers (In-Reply-To, References).
 *
 * These are `<id@host>` tokens, space separated, so they need the same
 * "rebuild from valid tokens" treatment but a different shape of token.
 */
function safeIdHeader(v) {
  return String(v || '')
    .split(/[\r\n\u2028\u2029\s]+/)
    .map((t) => t.trim())
    .filter((t) => /^<[^<>\s]+>$/.test(t))
    .join(' ');
}


/** Minimal, escaped plain-text -> HTML. Never interpolates raw user text. */
function plainToHtml(text) {
  const esc = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<div style="white-space:pre-wrap;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">${esc}</div>`;
}

/**
 * Send a message.
 * `threadId` keeps a reply inside its conversation.
 */
export async function sendMessage(mime, threadId) {
  const body = { raw: b64urlEncode(mime) };
  if (threadId) body.threadId = threadId;
  return api('/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Find the draft that owns a message, and return it ready for editing.
 *
 * The Drafts mailbox is fetched by LABEL, so the app holds message ids while
 * the drafts API is keyed by DRAFT id -- and they are different. Without this
 * lookup a draft could be listed and never opened, which is exactly the state
 * the product was in.
 *
 * Returns the draft id alongside the RAW message resource. Parsing stays in
 * the worker beside extractBody, which already knows how to read a Gmail
 * payload -- a second parser is how two readers drift.
 */
export async function getDraftForMessage(messageId) {
  const list = await api('/drafts?maxResults=500');
  const hit = (list.drafts || []).find((d) => d.message?.id === messageId);
  if (!hit) return null;
  const full = await api(`/drafts/${encodeURIComponent(hit.id)}?format=full`);
  return { draftId: hit.id, message: full.message || {} };
}

/** Save a draft rather than sending. */
export async function saveDraft(mime, threadId, draftId) {
  const message = { raw: b64urlEncode(mime) };
  if (threadId) message.threadId = threadId;
  const payload = JSON.stringify({ message });
  if (draftId) {
    return api(`/drafts/${encodeURIComponent(draftId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
  }
  return api('/drafts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });
}

// ============================================================================
// LABELS
// ============================================================================

export async function listLabels() {
  const data = await api('/labels');
  return (data.labels || [])
    .filter((l) => l.type === 'user')
    .map((l) => ({ id: l.id, name: l.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function createLabel(name) {
  return api('/labels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    }),
  });
}

/**
 * Find a label by name, creating it if it does not exist.
 *
 * Gmail returns 409 for a duplicate name, and two callers racing (a snooze and
 * a wake at the same moment) will do exactly that. So a failed create falls
 * back to a re-list rather than propagating: by definition the label now
 * exists, which is all the caller wanted.
 *
 * The id is cached because this is on the path of every snooze, and the id of
 * a label never changes.
 */
const labelIdCache = new Map();

export async function ensureLabel(name) {
  if (labelIdCache.has(name)) return labelIdCache.get(name);

  const existing = (await api('/labels')).labels || [];
  const hit = existing.find((l) => l.name === name);
  if (hit) {
    labelIdCache.set(name, hit.id);
    return hit.id;
  }

  try {
    const made = await createLabel(name);
    if (made?.id) {
      labelIdCache.set(name, made.id);
      return made.id;
    }
  } catch {
    // Fall through: most likely a race, and the re-list below settles it.
  }

  const after = (await api('/labels')).labels || [];
  const found = after.find((l) => l.name === name);
  if (!found) throw new Error(`Could not create the "${name}" label`);
  labelIdCache.set(name, found.id);
  return found.id;
}

/** Test seam. */
export function _clearLabelCache() {
  labelIdCache.clear();
}

// ============================================================================
// ATTACHMENTS
// ============================================================================

/**
 * Fetch one attachment as a data: URL.
 *
 * Returned as a data URL rather than a blob because the worker has no DOM and
 * therefore no URL.createObjectURL. The app turns it into a download. Gmail's
 * attachment payloads are base64url, which is NOT what a data: URL wants, so
 * the padding and alphabet are converted here.
 */
export async function getAttachment(messageId, attachmentId, mimeType) {
  const data = await api(
    `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
  );
  const b64 = String(data.data || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return `data:${mimeType || 'application/octet-stream'};base64,${padded}`;
}
