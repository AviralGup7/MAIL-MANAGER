# UI / UX / Themes audit II — 50 open problems (round 46)

Charter. Only issues that are OPEN after round 45's fixes. Everything fixed
this programme (reader density & themed frame, responsive ladder, native
confirms, focus contract, bulk progress, compose meter & identity, live
strip, mailbox-aware links, motion token completion) is EXCLUDED.

**Explicitly out of scope by product decision: the QUANTITY of animation.**
The motion in this UI is deliberate, tokenised and reduced-motion-aware; no
finding below treats animation amount as a defect, and none may be used to
justify removing or shortening an animation. Findings about motion concern
consistency and accessibility completeness only.

Severity: **M**oderate · **L**ow. Zero Severe.

---

## Themes & colour (1–10)

1. **L** No automatic dark mode: `prefers-color-scheme` only decides the
   FIRST run; a machine that flips schemes later never sees the app follow.
2. **L** The theme picker's only preview is the swatch dot — choosing
   between six palettes is a leap of faith (no hover preview).
3. **L** Theme application is silent; after this round's settings-failure
   toast, success and failure now speak different languages.
4. **L** No per-user accent nudge; projection/visibility needs are
   unaddressable without a whole new theme.
5. **L** `forced-colors` / Windows High Contrast mode unhandled — the
   variable-driven palette can collapse under OS contrast enforcement.
6. **L** High Contrast theme's interactive STATES (hover, selection, drag)
   were never audited as a set; the contrast checker covers text/surface.
7. **L** The star's gold and the warning colour share a hue band across
   themes — starred rows and warnings read as kin.
8. **L** Reader typography is not user-adjustable beyond density (size,
   serif/sans, measure are fixed).
9. **L** Theme tokens assume LTR; no bidi review has ever been done.
10. **L** The gate card can paint one frame before the theme lands on very
    slow machines (the visual harness caught exactly this at 250ms; real
    users on cold storage may see the flash the comment promises to avoid).

## Layout & responsive (11–18)

11. **M** No touch affordances: row heights, hit areas and gestures are
    mouse-tuned; tablets get a desktop app.
12. **L** The options page has no responsive styling — the second desktop-
    only surface.
13. **L** No print styles: printing a message or the timetable prints
    chrome, toasts and sidebars.
14. **L** All type tokens are px; users with enlarged default font sizes get
    UI text that ignores their preference (rem scaling would honour it).
15. **L** The gate at ≤480px has never been visually verified — the ladder
    covers panes, not the signed-out card.
16. **L** The bulk bar at 480px is unverified — its buttons may wrap under
    the count.
17. **L** The minimised compose bar's summary can itself overflow at narrow
    widths with a long subject; no ellipsis rule on the summary.
18. **L** `#compose` at 600px spans full width but keeps the desktop
    max-height — on a short landscape window the body scrolls twice.

## Reader (19–26)

19. **L** Quote-fold's 480-char threshold is hardcoded; no "unfold all" and
    no per-user threshold.
20. **L** The image allow-list has no manager: once "always load" is
    clicked, allowed senders are invisible and unrevocable.
21. **L** Body loading shows a spinner with no sense of scale for large
    messages.
22. **L** Attachment downloads show no progress; the budget allows 60s of
    inert chip.
23. **L** Reading position per message is not remembered; reopening a long
    mail starts at the top.
24. **L** External links don't name their domain before the click (the
    _blank marker shows; the destination doesn't).
25. **L** The reader's `<pre>` fallback uses `font: inherit` — plain-text
    mail loses the monospace affordance that says "this is code/log output".
26. **L** Blocked-image placeholders all look identical whether the image
    is remote-blocked or cid-unresolved; the two have different remedies.

## List & triage (27–34)

27. **L** Swipe-to-archive and long-press selection absent for touch.
28. **L** Muted categories render in the rail exactly like unmuted ones —
    mute state invisible where it is managed.
29. **L** Template insertion still teleports the caret above the typed
    text with no marker of the insertion point.
30. **L** The signature editor is a bare textarea with no live preview.
31. **L** Lane-specific empty states unexplained — "Nothing here" teaches
    nothing about what a lane holds.
32. **L** No onboarding tour; the three headline ideas (categories,
    deadlines, the chord) are discoverable only by accident.
33. **L** The search grammar — the product's secret weapon — has no
    cheatsheet on focus.
34. **L** Saved views live only in the palette; frequent views deserve a
    sidebar pin.

## Compose & outbox UX (35–40)

35. **L** No per-context signatures (academic / clubs / personal).
36. **L** Drag-and-drop attachments unsupported; the file picker only.
37. **L** The undo-window countdown is a text line on the outbox row, not a
    glanceable ring.
38. **L** Send-later is absent — the outbox hold proves the mechanism, but
    the picker doesn't exist.
39. **L** Outbox stuck items offer retry but no "open in Gmail instead"
    escape hatch for permanently failing sends.
40. **L** The compose dirty-dot and the minimised summary don't mention
    pending attachments — a parked draft with files looks text-only.

## Accessibility (41–46)

41. **M** No real screen-reader pass has ever run (TODO #10) — every other
    a11y investment depends on it.
42. **L** The a11y CI test audits shells only; rendered states (list,
    reader, compose open) are not axe'd.
43. **L** Palette and menu layers lack the focus trap the confirm and
    timetable dialogs now have.
44. **L** The coach toast ("Press j to move…") appears on the SIGN-IN gate,
    where no list exists yet — first-run noise.
45. **L** Lane-count changes and radar updates still aren't announced to
    assistive tech.
46. **L** Bulk checkboxes share one generic aria-label ("Select message")
    with no subject context — 40 identical names in the accessibility tree.

## Tooling & QA as UI quality (47–50)

47. **M** Visual-regression baselines are not committed — the harness can
    diff locally but CI can't catch a theme or layout regression.
48. **L** The harness cannot sign in, so its 72 screenshots cover the gate,
    never the list/reader/compose — the surfaces users stare at.
49. **L** No pixel-diff step: screenshots are artefacts without a judge.
50. **L** The a11y and contrast tools never intersect: interactive-state
    contrast (hover, selection) is checked by neither.

---

## Distribution

| Severity | Count |
|---|---|
| Severe | 0 |
| Moderate | 4 (#11 touch, #41 SR pass, #47 baselines, #10 theme flash) |
| Low | 46 |

**Read plainly:** round 45 retired the structural defects; what remains is
a polish-and-coverage surface — theming depth, touch/print/bidi, reader
comfort, discoverability, and the QA tooling that would keep all of it
honest. The highest-leverage items are the QA ones (#47–49): they turn the
other 47 from recurring audits into caught regressions.
