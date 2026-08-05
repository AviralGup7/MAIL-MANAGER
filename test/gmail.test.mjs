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

globalThis.chrome = {
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
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
