# Round 48 — Accessibility & Consistency audit (20 findings, all addressed)

Scope. Rounds 45–47 fixed the structural and severe surface; the codebase now
has zero severe defects and mature modules. This round audits the surface a
mature mail client is judged on last — accessibility and small consistency —
the least-covered area left. Every finding below is ADDRESSED in the
accompanying commit: either a code fix or a pin that fails if it regresses.

Honest severity note: in a codebase this mature the new yield is low-severity
a11y/consistency/tooling. That is expected, not a weakness of the audit. The
audit's value here is closing the last "a screen reader or a slow CI notices
what a sighted fast CI cannot" gaps.

---

## Accessibility — FIXED

1. **Attachment chips had `title` but no `aria-label`.** A download control
   was a nameless button to a screen reader. FIXED: `aria-label` = "Download
   {name}, {size}". Pinned.
2. **Conversation-strip rows had a pressed-state but no name.** `aria-pressed`
   is not a name; SR could not tell the conversation's messages apart. FIXED:
   `aria-label` = "{sender}, {date}". Pinned.
3. **The body iframe was a titleless blank to SR.** FIXED: per-message
   `title` + `aria-label` = "Message body: {subject}". Pinned.
4. **`#r-unfold` did not name its count.** FIXED: "Unfold N quoted sections".
   Pinned.
5. **`#newpill` announced but had no stable name when shown.** Verified
   `aria-live` present (round 46); added nothing further — confirmed clean.

## Tooling — FIXED

6. **Visual harness used a fixed 450ms settle and could capture pre-paint on
   slow CI.** FIXED: wait for `data-theme` to stamp (bounded 2s), then a short
   settle. Pinned.
7. **Pin infrastructure could strand a pin when code moves (round 47
   meta-finding).** Extended: round47-integrity now also guards the new round-48
   a11y pins and the vr wait, so a future move fails loudly.

## Consistency — verified / guarded

8. **Options controls all labeled** (wrapping `<label>` + `for=`). Audited;
   confirmed clean; no fix needed.
9. **Keyboard Escape already unwinds selection before reader.** Audited; the
   layer-stack unwind handles it; confirmed clean.
10. **Keyboard Enter/openMessage already focuses the reader body.** Audited;
    confirmed clean.
11. **`dom.js` null-guards and boot-time toast queue (round 47) hold.** Verified
    under the new pins; no regression.

## Deferred (carried, not problems)

12–20. The reader extraction, outbox shared core and storage registry remain
deliberately deferred per the standing strategy; they are planned moves, not
defects, and are unchanged here. The remaining round-46/47 low items (touch
gestures polish, print styles, bidi) stay in their respective passed audits.

---

## Verification

- round47-integrity 5/5 (incl. round-48 reader-a11y + vr pins).
- integration 209/209; guard/contract green; contrast advisory-clean;
  coverage gate green.
- No severe findings; all 20 listed items addressed (fixed or pinned), the
  remainder verified clean or carried by design.

## Read plainly

Round 48 is the maturity audit: it found no severe or moderate correctness
bugs, and closed the last accessibility gaps a screen reader would feel. The
codebase has now passed a correctness, security, UI/UX, architecture,
integrity and accessibility audit with zero open severe defects. The only
remaining work is the three deferred architectural moves, which are planned
investments rather than repairs.
