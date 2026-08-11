/**
 * Tests for the Gmail wire-format layer.
 *
 * These are the functions most likely to break silently in production: if the
 * batch parser stops recognising Google's response, the app shows an empty
 * inbox and reports no error at all. That failure mode is exactly what a test
 * is for.
 *
 * `chrome` is stubbed before import because gmail.js -> auth.js touches
 * chrome.storage at module scope in a real browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * A signed-in stub. getToken() short-circuits on a live accessToken, so the
 * network tests below never reach the refresh path — they only exercise the
 * Gmail layer, which is the point.
 */
const fakeStorage = {
  accessToken: 'fake-token',
  expiresAt: Date.now() + 3600_000,
  refreshToken: 'fake-refresh',
  clientId: 'test.apps.googleusercontent.com',
};

globalThis.chrome = {
  storage: {
    local: {
      async get(k) {
        if (Array.isArray(k)) {
          const o = {};
          for (const key of k) if (key in fakeStorage) o[key] = fakeStorage[key];
          return o;
        }
        if (typeof k === 'string') return k in fakeStorage ? { [k]: fakeStorage[k] } : {};
        return { ...fakeStorage };
      },
      async set() {},
      async remove() {},
    },
  },
  identity: { getRedirectURL: () => 'https://abc.chromiumapp.org/' },
  runtime: { id: 'test' },
};

const { parseBatch, normalise, buildMime } = await import('../src/background/gmail.js');

// --------------------------------------------------------------- parseBatch --

function batchBody(parts, boundary = 'batch_xyz') {
  return (
    parts
      .map(
        (p, i) =>
          `--${boundary}\r\n` +
          `Content-Type: application/http\r\n` +
          `Content-ID: response-bmm-${i}\r\n\r\n` +
          `HTTP/1.1 ${p.status}\r\n` +
          `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
          `${JSON.stringify(p.json)}\r\n\r\n`
      )
      .join('') + `--${boundary}--\r\n`
  );
}

test('parseBatch reads every successful sub-response', () => {
  const text = batchBody([
    { status: '200 OK', json: { id: 'a' } },
    { status: '200 OK', json: { id: 'b' } },
    { status: '200 OK', json: { id: 'c' } },
  ]);
  assert.deepEqual(
    parseBatch(text).map((o) => o.id),
    ['a', 'b', 'c']
  );
});

test('parseBatch drops a failed sub-response without losing the good ones', () => {
  // One dead message must not kill a sync of a hundred good ones.
  const text = batchBody([
    { status: '200 OK', json: { id: 'a' } },
    { status: '404 Not Found', json: { error: { code: 404 } } },
    { status: '200 OK', json: { id: 'c' } },
  ]);
  assert.deepEqual(
    parseBatch(text).map((o) => o.id),
    ['a', 'c']
  );
});

test('parseBatch survives malformed JSON in one part', () => {
  const good = batchBody([{ status: '200 OK', json: { id: 'a' } }]).replace(/--batch_xyz--\r\n$/, '');
  const broken =
    `--batch_xyz\r\nContent-Type: application/http\r\n\r\n` +
    `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{ this is not json\r\n\r\n` +
    `--batch_xyz--\r\n`;
  assert.deepEqual(
    parseBatch(good + broken).map((o) => o.id),
    ['a']
  );
});

test('parseBatch tolerates LF-only line endings', () => {
  // Observed from Google in the wild; a \r\n-only parser returns an empty inbox.
  const text = batchBody([{ status: '200 OK', json: { id: 'a' } }]).replace(/\r\n/g, '\n');
  assert.deepEqual(
    parseBatch(text).map((o) => o.id),
    ['a']
  );
});

test('parseBatch returns [] for junk rather than throwing', () => {
  assert.deepEqual(parseBatch(''), []);
  assert.deepEqual(parseBatch('not a batch at all'), []);
});

// ---------------------------------------------------------------- normalise --

test('normalise flattens headers and reads labels', () => {
  const m = normalise({
    id: '1',
    threadId: 't1',
    internalDate: '1700000000000',
    snippet: 'Fee payment &amp; deadline',
    labelIds: ['INBOX', 'UNREAD', 'STARRED'],
    payload: {
      headers: [
        { name: 'From', value: 'AUGSD <augsd@pilani.bits-pilani.ac.in>' },
        { name: 'Subject', value: 'Registration open' },
        { name: 'Date', value: 'Tue, 14 Nov 2023 12:00:00 +0530' },
      ],
    },
  });
  assert.equal(m.subject, 'Registration open');
  assert.equal(m.from, 'AUGSD <augsd@pilani.bits-pilani.ac.in>');
  assert.equal(m.unread, true);
  assert.equal(m.starred, true);
  assert.equal(m.snippet, 'Fee payment & deadline');
  assert.equal(m.date, 1700000000000);
});

test('normalise prefers internalDate over the attacker-controlled Date header', () => {
  // A spammer sets Date: 2099 so their mail pins to the top of the list.
  const m = normalise({
    id: '2',
    internalDate: '1700000000000',
    payload: { headers: [{ name: 'Date', value: 'Fri, 1 Jan 2099 00:00:00 +0000' }] },
  });
  assert.equal(m.date, 1700000000000);
});

test('normalise is case-insensitive about header names', () => {
  const m = normalise({ id: '3', payload: { headers: [{ name: 'SUBJECT', value: 'Hi' }] } });
  assert.equal(m.subject, 'Hi');
});

test('normalise gives a subject placeholder rather than an empty row', () => {
  const m = normalise({ id: '4', payload: { headers: [] } });
  assert.equal(m.subject, '(no subject)');
  assert.equal(m.threadId, '4');
});

test('normalise returns null for a record with no id', () => {
  assert.equal(normalise({}), null);
  assert.equal(normalise(null), null);
});

// ------------------------------------------------------------------ history --

/**
 * BUG 1 regression: the history endpoint's `historyId` is the mailbox's
 * CURRENT id, not the id of the last record on the page. Reading page 1 and
 * then storing that value advances the cursor past pages 2..n, and those
 * changes can never be requested again. Either every page is drained, or the
 * cursor must not move.
 */
test('BUG 1: history() drains every page before returning', async () => {
  const { history } = await import('../src/background/gmail.js');
  const pages = [
    { history: [{ id: '1' }], nextPageToken: 'p2', historyId: '900' },
    { history: [{ id: '2' }], nextPageToken: 'p3', historyId: '900' },
    { history: [{ id: '3' }], historyId: '900' },
  ];
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => pages[calls++],
  });
  try {
    const res = await history('100');
    assert.equal(calls, 3, 'must follow nextPageToken to the end');
    assert.deepEqual(res.changes.map((c) => c.id), ['1', '2', '3']);
    assert.equal(res.historyId, '900');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('BUG 1: an unbounded page chain forces a resync rather than losing records', async () => {
  const { history } = await import('../src/background/gmail.js');
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      calls++;
      return { history: [{ id: String(calls) }], nextPageToken: 'more', historyId: '900' };
    },
  });
  try {
    const res = await history('100');
    assert.equal(res.tooOld, true, 'must resync, not advance the cursor');
    assert.ok(calls <= 10, `page cap must hold, got ${calls}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('history() reports an expired cursor as tooOld', async () => {
  const { history } = await import('../src/background/gmail.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    text: async () => 'not found',
  });
  try {
    assert.deepEqual(await history('1'), { tooOld: true });
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ------------------------------------------------- retry / backoff --------

/**
 * Stub fetch with a scripted sequence of responses.
 * Records how many attempts were made and how long each wait was.
 */
function scriptFetch(responses) {
  const attempts = [];
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  const waits = [];

  // Collapse real backoff delays so the suite stays fast, while still
  // recording what the code ASKED to wait -- that is the behaviour under test.
  globalThis.setTimeout = (fn, ms) => {
    if (ms > 0) waits.push(ms);
    return realSetTimeout(fn, 0);
  };

  globalThis.fetch = async (url, init) => {
    attempts.push({ url: String(url), init });
    const next = responses.shift();
    if (typeof next === 'function') return next();
    return next;
  };

  return {
    attempts,
    waits,
    restore() {
      globalThis.fetch = realFetch;
      globalThis.setTimeout = realSetTimeout;
    },
  };
}

const res = (status, body = '{}', headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => JSON.parse(body),
  text: async () => body,
});

test('RETRY: a 429 is retried and then succeeds', async () => {
  // The point of the whole feature. Gmail rate-limits per user and a
  // 100-message batch is a burst, so a healthy sync produces these routinely.
  const { api } = await import('../src/background/gmail.js');
  const s = scriptFetch([res(429, 'rate limited'), res(200, '{"ok":true}')]);
  try {
    assert.deepEqual(await api('/messages'), { ok: true });
    assert.equal(s.attempts.length, 2, 'must retry once');
  } finally {
    s.restore();
  }
});

test('RETRY: Retry-After is honoured rather than guessed', async () => {
  const { api } = await import('../src/background/gmail.js');
  const s = scriptFetch([res(429, 'slow down', { 'retry-after': '2' }), res(200, '{}')]);
  try {
    await api('/messages');
    assert.deepEqual(s.waits, [2000], `expected a 2s wait, got ${s.waits}`);
  } finally {
    s.restore();
  }
});

test('RETRY: backoff grows and is jittered', async () => {
  const { api } = await import('../src/background/gmail.js');
  const s = scriptFetch([res(503), res(503), res(200, '{}')]);
  try {
    await api('/messages');
    assert.equal(s.waits.length, 2);
    // 500 and 1000 base, plus up to 250ms jitter.
    assert.ok(s.waits[0] >= 500 && s.waits[0] < 750, `first wait ${s.waits[0]}`);
    assert.ok(s.waits[1] >= 1000 && s.waits[1] < 1250, `second wait ${s.waits[1]}`);
    assert.ok(s.waits[1] > s.waits[0], 'backoff must grow');
  } finally {
    s.restore();
  }
});

test('RETRY: gives up after 3 attempts and reports the real status', async () => {
  const { api } = await import('../src/background/gmail.js');
  const s = scriptFetch([res(503), res(503), res(503)]);
  try {
    await assert.rejects(() => api('/messages'), /503/);
    assert.equal(s.attempts.length, 3, 'bounded at 3 attempts');
  } finally {
    s.restore();
  }
});

test('RETRY: a 404 is NOT retried — it is terminal', async () => {
  // Notably this is the expired-historyId path, which must fail fast so
  // syncDelta can fall back to a full resync.
  const { api } = await import('../src/background/gmail.js');
  const s = scriptFetch([res(404, 'not found')]);
  try {
    await assert.rejects(() => api('/history?x=1'), /404/);
    assert.equal(s.attempts.length, 1, 'must not retry a 404');
  } finally {
    s.restore();
  }
});

test('RETRY: a 401 is NOT retried — it is handed to the renew path', async () => {
  // The invariant this pins: fetchRetrying must not burn attempts repeating a
  // 401 with the same (rejected) token. Exactly ONE attempt hits the
  // endpoint, then control transfers to the renew-once path in api(). With no
  // consent in the harness, that path surfaces NOT_SIGNED_IN -- proof the 401
  // branch is now REACHABLE (it was dead code when fetchRetrying threw first:
  // bug-hunt #2).
  const { api } = await import('../src/background/gmail.js');
  // Two 401s: the first is handed to the renew path, which retries EXACTLY
  // once; the second is the canonical AUTH_REVOKED. (The harness storage's
  // remove() is a no-op, so the 'renewed' token is the same one -- api() does
  // not care; the point is the single-retry shape.) A third attempt would
  // mean blind retrying, which is what this test has always policed.
  const s = scriptFetch([res(401, 'unauthorized'), res(401, 'unauthorized')]);
  try {
    await assert.rejects(() => api('/profile'), /AUTH_REVOKED/);
    assert.equal(s.attempts.length, 2, 'exactly one renew-and-retry, never more');
  } finally {
    s.restore();
  }
});

test('RETRY: a 403 is retried only when it is a quota error', async () => {
  // Gmail returns 403 for BOTH rateLimitExceeded and insufficient scope.
  // Retrying a permissions failure three times just delays a clear message.
  const { api } = await import('../src/background/gmail.js');

  const quota = scriptFetch([res(403, '{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}'), res(200, '{}')]);
  try {
    await api('/messages');
    assert.equal(quota.attempts.length, 2, 'quota 403 must retry');
  } finally {
    quota.restore();
  }

  const scope = scriptFetch([res(403, '{"error":{"message":"Insufficient Permission"}}')]);
  try {
    await assert.rejects(() => api('/messages'), /403/);
    assert.equal(scope.attempts.length, 1, 'permission 403 must not retry');
  } finally {
    scope.restore();
  }
});

test('RETRY: a network failure is retried', async () => {
  const { api } = await import('../src/background/gmail.js');
  const s = scriptFetch([
    () => { throw new Error('ECONNRESET'); },
    res(200, '{"recovered":true}'),
  ]);
  try {
    assert.deepEqual(await api('/messages'), { recovered: true });
    assert.equal(s.attempts.length, 2);
  } finally {
    s.restore();
  }
});

test('RETRY: the batch endpoint retries too', async () => {
  // It is the most likely request to be limited: 100 sub-requests at once.
  const { batchMetadata } = await import('../src/background/gmail.js');
  const body =
    `--b\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\n` +
    `Content-Type: application/json\r\n\r\n{"id":"a","payload":{"headers":[]}}\r\n\r\n--b--\r\n`;
  const s = scriptFetch([res(429, 'slow'), res(200, body)]);
  try {
    const out = await batchMetadata(['a']);
    assert.equal(s.attempts.length, 2, 'batch must retry');
    assert.equal(out[0].id, 'a');
  } finally {
    s.restore();
  }
});

/* ============================================================ attachments == */

test('MIME: a message with no attachment stays multipart/alternative', () => {
  /*
   * The shape that has always worked must not change. Wrapping every message
   * in multipart/mixed "for consistency" would add a layer to the 99% case to
   * serve the 1%, and some clients render the extra nesting badly.
   */
  const mime = buildMime({ to: 'a@b.c', subject: 'Hi', body: 'text' });
  assert.match(mime, /Content-Type: multipart\/alternative/);
  assert.doesNotMatch(mime, /multipart\/mixed/);
});

test('MIME: an attachment is base64 and correctly nested', () => {
  /*
   * OUTBOUND ATTACHMENTS -- audit 12 C-3. "Send me the PDF" is table stakes,
   * and a compose window that cannot attach forces the user back to Gmail,
   * which defeats the product.
   *
   * The structure must be multipart/mixed wrapping the existing
   * multipart/alternative, not replacing it. Flattening the alternative part
   * away would lose the text/plain fallback that non-HTML clients read.
   */
  const mime = buildMime({
    to: 'a@b.c',
    subject: 'Report',
    body: 'See attached',
    attachments: [{
      filename: 'notes.txt',
      mimeType: 'text/plain',
      // "hello" in base64.
      data: 'aGVsbG8=',
    }],
  });

  assert.match(mime, /Content-Type: multipart\/mixed/, 'the outer wrapper');
  assert.match(mime, /Content-Type: multipart\/alternative/, 'the body parts survive');
  assert.match(mime, /Content-Type: text\/plain; charset="UTF-8"/, 'plain fallback kept');

  assert.match(
    mime, /Content-Disposition: attachment; filename="notes\.txt"/,
    'the attachment must be named'
  );
  assert.match(
    mime, /Content-Transfer-Encoding: base64/,
    'binary must not be sent 8bit'
  );
  assert.ok(mime.includes('aGVsbG8='), 'the payload must be present');

  // The alternative boundary must be a DIFFERENT string from the mixed one,
  // or the parser cannot tell where the inner part ends.
  const mixed = mime.match(/multipart\/mixed; boundary="([^"]+)"/)[1];
  const alt = mime.match(/multipart\/alternative; boundary="([^"]+)"/)[1];
  assert.notEqual(mixed, alt, 'nested parts need distinct boundaries');
});

test('MIME: a filename with a quote or newline cannot break the headers', () => {
  /*
   * A filename is attacker-controlled the moment you forward something. An
   * unescaped `"` ends the filename parameter early; a CRLF injects a whole
   * new header. Either turns a forward into a header-injection primitive.
   */
  const mime = buildMime({
    to: 'a@b.c', subject: 'x', body: 'y',
    attachments: [{
      filename: 'ev"il\r\nBcc: attacker@evil.com\r\n.txt',
      mimeType: 'text/plain', data: 'AA==',
    }],
  });
  assert.doesNotMatch(
    mime, /^Bcc: attacker@evil\.com/m,
    'a newline in a filename must not become a header'
  );
  const line = mime.split('\r\n').find((l) => l.startsWith('Content-Disposition'));
  assert.ok(line, 'the disposition header must exist');
  assert.equal(
    (line.match(/"/g) || []).length, 2,
    `exactly one quoted filename, got: ${line}`
  );
});


/* ==========================================================================
 * EMAIL HEADER INJECTION
 *
 * The most serious defect found in this project. `safeHeaderValue` and
 * `safeFilename` existed and were applied to ATTACHMENT metadata only; To, Cc,
 * Bcc, From, In-Reply-To and References were interpolated raw.
 *
 * The reachable attack is not "a user types CRLF into their own message". It
 * is that `buildReply()` fills To from the INBOUND Reply-To header, which the
 * sender controls completely -- so hitting Reply on a crafted message silently
 * added a Bcc.
 * ========================================================================== */

const INJECTION = 'victim@x.com\r\nBcc: attacker@evil.com';

function headersOf(mime) {
  return mime.split('\r\n\r\n')[0];
}

test('every address header resists CRLF injection', () => {
  for (const field of ['to', 'cc', 'bcc', 'from', 'inReplyTo', 'references']) {
    const mime = buildMime({ to: 'a@b.com', subject: 's', body: 'b', [field]: INJECTION });
    assert.doesNotMatch(
      headersOf(mime),
      /^Bcc: attacker@evil\.com/mi,
      `${field} allowed an injected Bcc`
    );
  }
});

test('a bare LF also cannot inject a header', () => {
  // Some MTAs accept a lone \n as a separator, so stripping only \r\n is not
  // enough.
  const mime = buildMime({ to: 'a@b.com\nBcc: attacker@evil.com', subject: 's', body: 'b' });
  assert.doesNotMatch(headersOf(mime), /Bcc: attacker/i);
});

test('unicode line separators are split, not merely rejected', () => {
  /*
   * This test was worthless as first written. It only asserted that no Bcc
   * appeared -- which held even with U+2028/U+2029 removed from the splitter,
   * because the whole unsplit token then fails the ADDRESS pattern and is
   * dropped.
   *
   * Safe, but WRONG: dropping the token throws away the legitimate recipient
   * along with the payload, so the user's reply silently goes to nobody. The
   * assertion has to check that the real address SURVIVES as well as that the
   * attacker's does not.
   */
  for (const sep of ['\u2028', '\u2029']) {
    const mime = buildMime({ to: `a@b.com${sep}Bcc: attacker@evil.com`, subject: 's', body: 'b' });
    const head = headersOf(mime);
    assert.doesNotMatch(head, /attacker@evil\.com/, `${JSON.stringify(sep)} leaked the payload`);
    assert.match(head, /^To: a@b\.com$/m, `${JSON.stringify(sep)} destroyed the real recipient`);
  }
});

test('THE REPLY PATH IS THE REACHABLE ATTACK, AND IT IS CLOSED', async () => {
  const { buildReply } = await import('../src/app/query.js');
  // A hostile inbound message. Reply-To is entirely sender-controlled.
  const hostile = {
    from: 'Prof <prof@bits.ac.in>',
    replyTo: 'prof@bits.ac.in\r\nBcc: harvest@evil.com',
    subject: 'Notice',
    to: 'me@pilani.bits-pilani.ac.in',
    cc: '',
  };
  const reply = buildReply(hostile, 'me@pilani.bits-pilani.ac.in', 'reply');
  const mime = buildMime({ to: reply.to, subject: reply.subject, body: 'ok' });
  assert.doesNotMatch(headersOf(mime), /harvest@evil\.com/, 'a crafted Reply-To reached the wire');
});

test('A LARGE REPLY-ALL IS NOT SILENTLY TRUNCATED', () => {
  /*
   * The first version of the fix reused `safeHeaderValue`, which caps at 200
   * characters, then a 2000-character variant. Both dropped recipients from a
   * real reply-all -- 60 addresses is ~2500 characters, and twelve of them
   * vanished. The message sends, looks correct in Sent, and a third of the
   * recipients never receive it.
   *
   * Length was never the attack. CRLF is, and that is stripped regardless.
   */
  const many = Array.from({ length: 60 }, (_, i) => `student${i}.f2024@pilani.bits-pilani.ac.in`).join(', ');
  const toLine = buildMime({ to: many, subject: 's', body: 'b' })
    .split('\r\n')
    .find((l) => l.startsWith('To: '));
  assert.equal(toLine.split(',').length, 60, 'recipients were dropped');
});

test('scrubbing does not damage an ordinary display-name recipient', () => {
  const mime = buildMime({ to: 'Vinti Agarwal <vinti@pilani.bits-pilani.ac.in>', subject: 's', body: 'b' });
  assert.match(headersOf(mime), /^To: Vinti Agarwal <vinti@pilani\.bits-pilani\.ac\.in>$/m);
});


/* ==========================================================================
 * MIME TREE DEPTH: A CRAFTED MESSAGE COULD KILL THE SERVICE WORKER
 * ========================================================================== */

test('a deeply nested MIME tree does not overflow the stack', async () => {
  /*
   * `walk()` recursed with no bound. extractBody runs in the SERVICE WORKER
   * handling GET_BODY, so one crafted message killed the worker -- taking
   * snooze wake-ups and the toolbar shortcut with it until Chrome restarted
   * it. The body is entirely sender-controlled: the trigger is "someone mails
   * you and you open it".
   *
   * Measured before the fix: fine at 2000, RangeError at 5000. Real mail nests
   * three to five deep.
   */
  const { extractBody } = await import('../src/background/mime.js');

  let root = { mimeType: 'multipart/mixed', parts: [] };
  let cur = root;
  for (let i = 0; i < 20000; i++) {
    const next = { mimeType: 'multipart/mixed', parts: [] };
    cur.parts.push(next);
    cur = next;
  }
  assert.doesNotThrow(() => extractBody({ id: 'x', payload: root }));
});

test('a cyclic MIME tree terminates', async () => {
  const { extractBody } = await import('../src/background/mime.js');
  const cyclic = { mimeType: 'multipart/mixed', parts: [] };
  cyclic.parts.push(cyclic);
  assert.doesNotThrow(() => extractBody({ id: 'y', payload: cyclic }));
});

test('a very wide MIME tree walks in linear time, uncapped', async () => {
  /*
   * A 500-part breadth cap was added alongside the depth bound and then
   * REMOVED, because sabotage showed no test could tell it was there and
   * measurement showed it was not earning its cost: a million-part tree walks
   * in ~90ms. Meanwhile the cap would have silently dropped attachments from a
   * legitimate 600-part message.
   *
   * This test pins the measurement so the reasoning stays checkable, and so a
   * future change that makes the walk super-linear is caught.
   */
  const { extractBody } = await import('../src/background/mime.js');
  const wide = {
    mimeType: 'multipart/mixed',
    parts: Array.from({ length: 200000 }, () => ({ mimeType: 'text/plain', body: {} })),
  };
  const t0 = Date.now();
  extractBody({ id: 'z', payload: wide });
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms — the walk is no longer linear`);
});

test('every part of a wide message is seen, not truncated', async () => {
  // The reason the cap was removed: a real message must not lose attachments.
  const { extractBody } = await import('../src/background/mime.js');
  const wide = {
    mimeType: 'multipart/mixed',
    parts: Array.from({ length: 600 }, (_, i) => ({
      mimeType: 'application/pdf',
      filename: `doc${i}.pdf`,
      body: { attachmentId: `a${i}`, size: 10 },
    })),
  };
  const out = extractBody({ id: 'w', payload: wide });
  assert.equal(out.attachments.length, 600, 'attachments were silently dropped');
});

test('the depth bound does not affect a normally-nested message', async () => {
  // mixed > alternative > related > text is what real mail looks like.
  const { extractBody } = await import('../src/background/mime.js');
  const real = {
    mimeType: 'multipart/mixed',
    parts: [{
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: 'aGVsbG8' } },
        {
          mimeType: 'multipart/related',
          parts: [{ mimeType: 'text/html', body: { data: 'PGI-aGk8L2I-' } }],
        },
      ],
    }],
  };
  const out = extractBody({ id: 'a', payload: real });
  assert.equal(out.text, 'hello');
  assert.match(out.html, /hi/);
});

// ------------------------------------------------------------- label cache --

test('the label-id cache is account-scoped: clearing it re-hits the API (V2 P1-12)', async () => {
  // Label ids belong to one account. The cache exists because ensureLabel is
  // on the path of every snooze, but it MUST be cleared at sign-out or the
  // next account inherits the previous one's ids. The clear is only
  // meaningful if the next call really goes back to the API.
  const { ensureLabel, _clearLabelCache } = await import('../src/background/gmail.js');

  let labelCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    labelCalls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ labels: [{ id: 'LID', name: 'BMM/Snoozed' }] }),
    };
  };
  try {
    _clearLabelCache(); // start cold no matter what ran before
    assert.equal(await ensureLabel('BMM/Snoozed'), 'LID');
    assert.equal(await ensureLabel('BMM/Snoozed'), 'LID');
    assert.equal(labelCalls, 1, 'the repeat call must be served from the cache');

    _clearLabelCache(); // what SIGN_OUT does
    assert.equal(await ensureLabel('BMM/Snoozed'), 'LID');
    assert.equal(labelCalls, 2, 'after the clear the id must come from the API again');
  } finally {
    globalThis.fetch = realFetch;
    _clearLabelCache();
  }
});

// -------------------------------------------------- bug-hunt security pins --

test('Subject is CRLF-scrubbed like every other header (bug-hunt #1)', async () => {
  // The reply path copies the INBOUND subject, which is attacker-controlled;
  // a pure-ASCII CR/LF in it used to be the last header-injection path.
  const { buildMime } = await import('../src/background/gmail.js');
  const mime = buildMime({
    to: 'a@b.com',
    subject: 'Hello\r\nBcc: harvest@evil.com',
    body: 'x',
  });
  assert.ok(!mime.includes('harvest@evil.com'), 'the injected text must not reach the wire at all');
  assert.match(mime, /^Subject: Hello\r\n/m, 'only the first line of the subject survives');
  // A clean subject survives intact.
  const ok = buildMime({ to: 'a@b.com', subject: 'Fee reminder', body: 'x' });
  assert.match(ok, /^Subject: Fee reminder\r\n/m);
});

test('getAttachment clamps a hostile mimeType (bug-hunt #5)', async () => {
  const { getAttachment } = await import('../src/background/gmail.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ data: 'aGVsbG8' }),
  });
  try {
    // Plain types pass; anything with parameters, quotes, whitespace or a
    // second scheme degrades to octet-stream (bug-hunt #5).
    const params = await getAttachment('m', 'a', 'image/png;evil=1');
    assert.ok(params.startsWith('data:application/octet-stream;base64,'));
    const spaced = await getAttachment('m', 'a', 'text/html attack');
    assert.ok(spaced.startsWith('data:application/octet-stream;base64,'));
    const quoted = await getAttachment('m', 'a', 'image/png\"x');
    assert.ok(quoted.startsWith('data:application/octet-stream;base64,'));
    const good = await getAttachment('m', 'a', 'image/png');
    assert.ok(good.startsWith('data:image/png;base64,'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('decodeEntities decodes &amp; LAST (bug-hunt #9)', async () => {
  const { normalise } = await import('../src/background/gmail.js');
  const mk = (snippet) => normalise({ id: 'x', snippet, internalDate: '1' });
  // A literal "&lt;" in the mail arrives as "&amp;lt;": ONE decode pass must
  // yield the visible text "&lt;", not an HTML-active "<".
  assert.equal(mk('a &amp;lt;b&amp;gt; c').snippet, 'a &lt;b&gt; c');
  assert.equal(mk('Tom &amp; Jerry').snippet, 'Tom & Jerry');
  assert.equal(mk('it&#x27;s &apos;fine&apos;').snippet, "it's 'fine'");
});

test('a 401 reaches api() and triggers the renew-once path (bug-hunt #2)', async () => {
  // Old behaviour: fetchRetrying THREW on 401, so the renew branch in api()
  // was dead code. Now the 401 response is handed to api(), which must renew
  // exactly once and retry with the fresh token.
  const mod = await import('../src/background/gmail.js');

  fakeStorage.authorized = true;
  fakeStorage.accessToken = 'stale';
  fakeStorage.expiresAt = Date.now() + 3600_000;

  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls++;
    if (String(url).includes('/revoke')) return { ok: true, status: 200 };
    if (calls === 1) return { ok: false, status: 401, text: async () => 'expired' };
    return { ok: true, status: 200, json: async () => ({ emailAddress: 'me@bits' }) };
  };
  // Silent renewal: answer the implicit-flow round trip with a fresh token.
  const realIdentity = globalThis.chrome.identity;
  globalThis.chrome.identity = {
    ...realIdentity,
    launchWebAuthFlow: async (opts) => {
      const state = new URL(opts.url).searchParams.get('state');
      return `https://abc.chromiumapp.org/#access_token=fresh&expires_in=3600&state=${encodeURIComponent(state)}`;
    },
  };
  try {
    const res = await mod.profile();
    assert.equal(res.emailAddress, 'me@bits');
    assert.equal(calls >= 2, true, 'the request must be retried after renewal');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.chrome.identity = realIdentity;
    delete fakeStorage.authorized;
    fakeStorage.accessToken = 'fake-token';
    fakeStorage.expiresAt = Date.now() + 3600_000;
  }
});

test('a second 401 after renewal is AUTH_REVOKED, not data (bug-hunt #2)', async () => {
  const mod = await import('../src/background/gmail.js');
  fakeStorage.authorized = true;
  fakeStorage.accessToken = 'stale';
  fakeStorage.expiresAt = Date.now() + 3600_000;

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/revoke')) return { ok: true, status: 200 };
    return { ok: false, status: 401, text: async () => 'nope' };
  };
  const realIdentity = globalThis.chrome.identity;
  globalThis.chrome.identity = {
    ...realIdentity,
    launchWebAuthFlow: async (opts) => {
      const state = new URL(opts.url).searchParams.get('state');
      return `https://abc.chromiumapp.org/#access_token=fresh&expires_in=3600&state=${encodeURIComponent(state)}`;
    },
  };
  try {
    await assert.rejects(() => mod.profile(), /AUTH_REVOKED/);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.chrome.identity = realIdentity;
    delete fakeStorage.authorized;
    fakeStorage.accessToken = 'fake-token';
    fakeStorage.expiresAt = Date.now() + 3600_000;
  }
});
