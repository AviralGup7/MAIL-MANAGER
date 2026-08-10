/**
 * OAuth tests.
 *
 * auth.js is the most security-sensitive file in the extension and the hardest
 * to verify by hand, because the failure modes are all Google-side. Everything
 * here drives the real code through a stubbed `chrome.identity` and `fetch`.
 *
 * The flow is the IMPLICIT flow (`response_type=token`), not PKCE. That is not
 * a preference -- Google's token endpoint demands `client_secret` for
 * authorization-code exchanges on a Web application client even when PKCE is
 * used, and Chrome Extension type clients reject `chromiumapp.org` redirects
 * outright. Both routes were tried against the live API and both fail. See the
 * file header of src/background/auth.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

// ---------------------------------------------------------------- harness --

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;
if (!globalThis.btoa) {
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
}

const REDIRECT = 'https://abcdef.chromiumapp.org/';
const CLIENT_ID = 'test-client.apps.googleusercontent.com';

/**
 * Fresh module instance per test, so the in-flight renewal promise and the
 * fake storage never leak between cases.
 */
async function load({ storage = { clientId: CLIENT_ID } } = {}) {
  const store = { ...storage };
  const calls = { authFlow: [], fetch: [] };

  /** Default: grant a token, echoing back the state we were given. */
  let reply = (opts) => {
    const state = new URL(opts.url).searchParams.get('state');
    return `${REDIRECT}#access_token=tok-1&token_type=Bearer&expires_in=3600&state=${encodeURIComponent(state)}`;
  };

  globalThis.chrome = {
    runtime: { id: 'test' },
    identity: {
      getRedirectURL: () => REDIRECT,
      launchWebAuthFlow: async (opts) => {
        calls.authFlow.push(opts);
        const r = reply(opts);
        if (r instanceof Error) throw r;
        return r;
      },
    },
    storage: {
      local: {
        async get(k) {
          if (Array.isArray(k)) {
            const o = {};
            for (const key of k) if (key in store) o[key] = store[key];
            return o;
          }
          if (typeof k === 'string') return k in store ? { [k]: store[k] } : {};
          return { ...store };
        },
        async set(o) {
          Object.assign(store, o);
        },
        async remove(k) {
          for (const key of [].concat(k)) delete store[key];
        },
      },
    },
  };

  globalThis.fetch = async (url, init) => {
    calls.fetch.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };

  const mod = await import(`../src/background/auth.js?t=${Math.random()}`);
  return { mod, store, calls, setReply: (fn) => (reply = fn) };
}

/** The authorization URL the code built, parsed. */
const authParams = (h, i = 0) => new URL(h.calls.authFlow[i].url).searchParams;

// --------------------------------------------------------------- the flow --

test('sign-in requests a token directly and sends no secret anywhere', async () => {
  const h = await load();
  await h.mod.signIn();

  const p = authParams(h);
  assert.equal(p.get('response_type'), 'token', 'implicit flow: no code to exchange');
  assert.equal(p.get('client_id'), CLIENT_ID);
  assert.equal(p.get('redirect_uri'), REDIRECT);
  assert.match(p.get('scope'), /gmail\.modify/);
  assert.equal(p.get('client_secret'), null, 'a secret must never appear');

  // The decisive property: there is no token-endpoint call at all, which is
  // exactly why no client_secret can ever be demanded.
  assert.equal(
    h.calls.fetch.filter((c) => c.url.includes('/token')).length,
    0,
    'no token exchange may occur'
  );
});

test('the interactive sign-in asks for consent', async () => {
  const h = await load();
  await h.mod.signIn();
  assert.equal(authParams(h).get('prompt'), 'consent');
  assert.equal(h.calls.authFlow[0].interactive, true);
});

test('the token and its expiry are persisted, with a safety margin', async () => {
  const h = await load();
  const before = Date.now();
  await h.mod.signIn();

  assert.equal(h.store.accessToken, 'tok-1');
  assert.equal(h.store.authorized, true, 'consent must be remembered');
  // Renewed 5 minutes early: implicit tokens cannot be refreshed on demand, so
  // a request must never race the expiry mid-sync.
  const margin = h.store.expiresAt - (before + 3600 * 1000);
  assert.ok(margin <= -299_000 && margin >= -301_000, `expected ~-300s, got ${margin}ms`);
});

test('CSRF: a mismatched state is rejected', async () => {
  const h = await load();
  h.setReply(() => `${REDIRECT}#access_token=tok&expires_in=3600&state=forged`);
  await assert.rejects(() => h.mod.signIn(), /state mismatch/i);
  assert.equal(h.store.accessToken, undefined, 'nothing may be persisted');
});

test('a missing state is rejected too', async () => {
  const h = await load();
  h.setReply(() => `${REDIRECT}#access_token=tok&expires_in=3600`);
  await assert.rejects(() => h.mod.signIn(), /state mismatch/i);
});

test('each sign-in uses a fresh state', async () => {
  const seen = new Set();
  for (let i = 0; i < 3; i++) {
    const h = await load();
    await h.mod.signIn();
    seen.add(authParams(h).get('state'));
  }
  assert.equal(seen.size, 3, 'state must never repeat');
});

test('the token is read from the FRAGMENT, not the query string', async () => {
  // Implicit flow returns everything after the '#'. Parsing the query instead
  // silently yields nothing, which is a classic implementation error.
  const h = await load();
  h.setReply((opts) => {
    const state = new URL(opts.url).searchParams.get('state');
    return `${REDIRECT}#access_token=frag-token&expires_in=1800&state=${encodeURIComponent(state)}`;
  });
  await h.mod.signIn();
  assert.equal(h.store.accessToken, 'frag-token');
});

test('a response with no token explains what to fix', async () => {
  const h = await load();
  h.setReply((opts) => {
    const state = new URL(opts.url).searchParams.get('state');
    return `${REDIRECT}#state=${encodeURIComponent(state)}`;
  });
  const err = await h.mod.signIn().then(() => null, (e) => e);
  assert.match(err.message, /Web application/, 'must name the required client type');
  assert.match(err.message, /chromiumapp\.org/, 'must show the redirect URI to register');
});

test('a cancelled sign-in says so', async () => {
  const h = await load();
  h.setReply(() => undefined);
  await assert.rejects(() => h.mod.signIn(), /cancelled/i);
});

test('sign-in with no client ID configured explains where to set it', async () => {
  const h = await load({ storage: {} });
  await assert.rejects(() => h.mod.signIn(), /client ID/i);
});

// ------------------------------------------------------ error diagnostics --

/**
 * These exist because "Token exchange failed (400)." wasted a real debugging
 * session: it discarded the body, which is the only field distinguishing
 * several unrelated setup mistakes. A test asserting only "throws" would have
 * passed against that useless message.
 */

test('redirect_uri_mismatch names the exact fix', async () => {
  const h = await load();
  h.setReply(() => `${REDIRECT}#error=redirect_uri_mismatch`);
  const err = await h.mod.signIn().then(() => null, (e) => e);
  assert.match(err.message, /redirect_uri_mismatch/);
  assert.match(err.message, /FIX:/);
  assert.match(err.message, /Authorized redirect URIs/i);
});

test('access_denied points at the test-user list', async () => {
  const h = await load();
  h.setReply(() => `${REDIRECT}#error=access_denied`);
  const err = await h.mod.signIn().then(() => null, (e) => e);
  assert.match(err.message, /Test users/i);
});

test('admin_policy_enforced explains it is a BITS domain restriction', async () => {
  // Institutional Workspace accounts commonly block third-party Gmail access,
  // and the raw error code gives a student no clue what to do.
  const h = await load();
  h.setReply(() => `${REDIRECT}#error=admin_policy_enforced`);
  const err = await h.mod.signIn().then(() => null, (e) => e);
  assert.match(err.message, /admin/i);
});

test('an unknown error still surfaces what Google said', async () => {
  const h = await load();
  h.setReply(() => `${REDIRECT}#error=some_new_thing&error_description=details+here`);
  const err = await h.mod.signIn().then(() => null, (e) => e);
  assert.match(err.message, /some_new_thing/);
  assert.match(err.message, /details here/);
});

test('no failure message is ever a bare status code', async () => {
  // The regression guard for the message that caused the round trip.
  for (const code of ['invalid_client', 'invalid_request', 'redirect_uri_mismatch']) {
    const h = await load();
    h.setReply(() => `${REDIRECT}#error=${code}`);
    const err = await h.mod.signIn().then(() => null, (e) => e);
    assert.ok(err.message.length > 60, `"${code}" gave: ${err.message}`);
    assert.match(err.message, /FIX:/, `"${code}" must carry a remedy`);
  }
});

// ------------------------------------------------------------ token cycle --

test('a live token is reused without any auth round trip', async () => {
  const h = await load({
    storage: {
      clientId: CLIENT_ID,
      accessToken: 'live',
      expiresAt: Date.now() + 600_000,
      authorized: true,
    },
  });
  assert.equal(await h.mod.getToken(), 'live');
  assert.equal(h.calls.authFlow.length, 0, 'must not re-authorize while valid');
});

test('an expired token is renewed SILENTLY, with no UI', async () => {
  // The property that makes the implicit flow acceptable. If this ever became
  // interactive, the user would face a popup every hour.
  const h = await load({
    storage: {
      clientId: CLIENT_ID,
      accessToken: 'stale',
      expiresAt: Date.now() - 1000,
      authorized: true,
    },
  });
  h.setReply((opts) => {
    const state = new URL(opts.url).searchParams.get('state');
    return `${REDIRECT}#access_token=renewed&expires_in=3600&state=${encodeURIComponent(state)}`;
  });

  assert.equal(await h.mod.getToken(), 'renewed');
  assert.equal(h.calls.authFlow[0].interactive, false, 'renewal must never show UI');
  assert.equal(authParams(h).get('prompt'), 'none', 'prompt=none is what keeps it silent');
});

test('concurrent callers share ONE renewal', async () => {
  // A sync burst issues many requests at once; a dozen simultaneous auth flows
  // would be slow and would be rate-limited.
  const h = await load({
    storage: {
      clientId: CLIENT_ID,
      accessToken: 'stale',
      expiresAt: Date.now() - 1000,
      authorized: true,
    },
  });
  h.setReply((opts) => {
    const state = new URL(opts.url).searchParams.get('state');
    return `${REDIRECT}#access_token=fresh&expires_in=3600&state=${encodeURIComponent(state)}`;
  });

  const results = await Promise.all([
    h.mod.getToken(),
    h.mod.getToken(),
    h.mod.getToken(),
    h.mod.getToken(),
  ]);
  assert.deepEqual(results, ['fresh', 'fresh', 'fresh', 'fresh']);
  assert.equal(h.calls.authFlow.length, 1, `expected 1 renewal, got ${h.calls.authFlow.length}`);
});

test('a failed silent renewal reports NOT_SIGNED_IN and stops retrying', async () => {
  // When the Google session cookie is gone, prompt=none fails. The UI must get
  // a clean signal to show the gate rather than looping.
  const h = await load({
    storage: {
      clientId: CLIENT_ID,
      accessToken: 'stale',
      expiresAt: Date.now() - 1000,
      authorized: true,
    },
  });
  h.setReply(() => `${REDIRECT}#error=login_required`);

  await assert.rejects(() => h.mod.getToken(), /NOT_SIGNED_IN/);
  assert.equal(h.store.authorized, undefined, 'must not keep retrying silently');
});

test('getToken without consent reports NOT_SIGNED_IN immediately', async () => {
  const h = await load();
  await assert.rejects(() => h.mod.getToken(), /NOT_SIGNED_IN/);
  assert.equal(h.calls.authFlow.length, 0, 'must not open a window unprompted');
});

// ---------------------------------------------------------------- signOut --

test('sign-out revokes the token server-side', async () => {
  // With no refresh token, the access token IS the grant -- revoking it ends
  // access rather than merely forgetting it. v1 cleared storage only.
  const h = await load({
    storage: { clientId: CLIENT_ID, accessToken: 'tok-1', authorized: true },
  });
  await h.mod.signOut();

  assert.equal(h.calls.fetch.length, 1);
  assert.match(h.calls.fetch[0].url, /\/revoke/);
  assert.match(h.calls.fetch[0].url, /tok-1/);
});

test('sign-out clears consent and the delta cursor', async () => {
  const h = await load({
    storage: {
      clientId: CLIENT_ID,
      accessToken: 'a',
      expiresAt: 123,
      authorized: true,
      historyId: '999',
      theme: 'nord',
    },
  });
  await h.mod.signOut();

  for (const k of ['accessToken', 'expiresAt', 'authorized', 'historyId']) {
    assert.equal(h.store[k], undefined, `${k} must be cleared`);
  }
  assert.equal(h.store.clientId, CLIENT_ID, 'the client ID is not a credential');
  assert.equal(h.store.theme, 'nord', 'unrelated settings survive');
});

test('sign-out still clears locally when offline', async () => {
  const h = await load({
    storage: { clientId: CLIENT_ID, accessToken: 'a', authorized: true },
  });
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  await h.mod.signOut();
  assert.equal(h.store.authorized, undefined);
});

test('isSignedIn tracks consent, not the presence of a token', async () => {
  // An implicit token expires hourly. Treating its absence as "signed out"
  // would show the sign-in gate every hour.
  const a = await load();
  assert.equal(await a.mod.isSignedIn(), false);

  const b = await load({ storage: { clientId: CLIENT_ID, authorized: true } });
  assert.equal(await b.mod.isSignedIn(), true, 'consent without a live token is still signed in');
});

/* ========================================================================== *
 * SESSION LIFECYCLE RACES
 *
 * A SECURITY DEFECT lived here. `signOut()` cleared storage, but a silent
 * renewal already in flight called `persist()` afterwards and wrote a fresh,
 * LIVE access token back. Signing out during a renewal left the user
 * believing they were signed out while a working credential sat in storage.
 *
 * Clearing storage cannot reach work that has already started, which is why
 * the fix is a session epoch rather than another `remove()` call: every
 * operation that writes credentials captures the epoch first and refuses to
 * commit if it has moved.
 * ========================================================================== */

/** A reply that takes `ms` to arrive, so a race can be driven deterministically. */
const slowGrant = (token, ms) => async (opts) => {
  await new Promise((r) => setTimeout(r, ms));
  const state = new URL(opts.url).searchParams.get('state');
  return `${REDIRECT}#access_token=${token}&token_type=Bearer&expires_in=3600&state=${encodeURIComponent(state)}`;
};

test('signing out during a silent renewal does not resurrect the token', async () => {
  const h = await load({
    storage: { clientId: CLIENT_ID, authorized: true, accessToken: 'old', expiresAt: Date.now() - 1000 },
  });
  h.setReply(slowGrant('RESURRECTED', 60));

  const renewal = h.mod.getToken().catch(() => 'threw');
  await new Promise((r) => setTimeout(r, 10)); // renewal is mid-flight
  await h.mod.signOut();
  await renewal;
  await new Promise((r) => setTimeout(r, 60)); // let it fully settle

  assert.equal(h.store.accessToken, undefined,
    'a revoked session must not have a token written back after signOut');
  assert.ok(!h.store.authorized, 'the authorized flag must stay cleared');
});

test('signing out during a renewal leaves isSignedIn false', async () => {
  // The user-visible half: the gate must appear, not a working inbox.
  const h = await load({
    storage: { clientId: CLIENT_ID, authorized: true, accessToken: 'old', expiresAt: Date.now() - 1000 },
  });
  h.setReply(slowGrant('RESURRECTED', 50));
  const renewal = h.mod.getToken().catch(() => {});
  await new Promise((r) => setTimeout(r, 10));
  await h.mod.signOut();
  await renewal;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await h.mod.isSignedIn(), false);
});

test('a new sign-in is not overwritten by the previous session\'s renewal', async () => {
  /*
   * Worse than the sign-out case: the stale renewal belongs to the OLD
   * account, so without the epoch the user ends up holding the previous
   * account's token while the UI shows the new one — reading the wrong
   * mailbox with no indication anything is wrong.
   */
  const h = await load({
    storage: { clientId: CLIENT_ID, authorized: true, accessToken: 'old', expiresAt: Date.now() - 1000 },
  });
  h.setReply(slowGrant('STALE', 80));
  const stale = h.mod.getToken().catch(() => {});

  await new Promise((r) => setTimeout(r, 10));
  h.setReply(slowGrant('NEWACCOUNT', 5));
  await h.mod.signIn();

  await stale;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(h.store.accessToken, 'NEWACCOUNT',
    'the superseded renewal overwrote the fresh sign-in');
});

test('a superseded renewal does not clear a freshly signed-in session', async () => {
  // The inverse hazard: renew()'s failure path removes credentials. If a
  // superseded renewal ran that path it would sign the user out immediately
  // after they signed in.
  const h = await load({
    storage: { clientId: CLIENT_ID, authorized: true, accessToken: 'old', expiresAt: Date.now() - 1000 },
  });
  h.setReply(async () => { await new Promise((r) => setTimeout(r, 60)); throw new Error('silent failed'); });
  const stale = h.mod.getToken().catch(() => {});

  await new Promise((r) => setTimeout(r, 10));
  h.setReply(slowGrant('GOOD', 5));
  await h.mod.signIn();

  await stale;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(h.store.accessToken, 'GOOD', 'a stale failure wiped the new session');
  assert.equal(await h.mod.isSignedIn(), true);
});

test('normal renewal still works after the epoch guard', async () => {
  // The guard must not break the path it protects.
  const h = await load({
    storage: { clientId: CLIENT_ID, authorized: true, accessToken: 'old', expiresAt: Date.now() - 1000 },
  });
  h.setReply(slowGrant('FRESH', 5));
  assert.equal(await h.mod.getToken(), 'FRESH');
  assert.equal(h.store.accessToken, 'FRESH');
});

test('concurrent getToken() calls still share ONE authorization flow', async () => {
  const h = await load({
    storage: { clientId: CLIENT_ID, authorized: true, accessToken: 'old', expiresAt: Date.now() - 1000 },
  });
  h.setReply(slowGrant('ONE', 30));
  const results = await Promise.all(Array.from({ length: 6 }, () => h.mod.getToken()));
  assert.equal(h.calls.authFlow.length, 1, `single-flight broken: ${h.calls.authFlow.length} flows`);
  assert.deepEqual([...new Set(results)], ['ONE'], 'callers disagreed on the token');
});

test('a NETWORK-failed renewal keeps consent and reports transient (H3)', async () => {
  // A wifi dropout during the hourly silent renewal must not look like
  // "you never signed in": consent survives, the error is transient, and the
  // retry is scheduled rather than a loop.
  const h = await load({
    storage: { clientId: CLIENT_ID, authorized: true, accessToken: 'old', expiresAt: Date.now() - 1000 },
  });
  h.setReply(() => new Error('silent failed'));
  await assert.rejects(() => h.mod.getToken(), /AUTH_RENEW_TRANSIENT/);
  assert.equal(h.store.authorized, true, 'consent must survive a network blip');
});

test('a REVOKED renewal clears authorized so the gate appears', async () => {
  const h = await load({
    storage: { clientId: CLIENT_ID, authorized: true, accessToken: 'old', expiresAt: Date.now() - 1000 },
  });
  h.setReply(() => `${REDIRECT}#error=access_denied`);
  await assert.rejects(() => h.mod.getToken(), /NOT_SIGNED_IN/);
  assert.ok(!h.store.authorized, 'confirmed revocation must end consent');
});
