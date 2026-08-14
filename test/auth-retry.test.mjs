/**
 * The AUD-M4 retry channel (audit 2026-08-15).
 *
 * AUTH_RENEW_TRANSIENT arms a retry. Before the audit the arms were an
 * `online` listener — which a service worker never receives — and a 60s
 * `setTimeout` — which dies with the worker's suspension. The comment
 * promised a retry the runtime could not deliver. The fix is a one-shot
 * chrome.alarms entry, and these pin its mechanics: armed on transient,
 * single-flight while armed, freed by the alarm run, not looped by a
 * still-dead network — and dispatched by the worker's onAlarm.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const REDIRECT = 'https://abcdef.chromiumapp.org/';
const CLIENT_ID = 'test-client.apps.googleusercontent.com';

const areaImpl = (store) => ({
  async get(k) {
    if (Array.isArray(k)) {
      const o = {};
      for (const key of k) if (key in store) o[key] = store[key];
      return o;
    }
    if (typeof k === 'string') return k in store ? { [k]: store[k] } : {};
    return { ...store };
  },
  async set(o) { Object.assign(store, o); },
  async remove(k) { for (const key of [].concat(k)) delete store[key]; },
});

async function load({ reply } = {}) {
  const store = {
    clientId: CLIENT_ID,
    authorized: true,
    accessToken: 'tok-old',
    expiresAt: Date.now() - 1000, // due: every getToken() renews silently
    accountEmail: 'a@bits.example',
  };
  const alarms = [];
  const answer =
    reply ||
    (() => new Error('network down')); // silent renewal fails = transient

  globalThis.chrome = {
    runtime: { id: 'test' },
    identity: {
      getRedirectURL: () => REDIRECT,
      launchWebAuthFlow: async (opts) => {
        const r = await answer(opts);
        if (r instanceof Error) throw r;
        return r;
      },
    },
    storage: { local: areaImpl(store), session: areaImpl(store) },
    alarms: {
      create: (name, opts) => { alarms.push({ name, ...opts }); },
      clear: async () => {},
    },
  };
  globalThis.fetch = async () => {
    throw new Error('offline');
  };

  const mod = await import(`../src/background/auth.js?t=${Math.random()}`);
  return { mod, store, alarms };
}

test('a transient renewal arms a one-shot 5-minute auth alarm', async () => {
  const h = await load();
  await assert.rejects(() => h.mod.getToken(), /AUTH_RENEW_TRANSIENT/);
  const armed = h.alarms.filter((a) => a.name === 'bmm-auth-retry');
  assert.equal(armed.length, 1, 'exactly one wake is owed');
  assert.equal(armed[0].delayInMinutes, 5, 'not the 60s of the dead timer');
  assert.equal(armed[0].periodInMinutes, undefined, 'one-shot — it must not loop');
});

test('the arm is single-flighted while one is owed', async () => {
  const h = await load();
  await assert.rejects(() => h.mod.getToken(), /AUTH_RENEW_TRANSIENT/);
  await assert.rejects(() => h.mod.getToken(), /AUTH_RENEW_TRANSIENT/);
  assert.equal(h.alarms.length, 1, 'two transients owe one wake, not two');
});

test('runAuthRetry frees the flag; a still-dead network re-arms exactly once', async () => {
  const h = await load();
  await assert.rejects(() => h.mod.getToken(), /AUTH_RENEW_TRANSIENT/);
  assert.equal(h.alarms.length, 1);
  // The alarm fired against a dead network: one more attempt, one more arm.
  await h.mod.runAuthRetry();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.alarms.length, 2,
    'the retry itself is transient, so it re-arms — spelled out, not hand-waved');
});

test('a recovered network renews on the alarm and owes nothing further', async () => {
  let dead = true;
  const h = await load({
    reply: (opts) => {
      if (dead) return new Error('network down');
      const state = new URL(opts.url).searchParams.get('state');
      return `${REDIRECT}#access_token=tok-back&expires_in=3600&state=${encodeURIComponent(state)}`;
    },
  });
  await assert.rejects(() => h.mod.getToken(), /AUTH_RENEW_TRANSIENT/);
  assert.equal(h.alarms.length, 1);

  dead = false;
  globalThis.fetch = async (url) => ({
    ok: true, status: 200,
    json: async () => ({ emailAddress: 'a@bits.example' }), // same account
    text: async () => '',
  });
  await h.mod.runAuthRetry();
  assert.equal(h.store.accessToken, 'tok-back', 'the alarm delivered the renewal');
  assert.equal(h.alarms.length, 1, 'a successful retry arms nothing');
});

test('the worker dispatches the alarm to runAuthRetry (wiring)', () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src/background/index.js'),
    'utf8'
  );
  assert.match(src, /alarm\.name === AUTH_RETRY_ALARM\)[^]*?await runAuthRetry\(\);/,
    'the name arrives, the retry runs');
  assert.match(src, /import \{[^}]*AUTH_RETRY_ALARM, runAuthRetry[^}]*\} from '\.\/auth\.js';/,
    'both halves travel together');
});
