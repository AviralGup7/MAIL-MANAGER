/**
 * OAuth. No client secret in this file, or anywhere.
 *
 * ============================================================================
 * WHY THIS USES THE IMPLICIT FLOW AND NOT PKCE
 * ============================================================================
 *
 * This file previously used authorization-code + PKCE, which is the textbook
 * answer for a public client and is what I argued for at length. It cannot
 * work here, and the reason is a Google-specific constraint, not a design
 * mistake in the abstract:
 *
 *   - Google's token endpoint requires `client_secret` for
 *     `grant_type=authorization_code` on a **Web application** client. PKCE
 *     does not exempt you. The response is
 *     `400 invalid_request / "client_secret is missing."`
 *
 *   - The obvious fix -- switch the client to type **Chrome Extension**, which
 *     is a public client -- does not work either. Google's own extensions
 *     DevRel has confirmed that Chrome Extension clients accept only
 *     `getAuthToken`-style flows, and their allowed redirect URIs are "very
 *     strict": a `https://<id>.chromiumapp.org/` redirect is rejected.
 *
 *   - `chrome.identity.getAuthToken` would sidestep all of it, but it is
 *     Chrome-only. It does not work in Brave, Edge or Firefox, and Brave is
 *     what this is actually being used in.
 *
 * So every code-exchange route demands a secret we refuse to ship. This is the
 * same wall v1 hit -- and v1's answer was to hardcode the secret, which is how
 * it ended up leaked in a public repo.
 *
 * The way out is to not exchange anything. `response_type=token` returns the
 * access token directly in the redirect fragment. There is no token endpoint
 * call, so there is nothing to authenticate with a secret.
 *
 * WHAT THIS COSTS, STATED PLAINLY
 *   - Access tokens last one hour.
 *   - There is no refresh token. Implicit flow does not issue them.
 *
 * WHAT MAKES IT ACCEPTABLE
 *   Re-auth is silent. `launchWebAuthFlow({interactive: false})` with
 *   `prompt=none` mints a fresh token without any UI for as long as the user's
 *   Google session cookie is alive, which for a browser people read mail in is
 *   effectively always. The user sees a consent screen once. If the silent
 *   path fails, we fall back to one interactive prompt.
 *
 *   Security-wise this is a fair trade: a one-hour token that cannot be
 *   refreshed is a strictly smaller prize for an attacker than a refresh token
 *   that grants `gmail.modify` indefinitely.
 *
 * ============================================================================
 * SCOPES
 * ============================================================================
 *
 * `gmail.modify` covers read, label, archive, star and delete-to-trash. We do
 * NOT request `gmail.send` or full `https://mail.google.com/` -- this build
 * does not compose, and asking for send access we never use is both a review
 * risk and a straightforward breach of least privilege.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
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

/**
 * Build the authorization URL.
 *
 * `response_type=token` is the whole point: the access token comes back in the
 * redirect fragment and there is no exchange to authenticate.
 *
 * @param {string} clientId
 * @param {string} redirectUri
 * @param {string} state
 * @param {boolean} silent  adds `prompt=none` for background renewal
 */
function authUrl(clientId, redirectUri, state, silent) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'token',
    scope: SCOPES,
    state,
    include_granted_scopes: 'true',
  });
  // prompt=none means "renew if you already can, otherwise fail immediately
  // rather than showing me a window". That is what makes silent renewal
  // possible without ever flashing UI at the user.
  if (silent) params.set('prompt', 'none');
  else params.set('prompt', 'consent');
  return `${AUTH_ENDPOINT}?${params}`;
}

/** Random URL-safe token, used for the `state` parameter. */
function randomState() {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Run one authorization round trip.
 *
 * @param {boolean} interactive  false = silent renewal, no UI ever
 * @returns {Promise<{access_token:string, expires_in:number}>}
 */
async function authorize(interactive) {
  const clientId = await getClientId();
  const redirectUri = chrome.identity.getRedirectURL();
  const state = randomState();

  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl(clientId, redirectUri, state, !interactive),
      interactive,
    });
  } catch (err) {
    // A silent attempt failing is normal and expected -- it just means the
    // Google session needs a real prompt. Only surface interactive failures.
    if (!interactive) throw new Error('SILENT_FAILED');
    throw new Error(friendlyAuthError(err?.message || String(err)));
  }

  if (!responseUrl) {
    throw new Error(interactive ? 'Sign-in was cancelled.' : 'SILENT_FAILED');
  }

  // Implicit flow returns everything in the FRAGMENT, not the query string.
  const url = new URL(responseUrl);
  const frag = new URLSearchParams(url.hash.replace(/^#/, ''));
  const query = url.searchParams;

  const error = frag.get('error') || query.get('error');
  if (error) {
    if (!interactive) throw new Error('SILENT_FAILED');
    throw new Error(friendlyAuthError(error, frag.get('error_description')));
  }

  // Verify state before trusting anything else in the response.
  if (frag.get('state') !== state) {
    throw new Error('OAuth state mismatch — sign-in aborted.');
  }

  const accessToken = frag.get('access_token');
  if (!accessToken) {
    if (!interactive) throw new Error('SILENT_FAILED');
    throw new Error(
      'Google returned no access token.\n\n' +
        'FIX: the OAuth client must be of type "Web application", and its ' +
        'Authorized redirect URIs must include exactly:\n' +
        redirectUri
    );
  }

  return {
    access_token: accessToken,
    expires_in: Number(frag.get('expires_in')) || 3600,
  };
}

/** Interactive sign-in. Persists the token. */
export async function signIn() {
  /*
   * A new sign-in supersedes anything in flight too — including a silent
   * renewal for the PREVIOUS account. Without this, switching accounts could
   * let the old account's renewal overwrite the new account's token, which is
   * worse than the sign-out case: the user ends up reading someone else's
   * mailbox with no indication anything went wrong.
   */
  sessionEpoch++;
  inFlight = null;

  // Captured BEFORE the await, or the comparison below is against a value
  // read after any concurrent change and can never differ.
  const epoch = sessionEpoch;
  const tok = await authorize(true);
  // If a signOut landed while the consent screen was open, do not persist.
  if (epoch !== sessionEpoch) throw new Error('NOT_SIGNED_IN');
  await persist(tok);
  // Remember that consent was granted, so getToken() knows silent renewal is
  // worth attempting. Implicit flow gives us no refresh token to test for.
  await chrome.storage.local.set({ authorized: true });
  return tok;
}

/**
 * Translate Google's terse OAuth errors into something actionable.
 *
 * The previous version reported `Token exchange failed (400).` and discarded
 * the body, which is the only field that distinguishes several unrelated
 * setup mistakes. That cost a full debugging round trip, so every known code
 * now carries its remedy.
 */
function friendlyAuthError(code, description) {
  const HELP = {
    invalid_client:
      'The OAuth client rejected this request.\n\n' +
      'FIX: in Google Cloud Console the client must be type "Web application", ' +
      'and its Authorized redirect URIs must contain the URI shown on the ' +
      'extension options page.',
    invalid_request:
      'Google rejected the shape of the request.\n\n' +
      'FIX: check the client ID is pasted in full, and that the redirect URI ' +
      'on the options page is registered on the client.',
    redirect_uri_mismatch:
      'The redirect URI is not registered on this OAuth client.\n\n' +
      'FIX: copy the URI from the extension options page into the client\'s ' +
      'Authorized redirect URIs. It must match exactly, trailing slash included.',
    access_denied:
      'Consent was refused, or this account is not allowed to use the app.\n\n' +
      'FIX: add your BITS address under OAuth consent screen -> Test users.',
    admin_policy_enforced:
      'Your Google Workspace admin blocks this app.\n\n' +
      'FIX: the BITS domain restricts third-party access to Gmail; an admin ' +
      'must allow-list the client ID.',
    org_internal:
      'This OAuth client is restricted to another organisation.\n\n' +
      'FIX: set the consent screen to External, or use a client from a project ' +
      'in the same organisation as the signing-in account.',
  };
  const help = HELP[code];
  const lead = `Google rejected the sign-in: ${code}${description ? ` (${description})` : ''}`;
  return help ? `${lead}\n\n${help}` : lead;
}

async function persist(tok) {
  await chrome.storage.local.set({
    accessToken: tok.access_token,
    // Renew 5 minutes early. Implicit tokens cannot be refreshed on demand,
    // so a wider margin avoids a request racing the expiry mid-sync.
    expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 - 300_000,
  });
}

/**
 * A valid access token, renewing silently if needed.
 *
 * Concurrent callers share one in-flight renewal. A sync burst issues many
 * requests at once, and firing a dozen simultaneous auth flows would be both
 * slow and rate-limited.
 */
let inFlight = null;

/**
 * Session generation.
 *
 * THIS FIXES A REAL SECURITY DEFECT. `signOut()` cleared storage, but a silent
 * renewal already in flight would call `persist()` AFTERWARDS and write a
 * fresh, live access token back — so signing out during a renewal left the
 * user believing they were signed out while a working credential sat in
 * storage. Reproduced: sign out 10ms into a 60ms renewal, and `accessToken`
 * came back as a valid token.
 *
 * Clearing storage is not enough on its own because it cannot reach work that
 * has already started. The epoch is the missing piece: every operation that
 * WRITES credentials captures it first and refuses to commit if it has moved.
 *
 * A boolean "signing out" flag would not do — sign-out completes, and a
 * renewal that started before it must stay invalid forever after, not just
 * during the sign-out itself.
 */
let sessionEpoch = 0;

export async function getToken() {
  const s = await chrome.storage.local.get(['accessToken', 'expiresAt', 'authorized']);

  if (s.accessToken && s.expiresAt && Date.now() < s.expiresAt) {
    return s.accessToken;
  }
  if (!s.authorized) throw new Error('NOT_SIGNED_IN');

  if (inFlight) return inFlight;
  inFlight = renew().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Mint a fresh token without showing anything.
 *
 * Works while the browser still holds a Google session cookie, which for a
 * browser someone reads mail in is effectively always. When it does fail we
 * clear the flag so the UI prompts rather than retrying forever.
 */
async function renew() {
  const epoch = sessionEpoch;
  try {
    const tok = await authorize(false);
    // The user may have signed out while this was in flight. Persisting now
    // would resurrect the session they just ended.
    if (epoch !== sessionEpoch) throw new Error('NOT_SIGNED_IN');
    await persist(tok);
    return tok.access_token;
  } catch (err) {
    // Do NOT clear storage for a superseded renewal: sign-out has already
    // cleared it, and a sign-IN may since have populated it afresh. Wiping
    // here would sign the user back out immediately after they signed in.
    if (epoch !== sessionEpoch) throw new Error('NOT_SIGNED_IN');
    await chrome.storage.local.remove(['accessToken', 'expiresAt', 'authorized']);
    throw new Error('NOT_SIGNED_IN');
  }
}

export async function signOut() {
  // Invalidate any renewal already in flight BEFORE doing anything else, so
  // it cannot commit a token after this returns. See `sessionEpoch`.
  sessionEpoch++;
  inFlight = null;

  const { accessToken } = await chrome.storage.local.get('accessToken');

  // Revoke server-side, not just locally. The implicit flow issues no refresh
  // token, so the access token IS the whole grant -- revoking it ends access
  // rather than merely forgetting it. v1 cleared storage only, leaving a live
  // credential standing on Google's side.
  if (accessToken) {
    await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(accessToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }).catch(() => {
      /* offline; the local removal below still happens */
    });
  }

  // `authorized` must go, or getToken() would keep attempting silent renewal
  // for an account the user just signed out of. historyId goes too: applying
  // one account's deltas to the next would be silent corruption.
  await chrome.storage.local.remove([
    'accessToken',
    'expiresAt',
    'authorized',
    'historyId',
  ]);
}

/**
 * Has the user granted consent?
 *
 * Keyed on the `authorized` flag rather than on a stored token, because an
 * implicit token expires hourly and its absence means "needs renewal", not
 * "signed out". Conflating the two would show the sign-in gate every hour.
 */
export async function isSignedIn() {
  const { authorized } = await chrome.storage.local.get('authorized');
  return Boolean(authorized);
}
