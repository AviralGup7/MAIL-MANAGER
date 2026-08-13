# The semester refresh (G4 m3)

BITS runs on semesters; the data this extension classifies with runs on the
same clock. The classifier's campus knowledge is *generated* — timetable,
department vocabulary, address map, pattern rules — so the refresh is a
calendar act, not a memory: tie it to the semester, or the pack silently
ages out from under the moat.

## When

Twice a year, in the first week teaching starts:

- **Semester I** — early August (the 2026-27 pack came from the
  5-Aug-2026 timetable + the 4-Aug changes notice; see
  `src/timetable/sources/`).
- **Semester II** — early January, when AUGSD publishes the new timetable.

The alarm is the owner's calendar (single-maintainer shop: that is
[@AviralGup7](https://github.com/AviralGup7)), set for the Monday after
registration closes. If a soak (G1, `docs/SOAK.md`) is in flight at the
same time, the refreshed pack makes a better soak — run them together.

## What moves

1. **Timetable.** Drop the new AUGSD dump(s) into `src/timetable/sources/`
   and regenerate:

   ```bash
   node tools/parse-timetable.mjs            # rewrites src/timetable/data.json
   node tools/check-departments.mjs          # the vocabulary gate — must stay green
   ```

   `check-departments` exists because `timetable-mail.js` hard-codes the
   department vocabulary (a 652KB JSON does not belong in the ingest hot
   path). If it goes red, the fix is in `timetable-mail.js`'s literal —
   with the gate's own diff as the evidence. CI runs the same gate; do not
   merge a red one.

2. **The data pack generators** — only if the pack they read changed:

   ```bash
   node tools/gen-address-map.mjs            # src/classify/address-map.js (stage 0)
   node tools/gen-pattern-rules.mjs          # src/classify/pattern-rules.js
   ```

   Their headers carry the "re-run when" rule; the semester is the natural
   audit of whether the pack drifted. Hand-edits to the generated files are
   the one known sin here: the generator IS the source of truth.

3. **Accuracy, measured.** With a backup export at hand
   (options → backup), number the classifier before AND after the pack
   lands — the deltas are the refresh's report card:

   ```bash
   node tools/eval-classifier.mjs path/to/backup.json
   ```

   Non-decreasing is the bar; a regression means the new pack is quietly
   worse and the semester's mail agreed — investigate before shipping.

4. **New-sender sweep.** Each semester mints a handful of new official
   addresses (new PS cycle, new fest editions). The harvest section of
   `docs/SOAK.md` explains how corrections accumulate; a semester refresh
   is when borderline recurring senders graduate into `address-map.js`
   through the generator — not by hand.

## Verify, then ship

```bash
npm run docs:check        # the doc gate, this file included
node tools/ci-smoke.mjs   # browser truths — the preview reclassifies the seed mail
git push                  # the 8 CI shards are the declared-suite verdict
```

The preview corpus re-runs through the REAL classifier at every boot, so a
pack that mis-files BITS mail turns the smoke's own categories green-to-red
on the spot. That is the ritual's last line: the generation the pack
describes and the generation the app thinks it is can never differ by more
than one push.
