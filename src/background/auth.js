/**
 * OAuth via PKCE. There is no client secret in this file, or anywhere.
 *
 * ============================================================================
 * WHY THE PREVIOUS VERSION WAS WRONG ABOUT THIS
 * ============================================================================
 *
 * The old `lib/auth.js` hardcoded a Google OAuth client secret and carried a
 * comment arguing it was safe because "Chrome extensions cannot use
 * server-side secret management".
 *
 * The premise is true; the conclusion is backwards. A browser extension is
 * shipped to users as a readable bundle — anyone can unzip a .crx. OAuth calls
 * this a PUBLIC CLIENT, and the answer for public clients is not "ship the
 * secret anyway", it is "use a flow that does not need one". That flow is
 * PKCE (RFC 7636), and it has been the required approach for installed apps
 * since Google deprecated the OOB flow.
 *
 * PKCE replaces the secret with a per-request proof:
 *   1. generate a random `code_verifier`
 *   2. send `code_challenge = BASE64URL(SHA256(verifier))` with the auth request
 *   3. send the raw `verifier` with the token exchange
 * An attacker who intercepts the authorization code cannot use it, because
 * they do not have the verifier. Nothing long-lived needs to be embedded.
 *
 * ============================================================================
 * SCOPES
 * ============================================================================
 *
 * `gmail.modify` covers read, label, archive, star and delete-to-trash. We do
 * NOT request `gmail.send` or full `https://mail.google.com/` — v1 does not
 * compose, and asking for send access we do not use is both a review risk and
 * a straightforward breach of least privilege.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
].join(' ');

/**
 * Set by the user in Options.
 *
 * NOT hardcoded. Every install can use its own Google Cloud project, which
 * means no shared credential to leak and no single client ID whose revocation
 * breaks everybody.
 */
async function getClientId() {
  const { clientId } = await chrome.storage.local.get('clientId');
  if (!clientId) {
    throw new Error(
      'No OAuth client ID configured. Open the extension options and paste ' +
        'the client ID from your Google Cloud project.'
    );
  }
  return clientId;
}

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomVerifier() {
  // 32 bytes -> 43 chars base64url, the RFC 7636 recommended length.
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64url(bytes);
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier)
  );
  return base64url(new Uint8Array(digest));
}

/** Interactive sign-in. Returns the token bundle and persists it. */
export async function signIn() {
  const clientId = await getClientId();
  const redirectUri = chrome.identity.getRedirectURL();
  const verifier = randomVerifier();
  const challenge = await challengeFor(verifier);

  // `state` guards against a forged callback being fed back to us.
  const stateToken = base64url(crypto.getRandomValues(new Uint8Array(16)));

  const url =
    `${AUTH_ENDPOINT}?` +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: stateToken,
      access_type: 'offline',
      // Without this, a returning user gets no refresh token and is thrown
      // back to the sign-in screen every hour.
      prompt: 'consent',
    });

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url,
    interactive: true,
  });
  if (!responseUrl) throw new Error('Sign-in was cancelled.');

  const params = new URL(responseUrl).searchParams;
  if (params.get('error')) throw new Error(`Google said: ${params.get('error')}`);
  if (params.get('state') !== stateToken) {
    throw new Error('OAuth state mismatch — sign-in aborted.');
  }
  const code = params.get('code');
  if (!code) throw new Error('No authorization code returned.');

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: verifier, // <- replaces the client secret
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}).`);
  }
  const tok = await res.json();
  await persist(tok);
  return tok;
}

async function persist(tok) {
  const record = {
    accessToken: tok.access_token,
    // Refresh 60s early so a request never races the expiry.
    expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 - 60_000,
  };
  // Google only returns a refresh token on first consent; never overwrite a
  // good one with undefined.
  if (tok.refresh_token) record.refreshToken = tok.refresh_token;
  await chrome.storage.local.set(record);
}

/**
 * A valid access token, refreshing if needed.
 *
 * Concurrent callers share one in-flight refresh. The old version could fire
 * several refreshes at once during a sync burst, and Google rate-limits that.
 */
let inFlight = null;

export async function getToken() {
  const s = await chrome.storage.local.get([
    'accessToken',
    'refreshToken',
    'expiresAt',
  ]);

  if (s.accessToken && s.expiresAt && Date.now() < s.expiresAt) {
    return s.accessToken;
  }
  if (!s.refreshToken) throw new Error('NOT_SIGNED_IN');

  if (inFlight) return inFlight;
  inFlight = refresh(s.refreshToken).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function refresh(refreshToken) {
  const clientId = await getClientId();
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    // A 400 here means the refresh token is dead (revoked, or consent
    // withdrawn). Clear it so the UI can prompt a fresh sign-in instead of
    // retrying forever — the old version's keepalive treated a transient 401
    // as fatal and vice versa.
    if (res.status === 400) {
      await chrome.storage.local.remove(['refreshToken', 'accessToken', 'expiresAt']);
      throw new Error('NOT_SIGNED_IN');
    }
    throw new Error(`Token refresh failed (${res.status}).`);
  }

  const tok = await res.json();
  await persist(tok);
  return tok.access_token;
}

export async function signOut() {
  const { accessToken } = await chrome.storage.local.get('accessToken');
  if (accessToken) {
    // Best effort: tell Google to drop it too, not just forget it locally.
    await fetch(`${REVOKE_ENDPOINT}?token=${accessToken}`, {
      method: 'POST',
    }).catch(() => {});
  }
  await chrome.storage.local.remove([
    'accessToken',
    'refreshToken',
    'expiresAt',
  ]);
}

export async function isSignedIn() {
  const { refreshToken } = await chrome.storage.local.get('refreshToken');
  return Boolean(refreshToken);
}
