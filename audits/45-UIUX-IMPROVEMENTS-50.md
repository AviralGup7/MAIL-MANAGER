# UI / UX / Themes / Animations — 50 improvements (round 45)

Companion audits: `45-UIUX-PROBLEMS-50.md`, `45-ARCH-CHANGES-10.md`.

By definition this list contains **no defects** — every entry is a new
capability, a new polish layer, or a new user-facing choice the product
does not have yet. Grouped so a focused pass can take one section whole.

---

## Themes & personalisation (1–8)

1. **Follow-OS theme**: honour `prefers-color-scheme` as the default, with
   the manual choice overriding it.
2. **Time-of-day suggestion**: first run offers Daylight or Midnight based
   on the local hour — one question, right answer.
3. **Reader typography settings**: font size, serif/sans and measure,
   persisted; the iframe plumbing already carries theme and density.
4. **Density inside the reader** too, so compact users get a compact
   reading surface (pairs with problem #16).
5. **Per-theme accent override**: keep the six palettes, let the user nudge
   the accent one step for projection/visibility.
6. **Theme preview on hover** in the picker — the swatch dot today is the
   only hint of what a theme feels like.
7. **Quote-fold control**: "unfold all" plus a persisted threshold, so long
   forwards stop being a surprise.
8. **Image allow-list manager**: a visible list of allowed senders with
   per-sender revoke.

## Motion (9–13)

9. **Motion tokens**: one duration scale and one easing family, declared as
   CSS variables and used everywhere — new surfaces inherit the voice
   instead of inventing one.
10. **Interruptible transitions**: toggles mid-animation reverse instead of
    ignoring input, so a double-tap never feels dead.
11. **Ghost-flight cancellation**: if the toast target changes mid-flight,
    the shared-element ghost retargets or fades instead of landing wrong.
12. **Skeleton → stalled state**: after N seconds the shimmer becomes an
    honest "still waiting on Gmail" with the freshness line as proof.
13. **Reduced-motion alternatives**, not just removal: opacity-only fades
    that keep state changes perceivable without movement.

## Reader (14–20)

14. **Inline attachment preview** — images and first-page PDF thumbs in the
    reader, budget-aware.
15. **Download progress** on attachment chips (the wire budget machinery
    already exists).
16. **Body-load skeleton** scaled to the message's known part sizes.
17. **Mailbox-aware Open-in-Gmail everywhere** — the deep link always lands
    where the message lives.
18. **Live thread strip**: deltas that grow the open conversation update
    the strip without a reopen.
19. **Reading position memory per message** — reopening a long mail returns
    to where you were.
20. **Link affordance pass**: external links announce themselves before the
    click (the `target=_blank` marker exists; extend it with the domain).

## List & triage (21–28)

21. **Keyboard-first triage mode**: e/y/!/archive with a row-flash
    confirmation, so the keyboard path feels as final as the mouse path.
22. **Keyboard path into threads** — Enter/right-arrow expands, Esc
    collapses.
23. **Select-all-visible** and visible range selection in the bulk bar.
24. **Bulk progress meter** with cancel-between-batches for 1000+ runs.
25. **Muted-category styling in the rail** — muted counts read as muted.
26. **Lane quick-filters**: one click on a lane name narrows the list to
    it; the lanes stop being read-only numbers.
27. **Touch affordances**: swipe-to-archive, taller rows under touch
    detection — a tablet pass, not a phone app.
28. **New-mail pill announcements** via `aria-live`, and a click target
    that keeps working after partial scrolling.

## Compose & outbox (29–35)

29. **Size budget meter** in compose: live MB count against the 25MB
    ceiling, error before send instead of after.
30. **Minimised-compose summary line**: "To: prof@… — Re: extension" so a
    parked draft is recognisable.
31. **Signature preview** beside the editor, rendered as it will send.
32. **Template preview pane** before insertion, with the auto-filled values
    visible and editable.
33. **Undo-window ring** on the outbox row: a visible countdown instead of
    a text line, readable at a glance.
34. **Drag-and-drop attachments** into compose.
35. **Per-context signatures** (academic / clubs / personal) on one key.

## Timetable, radar & notices (36–42)

36. **ICS export** — the term in every phone calendar.
37. **Clash warnings at add-time**, before a conflicting section is chosen.
38. **"Now" strip**: the current class, its room, and the walk time left —
    the one glance a student actually takes.
39. **Timetable print stylesheet** — the wall poster use case is real.
40. **Deadline digest card**: one Sunday summary of the radar's week.
41. **Follow-up reminders**: the worker nudges when a waited-on reply is
    overdue — the feature's original promise, completed.
42. **Notice history drawer**: every academic notice the scanner saw, with
    what it did — transparency for the intelligence pipeline.

## Feedback, onboarding & platform (43–50)

43. **Toast queue with icons**: distinct shapes for error/success/undo,
    queued instead of replacing, optional sound.
44. **Empty-state education per lane**: each empty lane explains what
    would land there.
45. **Onboarding tour**: three screens — categories, deadlines, the
    takeover chord — and then it never appears again.
46. **Search operator cheatsheet** on focus: the grammar is the product's
    secret weapon and currently invisible.
47. **Saved views pinned to the sidebar**, not buried in the palette.
48. **First-run theme + density suggestions** bundled into one calm setup
    card (no wizard, one decision each).
49. **forced-colors support pass** — the palette degrades gracefully under
    OS high-contrast enforcement.
50. **Print styles for messages** — a clean single-message print for
    records and complaints.

---

## How to sequence

- **Highest everyday value:** 21, 22, 24, 29, 33, 38, 46.
- **Highest trust value:** 8, 18, 28, 42, 43.
- **Cheapest wins:** 9, 17, 25, 28, 44.
- **Biggest builds (schedule deliberately):** 14, 27, 36, 45.

None of this is required for stability — the companion problems file shows
the UI is sound. This is the list that makes it *loved* rather than merely
*used*.
