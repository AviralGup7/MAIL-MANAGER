/**
 * Account identity tests — the pins for audit 2026-08-15's two CRITICALs.
 *
 * AUD-C1: silent OAuth renewal (`prompt=none`) mints a token for whichever
 * account the BROWSER treats as current this hour. Before the fix there was
 * no proof step: the new account's token was persisted, and the extension
 * applied the old account's historyId, label cache, notify dedupe and queued
 * sends to it. The law now: every silent renewal proves WHO the token belongs
 * to before anything is persisted; only "proved different" is destructive,
 * and "couldn't check" is transient (AUTH_RENEW_TRANSIENT), never clearance.
 *
 * AUD-C2: the outbox was the one account-scoped store that survived sign-out,
 * so a queued — or failed-but-retryable — send could leave under the NEXT
 * account's token. The law now: every queued row carries the account that
 * queued it, the pump refuses a row stamped for a different account, and
 * sign-out clears the queue under the `clearOutboxOnSignOut` setting (ON by
 * default). Legacy unstamped rows stay dispatchable: refusing mail nobody can
 * identify would strand real messages.
 *
 * The auth harness mirrors auth.test.mjs, with one extension: profile answers
 * are PER-TOKEN, so a test can mint a token for account B on a session that
 * belongs to account A — the exact move the audit traced.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { fakeStorage } from './helpers/storage.mjs';

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const REDIRECT = 'https://abcdef.chromiumapp.org/';
const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

const A = 'a@bits.example';
const B = 'b@gmail.example';

// ---------------------------------------------------------------- harness --

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

/**
 * @param {object} opts.storage seed for the shared backing store
 * @param {(opts: object) => string|Error|Promise<string>} [opts.reply]
 *        the OAuth reply; receives the launchWebAuthFlow argument so it can
 *        mint different tokens for silent vs interactive flows
 * @param {Map<string, {email:string, delayMs?:number}|Error>} [opts.profiles]
 *        profile answers keyed by Bearer token — the per-TOKEN map is the
 *        whole point: Google answers for whoever the token names
 */
async function load({ storage = {}, reply, profiles = new Map() } = {}) {
  const store = { clientId: CLIENT_ID, ...storage };
  const calls = { authFlow: [], fetch: [] };

  const grant = (opts) => {
    const state = new URL(opts.url).searchParams.get('state');
    // Silent and interactive default to different tokens: renewal tests must
    // be able to tell WHICH round trip a persisted token came from.
    const token = opts.interactive ? 'tok-interactive' : 'tok-silent';
    return `${REDIRECT}#access_token=${token}&token_type=Bearer&expires_in=3600&state=${encodeURIComponent(state)}`;
  };
  const answer = reply || grant;

  globalThis.chrome = {
    runtime: { id: 'test' },
    identity: {
      getRedirectURL: () => REDIRECT,
      launchWebAuthFlow: async (opts) => {
        calls.authFlow.push(opts);
        const r = await answer(opts);
        if (r instanceof Error) throw r;
        return r;
      },
    },
    storage: { local: areaImpl(store), session: areaImpl(store) },
  };

  globalThis.fetch = async (url, init) => {
    calls.fetch.push({ url: String(url), init });
    const u = String(url);
    if (u.startsWith(PROFILE_URL)) {
      const bearer = /Bearer (\S+)/.exec(String(init?.headers?.Authorization || ''))?.[1];
      const p = profiles.get(bearer);
      if (!p) throw new Error(`no profile stub for ${bearer}`);
      if (p.delayMs) await new Promise((r) => setTimeout(r, p.delayMs));
      if (p instanceof Error) throw p;
      return { ok: true, status: 200, json: async () => ({ emailAddress: p.email }) };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };

  const mod = await import(`../src/background/auth.js?t=${Math.random()}`);
  return { mod, store, calls, setProfiles: (m) => { profiles.clear(); for (const [k, v] of m) profiles.set(k, v); } };
}

const signedInSeed = {
  authorized: true,
  accessToken: 'tok-old',
  expiresAt: Date.now() - 1000, // due for silent renewal
  historyId: '777',
  bgNotifiedIds: ['m1', 'm2'],
  accountEmail: A,
};

// ================================================================== AUD-C1 ==

test('sign-in stamps the account, canonicalised (lowercase + trim)', async () => {
  const h = await load({
    profiles: new Map([['tok-interactive', { email: '  A@BITS.EXAMPLE ' }]]),
  });
  await h.mod.signIn();
  assert.equal(h.store.accountEmail, A,
    'the stamp is the canonical form — every later comparison depends on it');
  assert.equal(h.store.accessToken, 'tok-interactive');
});

test('sign-in fails closed when the account identity cannot be proved', async () => {
  const h = await load({
    profiles: new Map([['tok-interactive', new Error('offline')]]),
  });
  await assert.rejects(() => h.mod.signIn(), /offline/);
  assert.equal(h.store.accessToken, undefined, 'an unowned token never activates');
  assert.equal(h.store.authorized, undefined, 'consent is not an active session without identity');
  assert.equal(h.store.accountEmail, undefined, 'no owner was guessed');
});

test('a renewal for the SAME account persists and keeps every session key', async () => {
  const h = await load({
    storage: signedInSeed,
    profiles: new Map([['tok-silent', { email: ' A@BITS.EXAMPLE' }]]),
  });
  assert.equal(await h.mod.getToken(), 'tok-silent');
  assert.equal(h.store.accessToken, 'tok-silent', 'the fresh token lands');
  assert.equal(h.store.accountEmail, A, 'stamp untouched (not rewritten)');
  assert.equal(h.store.historyId, '777', 'the delta cursor survives');
  assert.deepEqual(h.store.bgNotifiedIds, ['m1', 'm2'], 'notify dedupe survives');
});

test('a renewal for a DIFFERENT account clears the session and refuses', async () => {
  /* THE AUD-C1 MOVE: the browser's default Google session moved from A to B.
     The daemon's answer must be the end of THIS session — nothing of A may
     carry into B, and B's token must never be persisted here. */
  const h = await load({
    storage: signedInSeed,
    profiles: new Map([['tok-silent', { email: B }]]),
  });
  await assert.rejects(() => h.mod.getToken(), /^Error: ACCOUNT_CHANGED$/);

  for (const k of ['accessToken', 'expiresAt', 'authorized', 'historyId', 'bgNotifiedIds', 'accountEmail']) {
    assert.equal(h.store[k], undefined, `${k} must be cleared`);
  }
  assert.equal(h.store.clientId, CLIENT_ID, 'the client ID is not account data');
  assert.equal(await h.mod.isSignedIn(), false, 'the gate must appear');
});

test('a FAILED identity check clears nothing and reports transient', async () => {
  /* Network blip during validation. "Couldn't check" must never masquerade
     as "account changed" — the remedy for a real change wipes account-scoped
     state, so crying wolf with it would sign users out over nothing. */
  const h = await load({
    storage: signedInSeed,
    profiles: new Map([['tok-silent', new Error('connection reset')]]),
  });
  await assert.rejects(() => h.mod.getToken(), /AUTH_RENEW_TRANSIENT/);
  assert.equal(h.store.accessToken, 'tok-old', 'the old token was not dropped');
  assert.equal(h.store.authorized, true, 'consent survives');
  assert.equal(h.store.historyId, '777');
  assert.equal(h.store.accountEmail, A, 'the stamp survives');
});

test('a legacy install is stamped on its first renewal and never cleared for lacking one', async () => {
  /* Upgrading users have a live session and no stamp. The first successful
     renewal writes one; nobody is ever treated as a stranger for lacking
     state the old version could not have written. */
  const { accountEmail, ...legacy } = signedInSeed; // eslint-disable-line no-unused-vars
  const h = await load({
    storage: legacy,
    profiles: new Map([['tok-silent', { email: 'WHO@LEGACY.EXAMPLE' }]]),
  });
  assert.equal(h.store.accountEmail, undefined, 'precondition: no stamp');
  assert.equal(await h.mod.getToken(), 'tok-silent');
  assert.equal(h.store.accountEmail, 'who@legacy.example', 'the first renewal wrote the stamp');
  assert.equal(h.store.historyId, '777', 'nothing of the session was cleared');
});

test('a superseded renewal never clears the NEW session’s stamp', async () => {
  /* The epoch re-check sits AFTER the identity fetch for a reason: without
     it, a renewal that started under account A — whose slow profile answer
     (B) resolves only after the user signed in as C — would compare B to C's
     fresh stamp and "helpfully" end C's session. */
  const profiles = new Map([
    ['tok-silent', { email: B, delayMs: 50 }], // the straggler, belongs to B
    ['tok-interactive', { email: 'c@new.example' }],
  ]);
  const h = await load({ storage: signedInSeed, profiles });

  const stale = h.mod.getToken().catch((e) => e);
  await new Promise((r) => setTimeout(r, 10)); // silent flow done, profile of B in flight
  await h.mod.signIn(); // C signs in; the epoch moves

  const outcome = await stale;
  assert.ok(outcome instanceof Error, 'the straggler must not resolve with a token');
  assert.match(outcome.message, /NOT_SIGNED_IN/);
  assert.equal(h.store.accountEmail, 'c@new.example', "C's stamp survived B's late proof");
  assert.equal(h.store.accessToken, 'tok-interactive', "C's token survived");
  assert.equal(h.store.authorized, true);
});

test('sign-out drops the identity stamp with the rest of the session', async () => {
  /* Keeping the stamp would frame the NEXT sign-in's first renewal as an
     account change — a cascade of false clearances after every switch. */
  const h = await load({ storage: signedInSeed });
  await h.mod.signOut();
  for (const k of ['accessToken', 'expiresAt', 'authorized', 'historyId', 'bgNotifiedIds', 'accountEmail']) {
    assert.equal(h.store[k], undefined, `${k} must be cleared`);
  }
});

// ================================================================== AUD-C2 ==

const outboxMod = await import('../src/features/outbox/model.js');
const { enqueue, dispatchable, clearOutbox, normaliseOutbox, flushOutbox, saveOutbox, loadOutbox, _resetOutbox } =
  outboxMod;

const NOW = 1_760_000_000_000;
const draft = { to: 'prof@bits.example', subject: 'Lab', body: 'text' };

test('dispatchable: legacy passes, the owner passes, a stranger is refused', () => {
  // Unstamped rows predate identity: refusing them would strand real mail.
  assert.equal(dispatchable({ draft }, A), true, 'legacy under a known session');
  /*
   * Including under an unproven session, and that is LOAD-BEARING (audit
   * EXT2-M6, withdrawn). Refusing here was tried and reverted: accountEmail
   * is absent for an ordinary single-account install until identity
   * activation completes, so the stricter rule stranded queued mail in seven
   * existing scenarios — the exact harm the legacy fail-open prevents. The
   * cross-account send it was meant to stop is already prevented by the
   * STAMP on every row written since AUD-C2.
   */
  assert.equal(dispatchable({ draft }, ''), true, 'legacy under an unproven session');
  // A stamped row is a promise BY someone — asymmetric on purpose.
  assert.equal(dispatchable({ draft, accountEmail: A }, A.toUpperCase()), true,
    'the compare canonicalises both sides');
  assert.equal(dispatchable({ draft, accountEmail: ` ${A} ` }, A), true, 'whitespace tolerated');
  assert.equal(dispatchable({ draft, accountEmail: A }, B), false, 'never under a stranger');
  assert.equal(dispatchable({ draft, accountEmail: A }, ''), false,
    'an owned row requires a proved current account');
});

test('enqueue stamps when told, omits otherwise; normalise round-trips the stamp', () => {
  const stamped = enqueue(draft, { now: NOW, accountEmail: A });
  assert.equal(stamped.accountEmail, A);
  assert.equal(enqueue(draft, { now: NOW }).accountEmail, undefined, 'absent stays absent');
  assert.equal(enqueue(draft, { now: NOW, accountEmail: '' }).accountEmail, undefined,
    'an unknown owner is not a stamp');

  const [back] = normaliseOutbox([stamped]);
  assert.equal(back.accountEmail, A, 'the stamp survives a reload — un-stamping would un-scope');
  assert.equal(normaliseOutbox([{ draft, accountEmail: 42 }])[0].accountEmail, undefined,
    'a non-string stamp is not one');
});

test('clearOutbox empties the queue and only the queue', async () => {
  const s = fakeStorage({ theme: 'nord' });
  _resetOutbox();
  await saveOutbox([enqueue(draft, { now: NOW, accountEmail: A })], s);
  assert.equal((await loadOutbox(s)).length, 1, 'precondition: one queued');
  assert.equal(await clearOutbox(s), true);
  assert.deepEqual(await loadOutbox(s), [], 'the queue died with the session');
  assert.equal((await s.get('theme')).theme, 'nord', 'unrelated data survives');
});

test('the pump refuses a stranger’s queue and keeps it armed for its owner', async () => {
  const s = fakeStorage();
  _resetOutbox();
  const item = enqueue(draft, { now: NOW, holdMs: 0, accountEmail: A }); // due NOW
  await saveOutbox([item], s);

  const sentTo = [];
  const underB = await flushOutbox({
    send: async (d) => { sentTo.push(d); return { id: 'g1' }; },
    storage: s, now: NOW + 1, accountEmail: B,
  });
  assert.equal(underB.sent, 0, 'NOTHING of A left under B');
  assert.equal(sentTo.length, 0, 'the send callback never fired');
  assert.equal(underB.wrongAccount, 1, 'the refusal is counted, for the activity log');
  const [armed] = await loadOutbox(s);
  assert.equal(armed.state, 'held', 'the row stays armed — it is A’s to send or cancel');

  _resetOutbox();
  const underA = await flushOutbox({
    send: async () => ({ id: 'g2' }), storage: s, now: NOW + 2, accountEmail: A,
  });
  assert.equal(underA.sent, 1, 'the owner’s pump dispatches it');
  assert.deepEqual(await loadOutbox(s), [], 'sent is gone from the queue');
});

test('the pump dispatches legacy rows under any session (no stranding)', async () => {
  const s = fakeStorage();
  _resetOutbox();
  await saveOutbox([enqueue(draft, { now: NOW, holdMs: 0 })], s); // no stamp
  const out = await flushOutbox({
    send: async () => ({ id: 'g3' }), storage: s, now: NOW + 1, accountEmail: B,
  });
  assert.equal(out.sent, 1, 'legacy mail is never stranded by identity');
  assert.equal(out.wrongAccount, undefined, 'no refusal was counted');
});
