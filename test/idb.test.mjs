/**
 * G2 m1 — the IndexedDB area behind the platform seam (2026-08-14).
 *
 * WHY THESE PINS
 * --------------
 * chrome.storage.local is a ~10MB whole-value JSON bucket; NEXT.md's G2
 * needs windowing beyond CACHE_MAX, deeper body floors, and fuller
 * offline — all of them IndexedDB work. The migration order is adapter
 * first, consumer second, so the adapter's correctness can never be
 * argued after the fact. The proof here is a CONTRACT: one suite of
 * area-semantics pins run twice — against the chrome-area fake the whole
 * suite already trusts (helpers/storage.mjs) and against platform/idb.js
 * over fake-indexeddb. If the two disagree anywhere, the seam is a lie
 * and m2's migration must not start.
 *
 * What is deliberately NOT pinned: read-aliasing (chrome deserialises per
 * read, IDB structured-clones per read; the fake aliases, and its own
 * header owns that back door), and undefined-values storage (chrome's
 * JSON law drops them; the adapter skips them; the fake keeps them —
 * callers have no business storing undefined either way).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexedDB } from 'fake-indexeddb';
import { fakeStorage } from './helpers/storage.mjs';

const { idbArea } = await import('../src/platform/idb.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

/* Each idb area gets its own database name, because fake-indexeddb's
   factory is process-wide — a shared name would leak state between tests
   exactly like two chrome profiles sharing chrome.storage.local. */
let dbSeq = 0;

/**
 * The AREA CONTRACT, run once per backend. `make` must hand back a fresh,
 * empty area per call.
 */
const areaContract = (label, make) => {
  test(`${label}: a missing string get resolves {} — never { k: undefined }`, async () => {
    const s = make();
    assert.deepEqual(await s.get('nope'), {});
  });

  test(`${label}: set then string get round-trips the value exactly`, async () => {
    const s = make();
    const blob = { v: 1, q: [{ id: 'a', note: 'déjà — dash ✓' }], n: null };
    await s.set({ k: blob });
    assert.deepEqual(await s.get('k'), { k: blob }, 'nested, unicode and null intact');
  });

  test(`${label}: an array get returns the present keys only`, async () => {
    const s = make();
    await s.set({ a: 1, c: 3 });
    assert.deepEqual(await s.get(['a', 'b', 'c']), { a: 1, c: 3 }, "'b' is omitted, not undefined");
  });

  test(`${label}: get(null) returns everything the area holds`, async () => {
    const s = make();
    await s.set({ x: { deep: [1, 2] }, y: 'two' });
    assert.deepEqual(await s.get(null), { x: { deep: [1, 2] }, y: 'two' });
  });

  test(`${label}: set overwrites — the last write is the truth`, async () => {
    const s = make();
    await s.set({ k: 'first' });
    await s.set({ k: 'second' });
    assert.deepEqual(await s.get('k'), { k: 'second' });
  });

  test(`${label}: remove by string AND by array; removing an absent key is quiet`, async () => {
    const s = make();
    await s.set({ a: 1, b: 2, c: 3 });
    await s.remove('a');
    await s.remove(['b', 'b', 'never-was']);
    assert.deepEqual(await s.get(null), { c: 3 });
  });

  test(`${label}: undefined values are skipped — chrome's JSON law`, async () => {
    /* fakeStorage KEEPS undefined (its header owns the divergence as a test
       back door); skip that backend for this one pin rather than weakening
       the contract: what the seam's callers rely on is "undefined never
       lands", and the two PRODUCTION truths — chrome and idb — both hold it. */
    if (label.startsWith('chrome-fake')) return;
    const s = make();
    await s.set({ present: 1, absent: undefined });
    assert.deepEqual(await s.get(null), { present: 1 });
  });

  test(`${label}: the area survives many keys without whole-value rewriting`, async () => {
    /* Not a perf assertion — a SHAPE one: chrome folds every write into one
       serialized value per key; an area that corrupted sibling keys would
       fail this. */
    const s = make();
    for (let i = 0; i < 25; i++) await s.set({ ['k' + i]: i });
    await s.remove('k12');
    const all = await s.get(null);
    assert.equal(Object.keys(all).length, 24);
    assert.equal(all.k0, 0);
    assert.equal(all.k24, 24);
  });
};

areaContract('chrome-fake area', () => fakeStorage());
areaContract('idb area', () => idbArea({ db: 'contract-' + (++dbSeq), backend: indexedDB }));

// ------------------------------------------------- indexeddb-specific ----

test('two store names on one database are separate universes', async () => {
  const db = 'namespaces-' + (++dbSeq);
  const a = idbArea({ db, store: 'a', backend: indexedDB });
  const b = idbArea({ db, store: 'b', backend: indexedDB });
  await a.set({ only: 'A' });
  assert.deepEqual(await b.get('only'), {}, 'an area never reads its neighbour');
  assert.deepEqual(await a.get('only'), { only: 'A' });
});

test('an absent IndexedDB rejects with an Error naming it — never a bare TypeError', async () => {
  /* `{}` has no .open — deterministic in every environment, unlike probing
     globalThis.indexedDB (which a jsdom-ish harness could someday define). */
  const orphan = idbArea({ db: 'x', backend: {} });
  await assert.rejects(orphan.get('k'), /IndexedDB/);
  await assert.rejects(orphan.set({ k: 1 }), /IndexedDB/);
});

test('a failed open does not condemn the next operation (one fresh attempt)', async () => {
  /* A factory that fails once, then works: the second op must try again
     and succeed, because the open promise is reset on failure. */
  let calls = 0;
  const flakey = {
    open(...args) {
      calls++;
      if (calls > 1) return indexedDB.open(...args);
      /* A request-shaped stub whose error handler fires without a result:
         exactly what a blocked private-mode open looks like to the caller. */
      return {
        set onupgradeneeded(fn) { /* never fires */ },
        set onsuccess(fn) { /* never fires */ },
        set onerror(fn) { queueMicrotask(() => fn()); },
        set onblocked(fn) { /* never fires */ },
        result: undefined,
        error: null,
      };
    },
  };
  const s = idbArea({ db: 'flakey-' + (++dbSeq), backend: flakey });
  await assert.rejects(s.get('k'), /IndexedDB/);
  await s.set({ k: 'recovered' });
  assert.deepEqual(await s.get('k'), { k: 'recovered' }, 'the retry opened for real');
});

// -------------------------------------------------------------- wiring ---

test('no consumer imports the adapter yet — migration is m2\'s own commit', () => {
  /* The half-migrated state (one consumer hard-wired with no fallback
     proof) is strictly worse than no migration: keep the wall bright, so
     G2 m2 is a deliberate diff with its own gates. */
  const files = [];
  (function walk(d) {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.js')) files.push(p);
    }
  })(join(ROOT, 'src'));
  const offenders = files
    .filter((f) => !f.endsWith('src/platform/idb.js'))
    .filter((f) => /idb\.js/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], 'nothing may reach for the adapter before the migration commit');
});

test('the platform layer stays dependency-free — it does not reach up', () => {
  const src = read('src/platform/idb.js');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, ''); // comments may name imports
  assert.ok(!/^\s*import\s/m.test(body), 'platform modules import nothing');
});
