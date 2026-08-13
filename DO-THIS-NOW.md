# Two things only you can do

I could not do either of these for you. The first takes about three minutes
and is the oldest open item in the project; the second is the one that decides
whether any of the 890 tests mean anything.

---

## 1 · Revoke the leaked credentials — 3 minutes

Three secrets were pasted into plain chat or committed to public history. They
are **still live right now**. Anyone who has seen them can push to your repo or
use your Google client.

### a. Two GitHub personal access tokens

Two tokens, both beginning `ghp_`: one starting `VUbK78…` (older) and one
starting `0zyV Lu…` (the one that was used for pushes). Both appear in full in
our chat history — I am deliberately **not** repeating them here, because this
file is committed to the repo and writing them down again would be a third
leak. The tokens page below lists them; revoke every token you do not
recognise.

1. Go to <https://github.com/settings/tokens>
2. Delete **both**. Do not edit their scopes — delete them.
3. Generate a new one if you want to keep pushing from here. Give it
   `repo` scope only.

**What I already did:** the token is no longer stored in `.git/config`. The
remote is a plain `https://` URL now, so nothing on disk contains a
credential. Pushing will ask for a username and password — use your GitHub
username and the **new** token as the password.

If you want git to remember it without writing it in the clear:

```bash
git config --global credential.helper store   # or 'osxkeychain' on macOS
```

### b. The Google OAuth client secret

The one beginning `GOCSPX-` (full value is in the chat history and in v1's
git log — again, not repeated here).

This is in v1's **public git history**, so it cannot be un-leaked by editing a
file. It must be rotated at the source.

1. Go to <https://console.cloud.google.com/apis/credentials>
2. Find the OAuth 2.0 Client ID this project uses.
3. **Reset secret** (or delete the client and make a new one).

The good news: **v2 does not use a client secret at all.** It uses the implicit
flow, and there is a test that fails the build if `GOCSPX-` ever appears in the
source. So rotating this breaks nothing here — it only closes the old hole.

---

## 2 · The service worker — RESOLVED

**Restarting the browser fixed it.**

That is the whole answer, and it matches what the sources said all along.
`Status code: 2` is `kErrorAbort`, which a Google engineer on the Chromium
tracker calls *"a general grab bag of 'something bad happened'"*. The
StackOverflow answer for this exact error recommends a browser or profile
restart. [crbug 394523691](https://issues.chromium.org/issues/394523691)
describes the mechanism: a registration interrupted by another extension
loading, leaving a state no file change can repair.

### What that means for the code

Nothing was ever wrong with it. Across the investigation the worker was moved
to the extension root, rewritten as a dynamic-import loader, flattened into a
classic bundle, and given a fresh extension ID. **None of it helped, because
none of it was the problem.** All of that scaffolding has been removed and the
worker is back to a module in `src/background/index.js`.

### If it ever returns

In order, cheapest first:

1. **Restart the browser.** This is what worked.
2. Remove the extension and **Load unpacked** again.
3. `chrome://serviceworker-internals` → find the extension → **Unregister**,
   then reload it.
4. Disable ad blockers and privacy extensions temporarily. Those hold
   `webRequest`, which is what triggers crbug 394523691.
5. Check `chrome://version` is **137+**, where that bug is fixed.

### And the app keeps working regardless

These were built during the investigation and are **deliberately kept**:

| Safety net | What it does |
|---|---|
| `src/app/system/fallback.js` | If the worker does not answer, the app runs the Gmail layer **in the page**. All 11 verbs — read, search, archive, send, drafts. |
| Amber banner | Says so once, names what is lost, dismissable. |
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> in the content script | Opens the takeover with no worker involved. |
| `chrome.action?.` / `chrome.commands?.` | A missing manifest key costs one feature, not the whole worker. |

Only **snooze wake-on-timer** genuinely needs the worker.

---

## 3 · Then actually use it — 10 minutes

### Load it

890 tests pass in jsdom. jsdom has **no layout engine, no real Gmail, and no
service worker**. Three classes of problem are invisible to it, and I have hit
two of them already this project — a menu whose colour swatches had silently
collapsed to zero width, with every test green.

### Load it

1. `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select the repository root
4. Open Gmail. Press **Alt+Shift+M**.

Once the worker registers you should see, in its console:

```
[BMM] ready. Shortcut: Alt+Shift+M
```

### Then, roughly in order of what is most likely to be wrong

| Check | Why it matters |
|---|---|
| Does the sign-in gate appear, and does Google accept the redirect? | The auth flow has never run. Implicit flow + extension redirect URI is the least-tested path in the project. |
| Does any mail actually appear? | Everything downstream is theoretical until it does. |
| Are the categories sensible on **your real mail**? | The classifier is validated against a synthetic data pack. There is no real BITS corpus. This is the single biggest unknown. |
| Scroll a full inbox. Does it stay smooth? | The 60fps claim is an expectation, not a measurement. |
| Open a message with a deadline. Does the new strip look right? | Rendered it offline; never seen in a browser. |
| Change a setting in Options, return to the tab. | Just fixed. Verified in jsdom only. |

Anything that looks wrong — a screenshot or the console text is enough for me
to work from.

---

## What I did do

Everything that did not require your credentials or a browser:

- **Reader deadline** — a message's own deadline is now shown in the reader,
  in the radar's vocabulary, quoting the phrase it was read from. It was
  extracted, stored and cached, and surfaced nowhere but a six-item sidebar.
- **Token removed from `.git/config`.**
- Audit 15's six consistency fixes (undo parity, announced errors, gate
  semantics, shortcut hints, cross-page settings, one storage fake).

## What I deliberately did not do

- **Labels write support**, notifications, attachment preview, view-original.
  These are real gaps, but building more unverified features on top of a
  product that has never run once is how you get a large pile of code that all
  fails for the same reason. Item 2 above comes first.
