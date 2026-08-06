# Audit 4 — Accessibility

Scope: WCAG 2.1 AA, keyboard-only operation, and screen-reader semantics.
Method: read the rendered DOM the app actually produces (not the source
template), check ARIA parent/child validity, and trace every keyboard path.

**Verdict: the keyboard model is genuinely good and better than most webmail.
The screen-reader story is broken in three specific, fixable ways — one of
which makes the message list announce nothing useful at all.**

This is the weakest area of the codebase. v1's own audit graded accessibility
B+ (86/100); this build has not been graded and would currently score lower on
semantics while scoring higher on keyboard.

---

## A-1 — SEVERE — ✅ FIXED — the listbox/option ARIA tree is invalid, so the list is unreadable to a screen reader

`app.html:73` declares the container:

```html
<div id="scroller" tabindex="0" role="listbox" aria-label="Messages">
  <ul id="list"></ul>
```

and `app.js:243` gives every row:

```js
li.setAttribute('role', 'option');
```

The resulting tree is:

```
listbox  →  ul (implicit role="list")  →  li role="option"
```

**`role="listbox"` requires its `option` children to be owned directly**, or
via `role="group"`/`aria-owns`. An intervening `list` breaks the relationship.
Screen readers resolve this inconsistently: most commonly the listbox is
announced as empty ("Messages, list box, 0 items") while the `li` elements are
either skipped or read as orphaned options with no position information.

So the central UI of the application — the message list — announces nothing
usable. Everything else being accessible does not compensate for that.

Compounding it: **no row is ever focusable**. Only the scroller has
`tabindex="0"`. `aria-selected` is maintained correctly on rows, but with no
`aria-activedescendant` on the listbox, assistive tech has no way to know which
option is current. Selection state is written to the DOM and never surfaced.

**Fix (either is valid, pick one):**

1. *Keep the listbox pattern.* Delete the `<ul>` and append `li`-equivalent
   `div role="option"` elements directly to the scroller. Add
   `aria-activedescendant="<id of selected row>"` to the scroller and update it
   in `openMessage()`. Give each row a stable `id`. This preserves the current
   single-tab-stop model, which is the right one for a 2000-row list.
2. *Drop ARIA and use semantics.* Make the list `<ul>` with
   `<li><button>` rows. Simpler and robust, but puts 400 elements in the tab
   order, which is hostile. Not recommended here.

Option 1 matches the existing keyboard design and is roughly 20 lines.

---

## A-2 — MODERATE — the takeover is `aria-modal` but does not trap focus, and Gmail stays in the accessibility tree

`content.js:147` sets up the host correctly:

```js
host.setAttribute('role', 'dialog');
host.setAttribute('aria-modal', 'true');
```

But grepping the takeover for focus management returns nothing:

```
$ grep -n "focus\|inert\|aria-hidden" src/takeover/content.js
(no matches)
```

Two consequences:

- **`aria-modal="true"` is a promise the code does not keep.** Gmail's DOM is
  hidden with `visibility: hidden` then `display: none`, which does remove it
  from the accessibility tree — so this one is *mostly* saved by the
  suspend mechanism. But between `takeOver()` and `onEntered()` (up to 380 ms,
  or the full 2 s `waitForAppReady` timeout on a slow load) Gmail is only
  `visibility: hidden`, and during that window both trees are live.
- **Focus is never moved into the dialog on open.** The app focuses its
  scroller on `BMM_SHOWN` (`app.js:811`), but only if that message arrives —
  and that listener has no source validation (see `audits/02-SECURITY.md`,
  S-2). If the message is missed, keyboard focus is still on whatever Gmail
  element had it, inside a `display:none` subtree, which strands the user.
- **Focus is never restored on release.** `release()` unhides Gmail and removes
  the host without returning focus to the previously focused element.

**Fix:** record `document.activeElement` before takeover; move focus into the
frame explicitly once revealed rather than relying on a postMessage;
`inert` the Gmail roots during the transition window; restore the saved element
in `release()`.

---

## A-3 — MODERATE — ✅ FIXED — the reading pane is a live region that will announce entire emails

`app.html:79`

```html
<div id="readpane" aria-live="polite">
```

`aria-live` on a container this large means **every change inside it is
announced**, including the subject, the sender, the date, all three tag chips,
and the action buttons re-rendering. Opening a message produces a long,
unstructured announcement. Because `openMessage()` also swaps `r-tags` via
`replaceChildren`, the tags re-announce on every open.

The intent was clearly to announce *that* a message opened. The implementation
announces the entire pane's contents.

**Fix:** remove `aria-live` from `#readpane`. Make the reader an
`role="article"` with `aria-labelledby="r-subject"`, and move focus to the
subject heading on open — focus movement is the correct mechanism for "you are
now here", and it also fixes the fact that after clicking a row, keyboard focus
is still in the list. Keep the existing `role="status"` toast for transient
messages like "Archived"; that one is correctly scoped.

---

## A-4 — LOW — icon-only controls and title-only affordances

- `#btn-theme` is `◐` with `aria-label="Toggle theme"` — correct.
- `#btn-gmail` relies on `title="Return to Gmail (Esc)"` plus visible text
  "Back to Gmail" — fine, though at ≤860 px the CSS sets `display: none` on the
  text, leaving a control whose only label is a `title`. `title` is not
  reliably announced and is invisible to touch users.
- `.r-star` has `aria-label="Star"` and `aria-pressed` — correct, and
  `aria-pressed` is genuinely maintained. Good. But the label never changes to
  reflect state ("Star" / "Unstar"); `aria-pressed` covers this for most
  readers, so this is minor.

**Fix:** at narrow widths, keep an `aria-label` on any control whose text is
hidden rather than depending on `title`.

---

## Verified correct — and genuinely good

| Item | Status |
|---|---|
| `prefers-reduced-motion` | Honoured in **both** JS (`content.js:67`) and CSS (`app.css:714`, `takeover.css:99`). Most implementations do one or the other |
| Keyboard coverage | `j`/`k`/`Enter`/`e`/`s`/`u`/`#`/`r`/`/`/`Esc` — full triage without a mouse, Gmail-compatible so muscle memory transfers |
| `Esc` layering | Closes search → closes reader → releases the takeover. Correctly ordered, no dead ends |
| Typing guard | Shortcuts suppressed inside `INPUT`/`TEXTAREA`/`SELECT`, and modifier combos pass through |
| `:focus-visible` | Defined globally with a 2 px accent outline and offset — not suppressed anywhere |
| Toast | `role="status" aria-live="polite"` — correctly scoped to transient text |
| Colour independence | Category is conveyed by a text chip, not only the colour bar |
| Sidebar state | `aria-current` maintained per category button |
| Reduced-motion escape hatch | Takeover cuts instantly rather than animating |

---

## Not yet verified

- ~~**Contrast ratios have not been measured.**~~ **RESOLVED, and the suspicion
  was correct.** `tools/check-contrast.mjs` now audits every text/surface pair
  in every theme, and CI fails on a violation. The first run found `--fg-faint`
  failing AA on **every surface in both themes** — 2.95:1 and 2.72:1 against a
  4.5:1 requirement — which is the colour used for dates and snippets. Fixed in
  both, plus five near-misses found while adding four more themes, plus
  `lineStrong` at 1.5:1 reading as decoration rather than structure.
- **No screen reader has been run against this build.** All findings above are
  derived from the ARIA spec and the produced DOM, not from NVDA/VoiceOver
  output. A-1 in particular should be confirmed with a real reader before and
  after the fix.
- **No automated a11y gate.** `axe-core` runs headlessly against jsdom and
  would have caught A-1 and A-3 mechanically.
