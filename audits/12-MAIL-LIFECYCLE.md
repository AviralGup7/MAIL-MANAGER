# 12 · Core mail lifecycle audit

**Subject:** BITS Mail Manager at `b6b3bae`.
**Question:** what still stops this from being a credible Gmail replacement?
**Method:** every claim below was probed against running code — the store, the
reply builder, the worker's verb table, the DOM — before it was written down.

Two of my own findings were wrong and are recorded as such.

---

## The verdict in one line

**Three gaps are disqualifying: no new-mail arrival, no threading, and no
outbound attachments.** Everything else is polish or niche.

The lifecycle is otherwise unusually complete — reply/reply-all/forward with
correct quoting and no stacked `Re:`, draft autosave with crash recovery,
spam both ways, undo on everything, a local search index with a Gmail server
fallback, and seven mailboxes.

---

## Stage-by-stage

| Stage | State |
|---|---|
| Arrival | ✅ **auto-refresh shipped**; no desktop notification |
| Scanning | ✅ categories, unread/total counts, deadline rail |
| Reading | ⚠️ good; **no view-source, no print** |
| Threading | 🔴 **absent** |
| Reply | ✅ complete |
| Compose | ✅ **attachments shipped** |
| Organising | ⚠️ **labels are read-only** |
| Recovery | ✅ undo everywhere, untrash, restore-from-source |
| Search | ✅ 20 operators, index + server fallback, saved views |
| Attachments | ⚠️ download works, **no preview** |
| History | ✅ sent, drafts, trash, spam all browsable |

---

## 🔴 Core — these three block the claim

### C-1 · Mail never arrives on its own — ✅ **FIXED**

**What's missing.** There is exactly one alarm in the worker (`bmm-wake`, for
snooze). `app.js` says outright: *"Delta refresh. Never on a timer."* So new
mail appears only when the app is open **and** you press `r` or reopen it.

**Why it matters.** This is the defining behaviour of a mail client. A client
you must poll by hand is a mail *viewer*.

**Gmail's behaviour.** Push within seconds; unread counts update while you are
elsewhere; a desktop notification if you allow one.

**What's preventing it.** Nothing structural — `alarms` is already permitted
and already drives the snooze wake. `notifications` is not in the manifest.

**Shipped:** a repeating timeout, re-armed only after each refresh settles so
a slow network cannot stack requests. Silent, skips hidden tabs, cancelled on
sign-out, 120s default and adjustable to Never in Options.

**Still open:** desktop notifications. They need the `notifications`
permission, and the classifier is what would make them *wanted* — notify on
`augsd` and `academics`, never on `external-promotions`. That is the one place
an academic feature genuinely improves a core mail task.

### C-2 · No conversation threading

**Probed:** three messages sharing `threadId: 'T1'` render as **three separate
rows**; the store exposes no `threads()` or `idsForThread()`.

**Why it matters.** For BITS mail this is the common case — *"Revised
schedule"* → *"Corrigendum"* → *"Final revised schedule"* — and those three
scatter as new mail arrives between them.

**What's preventing it.** The store is per-mailbox, so threading must work
across six `Store` instances and interact correctly with selection, category
rules and the mark-read grace period. It also wants the IndexedDB migration
first, since `CACHE_MAX` is 500.

**Rating: core, but the largest single piece of work in the product.**

### C-3 · You cannot attach a file — ✅ **FIXED**

**Probed:** no `type="file"` anywhere; `buildMime` emits
`multipart/alternative` only.

**Why it matters.** "Send me the PDF" is table stakes. A compose window that
cannot attach forces the user back to Gmail — which defeats the product.

**Shipped.** `multipart/mixed` now wraps the existing `alternative` rather
than replacing it, so the `text/plain` fallback survives. Messages with no
attachment emit exactly the old shape — adding a layer to the 99% case to
serve the 1% is how clients start rendering oddly.

Two things worth noting. Filenames are **attacker-controlled the moment you
forward something**: an unescaped `"` closes the MIME parameter early and a
CRLF injects a whole new header, which turns a forward into a way to add a
`Bcc`. Both are stripped, and there is a test that fails when the stripping is
removed. And attachments live in module state, *not* in the autosaved draft —
`chrome.storage.local` is a ~10MB budget shared with the message cache, so a
5MB PDF would evict the inbox to recover a file the user still has on disk.

---

## ⚠️ Important — credible without them, better with them

### I-1 · Labels are read-only

`label:Thesis` searches, and the palette lists your labels — but nothing can
**apply** one. `CREATE_LABEL` exists and is called only internally by
`ensureLabel` for snooze.

Gmail users organise by label the way this product organises by category. The
category system is genuinely better for BITS mail, which is why this is
important rather than core — but "I can see labels and not use them" is a
half-feature, and half-features are the ones that erode trust.

### I-2 · No view-original / no print

Both are how you resolve *"is this phishing?"* and *"I need this on paper for
the AUGSD counter."* `getFull()` already returns the whole Gmail resource, so
source view is close to free; print needs a stylesheet.

### I-3 · No attachment preview

Download works and is correct. But opening a PDF to check one date means a
download, a file manager, and a cleanup. `GET_ATTACHMENT` already returns a
data URL, so a viewer is mostly UI.

---

## Optional

- **No right-click context menu on a row.** The toolbar and 24 shortcuts cover
  the same actions; this is muscle memory, not capability.
- **No multi-account switcher.** Single account is a stated boundary.
- **No message-level "mute thread".** Needs threading first.

---

## Two findings of mine that were wrong

**F-1 · "`buildReply` returns no recipient and labels forwards `Re:`."**
False. I called it as `buildReply(msg, mode)`; the real signature is
`buildReply(body, selfEmail, mode)`. Called correctly it excludes self from
reply-all, strips stacked `Re:/Fwd:` prefixes, prefers `Reply-To` over `From`,
and produces `Fwd:` for forwards. **The reply path is one of the strongest
parts of the product.**

**F-2 · "Search cannot see message bodies."**
False. Bodies are not in the local index — but `runServerSearch` sends the
query verbatim to Gmail after a 420ms debounce and merges the results, with a
visible "Searching all mail…" note. Gmail's operator syntax is a superset of
ours, so `from:x report` means the same thing on both sides.

Both were caught by probing before writing. Recorded because the next person
to grep for these will have the same suspicion.

---

## Order of work

1. ~~**C-1 arrival**~~ — done.
2. ~~**C-3 attachments**~~ — done.
3. **I-1 labels** — finishes a half-feature.
4. **I-2 view-source** — nearly free given `getFull()`.
5. **C-2 threading** — after the IndexedDB migration. The largest single piece
   of work left in the product.
6. **Notifications** — needs a manifest permission and a real browser to test.

---

## Answer to the question

**What stops this from feeling like a credible Gmail replacement?**

Originally three things: mail that did not arrive by itself, conversations
that scatter into individual rows, and a compose window that could not attach
a file.

**Two are now fixed.** The honest remaining answer is **threading** — and
after that, labels being read-only and there being no print view, which is
polish rather than credibility.
