# The manifest `key`, and why it is currently removed

## What happened

`manifest.json` carried a fixed `"key"` field from commit `1f9600c` until the
key was removed to unblock loading.

The key is the extension's public key. Chrome hashes it to derive the
extension ID, so a fixed key means a fixed ID — `dgeanijfllibcphbblkhacjcbdehihcp`
— which in turn means a fixed OAuth redirect URI:

```
https://dgeanijfllibcphbblkhacjcbdehihcp.chromiumapp.org/
```

That stability is genuinely useful. Without it Chrome mints a new keypair on
every unpacked load, the ID changes, and Google rejects sign-in with
`redirect_uri_mismatch` until you re-register the new URI.

## Why it was removed anyway

**A pinned ID is refused if anything else in the profile already claims it.**
A previous install, a leftover registration, or a second copy of the folder is
enough. Chrome reports that refusal as:

```
Service worker registration failed. Status code: 2
```

which names nothing, and which is exactly the error seen here — on a build that
had loaded successfully *before* the key was added.

That made the key the prime suspect on evidence rather than on theory:

```
39cc52a  last commit confirmed working in a real browser
1f9600c  key added — never verified in a browser
```

## The tradeoff, stated plainly

| | Without the key | With a colliding key |
|---|---|---|
| Cost | Re-register the redirect URI after a reload | **The extension does not load at all** |
| Scope | OAuth setup only | Every feature, gone |
| Recoverable | Yes, in about a minute | Not without finding the collision |

The costs are wildly asymmetric, so the key goes.

## Nothing in the code depends on it

Verified rather than assumed:

- `src/background/auth.js` calls `chrome.identity.getRedirectURL()` at runtime.
  It reads whatever ID Chrome assigned; it never hardcodes one.
- `src/options/options.js` compares `chrome.runtime.id` against the expected
  value and *colours the text red with an explanatory tooltip* if they differ.
  It does not throw, and nothing else branches on it.

So removing the key changes exactly one thing the user can see: the options
page flags the ID as unexpected, and the redirect URI shown there is the one
you must register.

## How to put it back

The key is preserved verbatim in `tools/manifest-key.txt`. Once the extension
loads reliably, restore it as the first field after `manifest_version`:

```json
{
  "manifest_version": 3,
  "key": "<paste the contents of tools/manifest-key.txt>",
  ...
}
```

Then re-register the redirect URI above with your Google OAuth client.

**Before restoring it**, remove any other copy of this extension from the
profile — that is what makes the ID collide in the first place. `chrome://extensions`
with Developer mode on shows every unpacked extension and its ID; look for
another entry claiming `dgeanijfllibcphbblkhacjcbdehihcp`.

## The test

`test/package.test.mjs` no longer *requires* the key. It now says: if a key is
present it must be a real RSA public key deriving the documented ID. A
malformed one is a silent load failure, so that half still matters. Verified by
altering a single character — the test fails with "the extension ID changed".
