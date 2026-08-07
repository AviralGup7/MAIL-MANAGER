# What the service worker does, and what happens if you remove it

You asked what this deals with, and what the alternatives are if it goes.

```json
"background": {
  "service_worker": "src/background/index.js",
  "type": "module"
}
```

Short answer: **it is the extension's privileged back end.** It holds the
OAuth token, it is the only thing that can run when no tab is open, and it is
what the toolbar button and keyboard shortcut talk to. Removing it entirely is
possible but costs three real features. Removing it *temporarily to unblock a
load failure* is easy and safe.

---

## What it actually does here

Measured from the source, not from the MV3 docs.

### 1. It owns the OAuth token — the security boundary

`src/background/auth.js` performs the sign-in flow and stores `accessToken`.
Grepping the entire app layer for `accessToken` or `Bearer` returns **nothing**.

That is deliberate and load-bearing. The UI runs in an iframe injected into
`mail.google.com`. If the token lived there, every script Google ships on that
page would share a document with your mailbox credential. Instead the app posts
a verb like `ARCHIVE` and the worker performs the call.

**This is the single strongest reason the worker exists.**

### 2. It answers 27 verbs

```
AUTH_STATUS  SIGN_IN     SIGN_OUT    PROFILE     SYNC_PAGE   SYNC_DELTA
GET_BODY     MARK_READ   MARK_UNREAD STAR        ARCHIVE     TRASH
BULK         UNARCHIVE   UNTRASH     SPAM        NOT_SPAM    SEND
GET_DRAFT    SAVE_DRAFT  LIST_LABELS CREATE_LABEL SNOOZE     UNSNOOZE
WAKE_DUE     GET_ATTACHMENT          GET_INLINE
```

The app calls `send(...)` in 22 places. Every one is a round trip through here.

### 3. It runs when no tab is open

This is the part nothing else can replace:

| Hook | Why it matters |
|---|---|
| `chrome.action.onClicked` | the toolbar button |
| `chrome.commands.onCommand` | <kbd>Alt+Shift+M</kbd> |
| `chrome.alarms.onAlarm` | **wakes snoozed mail** |
| `chrome.runtime.onStartup` / `onInstalled` | catch-up sweep for overdue snoozes |

A page can only run while it is open. Snooze is a promise about the future, and
the alarm is the only timer that survives the worker being killed.

---

## Option A — remove it entirely, move the work into the page

**Viable.** The CSP already allows it:

```
connect-src 'self' https://gmail.googleapis.com https://oauth2.googleapis.com
```

`app.html` runs on the `chrome-extension://` origin, so it can call the Gmail
API directly. `chrome.identity`, `chrome.storage` and `chrome.tabs` are all
available to an extension page.

### What you lose

1. **Snooze stops working.** No alarms means no wake. Mail snoozed to
   "tomorrow 8am" reappears only when you next open the app — and only via the
   catch-up sweep, which would also have to move.
2. **The toolbar button and Alt+Shift+M stop working.** Both are worker-only
   events. You would open the app by navigating to it.
3. **The token moves into the page.** Still an extension origin, not Gmail's,
   so it is not catastrophic — but the isolation described above is gone.

### What it costs to build

`send()` becomes a local dispatch instead of `chrome.runtime.sendMessage`, and
`src/background/*` gets imported by the app rather than by a worker. The 27
verb handlers do not need rewriting — they are already plain async functions.

Roughly a day, and it is a genuine downgrade in capability.

---

## Option B — keep the worker, make it trivially thin

**Better if the goal is diagnosing a load failure.** Reduce
`src/background/index.js` to a stub that only registers a message listener, and
move everything else into the page. If it still fails to register, the problem
was never your code.

This is what `tools/bisect/2-real-worker-only` and `tools/sw-probe` already
test, without editing anything.

---

## Option C — keep it, drop only the fragile parts

The most surgical option, and the one I would choose.

The worker is not fragile because it is a worker. It is fragile because a
throw at module top level kills the whole thing. That is already fixed:
`chrome.action?.` and `chrome.commands?.` are optional-chained, so a missing
manifest key costs one feature instead of the extension.

If you want to shrink the surface further, `alarms` is the only permission the
worker strictly needs that a page could not provide. Everything else could
migrate incrementally, with the worker kept purely for the four background
hooks.

---

## If you just want it out of the way *right now*

You do not need to modify any source. Point Chrome at a copy with the
`background` key deleted:

```bash
node tools/make-bisect.mjs
# then load tools/bisect/... in chrome://extensions
```

Or, by hand — remove these four lines from `manifest.json`:

```json
"background": {
  "service_worker": "src/background/index.js",
  "type": "module"
},
```

The extension **will load**. The content script still injects, `app.html` still
renders, the UI still works. Sign-in, mail sync and every action will fail,
because nothing is answering the verbs — but you will see the interface, and
more importantly you will know for certain whether the worker was the thing
blocking the load.

That is a five-second experiment and it answers the question definitively.

---

## My recommendation

Do not remove it as a design decision — it is carrying real weight, and the
security boundary in particular is worth keeping.

Do remove it as a **test**, right now, for thirty seconds. Either the
extension loads without it (the worker is implicated, and Option C narrows it
further) or it still fails (the worker was never the problem, and the cause is
the manifest, the profile, or the browser).
