/**
 * Adversarial batch-response pins (audit 2026-08-15, AUD-Q2).
 *
 * parseBatch is the one parser whose input is entirely wire: the boundary is
 * sniffed from the response, each part's identity is claimed in-band, and a
 * hostile or confused peer can stuff in parts we never asked for. Two laws,
 * pinned here:
 *
 *   1. NEVER THROWS. Any malformed, misboundaried, hostile-stringed body
 *      degrades to fewer records, not to a crashed sync.
 *   2. NEVER YIELDS AN UNREQUESTED ID. batchMetadata whitelists against the
 *      request set BEFORE normalise — a phantom cannot even become a record.
 *
 * The deterministic cases pin the interesting classes; the seeded property
 * sweep pins the two laws across shuffled, duplicated, corrupted wires.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, hostileString } from './helpers/fuzz.mjs';

/* Signed-in stub, as in gmail.test.mjs: getToken() short-circuits on the
   live accessToken, so batchMetadata reaches only the fetch layer we drive. */
globalThis.chrome = {
  storage: {
    local: {
      async get(k) {
        const store = {
          accessToken: 'fake-token',
          expiresAt: Date.now() + 3600_000,
          clientId: 'test.apps.googleusercontent.com',
        };
        if (Array.isArray(k)) {
          const o = {};
          for (const key of k) if (key in store) o[key] = store[key];
          return o;
        }
        if (typeof k === 'string') return k in store ? { [k]: store[k] } : {};
        return { ...store };
      },
      async set() {},
      async remove() {},
    },
  },
  identity: { getRedirectURL: () => 'https://abc.chromiumapp.org/' },
  runtime: { id: 'test' },
};

const { parseBatch, batchMetadata } = await import('../src/background/gmail.js');

// ------------------------------------------------------------- the harness --

/** Build a multipart body with per-part status + JSON payload. */
function batchBody(parts, boundary = 'batch_xyz') {
  return (
    parts
      .map(
        (p) =>
          `--${boundary}\r\n` +
          `Content-Type: application/http\r\n` +
          `Content-ID: <response-${Math.random().toString(36).slice(2, 8)}>\r\n\r\n` +
          `HTTP/1.1 ${p.status}\r\n` +
          `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
          `${typeof p.json === 'string' ? p.json : JSON.stringify(p.json)}\r\n\r\n`
      )
      .join('') + `--${boundary}--\r\n`
  );
}

const okPart = (id, subject = 'S') => ({
  status: '200 OK',
  json: { id, threadId: `t-${id}`, payload: { headers: [{ name: 'Subject', value: subject }] } },
});

/** Drive batchMetadata against one scripted fetch response. */
async function batchOnce(ids, wireText) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    text: async () => wireText,
    json: async () => ({}),
  });
  try {
    return await batchMetadata(ids);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --------------------------------------------------- AUD-Q2: the whitelist --

test('AUD-Q2: a phantom id in the batch answer is refused before normalise', async () => {
  const out = await batchOnce(['a', 'b'], batchBody([
    okPart('a'),
    okPart('evil-phantom', 'I was never asked for'),
    okPart('b'),
  ]));
  assert.deepEqual(out.map((m) => m.id).sort(), ['a', 'b'],
    'only the requested ids survive the gate');
});

test('AUD-Q2: an all-phantom answer is a FAILURE, never an empty page', async () => {
  // Same law as V2 P2-20's all-dead batch: silence would be upserted as
  // "no mail". The whitelist makes all-phantom one more way to say nothing.
  await assert.rejects(
    () => batchOnce(['a'], batchBody([okPart('zzz')])),
    /returned nothing/
  );
});

test('AUD-Q2: duplicated and out-of-order parts keep their honest meaning', async () => {
  const out = await batchOnce(['a', 'b'], batchBody([
    okPart('b', 'second requested, first to arrive'),
    okPart('a'),
    okPart('a', 'a duplicate on the wire'),
  ]));
  const ids = out.map((m) => m.id).sort();
  assert.deepEqual(ids, ['a', 'a', 'b'],
    'dupes pass the gate (the store upsert by id is what dedupes); order is not identity');
});

// -------------------------------------------- parseBatch: hostile structure --

test('parseBatch never throws: garbage, emptiness, and sniffed boundaries', () => {
  assert.deepEqual(parseBatch(''), []);
  assert.deepEqual(parseBatch('no boundaries at all'), []);
  assert.deepEqual(parseBatch('--x\r\n--y\r\n{z}'), [], 'junk between dashes');
  // A body that contains its OWN boundary string: the part shatters and is
  // dropped — fail-closed, never half-parsed.
  const boundary = 'batch_self';
  const evil = batchBody([okPart('a', `literal --${boundary} inside the subject`)], boundary);
  const out = parseBatch(evil);
  assert.ok(out.every((m) => m && typeof m === 'object'), 'whatever survived is a record');
});

test('parseBatch drops mixed 5xx parts and malformed JSON, keeps the 2xx', () => {
  const out = parseBatch(batchBody([
    okPart('ok1'),
    { status: '500 Internal Server Error', json: { id: 'dead' } },
    { status: '200 OK', json: '{not json at all' },
    okPart('ok2'),
  ]));
  assert.deepEqual(out.map((o) => o.id), ['ok1', 'ok2']);
});

test('hostile strings inside payloads cannot break the batch or smuggle ids', async () => {
  const rnd = mulberry32(0xB47C4);
  const wanted = ['m1', 'm2', 'm3'];
  const parts = wanted.map((id) => okPart(id, hostileString(rnd)));
  const out = await batchOnce(wanted, batchBody(parts));
  assert.equal(out.length, 3, 'all honest parts survived hostile content');
  assert.ok(out.every((m) => wanted.includes(m.id)), 'no smuggled id');
});

// ------------------------------------------------ the seeded property sweep --

test('PROPERTY: across corrupted wires — never throws, ids ⊆ requested', async () => {
  const rnd = mulberry32(0xFEED42);
  for (let iter = 0; iter < 60; iter++) {
    const n = 1 + Math.floor(rnd() * 12);
    const wanted = Array.from({ length: n }, (_, i) => `id-${i}`);
    const parts = [];
    let live = 0; // honest 2xx parts for requested ids — the all-dead law's input
    for (const id of wanted) {
      const roll = rnd();
      if (roll < 0.15) continue; // missing entirely
      if (roll < 0.3) {
        parts.push({ status: '500 Internal Server Error', json: { id } }); // dead sub-request
        continue;
      }
      parts.push(okPart(id, hostileString(rnd)));
      live++;
      if (rnd() < 0.2) parts.push(okPart(id)); // duplicate
      if (rnd() < 0.25) parts.push(okPart(`phantom-${Math.floor(rnd() * 100)}`));
    }
    // Shuffle the wire: arrival order is not request order.
    for (let i = parts.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [parts[i], parts[j]] = [parts[j], parts[i]];
    }
    const set = new Set(wanted);
    if (live === 0) {
      /* V2 P2-20 (extended by AUD-Q2 to all-phantom): a batch with nothing
         honest to say must read as FAILURE, never as an empty page. */
      await assert.rejects(() => batchOnce(wanted, batchBody(parts)), /returned nothing/);
      continue;
    }
    const out = await batchOnce(wanted, batchBody(parts));
    assert.ok(out.every((m) => set.has(m.id)),
      `iter ${iter}: an unrequested id crossed: ${out.map((m) => m.id)}`);
  }
});

test('PROPERTY: parseBatch alone never yields a non-object, on any text', () => {
  const rnd = mulberry32(7);
  for (let iter = 0; iter < 80; iter++) {
    const text = hostileString(rnd) + (rnd() < 0.5 ? '--x\r\n\r\nHTTP/1.1 200 OK\r\n\r\n{"id":"a"}' : '');
    let out;
    assert.doesNotThrow(() => { out = parseBatch(text); });
    assert.ok(Array.isArray(out));
    assert.ok(out.every((o) => o && typeof o === 'object' && !Array.isArray(o)));
  }
});
