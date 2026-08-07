# Audit 16 — Exhaustive Feature Discovery

**Mode:** discovery only. Nothing here is ranked, costed, or committed to.
Nothing here is rejected either — the elimination pass is a separate document.

**Product identity that every idea below must respect** (user's own words):

> *"a better Gmail that happens to understand student life, not a student
> platform with a mailbox bolted on."*

So the test applied to each idea was **"does a person who never opens the
timetable still get a better mail client?"** Academic intelligence is allowed
to be a multiplier on mail work; it is not allowed to become the product.

**What the product already has** (stated once, so the 100 entries below never
have to re-explain it):

- 27 background verbs incl. `SYNC_PAGE/SYNC_DELTA`, `GET_BODY`, `GET_INLINE`,
  `GET_ATTACHMENT`, `SEND`, `SAVE_DRAFT`, `GET_DRAFT`, `BULK`, `LIST_LABELS`,
  `CREATE_LABEL`, `SNOOZE/UNSNOOZE/WAKE_DUE`, `SPAM/NOT_SPAM`, `TRASH/UNTRASH`,
  `ARCHIVE/UNARCHIVE`, `STAR`, `MARK_READ/MARK_UNREAD`, `PROFILE`.
- A client-side store with a flat `order` and a threaded `rootIds()` from the
  same index; `MAX_MESSAGES = 2000` in memory.
- A parsed query language: `from: to: subject: label: category: has: is:
  before: after: deadline: due: overdue:` plus free text.
- A 15-category BITS classifier with a sender map, pattern rules and scoring,
  plus per-sender user corrections (`rules.js: correctSender`).
- A deadline extractor + a "due soon" radar rail (`RADAR_MAX = 6`).
- A parsed institutional timetable: 688 courses / 1681 sections / 119 change
  rows, and `timetable-mail.js` which already finds course numbers and section
  IDs inside message text.
- Snooze with presets, mute + auto-archive rules, saved views, a command
  palette, an undo stack with inverse-verb derivation, six themes, an in-page
  fallback for a dead service worker.
- Only **8** settings keys: `theme, remoteImages, markReadOnOpen, threaded,
  markReadDelayMs, autoRefreshMs, signature, clientId`.

**Format per idea:** what · problem · why possible here · where it lives ·
value · implementation direction · dependencies · tier
(**core** = the product feels incomplete without it · **important** = clear
daily win · **optional** = depth for the people who want depth).

---

## A · Labels, organisation and structure (1–12)

### 1 · Label write support (apply / remove from the list and reader)
**What:** a label picker on any message or selection that applies and removes
Gmail labels, with type-ahead over the labels already fetched by `LIST_LABELS`.
**Problem:** labels are currently read-only — `label:Thesis` searches, the
palette lists them, and nothing can change them. Every organising action has to
be done back in Gmail, which breaks the "never leave the takeover" promise.
**Why possible:** `LIST_LABELS` and `CREATE_LABEL` verbs already exist, and
`BULK` already sends positional `add`/`remove` arrays to `batchModify`.
**Where:** reader toolbar button, selection toolbar button, `L` shortcut, and a
palette command.
**Value:** closes the single biggest functional hole against Gmail.
**Implementation:** a new `label-picker.js` reusing the `menu.js` unified menu;
push `{add, remove}` through the existing `BULK_ACTIONS` shape so undo derives
the inverse for free.
**Depends on:** nothing new. **Tier: core.**

### 2 · Create-label inline from the picker
**What:** typing a label name that does not exist offers "Create *X* and apply".
**Problem:** users organise by inventing a category at the moment they need it;
forcing them to a settings page first means they don't do it.
**Why possible:** `CREATE_LABEL` verb exists and is currently unreachable from
the UI — dead capability.
**Where:** bottom row of the label picker.
**Value:** turns an implemented-but-unsurfaced verb into a feature.
**Implementation:** create → refresh label cache → apply in one optimistic step,
with rollback if create fails. **Depends on:** #1. **Tier: important.**

### 3 · Nested label tree in the sidebar
**What:** render Gmail's `Parent/Child` label names as an indentable tree under
a collapsible "Labels" section in the rail, with per-label unread counts.
**Problem:** the rail shows the 15 BITS categories but the user's own Gmail
labels are invisible, so their existing organisation is thrown away.
**Why possible:** label names come back from `LIST_LABELS`; the rail already
renders counted rows and already knows how to count via `store.idsFor`.
**Where:** sidebar rail, below categories.
**Value:** the extension stops feeling like it ignores years of existing setup.
**Implementation:** split names on `/`, build a tree, persist expanded state in
settings. **Depends on:** counting labels client-side. **Tier: important.**

### 4 · Colour chips for labels
**What:** each label gets its Gmail colour (or a deterministic hash colour) as a
small chip on the row and in the reader header.
**Problem:** label membership is currently invisible while scanning a list.
**Why possible:** the theme layer already exposes tokens and a contrast checker
(`npm run contrast`) that can force every chip to pass AA on all six themes.
**Where:** list row metadata line, reader header.
**Value:** scanning speed; label state visible without opening anything.
**Implementation:** map Gmail's colour to nearest AA-safe token per theme rather
than using the raw hex. **Depends on:** #1. **Tier: optional.**

### 5 · Pin to top
**What:** a per-message/thread "pin" that floats it above the list in every view
until unpinned, with a thin separator under the pinned block.
**Problem:** starring is overloaded — it means both "important" and "come back
to this" — and neither survives scrolling in a 44-conversation inbox.
**Why possible:** purely local; the store can carry a `pinned` set in storage
and the list sorter already handles a threaded/flat split.
**Where:** row hover action, `P` shortcut, reader toolbar.
**Value:** a real working set that does not pollute Gmail state.
**Implementation:** `pins.js` with a storage-backed Set of message IDs; sort key
prepended in the list builder. **Depends on:** none. **Tier: important.**

### 6 · Follow-up flag with a due date ("waiting on a reply")
**What:** mark a sent or received message as awaiting a response by date; it
appears in a "Waiting" view and escalates in the radar when the date passes with
no newer message in the thread.
**Problem:** the most common student mail failure is a mail to a professor that
silently never got answered.
**Why possible:** threading already exists, so "has anything newer arrived in
this thread" is a `rootIds()` lookup; the radar already renders dated urgency.
**Where:** reader toolbar, saved view, radar section.
**Value:** converts the mailbox into a lightweight accountability system.
**Implementation:** `followups.js` storing `{threadId, dueAt, note}`; radar reads
it alongside deadlines. **Depends on:** radar refactor to accept multiple
sources. **Tier: important.**

### 7 · Per-message private notes
**What:** a note pane attached to a message, stored locally, searchable via
`note:` and shown as a small marker on the row.
**Problem:** context around a mail ("prof said resubmit by Fri, verbally") has
nowhere to live and ends up in a separate notes app, unlinked.
**Why possible:** the reader is already a rendered panel with room for a
collapsible footer; storage is already schema-managed.
**Where:** reader footer, row badge, new query operator.
**Value:** the mailbox becomes the record of the conversation, not just its
transcript. **Implementation:** `notes.js` + `query.js` operator + index into
the search path. **Depends on:** query extension point. **Tier: optional.**

### 8 · Tags that are local-only (fast, no API round trip)
**What:** a second labelling system that never touches Gmail — instant, free,
arbitrary, and useful for ephemeral organising ("skim later", "for the group").
**Problem:** every Gmail label write is a network call, so labelling a burst of
mail is slow and failure-prone on campus wifi.
**Why possible:** the store is fully client-side and already persists.
**Where:** `#tag` syntax in the search bar; a tag row in the rail.
**Value:** zero-latency organisation; the fallback path keeps working offline.
**Implementation:** reuse the pins storage shape with a string key. **Depends
on:** none. **Tier: optional.**

### 9 · Smart grouping in the list (by sender, by course, by day)
**What:** a "Group by" control that inserts sticky section headers into the list
— by sender domain, by detected course code, by day, or by category.
**Problem:** 44 conversations of mixed provenance read as noise; grouping makes
the shape of the inbox legible at a glance.
**Why possible:** the list is already virtualised-ish and rendered from an ID
array; grouping is a partition of that array plus header rows.
**Where:** list header control, palette command, remembered per view.
**Value:** triage becomes "deal with all AUGSD mail", not "read 44 things".
**Implementation:** group function returns `[{header, ids}]`; renderer already
handles heterogeneous rows for date separators. **Depends on:** list renderer
seam. **Tier: important.**

### 10 · Sender-centric view ("everything from this person")
**What:** clicking an avatar or name opens a filtered stream for that sender
with their stats: first seen, volume, average reply latency, categories used.
**Problem:** relationships, not messages, are the unit students think in
("what's the Placement Unit been sending?").
**Why possible:** `contacts.js` already exists and the query language already
supports `from:`; this is a presentation of data already held.
**Where:** hover card → "See all", and a palette command.
**Value:** answers "did I miss anything from my instructor" in one click.
**Implementation:** a view preset over `parseQuery('from:x')` plus a header
strip of computed stats. **Depends on:** hover cards (#41). **Tier: important.**

### 11 · Thread timeline / relationship map
**What:** a compact vertical timeline in the reader showing every message in the
thread with date, direction, participants entering and leaving, and attachment
markers — clickable to jump.
**Problem:** long threads (mess committee, group projects) lose their shape; you
cannot tell who joined when or where the decision happened.
**Why possible:** threading is complete and documented in `docs/THREADING.md`;
all the data is in the store.
**Where:** collapsible left gutter of the reader.
**Value:** makes long threads navigable instead of scrollable.
**Implementation:** derive from `rootIds()` children; pure render.
**Depends on:** none. **Tier: optional.**

### 12 · Attachment-centric browser
**What:** a view that lists every attachment across the mailbox — filename,
type, size, sender, date, source message — filterable and sortable.
**Problem:** "where's that PDF of the exam schedule" is a search for a *file*,
and mail clients make you search for the *message* that carried it.
**Why possible:** attachment metadata arrives with message metadata during
`SYNC_PAGE`; the `GET_ATTACHMENT` verb already fetches bytes on demand.
**Where:** a rail entry "Files", plus `has:attachment` gaining a grid layout.
**Value:** a genuinely missing capability in Gmail's own UI.
**Implementation:** build an index at ingest; render a table view reusing list
row primitives. **Depends on:** attachment metadata retention. **Tier: important.**

---

## B · Composing, replying and sending (13–26)

### 13 · Undo send
**What:** a configurable 5/10/20/30s window after `SEND` during which the toast
offers "Undo", holding the message locally instead of dispatching.
**Problem:** the highest-regret action in mail has no recovery path here.
**Why possible:** the send path already goes through one verb and already shows
a toast; `undoSendSeconds` was *deliberately removed* from the settings schema
with a note saying it returns on the commit that implements the feature.
**Where:** compose send button → toast; settings.
**Value:** removes the fear that makes people re-read a mail four times.
**Implementation:** queue in the app layer (not the worker, which can be
evicted); flush on timer, on window close, and on manual "Send now".
**Depends on:** the send-queue (#14) is the honest version. **Tier: core.**

### 14 · Outbox / send queue with retry
**What:** messages that fail to send (offline, hostel wifi, token expiry) land
in a visible Outbox and retry with backoff instead of vanishing into an error
toast.
**Problem:** a failed send currently only exists as a transient toast; the
message is lost or the user does not realise it never left.
**Why possible:** drafts already persist via `draft-store.js` and `SAVE_DRAFT`;
an outbox is a draft with an intent flag and a retry policy.
**Where:** a rail entry that only appears when non-empty; a status chip.
**Value:** trust — sending stops being a coin flip on campus networks.
**Implementation:** `outbox.js`; `chrome.alarms` retry ticks in the worker with
an app-side fallback timer. **Depends on:** #13 shares the queue. **Tier: core.**

### 15 · Scheduled send
**What:** "Send at" with presets (tomorrow 8am, Monday 9am, after this class
ends) and a custom picker.
**Problem:** students write at 2am and know that a 2am mail to a professor reads
badly; also "send this right after the deadline passes".
**Why possible:** the outbox already holds messages with a dispatch time; the
timetable already knows when the next class ends, which makes the presets
*better than Gmail's*.
**Where:** split button beside Send; palette command.
**Value:** a Gmail-parity feature with a genuinely BITS-aware preset set.
**Implementation:** `dispatchAt` field on the outbox record; `WAKE_DUE`-style
alarm already proven by snooze. **Depends on:** #14. **Tier: important.**

### 16 · Templates / canned responses
**What:** named reusable bodies with placeholders (`{{name}}`, `{{course}}`,
`{{deadline}}`), insertable from compose or the palette.
**Problem:** students write the same four mails all semester: leave request,
extension request, mess rebate, recommendation-letter follow-up.
**Why possible:** compose is a first-class module; storage and the palette both
take arbitrary registered commands.
**Where:** compose toolbar, palette (`Insert template…`), options page editor.
**Value:** the single biggest time saver for repetitive institutional mail.
**Implementation:** `templates.js` with a small mustache-ish substitutor; ship a
starter set derived from BITS workflows. **Depends on:** none. **Tier: important.**

### 17 · Multiple signatures with per-recipient rules
**What:** more than one signature (formal for faculty, short for peers, club
role signature), auto-selected by recipient domain or category.
**Problem:** `signature` is a single string today; one tone does not fit both a
Dean and a project partner.
**Why possible:** settings already supports typed schema entries; the classifier
already knows sender/recipient provenance.
**Where:** settings; a signature switcher in compose.
**Value:** correctness of tone with no thought.
**Implementation:** array of `{name, body, match}`; compose picks the first
match. **Depends on:** settings schema extension. **Tier: optional.**

### 18 · Reply presets ("Acknowledged", "Will do by <date>", "Can't attend")
**What:** one-click short replies rendered as chips under the reader, sending a
polite two-line message.
**Problem:** a large fraction of institutional mail needs only an
acknowledgement, and opening a compose window for it is disproportionate.
**Why possible:** the reader already has a toolbar with shortcut hints; send is
one verb away.
**Where:** reader footer chips; number-key shortcuts.
**Value:** turns a 30-second task into a keystroke.
**Implementation:** template subset with `send immediately` semantics and a
mandatory undo-send window. **Depends on:** #13, #16. **Tier: important.**

### 19 · Inline quick reply in the reader
**What:** a `R`-focused single-field reply box docked at the bottom of the
reader, no modal, no overlay, Enter-to-send with modifier.
**Problem:** the compose overlay is heavyweight for a two-line answer and it
covers the message you are replying to.
**Why possible:** compose already exists as a module with a body editor; this is
a second, smaller mount point.
**Where:** reader footer.
**Value:** the biggest perceived-speed win in the whole reading flow.
**Implementation:** reuse compose's state machine with a `mode: 'inline'`
render. **Depends on:** compose refactor to separate state from chrome.
**Tier: important.**

### 20 · Send-later "nudge me if no reply"
**What:** when sending, optionally set "remind me in 3 days if nobody replies",
which creates a follow-up automatically.
**Problem:** the user has to remember to remember.
**Why possible:** #6 provides the mechanism; this is the entry point at the
moment of highest intent.
**Where:** a checkbox in compose.
**Value:** closes the loop on outbound mail without any manual bookkeeping.
**Implementation:** on send success, write a follow-up record keyed to the new
thread ID. **Depends on:** #6. **Tier: optional.**

### 21 · Recipient safety checks before send
**What:** warn on: empty subject, "attached" mentioned with no attachment, an
external domain in a thread that was internal, replying-all to 40 people, and a
recipient the user has never mailed before.
**Problem:** the reply-all catastrophe and the missing attachment are universal,
and on a campus list the blast radius is hundreds of people.
**Why possible:** `contacts.js` knows who has been mailed before; the compose
body and attachment list are both in hand at send time.
**Where:** an interstitial strip above the send button, not a modal.
**Value:** prevents the class of mistake that cannot be undone socially.
**Implementation:** a pure `checkCompose(draft, contacts)` returning warnings —
trivially unit-testable. **Depends on:** none. **Tier: important.**

### 22 · Rich-text composing (bold, lists, links)
**What:** minimal formatting in compose, producing clean HTML alongside a plain
text alternative part.
**Problem:** plain text is fine for peers, but applications, club announcements
and formal requests read as unpolished without structure.
**Why possible:** `src/background/mime.js` already builds multipart messages;
`sanitize.js` already exists for the reading side and can be reused on output.
**Where:** compose toolbar.
**Value:** removes a reason to switch back to Gmail.
**Implementation:** a constrained contenteditable with a whitelist serialiser —
never accept arbitrary pasted HTML. **Depends on:** mime multipart/alternative.
**Tier: important.**

### 23 · Paste-to-attach and drag-and-drop attachments
**What:** dropping files anywhere on compose, and pasting an image from the
clipboard, attaches them with an inline thumbnail.
**Problem:** the file picker is the slowest possible path for a screenshot,
which is what students actually attach most.
**Why possible:** `MAX_ATTACH_BYTES` handling and MIME assembly already exist.
**Where:** compose drop zone.
**Value:** removes friction from the most common attachment case.
**Implementation:** `paste`/`drop` handlers → the existing attachment pipeline;
show size against the 25MB cap live. **Depends on:** none. **Tier: important.**

### 24 · Large-attachment guard with a link-instead suggestion
**What:** when the total crosses the 25MB cap, explain it before the send fails
and offer to remove the largest item or paste a Drive link placeholder.
**Problem:** the cap currently surfaces as a failure at the worst moment.
**Why possible:** the cap constant is already known client-side.
**Where:** compose attachment strip.
**Value:** turns a hard error into a decision.
**Implementation:** live sum with a progress meter. **Depends on:** #23.
**Tier: optional.**

### 25 · Draft autosave indicator and recovery banner
**What:** a visible "Saved 12s ago" state, and on next launch, "You have 2
unsent drafts — resume?" with a preview.
**Problem:** `draft-store.js` persists drafts but the user has no signal that it
happened, so they don't trust closing the window.
**Why possible:** the persistence already exists; only the surfacing is missing.
**Where:** compose header; a boot banner.
**Value:** trust in an existing invisible feature — cheap and high value.
**Implementation:** timestamp on each save; a boot check against non-empty
drafts. **Depends on:** none. **Tier: important.**

### 26 · Composition from a selection ("mail these to someone")
**What:** with N messages selected, "Forward as digest" builds one message with
each subject, sender, date and a short excerpt, linked.
**Problem:** sharing a set of related mails means forwarding them one at a time.
**Why possible:** selection is a first-class module; the store has all metadata.
**Where:** selection toolbar; palette.
**Value:** a genuinely absent capability in Gmail.
**Implementation:** a render-to-text/HTML function over selected IDs feeding
compose. **Depends on:** #22 for the nice version. **Tier: optional.**

---

## C · Reading, triage and the list (27–42)

### 27 · Message preview pane modes (split / stacked / full / none)
**What:** a layout switch: vertical split, horizontal split, full-width reader,
or list-only with a modal reader.
**Problem:** one layout cannot serve a 13" laptop in a lecture hall and a
27" monitor in a hostel room.
**Why possible:** the shell is CSS-grid driven with a design-token system.
**Where:** a layout button in the list header; settings; palette.
**Value:** the product fits the screen the user actually has.
**Implementation:** grid template variants behind a settings enum; all six
themes already tested by the contrast tool. **Depends on:** none.
**Tier: important.**

### 28 · Density control (comfortable / cosy / compact)
**What:** three row heights, changing line count and padding, not just font size.
**Problem:** at 44 conversations, comfortable density means constant scrolling;
`density` was removed from the schema pending implementation.
**Why possible:** spacing is entirely token-driven (`--s-*`) with a 4px grid
guard test already in place.
**Where:** settings + palette.
**Value:** doubles the visible inbox for people who want it.
**Implementation:** a `data-density` attribute on the root remapping spacing
tokens. **Depends on:** none. **Tier: important.**

### 29 · Snippet preview line with sender-aware trimming
**What:** show the first meaningful line of the body on the row, stripped of
"Dear all", quoted text, disclaimers and unsubscribe boilerplate.
**Problem:** institutional mail begins with the same salutation, so a naive
snippet is worthless and consumes a row of screen.
**Why possible:** `sanitize.js` already strips content; the classifier already
recognises institutional senders and their boilerplate patterns.
**Where:** list row second line.
**Value:** decide without opening — the core triage win.
**Implementation:** a `snippet.js` with a rule list; unit test against real BITS
boilerplate. **Depends on:** body availability (snippets from sync metadata
first, upgraded when `GET_BODY` runs). **Tier: core.**

### 30 · Hover card for messages
**What:** hovering a row for ~500ms shows a floating card: full subject, first
~200 words, attachment names, thread size, detected deadline, category and
confidence.
**Problem:** opening a message costs a mark-read timer and a navigation; peeking
should be free.
**Why possible:** the layer/z-index system is formalised
(`--z-menu`, `--z-overlay`), and body text can be fetched lazily.
**Where:** list.
**Value:** dramatically faster scanning.
**Implementation:** shared popover primitive reused by #10 and #43.
**Depends on:** a popover primitive. **Tier: important.**

### 31 · Split inbox / triage lanes
**What:** the inbox renders as ordered lanes — "Needs reply", "Deadlines",
"FYI / announcements", "Newsletters" — each collapsible with a count.
**Problem:** a single flat list forces the user to re-derive priority every time
they look at it, even though the classifier already knows a lot.
**Why possible:** the classifier, deadline extractor and reply-detection
(a message addressed to you personally vs. a list) are all present.
**Where:** the default inbox view, toggleable.
**Value:** the single most visible "this is better than Gmail" moment.
**Implementation:** lane assignment function over classification + heuristics;
render via the grouping mechanism from #9. **Depends on:** #9. **Tier: core.**

### 32 · "Only addressed to me" filter
**What:** a toggle/operator that hides anything where the user is a bulk
recipient of a list rather than a named To/Cc.
**Problem:** campus mailing lists dominate volume and almost never need action.
**Why possible:** recipient headers are already synced; the check is local.
**Where:** a rail toggle and `is:direct` in the query language.
**Value:** collapses a 44-item inbox to the ~6 that concern you.
**Implementation:** compare the profile address against To/Cc; treat
`list-id`-bearing mail as broadcast. **Depends on:** header retention.
**Tier: core.**

### 33 · Bulk unsubscribe centre
**What:** a screen listing every sender that sets `List-Unsubscribe`, with
volume over the last 90 days and a one-click unsubscribe (mailto or URL) plus
auto-archive fallback.
**Problem:** promotional mail accumulates and unsubscribing one-by-one never
happens.
**Why possible:** `rules.js` already implements mute and auto-archive per
sender — this is a bulk UI over an existing rule engine plus a header read.
**Where:** a "Cleanup" screen reachable from the rail and palette.
**Value:** a visible, satisfying one-off inbox reduction.
**Implementation:** index `List-Unsubscribe` at ingest; for URL form open a tab,
for mailto form send via the outbox. **Depends on:** header retention.
**Tier: important.**

### 34 · Sender volume analytics / "inbox audit"
**What:** a small dashboard: top senders, volume by category over time, unread
age distribution, average time-to-archive, busiest hours.
**Problem:** the user has no idea where their mail load actually comes from, so
they can't fix it.
**Why possible:** up to 2000 messages are already in a local store with dates,
senders and categories — this is presentation, not new data.
**Where:** a "Stats" screen.
**Value:** actionable — it feeds directly into #33 and the rule engine.
**Implementation:** aggregate functions + code-generated SVG charts (the project
prefers deterministic assets over libraries). **Depends on:** none.
**Tier: optional.**

### 35 · Read/unread age escalation ("aging" indicators)
**What:** unread messages older than N days get a subtle escalating marker;
a rail chip counts "unread > 7 days".
**Problem:** old unread mail becomes invisible; the count grows and stops
meaning anything.
**Why possible:** dates are in the store and the rail already renders counted
chips.
**Where:** list rows, rail.
**Value:** guilt with a target, instead of a meaningless 1,482.
**Implementation:** pure derived state on render. **Depends on:** none.
**Tier: optional.**

### 36 · Bulk actions by rule ("archive everything like this")
**What:** from any message, "Archive all 37 from this sender", "Archive all read
in this category older than 30 days", previewed with an exact count before
execution and undoable as one entry.
**Problem:** cleaning up requires selecting dozens of rows by hand.
**Why possible:** `BULK` + the `BULK_ACTIONS` inverse-deriving table means a
mass action is already undoable in one entry.
**Where:** row context menu; a Cleanup screen.
**Value:** minutes of work in one click, safely.
**Implementation:** build the ID set from a query, show a confirm with the
count, dispatch in `BATCH_SIZE` chunks. **Depends on:** chunked bulk progress.
**Tier: important.**

### 37 · Bulk action progress and cancellation
**What:** operating on 400 messages shows a determinate progress bar with a
Cancel that stops after the current chunk.
**Problem:** a large bulk operation currently looks frozen and cannot be stopped.
**Why possible:** `BATCH_SIZE = 100` already chunks the work; only the
per-chunk progress event is missing.
**Where:** the toast/status area.
**Value:** confidence to use bulk actions at all.
**Implementation:** worker posts progress messages back per chunk; the app
renders them. **Depends on:** a streaming message channel (port, not
one-shot sendMessage). **Tier: important.**

### 38 · Multi-select power gestures
**What:** shift-click ranges, `x` to toggle, `*a`/`*n`/`*r`/`*u`/`*s` selectors
(all/none/read/unread/starred), and "select all N matching this search, not just
the loaded page".
**Problem:** selection today is per-row; large operations are impractical.
**Why possible:** `selection.js` is a dedicated module and the query engine can
already produce the full matching ID set.
**Where:** list; a "Select all N" bar appears above the list.
**Value:** parity with Gmail's most-used power feature.
**Implementation:** extend selection with an anchor and a query-backed mode.
**Depends on:** none. **Tier: important.**

### 39 · Keyboard-driven row navigation with a persistent cursor
**What:** `j/k` move a visible cursor independent of selection and of the open
message; `o` opens, `Enter` opens, `x` selects, `[`/`]` archive-and-advance.
**Problem:** keyboard-first triage requires a cursor concept; without it, every
action needs the mouse to establish context.
**Why possible:** shortcuts are a dedicated module and the list is
ID-array-driven.
**Where:** list.
**Value:** the difference between "has shortcuts" and "is keyboard-first".
**Implementation:** cursor index in list state; ensure scroll-into-view and
`aria-activedescendant`. **Depends on:** list renderer seam. **Tier: core.**

### 40 · Action-and-advance semantics
**What:** archiving/deleting/snoozing from the reader immediately opens the next
message rather than returning to an empty reader.
**Problem:** the reader currently empties, forcing a return trip to the list for
every single item — the dominant cost in a triage session.
**Why possible:** the departing-row animation and 260ms settle are already
implemented and tested.
**Where:** reader; a setting for people who prefer returning to the list.
**Value:** turns triage into a rhythm.
**Implementation:** capture the next ID before the row leaves; guard against the
list re-sorting underneath. **Depends on:** #39. **Tier: core.**

### 41 · Contact hover card with avatars
**What:** hovering a sender shows avatar (Gravatar-style deterministic initials
disc), full address, department inferred from the domain/rules, last 3 messages,
and buttons: mail, see all, mute, correct category.
**Problem:** `first.last@pilani.bits-pilani.ac.in` tells you nothing at a glance.
**Why possible:** `contacts.js` exists; `icons.js` already generates
deterministic SVG.
**Where:** list rows, reader header, compose chips.
**Value:** identity resolution, the thing institutional mail is worst at.
**Implementation:** deterministic colour+initials avatars — no network, no
tracking. **Depends on:** popover primitive. **Tier: important.**

### 42 · Focus mode
**What:** a mode that hides the rail, radar and all counts, showing only the
current triage lane one message at a time.
**Problem:** the UI itself is a distraction during a deliberate clear-out.
**Why possible:** layout is token/grid driven and the layers module already
manages overlays.
**Where:** palette command; `Shift+F`.
**Value:** a calm mode for the 20-minute daily sweep.
**Implementation:** a root class plus a simplified render path.
**Depends on:** #40 for the flow. **Tier: optional.**

---

## D · Search, query and retrieval (43–54)

### 43 · Search suggestions and autocomplete in the query bar
**What:** as the user types, suggest operators, known senders, labels,
categories, course codes and recent queries, with keyboard selection.
**Problem:** the query language is powerful and undiscoverable; nobody types
`deadline:overdue` unless something tells them it exists.
**Why possible:** `autocomplete.js` already exists for compose recipients and
can be generalised; `parseQuery` knows every operator.
**Where:** under the search field.
**Value:** turns a hidden power feature into the default way to search.
**Implementation:** a suggestion provider per token type; reuse the palette's
list rendering. **Depends on:** none. **Tier: core.**

### 44 · Query history with re-run
**What:** the last ~50 searches, deduped, with timestamps, re-runnable from the
palette and promotable to a saved view in one click.
**Problem:** searches get re-typed constantly, and the good ones are the exact
ones that should have been saved.
**Why possible:** saved views already exist — history is the same store with an
eviction policy.
**Where:** dropdown on the empty search field; palette section.
**Value:** low cost, immediately useful, feeds saved views.
**Implementation:** ring buffer in storage; skip trivially short queries.
**Depends on:** none. **Tier: important.**

### 45 · Search inside the open message / thread
**What:** `Ctrl+F` scoped to the reader, highlighting matches across all
messages in the collapsed thread with next/prev.
**Problem:** the browser's find only sees rendered DOM, so it misses collapsed
thread parts and quoted blocks.
**Why possible:** the reader owns its own DOM and sanitised HTML.
**Where:** reader.
**Value:** essential in long institutional threads.
**Implementation:** expand-on-match plus a mark-and-scroll routine.
**Depends on:** threading render. **Tier: optional.**

### 46 · Full-text local search over synced bodies
**What:** an inverted index over the bodies already fetched, so body search is
instant and works offline, falling back to server search only for the tail.
**Problem:** `SERVER_SEARCH_MS = 420` debounce plus a network round trip is the
slow path for content already on the machine.
**Why possible:** `cache.js` already holds up to `CACHE_MAX = 500` bodies.
**Where:** transparent inside the existing search path.
**Value:** search that feels instant is a different product.
**Implementation:** a token→ID postings map, built incrementally, capped and
persisted; merge local hits ahead of server hits.
**Depends on:** cache retention policy. **Tier: important.**

### 47 · Search operator help sheet
**What:** a `?`-reachable panel listing every operator with a live example that
runs when clicked.
**Problem:** the query language is one of the product's best assets and is
entirely undocumented in-app.
**Why possible:** operators are enumerable from `query.js`; a test can assert
the sheet and the parser never drift apart.
**Where:** the existing `?` shortcuts overlay, second tab.
**Value:** discoverability at near-zero cost.
**Implementation:** generate the sheet from the parser's operator table.
**Depends on:** none. **Tier: important.**

### 48 · Negation, OR groups and parentheses in queries
**What:** `-from:x`, `a OR b`, `(x OR y) -label:z`.
**Problem:** the current grammar is implicit AND, which cannot express the most
common real filter ("everything academic except the timetable bot").
**Why possible:** `parseQuery` is a real parser module with its own tests.
**Where:** query language; suggestions from #43 teach it.
**Value:** unlocks rules and saved views that are currently impossible.
**Implementation:** shunting-yard over the existing tokens; keep the parsed AST
serialisable so saved views and rules can store it. **Depends on:** none.
**Tier: important.**

### 49 · Size, age and attachment-type operators
**What:** `larger:5M`, `older_than:30d`, `newer_than:2d`, `filename:*.pdf`,
`has:pdf`, `has:link`, `has:deadline`.
**Problem:** cleanup and retrieval both need these and neither is expressible.
**Why possible:** size and attachment metadata come down with message metadata.
**Where:** query language.
**Value:** makes the Cleanup screen (#33/#36) actually targetable.
**Depends on:** metadata retention. **Tier: important.**

### 50 · Saved view live badges and reordering
**What:** saved views get an unread badge, drag-to-reorder, an optional pin to
the top of the rail, and a keyboard shortcut assignment (`g` then a digit).
**Problem:** saved views exist but are inert in the rail; a view you cannot
reach in one keystroke is a bookmark.
**Why possible:** counts already recompute on settled store changes.
**Where:** rail.
**Value:** converts saved views into the primary navigation.
**Implementation:** order field in the view record; shortcut registry entry.
**Depends on:** saved-views store extension. **Tier: important.**

### 51 · Smart views shipped by default
**What:** a set of pre-built views the user can enable: "Needs reply", "Awaiting
me", "This week's deadlines", "From my instructors", "Big attachments",
"Unread > 7 days", "Auto-archived (audit me)".
**Problem:** an empty saved-views section teaches nothing; good defaults teach
the query language by example.
**Why possible:** each is one query in the existing grammar (some need #48/#49).
**Where:** rail, and a picker in options.
**Value:** immediate value on first run.
**Depends on:** #48, #49. **Tier: important.**

### 52 · Deep links into the app
**What:** URLs like `#/msg/<id>`, `#/q/<encoded query>`, `#/view/deadlines` that
restore state, are back/forward navigable, and can be pasted into notes.
**Problem:** state is entirely ephemeral; a reload loses the place and nothing
can be referenced from outside.
**Why possible:** the takeover owns a real page with a URL.
**Where:** router in the shell.
**Value:** enables notes (#7), bug reports, and cross-device sharing of a query.
**Implementation:** a hash router with a serialise/restore pair; also fixes
accidental-reload loss. **Depends on:** state extraction from `app.js`.
**Tier: important.**

### 53 · Recently viewed / back stack
**What:** an ordered list of the last 20 messages opened, reachable with
`Alt+←` and from the palette.
**Problem:** "the mail I read five minutes ago" is a search today.
**Why possible:** the reader already knows what it opened.
**Where:** palette section; a rail entry.
**Value:** removes a small friction that occurs many times an hour.
**Depends on:** none. **Tier: optional.**

### 54 · Search across drafts, outbox, snoozed and trash
**What:** `in:drafts`, `in:snoozed`, `in:outbox`, `in:trash`, `in:anywhere`,
with results tagged by their source lane.
**Problem:** search currently sees the mailbox, not the app's other stores, so a
snoozed message effectively disappears.
**Why possible:** each of those stores is local and enumerable.
**Where:** query language.
**Value:** "it's in here somewhere" always resolves.
**Depends on:** #14 for outbox. **Tier: important.**

---

## E · Academic intelligence — mail that understands BITS (55–72)

*Constraint honoured throughout: every item here is a **property of a message**
or an **overlay on mail work**. None of them asks the user to adopt a separate
student app.*

### 55 · Course chip on the message row
**What:** when `timetable-mail.js` finds a course number, the row shows a small
chip (`CS F111`) that is clickable to filter.
**Problem:** the detection already runs and the result is invisible in the list.
**Why possible:** `courseNumbersIn()` and `sectionsIn()` exist and are tested.
**Where:** list row; reader header.
**Value:** the flagship "this understands my life" moment, at low cost.
**Implementation:** cache detection results on ingest, render as a chip.
**Depends on:** none. **Tier: core.**

### 56 · Course context panel in the reader
**What:** a collapsible strip for a course-tagged message: full title, credits,
your section, instructor, room, next meeting, and links to other mail about the
same course.
**Problem:** a mail saying "L2 shifted to 6117" is meaningless without the
timetable open in another tab.
**Why possible:** 688 courses / 1681 sections are parsed and shipped as data.
**Where:** reader.
**Value:** answers the question the mail creates, in place.
**Depends on:** #55. **Tier: important.**

### 57 · Room-change and class-cancellation detection
**What:** parse "shifted to", "venue changed", "class cancelled", "extra class"
notices and surface them as a distinct, high-prominence card with the old and
new values, plus an "apply to my timetable" action.
**Problem:** these are the highest-urgency, lowest-volume mails on campus and
they look identical to everything else in a list.
**Why possible:** `matchNotice()` and 119 parsed change rows already exist;
`scanForUpdates()` is already the shape of this.
**Where:** a pinned card at the top of the inbox; the radar.
**Value:** the single most "Gmail could never" feature in the product.
**Implementation:** extend the notice matcher with a change-type taxonomy;
require an explicit confirm before mutating the personal timetable.
**Depends on:** #58. **Tier: core.**

### 58 · Personal timetable ("my sections")
**What:** the user picks their sections once; everything downstream —
detection, filtering, the day strip, conflict warnings — is scoped to *their*
courses rather than all 688.
**Problem:** without it, course intelligence is generic and mostly noise.
**Why possible:** the section data is complete and `timetable-store.js` already
persists user timetable state.
**Where:** the timetable screen (`T`); an onboarding step.
**Value:** the enabling primitive for a third of this section.
**Implementation:** store an array of section IDs; derive a meeting list.
**Depends on:** none. **Tier: core.**

### 59 · "Today" strip
**What:** a thin bar above the list showing today's classes with the current one
highlighted and a countdown to the next, collapsing to nothing on a free day.
**Problem:** the user checks mail between classes; the schedule is the context
they are already holding in their head.
**Why possible:** `#58` gives the meeting list; the rail already renders
compact rows.
**Where:** top of the list column, dismissible, off by default for non-students.
**Value:** high glanceability without changing what the product is.
**Depends on:** #58. **Tier: important.**

### 60 · Deadline extraction confidence and correction
**What:** each detected deadline shows its source phrase on hover, and lets the
user correct or dismiss it; corrections feed the extractor's rule set.
**Problem:** `extractDeadline` will be wrong sometimes, and a silently wrong
radar entry is worse than none — the user stops trusting the panel.
**Why possible:** `rules.js` already implements per-sender classifier
corrections; this is the same mechanism for a different extractor.
**Where:** radar entries and reader.
**Value:** trust, and a labelled corpus as a by-product.
**Depends on:** none. **Tier: core.**

### 61 · Manual deadline creation from any message
**What:** "Set deadline" on any message, with quick presets and a picker, even
when nothing was auto-detected.
**Problem:** the radar can only ever be as good as the extractor; a manual path
makes it complete.
**Why possible:** the radar reads a deadline list, not a parser.
**Where:** reader toolbar; row context menu; `D`.
**Value:** the mailbox becomes a reliable deadline system.
**Depends on:** radar multi-source refactor (#6 shares it). **Tier: important.**

### 62 · Deadline calendar view
**What:** a month/week grid of all detected and manual deadlines, colour-coded
by category, each cell linking back to its source message.
**Problem:** the radar shows 6 items in a linear list — no sense of clustering
or of a brutal week ahead.
**Why possible:** the data exists; rendering is a code-generated grid, matching
the project's preference for deterministic assets.
**Where:** a screen behind the radar's "See all".
**Value:** planning, not just reacting.
**Depends on:** #61. **Tier: optional.**

### 63 · Exam-mode awareness
**What:** when the parsed comprehensive/midsem window is near, the app surfaces
an exam panel: your papers, dates, times, venues from the timetable's exam
column, and it suppresses non-urgent categories from the inbox lane.
**Problem:** during exam weeks, the mail that matters is a tiny fraction and the
cost of missing it is maximal.
**Why possible:** the timetable rows carry exam slots (`02/12 AN` in the raw
data).
**Where:** an auto-appearing rail section; lane weighting.
**Value:** the product is most useful exactly when the user is most stressed.
**Depends on:** #58, #31. **Tier: important.**

### 64 · Instructor recognition
**What:** mail from an address that matches a parsed instructor name is badged
"Your instructor — CS F111 L1" and sorts into the priority lane.
**Problem:** a mail from `vinti@...` is anonymous unless you already know who
that is.
**Why possible:** 1681 sections carry instructor names; `contacts.js` holds
addresses; a fuzzy name↔address match with a user confirmation step is enough.
**Where:** row badge, hover card, lane assignment.
**Value:** never miss the one mail that actually affects your grade.
**Implementation:** propose matches, never assume — a wrong instructor badge is
worse than none. **Depends on:** #58, #41. **Tier: important.**

### 65 · Timetable conflict checker for event mail
**What:** when a message announces a dated, timed event, show inline whether it
clashes with a class ("Clashes with CS F111 L1, Wed 3").
**Problem:** deciding whether to attend a talk requires opening the timetable
and doing arithmetic.
**Why possible:** meeting times are structured; event time extraction is a small
extension of the deadline extractor.
**Where:** an inline chip in the reader.
**Value:** an instant answer to a question asked several times a week.
**Depends on:** #58. **Tier: optional.**

### 66 · Academic digest
**What:** a once-a-day generated summary card: new deadlines, changed classes,
unread instructor mail, tomorrow's schedule — built from local data only.
**Problem:** users who check mail once a day want a briefing, not archaeology.
**Why possible:** every input is already computed; this is composition.
**Where:** a card at the top of the inbox on first open of the day.
**Value:** the "why I open this instead of Gmail" moment.
**Depends on:** #57, #60, #58. **Tier: important.**

### 67 · Semester timeline / archive by term
**What:** group and search mail by academic term, with a term switcher; old
terms collapse into an archive.
**Problem:** semester boundaries are the natural unit of student memory and mail
clients only know dates.
**Why possible:** term boundaries are derivable from the timetable source.
**Where:** rail; `term:2025-1` operator.
**Value:** retrieval that matches how the user remembers.
**Depends on:** term metadata. **Tier: optional.**

### 68 · Category correction UI with live effect preview
**What:** "This isn't Administration" on any message opens a chooser that shows
how many other messages the correction would move.
**Problem:** the classifier's real-inbox accuracy is unvalidated and
`Naukri Campus Jobs → ADMINISTRATION` is already a known suspect; correction is
the only mechanism that builds a labelled corpus.
**Why possible:** `correctSender`/`applyCorrection` exist; only the surfacing
and the preview count are missing.
**Where:** reader header chip; row context menu.
**Value:** the classifier improves through use instead of through releases.
**Depends on:** none. **Tier: core.**

### 69 · Classifier explainability ("why this category")
**What:** a popover listing the signals that fired — sender-map hit, pattern
rule, keyword score — with weights.
**Problem:** an opaque wrong classification is un-actionable; the user cannot
tell whether to correct the sender or the rule.
**Why possible:** `scoring.js` computes exactly these terms and currently
discards them.
**Where:** the category chip's popover.
**Value:** trust, plus far better bug reports from the user.
**Implementation:** have the classifier return `{category, score, reasons[]}`.
**Depends on:** classifier return-shape change. **Tier: important.**

### 70 · Course-mail folders auto-derived
**What:** each course the user is enrolled in gets a rail entry aggregating all
mail mentioning it, without any Gmail label being written.
**Problem:** course mail is scattered across senders and categories.
**Why possible:** #55's detection plus #58's enrolment is exactly this query.
**Where:** rail, under a "My courses" section.
**Value:** the organisation students would build by hand, for free.
**Depends on:** #55, #58. **Tier: important.**

### 71 · Grade/result announcement detection
**What:** recognise result, grade-sheet and evaluation-uploaded notices and give
them a distinct badge and lane priority.
**Problem:** these are time-sensitive (re-eval windows are short) and easily
buried.
**Why possible:** they come from a small, stable set of senders with stable
phrasing — the classifier's strongest case.
**Where:** lane + badge.
**Value:** never miss a re-evaluation deadline.
**Depends on:** #31. **Tier: optional.**

### 72 · Placement / internship pipeline tracker
**What:** mail from the Placement Unit and company recruiters is threaded into a
per-company pipeline with stage detection (shortlist → test → interview →
result) and dates.
**Problem:** placement season generates dozens of mails per company and missing
one deadline is disqualifying; the screenshot already shows Placement Unit
notices going overdue.
**Why possible:** an `internship` category already exists; stage keywords are
stable; deadlines are already extracted.
**Where:** a rail section active during placement season.
**Value:** the highest-stakes mail workflow a BITS student has.
**Implementation:** company inferred from sender domain + subject; stage from a
keyword table; entirely local. **Depends on:** #61. **Tier: important.**

---

## F · Automation, rules and workflow acceleration (73–84)

### 73 · A real rule engine (if → then)
**What:** user-authored rules: conditions on sender / subject / category /
recipient / attachment / age, actions of archive, label, star, mute, pin, set
category, set deadline, mark read, forward.
**Problem:** `rules.js` today supports exactly two hardcoded behaviours — mute
and auto-archive — per sender. Everything else must be done by hand forever.
**Why possible:** the condition language is `parseQuery`'s AST and the action
set is `BULK_ACTIONS`; both already exist and are already undoable.
**Where:** an options-page editor, plus "create a rule from this message".
**Value:** the ceiling-raising feature for power users.
**Implementation:** evaluate rules at ingest; log every application so it is
auditable and reversible. **Depends on:** #48 for good conditions.
**Tier: important.**

### 74 · Rule dry-run and audit log
**What:** before saving, show exactly which of the last 2000 messages a rule
would have matched; after saving, keep a log of every message it touched with
one-click revert.
**Problem:** invisible automation that silently archives a mail from a Dean is
the fastest way to make a user uninstall.
**Why possible:** the whole corpus is local, so a dry run is instant.
**Where:** rule editor; a "Automation log" screen.
**Value:** makes automation safe enough to actually adopt.
**Depends on:** #73. **Tier: important.**

### 75 · "Create rule from this message" one-click
**What:** from any message, a pre-filled rule dialog with sensible guesses
(sender, or sender+subject-pattern) and the action the user just performed.
**Problem:** rules are written at the moment of annoyance, not in a settings
page later.
**Why possible:** the message and the last action are both in hand.
**Where:** row context menu; the undo toast ("Always do this?").
**Value:** the discovery path that makes #73 get used.
**Depends on:** #73. **Tier: important.**

### 76 · Right-click context menu on rows
**What:** a full context menu — open, open in new tab, archive, delete, spam,
snooze, label, pin, mute sender, create rule, copy link, copy address, view
original.
**Problem:** noted as missing; every action currently requires either hover
targets or memorised shortcuts.
**Why possible:** `menu.js` already unifies four menus with focus management.
**Where:** list rows, reader, sender chips.
**Value:** discoverability of everything else in this document.
**Depends on:** none. **Tier: core.**

### 77 · Palette actions that operate on the current selection
**What:** the palette becomes context-aware: with rows selected, it offers
bulk verbs; in the reader, message verbs; in compose, compose verbs — each
labelled with the count it will affect.
**Problem:** the palette is currently a fixed 11-command list, so it stops being
useful as soon as the app grows.
**Why possible:** the palette is a registry; commands can carry a predicate.
**Where:** palette.
**Value:** one keystroke reaches every capability in the product.
**Implementation:** command objects gain `when(ctx)` and `title(ctx)`.
**Depends on:** none. **Tier: core.**

### 78 · Recent actions / repeat last action
**What:** `.` repeats the last action on the current message or selection; the
palette lists recently used commands first.
**Problem:** triage is repetitive and every repetition currently costs the same
as the first.
**Why possible:** the undo stack already records action verbs and targets.
**Where:** global shortcut; palette ordering.
**Value:** compounding speed for heavy users.
**Depends on:** #77. **Tier: optional.**

### 79 · Custom keyboard shortcut remapping
**What:** an options screen to rebind any command, with conflict detection and a
printable cheat sheet.
**Problem:** muscle memory is personal, and users coming from Gmail/Superhuman/
mutt each want a different map.
**Why possible:** shortcuts are already a registry module and the `?` overlay
already renders from it.
**Where:** options.
**Value:** removes the relearning cost that makes people abandon a new client.
**Implementation:** a stored override map; validate against reserved browser
combos. **Depends on:** shortcuts registry refactor. **Tier: optional.**

### 80 · Workflow macros
**What:** record or compose a sequence ("label Placement + set deadline +
archive") and bind it to a key or palette entry.
**Problem:** some triage decisions are always three actions, never one.
**Why possible:** actions are already discrete verbs with derivable inverses, so
a macro is a list and its undo is the reversed list.
**Where:** palette; options editor.
**Value:** power-user depth with a coherent undo story.
**Depends on:** #77, #78. **Tier: optional.**

### 81 · Snooze upgrades: custom time, recurring, and "until next class"
**What:** an arbitrary date/time picker, weekday recurrence, and timetable-aware
presets ("after this lecture", "before the next lab").
**Problem:** presets are fixed and none of them know the user's day.
**Why possible:** snooze already has a preset table, a `WAKE_DUE` alarm and
`wakeLabel`; the timetable supplies the smart presets.
**Where:** snooze menu.
**Value:** the clearest example of academic data improving a *mail* feature.
**Depends on:** #58. **Tier: important.**

### 82 · Auto-triage suggestions ("clean this up?")
**What:** periodically the app notices patterns ("You archive 94% of mail from
X unread") and offers a one-click rule.
**Problem:** users never open the rules editor; the app should notice for them.
**Why possible:** the action history needed for the statistic is local.
**Where:** a dismissible card in the inbox.
**Value:** automation adoption without a configuration burden.
**Implementation:** require a high threshold and ≥10 observations before
suggesting; always show the evidence. **Depends on:** #73, #86. **Tier: optional.**

### 83 · Mute a thread (not just a sender)
**What:** future replies to a specific thread skip the inbox and are marked read.
**Problem:** `rules.js` mutes senders; the actual noise unit is usually one
runaway thread on a mailing list.
**Why possible:** threading is complete; the mute check just moves from sender
to thread root.
**Where:** reader toolbar; `m`.
**Value:** survives the 80-reply hostel thread.
**Depends on:** none. **Tier: important.**

### 84 · Auto-advance rules for the reader queue
**What:** a per-category default action offered at the reader footer ("Archive
newsletters when done"), applied on advance if the user opts in.
**Problem:** the same terminal action is taken for a whole class of mail.
**Why possible:** category is known and #40 supplies the advance moment.
**Where:** reader footer; options.
**Value:** removes one decision per message.
**Depends on:** #40, #73. **Tier: optional.**

---

## G · Trust, recovery, transparency and state (85–92)

### 85 · Multi-level undo history panel
**What:** a panel listing the last N actions with what/when/how many, each
individually revertable, not just the top of the stack.
**Problem:** `Ctrl+Z` reverses one action; a triage session produces dozens and
the mistake is usually three actions back.
**Why possible:** the undo stack already stores structured entries with derived
inverses, and `_resetUndo()` proves the module is state-clean.
**Where:** a panel behind the toast's "History" link; palette.
**Value:** confidence to move fast, which is the whole thesis of the product.
**Implementation:** render the stack; guard against reverting an entry whose
target has since changed. **Depends on:** none. **Tier: important.**

### 86 · Activity log
**What:** an append-only local log of every mutating action — verb, targets,
timestamp, result, whether a rule or the user did it — searchable and exportable.
**Problem:** when the mailbox differs from expectation, there is currently no
way to find out what happened. It also makes bug reports actionable.
**Why possible:** every mutation already funnels through a small verb set.
**Where:** a screen in options; feeds #82 and #74.
**Value:** debuggability for the user and the developer alike.
**Implementation:** ring buffer capped by count and bytes; never store bodies.
**Depends on:** none. **Tier: important.**

### 87 · Local export / backup
**What:** export the local state — settings, rules, saved views, notes, pins,
corrections, timetable selection, deadlines — as one JSON file, and import it
back with a diff preview.
**Problem:** everything the user teaches the app lives in one browser profile
and is one reinstall from gone.
**Why possible:** all of it is `chrome.storage.local` under a typed schema.
**Where:** options.
**Value:** makes it safe to invest effort in configuring the product.
**Implementation:** versioned envelope with a migration function.
**Depends on:** none. **Tier: important.**

### 88 · Message export (EML / PDF / clipboard)
**What:** save the raw RFC822 message, print a clean version to PDF, or copy a
formatted citation of the message.
**Problem:** proof matters — "I did submit by the deadline, here is the mail" —
and there is no export path today.
**Why possible:** the raw message is fetchable via the same API path
`GET_BODY` uses; print styling is a stylesheet.
**Where:** reader overflow menu.
**Value:** a real institutional need, and covers "view original" at once.
**Depends on:** a `GET_RAW` verb. **Tier: important.**

### 89 · Offline mode
**What:** an explicit offline state: read anything cached, queue every mutation,
show a clear banner, and reconcile on reconnect with conflict reporting.
**Problem:** campus wifi drops constantly; today a drop produces error toasts and
lost intent.
**Why possible:** the optimistic-update + rollback machinery and the fallback
banner pattern are both built and tested.
**Where:** global banner; the outbox.
**Value:** the app stops punishing a bad network.
**Implementation:** an action queue with idempotency keys; reconcile against the
next `SYNC_DELTA`. **Depends on:** #14, #86. **Tier: important.**

### 90 · Conflict visibility
**What:** when `SYNC_DELTA` reveals that a message changed elsewhere (read on
the phone, archived in Gmail) in a way that contradicts a local pending action,
say so rather than silently picking a winner.
**Problem:** silent divergence is how users lose faith in a client.
**Why possible:** delta sync already computes the difference.
**Where:** an inline row marker plus an entry in the activity log.
**Value:** honesty about a genuinely ambiguous situation.
**Depends on:** #89. **Tier: optional.**

### 91 · Session restore
**What:** on launch, restore the last view, scroll position, open message,
selection and search — plus a "resume where you left off" prompt after a crash.
**Problem:** an accidental reload currently costs the entire working context and
a full re-sync feel.
**Why possible:** #52's serialisable route is exactly this state.
**Where:** boot path.
**Value:** the app feels continuous rather than restarted.
**Depends on:** #52. **Tier: important.**

### 92 · Sync transparency panel
**What:** a small status surface: last sync time, messages held, cache size,
quota use against Gmail API limits, token expiry, and a manual "full resync".
**Problem:** when something looks stale the user has no way to tell whether the
app or the network is at fault — and this is exactly the class of confusion the
false "background service unavailable" banner caused.
**Why possible:** the worker already tracks all of it; `tools/doctor.mjs` proves
the diagnostic instinct is already in the project.
**Where:** click the status chip in the header.
**Value:** turns mysterious behaviour into a readable state.
**Depends on:** none. **Tier: important.**

---

## H · Notifications, presence and platform reach (93–100)

### 93 · Desktop notifications with actions
**What:** native notifications for mail matching a user-chosen filter (direct to
me, instructor, deadline detected, placement), with Archive / Snooze / Open
buttons on the notification itself.
**Problem:** listed as missing. Without it the extension only helps when it is
already open, which is the wrong half of the day.
**Why possible:** the worker already runs `SYNC_DELTA` on an alarm; only the
`notifications` permission and a filter are missing.
**Where:** worker; an options screen with a live-preview filter.
**Value:** the product becomes ambient rather than a destination.
**Implementation:** strict filter by default — never notify on everything, or it
gets muted within a day. **Depends on:** `notifications` permission (a new
consent prompt on update — worth flagging to the user). **Tier: important.**

### 94 · Quiet hours and class-aware notification suppression
**What:** notifications are suppressed during classes, exams and user-defined
quiet hours, and batched into a digest afterwards.
**Problem:** a buzz during a lecture is exactly why people disable notifications
permanently.
**Why possible:** the timetable knows when the user is in class; #58 scopes it.
**Where:** notification settings.
**Value:** the reason the notifications stay enabled.
**Depends on:** #93, #58. **Tier: important.**

### 95 · Toolbar badge and icon states
**What:** the extension icon shows a count of *actionable* mail (direct, or
deadline-bearing) rather than all unread, with a distinct state for
overdue deadlines.
**Problem:** the toolbar icon is currently inert; the browser tab is the only
signal and it is generic.
**Why possible:** `chrome.action.setBadgeText` needs no new permission and the
count is already computed for the rail.
**Where:** worker.
**Value:** persistent, zero-cost awareness.
**Implementation:** must respect the existing `chrome.action?.` optional
chaining used by the fallback path. **Depends on:** #32. **Tier: important.**

### 96 · Toolbar popup mini-inbox
**What:** clicking the icon opens a small popup: 5 most actionable messages,
today's next class, deadlines due today, and a "Open full app" button.
**Problem:** a quick check should not require taking over a tab.
**Why possible:** a `default_popup` was already built and reverted during the
service-worker saga, so the plumbing is known to work — and the app's rendering
primitives are reusable.
**Where:** `action.default_popup`.
**Value:** a second, lighter entry point to the same product.
**Depends on:** shared render primitives. **Tier: optional.**

### 97 · Onboarding and first-run tour
**What:** a short guided setup — client ID, sign-in, pick sections, choose
theme/density, three keyboard shortcuts to learn — with a skip and a resume.
**Problem:** the current first run demands a Google Cloud client ID with no
guidance, which is an extremely steep first step even for the author.
**Why possible:** options and the gate dialog already exist and the gate is
already a proper `role="dialog"`.
**Where:** first launch after install.
**Value:** the difference between a personal tool and something shareable.
**Depends on:** none. **Tier: core** (if the product is ever given to anyone
else).

### 98 · Multi-account support
**What:** more than one Gmail account, with a switcher, a per-account colour
accent, and an optional unified inbox.
**Problem:** listed as missing; students routinely carry a BITS account and a
personal one, and placement mail often lands on the personal one.
**Why possible:** auth, store and sync are separate layers; the store is keyed
per-message and could be namespaced per account.
**Where:** an account switcher in the header.
**Value:** removes the last reason to keep Gmail open in another tab.
**Implementation:** namespace storage and the token store by account ID; the
unified inbox is a merged read over two stores. **Depends on:** storage
namespacing — a large but structural change. **Tier: important.**

### 99 · Settings sync across devices
**What:** move preferences, rules, views and corrections to
`chrome.storage.sync` (with a local mirror and a size budget), so a second
machine inherits the configuration.
**Problem:** everything configured is per-profile today; a laptop and a lab PC
are two different products.
**Why possible:** settings already go through one typed schema with one
accessor — the exact precondition for switching the backing store.
**Where:** settings layer, invisible to users.
**Value:** the configuration investment travels.
**Implementation:** respect the 8KB-per-item / 100KB quota; keep bulky things
(activity log, cache, timetable data) local. **Depends on:** #87's versioned
envelope. **Tier: optional.**

### 100 · Print and share-friendly rendering
**What:** a print stylesheet for messages, threads, the timetable, and the
deadline calendar — clean typography, no chrome, working page breaks, URLs
expanded as footnotes.
**Problem:** students print or PDF timetables and official notices constantly,
and printing the takeover today produces the app UI.
**Why possible:** the design system is token-driven, so a print media query is
a token remap plus a few `display:none` rules; the contrast tooling already
verifies the monochrome-ish end of the range.
**Where:** `@media print` in `app.css`; a Print item in the reader menu.
**Value:** a small, concrete need that currently forces a trip back to Gmail.
**Depends on:** #88 shares the stylesheet. **Tier: optional.**

---

## Cross-cutting observations from the discovery pass

*Not features — patterns worth noting before the elimination pass.*

1. **Several verbs are implemented and unreachable.** `CREATE_LABEL`,
   `GET_DRAFT` and `UNTRASH` have no UI entry point. Cheapest wins in the
   document (#1, #2, #25).
2. **Three features want the same missing primitive: a popover.** Hover cards
   (#30), contact cards (#41) and classifier explainability (#69) should be one
   component, built once, layered with the existing `--z-*` scale.
3. **The radar wants to become multi-source.** Deadlines, follow-ups (#6),
   manual deadlines (#61), class changes (#57) and placement stages (#72) all
   want the same rail panel. Refactoring it to accept sources is a
   prerequisite hiding behind five features.
4. **`parseQuery`'s AST is the automation language.** Rules (#73), smart views
   (#51), bulk-by-rule (#36) and search-all-stores (#54) all become cheap once
   the parser emits a reusable, serialisable AST and gains negation/OR (#48).
5. **The undo table is the safety net for everything.** Because
   `BULK_ACTIONS` derives inverses, any new mutating feature that routes through
   it is undoable for free — and any that does not is a future bug of exactly
   the kind found in the last defect hunt.
6. **`markReadDelayMs`, `autoRefreshMs`, `remoteImages` prove the schema
   discipline works.** The three removed keys (`density`, `undoSendSeconds`,
   `autoSyncMinutes`) map to #28, #13 and #92 — the schema is already a small
   roadmap someone wrote and then honourably deleted.
7. **The identity guard held.** Of 100 ideas, 18 are academic (#55–#72) and
   every one is an overlay on a message, a rail panel, or a smarter preset for
   an existing mail action. None asks the user to adopt a student platform.
