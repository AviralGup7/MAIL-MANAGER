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
    throw await tokenError(res);
  }
  const tok = await res.json();
  await persist(tok);
  return tok;
}

/**
 * Turn a failed token response into an error that says what to DO.
 *
 * This used to be `Token exchange failed (400).` and nothing else, which threw
 * away the response body -- the one field that distinguishes three completely
 * different setup mistakes. A user seeing that had no way forward.
 *
 * Google's OAuth errors are terse and their remedies are non-obvious, so each
 * known code is translated into the actual fix.
 */
async function tokenError(res) {
  let body = {};
  try {
    body = await res.json();
  } catch {
    /* not JSON; fall through to the generic message */
  }
  const code = body.error || '';
  const detail = body.error_description || '';

  const HELP = {
    invalid_client:
      'Your OAuth client is a "Web application" type, which Google treats as a ' +
      'confidential client and requires a client secret for — even with PKCE. ' +
      'This extension deliberately ships no secret.\n\n' +
      'FIX: in Google Cloud Console create a NEW OAuth client ID of type ' +
      '"Chrome Extension", paste your extension ID into it, and use that ' +
      'client ID here instead.',
    redirect_uri_mismatch:
      'The redirect URI is not registered on this OAuth client.\n\n' +
      'FIX: either register the exact URI shown on this options page, or ' +
      '(better) switch to a "Chrome Extension" type client, which is matched ' +
      'by extension ID and needs no redirect URI at all.',
    invalid_grant:
      'The authorization code was already used or has expired.\n\n' +
      'FIX: just try signing in again. If it keeps happening, check that your ' +
      'system clock is correct — a skewed clock invalidates codes immediately.',
    invalid_request:
      'Google rejected the shape of the request.\n\n' +
      'FIX: confirm the client ID was pasted in full, with no trailing spaces.',
    unauthorized_client:
      'This client is not allowed to use the authorization-code flow.\n\n' +
      'FIX: create a "Chrome Extension" type OAuth client and use its ID.',
    access_denied:
      'Consent was refused, or your account is not on the test-user list.\n\n' +
      'FIX: add your BITS address under OAuth consent screen -> Test users.',
  };

  const help = HELP[code];
  const lead = code
    ? `Google rejected the sign-in: ${code}${detail ? ` (${detail})` : ''}`
    : `Token exchange failed with HTTP ${res.status}.`;

  return new Error(help ? `${lead}\n\n${help}` : lead);
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
  const { accessToken, refreshToken } = await chrome.storage.local.get([
    'accessToken',
    'refreshToken',
  ]);

  // Revoke the REFRESH token by preference. Revoking an access token kills one
  // hour-long credential; revoking the refresh token kills the entire grant,
  // which is what "sign out" has to mean. The old version cleared local
  // storage only, so a live refresh token was left standing on Google's side
  // forever — a user who signed out was still authorised.
  const token = refreshToken || accessToken;
  if (token) {
    await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }).catch(() => {
      /* offline; local removal below still happens */
    });
  }

  // historyId goes too. Keeping a delta cursor across accounts would apply the
  // previous account's deltas to the next one.
  await chrome.storage.local.remove([
    'accessToken',
    'refreshToken',
    'expiresAt',
    'historyId',
  ]);
}

export async function isSignedIn() {
  const { refreshToken } = await chrome.storage.local.get('refreshToken');
  return Boolean(refreshToken);
}
