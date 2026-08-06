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

test('RETRY: a 401 is NOT retried — the token needs refreshing, not repeating', async () => {
  const { api } = await import('../src/background/gmail.js');
  const s = scriptFetch([res(401, 'unauthorized')]);
  try {
    await assert.rejects(() => api('/profile'), /401/);
    assert.equal(s.attempts.length, 1);
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
