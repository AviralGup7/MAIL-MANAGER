# Security

## 1. URGENT — a live Google OAuth client secret is in this repository's history

Version 1 hard-coded a Google OAuth **client secret** at `lib/auth.js`, lines 73
and 112:

```js
client_secret: 'GOCSPX-…',
```

That file lived in a **public** repository. The secret is therefore in git
history, is indexed by GitHub's search, and has been scraped by automated
secret-harvesters. Deleting the file does not help — history is what matters.

**Action required: rotate it.**

1. Go to <https://console.cloud.google.com/apis/credentials>
2. Open the OAuth 2.0 Client ID for this project
3. **Reset / delete the client secret**
4. Do not put the new one anywhere. This build does not need one.

While you are there, also revoke any GitHub personal access token that has been
pasted into a chat: <https://github.com/settings/tokens>

### The comment that defended it

v1 carried this note above the secret:

```
// SECURITY NOTE: The Google OAuth client secret is intentionally hardcoded in this file.
// This is NOT a vulnerability. Chrome extensions cannot use server-side secret management.
// The secret is bound to a specific extension ID and is required for OAuth token exchange.
```

The first two sentences are true. The conclusion does not follow.

- "Chrome extensions cannot use server-side secret management" — correct. That
  is precisely why an extension is a **public client** in OAuth terms, and why
  RFC 6749 §2.1 and RFC 8252 §8.4 say a public client **must not** be issued or
  ship a secret.
- "The secret is bound to a specific extension ID" — it is not. A Google *Web
  application* client secret is bound to nothing but the client ID. Anyone
  holding both can mint tokens against your project from anywhere.
- "is required for OAuth token exchange" — required only for a *code exchange*.
  Do not exchange a code and the question does not arise.

The right response to "we cannot keep a secret" is not "ship it anyway"; it is
"use a flow that does not need one."

## 2. What version 2 does instead

**Implicit flow (`response_type=token`), with silent renewal.**

This started as Authorization Code + PKCE, which is the textbook answer for a
public client. **It does not work against Google from an extension**, and the
reason is worth recording because it is the same wall v1 hit:

| Attempt | Result |
|---|---|
| Web application client + PKCE, no secret | `400 invalid_request` — *"client_secret is missing."* PKCE does not exempt you |
| Chrome Extension client (a true public client) | Rejects `chromiumapp.org` redirects; only supports `getAuthToken` |
| `chrome.identity.getAuthToken` | Chrome-only. Does not work in Brave, Edge or Firefox |

Every code-exchange route demands a secret. v1's answer was to hardcode one,
and that is how it ended up published.

So: **do not exchange anything.**

1. Generate a random `state` via `crypto.getRandomValues`.
2. `chrome.identity.launchWebAuthFlow` with `response_type=token`.
3. Google returns the access token in the redirect **fragment**.
4. The `state` is verified before the token is read.
5. There is no token-endpoint call, so no `client_secret` can be demanded.

**The trade, stated plainly.** Tokens last one hour and there is no refresh
token. Renewal is silent: `launchWebAuthFlow({interactive: false})` with
`prompt=none` mints a fresh token with no UI while the Google session cookie
lives. The user consents once.

**This is not a security downgrade.** A one-hour token that cannot be refreshed
is a strictly smaller prize than a refresh token granting `gmail.modify`
indefinitely — which is what the PKCE design would have stored on disk.

The residual weakness is real and worth naming: the token arrives in a URL
fragment rather than a POST response body. In this context the fragment is
handled entirely inside `chrome.identity`'s own flow, is never committed to a
page's history, and never reaches a document that renders mail.

The client **ID** remains in `chrome.storage.local`, user-supplied via Options.
A client ID is not confidential — it is transmitted in plaintext in every
authorization URL by design. The options page refuses any value beginning with
`GOCSPX-`, to stop the v1 mistake being repeated by hand.

## 3. Token handling

- Tokens live **only in the service worker**. The app document — the one that
  renders untrusted HTML from strangers — never holds one.
- The app sends **named verbs** (`SYNC_PAGE`, `STAR`, `SEND`, …) and the worker
  performs the fetch. There is no generic passthrough: an earlier `{type:
  'GMAIL', path}` proxy was deleted precisely because it let the app name any
  endpoint. A successful XSS in the app still cannot read the token, and now
  cannot reach an arbitrary Gmail URL either.
- There is **no refresh token to store** — the implicit flow does not issue
  one. Only a one-hour access token is ever at rest, in `chrome.storage.local`,
  readable only by this extension.
- **Sign out revokes.** The worker calls
  `https://oauth2.googleapis.com/revoke` and then clears storage. v1 cleared
  storage only, leaving a live credential on Google's side.
- **Sign out cannot be undone by work already in flight.** A silent renewal
  running when the user signs out used to call `persist()` afterwards and write
  a fresh, live token back — the gate appeared while a working credential sat
  in storage. Every operation that writes credentials now captures a session
  epoch first and refuses to commit if it moved. The same guard stops a stale
  renewal for a previous account overwriting a new sign-in.
- **Signing out clears every mailbox, not just the visible one.** The stores
  are per-mailbox; clearing only the active one left the previous account's
  Sent and Trash one click away behind the gate. Fetching is also gated on
  `state.signedIn`, so an ended session issues no network requests.

## 4. Rendering hostile mail

Message bodies are the only attacker-controlled content the extension renders.

**Primary defence — capability removal.** The body iframe is declared:

```html
<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer">
```

No `allow-scripts` and no `allow-same-origin`. Script cannot execute, and the
document has an opaque origin, so even if it could it would have no access to
the app, to `chrome.*`, or to storage.

**Secondary — CSP inside the frame:**

```
default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;
```

Remote images are blocked. Tracking pixels are the standard way a sender learns
that you read their mail and that your address is live; this stops them.

**Tertiary — string filtering.** `script`, `iframe`, `object`, `embed`, `link`,
`meta`, `base` and `form` elements are stripped, as are `on*` attributes and
`javascript:` URLs. This is defence in depth, **not** the real protection — a
regex is not an HTML parser and is not treated as one here. v1 relied on
regex filtering as its primary control while also granting the frame more
capability than it needed.

## 5. Permissions

| | v1 | v2 |
|---|---|---|
| `identity` | ✅ | ✅ needed for the OAuth flow |
| `storage` | ✅ | ✅ client ID, access token, historyId, settings, cache |
| `alarms` | ✅ | ✅ snooze wake — the only reliable MV3 timer |
| `scripting` | — | ✅ injects the takeover on demand |
| `unlimitedStorage` | ✅ | ❌ headers only, nowhere near the 5 MB quota |
| `sidePanel` | ✅ | ❌ no side panel |
| `tabs` | ✅ | ❌ the content script knows its own tab |
| `notifications` | ✅ | ❌ not yet — see TODO item 4 |
| `generativelanguage.googleapis.com` host | ✅ | ❌ **no code referenced it** |

Scopes went from six to one:

| Scope | v1 | v2 | Why |
|---|---|---|---|
| `gmail.modify` | ✅ | ✅ read + label changes for triage |
| `gmail.readonly` | ✅ | ❌ subsumed by `modify` |
| `gmail.send` | ✅ | ❌ this build cannot send mail |
| `gmail.labels` | ✅ | ❌ `modify` covers label writes |
| `userinfo.email` | ✅ | ❌ `users.getProfile` already returns it |
| `userinfo.profile` | ✅ | ❌ never displayed |

## 6. Other

- **No remote code.** No CDN, no `eval`, no `new Function`, no
  `chrome.scripting` injection of anything not in the package. Everything the
  extension runs ships with it and is reviewable.
- **Extension-page CSP:** `script-src 'self'; object-src 'none'; connect-src
  'self' https://gmail.googleapis.com https://oauth2.googleapis.com`.
- **Data leaves the device only to Google.** No analytics, no telemetry, no
  third-party endpoint. Classification is local string matching; no message
  content is ever sent anywhere for categorisation. (v1 held a host permission
  for Google's generative-language API. Nothing used it, but the permission
  was granted.)
- **`web_accessible_resources` is scoped to `https://mail.google.com/*`**, so
  arbitrary sites cannot probe for the extension by loading its pages.

## Reporting

Open an issue at <https://github.com/AviralGup7/MAIL-MANAGER/issues>. Do not
include tokens, cookies, or full message bodies.
