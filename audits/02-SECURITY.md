# Audit 2 — Security

Scope: the trust boundaries. Untrusted mail HTML, the OAuth flow, the
extension↔page bridge, and stored credentials.
Method: adversarial reading plus executed proof-of-concept where a claim was
testable.

`SECURITY.md` states the design intent. This audit tests whether the code
matches it. **Verdict: the architecture is sound; 3 gaps, none currently
exploitable, one of which becomes critical if a single attribute is ever
changed.**

---

## S-1 — HIGH (latent) — the entire XSS defence rests on one attribute, and the fallback behind it does not work

`app.html:107`

```html
<iframe id="r-body" sandbox="allow-popups allow-popups-to-escape-sandbox" ...>
```

This is correct and is the real control: no `allow-scripts`, no
`allow-same-origin`, so mail HTML is inert and origin-less. `test/package.test.mjs`
guards it. Good.

The problem is the *stated* defence in depth behind it. `app.js:415` describes
the string filtering as "defence in depth", which implies it would hold if the
sandbox were weakened. It would not. Executed against the actual regex chain:

| Payload | Result | Survives? |
|---|---|---|
| `<scr<script>ipt>alert(1)</script>` | `<scr` | neutralised |
| `<a href="JaVaScRiPt:alert(1)">` | `href="blocked:..."` | neutralised |
| `<img\nsrc=x\nonerror=alert(1)>` | `<img\nsrc=x>` | neutralised |
| **`<svg/onload=alert(1)>`** | **`<svg/onload=alert(1)>`** | **SURVIVES** |

The `on*` stripper is `/\son\w+\s*=/` — it requires whitespace before the
handler. `<svg/onload=` uses a solidus as the attribute separator, which is
valid HTML5 and is the oldest filter-bypass in the catalogue.

Not exploitable today: no `allow-scripts` means the handler never fires. But
the comment invites a future maintainer to believe there are two layers when
there is one and a half. The realistic path to a breach is someone adding
`allow-scripts` to make a newsletter's collapsible sections work.

**Fix:** two options, and the choice should be explicit.
1. Keep regex filtering but stop calling it a layer — relabel it "cosmetic
   cleanup, not a security control", and add a test asserting the sandbox
   attribute is the control.
2. Or do it properly: parse with `DOMParser` into an inert document, walk the
   tree, allow-list elements and attributes, re-serialise. ~60 lines, no
   dependency, and actually holds.

Either way, add `<svg/onload=>` and `<math>`-based payloads to the test corpus.

---

## S-2 — MODERATE — asymmetric `postMessage` origin validation

The content script validates the sender on both of its listeners:

```js
// content.js:138
if (e.source === frame?.contentWindow && e.data?.type === 'BMM_READY')
// content.js:258
if (e.source !== frame?.contentWindow) return;
```

The app does not:

```js
// app.js:810
window.addEventListener('message', (e) => {
  if (e.data?.type === 'BMM_SHOWN') el.scroller.focus({ preventScroll: true });
});
```

No `e.source` check, no `e.origin` check. Any frame that can obtain a handle to
the app window can post `{type:'BMM_SHOWN'}` and steal focus into the message
list. Impact is genuinely low — it moves focus, nothing more — but the
inconsistency is the finding: two of three listeners are hardened and the third
was missed, which means the pattern is not enforced anywhere.

Also note both `postMessage` calls target `'*'`:

```js
parent.postMessage({ type: 'BMM_RELEASE' }, '*');
parent.postMessage({ type: 'BMM_READY' }, '*');
```

Neither message carries data, so there is nothing to leak, but `'*'` means any
page that manages to frame the app receives them.

**Fix:** check `e.source === parent` in the app listener. Replace `'*'` with the
Gmail origin, which the app can be told at construction time via the frame URL.
Add a test that a message from an unexpected source is ignored.

---

## S-3 — MODERATE — refresh token at rest in `chrome.storage.local`

`auth.js:151` persists the refresh token in plaintext in
`chrome.storage.local`. This is standard practice for extensions and is
protected by the browser's per-extension isolation, so it is not a defect as
such. But it is the highest-value secret the extension holds — it grants
`gmail.modify` indefinitely — and it is worth stating the residual risk
explicitly rather than leaving it implicit:

- Any code running in the extension's own context can read it. Today that is
  only first-party code with no remote loading, so the exposure is bounded by
  the supply chain.
- It survives browser restart by design, and `signOut()` now correctly revokes
  it server-side (fixed earlier — v1 only cleared it locally, leaving a live
  grant on Google's side forever).
- A local attacker with filesystem access to the Chrome profile can read
  LevelDB directly. Nothing an extension can do prevents that.

**Fix:** no code change required. Document the threat model in `SECURITY.md`:
state that a compromised extension context or a compromised OS profile means a
compromised mailbox, and that the mitigation is scope minimisation
(`gmail.modify` only) plus revocation on sign-out — both already done.

---

## Verified correct

Tested, sound, no action.

| Control | Evidence |
|---|---|
| PKCE S256, no client secret | `auth.js` — verifier is 32 bytes from `crypto.getRandomValues`, challenge is SHA-256, no `client_secret` field is ever sent |
| OAuth `state` validation | `auth.js:116` compares and throws on mismatch — blocks a forged callback |
| Refresh-token revocation on sign-out | Revokes the *refresh* token, killing the whole grant, not just one hour-long access token |
| Token never enters the mail-rendering document | App messages the worker; worker holds the token. A total XSS in the app still cannot read it |
| Body-frame CSP | `default-src 'none'; img-src data:` — remote images blocked, so opening mail does not confirm the address to a spammer |
| Extension-page CSP | `script-src 'self'`, `object-src 'none'`, `connect-src` limited to two Google origins |
| No remote code | No `eval`, no `new Function` in `src/`, no CDN, no dynamic import of remote URLs |
| `web_accessible_resources` scoping | Restricted to `https://mail.google.com/*` — arbitrary sites cannot probe for the extension |
| Phishing-domain rejection | `detectBitsSource` does a real subdomain check; `bits-pilani.ac.in.evil.com` is rejected |
| External→internal rule leak | Fixed: an outside sender can no longer match an internal BITS category (was a phishing shape in the highest-trust category) |
| Address map prototype safety | Uses `Map`, not an object literal, so `__proto__` as an address cannot poison lookup. Tested |
| Secret-in-source guard | `package.test.mjs` fails the build if `GOCSPX-` or a `client_secret` assignment appears anywhere |

---

## Outstanding, not code

- 🔴 **The v1 OAuth client secret is still in public git history and still
  unrotated.** Nothing in this repo can fix that.
  → <https://console.cloud.google.com/apis/credentials>
- 🔴 **The GitHub PAT used to push this repo is still live.**
  → <https://github.com/settings/tokens>
