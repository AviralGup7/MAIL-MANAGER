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
- "is required for OAuth token exchange" — only for the confidential-client
  flow. The correct flow here is **Authorization Code with PKCE (RFC 7636)**,
  which exists for exactly this situation and requires no secret at all.

The right response to "we cannot keep a secret" is not "ship it anyway"; it is
"use a flow that does not need one."

## 2. What version 2 does instead

**PKCE, S256.**

1. Generate a 32-byte random `code_verifier` via `crypto.getRandomValues`.
2. `code_challenge = BASE64URL(SHA-256(code_verifier))`.
3. Send the challenge with the authorization request, along with a random
   `state`.
4. `chrome.identity.launchWebAuthFlow` returns the code; the `state` is
   **verified** before the code is used.
5. Exchange code + `code_verifier` for tokens. **No `client_secret` field is
   sent, because there is no secret.**

An attacker who intercepts the authorization code cannot redeem it: they do not
have the verifier, and the challenge is a one-way hash of it.

The client **ID** remains in `chrome.storage.local`, user-supplied via Options.
A client ID is not confidential — it is transmitted in plaintext in every
authorization URL by design. The options page refuses any value beginning with
`GOCSPX-`, to stop the v1 mistake being repeated by hand.

## 3. Token handling

- Tokens live **only in the service worker**. The app document — the one that
  renders untrusted HTML from strangers — never holds one.
- The app sends `{type:'GMAIL', …}` messages and the worker performs the fetch.
  A successful XSS in the app therefore still cannot read the token.
- The refresh token is in `chrome.storage.local`, which is readable only by
  this extension.
- **Sign out revokes.** The worker calls
  `https://oauth2.googleapis.com/revoke` and then clears storage. v1 cleared
  storage only, leaving a live refresh token on Google's side.

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
| `storage` | ✅ | ✅ client ID, refresh token, historyId, theme |
| `alarms` | ✅ | ✅ |
| `unlimitedStorage` | ✅ | ❌ headers only, nowhere near the 5 MB quota |
| `sidePanel` | ✅ | ❌ no side panel |
| `tabs` | ✅ | ❌ the content script knows its own tab |
| `notifications` | ✅ | ❌ never used |
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
