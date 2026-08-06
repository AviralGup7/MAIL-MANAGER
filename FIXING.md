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

## "Token exchange failed (400)" — the client is the wrong TYPE

Your client ID is fine. The **application type** is wrong, and my setup
instructions caused it: they said to create a **Web application** client.

Google classes a Web application client as a **confidential** client, which
means it demands a `client_secret` on the token exchange — even when PKCE is
used. This build deliberately ships no secret (that is the entire point of the
PKCE rewrite, after v1 leaked one). So Google answers:

```
400 {"error":"invalid_client","error_description":"client_secret is missing."}
```

### Fix — create a Chrome Extension client instead

1. <https://console.cloud.google.com/apis/credentials>
2. **Create credentials → OAuth client ID**
3. Application type: **Chrome Extension** ← not Web application
4. **Item ID**: paste your extension ID

   ```
   dgeanijfllibcphbblkhacjcbdehihcp
   ```
5. Copy the new client ID into the extension's Options and sign in again.

A Chrome Extension client is a **public** client: no secret, PKCE accepted, and
it is matched by extension ID so there is no redirect URI to register at all.
The old Web application client can be deleted.

Also make sure your BITS address is listed under **OAuth consent screen → Test
users**, or consent is refused before the exchange even happens.

### And the reason this was hard to diagnose

The error you saw was the whole message. `Token exchange failed (400).` threw
away Google's response body — the one field that says *which* of three
unrelated setup mistakes occurred. That was my bug, not a Google limitation.

Errors now read the body and translate it into an action, e.g.:

> Google rejected the sign-in: invalid_client (client_secret is missing.)
>
> Your OAuth client is a "Web application" type, which Google treats as a
> confidential client and requires a client secret for — even with PKCE. This
> extension deliberately ships no secret.
>
> FIX: in Google Cloud Console create a NEW OAuth client ID of type
> "Chrome Extension", paste your extension ID into it, and use that client ID
> here instead.

Six tests cover the translation, including one asserting that no failure
message is ever again a bare status code.

## Still to check once it loads

- Does the takeover animate in over Gmail?
- Does sign-in complete? (Options → paste your OAuth client ID first, or click
  **Use v1 client ID**.)
- Does `Esc` hand Gmail back cleanly?
- Does the second account (`/mail/u/1/`) behave?

Tell me what breaks. 235 automated tests pass, and they clearly do not
substitute for one real browser.
