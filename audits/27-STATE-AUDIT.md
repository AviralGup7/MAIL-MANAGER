# Audit 27 — Empty, Loading and Error States

Every state where the product is **not on the happy path**: waiting, empty,
offline, failing, recovering.

## Method

States were driven, not read. Each was reached by tracing the actual code path
a user reaches it through — which error branch catches it, what string lands on
screen, and for how long. Where a claim depended on a real value (what a
browser's offline `fetch` rejects with, which `reportError` branch a message
routes to), it was executed rather than assumed.

## The headline: this is the strongest area of the product

Twenty-six audits in, I expected non-happy paths to be where the cracks were.
They are not. Some measured examples:

**The empty state has six contextual branches**, each with its own copy and its
own recovery action:

| Condition | Says | Offers |
|---|---|---|
| Active search | *"Nothing matches "x". Try fewer words, or a different filter."* | Clear search |
| A category | *"No AUGSD mail — nothing has been filed here yet."* | Show all mail |
| **Hidden by a mute rule** | *"Everything here is muted — 12 messages hidden by your category rules."* | Show muted mail |
| Just cleared it | *"That was the last one. Your inbox is clear."* | — (nothing left to do) |
| Genuinely empty mailbox | *"Trash is empty"* + that mailbox's own copy | Refresh |
| Filtered to nothing | *"You're all caught up"* | — |

The mute branch is the one worth pointing at. Its comment reads: *"Saying
'you're all caught up' here would be a lie, and a mute that can make mail
vanish with no trace is exactly the kind of feature that loses people's
trust."* That is the standard this audit exists to check for, already met.

**Search states are complete**: a debounced *"Searching all mail…"*, then either
*"3 more found by searching message bodies in Gmail"* or *"No matches in your
mail."* — and a **stale-response guard** so an old query cannot flash over a
newer one. On failure it deliberately does *not* say "no results", because the
local results are still valid and still on screen.

**Quota and rate limiting are handled properly**: `RETRYABLE = {429, 500, 502,
503, 504}` with exponential backoff, and 403 deliberately excluded because
Gmail returns it for both `rateLimitExceeded` and genuine permission failures.
429 is explicitly treated as *not an error* — the comment records that a
previous version showed the user `Gmail 429 /messages` and stopped syncing.

**Auth failure is routed, not dumped**: `401`, `invalid_grant` and
`No refresh token` all produce *"Session expired. Sign in again."* on the gate,
not a toast.

So the findings below are narrow, and three of the four are the same gap.

---

## S-1 · Offline is not a state — it is an unstyled toast of browser jargon

**State.** Offline / network unreachable.
**Screen.** Everywhere: sync, send, open a message, search, refresh.

**Current behaviour.** Measured. `navigator.onLine` appears **zero times** in
the codebase, and there is no `online`/`offline` listener anywhere. So a
network failure falls to the final `else` in `reportError()`:

```js
} else {
  toast(msg.slice(0, 140));
}
```

`toast()` with no `kind` is `kind: 'info'`, which is **2200ms**. The message is
whatever the engine rejected with — traced across engines:

| Engine | User sees |
|---|---|
| Chrome | *"Failed to fetch"* |
| Firefox | *"NetworkError when attempting to fetch resource."* |
| Safari | *"Load failed"* |

**Why it feels incomplete.** Three separate failures in one:

1. **It is jargon.** "Failed to fetch" is a `fetch` implementation detail. It
   does not say the connection is down, and it does not say what still works.
2. **It is styled as information, not a problem.** An error toast gets 4000ms
   and error colouring; this gets neither, so a genuine failure is dressed as
   a status update.
3. **It is gone in 2.2 seconds.** Offline is not a momentary event — it lasts
   until the network returns. A transient toast is the wrong shape entirely.

The gap is sharper because **the correct pattern already exists in this
codebase**. `showWorkerWarning()` renders a persistent banner for degraded
mode, and its own comment explains exactly why: *"A persistent strip rather
than a toast: a toast is for something that just happened and then stops
mattering, and this condition lasts for the whole session."* Offline is that
condition, and it never got the treatment.

**Missing communication.** That the *connection* failed rather than the app;
that cached mail is still readable; that sends are queued, not lost.

**Missing UI.** A persistent banner, dismissed automatically on reconnect.

**Missing recovery path.** None needed — reconnection is automatic. But the
user must be told that, or they will retry manually and conclude the app is
broken.

**Suggested improvement.** Listen to `online`/`offline`, show the existing
banner idiom while offline, and translate network-shaped errors into one
sentence in the product's own voice. Crucially: **say what still works.** The
outbox already queues and retries sends; that is a promise worth making
explicit at the moment the user is worried.

**Priority: high.** **Systemic** — it affects every network-touching action.

---

## S-2 · A failed send is the one queued state with no visible home

**State.** Send failed and is waiting on backoff.
**Screen.** Outbox rail section.

**Current behaviour.** The outbox row shows `statusOf(item)` — *"Retrying in
15s (attempt 2 of 4)"* — which is good. But the **section only exists while
the queue is non-empty**, and the queue drains on success. So the sequence a
user experiences is: press Send → panel closes → toast → *silence*.

If the send is retrying, a rail section they were not looking at is counting
down. If it fails permanently, `isStuck()` turns the status red and offers
Retry/Discard — again, in a section they have no reason to be looking at.

**Why it feels incomplete.** The failure is *recorded* but not *announced*.
The user's model is "I sent it"; the app's model is "it is attempt 2 of 4".
Nothing bridges those.

**Missing communication.** A signal at the moment of failure, not only in the
place that tracks it.

**Missing UI.** None new — the activity log already records
`outcome: 'failed'`, and audit 20 specified a failure digest for exactly this.

**Suggested improvement.** When a queued send exhausts its retries, raise a
toast with `kind: 'error'` naming the recipient, with the outbox as its action.
One line at the moment it becomes final.

**Priority: medium.** **Isolated**, but it is the failure with the worst
consequence — a message the user believes they sent.

---

## S-3 · First launch shows the client-ID gate with no explanation of why

**State.** First run, no client ID configured.
**Screen.** The gate.

**Current behaviour.** `showGate(msg)` displays whatever error string arrived.
For a missing client ID that is a message mentioning "client ID" — accurate,
and meaningless to anyone who has not set up a Google Cloud project.

**Why it feels incomplete.** This is the **first screen a new user ever sees**,
and it asks for an OAuth client ID with no explanation of what one is, why the
app needs it, or where to get it. Every other empty state in this product
explains itself and offers a next action; this one states a precondition.

The build plan already flags this: *"demanding a Google Cloud client ID with no
guidance is a wall."*

**Missing communication.** Why the app needs it (it talks to *your* Gmail with
*your* credentials, and there is no server in between), and that this is a
one-time step.

**Missing UI.** A link to the options page, and a link to the Google Cloud
console.

**Missing recovery path.** There is no path at all — the user must already
know.

**Suggested improvement.** Not full onboarding, which the elimination audit
correctly deferred until someone other than the author installs this. One
sentence of context plus two links, in the gate's existing error slot.

**Priority: medium** — it is the first impression, but the current audience is
one person who already knows the answer. **Isolated.**

---

## S-4 · Partial sync is invisible

**State.** Some pages loaded, more available; or a delta sync that failed after
a page succeeded.
**Screen.** Message list.

**Current behaviour.** `#btn-more` ("Load more") exists, and the skeleton
covers the first load. But there is no indication that what is on screen is a
*subset*, and a mid-sync failure leaves the successfully-loaded pages in place
with only a transient toast.

**Why it feels incomplete.** The audit brief names this directly: *"avoid
pretending everything succeeded."* A list that stops at 100 messages looks
identical whether that is all the mail there is, or the point where a request
failed.

**Missing communication.** Whether the list is complete.

**Suggested improvement.** The sync transparency panel specified in audit 17
(#92) is the right home — last sync time, messages held, whether the last
attempt succeeded. This finding is really "that panel is still unbuilt", and
should be tracked there rather than solved twice.

**Priority: low-medium.** **Systemic**, but already specified elsewhere.

---

## Checked and found complete

| State | Finding |
|---|---|
| Inbox empty | ✅ six contextual branches, each with a recovery action |
| Empty per mailbox | ✅ Sent/Drafts/Trash/Spam each carry their own copy |
| Empty by mute rule | ✅ names the rule, offers the way out, refuses to lie |
| Triage finished | ✅ *"That was the last one"* — dry, no confetti, no action |
| No search results | ✅ quotes the query, suggests fewer words, clears the search |
| Search in progress | ✅ *"Searching all mail…"* with a stale-response guard |
| Search failed | ✅ deliberately does not report "no results" |
| Saved views empty | ✅ *"Save a search to keep it here."* |
| Palette no match | ✅ quotes the query, offers a search fallback |
| Rules empty | ✅ *"No rules yet."* |
| First load | ✅ 7-row skeleton, not a spinner |
| Message body loading | ✅ body-shaped placeholder reusing `sk-shimmer` |
| Busy / syncing | ✅ topbar sweep, `aria-busy`, Refresh disabled |
| Auth expired | ✅ routed to the gate with a plain-English sentence |
| Rate limited | ✅ 429/5xx retried with backoff; 429 not treated as an error |
| Worker dead | ✅ persistent banner, in-page fallback, honest about what is lost |
| Draft recovery | ✅ offered, never automatic — *"restore must ask"* |
| Blocked images | ✅ framed placeholder with alt text, not a 0×0 collapse |
| Bulk in flight | ✅ `aria-busy` for batches ≥10 |
| Destructive confirm | ✅ rule dry run runs before every save |

**On the identity rule:** the timetable's empty and loading states use the same
skeleton and copy conventions as the mail surfaces, and no academic state is
louder than its mail equivalent. No finding.

## Priority

| # | Finding | Scope | Priority |
|---|---|---|---|
| S-1 | Offline is jargon in a 2.2s info toast | systemic | **high** |
| S-2 | A permanently failed send is never announced | isolated | medium |
| S-3 | First-run gate explains nothing | isolated | medium |
| S-4 | Partial sync invisible | systemic | low-medium (tracked as #92) |

---

## Applied

Three of four. S-4 was deliberately **not** solved here — it is the sync
transparency panel already specified as #92 in audit 17, and solving it twice
would produce two surfaces answering the same question.

| # | Change |
|---|---|
| S-1 | `online`/`offline` listeners, a persistent `#net-warn` banner, and network-shaped errors routed into it instead of a raw toast |
| S-2 | A permanently-failed send raises one error toast naming the recipient, with the outbox as its action |
| S-3 | The gate explains *why* it wants a client ID — and only for that error |

**1276 tests pass. All six themes still meet WCAG AA.** Four state tests added,
all sabotage-verified.

### What the offline banner says is the whole point

Not *"you are offline"* — the user knows. It says:

> No connection — showing mail already downloaded. Anything you send is queued
> and goes out automatically when you are back.

Two facts they cannot otherwise know: **cached mail is still readable**, and
**sends are not lost**. On a campus network that drops several times an hour,
that is the difference between waiting and retrying by hand until they conclude
the app is broken.

It reuses `#sw-warn`'s rule rather than authoring a second banner, with one
declaration of difference: amber for the degraded worker, `--fg-faint` for
offline — because a temporary fact about the network is not a fault in the
product, and colouring it as a warning would overstate it.

**No dismiss button**, unlike the worker banner. That one describes something
the user can do nothing about and may last the session; this one clears itself
on reconnect, so a dismiss control would only let someone hide a fact that is
still true.

### Also fixed while there

`reportError`'s fallback `toast(msg)` had no `kind`, so **every unrecognised
error rendered as an info toast** — 2200ms, no error colouring. Now
`kind: 'error'`, which is 4000ms and styled as a problem. One word, and it
covers every failure the three named branches do not.

### Two probes disagreed and both were wrong

While verifying the shared banner rule I got contradictory readings: one python
regex reported the border landing inside a dark-theme selector, and jsdom
reported `--fg-dim` where the source says `--warning`. Reading the raw bytes
settled it — the CSS was correct all along.

jsdom does not resolve `var()` inside shorthand properties, so
`getComputedStyle(...).borderLeftColor` returns the element's `color` fallback
rather than the declared token. Worth recording: **this project's CSS probes
cannot be trusted for any shorthand containing a custom property**, which
affects `border`, `background`, `font` and `animation`. Longhand or source
inspection only.

### What this audit could not reach

Genuine offline behaviour — service-worker eviction under real memory
pressure, Chrome's actual `online` event timing, and whether a half-completed
sync leaves the store consistent. jsdom fires the events I dispatch and nothing
else. The banner and its wiring are verified; the underlying network
degradation is not, and would need the extension running.
