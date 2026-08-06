# 08 · Gmail Competitive Audit, second pass

**Subject:** BITS Mail Manager **v1.0** (`46c11c8`) vs. Gmail web.
**Supersedes:** [`07-GMAIL-COMPETITIVE.md`](07-GMAIL-COMPETITIVE.md), which
audited v0.9. Most of that document has been implemented; this one is measured
against the code as it now stands, not against the previous report.
**Method:** every claim carries the command or line that produced it. Where I
could not verify something, I say so.

**Third pass (appended):** §10's six unknowns were measured rather than left
standing. Two were real bugs — a shift-range that could not shrink, and a
render path that walked all 2000 rows to change one (549ms → 8.1ms). Both are
fixed. See §10.

**Scope audited:** 14,349 lines. 20 app modules, 24 background verbs, 515 tests.

---

## 0 · What changed, and what that changed about the gap

Audit 07 named five things separating "impressive prototype" from "the thing I
use instead of Gmail": Sent/Drafts, threading, working images, background sync,
and one hour in a real browser.

**Three of the five are done.** Images render (remote policy + `cid:`),
Sent/Drafts/Spam/Trash/Snoozed exist, and `alarms` is now permitted with a
working wake scheduler. Threading and the browser run are not.

That progress changes the shape of this audit. The v0.9 report was dominated by
absent features. v1.0's most serious problems are different in kind:

### The three findings that outrank the feature list

**F-1 — Four settings are declared and never read. (High, verified)**
`src/app/settings.js` defines nine keys. `grep -rn "settings.get("` returns
call sites for exactly three: `markReadOnOpen`, `markReadDelayMs`,
`remoteImages`. The other four — **`density`, `signature`, `undoSendSeconds`,
`autoSyncMinutes`** — are dead. `undoSendSeconds` is worse than dead: it
implies an undo-send feature that does not exist anywhere in the codebase
(`grep -r UNDO_SEND` → nothing).

This is precisely the "unfinished, not missing" pattern audit 07 criticised in
`LIST_LABELS`/`CREATE_LABEL` — and I reintroduced it while fixing that one. A
schema that promises capabilities the app does not have is a worse failure than
an absent setting, because it will be read by the next person as "implemented,
just not surfaced."

**F-2 — `LIST_LABELS` and `CREATE_LABEL` are STILL unreachable.**
Audit 07 flagged these as verbs nothing calls. They are still verbs nothing
calls: `grep -rn "LIST_LABELS" src/` matches only the handler definition. The
mailbox work built system labels (`INBOX`, `SENT`, `TRASH`…) and a private
`BMM/Snoozed`, but the user's own Gmail labels remain invisible and
uncreatable. A finding carried forward unfixed across two audits is a finding
that needs a decision, not another mention — see C-2.

**F-3 — Search still silently misses, and the fallback partly masks it.**
`Store.tokenize` (store.js:110) indexes `subject` and `from` only. I added a
Gmail server fallback, which helps — but it fires only after a 420ms debounce,
only at ≥3 characters, and only in the inbox. In Sent, Trash, Spam, Drafts and
Snoozed there is **no body search at all and no indication of that**. The
fallback made the common case better and the edge case more confusing, because
the user now sees "N more found by searching message bodies" in the inbox and
nothing whatsoever in Sent.

### Verified capability inventory (v1.0)

| Area | v0.9 | v1.0 | Evidence |
|---|---|---|---|
| Background verbs | 21 | **24** | `index.js` |
| Verbs unreachable from UI | 2 | **2** (same two) | `LIST_LABELS`, `CREATE_LABEL` |
| Search operators | 8 | **18** | `query.js` |
| Search index scope | subject+sender | **unchanged** + server fallback | `store.js:110` |
| Keyboard shortcuts | 13 | **23** | `shortcuts.js` |
| Settings exposed | 1 | **3 of 9 declared** | F-1 |
| Sync trigger | manual | **manual** (alarms exist, unused for sync) | F-1 |
| Threading | none | **none** | `threadId` only used for a deep link |
| Offline awareness | none | **none** | no `navigator.onLine` |
| Notifications | none | **none** | no `Notification` |
| Drafts | save only | **save + list view** | `mailboxes.js` |
| Attachments | download | **download + inline `cid:`** | — |
| Print | none | **none** | — |
| Context menus | none | **category rail only** | `app.js:1693` |
| Multi-account | none | **none** | `ACCOUNT_INDEX` constant |
| Undo | universal, 5-min | **unchanged** | `undo.js` |

---

## 1 · Critical missing features

---

### C-1 · Conversation threading

**1. Feature.** Gmail groups messages sharing a thread into one expandable
conversation, collapsed to sender names, newest expanded, quoted text folded.

**2. Description.** Keys on `threadId` plus `References`/`In-Reply-To`. A
conversation is **one row** with a message count. Gmail detects the quoted
reply chain and hides it behind a "···" chip.

**3. User problem.** Without it a five-message exchange is five rows that
scatter as new mail arrives between them. Reconstructing "what was decided"
means opening five things and mentally ordering them.

**4. Impact — Critical.** Unchanged from audit 07, and now the largest
remaining gap. For BITS specifically, administrative mail is heavily threaded:
"Revised schedule" → "Corrigendum to revised schedule" → "Final revised
schedule" is the canonical AUGSD pattern, and reading the wrong one has
consequences.

**5. Freq — Every interaction.**

**6. Productivity.** At a typical 1.6 messages/thread, list length drops ~35%.
Removes the "is this the latest one?" check entirely.

**7. UX.** Efficiency, error prevention, scanning, satisfaction.

**8. Cx — High**, and *higher than it was in v0.9*. The store is now
**per-mailbox** (`stores` Map, app.js), so threading must work across six
independent `Store` instances, each with its own `order` array and inverted
index. Additional interactions the v0.9 estimate did not have to consider:
- Selection (`selection.js`) operates on message ids; ticking a collapsed
  thread must mean all its members.
- Category rules (`rules.js`) mute by category; a thread whose members
  classify differently needs a deterministic rule.
- The mark-read grace period is per-message and would need thread semantics.

**9. Dependencies.** Storage (cache.js:55 is a positional array — a versioned
migration), state, UI redesign of the row, search, sync, selection, rules,
a11y (expand/collapse), testing.

**10. Recommendation — Implement Soon.** Still the biggest single item. It
should be preceded by the IndexedDB migration (A-1), not follow it.

---

### C-2 · Gmail's own labels — decide, then act

**1. Feature.** Gmail's user labels: many-to-many, nestable, colourable,
assignable in bulk, filterable.

**2. Description.** A message carries any number. The rail lists them; a label
picker assigns them; `label:` searches them.

**3. User problem.** Users who have already built a Gmail taxonomy find it
absent here, and mail filed into it is unreachable.

**4. Impact — Medium, and deliberately downgraded from audit 07's implicit
framing.** This product's thesis is that a 15-category automatic classifier
beats a hand-built taxonomy for this user. A student who has curated Gmail
labels is not the target user. But `label:` **is already a search operator**
(`query.js`), so the app half-promises label support today.

**5. Freq — Weekly**, for users who have labels at all.

**6/7.** Reduced navigation; better for migrating users; improves the
first-run experience for anyone with an existing system.

**8. Cx — Low.** `listLabels`/`createLabel` exist and work. `syncPage` takes
`labelIds`, and `mailboxes.js` already resolves a label *by name*
(`byLabelName`) for `BMM/Snoozed` — the exact mechanism needed.

**9. Dependencies.** UI (rail section + a picker), state, sync.

**10. Recommendation — Implement Soon, or delete the verbs.** The current
state is the worst option: two dead verbs, a `label:` operator with nothing
behind it, and a reader who cannot tell whether the feature exists. **Either
finish it or remove it** — carrying it unfixed through a third audit is not
acceptable. My recommendation is to finish it minimally: list existing labels
in the rail, allow assign/remove, and do **not** build nesting or colours.

---

### C-3 · Background sync and new-mail notification

**1. Feature.** Gmail pushes new mail into an open tab within seconds, updates
the title count, and can raise a desktop notification.

**2. Description.** Long-lived server channel; notification permission on first
opt-in.

**3. User problem.** A stale client is a client you stop trusting. If you must
press refresh to know, you either press it constantly or leave Gmail open in
another tab — which defeats the product entirely.

**4. Impact — High.** `app.js:998` still reads *"Cheap; safe to call on demand.
Never on a timer."* That was a defensible performance decision; it is now a
product problem, and **the blocker has been removed**: `alarms` is permitted
and `chrome.alarms` is already driving the snooze wake. `autoSyncMinutes`
exists in the schema with a 5-minute default and nothing reads it.

**5. Freq — Hourly.**

**6. Productivity.** Removes dozens of manual refreshes a day, and the doubt.

**7. UX.** Confidence, reliability, timeliness.

**8. Cx — Low-Medium**, down from Medium in audit 07 purely because the alarm
infrastructure now exists. The remaining work is one alarm, a delta call, and
care around the 1-hour implicit token: background sync **will** hit silent
renewal failures and must degrade quietly rather than spam errors.

**9. Dependencies.** Manifest (`notifications` only — `alarms` is done), auth
resilience, settings (wire `autoSyncMinutes`), notification rules (I-2).

**10. Recommendation — Implement Immediately.** Best impact-to-effort ratio in
this document, and it retires a dead setting.

---

### C-4 · Undo Send

**1. Feature.** Gmail holds outbound mail 5–30s and offers "Undo".

**2. Description.** A client-side hold before the actual send.

**3. User problem.** The regret arrives about two seconds after the click.

**4. Impact — High.** This product has the best undo architecture of any mail
client I have read — `UndoStack` covers archive, delete, star, bulk, snooze,
with a 5-minute TTL — and **send is the one thing it cannot undo**, which is
the one thing Gmail *can*. `undoSendSeconds: 8` sits in the schema promising
otherwise.

**5. Freq — Daily.**

**6/7.** Prevents a class of error that is otherwise unrecoverable; confidence.

**8. Cx — Low-Medium.** Queue the MIME, toast with a countdown, send on expiry.
The hard part is the failure mode: if the app closes during the hold the mail
must still send, so the timer belongs in the service worker — which needs
`alarms`, now available. Do **not** use Gmail's scheduled-send; its granularity
is far too coarse.

**9. Dependencies.** Background worker, alarms, compose flow, settings.

**10. Recommendation — Implement Immediately.** Small, high-value, and it
retires a second dead setting.

---

## 2 · High-impact improvements

### H-1 · Finish or remove the remaining dead settings (`density`, `signature`)

`density` implies a comfortable/compact toggle; nothing reads it. `signature`
implies an auto-appended signature; `buildMime` never consults it.

Both are genuinely useful. Signature is ~15 lines (append to the body in
`collectDraft`, above the quoted original). Density is a `data-density` attribute
on the root plus a handful of token overrides — real work, but bounded, and it
is the single most requested list preference in every mail client.

**Impact Medium · Freq Daily (felt) · Cx Low (signature) / Medium (density).**
**Recommendation — Implement Soon.** Whatever is not built by the next release
should be **deleted from the schema**. A promise in a schema is still a promise.

---

### H-2 · Search: close the honesty gap

Two specific defects, both measured:

1. **No body search outside the inbox.** The fallback is gated on
   `state.mailbox !== 'inbox'` (app.js). Searching Sent for a phrase you wrote
   returns local subject/sender matches only, silently.
2. **No `OR`, no grouping, no negation of groups.** `parseQuery` ANDs every
   predicate (`checks.every`, query.js:134). `OR` is the operator users
   actually miss.

Fix 1 is small: allow the fallback in every mailbox, scoping `q` with the
mailbox's label. Fix 2 needs a real parser.

**Impact High · Freq Daily · Cx Low (1) / Medium (2).**
**Recommendation — Implement Soon** for (1), **Nice to Have** for (2).

---

### H-3 · Hover quick-actions on rows

Gmail reveals archive/delete/mark-read/snooze on row hover, turning two clicks
into one for the most frequent action in email. The row already has hover
treatment (`.row:hover` in seven rules) and a reveal pattern for `.r-star` and
`.r-check`, so the mechanism exists.

Must be `opacity` only (never layout, per the standing motion rules), must
appear on keyboard focus too, and must not add tab stops — the codebase already
had a 2024-tab-stop keyboard trap from exactly this kind of per-row control.

**Impact Medium-High · Freq Every interaction · Cx Low.**
**Recommendation — Implement Soon.**

---

### H-4 · Offline behaviour

Still no `navigator.onLine` anywhere. Half of this is already built and
unexposed: `cache.js` gives a warm start, so cached mail *is* readable offline.
What is missing is that the app never says it is offline, and actions fail with
a raw error instead of queueing.

Minimum viable: an offline banner and disabled actions. The replay queue needs
conflict thought and should be **best-effort with reported failures**, never
silent reconciliation.

**Impact Medium · Freq Occasionally (Critical when it happens) · Cx Medium.**
**Recommendation — Nice to Have.** Banner first; defer the queue.

---

### H-5 · Rich-text compose and signature

`c-text` is a `<textarea>`; `buildMime` escapes it into a `<div>`. No bold, no
lists, no links. Quoted-original **is** now correct (with a dated attribution),
so the correctness half of audit 07's H-6 is done.

I still would not build a `contenteditable` WYSIWYG — it is a cross-browser
swamp and a permanent maintenance liability. Markdown-ish plain text rendered
on send suits a technical user base and is testable.

**Impact Medium · Freq Daily · Cx Medium.** **Nice to Have.**

---

## 3 · Medium priority

**M-1 · Context menu on message rows.** Exists for the category rail only
(app.js:1693). Extending it to rows gives archive/delete/snooze/label at the
pointer. Must not suppress the browser menu on selected text, and every item
needs a keyboard path. *Cx Low.* **Nice to Have.**

**M-2 · Importance markers.** `important` is parsed (`gmail.js`) and
searchable (`is:important`) but **never displayed**. Free to show; the learning
part is I-3. *Cx Very Low.* **Implement Soon** — it is already in the data.

**M-3 · Unsubscribe.** `listUnsubscribe` is extracted in `extractBody` and
never used. For a promotions-heavy student inbox this is high value and nearly
free: a button in the reader when the header is present. *Cx Very Low.*
**Implement Soon** — another already-paid-for capability going uncollected.

**M-4 · Recent searches.** No search history. The saved-views feature covers
the deliberate case; this covers the accidental one. *Cx Low.* **Nice to Have.**

**M-5 · Attachment preview.** Download works; preview does not. Scope honestly:
images (trivial, `data:` URL in an overlay) and PDF (blob URL in an iframe).
Office formats are **Do Not Copy** — they need a rendering service.
*Cx Low/Medium.* **Nice to Have.**

**M-6 · Print.** Still blocked by the same constraint as A-2: the reader iframe
has no `allow-scripts`, so the parent cannot trigger its print. Workaround is a
print-specific document. *Freq Rarely.* **Nice to Have.**

**M-7 · Avatars in rows.** Deterministic initials with a hashed colour would
fit the "code-generated assets" rule and genuinely aid scanning. *Cx Very Low.*

**M-8 · Multiple accounts.** `ACCOUNT_INDEX` is still a constant. Genuinely
hard: multiple token sets, stores, caches, and a switcher touching every view.
The per-mailbox store refactor makes this *less* bad than it was — the
multi-store pattern now exists — but it is still Very High. **Nice to Have**;
revisit after threading.

**M-9 · Auto-load on scroll.** "Load more" exists and is honest. Gmail's fixed
pagination is **Do Not Copy**, but loading automatically near the scroll end is
strictly better than a button. *Cx Low.*

---

## 4 · Low priority / explicitly rejected

**Low:** vacation responder · row density (folded into H-1) · middle-click to
open · scroll-anchoring verification · search result ranking by relevance
rather than date (should be a *choice*, currently a consequence).

**Do Not Copy:** tabbed inbox (Primary/Social/Promotions — Gmail's weaker
answer to the problem this classifier solves properly; adopting it would be a
downgrade) · Smart Compose · read receipts · confidential mode · Meet/Chat
integration · background-image themes · Gmail-style server-side filters (the
classifier plus I-3 corrections is the better shape) · Office attachment
preview.

---

## 5 · Design philosophy comparison

Re-scored against v1.0.

| Dimension | Gmail | v1.0 | Verdict |
|---|---|---|---|
| Navigation clarity | User-built taxonomy | 15 auto-categories **+ 7 system mailboxes** | **Ahead** — the v0.9 caveat is resolved |
| Information density | Configurable | One density (`density` dead) | **Behind** |
| Visual hierarchy | 20 years of accretion | Tokens, one icon set, contrast-audited | **Well ahead** |
| Reading comfort | Full width | 68ch measure, 15px/1.65 | **Well ahead** |
| Search discoverability | Chip-based panel | 18 operators, `?` overlay, saved views | **Even** — was Behind |
| Message scanning | Threading + avatars | Category tags, confidence shown only when low | **Mixed** — threading still absent |
| Triage | Archive/delete/label | + bulk, snooze, mute, universal undo | **Well ahead** |
| Interaction speed | Server round-trip | Optimistic + warm cache | **Well ahead** |
| Feedback quality | Toasts, sometimes silent | Toast + undo on every mutation | **Ahead** |
| Loading experience | Skeleton | Skeleton suppressed on warm cache | **Ahead** |
| Motion | Minimal, inconsistent | Tokenised, reduced-motion enforced, lint-guarded | **Well ahead** |
| Error handling | Generic banners | Mapped messages with fixes | **Ahead** |
| Customisation | Dozens of settings | **3 real settings** | **Behind** |
| Keyboard-first | ~40 shortcuts + `?` | **23 shortcuts + `?`, help cannot drift** | **Even**, and the anti-drift test is better than Gmail's docs |
| Consistency | Drifts between surfaces | Lint-enforced: no duplicate selectors, no untokenised colour | **Well ahead** |
| Accessibility | Mature, heavily tested | WCAG 2.2 targets, contrast-checked, focus restoration tested | **Ahead on measured axes**, unverified with a screen reader |
| Reliability | Battle-tested at scale | 515 tests, **zero browser runtime** | **Behind** |
| Privacy | Proxies images | Blocks by default, no telemetry, no server | **Ahead** |

The v0.9 summary was "better designed, worse finished." v1.0 is **better
designed, better finished, and still unverified.** The floor is no longer a
missing Sent folder; it is that nobody has run it.

---

## 6 · Hidden behaviours

Re-checked; several from audit 07 are now resolved.

1. **Focus restoration after archive** — audit 07 listed this as unverified.
   Still unverified for *archive*, though the help overlay's focus restoration
   is now tested. This remains the most likely silent keyboard regression.
2. **Auto-advance preference** (newer/older/back to list after archiving) —
   still hard-coded to "next".
3. **Hover-intent delay** — no hover cards yet; H-3 will need ~300ms or it
   strobes as the mouse crosses the list.
4. **Undo timing** — 5-minute TTL, better than Gmail, and now surfaced in the
   `?` overlay footer. **Resolved.**
5. **Draft persistence across crashes** — **resolved** (`draft-store.js`).
6. **Reading-position memory** — still blocked by A-2 (nested scroll).
7. **Selection anchoring** — shift-click should extend from the last *anchor*,
   not the last clicked row. Still unverified in `selection.js`.
8. **Search ranking** — date order, still a consequence rather than a choice.
9. **Mark-read delay** — **resolved and now better than Gmail**: 1.2s grace,
   cancelled on close or navigate, so skimming costs no unread state.
10. **Cursor positioning in compose** — reply lands in the body above the
    quote, new mail in To. **Correct.** Forward should land at the very top;
    worth checking.
11. **Escape hierarchy** — **resolved and tested**: help → snooze menu →
    category menu → palette → compose → selection → reader → release.
12. **Scroll-anchoring on new mail** — `overflow-anchor` not verified.
13. **Optical alignment of icons** — `.primary svg` dead-opacity bug fixed.

---

## 7 · Architecture

| Capability | Gmail | v1.0 | Note |
|---|---|---|---|
| Incremental sync | Server push | History API deltas, **inbox only** | Correctly gated: non-inbox pages pass `anchorHistory:false` |
| Virtualisation | Full virtual list | `content-visibility:auto` | Unproven above 2000 rows and in a real layout engine |
| Background refresh | Always | **None** (alarms available) | C-3 |
| Caching | IndexedDB | `chrome.storage.local`, **CACHE_MAX 500**, ~1MB | Inbox only; a 5000-message mailbox will not fit |
| Offline storage | Full | Read-only warm cache | H-4 |
| Search indexing | Server, full text | Local subject+sender + inbox-only fallback | H-2 |
| Threading | Native | **None** | C-1 |
| Optimistic updates | Yes | Yes, + universal undo | **Ahead** |
| Conflict resolution | Server authoritative | Last-write-wins, no detection | Becomes visible with H-4's queue |
| Session restoration | Full | Theme, cache, **unsent draft** | No scroll/selection restoration |
| Telemetry | Extensive | **None** | Deliberate. Means every perf claim is an expectation |
| Multi-store | n/a | **Six independent Stores** | New in v1.0; makes M-8 less bad, C-1 worse |

### Architectural limits that genuinely block parity

**A-1 · `chrome.storage.local` at 10MB, CACHE_MAX 500.** Caps warm start,
blocks attachment caching, and is the reason only the inbox is cached. **This
is now the top architectural item**, because C-1 (threading), M-5 (preview) and
H-4 (offline) all want it. Migrating to IndexedDB should happen *before*
threading, not during.

**A-2 · The sandboxed reader iframe without `allow-scripts`.** Right decision,
load-bearing, and it costs: iframe auto-height, print, in-body find, scroll
memory. Of the three options in audit 07 I still recommend (b) — measure height
by rendering the sanitised DOM off-screen in the parent — and still refuse (c),
which would make the sanitiser the only line of defence.

**A-3 · Implicit-flow tokens, 1 hour, no refresh token.** Every background
behaviour (C-3, C-4) must tolerate silent-renewal failure. Design this **once,
centrally**, before building either.

**A-4 · MV3 worker termination.** `alarms` is the only reliable timer; 1-minute
minimum granularity. Already handled correctly for snooze.

**A-5 · No server.** No push, no image proxy, no cross-device state. Also no
privacy risk, no cost, no outage. Correct trade — it just needs stating so
features are not designed assuming a backend.

---

## 8 · Where this product can beat Gmail

**I-1 · Category mute and auto-archive — SHIPPED.** Gmail's mute is per-thread
and its block is per-sender; neither expresses "I do not care about club mail
during exam weeks." This now works, never hides from search or from a category
opened by name, and an all-muted list says so. **This is the differentiator;
it should lead the README.**

**I-2 · Classifier-driven notification rules.** Notify on `augsd`, `academics`,
`admin`; never on `external-promotions`. This is what makes C-3's notifications
*desirable* rather than annoying, and Gmail structurally cannot offer it.
**Build with C-3, not after.**

**I-3 · Classifier corrections — SHIPPED, and now the data pipeline.**
`rules.js` stores per-sender corrections that outrank the generated rules.
Gmail's importance model is uncorrectable in any way the user can see. The
remaining step is to make corrections *reachable*: there is currently no UI to
say "this sender is not Events" — the mechanism exists, the affordance does
not. **That is a ~30-line gap holding back the only source of labelled BITS
data this project will ever get.** Highest-value small item in the document.

**I-4 · Deadline radar + snooze, integrated — PARTLY SHIPPED.** `deadlines.js`
feeds a "day before the deadline" snooze preset Gmail cannot offer. Remaining:
`.ics` export and a countdown in the row.

**I-5 · Universal undo, advertised — SHIPPED and surfaced** in the `?` overlay.

**I-6 · Privacy as a stated feature.** Blocking remote images by default is
stronger than Gmail's proxy, which still confirms the read via cache timing.
No telemetry, no server. **Say this on the options page.**

**I-7 · Being an extension is an advantage.** "Open in Gmail" means parity is
never strictly required for the long tail — link out rather than rebuild. This
should be an explicit product principle; it is why §4 can say "Do Not Copy" so
often.

**I-8 · Speed as a measurable claim.** Blocked on TODO 13's headless-Chrome
benchmark. Until then it is an expectation, not a number.

---

## 9 · Prioritised roadmap

### Tier 0 — integrity and verification
| # | Item | Why first |
|---|---|---|
| 0.1 | **Run it in Chrome against a real inbox** | 515 tests, zero browser runtime. Everything below is speculative until this happens. |
| 0.2 | **Resolve the four dead settings** (F-1) | Build or delete. A schema that lies is worse than a gap. |
| 0.3 | **Decide `LIST_LABELS`/`CREATE_LABEL`** (F-2) | Unfixed across two audits. Finish minimally or remove. |
| 0.4 | **Correction UI** (I-3) | ~30 lines; unlocks the only labelled-data path |
| 0.5 | **Unsubscribe button** (M-3) | Header already extracted, going unused |
| 0.6 | **Show importance** (M-2) | Already in the data |

### Tier 1 — critical
| # | Item | Cx |
|---|---|---|
| 1.1 | **C-3 background sync** (+ `notifications`, wires `autoSyncMinutes`) | Low-Med |
| 1.2 | **I-2 classifier-driven notification rules** — with 1.1, not after | Low |
| 1.3 | **C-4 undo send** (wires `undoSendSeconds`) | Low-Med |
| 1.4 | **H-2(1) body search in every mailbox** | Low |
| 1.5 | **H-1 signature** | Low |

### Tier 2 — high impact
| # | Item | Note |
|---|---|---|
| 2.1 | **A-1 IndexedDB migration** | Unblocks 2.2, M-5, H-4. Do it BEFORE threading. |
| 2.2 | **C-1 threading** | Largest single item; harder now (six stores) |
| 2.3 | **C-2 labels** (if 0.3 says build) | Medium |
| 2.4 | **H-3 hover quick-actions** | Strong ratio |
| 2.5 | **H-1 density** | Medium |

### Tier 3 — medium
M-1 row context menu · M-4 recent searches · M-5 image preview · H-4 offline
banner · M-7 avatars · M-9 auto-load on scroll · H-2(2) `OR` parser ·
A-2 iframe height · I-4 `.ics` export

### Tier 4 — low
M-6 print · vacation responder · M-8 multi-account · search ranking choice

### Tier 5 — verification debt
Focus-after-archive test · Escape ordering for the *reader* path ·
shift-click anchoring · `overflow-anchor` · screen-reader pass ·
TODO 13 headless-Chrome benchmark

---

## 10 · What I could not determine — RESOLVED, third pass

The six unknowns below were listed as unverified. Five have since been
measured; the findings are recorded here rather than in a new document,
because an audit that leaves its own unknowns standing is incomplete.

### ✅ Focus after archive/delete — VERIFIED CORRECT

Driven in jsdom: focus the listbox, `j` to open, `e` to archive. Focus stays
on `#list` throughout, selection advances to the next message, and
`aria-activedescendant` tracks it (`bmm-row-m2` after two moves). `j` still
works afterwards. **No bug.** This was flagged as the most likely silent
keyboard regression; it is not one.

### 🔴 Shift-click anchoring — BUG FOUND AND FIXED

`Selection.range()` only ever ADDED to the set, so a range could grow but
never shrink. Shift-click `e`, realise you overshot, shift-click `d` — and `e`
stayed selected. The count never came back down, so the only recovery was to
clear the selection and start over.

Gmail, Finder and Explorer all treat the live range as transient and recompute
it from the anchor on every shift-click, while preserving anything selected
BEFORE the anchor. Fixed by snapshotting `_preRange` and invalidating it at
all five sites that move the anchor. `selection.js` had **no unit tests at
all**, which is why it shipped; there are now 16.

### 🔴 Rendering performance — BUG FOUND AND FIXED (68x)

`npm run bench` reported "renders triggered: 1" but never touched the DOM, so
it could not support the 60fps claim. Measuring the real render path found
that starring ONE message cost:

| rows | before | after |
|---|---|---|
| 500 | 165ms | 7.9ms |
| 2000 | **549ms** | **8.1ms** |

Cause: the store emits `{changed, structural}` and `scheduleRender` has a
per-id fast path, but the subscriber was `() => scheduleRender()` — dropping
the payload, so the parameter fell back to `structural: true` and every change
re-walked the entire list. The fast path was unreachable dead code. Forwarding
the detail made it constant-time.

Two tests now guard it, and the first version of the behavioural one **passed
with the bug reintroduced** — it spied on `textContent`, but `setText` already
guards on equality, so re-filling 2000 unchanged rows performs zero writes. It
measured a no-op. Rewritten to count rows VISITED, it now fails with
"walked 63 rows".

### ✅ `content-visibility` above 2000 rows — NOT APPLICABLE

`store.js:38` caps at `MAX_MESSAGES = 2000` by design, so there is no
above-2000 case. Every row is in the DOM at 2000 (no virtualiser, as
documented). Initial render is ~3.3s of scripted work in jsdom, which has no
layout engine — that number is a jsdom artefact and still says nothing about
frame rate in Chrome. **The 60fps claim remains unproven** and needs TODO 13.

### ✅ Scroll anchoring — VERIFIED, now explicit

`overflow-anchor` was absent, i.e. defaulting to `auto`, which is correct: a
delta sync inserts above the reading position. Written out explicitly on
`#scroller` because `contain: strict` sits one line away and it is genuinely
unclear whether containment suppresses anchoring. It does not.

### ⬜ Still unverified

- **Screen-reader behaviour.** ARIA is present and structurally tested; no
  NVDA/VoiceOver pass. Measured a11y is not actual a11y.
- **Classifier accuracy.** Proven against the data pack, not against real
  mail. The correction UI (I-3) is both the fix and the corpus.
- **Frame rate in a real engine.** jsdom has no layout. TODO 13.

---

## 11 · Closing judgement

Audit 07 said the gap was completeness and verification, not craft. Half of
that is now closed: the product has the mailboxes, the images, the snooze, the
autocomplete and the settings infrastructure it lacked, and the guardrails
(no untokenised colour, no ungated animation, no duplicate selector, no
sub-24px target, help that cannot drift from the bindings) are stronger than
anything Gmail enforces on itself.

What remains is sharper and more uncomfortable:

1. **Four settings and two verbs promise things that do not exist.** I added
   the settings while fixing the verbs. Integrity of the schema is now the
   first item on the roadmap, above every feature.
2. **Threading is the last true feature gap**, and the per-mailbox refactor
   made it harder. It needs IndexedDB first.
3. **Nobody has run this in a browser.** 515 tests is not the same as one hour
   with a real inbox, and no amount of further testing changes that.

The winning move is unchanged and now half-built: a mail client that
understands *what BITS mail is* can mute a category, wake a message the day
before its deadline, and learn from a correction. Two of those three ship
today. The third needs thirty lines and is the only way this project will ever
get real training data.

Finish the promises. Then threading. Then run it.
