# Round 50 — Layout & Rules audit (from the live render)

Source: four live screenshots (list+reader idle, timetable, selected row) plus
code review. The user reported the layout "needs a complete redesign" and the
rules "seem problematic." This audit separates genuine defects (fixed) from
redesign targets (planned), and audits the classification rules against the
mislabels visible in the live render.

Severity: **M**oderate · **L**ow. Zero Severe.

---

## Layout — FIXED this round

1. **M — the idle reader pane was a blank half-screen.** The default view
   spent ~45% of the display on a two-word legend. FIXED: `renderReaderIdle`
   fills the resting reader pane with the same due-soon list the radar shows
   (extracted `collectDueItems` so the two surfaces cannot drift), each item a
   real button that opens the message. The default view is now useful.
2. **L — reader empty-state collapsed to a narrow column.** In a column flex,
   `margin:auto` shrink-wraps; the legend wrapped to two words. FIXED with a
   real measure (`width:min(100%,480px)`), pinned.
3. **L — new `.reader-idle-what` ellipsis needed `min-width:0`.** A 1fr
   grid item won't truncate without it; the layout guard caught it. FIXED.

## Layout — redesign targets (planned, not defects)

4. **L — timetable week grid reads sparse.** The week strip shows one block
   over a large empty band; day headers/empty-day columns are not visually
   anchored, so a light day looks broken. Redesign: render all day columns
   with a quiet empty state so absence reads as "no class", not "error".
5. **L — timetable chooser message is confusing.** "No lecture section
   matches that teacher." appears before the user has chosen a teacher.
   Reword to "No lecture section yet — pick one below" or hide until a
   teacher filter is active.
6. **L — topbar can sit high on short windows.** The search/topbar row has no
   compact fallback at low viewport heights. Redesign: a condensed topbar
   under a height media query.

## Rules — FIXED this round

7. **M — course-content mail mislabeled clubs/events.** Live render showed
   "KINETICS & REACTOR DESIGN (CHE F311) new content" → CLUBS and a lecture-
   session mail → EVENTS. FIXED: a course-code signal (dept+letter+3 digits)
   adds a strong academics score, so naming a course wins over stray
   keywords. Pinned by a classify test.
8. **L — course-code detector duplicated locally.** To keep DOM code out of
   the worker (the load-doctor rejected importing timetable.js), the detector
   is a minimal local regex. Kept in sync by the classify test; documented.

## Rules — observations (by design, unchanged)

9. **L — GitHub CI mail → EXT SERVICES is correct.** Not a mislabel.
10. **L — events vs academics share 'lecture'.** The course-code signal now
    disambiguates real course mail; pure event mail (fest/seminar without a
    course code) still routes to events, as intended.

---

## Verification

- package+classify 149/149 (incl. load-doctor, ellipsis guard, course-code).
- integration + layout-contract 220/220.
- The load-doctor caught a defect I briefly introduced (course-code import
  pulled `document` into the worker graph); fixed by the local detector and
  kept as a regression the doctor already enforces.

## Read plainly

The layout's default state was the real weakness and is now fixed (idle
reader is useful, empty-state no longer collapses). The remaining layout work
is a genuine redesign of the timetable week grid and a compact topbar —
planned, not defects. The rules' one real defect (course mail mislabeled) is
fixed and pinned. The codebase remains at zero severe defects.
