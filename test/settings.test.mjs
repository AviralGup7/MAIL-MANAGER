/**
 * Settings tests.
 *
 * The contract under test (bug-hunt 43 #17): the storage write is the
 * AUTHORITATIVE operation. A setting that fails to persist must not pretend
 * to have taken -- the cache rolls back, the subscribers hear about the
 * reversion, and the caller gets an error it can surface.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStorage } from './helpers/storage.mjs';

const { SCHEMA, loadSettings, get, set, snapshot } = await import('../src/app/settings.js');

test('a successful set persists and is readable synchronously', async () => {
  const s = fakeStorage();
  await loadSettings(s);
  await set('theme', 'nord', s);
  assert.equal(get('theme'), 'nord', 'the cache answers immediately');
  assert.equal((await s.get('theme')).theme, 'nord', 'and the value reached storage');
});

test('a failed write rolls the cache back and throws (bug-hunt 43 #17)', async () => {
  const s = fakeStorage();
  await loadSettings(s);
  await set('theme', 'nord', s);

  // Break the NEXT write.
  s.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };

  const events = [];
  const mod = await import('../src/app/settings.js');
  const unsub = mod.subscribe?.((k, v) => events.push([k, v]));

  await assert.rejects(
    () => set('theme', 'carbon', s),
    /SETTINGS_PERSIST_FAILED/,
    'the caller must hear about the failure'
  );
  assert.equal(get('theme'), 'nord', 'the cache rolled back to the persisted value');
  assert.equal((await s.get('theme')).theme ?? 'nord', 'nord');

  // Subscribers were told about the reversion, so any UI bound to the value
  // cannot sit on the phantom.
  if (unsub) {
    assert.ok(events.some(([k, v]) => k === 'theme' && v === 'nord'),
      'the reversion is announced, not silent');
    unsub();
  }
});

test('coercion still protects every type on read and write', async () => {
  const s = fakeStorage();
  await loadSettings(s);
  await set('markReadDelayMs', '900', s);
  assert.equal(get('markReadDelayMs'), 900, 'numeric strings coerce');
  await set('remoteImages', 'bogus-value', s);
  assert.ok(SCHEMA.remoteImages.values.includes(get('remoteImages')),
    'a bad enum falls back to a legal value');
  await set('threaded', 'not-a-bool', s);
  assert.equal(typeof get('threaded'), 'boolean');
});

test('snapshot reflects the live cache', async () => {
  const s = fakeStorage();
  await loadSettings(s);
  await set('density', 'compact', s);
  assert.equal(snapshot().density, 'compact');
});
