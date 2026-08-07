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

## 2 · The service worker will not register — the likely cause, at last

### Status code 2 is not a cause

It is `kErrorAbort`, Chromium's generic "operation aborted". A Google
engineer on the issue tracker calls it *"a general grab bag of 'something bad
happened'"*. That is why ten rounds of static analysis found nothing: there
was nothing in the files to find.

### What actually fits every observation

From `woxxOm` (75k reputation, the standing authority on chromium-extensions):

> *"You've unregistered the service worker… reinstall the extension or run
> `navigator.serviceWorker.register(chrome.runtime.getManifest().background.service_worker, {scope:'/', type: …})`"*

**Once a profile holds an unregistered slot for an extension ID, Chrome does
not re-create it when the extension reloads.** The extension loads, the card
shows the error, and the worker never starts.

That state is reached by "Clear site data" in the extension's own DevTools, by
privacy/cleaner tools, and by the interrupted-registration bug
[crbug 394523691](https://issues.chromium.org/issues/394523691).

Why this fits when nothing else did:

| Observation | Explained |
|---|---|
| `sw.js` always fetched **200 OK** | the file was never the problem |
| Moving it to the root changed nothing | scope was never the problem |
| Remove + Load unpacked never helped | **`manifest.key` pins the ID, so you get the same poisoned slot every time** |
| "It worked before the timetable" | a profile event unregistered it; no code change caused this |

That fourth row is the one that matters. Reinstalling *felt* like it should
work, and it could never have worked.

### The fix — try these in order

**1. Open the toolbar popup.** It now detects a dead worker and **repairs it
automatically**: it unregisters the stale slot and registers again from the
manifest. That is the documented recovery, done for you. If the silent
attempt does not take, a **Repair** button appears.

**2. Load `tools/bisect/6-fresh-id`.** Run `node tools/make-bisect.mjs` first.
This is the complete extension with the `key` removed, so Chrome mints a
**new ID and a clean registration slot**.

> **If that one loads and the real one does not, the diagnosis is confirmed** —
> the profile's slot for `dgeanijfllibcphbblkhacjcbdehihcp` is poisoned, and
> no change to this repository can fix it.

**3. If 6-fresh-id works, ship without the key.** `tools/manifest-key.txt`
keeps it, and `docs/EXTENSION-KEY.md` explains the trade (you re-register the
OAuth redirect URI after reloads).

**4. `chrome://version`** — if below **137**, update. That is where crbug
394523691 is fixed.

**5. Untick "unregister service worker"** in DevTools → Application → Clear
storage, if you have ever used it on this extension.

### You are not blocked meanwhile

- **Toolbar button** → the popup, rendered by the browser, needs no worker.
- **<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> on Gmail** → the content
  script handles it directly.
- **Reading, searching, archiving, sending** → the app falls back to running
  the Gmail layer in the page, with an amber banner saying so.

Only **snooze wake-on-timer** genuinely needs the worker.

---

## 2b · Older diagnostic notes

You have hit this twice:

```
Service worker registration failed. Status code: 2
```

**That message names no file, no line and no cause.** It is emitted for any
failure during worker startup, and Chrome deliberately hides the detail on the
extensions card. Everything below exists to get the real error out of it.

### 2a. Get the actual exception — this is the important step

On `chrome://extensions`, on the BITS Mail Manager card, there is a red
**`Errors`** button (it only appears when there are errors). Click it.

That panel shows the real thrown exception with a filename and line number.
One screenshot or paste of it and I can fix the cause in minutes. Without it I
am guessing, and I have now guessed twice.

If there is no `Errors` button, click **`service worker`** (blue link) and read
the Console tab that opens.

### 2b. Rule out the browser with a two-file probe

`tools/sw-probe/` is the smallest legal MV3 extension: a manifest and a
one-line worker. No permissions, no imports, no manifest key, no `chrome.*`
call. There is nothing in it that *can* fail.

1. `chrome://extensions` → **Load unpacked** → select `tools/sw-probe`
2. Click its **service worker** link and look for `[PROBE] service worker
   registered OK`

| Result | What it means |
|---|---|
| Probe registers | Chrome is fine. The fault is specific to the main extension, and 2a will name it. |
| Probe **also** fails | The fault is in the browser or profile, not in any file I can change. See 2c. |

### 2c. If even the probe fails

Then no MV3 extension can start on that profile, and the cause is environmental:

- **Enterprise policy.** Check `chrome://policy` for `ExtensionInstallBlocklist`
  or `ExtensionSettings`. Managed machines commonly block unpacked extensions.
- **A different Chrome profile**, or a fresh one, or Chrome Canary.
- **Chrome version.** The manifest asks for 116+. Check `chrome://version`.
- **The extensions directory is unwritable** — common if Chrome was installed
  by a package manager under a different user, or is running from a read-only
  mount or a WSL/network path.

### 2d. Reload properly, not with the refresh arrow

The circular refresh icon can keep a stale worker registration alive. Use
**Remove**, then **Load unpacked** again. Also confirm you are selecting the
repository ROOT — the folder containing `manifest.json` — and not a parent or
a subfolder.

### 2e. Confirm your files match mine

The manifest you pasted had every URL rewritten as
`[https://mail.google.com/*](https://mail.google.com/*)`, which is markdown
link syntax inside JSON. That is still *valid JSON*, so it parses, and Chrome
then rejects the match patterns. If your working copy really looks like that,
that alone is the bug:

```bash
git status          # should be clean
git pull
npm run doctor      # one second; fails loudly if the manifest is mangled
```

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
