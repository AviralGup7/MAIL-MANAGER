/**
 * PKCE sign-in tests.
 *
 * auth.js is 244 lines of security-critical code and had no direct test. The
 * `state` check is the CSRF control for the whole OAuth flow; the PKCE
 * challenge is what replaces the client secret that v1 leaked. Neither was
 * asserted anywhere, so a refactor that turned the state throw into a warning,
 * or broke the challenge derivation, would have shipped green.
 *
 * Everything is driven through stubbed `chrome.identity` and `fetch`, so the
 * real code path runs -- no reimplementation of the crypto in the test.
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

/** Fresh module instance per test, so `inFlight` and storage never leak. */
async function load({ storage = { clientId: CLIENT_ID } } = {}) {
  const store = { ...storage };
  const calls = { fetch: [], authFlow: [] };

  /** Queue of responses for successive fetch calls. */
  let fetchQueue = [];

  globalThis.chrome = {
    runtime: { id: 'test' },
    identity: {
      getRedirectURL: () => REDIRECT,
      launchWebAuthFlow: async (opts) => {
        calls.authFlow.push(opts);
        return authFlowReply(opts);
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

  /** Default: echo back a valid code with the state we were given. */
  let authFlowReply = (opts) => {
    const state = new URL(opts.url).searchParams.get('state');
    return `${REDIRECT}?code=auth-code-123&state=${encodeURIComponent(state)}`;
  };

  globalThis.fetch = async (url, init) => {
    calls.fetch.push({ url: String(url), init, body: init?.body?.toString?.() ?? '' });
    const next = fetchQueue.shift();
    if (!next) return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    return next;
  };

  const mod = await import(`../src/background/auth.js?t=${Math.random()}`);
  return {
    mod,
    store,
    calls,
    setAuthFlowReply: (fn) => (authFlowReply = fn),
    queueFetch: (...rs) => (fetchQueue = rs),
  };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
const fail = (status) => ({ ok: false, status, json: async () => ({}), text: async () => '' });

const TOKENS = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_in: 3600,
};

/** Parse the authorize URL the code built. */
const authParams = (h) => new URL(h.calls.authFlow[0].url).searchParams;
/** Parse a form-encoded token request body. */
const tokenBody = (h, i = 0) => new URLSearchParams(h.calls.fetch[i].body);

// --------------------------------------------------------------- the flow --

test('sign-in sends a correct S256 PKCE challenge and no client secret', async () => {
  const h = await load();
  h.queueFetch(ok(TOKENS));
  await h.mod.signIn();

  const p = authParams(h);
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.equal(p.get('client_id'), CLIENT_ID);
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('access_type'), 'offline');

  // The challenge must actually be BASE64URL(SHA-256(verifier)). Recompute it
  // from the verifier the code sent to the token endpoint.
  const verifier = tokenBody(h).get('code_verifier');
  assert.ok(verifier, 'a verifier must be sent in the exchange');
  assert.equal(verifier.length, 43, 'RFC 7636 recommends 32 bytes -> 43 chars');

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const expected = Buffer.from(digest)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  assert.equal(p.get('code_challenge'), expected, 'challenge must be SHA-256 of the verifier');

  // The whole point of PKCE here: v1 shipped a client secret, this must not.
  const body = tokenBody(h);
  assert.equal(body.get('client_secret'), null, 'no client secret may ever be sent');
  assert.equal(body.get('grant_type'), 'authorization_code');
});

test('CSRF: a mismatched state aborts the sign-in before exchanging the code', async () => {
  const h = await load();
  h.setAuthFlowReply(() => `${REDIRECT}?code=auth-code-123&state=forged-by-attacker`);
  h.queueFetch(ok(TOKENS));

  await assert.rejects(() => h.mod.signIn(), /state mismatch/i);
  // Critical: the code must never be redeemed when state fails.
  assert.equal(h.calls.fetch.length, 0, 'no token exchange may occur');
  assert.equal(h.store.accessToken, undefined);
});

test('a missing state also aborts', async () => {
  const h = await load();
  h.setAuthFlowReply(() => `${REDIRECT}?code=auth-code-123`);
  await assert.rejects(() => h.mod.signIn(), /state mismatch/i);
  assert.equal(h.calls.fetch.length, 0);
});

test('each sign-in uses a fresh verifier and a fresh state', async () => {
  const seen = new Set();
  for (let i = 0; i < 3; i++) {
    const h = await load();
    h.queueFetch(ok(TOKENS));
    await h.mod.signIn();
    seen.add(tokenBody(h).get('code_verifier'));
    seen.add(authParams(h).get('state'));
  }
  assert.equal(seen.size, 6, 'verifier and state must never repeat');
});

test('an error in the callback surfaces rather than being swallowed', async () => {
  const h = await load();
  h.setAuthFlowReply(() => `${REDIRECT}?error=access_denied`);
  await assert.rejects(() => h.mod.signIn(), /access_denied/);
  assert.equal(h.calls.fetch.length, 0);
});

test('a cancelled sign-in reports cancellation', async () => {
  const h = await load();
  h.setAuthFlowReply(() => undefined);
  await assert.rejects(() => h.mod.signIn(), /cancelled/i);
});

test('sign-in without a configured client ID explains what to do', async () => {
  const h = await load({ storage: {} });
  await assert.rejects(() => h.mod.signIn(), /client ID/i);
});

test('tokens persist, and expiry is set 60s early to avoid racing the clock', async () => {
  const h = await load();
  h.queueFetch(ok(TOKENS));
  const before = Date.now();
  await h.mod.signIn();

  assert.equal(h.store.accessToken, 'access-1');
  assert.equal(h.store.refreshToken, 'refresh-1');
  const skew = h.store.expiresAt - (before + 3600 * 1000);
  assert.ok(skew <= -59_000 && skew >= -61_000, `expected ~-60s skew, got ${skew}ms`);
});

test('a failed token exchange does not half-persist', async () => {
  const h = await load();
  h.queueFetch(fail(400));
  await assert.rejects(() => h.mod.signIn(), /Token exchange failed/);
  assert.equal(h.store.accessToken, undefined);
  assert.equal(h.store.refreshToken, undefined);
});

// ------------------------------------------------------------ token cycle --

test('a live access token is reused without hitting the network', async () => {
  const h = await load({
    storage: { clientId: CLIENT_ID, accessToken: 'live', expiresAt: Date.now() + 600_000 },
  });
  assert.equal(await h.mod.getToken(), 'live');
  assert.equal(h.calls.fetch.length, 0);
});

test('an expired token is refreshed, and the refresh sends no secret', async () => {
  const h = await load({
    storage: {
      clientId: CLIENT_ID,
      accessToken: 'stale',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() - 1000,
    },
  });
  h.queueFetch(ok({ access_token: 'fresh', expires_in: 3600 }));

  assert.equal(await h.mod.getToken(), 'fresh');
  const body = tokenBody(h);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'refresh-1');
  assert.equal(body.get('client_secret'), null);
});

test('refreshing never clobbers a good refresh token with undefined', async () => {
  // Google only returns refresh_token on first consent.
  const h = await load({
    storage: {
      clientId: CLIENT_ID,
      refreshToken: 'keep-me',
      expiresAt: Date.now() - 1000,
    },
  });
  h.queueFetch(ok({ access_token: 'fresh', expires_in: 3600 }));
  await h.mod.getToken();
  assert.equal(h.store.refreshToken, 'keep-me');
});

test('concurrent callers share ONE refresh, not a thundering herd', async () => {
  // A sync burst issues many requests at once. v1 could fire several refreshes
  // simultaneously, which Google rate-limits.
  const h = await load({
    storage: {
      clientId: CLIENT_ID,
      accessToken: 'stale',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() - 1000,
    },
  });
  h.queueFetch(ok({ access_token: 'fresh', expires_in: 3600 }));

  const results = await Promise.all([
    h.mod.getToken(),
    h.mod.getToken(),
    h.mod.getToken(),
    h.mod.getToken(),
  ]);

  assert.deepEqual(results, ['fresh', 'fresh', 'fresh', 'fresh']);
  assert.equal(h.calls.fetch.length, 1, `expected 1 refresh, got ${h.calls.fetch.length}`);
});

test('a dead refresh token clears storage and asks for a fresh sign-in', async () => {
  const h = await load({
    storage: {
      clientId: CLIENT_ID,
      accessToken: 'stale',
      refreshToken: 'revoked',
      expiresAt: Date.now() - 1000,
    },
  });
  h.queueFetch(fail(400));

  await assert.rejects(() => h.mod.getToken(), /NOT_SIGNED_IN/);
  assert.equal(h.store.refreshToken, undefined, 'must not retry a dead token forever');
  assert.equal(h.store.accessToken, undefined);
});

test('getToken with no refresh token reports NOT_SIGNED_IN', async () => {
  const h = await load();
  await assert.rejects(() => h.mod.getToken(), /NOT_SIGNED_IN/);
});

// ---------------------------------------------------------------- signOut --

test('sign-out revokes the REFRESH token, killing the whole grant', async () => {
  // v1 cleared local storage only, so a user who signed out remained
  // authorised on Google's side indefinitely. Revoking the access token alone
  // would only kill one hour-long credential.
  const h = await load({
    storage: { clientId: CLIENT_ID, accessToken: 'access-1', refreshToken: 'refresh-1' },
  });
  h.queueFetch(ok({}));
  await h.mod.signOut();

  assert.equal(h.calls.fetch.length, 1);
  const url = h.calls.fetch[0].url;
  assert.ok(url.includes('/revoke'), 'must call the revoke endpoint');
  assert.ok(
    url.includes('refresh-1'),
    `must revoke the refresh token, got ${url}`
  );
});

test('sign-out clears every credential and the delta cursor', async () => {
  // historyId must go too: applying one account's deltas to the next account
  // would be silent corruption.
  const h = await load({
    storage: {
      clientId: CLIENT_ID,
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 123,
      historyId: '999',
      theme: 'dark',
    },
  });
  h.queueFetch(ok({}));
  await h.mod.signOut();

  for (const k of ['accessToken', 'refreshToken', 'expiresAt', 'historyId']) {
    assert.equal(h.store[k], undefined, `${k} must be cleared`);
  }
  assert.equal(h.store.clientId, CLIENT_ID, 'the client ID is not a credential');
  assert.equal(h.store.theme, 'dark', 'unrelated settings survive');
});

test('sign-out still clears locally when the network is down', async () => {
  const h = await load({
    storage: { clientId: CLIENT_ID, accessToken: 'a', refreshToken: 'r' },
  });
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  await h.mod.signOut();
  assert.equal(h.store.refreshToken, undefined);
});

test('isSignedIn reflects the presence of a refresh token', async () => {
  const a = await load();
  assert.equal(await a.mod.isSignedIn(), false);
  const b = await load({ storage: { clientId: CLIENT_ID, refreshToken: 'r' } });
  assert.equal(await b.mod.isSignedIn(), true);
});

// ------------------------------------------------- error diagnostics ------

/**
 * These exist because "Token exchange failed (400)." wasted a real debugging
 * session. Google's OAuth errors are terse and their remedies are non-obvious,
 * so the body must be read and translated into an action. A test that only
 * checked "throws on 400" would have passed against the useless version.
 */

const errBody = (error, description) =>
  ({
    ok: false,
    status: 400,
    json: async () => ({ error, error_description: description }),
    text: async () => JSON.stringify({ error }),
  });

test('invalid_client explains the Web-application client-type mistake', async () => {
  // The actual cause of the first real sign-in failure, and the one the setup
  // docs originally caused by saying "Web application".
  const h = await load();
  h.setAuthFlowReply((opts) => {
    const state = new URL(opts.url).searchParams.get('state');
    return `${REDIRECT}?code=c&state=${encodeURIComponent(state)}`;
  });
  h.queueFetch(errBody('invalid_client', 'client_secret is missing.'));

  const err = await h.mod.signIn().then(() => null, (e) => e);
  assert.ok(err, 'must throw');
  assert.match(err.message, /invalid_client/);
  assert.match(err.message, /Chrome Extension/, 'must name the correct client type');
  assert.match(err.message, /FIX:/, 'must tell the user what to do');
});

test('redirect_uri_mismatch names the fix', async () => {
  const h = await load();
  h.queueFetch(errBody('redirect_uri_mismatch'));
  const err = await h.mod.signIn().then(() => null, (e) => e);
  assert.match(err.message, /redirect_uri_mismatch/);
  assert.match(err.message, /FIX:/);
});

test('invalid_grant suggests retrying and checking the clock', async () => {
  const h = await load();
  h.queueFetch(errBody('invalid_grant', 'Bad Request'));
  const err = await h.mod.signIn().then(() => null, (e) => e);
  assert.match(err.message, /again/i);
  assert.match(err.message, /clock/i, 'skew is the non-obvious cause');
});

test('an unrecognised error still surfaces what Google said', async () => {
  const h = await load();
  h.queueFetch(errBody('some_new_error', 'a description'));
  const err = await h.mod.signIn().then(() => null, (e) => e);
  assert.match(err.message, /some_new_error/);
  assert.match(err.message, /a description/);
});

test('a non-JSON failure still reports the status', async () => {
  const h = await load();
  h.queueFetch({
    ok: false,
    status: 502,
    json: async () => { throw new Error('not json'); },
    text: async () => '<html>gateway</html>',
  });
  const err = await h.mod.signIn().then(() => null, (e) => e);
  assert.match(err.message, /502/);
});

test('no failure message is a bare status code', async () => {
  // The regression guard. The old message was exactly this shape, and it is
  // what made the failure undiagnosable.
  for (const code of ['invalid_client', 'redirect_uri_mismatch', 'invalid_grant']) {
    const h = await load();
    h.queueFetch(errBody(code));
    const err = await h.mod.signIn().then(() => null, (e) => e);
    assert.ok(
      err.message.length > 60,
      `"${code}" produced a uselessly short message: ${err.message}`
    );
    assert.ok(!/^Token exchange failed \(\d+\)\.$/.test(err.message));
  }
});
