# UI / UX / Themes / Animations — 50 problems (round 45)

Companion audits: `45-UIUX-IMPROVEMENTS-50.md`, `45-ARCH-CHANGES-10.md`.

Context first, because it shapes everything below: this UI has already
survived six audit rounds and a contrast checker runs in CI. Most surfaces
are genuinely good. The findings here are therefore dominated by
**consistency, coverage and edge states**, not broken basics. Zero Severe.

Severity: **M**oderate · **L**ow.

---

## Themes & colour (1–8)

1. **M** `#r-body` (the reader iframe) has `background: #fff` hardcoded —
   the one place a dark theme leaks white. The srcdoc carries its own
   surface colour, but the frame behind it is white, so dark-mode opens
   flash and any sub-pixel gap stays white. Theme the frame or make it
   transparent.
2. **L** The timetable flash highlight falls back to `var(--accent, #4a7)`
   — an arbitrary magic colour that belongs to no theme. Every token use
   should resolve or fail visibly, not degrade to a hex nobody chose.
3. **L** Compact density hides snippets GLOBALLY. A user who wants dense
   rows but needs snippets for one workflow has no escape hatch; density is
   all-or-nothing per install.
4. **L** The High Contrast theme's INTERACTIVE affordances (hover states,
   selection, drag highlights) have never been reviewed as a set — contrast
   checking covers text/surface pairs, not state differentiation.
5. **L** Toast kinds are differentiated by a 2px coloured edge ONLY. For
   colour-blind users an error and a success can be indistinguishable; there
   is no icon, prefix or text marker.
6. **L** The star's gold (`#8a5a00` family) sits in the same hue band as the
   warning colour across themes — starred rows and warnings share visual
   ground.
7. **L** No automatic dark mode: `prefers-color-scheme` is ignored. Users
   must hand-pick Midnight; the OS preference never applies (not even as a
   default on first run).
8. **L** Theme application is silent — after this round's settings-failure
   toast, a successful theme change saying nothing is a small consistency
   gap (one subdued confirmation would close it).

## Motion & animation (9–15)

9. **L** Durations are not tokenised: at least ten distinct values ship
   (40/80/88/90/120/140/180/200/380/450ms). Every new surface invents its
   own number; nothing keeps them related.
10. **L** Three easing families coexist (34× ease-out, 19× ease, 9× ease-in)
    plus three bespoke béziers — there is no single motion voice, so motion
    reads as per-feature decoration rather than one language.
11. **L** Row entrance staggers up to ~450ms on every FULL re-render
    (mailbox switch, resync). Reduced-motion correctly zeroes the delays,
    but everyone else pays sequential pop-in as perceived latency on the
    most frequent navigation action.
12. **L** The archive→toast shared-element ghost measures the toast's live
    rect at flight time — if a second toast REPLACES the first mid-flight,
    the ghost flies at the wrong target. No cancellation on replacement.
13. **L** Toggles mid-animation are ignored (correct, prevents
    half-mounting) — but a double-tapping user gets no feedback that their
    second press was seen. A dead keystroke feels like lag.
14. **L** The toast drain bar animates `linear` for the full window while
    the toast's own exit is 140ms ease — the drain visibly snaps when an
    early replacement cancels it.
15. **L** The cold-start skeleton shimmers indefinitely. On a stalled
    network there is no transition to "still working…" or "this is taking
    long" — infinite shimmer reads as a hung app.

## Reader (16–22)

16. **M** The density setting never reaches the reader iframe: body
    typography is fixed at 15px/1.65 regardless. A compact-mode user gets a
    dense list and a spacious reader — two apps in one window.
17. **L** Quote-fold's 480-character threshold is hardcoded; long
    legitimate quotes open collapsed, and there is no "unfold all" or
    per-user threshold.
18. **L** The image allow-list is invisible: once "always load from this
    sender" is clicked, there is nowhere to SEE or revoke which senders are
    allowed.
19. **L** Body loading shows a spinner with no sense of scale — a huge
    message and a tiny one look identical while fetching.
20. **L** Attachment downloads show no progress; the GET_ATTACHMENT budget
    allows 60 seconds, during which the chip is inert with no feedback.
21. **L** At least one Open-in-Gmail anchor is built with a hardcoded
    `#inbox/` fragment although a mailbox-aware `gmailUrl()` helper exists —
    opening a Sent or Trashed message lands the user in the inbox view.
22. **L** The reader's thread strip does not refresh when a delta adds a
    reply to the open conversation — the strip goes stale until reopen.

## List & triage (23–29)

23. **L** One-character search answers "everything" (carried UX decision —
    listed because every new user hits it; needs the explanatory empty
    state, not the full list).
24. **L** The "N new — jump up" pill has no `aria-live`; arrivals are a
    visual-only announcement (carried, still open).
25. **L** Bulk operations over 1000 items run multiple sequential batches
    behind one spinner — no count, no cancel between batches (carried).
26. **L** Row hover-actions exist only under `hover: hover`; touch devices
    get no long-press or visible alternative — the same actions are
    unreachable without a mouse.
27. **L** The category rail shows counts for muted categories exactly like
    unmuted ones — mute state is invisible where the user manages it.
28. **L** Lane counts and partition recompute wholesale per render with no
    memoisation — at the 2000-message cap the sidebar pays O(n) per refresh
    (carried perf note with UX consequences).
29. **L** An empty-but-loading mailbox is visually indistinguishable from a
    genuinely empty one — the skeleton is off, the page is unset, and
    "Nothing here" can appear for a moment before mail lands.

## Compose (30–35)

30. **L** Four native `confirm()` dialogs survive while an in-app dialog
    primitive exists — one voice for destructive questions is missing
    (carried; the timetable wipe is the most destructive of the four).
31. **L** No size budget feedback: the 25MB Gmail limit is discovered only
    at send time, after the undo window, as an opaque outbox error.
32. **L** A minimised compose shows no context — no recipient, no subject,
    just the dirty dot. Users park a draft and must reopen to remember what
    it was.
33. **L** Template insertion teleports the caret into the template above
    the typed text with no visible marker of the insertion point (carried).
34. **L** The signature editor is a bare textarea with no preview — the
    user cannot see the `-- \n` convention they are editing.
35. **L** Autocomplete combobox semantics (roles, aria-expanded, option
    navigation) have no test coverage anywhere — the ARIA contract is
    asserted by nothing.

## Keyboard & focus (36–40)

36. **L** Takeover Escape only releases when the PARENT document has focus;
    keystrokes inside the app iframe never reach it (carried; the app's own
    release covers the normal path).
37. **L** Focus styling mixes `:focus` (9 uses) and `:focus-visible`
    (5 uses) — keyboard users see inconsistent rings, mouse users see
    incidental ones. One policy, applied everywhere.
38. **L** j/k treats collapsed threads atomically; there is no keyboard
    path INTO a conversation (carried).
39. **L** Focus restoration after bulk actions is not guaranteed — focus
    can land on the body, leaving keyboard users stranded after archiving a
    selection.
40. **L** Dialog focus-return is tested for the gate and compose, but the
    timetable chooser and other transient boxes have no focus-return pins.

## Accessibility states (41–44)

41. **L** Lane-count changes, radar updates and reclassification are not
    announced to assistive tech — the live regions cover search/bulk/attach
    only.
42. **L** No screen-reader pass has ever run against a real SR (carried
    from TODO #10 — listed because every other a11y investment depends on
    it).
43. **L** The timetable panel is `role="dialog"` without a focus trap —
    Tab walks out of the modal into the app chrome behind it.
44. **L** Error states (offline, auth expired, quota full) are announced
    visually via toasts; none of them has an `aria-live` or role=alert
    guarantee, so the worst moments can be the quietest.

## Responsive & platform (45–50)

45. **M** Only two breakpoints exist (1080px, 860px) and nothing below —
    narrow windows degrade into an untested layout. The app assumes a
    desktop-sized surface everywhere.
46. **L** No touch affordances at all: row heights, hit areas and gestures
    are mouse-tuned. A tablet Gmail user gets a desktop app.
47. **L** The options page has no responsive styling — fixed desktop
    layout, the same assumption as #45 in a second surface.
48. **L** No print styles: printing a message or the timetable includes
    chrome, toasts and sidebars.
49. **L** All type tokens are px-based. Browser zoom works, but users with
    enlarged default font sizes get UI text that ignores their preference —
    rem scaling would honour it.
50. **L** `forced-colors` / Windows High Contrast mode is unhandled — the
    CSS-variable-driven palette can collapse to invisible borders and
    indistinguishable states under OS-level contrast enforcement.

---

## Distribution

| Severity | Count |
|---|---|
| Severe | 0 |
| Moderate | 4 (#1, #16, #45 + #11's perceived-latency family) |
| Low | 46 |

**Read plainly:** this is a polish-and-coverage list, not a repair list.
The highest-leverage items are the theme leak (#1), the reader density gap
(#16), the motion-token consolidation (#9/#10), and the
accessibility-announcement gaps (#41/#44) — small work, disproportionate
trust. Everything else belongs to the focused UX pass, taken section by
section.
