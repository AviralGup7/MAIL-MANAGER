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

const { parseBatch, normalise } = await import('../src/background/gmail.js');

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
