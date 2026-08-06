# 07 · Gmail Competitive Audit

**Subject:** BITS Mail Manager v0.9 (`fc32313`) vs. Gmail web.
**Method:** every claim below was read out of the source at the cited line, not
recalled. Where I could not verify a thing, I say so rather than guessing.
**Scope of the codebase audited:** 11,294 lines across `src/`, `app.html`,
`manifest.json`.

---

## 0 · Executive summary

The product is **not** a thin Gmail reskin. It has three things Gmail does not
have at all — a 15-category BITS classifier (891 pattern keys, 152 exact
addresses), a deadline radar, and universal undo (`src/app/undo.js` — Gmail
undoes *send* only). Those are real moats and the roadmap below protects them.

But the gap analysis turned up something more important than any missing
feature, so it goes first.

### The three findings that outrank the feature list

**F-1 — Remote images are silently and permanently broken. (Critical, verified)**
`src/app/sanitize.js:79` permits `https:` on `img[src]`, so a remote image
survives sanitisation and lands in the reader document. Then
`src/app/app.js:795` sets the frame CSP to `img-src data:`. The tag is present,
the fetch is blocked, and the user gets a blank box with **no explanation and no
way to load it**. Gmail proxies images through `googleusercontent.com` and, when
it does block, says so in a bar with a "Display images below" button. Two
defensible designs exist (block-and-offer, or proxy); the current state is
neither — it is a policy the sanitiser and the CSP disagree about. Any mail with
a logo or a signature image renders wrong today.

**F-2 — Inline `cid:` images have no handling whatsoever. (Critical, verified)**
`grep -rn "cid" src/app/sanitize.js src/app/app.js` returns nothing.
Multipart/related mail — every newsletter, most institutional HTML mail —
references its own attached images as `cid:something@domain`. `cid:` is not in
`SAFE_SCHEME`, so the attribute is dropped and the image vanishes with no
placeholder. The parts *are* already fetchable: `GET_ATTACHMENT`
(`src/background/index.js:217`) exists and works. This is roughly 40 lines of
wiring, and its absence makes formatted mail look broken.

**F-3 — The reader iframe is fixed-height with an inner scrollbar.**
`src/app/app.css:1002` sets `#r-body{height:100%}`. Long mail therefore scrolls
*inside* a box, nested in the page's own scroll. Gmail's message body has no
independent scroll region; the whole conversation scrolls as one. Nested
scrolling is a well-known source of trackpad frustration and it breaks
"reading-position memory" entirely. Fixing it requires height measurement,
which needs a `postMessage` channel — impossible today because the frame is
sandboxed without `allow-scripts`, which is a *deliberate and correct* security
decision. This is the clearest architectural constraint in the product, and
§9 works through the options honestly rather than pretending it is easy.

### Verified capability inventory

| Area | State | Evidence |
|---|---|---|
| Verbs implemented | 21 | `src/background/index.js:160-217` |
| Verbs implemented but **unreachable from UI** | 2 (`LIST_LABELS`, `CREATE_LABEL`) | nothing calls them |
| Search operators | 8 | `query.js:140-173` |
| Search index scope | subject + sender **only** | `store.js:106` |
| Keyboard shortcuts | 13 | `app.js:1421-1490` |
| Settings exposed to user | **1** (`clientId`) + theme | `options.js:44-79` |
| Sync trigger | manual only, no timer | `app.js:998` "Never on a timer" |
| Conversation threading | **none** — flat list | `threadId` stored, only used for a deep link (`app.js:644`) |
| Offline awareness | none | no `navigator.onLine` anywhere |
| Notifications | none | no `Notification` anywhere |
| Drafts | can save, **cannot list** | `SAVE_DRAFT` exists; no drafts view |
| Attachments | download ✅, preview ❌ | `app.js:681` |
| Print | none | `grep print` → only a comment |
| Context menus | none | no `contextmenu` listener |
| Multi-account | none | `ACCOUNT_INDEX` is a constant, `app.js:126` |

**Headline:** the deepest gap is not any single feature. It is that
**14 of the 15 sidebar entries are BITS categories and there is no way to reach
Sent, Drafts, Spam, Trash, or any Gmail label.** Sync hard-codes
`labelIds:['INBOX']` (`sync.js:68`). The product is an inbox triage tool
presented as a mail client, and a user who needs to check what they sent must
leave for Gmail. That single boundary causes more defection than every polish
item combined.

---

## 1 · How to read the analyses

Every entry carries the ten fields requested. Impact and complexity are my
estimates, and I state the basis. Where I recommend **Do Not Copy**, the
reasoning matters more than the verdict — those are the entries where Gmail is
wrong and imitating it would make this product worse.

Two abbreviations: **Freq** = usage frequency, **Cx** = engineering complexity.

---

## 2 · Critical missing features

These block competitiveness. A user hits all five in their first week.

---

### C-1 · Conversation threading

**1. Feature.** Gmail groups messages sharing a thread into one expandable
conversation, collapsed to sender names with the newest expanded, quoted text
folded behind a "···" chip.

**2. Description.** Threading keys on `threadId` plus `References`/`In-Reply-To`.
Collapsed rows show sender and a one-line snippet. Gmail detects the quoted
reply chain and hides it. A conversation counts as **one** row in the list with
a message count `(3)`.

**3. User problem.** Without threading, a five-message exchange is five rows
that scatter as new mail arrives between them. Reconstructing "what was
decided" means opening five things and mentally ordering them.

**4. Impact — Critical.** For BITS specifically: administrative mail is
*heavily* threaded. "Revised schedule" → "Corrigendum to revised schedule" →
"Final revised schedule" is the canonical AUGSD pattern, and it is exactly the
case where reading the wrong one has consequences. This is also the single
feature whose absence is most immediately visible.

**5. Freq — Every interaction.** Every list render.

**6. Productivity.** In a 200-message inbox with a typical 1.6 messages/thread
ratio, list length drops ~35%. Saves ~4 clicks per multi-message exchange and
removes the "is this the latest one?" check entirely.

**7. UX.** Efficiency, error prevention (reading a superseded message is a real
error with real cost), scanning, satisfaction.

**8. Cx — High.** `Store` is keyed by message id with an `order` array and an
inverted index (`store.js:53`). Threading needs a second grouping layer:
`threadId → id[]`, a rule for which message represents the thread (newest,
non-draft), thread-level unread/starred as an OR-reduction over members, and
`_index`/`_deindex` must maintain it incrementally — a `rebuild()` in the hot
path is explicitly ruled out by the file's own doc comment (`store.js:24`).
Category assignment must also resolve: members can classify differently, so the
thread needs a deterministic rule (I'd use the newest member's category, and
show a low-confidence marker on disagreement).

**9. Dependencies.** Storage (cache schema, `cache.js:55` is a positional array
— adding a field is a versioned migration), state management, UI redesign of
the row, search (matching a member must surface the thread), sync (delta must
regroup), a11y (expand/collapse semantics), testing.

**10. Recommendation — Implement Soon.** Not "immediately" only because F-1/F-2
are smaller and hurt more per hour of work. This is the largest single
engineering item on the roadmap and should be the next *major* project.

---

### C-2 · Sent, Drafts, Spam, Trash, and Gmail labels

**1. Feature.** Gmail's left rail: Inbox, Starred, Snoozed, Sent, Drafts, All
Mail, Spam, Trash, plus every user label, nestable, colourable, pinnable.

**2. Description.** Each is a query over a system label. Drafts are editable
in place. Trash auto-purges at 30 days and says so. Labels are many-to-many,
unlike folders — a message can carry five.

**3. User problem.** "What did I send?" "Where's that draft?" "Did it go to
spam?" Without these the answer is always "go to Gmail."

**4. Impact — Critical.** This is the leak. Every other feature is undermined
by a workflow that ejects the user. Worse, it is *self-reinforcing*: once in
Gmail, they have no reason to come back this session.

**5. Freq — Daily.** Sent and Drafts daily; Spam weekly; Trash on mistakes.

**6. Productivity.** Eliminates a full context switch — the takeover animation
runs 380/260ms each way, plus Gmail's own load, plus re-finding your place.
Realistically 15-30s and a lost train of thought, several times a day.

**7. UX.** Learnability (the rail is where every mail user looks first),
efficiency, confidence, workflow completeness.

**8. Cx — Medium.** The API work is nearly free: `listIds` already takes
`labelIds` (`gmail.js:127`) and `syncPage` already threads it through
(`sync.js:38`). `LIST_LABELS` and `CREATE_LABEL` **already exist and are
already unreachable** (`index.js:211-213`) — the same "unfinished, not missing"
pattern this codebase keeps producing. The real work is that `Store` currently
holds one collection that is implicitly the inbox. Multiple label views need
either per-view stores or a `labels` predicate on the existing one; the latter
is cheaper and the data is already there (`normalise` keeps the full `labels`
array, `gmail.js:239`).

**9. Dependencies.** Sync (per-label cursors — `historyId` is account-wide so
this is simpler than it looks), storage (cache per view, with a bound), UI
(rail redesign — 15 categories plus 8 system views needs sectioning), state.

**10. Recommendation — Implement Immediately.** Highest impact-to-effort ratio
in the document. Start with **Sent + Drafts** — those are the two a user needs
in the same session as composing, and compose already exists.

---

### C-3 · Remote-image policy (finding F-1)

**1. Feature.** Gmail proxies every remote image through
`googleusercontent.com`, stripping the sender's view of your IP and User-Agent
while still showing the picture. For untrusted senders it blocks and shows a
bar: "Images are not displayed. Display images below · Always display images
from X."

**2. Description.** The proxy caches, so a tracking pixel fires at most once and
carries Google's IP. The bar is per-message with a per-sender persistent
override.

**3. User problem.** Two at once: tracking pixels report when and where you
read mail; and blocking without explanation makes legitimate mail look broken.

**4. Impact — Critical (defect, not gap).** Current behaviour is the worst
option: the tag renders, the fetch dies, the user sees an empty rectangle with
no bar, no alt fallback styling, and no override. Not a missing feature — an
**inconsistency between two files** that each look correct alone.

**5. Freq — Every interaction.** Nearly all institutional and commercial mail
carries images.

**6. Productivity.** Removes "is this email broken or is my client broken?"
Restores signatures, logos, posters — for BITS club and event mail the poster
*is* the message.

**7. UX.** Error prevention, trust, satisfaction, privacy confidence.

**8. Cx — Low.** No proxy needed and none should be built (running one means
running a server, which this product deliberately does not have). Correct fix:
strip `src` → `data-bmm-src` in the sanitiser, render a styled placeholder,
show a reader bar with a count, and on click rewrite the srcdoc with
`img-src https:`. Per-sender allow-list in `chrome.storage.local`.

**9. Dependencies.** Sanitiser, reader render path, settings (default policy +
allow-list), a11y (the bar must be announced), tests.

**10. Recommendation — Implement Immediately.** Small, visible, fixes a live
defect, and the block-by-default default is *stronger privacy than Gmail* —
Gmail proxies by default, which still confirms the read to the sender via cache
timing. Ship it as a stated advantage.

---

### C-4 · Inline `cid:` images (finding F-2)

**1. Feature.** Gmail renders multipart/related inline images in position.

**2. Description.** HTML references `cid:xyz@host`; the matching MIME part
carries `Content-ID: <xyz@host>`. The client resolves reference to part.

**3. User problem.** Without it, formatted mail is a wall of text with holes.
The images are *attached to the message you already downloaded* — they are not
even a network round trip in principle.

**4. Impact — Critical.** Combined with C-3, HTML mail currently cannot render
correctly by either path. Every image in every message is broken.

**5. Freq — Daily.**

**6. Productivity.** Removes "open in Gmail to actually see this" — which is
C-2's leak arriving by a second route.

**7. UX.** Reading comfort, completeness, trust.

**8. Cx — Low.** `getAttachment` already returns data
(`gmail.js:496`). Walk `payload.parts` for `Content-ID`, fetch, convert to a
`data:` URL, substitute. Note this needs **no CSP change** — the frame already
permits `img-src data:` (`app.js:795`), which is why this is the cheapest
visual win available. Bound total substituted bytes (I'd cap ~2MB) so a hostile
message cannot blow up the srcdoc.

**9. Dependencies.** Body fetch path, sanitiser (`cid:` must survive the
attribute walk to be rewritten), memory bound, tests.

**10. Recommendation — Implement Immediately.** Cheapest high-visibility fix in
the document. Do it in the same commit as C-3.

---

### C-5 · Background sync and new-mail notification

**1. Feature.** Gmail pushes new mail into an open tab within seconds, updates
the favicon and title count, and can raise a desktop notification.

**2. Description.** Long-lived channel server-side; a browser-notification
permission prompt on first opt-in.

**3. User problem.** A stale mail client is a mail client you stop trusting.
If you must press refresh to know, you press it constantly — or you leave Gmail
open in another tab, which defeats the entire product.

**4. Impact — High.** `app.js:998` — *"Cheap; safe to call on demand. **Never on
a timer.**"* That is a defensible performance decision that has become a product
problem: the app can be arbitrarily stale and never says so.

**5. Freq — Hourly.**

**6. Productivity.** Removes manual refresh (a few dozen clicks/day for an
active user) and, more importantly, removes the *doubt*.

**7. UX.** Confidence, reliability, timeliness. Notifications need care: a
notification per message is hostile — this is where the classifier earns its
keep (see I-2).

**8. Cx — Medium.** MV3 service workers are killed aggressively, so a
`setInterval` in the worker is unreliable by design; this needs `chrome.alarms`,
which was **deliberately removed from `permissions`** (manifest now
`["identity","scripting","storage"]`). Restoring it is a permission change, so
it must be justified in the store listing. Minimum granularity is 1 minute.
Deltas are cheap — `SYNC_DELTA` uses the History API — but the token is a
1-hour implicit-flow token with **no refresh token**, so background sync will
hit silent-renewal failures and must degrade gracefully rather than spam errors.

**9. Dependencies.** Manifest permissions (`alarms`, `notifications`), auth
(silent renewal reliability), sync, settings (interval, quiet hours, which
categories may notify), battery/quota care.

**10. Recommendation — Implement Soon.** Do the alarm-driven refresh first and
notifications second, gated behind an explicit opt-in and category filter.

---

## 3 · High-impact improvements

---

### H-1 · Search over message bodies

`store.js:106` indexes **subject and sender only** — an explicit, documented
trade ("Snippets would triple index size"). Gmail searches full body text
server-side.

The consequence is that search *silently* misses. A user searching a phrase
they remember from the body gets zero results and concludes the mail is gone.
A wrong-but-confident answer is worse than a slow one.

Two options, and I favour the second:
1. Index snippets too — cheap, but snippets are ~100 chars, so it only
   *narrows* the gap while still being silently incomplete.
2. **Delegate to the Gmail API on miss.** `listIds` already accepts `q`
   (`gmail.js:127`) and `syncPage` already handles a `q` path with
   `labelIds:[]` (`sync.js:68`). So when the local index returns few or no
   results, fire the same query server-side and merge, labelled "N more from
   Gmail". This is *better than Gmail* on the fast path (local is instant) and
   *equal* on the slow path.

**Impact High · Freq Daily · Cx Medium** (async search state, race handling on
fast typing, merge semantics, result provenance in the UI).
**Recommendation — Implement Soon.**

---

### H-2 · Undo Send

Gmail holds outbound mail 5-30s (configurable) and offers "Undo". It is
consistently cited as one of Gmail's most-loved features, because the regret
arrives about two seconds after the click.

This product has the **best undo architecture of any mail client I have read** —
`UndoStack` covers archive, delete, star, bulk (`undo.js`) — and it is the one
place Gmail actually has undo where this product does not. That asymmetry is
almost funny and should be closed.

Implementation is a client-side hold: queue the MIME, show a toast with a
countdown, call `sendMessage` on expiry. Do **not** use Gmail's scheduled-send
for this (minimum granularity is far too coarse). The hard part is the failure
mode: if the app closes during the hold, the mail must still send — so the
timer belongs in the service worker, not the page, which again wants `alarms`.
Ship it with C-5.

**Impact High · Freq Daily · Cx Low-Medium.**
**Recommendation — Implement Soon.**

---

### H-3 · Snooze

Gmail hides a message until a chosen time, then returns it to the top of the
inbox as unread.

For a student inbox this is arguably *more* valuable than in a work inbox: "fee
deadline on the 20th" wants to reappear on the 19th, and the deadline radar
(`src/app/deadlines.js`) **already parses dates out of BITS mail**. Snooze plus
the radar is a feature Gmail cannot match, because Gmail has no idea what the
message is about.

Mechanism: remove `INBOX`, add a `BMM/Snoozed` label, persist the wake time,
and restore on an alarm. Note the correctness trap — if the wake alarm never
fires (extension disabled, profile moved), the mail is *lost from the inbox*.
Mitigation: a visible Snoozed view (so nothing is invisible), and a wake check
on every startup that catches anything overdue.

**Impact High · Freq Daily · Cx Medium** (needs `alarms`, storage, a view,
recovery-on-startup).
**Recommendation — Implement Soon**, immediately after C-5 lands `alarms`.

---

### H-4 · Keyboard shortcut help overlay (`?`)

13 shortcuts exist (`app.js:1421-1490`). Discoverability is near zero — the
palette hint mentions a few, and `FIXING.md` is not something anyone reads
twice. Gmail's `?` overlay is how every Gmail power user learned Gmail.

This is the highest ratio of value to effort in the entire document: a static
modal, one keybinding, an existing dialog pattern to copy, roughly 80 lines. It
converts already-built work into used work.

**Impact Medium-High · Freq Weekly (but gates daily use of 13 features) · Cx
Very Low.**
**Recommendation — Implement Immediately.** Do it this week.

---

### H-5 · Settings depth

Currently exposed: `clientId` and theme (`options.js`). Gmail has dozens of
preferences. Most are cruft, but a defensible core is missing:

density (comfortable/compact), default view on open, mark-read-on-open (a real
preference — some users read the list and want *nothing* marked), signature,
send-and-archive, undo-send delay, remote-image policy (from C-3), notification
rules (from C-5), reply-vs-reply-all default.

Each is small; the dependency is that **each one is a branch in the render
path** and therefore a test. Build a settings schema with defaults in one
module rather than scattering `storage.get` calls — the current single-key
approach will not survive ten keys.

**Impact Medium-High · Freq Occasionally (set once, felt daily) · Cx Low-Medium.**
**Recommendation — Implement Soon.** Blocked-ish on C-3 and C-5, which each add
a setting; do the schema first so those land into a real home.

---

### H-6 · Rich-text compose

`c-text` is a `<textarea>` (`app.html:304`), and `buildMime` escapes it into a
`<div style="white-space:pre-wrap">` (`gmail.js:409`). So: no bold, no lists,
no links, no inline images, and — most visible — **no quoted original in
replies**, which makes every reply look like it dropped the context.

Gmail gives a full WYSIWYG plus quoted-original folding.

I would **not** build a full editor. `contenteditable` is a notorious
cross-browser swamp and a large ongoing maintenance liability. Two better
options:
1. **Markdown-ish plain text** rendered to HTML on send — bold/italic/lists/links
   from characters people already type. Small, testable, no editor bugs, and it
   suits a technical user base.
2. A minimal `contenteditable` with exactly four commands and aggressive paste
   sanitisation (reuse `sanitize.js`).

Quoted-original inclusion is separate and **should be done regardless of which
editor** — it is a correctness issue, not a formatting one.

**Impact Medium-High · Freq Daily · Cx Medium (markdown) / High (WYSIWYG).**
**Recommendation — Implement Soon** for quoted-original; **Nice to Have** for
formatting, via markdown.

---

### H-7 · Contact autocomplete in compose

`c-to` is `autocomplete="off"` free text (`app.html:299`). One typo and the mail
bounces — or worse, reaches the wrong person. Gmail autocompletes from contacts
and history, with avatars and a warning for unusual recipients.

No new scope needed and no Contacts API required: **every address the user has
ever received mail from is already in the local store**, and the inverted index
already tokenises the local part and domain of addresses separately
(`store.js:119`) — the data structure for this is *already built*.

**Impact Medium-High · Freq Daily · Cx Low.** Frequency-ranked local lookup +
a combobox with correct ARIA.
**Recommendation — Implement Soon.** High value, and the groundwork exists.

---

### H-8 · Attachment preview

Download works (`app.js:681`); preview does not. Gmail previews PDF, images,
and Office docs in an overlay. For a student, "is this the right timetable?"
should not require a download, a file manager, and an external app.

Scope it honestly: **images and PDF only**. Images are trivial (`data:` URL in
an overlay). PDF needs a viewer — Chrome's built-in handles a blob URL in an
iframe, which is nearly free; bundling `pdf.js` is not, and I would not.
Office formats: **Do Not Copy** — that requires a rendering service.

**Impact Medium · Freq Weekly · Cx Low (images) / Medium (PDF).**
**Recommendation — Nice to Have**, images first.

---

### H-9 · Offline behaviour

No `navigator.onLine` anywhere. Gmail Offline caches recent mail and queues
outbound actions.

Half of this is **already done and merely unexposed**: `cache.js` gives a warm
start, so cached mail is already readable offline. What is missing is (a) the
app never *says* it is offline, and (b) actions fail with a raw error instead of
queueing.

Minimum viable: an offline banner, disable actions that cannot work, and queue
mutations for replay. Queueing needs conflict thought — replaying an archive
against a message the user already deleted on their phone must not resurrect
it. Gmail solves this server-side; here, replay should be **best-effort and
report failures**, not silently reconcile.

**Impact Medium · Freq Occasionally (Critical when it happens) · Cx Medium.**
**Recommendation — Nice to Have.** Banner + read-only degradation is the cheap
80%; do that, defer the queue.

---

## 4 · Medium priority

**M-1 · Right-click context menu.** No `contextmenu` handler anywhere. Gmail's
row menu gives archive/delete/label/snooze/mute at the pointer. Saves travel to
the toolbar. *Impact Medium · Freq Daily · Cx Low.* **Nice to Have** — but note
it must not suppress the browser menu on text, and every item needs a keyboard
path too, or it becomes an accessibility regression.

**M-2 · Hover quick-actions on rows.** Gmail reveals archive/delete/mark-read/
snooze on row hover. Turns two clicks into one for the most frequent action in
email. Must be `opacity` only (never layout), per the standing motion rules, and
must also appear on keyboard focus. *Impact Medium · Freq Every interaction ·
Cx Low.* **Implement Soon** — this is a strong ratio.

**M-3 · Drafts list.** `SAVE_DRAFT` exists (`index.js:207`); nothing lists
drafts. A draft you cannot find is a lost draft. Folded into C-2. *Cx Low* once
C-2 lands.

**M-4 · Auto-save drafts while typing.** Gmail saves every few seconds. Today,
closing compose loses everything. This is a **data-loss bug wearing a feature
costume** and I rank it above most of this section. Debounced local save is the
first 30 lines; server draft sync is the rest. *Impact High · Freq Daily · Cx
Low.* **Implement Soon.**

**M-5 · Print.** No print path; the sandboxed iframe cannot be triggered to
print from the parent without `allow-scripts`, so this is genuinely blocked by
the same constraint as F-3. Workaround: render a print-specific document. *Impact
Low-Medium · Freq Rarely · Cx Medium.* **Nice to Have.**

**M-6 · Recent searches / suggestions.** No search history (`grep recent` →
nothing). Gmail suggests prior searches and contacts on focus. The saved-views
feature (`views.js`) covers the *deliberate* case; this covers the accidental
one. *Impact Medium · Freq Daily · Cx Low.* **Nice to Have.**

**M-7 · More search operators.** Eight exist. Missing: `cc`, `bcc`, `filename`,
`larger`/`smaller`, `older_than`/`newer_than`, `list`, `in`. Also missing:
**`OR` and parenthesised grouping** — the parser ANDs every check
(`query.js:133`, `checks.every`). `OR` is the one users actually miss. *Impact
Medium · Freq Weekly · Cx Low-Medium* (grouping means a real parser).
**Nice to Have**, with `OR` first.

**M-8 · Mute / block sender.** Gmail mutes a thread and blocks a sender to spam.
For a student on 40 club mailing lists this is the single most requested action.
The classifier gives a *better* version of this — see I-1. **Nice to Have** as
Gmail-parity; **Implement Soon** as the I-1 form.

**M-9 · Importance markers.** `important` is parsed (`gmail.js:240`) and
searchable, but never shown. Gmail displays a yellow chevron and learns from
corrections. Free to display; the learning part is I-3. *Cx Very Low.*

**M-10 · Multiple accounts.** `ACCOUNT_INDEX` is a constant (`app.js:126`).
Many BITS students run a personal Gmail alongside the institute one. Genuinely
hard: multiple token sets, multiple stores, multiple caches, and an account
switcher touching every view. *Impact Medium · Freq Daily for those affected ·
Cx Very High.* **Nice to Have** — revisit after the architecture settles;
building it early would tax every other feature.

**M-11 · Filters / rules.** Gmail lets users write server-side rules. Here the
classifier does this automatically and better for BITS mail. But there is no
**override**: when the classifier is wrong, the user can do nothing. A
user-rule layer that takes precedence is the right shape — see I-3. **Not
Worth Implementing** as Gmail-style filters; **Implement Soon** as corrections.

**M-12 · Infinite scroll / pagination polish.** `loadPage` exists
(`app.js:984`) with an explicit "Load more". Gmail paginates in fixed pages
with position memory. The current model is fine — arguably better. **Do Not
Copy** Gmail's pagination. Do add automatic loading near the scroll end.

---

## 5 · Low priority / polish

- **Avatars in rows.** Gmail shows sender avatars. Deterministic initials with
  a hashed colour would fit the "code-generated assets" rule and aid scanning
  meaningfully. *Cx Very Low.* Recommended despite the low ranking.
- **Read receipts, confidential mode, Smart Compose, Meet/Chat/Spaces
  integration, themes with background images, tabbed inbox (Primary/Social/
  Promotions).** All **Do Not Copy**. The tabbed inbox in particular is
  Gmail's weaker answer to the problem this product's 15-category classifier
  solves properly; adopting it would be a downgrade.
- **Vacation responder.** Server-side setting; genuinely useful, rarely
  changed. *Nice to Have.*
- **Row density toggle.** Folded into H-5.
- **Message translation, "unsubscribe" button.** Unsubscribe detection
  (`List-Unsubscribe` header) is *cheap* and high value for a promotions-heavy
  student inbox — worth pulling up to Medium.

---

## 6 · Design philosophy comparison

Where the product already wins, and where it does not.

| Dimension | Gmail | This product | Verdict |
|---|---|---|---|
| Navigation clarity | Labels — user must build the taxonomy | 15 auto-categories, ordered by urgency (`categories.js:58`) | **Ahead**, but broken by the missing system views (C-2) |
| Information density | Configurable, default roomy | One density, tuned | Even; needs the toggle |
| Visual hierarchy | Accreted over 20 years | Full token system, one iconography set, audited contrast | **Well ahead** |
| Reading comfort | Full width, no measure control | 68ch measure, 15px/1.65 (`app.js:806`) | **Well ahead** |
| Search discoverability | Chip-based advanced panel | Operators exist, undiscoverable | **Behind** |
| Message scanning | Threading + avatars | Category tags + confidence | Mixed |
| Triage | Archive/delete/label | Same + bulk + universal undo | **Ahead** |
| Interaction speed | Server round-trip per action | Optimistic local + async network | **Well ahead** |
| Feedback quality | Toasts, sometimes silent | Toast + undo on every mutation | **Ahead** |
| Loading experience | Skeleton + progressive | Skeleton, suppressed on warm cache (`app.js:415`) | **Ahead** — the "don't replace real mail with grey bars" reasoning is better than Gmail's |
| Motion | Minimal, inconsistent | Tokenised, reduced-motion honoured as the last rule | **Ahead** |
| Error handling | Generic banners | Mapped messages with fixes (`app.js:1068`) | **Ahead** |
| Progressive disclosure | Everything visible | Palette-first | Even |
| Customisation | Dozens of settings | Two | **Behind** (H-5) |
| Keyboard-first | ~40 shortcuts, `?` overlay | 13 shortcuts, no overlay | **Behind** (H-4) |
| Consistency | Drifts between surfaces | Lint-enforced single definitions | **Well ahead** |
| Accessibility | Mature, heavily tested | WCAG 2.2 hit targets, contrast-checked, tab-stop audited | **Ahead on measured axes**, unverified with a real screen reader |
| Reliability | Battle-tested at scale | 323 tests, **zero browser runtime** | **Behind** — see §10 |

The honest summary: **this product is better designed and worse finished.** Its
craft ceiling is higher than Gmail's; its floor is a missing Sent folder.

---

## 7 · Hidden Gmail behaviours

The subtle things. These are where perceived quality actually comes from.

1. **Focus restoration after archive.** Gmail moves focus to the *next* message
   and keeps the cursor in the list. Verify this product does the same — a
   focus drop to `<body>` after archive breaks keyboard triage completely, and
   it is the single most common regression of its kind. (`app.js:887` handles
   the action; the focus consequence is worth an explicit test.)
2. **Auto-advance preference.** Gmail lets you choose newer / older / back to
   list after archiving. A genuine workflow fork; most clients hard-code it.
3. **Hover-intent delay.** Gmail delays hover cards ~300ms so a mouse crossing
   the list does not strobe. Any hover card (M-2) needs this or it feels cheap.
4. **Undo timing.** Gmail's toast persists ~5s but the *keyboard* undo window
   is longer. This product's `UndoStack` uses a 5-minute TTL (`undo.js:35`) —
   **better**, and it should be advertised in the UI, because a user who does
   not know the undo is still live will not reach for it.
5. **Draft persistence across crashes.** Gmail restores an unsent draft after a
   browser crash. Covered by M-4.
6. **Reading-position memory.** Gmail returns you to your scroll position in a
   long message. Blocked by F-3 (nested scroll).
7. **Selection anchoring.** Shift-click extends from the last *anchor*, not the
   last clicked row. Subtly different and users feel the wrong one. Worth
   checking `selection.js` against this precisely.
8. **Search ranking.** Gmail ranks by relevance, not date. Here results are
   date-ordered via the `order` array. Date order is defensible and often
   better for mail — but it should be a *choice*, and it is currently a
   consequence.
9. **Optimistic label counts.** Gmail updates the unread count before the
   server confirms. Already done here.
10. **Cursor positioning in compose.** Reply → cursor above the quote; forward →
    cursor at the very top; new → in the To field. Small, and its absence is
    felt every single time.
11. **Escape hierarchy.** Escape should close the innermost thing (palette →
    compose → reader → release takeover), never jump straight out. Worth an
    explicit test; this is where "one Escape too many dumped me back in Gmail"
    complaints come from.
12. **Loading prioritisation.** Gmail paints the list before bodies. Already
    matched — bodies fetch on open (`gmail.js:254`).
13. **Scroll-anchoring on new mail.** New mail arriving must not push the row
    you are reading. `overflow-anchor` handles it; verify it is not disabled.
14. **Middle-click / Cmd-click to open in a new context.** No equivalent here;
    minor.
15. **Marking read on open, with a delay.** Gmail marks read almost instantly;
    some clients wait ~2s so a mis-click does not consume the unread state. The
    delayed version is better and should be the setting's default.

---

## 8 · Architecture comparison

| Capability | Gmail | This product | Note |
|---|---|---|---|
| Incremental sync | Server push | History API deltas (`sync.js`) | **Matched.** Cursor read before listing — a bug already fixed this project. |
| Virtualisation | Full virtual list | `content-visibility:auto` | Works to 2000 rows, 1 render. **Unproven above that**, and unproven in a real layout engine (jsdom has none). |
| Background refresh | Always | None | C-5. Constrained by MV3 worker lifetime. |
| Caching | IndexedDB, large | `chrome.storage.local`, one key, 10MB bound (`cache.js:31`) | The bound is real. A 5,000-message mailbox will hit it. IndexedDB is the upgrade path. |
| Offline storage | Full | Read-only warm cache | H-9. |
| Search indexing | Server, full text | Local inverted index, **subject+sender only** | H-1. Biggest architectural gap in search. |
| Threading | Native | None | C-1. |
| Optimistic updates | Yes | Yes, with universal undo | **Ahead.** |
| Conflict resolution | Server authoritative | Last-write-wins, no detection | Acceptable now; becomes visible with offline queueing. |
| Session restoration | Full | Theme + cache | No scroll/selection/draft restoration. |
| Telemetry | Extensive | **None** | Deliberate and correct. But it means every performance claim is an *expectation* — see TODO 13. |
| Plugin architecture | Add-ons | None | Not needed. |
| Large mailbox | Millions | 2000 cap | Fine for the target user; state it. |

### Architectural limitations that genuinely block Gmail parity

1. **Sandboxed reader iframe without `allow-scripts`** (`app.html:260`). This is
   the right security decision and it is *load-bearing* — it is why hostile mail
   cannot phone home. It costs: iframe auto-height (F-3), print (M-5),
   in-body find, and scroll-position memory. Options: (a) accept it; (b) measure
   height by rendering the sanitised DOM off-screen in the parent and sizing the
   frame to that — awkward but scriptless; (c) drop the iframe and render
   sanitised HTML directly in the parent, relying on `sanitize.js` alone. **(c)
   is tempting and should be refused** — it makes the sanitiser the only line of
   defence, and sanitisers are bypassed regularly. I recommend (b), and if it
   proves unreliable, (a) with the nested scroll made visually explicit.
2. **Implicit-flow tokens, 1 hour, no refresh token.** Every long-running
   background behaviour (C-5, H-2, H-3) must tolerate silent-renewal failure.
   This is a permanent tax imposed by Google rejecting every other option, and
   it should be designed for once, centrally, rather than in each feature.
3. **`chrome.storage.local` 10MB.** Caps mailbox size and blocks attachment
   caching outright. IndexedDB migration is the unlock for C-1, H-8 and H-9
   together — worth doing *before* those, not during.
4. **MV3 service worker termination.** No long-lived connection. `alarms` is
   the only reliable timer, minimum 1 minute.
5. **No server.** No push, no image proxy, no cross-device state, no
   server-side rules. Also: no privacy risk, no cost, no outage. Correct trade
   for this product; it just needs to be *stated* so features are not designed
   assuming a backend.

---

## 9 · Where this product can beat Gmail

Matching Gmail is table stakes and is most of §2. Winning is here.

**I-1 · Category-level mute and auto-triage.** Gmail's mute is per-thread;
blocking is per-sender. Neither maps to "I do not care about club mail during
exam weeks." This product knows the *category* of every message. Offer:
mute a category, auto-archive a category, digest a category. Gmail structurally
cannot do this — it does not know what BITS mail is. *Cx Low* — the
classification already exists. **Highest-leverage differentiator in the
document.**

**I-2 · Notification rules driven by the classifier.** Gmail notifies on
"important" using an opaque model. Here: notify on `augsd`, `academics`, and
`admin`; never on `external-promotions`. That is a preference a student can
actually state, and it makes C-5 *desirable* rather than annoying. Pair them.

**I-3 · Correcting the classifier.** When it is wrong, let the user say so, and
have the correction persist as a user rule that outranks the generated rules.
Gmail's importance model is uncorrectable in any way the user can see. This also
generates exactly the labelled data the classifier currently lacks — the audit
notes no real BITS corpus exists. **This feature is simultaneously a UX fix and
the data pipeline.** *Cx Low-Medium.*

**I-4 · Deadline radar, extended.** `deadlines.js` already extracts dates. Next
steps Gmail cannot follow: an "add to calendar" `.ics` export, a deadline
countdown in the row, and snooze-to-the-day-before (H-3). Gmail's date
detection is generic; a BITS-aware one knows a comprehensive-exam date matters
more than a webinar.

**I-5 · Universal undo, advertised.** Already built and already better than
Gmail. Nobody knows. Surface it in H-4's overlay and in the toast copy.

**I-6 · Privacy as a stated feature.** Blocking remote images by default (C-3)
is stronger than Gmail's proxy. No telemetry. No server. Say this on the
options page — it is a genuine differentiator for a security-aware user base.

**I-7 · Being an extension is an advantage, not a constraint.** Gmail cannot
take over Gmail. This product can: keep Gmail's tab, its session, its
notifications, its search-as-fallback (H-1), and its deep links (`app.js:644`) —
and put a better interface in front. The "Open in Gmail" escape hatch means
parity is never strictly required for the long tail (M-5, M-10, vacation
responder). **This should be an explicit product principle:** for rare features,
link out rather than rebuild. It is why §5 can say "Do Not Copy" so often.

**I-8 · Speed as a measurable claim.** Optimistic updates + warm cache mean
actions are instant where Gmail round-trips. Once TODO 13's headless-Chrome
benchmark exists, this becomes a number, and a number is marketing.

---

## 10 · Prioritised roadmap

Ranked by impact ÷ effort, with dependencies respected.

### Tier 0 — before any new feature
These are defects and verification, not features.

| # | Item | Why first |
|---|---|---|
| 0.1 | **Run the extension in Chrome against a real inbox** | 323 tests, zero browser runtime. TODO item 1. The `inert` fix is unverified by a human. Everything below is speculative until this happens. |
| 0.2 | **C-3 remote images** | Live defect, every message |
| 0.3 | **C-4 inline `cid:` images** | Live defect, ~40 lines |
| 0.4 | **H-4 `?` overlay** | ~80 lines; unlocks 13 built features |
| 0.5 | **M-4 draft auto-save** | Silent data loss |

### Tier 1 — critical, blocks competitiveness
| # | Item | Cx |
|---|---|---|
| 1.1 | **C-2 Sent / Drafts / Spam / Trash / labels** — start with Sent+Drafts | Medium |
| 1.2 | **I-1 category mute + auto-archive** — cheapest differentiator | Low |
| 1.3 | **H-7 contact autocomplete** — index already exists | Low |
| 1.4 | **H-6 quoted original in replies** (correctness half only) | Low |
| 1.5 | **H-1 search: server fallback on miss** | Medium |

### Tier 2 — high impact
| # | Item | Note |
|---|---|---|
| 2.1 | **IndexedDB migration** | Unblocks 2.2, H-8, H-9. Do before threading. |
| 2.2 | **C-1 conversation threading** | Largest single item |
| 2.3 | **C-5 background sync** (+ `alarms` permission) | Enables 2.4, 2.5 |
| 2.4 | **H-2 undo send** | Needs 2.3's worker timer |
| 2.5 | **H-3 snooze** + I-4 radar integration | Needs 2.3 |
| 2.6 | **I-2 classifier-driven notifications** | Needs 2.3 |
| 2.7 | **H-5 settings schema** | Needs a home for the above |
| 2.8 | **M-2 hover quick-actions** | Strong ratio, independent |

### Tier 3 — medium
I-3 classifier corrections · M-1 context menu · M-6 recent searches ·
M-7 `OR` operator · M-9 importance display · unsubscribe detection ·
H-8 image preview · H-9 offline banner · avatars · F-3 iframe height (option b)

### Tier 4 — low
M-5 print · vacation responder · density toggle · PDF preview ·
M-10 multi-account (revisit later) · M-12 auto-load on scroll

### Explicitly rejected
Tabbed inbox · Smart Compose · read receipts · confidential mode ·
Meet/Chat integration · background-image themes · Gmail-style server filters ·
Gmail-style fixed pagination · Office attachment preview

---

## 11 · What I could not determine

Stated plainly, because an audit that hides its gaps is worthless.

- **Focus behaviour after archive/delete** — I read the action handler
  (`app.js:868-903`) but did not verify where focus lands. This is hidden
  behaviour #1 and the most likely silent keyboard regression. Needs a test.
- **Escape hierarchy** — four dismissable layers; no test asserts the order.
- **Shift-click anchoring** in `selection.js` — not verified against Gmail's
  anchor semantics.
- **Real rendering performance** — jsdom has no layout engine, so "60fps at
  2000 rows" remains an expectation, not a measurement. TODO 13.
- **Screen-reader behaviour** — 4 `aria-live` regions and 2 dialogs exist;
  none tested with NVDA/VoiceOver. Measured a11y ≠ actual a11y.
- **Classifier accuracy** — proven against the data pack, not against real
  mail. I-3 is the fix for this *and* the way to get the corpus.

---

## 12 · Closing judgement

The gap between this product and Gmail is **not craft**. On tokens, motion,
contrast, iconography, error copy, loading behaviour and undo, this codebase is
already better than Gmail, and the reasoning recorded in its comments is better
than most production code I have read.

The gap is **completeness and verification**. Five things — Sent/Drafts,
threading, working images, background sync, and one hour in an actual browser —
separate "an impressive prototype" from "the thing I use instead of Gmail."

And the winning move is not parity. It is I-1, I-2 and I-3: a mail client that
understands *what BITS mail is* can mute a category, notify on a deadline, and
learn from a correction. Gmail cannot do any of that, and no amount of Google
engineering will make it care about AUGSD.

Build the five. Then build the three Gmail can't.
