# UI / UX / Themes audit II — 50 improvements (round 46)

Charter. Additions only — capabilities, comforts and discoverability this
UI does not have yet. Distinct from `46-UIUX-PROBLEMS-50.md`: that file is
what to repair, this one is what to build. Ordered by tier, then value.

---

## Tier 1 — everyday value (1–12)

1. **Keyboard-first triage mode** — e/y/!/archive with a row-flash
   confirmation so the keyboard path feels as final as the mouse path.
2. **Keyboard thread navigation** — Enter/right-arrow expands a
   conversation, Esc collapses; j/k then walks inside it.
3. **Search operator cheatsheet on focus** — the grammar rendered as a
   two-column card; the product's best feature becomes visible.
4. **Now strip** — the current class, its room, walk-time left; the one
   glance a student actually takes, surfaced in the sidebar.
5. **Deadline digest card** — one Sunday summary of the radar's week.
6. **Undo-window ring** — a glanceable countdown on the outbox row
   replacing the text line.
7. **Recent-search chips** under an empty search box — history as
   affordance, not just arrow-key memory.
8. **Saved-view sidebar pins** — the two or three views a user lives in,
   one click from anywhere.
9. **Bulk "select all visible"** plus range selection — the triage-pass
   keystroke Gmail users expect.
10. **Attachment preview** — image thumbs and first-page PDF in the reader,
    budget-aware.
11. **Timetable ICS export** — the term in every phone calendar.
12. **Follow-up reminders** — the worker nudges when a waited-on reply is
    overdue; the feature's original promise completed.

## Tier 2 — trust & understanding (13–22)

13. **Image allow-list manager** — see, search and revoke every sender
    granted remote images.
14. **Notice history drawer** — every academic notice the scanner saw and
    what it did; transparency for the intelligence pipeline.
15. **Toast queue with icons** — distinct shapes for error/success/undo,
    queued instead of replacing.
16. **Onboarding tour** — three screens (categories, deadlines, the chord),
    shown once, never again.
17. **Empty-lane education** — each empty lane explains what would land in
    it, with one example query that would fill it.
18. **Activity log filters + export** — by verb, actor and day; the log
    becomes a diagnostic tool instead of a scroll.
19. **Storage dashboard in options** — cache/outbox/claims bytes per key,
    so quota surprises are visible before they bite.
20. **Stuck-send escape hatch** — "open in Gmail instead" on permanently
    failing outbox items.
21. **Reader "why is this here?" popover** — the classification reason,
    already recorded, one key away from the row.
22. **Theme-change confirmation toast** — the success half of this round's
    settings-failure toast, completing the language.

## Tier 3 — strong product features (23–34)

23. **Send later** — the outbox hold generalised to a schedule picker.
24. **Timetable clash warnings at add-time** — conflicts surfaced before a
    section is chosen, not after.
25. **Per-context signatures** — academic / clubs / personal on one key.
26. **Signature live preview** beside the editor.
27. **Drag-and-drop attachments** into compose.
28. **Attachment download progress** on the chip.
29. **Reading-position memory** per message.
30. **External-link domain markers** — destination named before the click.
31. **Custom snooze date/time** picker beside the presets.
32. **Configurable snooze presets** — the four defaults become a starting
    point.
33. **Notification category picker** — the allow-list becomes a setting
    with the conservative defaults.
34. **Notification grouping** — one card per burst instead of three drips.

## Tier 4 — theming & platform depth (35–44)

35. **Follow-OS theme** after first run, manual choice always winning.
36. **Theme hover preview** in the picker — the palette applied live while
    hovering, committed on click.
37. **Accent override** — one step of nudge for projection and visibility.
38. **Reader typography settings** — size, serif/sans, measure, persisted.
39. **Time-of-day theme suggestion** folded into the onboarding card.
40. **Quote-fold controls** — unfold-all plus a persisted threshold.
41. **Print stylesheets** for message and timetable — the wall-poster use
    case is real.
42. **Touch affordances** — swipe-to-archive, taller rows under touch
    detection.
43. **Bidi pass** — the layout and tokens reviewed for right-to-left so a
    future locale doesn't inherit a broken mirror.
44. **Monospace affordance** for plain-text code/log mail in the reader.

## Tier 5 — polish & delight (45–50)

45. **First-run theme suggestion** by local hour, folded into setup.
46. **Palette recent-actions section** — the last five commands, top of
    the list.
47. **Contextual bulk-bar labels** — "Archive 12 promotions" instead of
    "12 selected", naming the dominant category.
48. **Compose summary with attachment count** — the minimised bar names
    parked files too.
49. **Optional toast sound** — off by default, one click to on.
50. **Coach marks for the radar and lanes** — the same "Got it" idiom the
    shortcuts toast uses, applied to the two surfaces nobody explains.

---

## Sequencing notes

- Tier 1 is the daily-use core; 3, 4, 6, 11 are the cheapest wins in it.
- Tier 2 compounds trust; 13 and 14 turn invisible systems into visible
  ones — the strongest move for a product whose intelligence can be wrong.
- Tiers 3–5 are expansion; none should precede the QA items in the
  problems file (#47–49 there), which keep all of this honest.

None of this is required for stability. The companion problems file shows
the UI is sound; this list is what makes it loved.
