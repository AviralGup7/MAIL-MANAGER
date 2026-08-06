# It didn't work — here's what was wrong and how to reload

You hit three real bugs on the first run in a real browser. All three were
mine, and all three came from the same mistake: a "permission minimisation"
pass that removed permissions the code actually calls.

---

## Reload it properly — a permission change needs more than a refresh

Adding a host permission does **not** take effect on a normal extension
reload. Chrome must re-read the manifest and re-grant.

1. `git pull` (or re-download the folder).
2. Go to `brave://extensions` (or `chrome://extensions`).
3. Find **BITS Mail Manager** → click **Remove**.
4. Click **Load unpacked** → select the `mail-manager` folder again.
   - Removing and re-adding is the reliable path. "Reload" often keeps the old
     permission set.
5. **Close every open Gmail tab, then open a fresh one.** A content script only
   exists in tabs loaded *after* the extension was installed. (The new build
   injects it on demand as a fallback, but a fresh tab is cleaner.)
6. Click the toolbar icon, or press **`Alt+Shift+M`** — the shortcut changed,
   see below.

### Check it registered

Open `brave://extensions` → BITS Mail Manager → **service worker** (blue link).
On install the worker now prints one of:

```
[BMM] ready. Shortcut: Alt+Shift+M
```

or a list of problems. If you see problems, paste them to me — that log exists
specifically because all three of these bugs were silent.

---

## What was broken

### 1. Every click opened a new Gmail tab, on the wrong account

`tab.url` is only readable when the extension holds either the broad `tabs`
permission or a host permission **for that specific tab**. I had removed `tabs`
and never added `mail.google.com` — `host_permissions` only listed the API
endpoints.

So `tab.url` was `undefined`, the "are we on Gmail?" check failed, and the code
took its *not on Gmail* branch:

```js
await chrome.tabs.create({ url: 'https://mail.google.com/' });   // every click
```

That URL has no `/u/N`, so Chrome resolved it to your **default** account —
which is why a different account kept appearing.

**Fixed:** added `https://mail.google.com/*` to `host_permissions`. That is
narrower than `tabs`, which would have exposed the URL of *every* tab you have
open. The extension now focuses an existing Gmail tab rather than spawning
another, and only creates one if none exists.

### 2. `Ctrl+Shift+M` opened Brave's profile switcher

That combination is reserved by Chrome and Brave for the profile menu. A
`suggested_key` that collides with a browser shortcut is simply never delivered
to the extension — so ours did nothing while the browser did its own thing.

**Fixed:** the shortcut is now **`Alt+Shift+M`**.

You can change it yourself at `brave://extensions/shortcuts`.

### 3. The button did nothing even on Gmail tabs

The fallback that injects the content script into an already-open tab calls
`chrome.scripting.executeScript` — but `scripting` was not in `permissions`, so
`chrome.scripting` was `undefined`. The resulting error went into a bare
`.catch(() => {})` and looked exactly like success.

**Fixed:** added the permission, made the fallback inject the CSS too, and
replaced the silent catch with a console error plus a red `!` badge on the
toolbar icon.

### 4. Found while fixing the others: "Open in Gmail" always went to account 0

Same wrong-account family. The link hardcoded `/mail/u/0/`. The app runs on an
extension origin and cannot read the parent page's URL, so the content script
now parses the `u/N` segment out of the Gmail URL and passes it to the app.

---

## Why the tests said everything was fine

This is the part worth being annoyed about. `test/package.test.mjs` contained:

```js
assert.ok(!manifest.permissions.includes('tabs'));
```

…as a "permission creep" guard, while `src/background/index.js` called
`chrome.tabs.*` on every single click. **The test enforced the bug.** It went
green while the extension could not function at all.

Minimisation is only a virtue when the removed permission is genuinely unused.
I checked the manifest against a hardcoded list instead of checking it against
the code.

Replaced with four tests that check the relationship that actually matters:

| Test | Catches |
|---|---|
| every `chrome.*` API used is permitted | bug 3 |
| every permission granted is used | real creep, the original goal |
| host permissions cover what the code reads | bug 1 |
| no shortcut collides with a browser-reserved key | bug 2 |

Each was verified by re-introducing the original fault and confirming the suite
goes red.

---

## Also fixed: the extension ID was changing on every load

`manifest.json` was missing the `"key"` field. Chrome derives the extension ID
by hashing the public key, and with no `"key"` it generates a **new keypair on
every unpacked load** — so the ID changed each time, and with it the OAuth
redirect URI:

```
https://<extension-id>.chromiumapp.org/
```

Google rejects any redirect URI that is not registered, so sign-in would have
failed with `redirect_uri_mismatch` no matter which client ID you entered, and
re-registering would have lasted exactly until the next reload.

v1 carried this key; the rewrite dropped it. Restored, verified as a valid
2048-bit RSA **public** key (safe to commit — a private key would let anyone
sign an update Chrome accepts as this extension), and pinned by a test:

```
Extension ID : dgeanijfllibcphbblkhacjcbdehihcp
Redirect URI : https://dgeanijfllibcphbblkhacjcbdehihcp.chromiumapp.org/
```

**Register that exact redirect URI** in your Google Cloud OAuth client. The
Options page now shows both the URI and the live extension ID, and turns the ID
red if it is not the expected one.

## Sign-in: I sent you down a dead end, twice. Here is the settled answer.

**Do this:**

1. <https://console.cloud.google.com/apis/credentials>
2. **Create credentials → OAuth client ID → Web application**
   (yes, "Web application", even for an extension — see below)
3. **Authorized redirect URIs** → add exactly, trailing slash included:

   ```
   https://dgeanijfllibcphbblkhacjcbdehihcp.chromiumapp.org/
   ```
4. **OAuth consent screen → Test users** → add your BITS address
5. Paste the client ID into the extension's Options. Ignore the client secret.
6. `git pull`, reload the extension, sign in.

### What I got wrong

I told you to switch the client to type **Chrome Extension**. That was wrong,
and it is why you then got `invalid_request`. Google's own extensions DevRel
has confirmed that Chrome Extension clients only support `getAuthToken`-style
flows and reject `chromiumapp.org` redirects.

Before that I told you to use **Web application** with PKCE. Also wrong:
Google's token endpoint requires `client_secret` for
`grant_type=authorization_code` on that client type, and **PKCE does not exempt
you**.

My error message made it worse. It matched on the error *code* and ignored the
*description*, so `invalid_request` + *"client_secret is missing."* printed
advice about trailing spaces in the client ID. The description was the entire
signal and the code threw it away.

### The real constraint

| Route | Result |
|---|---|
| Web application + PKCE, no secret | `400` — *"client_secret is missing."* |
| Chrome Extension client | Rejects `chromiumapp.org` redirects |
| `chrome.identity.getAuthToken` | Chrome-only — dead in Brave |

Every code-exchange route demands a secret. **This is the same wall v1 hit**,
and v1's answer was to hardcode the secret — which is how it ended up published
in a public repository. I spent this entire rewrite criticising that decision
without first establishing that the alternative actually works.

### What now ships

`response_type=token` — the implicit flow. The token comes back in the redirect
fragment, there is no token-endpoint call, so no secret can be demanded.

**The trade:** tokens last one hour and there is no refresh token. Renewal is
silent — `prompt=none` with `interactive: false` mints a new token with no UI
while your Google session is alive. You consent once and should never see a
popup again.

**Not a security downgrade.** A one-hour token that cannot be refreshed is a
smaller prize than a refresh token granting `gmail.modify` indefinitely, which
is what the PKCE design would have written to disk.

## Signed in but still looking at the sign-in screen

Auth was fine — the popup completed, the token was stored, the code correctly
decided you were signed in and called `hideGate()`. The gate just refused to go
away.

`hidden` is not special. The browser implements it as a plain stylesheet rule:

```css
[hidden] { display: none }
```

…at the **lowest** author-overridable precedence. So this, in our own CSS:

```css
#gate { position: fixed; inset: 0; display: grid; }
```

beat it outright. `el.gate.hidden = true` set the attribute and changed nothing
you could see.

Three elements had the same flaw:

| Element | Rule | Symptom |
|---|---|---|
| `#gate` | `display: grid` | sign-in screen never dismissed |
| `#reader` | `display: flex` | reading pane would not close on `Esc` |
| `#r-loading` | `display: grid` | stale "Loading…" over a rendered message |

Fixed with `[hidden] { display: none !important }`.

### Why 241 tests didn't catch it

Every test asserted the **property** — `assert.equal(gate.hidden, true)` —
which was always correct. Not one asked whether the element was actually
*painted*. The new test sets `hidden` on every element the app toggles and
asserts computed `display` is `none`.

That is the difference between testing what the code did and testing what the
user sees, and it is the third bug in this run that only a real browser found.

## Gmail's console is noisy — most of it is not us

Opening DevTools on Gmail shows a wall of errors on every load. These are
Google's own and appear with the extension disabled:

| Message | Whose |
|---|---|
| `Deprecated API for given entry type` | Google's perf bundle (`xUg.activate`, `Ai`) |
| `Unrecognized feature: 'attribution-reporting'` / `'speaker'` | Google's iframe `allow=` attributes |
| `_frameReady` cross-origin SecurityError | Google Chat talking to Gmail |
| `manifest.json: 'migrate_from' ignored` | A **different** extension — ours has no `migrate_from` |
| `frame-ancestors` / `worker-src` CSP violations | Meet and OGS, both **report-only** |

**To see only our messages, type `BMM` in the DevTools filter box.**

And note the service worker logs to a **separate console**:
`chrome://extensions` → the blue **"service worker"** link. That is where
`[BMM] ready. Shortcut: Alt+Shift+M` appears — or `[BMM] startup problems:`
with the reason. If neither shows, the worker did not start.

## Still to check once it loads

- Does the takeover animate in over Gmail?
- Does sign-in complete? (Options → paste your OAuth client ID first.)
- Press **`?`** — does the shortcut overlay list all 23?
- Does `Esc` hand Gmail back cleanly, with Gmail fully interactive again?
- Do **read** messages appear, not just unread? The rail should read
  `unread/total`, e.g. `3/41`.
- Does compose send, and does a draft survive closing the panel?
- Does the second account (`/mail/u/1/`) behave?

Tell me what breaks. 633 automated tests pass, and they still do not
substitute for one real browser.
