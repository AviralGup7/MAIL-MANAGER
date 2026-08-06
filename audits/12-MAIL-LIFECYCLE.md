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
| Arrival | 🔴 **no periodic sync, no notification** |
| Scanning | ✅ categories, unread/total counts, deadline rail |
| Reading | ⚠️ good; **no view-source, no print** |
| Threading | 🔴 **absent** |
| Reply | ✅ complete |
| Compose | ⚠️ strong; **no attachments** |
| Organising | ⚠️ **labels are read-only** |
| Recovery | ✅ undo everywhere, untrash, restore-from-source |
| Search | ✅ 20 operators, index + server fallback, saved views |
| Attachments | ⚠️ download works, **no preview** |
| History | ✅ sent, drafts, trash, spam all browsable |

---

## 🔴 Core — these three block the claim

### C-1 · Mail never arrives on its own

**What's missing.** There is exactly one alarm in the worker (`bmm-wake`, for
snooze). `app.js` says outright: *"Delta refresh. Never on a timer."* So new
mail appears only when the app is open **and** you press `r` or reopen it.

**Why it matters.** This is the defining behaviour of a mail client. A client
you must poll by hand is a mail *viewer*.

**Gmail's behaviour.** Push within seconds; unread counts update while you are
elsewhere; a desktop notification if you allow one.

**What's preventing it.** Nothing structural — `alarms` is already permitted
and already drives the snooze wake. `notifications` is not in the manifest.

**Do first:** a periodic alarm running the existing delta sync. That alone
fixes arrival. Notifications are a second step and need a new permission,
plus the classifier is the thing that makes them *wanted* — notify on `augsd`
and `academics`, never on `external-promotions`. That is the one place an
academic feature genuinely improves a core mail task.

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

### C-3 · You cannot attach a file

**Probed:** no `type="file"` anywhere; `buildMime` emits
`multipart/alternative` only.

**Why it matters.** "Send me the PDF" is table stakes. A compose window that
cannot attach forces the user back to Gmail — which defeats the product.

**What's preventing it.** `buildMime` needs `multipart/mixed` wrapping the
existing `alternative` part, plus base64 encoding. The send path already
handles arbitrary MIME.

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

1. **C-1 arrival** — smallest of the three, highest daily impact, unblocks
   notifications.
2. **C-3 attachments** — self-contained, one MIME change.
3. **I-1 labels** — finishes a half-feature.
4. **I-2 view-source** — nearly free given `getFull()`.
5. **C-2 threading** — after the IndexedDB migration.

---

## Answer to the question

**What stops this from feeling like a credible Gmail replacement?**

Mail that does not arrive by itself, conversations that scatter into
individual rows, and a compose window that cannot attach a file.

Fix those three and the honest remaining answer is *"labels are read-only and
there is no print view"* — which is polish, not credibility.
