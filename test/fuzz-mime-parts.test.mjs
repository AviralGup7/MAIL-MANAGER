/**
 * Fuzz sweep, round 4 (2/3 — 2026-08-14, defect #20): the MIME part walk is
 * total over wire-shaped trees.
 *
 * THE ACCUSATION, CONFIRMED BEFORE THE FIX. headerMap healed extractBody's
 * HEADER loops ("a single unreadable message in extractBody is now
 * impossible"); the PART loop kept trusting raw fields. Measured pre-fix,
 * each inside the service worker's GET_BODY handler:
 *
 *   payload.mimeType = 5        -> "mime.startsWith is not a function"
 *   payload.parts    = {}       -> "object is not iterable"
 *   payload.body     = {data:64} -> "data.replace is not a function" (b64url)
 *
 * One malformed message crashed its own read every time the user opened it,
 * and left an unhandled rejection on the worker that also wakes snoozes.
 *
 * Properties pinned:
 *   - extractBody never throws for ANY JSON-shaped payload tree, however
 *     hostile the part fields (type, depth, breadth all fuzzed);
 *   - the output CONTRACT holds: html/text are strings, attachments and
 *     inline entries carry only string names and ids, sizes are finite;
 *   - honest trees extract exactly what they used to (the coercions refuse
 *     junk, they do not narrow the schema).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { extractBody } = await import('../src/background/mime.js');
const { mulberry32, hostileString, hostileValue } = await import('./helpers/fuzz.mjs');

/** A hostile part: every field fuzzed, sometimes a whole hostile value. */
function hostilePart(rnd, depth) {
  if (rnd() < 0.15) return hostileValue(rnd); // the part itself is junk
  const part = { headers: [] };
  if (rnd() < 0.7) part.mimeType = rnd() < 0.5 ? hostileValue(rnd) : hostileString(rnd);
  if (rnd() < 0.6) part.filename = rnd() < 0.5 ? hostileValue(rnd) : hostileString(rnd);
  if (rnd() < 0.6) {
    part.body = {
      data: hostileValue(rnd),
      size: hostileValue(rnd),
      attachmentId: hostileValue(rnd),
    };
  }
  if (depth < 4 && rnd() < 0.55) {
    // parts: sometimes honest, sometimes a truthy non-iterable (#20's trap)
    if (rnd() < 0.25) {
      part.parts = hostileValue(rnd);
    } else {
      const n = Math.floor(rnd() * 4);
      part.parts = Array.from({ length: n }, () => hostilePart(rnd, depth + 1));
    }
  }
  return part;
}

function checkContract(out, seed, i) {
  assert.equal(typeof out.html, 'string', `seed ${seed} draw ${i}: html a string`);
  assert.equal(typeof out.text, 'string', `seed ${seed} draw ${i}: text a string`);
  assert.ok(Array.isArray(out.attachments), 'attachments an array');
  assert.ok(Array.isArray(out.inline), 'inline an array');
  for (const a of [...out.attachments, ...out.inline]) {
    assert.equal(typeof a.filename, 'string', `seed ${seed} draw ${i}: filename a string`);
    assert.equal(typeof a.mimeType, 'string', 'mimeType a string');
    assert.equal(typeof a.attachmentId, 'string', 'attachmentId a string');
    assert.ok(Number.isFinite(a.size), 'size finite');
  }
}

test('fuzz: extractBody never throws over hostile part trees, and the contract holds', () => {
  const rnd = mulberry32(0x5eed20);
  for (let i = 0; i < 800; i++) {
    const full = {
      id: 'm1',
      threadId: 't1',
      internalDate: '1577836800000',
      payload: hostilePart(rnd, 0),
    };
    let out;
    assert.doesNotThrow(() => { out = extractBody(full); }, `seed 0x5eed20 draw ${i}: ${JSON.stringify(full.payload)?.slice(0, 200)}`);
    checkContract(out, '0x5eed20', i);
  }
});

test('the three measured crashes are the reproducers (walker reads, never trusts)', () => {
  const base = (payload) => ({ id: 'm1', threadId: 't1', internalDate: '1577836800000', payload });
  // Numeric mimeType killed the isInline check.
  assert.doesNotThrow(() => extractBody(base({ mimeType: 5, headers: [] })));
  // A truthy non-array parts met for..of.
  assert.doesNotThrow(() => extractBody(base({ headers: [], parts: { not: 'array' } })));
  // A numeric body.data reached b64url's .replace.
  assert.doesNotThrow(() => extractBody(base({ headers: [], mimeType: 'text/html', body: { data: 64 } })));
  // Primitives and nulls as whole parts.
  assert.doesNotThrow(() => extractBody(base(42)));
  assert.doesNotThrow(() => extractBody(base(null)));
  assert.doesNotThrow(() => extractBody({ id: 'm1', threadId: 't1' }));
});

test('honest trees extract exactly as before the totality repair', () => {
  const plain = btoa('hello body');
  const full = {
    id: 'm1',
    threadId: 't1',
    internalDate: '1577836800000',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [],
      parts: [
        { mimeType: 'text/plain', headers: [], body: { data: plain, size: 10 } },
        {
          mimeType: 'application/pdf',
          filename: 'timetable.pdf',
          headers: [],
          body: { attachmentId: 'att-1', size: 12345 },
        },
      ],
    },
  };
  const out = extractBody(full);
  assert.equal(out.text, 'hello body');
  assert.equal(out.attachments.length, 1);
  assert.equal(out.attachments[0].filename, 'timetable.pdf');
  assert.equal(out.attachments[0].attachmentId, 'att-1');
  assert.equal(out.attachments[0].size, 12345);
  // Depth discipline is untouched: nested alternatives still resolve.
  const nested = extractBody({
    id: 'm2', threadId: 't2', internalDate: '1',
    payload: {
      mimeType: 'multipart/mixed', headers: [],
      parts: [{
        mimeType: 'multipart/alternative', headers: [],
        parts: [{ mimeType: 'text/html', headers: [], body: { data: btoa('<p>hi</p>'), size: 9 } }],
      }],
    },
  });
  assert.equal(nested.html, '<p>hi</p>');
});
