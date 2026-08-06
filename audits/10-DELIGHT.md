# 10 · Product delight audit

**Subject:** BITS Mail Manager at `07dba7d`.
**Question:** where is this product merely *functional* rather than
*satisfying*?
**Stance:** written as a user who already trusts the product and opens it forty
times a day. Correctness, performance and security are assumed handled — this
is about how it feels.

Every claim below is measured against the code. Where the product already gets
something right, I say so rather than inventing a problem.

---

## 0 · The overall feeling

This product is **quiet, fast and trustworthy, and slightly cold.**

It has genuinely excellent bones: a 68ch reading measure, a real type scale,
skeleton suppression on warm cache, six audited themes, and error messages that
tell you how to fix things. Those are the marks of someone with taste.

What it lacks is **the sense of a hand on the other side.** Actions complete
correctly but without acknowledgement. The single most repeated gesture in the
product — archiving a message — has no motion at all. The product's cleverest
feature, the deadline radar, sits in a box labelled "Due soon" and never once
tells you it did something smart for you.

The gap is not polish. It is **closure**: too many actions end rather than
finish.

---

## 1 · The findings, in order of felt impact

### D-1 · Archiving is the product's most frequent action and has no motion — **major, immediate**

**The moment.** You press `e`, or click Archive. The row disappears.

**Why it feels weak.** It does not disappear — it *ceases to exist*, mid-frame.
Measured: `node.remove()` at `app.js:497`, with **zero exit animations in the
entire stylesheet** (`grep -c "@keyframes.*(out|leave|exit)"` → 0).

The asymmetry is the tell. Rows animate *in* with a staggered 22ms cascade
(`.list-enter .row`, eight steps). Somebody cared about arrival and nobody
thought about departure. Triage is 90% departure.

**What is missing emotionally.** Confirmation that the thing you did *happened*
and *went somewhere*. Right now the list snaps closed and you are left checking
the toast to be sure. That check is a tiny tax paid dozens of times a day.

**How to improve it.** A ~140ms collapse: the row fades to 0 opacity, shifts
~8px in the direction it went (left for archive, which reads as "filed away"),
and its height collapses so the rows beneath glide up rather than jump. Use the
existing `--dur-fast` and `--ease-out`; add one `row-out` keyframe.

Critically: **the store mutation stays optimistic and instant.** Only the DOM
node lingers for the animation. Nothing gets slower.

**Why it would feel better.** Motion that follows the direction of the action
makes the action feel *performed* rather than *reported*. The rows gliding up
also preserves the user's sense of place in the list — currently the next
message teleports under the cursor.

**Reduced motion:** the existing universal `@media (prefers-reduced-motion)`
block already zeroes this. No extra work.

---

### D-2 · The toast is one flat channel for four different meanings — **moderate, immediate**

**The moment.** Every single piece of feedback the product gives you.

**Why it feels weak.** Measured: **21 distinct toast messages, one style.**
`#toast` is a single dark pill. "Message sent", "Could not archive",
"Auto-archived 4 messages" and "Archived · Ctrl+Z to undo" are visually
identical.

So the product's tone is uniform regardless of whether something succeeded,
failed, or is reversible. A failure gets the same gentle grey pill as a
success. That is not calm — it is *flat*, and it quietly teaches you to read
every toast carefully because you cannot tell at a glance which kind it is.

**What is missing.** Instant classification without reading. And for errors, a
touch of appropriate weight — an error that looks exactly like a success is a
small betrayal of trust.

**How to improve it.** Three variants sharing one shape:

- **success** — a subtle accent-tinted left edge, no extra colour elsewhere
- **error** — `--danger` left edge, and it stays ~4s instead of 2.2s, because
  you need longer to read a failure than a confirmation
- **undoable** — see D-3

Not four background colours. One 2px edge and a duration difference.

**Why it would feel better.** You would stop *reading* toasts and start
*glancing* at them. That is the difference between feedback that costs
attention and feedback that returns it.

---

### D-3 · Universal undo is the product's best idea and it is emotionally invisible — **major, immediate**

**The moment.** You archive, delete, snooze or bulk-action anything.

**Why it feels weak.** This product can undo **archive, delete, star, snooze
and bulk actions**, for five minutes, which is dramatically better than Gmail
(send only). The user is told via: `` `${label} · Ctrl+Z to undo` `` — text, in
the same flat pill as everything else, gone in 2.2 seconds.

The single best reason to prefer this product over Gmail is communicated as a
**suffix**.

**What is missing.** The feeling of safety. Right now the user only learns undo
exists if they read the toast; and having read it once, they get no ongoing
reassurance. The anxiety of "did I just delete the wrong thing?" is exactly
what this feature removes, and the UI does not cash that in.

**How to improve it.**

1. Give undoable toasts a real **Undo button**, not a keyboard hint. Clicking
   is what people reach for in the half-second after a mistake.
2. Hold undoable toasts slightly longer — ~3.5s, matching how long regret
   actually takes to arrive.
3. Add a thin progress line that drains as the toast expires, so the window is
   *visible* rather than guessed at.
4. The keyboard hint stays, secondary, for the people who want it.

**Why it would feel better.** It converts a feature people must be told about
into one they *feel*. The drain line is the key detail: it silently says "you
have time", which is the emotional content of undo.

**Note:** the 5-minute `UndoStack` TTL is far longer than the toast. Worth
saying so in the `?` overlay — "Ctrl+Z works for five minutes, not just while
the toast is up" is genuinely reassuring and currently a secret.

---

### D-4 · Clicks have almost no tactile response — **moderate, immediate**

**The moment.** Every button press, every star, every menu item.

**Why it feels weak.** Measured: **three `:active` rules in 2,700 lines of
CSS.** Hover states are well-developed (the star scales to 1.12, rows lift,
buttons shift border colour) — but the *press itself* does nothing almost
everywhere.

Hover says "this is clickable". Press should say "I got that". Without it,
every click feels like it went into a form rather than onto a control.

**How to improve it.** One rule, applied through the existing button classes:
`transform: scale(0.97)` on `:active`, at `--dur-instant` (90ms). For the star
specifically, a slightly springier response, since starring is the most
gratuitous action in the product and the one people do for pleasure.

**Why it would feel better.** Tactility is the cheapest possible upgrade to
perceived quality. It is why native apps feel different from web apps, and it
is one CSS rule.

---

### D-5 · Starring should be the most satisfying moment in the product — **moderate, immediate**

**The moment.** You press `s`, or click the star.

**Why it feels weak.** The star fades in and changes colour. That is all.
Starring is the one action with no consequence — nothing moves, nothing is
lost, it is purely an expression of intent. It should be the small pleasure of
the interface, and instead it is the same as marking read.

**How to improve it.** A ~180ms `--ease-spring` pop on the *filled* transition
only (scale 1 → 1.25 → 1). Not on unstar — removing a star should be quiet;
only the affirmative gesture gets the flourish.

**Why it would feel better.** Asymmetric feedback is what makes an interaction
feel *authored*. The product already owns `--ease-spring` and uses it
elsewhere; this is using the vocabulary it already has.

---

### D-6 · The deadline radar never says it was clever — **moderate, optional**

**The moment.** The radar shows "Due soon" with a list.

**Why it feels weak.** This is the product's single most differentiated
feature. It reads institutional mail, extracts a real date, and computes five
urgency bands (`overdue`, `today`, `soon`, `week`, `later`). Genuinely smart.

It is presented as a box titled **"Due soon"** — the same visual weight as any
other list. The intelligence is invisible; it looks like a filter.

**What is missing.** The small moment of "oh, it *noticed* that." Right now the
user has to work out that the app read their mail and understood a deadline.

**How to improve it.** Restrained, not gimmicky:

- When a deadline is extracted, the reader could show *where it came from* —
  the matched phrase, quietly, on the tag: "Due 14 Mar · from 'last date for
  submission'". That is the app showing its work, which builds trust rather
  than demanding it.
- The radar heading could carry the count and the nearest urgency: "Due soon ·
  1 overdue".

**Why it would feel better.** Explaining a smart inference converts "how did it
know that?" (uncanny) into "of course, it read the line" (trustworthy). It is
the difference between a magic trick and a good assistant.

**Optional**, because it is the one item here that adds text to the UI. It
should be tried and reverted if it reads as noisy.

---

### D-7 · Sending a message ends rather than completes — **moderate, immediate**

**The moment.** You press Ctrl+Enter. The panel closes. A grey pill says
"Message sent".

**Why it feels weak.** Sending is the highest-stakes action in a mail client —
it is irreversible and it is *seen by another person*. The product treats it
with exactly the same ceremony as marking something read.

**What is missing.** Completion. The compose panel vanishing is an *absence*,
not a resolution.

**How to improve it.** The panel should leave in the direction of "gone" —
a short slide-and-fade downward/outward over ~200ms rather than a
`hidden = true` snap — and the success toast should name the recipient:
"Sent to AUGSD". Naming the recipient is the reassurance that matters, because
the fear after sending is *who did that go to*.

**Why it would feel better.** It answers the actual post-send anxiety instead
of confirming a mechanical fact.

---

### D-8 · The sidebar count is now honest but not glanceable — **subtle, immediate**

**The moment.** Scanning the rail to decide where to go.

**Why it feels weak.** It currently reads `3/41`. That is accurate — and it was
a real fix — but a slash is a *reading* task, not a *scanning* one, and it is
repeated across 22 rail entries.

**How to improve it.** Keep both numbers, drop the punctuation: the unread
count in the accent colour with medium weight, the total immediately after in
`--fg-faint` at `--t-xs`. The eye then separates them by weight and colour
rather than by parsing a delimiter.

**Why it would feel better.** Twenty-two entries × every glance. Small per
instance, constant in aggregate — which is exactly the profile of a detail
worth getting right.

---

### D-9 · Background refresh is silent, so the app feels stale — **subtle, immediate**

**The moment.** You press `r`, or a refresh completes.

**Why it feels weak.** On success you get "Up to date" or "3 new messages".
Fine. But there is no ambient sense of *freshness* — nothing says when the app
last spoke to Gmail. A mail client that cannot tell you how current it is
quietly makes you doubt it.

**How to improve it.** A single line of `--fg-faint` text near the account:
"Updated 2 min ago", recomputed on render, not on a timer. When a refresh is
running, the existing topbar sweep already covers the motion — no new spinner
needed.

**Why it would feel better.** It removes a low-grade background doubt. This is
the anxiety-reduction category: nothing is *wrong* today, the user simply has
no way to know it is right.

---

### D-10 · Nothing marks the moment the inbox is finally clear — **subtle, optional**

**The moment.** You archive the last message.

**Why it feels weak.** The list empties and shows "You're all caught up ·
Nothing left in this view." Well written. But it appears identically whether
you cleared 40 messages through deliberate triage or opened a category that was
already empty.

**How to improve it.** Distinguish *achieved* empty from *always* empty. When
the list becomes empty as a result of the user's own last action, the empty
state fades in with the existing `empty-in` animation and reads slightly
differently — acknowledging the work rather than describing the state.

**Why it would feel better.** Triage is a chore. The one moment of satisfaction
it offers is finishing, and the product currently declines to notice.

**Restraint matters here.** No confetti, no illustration, no exclamation mark.
This product's voice is dry and that is an asset. One different sentence.

---

## 2 · What is already right — leave it alone

Saying this precisely, because these are the things a delight pass most often
ruins:

- **The empty states are genuinely well written.** "No matches — try fewer
  words, or a different filter" and "Trash is empty. Gmail deletes it
  permanently after 30 days" are useful, calm and specific. Do not make them
  cute.
- **Skeleton suppression on warm cache.** Refusing to replace real mail with
  grey bars is a better instinct than most shipping products have.
- **The reading measure.** 68ch at 15px/1.65 is the single biggest reason the
  reader feels premium. Touch nothing here.
- **The dry voice.** "A filter you cannot keep is a filter you use once."
  "Blocking by default is stronger than Gmail's proxy." This product sounds
  like a person who knows what they are doing. Any injected whimsy would break
  it.
- **The motion budget.** Three durations, two easings, nothing infinite while
  idle. Every recommendation above fits inside that budget deliberately — if
  one did not, it would be the wrong recommendation.

---

## 3 · Ranked recommendation

| # | Change | Size | When | Felt benefit |
|---|---|---|---|---|
| D-1 | Row exit animation | major | immediate | Triage stops feeling abrupt |
| D-3 | Undo button + drain line | major | immediate | The best feature becomes visible |
| D-2 | Toast variants | moderate | immediate | Glance instead of read |
| D-4 | `:active` press states | moderate | immediate | Everything feels tactile |
| D-5 | Star pop | moderate | immediate | One moment of pleasure |
| D-7 | Send completion + recipient | moderate | immediate | Answers the real anxiety |
| D-8 | Rail count typography | subtle | immediate | Scannable, 22× per glance |
| D-9 | "Updated N min ago" | subtle | immediate | Removes background doubt |
| D-6 | Radar shows its working | moderate | optional | Smart becomes trustworthy |
| D-10 | Achieved-empty state | subtle | optional | Notices the user finished |

**Start with D-1, D-3 and D-4.** They are the three highest-frequency moments
in the product — departing rows, reversible mistakes, and clicks — and together
they would change the felt character of the app more than the other seven
combined.

---

## 4 · The one-line summary

The product is well built and slightly withholding. It does the right thing and
then declines to acknowledge it. Almost everything above is about **closing the
loop on actions the product is already performing correctly** — which is why
none of it requires new features, and none of it costs performance.
