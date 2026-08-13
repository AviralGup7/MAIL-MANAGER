# The Soak — making "observed working" a ritual

Direction G1 (2026-08-14). Audit 64's cap on nearly every strong score was
the same clause: *implemented + unit-proven, never observed working*. The
M2 machinery (smoke gates, render bench, traces) instrumented the demo
corpus; the soak is the same honesty on a **live mailbox, a live Gmail
DOM, real hardware** — run as a ritual, with every finding coming home as
a commit or a pin.

**When:** once a week while the project is active, and before any release.
~20 minutes plus a passive week of having it installed.

---

## 0 · Pre-flight (2 min)

```sh
npm run doctor            # what Chrome validates, before Chrome does
node tools/ci-smoke.mjs   # 18 browser-truth gates on the demo corpus
```

Load the unpacked build in `chrome://extensions` (Developer mode). Watch
for `Service worker registration failed. Status code: 2` — the one
production failure this project has seen and never explained (audit 64
§12). If it appears: the probe branch `38b6a3a` exists for exactly this;
run it, capture what it prints, and give the mystery its verdict — merge
the fix or retire the branch, but stop carrying "unexplained".

## 1 · First boot on the live account (5 min)

- The OAuth consent screen reads as planned (scopes match the docs essay).
- The takeover mounts over the live Gmail page: handover animates once and
  stops; Gmail's root hides; no console errors in EITHER document.
- First sync lands; the list classifies. Open the background console once
  and confirm the multipart batch shape (2 round trips per 100).

## 2 · The quiet week (passive)

Leave it installed and actually read mail with it. What to notice:

- Deltas over days, especially after >7 idle days (the `historyId`
  cliff: resync, not lost mail).
- The 15-minute background sweep and its notification cards — sender
  truncated, subject intact, click-through opens the takeover.
- Snooze wake-ups arriving on time after a browser restart (the alarm is
  a nudge; the sweep is the guarantee).

**Storage reading, once mid-week** — from the app page's console:

```js
chrome.storage.local.getBytesInUse(null, console.log);       // quota spend
navigator.storage.estimate().then(e => console.table(e));    // origin total
```

Record the two numbers in the soak log below. The body floor (M1) charters
2MB beside the header cache's 1MB against a 10MB quota; G2 (IndexedDB)
lands when the readings say it must, not when fashion says so. That is why
the readings are the ritual.

## 3 · The accessibility pass (15 min, = A-A9's only verdict path)

The body iframe's AX absence is control-proven a harness artifact; the
only remaining verdict is a real screen reader on real hardware. NVDA
(Windows) or VoiceOver (macOS): open a message, read the thread strip,
the deadline strip, and the body; tab the actions; Esc to the list. Three
judgements: is the conversation order right, is every control named, does
focus return where it should.

## 4 · Classifier harvest (5 min)

Export a backup (Options → backup). Then:

```sh
node tools/eval-classifier.mjs path/to/backup.json
```

It reports the *pre-correction agreement rate*: how often the raw
classifier already agreed with the categories you corrected by hand. That
number, week over week, is the classifier's first honest accuracy signal
(G4's corpus).

## 5 · Write it down — the part that makes it a ritual

Keep the log in this file's sibling: `docs/SOAK-LOG.md` is created by the
first real soak (dated entries: build SHA, readings, findings, verdicts).
A finding that doesn't land back as a commit or a pin didn't happen.

---

*The soak is deliberately not automated: its entire value is that the
automation can't reach where it goes. Everything it finds should strain
toward becoming a gate, and the gates that already exist (smoke, bench,
axe) get their final corroboration from it.*
