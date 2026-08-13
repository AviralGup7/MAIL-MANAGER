# ACCESSIBILITY & INPUT ARCHITECTURE AUDIT

**Date:** 2026-08-13 · **Scope:** entire codebase (app shell, dialogs, rails, compose, options page, worker boundary)
**Method:** source census of `app.html` (72 interactive elements) + headless-Chromium live probing (tab-order walks, isolated overlay focus flows, CDP `Accessibility` tree reads, forced-colors / reduced-motion / zoom equivalence emulation) + existing gate tooling (`tools/check-contrast.mjs`).
**Evidence standard (§28):** nothing below rests on ARIA attributes alone; every claim carries the probe/readback that produced it, or is marked **UNVERIFIED**.

---

## 1. Executive diagnosis

**The interaction architecture is fundamentally accessible, and the accessible parts are load-bearing architecture, not applied ARIA.** The message list is a true single-tab-stop listbox with `aria-activedescendant`; every menu runs through one primitive that owns roles, arrow-key roving, Escape and focus return; overlays ride one layer stack with a documented non-modal doctrine; forced colors and reduced motion degrade *conceptually intact* because hierarchy never depended on the properties that get removed.

The measured defects are concentrated and sharable:

| # | Sev | Finding in one line |
|---|---|---|
| **A-A1** | **MAJOR** | The toast action button's accessible name is frozen at **"Undo"** — the coach's "Got it" and the outbox's "Show" both *announce as Undo* (AX-tree proven). |
| A-A2 | MODERATE | Menus invoked from a list row restore focus to a **non-focusable row div** → focus drops to `<body>` (context menu/s snooze). No trap; j/k survive. |
| A-A3 | MODERATE | Every row checkbox is named **"Select message"** — 20+ identical names in browse mode, no row identity. |
| A-A4 | MINOR | The sidebar `<aside>` landmark is unnamed (the rail's is "For you"). |
| A-A5 | MINOR | `#views-pop` is `role="dialog"` with **no accessible name**. |
| A-A6 | MINOR | Search suggestions **reopen empty** (history list) right after Escape closes them. |
| A-A7 | MINOR/OPP. | `#bulkbar` has no role; `#r-due` updates after open with no announcement; the single toast node hot-swaps `role=status↔alert` and lacks `aria-atomic`. |
| A-A8 | OPPORTUNITY | OS-level text-size scaling acts only partially (px-token type system). Browser-zoom is the supported path and is solid (it funnels through the responsive ladder). |
| A-A9 | **UNVERIFIED** | The sandboxed body iframe produced **no nodes** in the headless full AX tree. Markup is correct (`title="Message body"`); only a real screen-reader pass can settle whether bodies are legible to AT. **If genuinely absent, this is CRITICAL** — it is the app's core task. |

**No CRITICAL finding is proven in this audit.** The three traps one expects in apps like this are *proven absent*: no keyboard trap anywhere (26-stop tab walk + per-overlay spreads), no unnamed action (zero unnamed focusable controls in 1131 AX nodes), no hover-only verb (every hover verb has a keyboard twin — that parity is their design doctrine, verified in source and behavior).

---

## 2. Complete input-mode inventory

| Feature | Pointer | Keyboard | Touch | Screen reader | Evidence |
|---|---|---|---|---|---|
| Mailbox/category nav | ✓ | ✓ (tab stops, `.cat` buttons) | ✓ 64px rows (coarse) | ✓ `nav` landmark "Categories" | AX tree; tab walk |
| Message list scan/skim | ✓ | ✓ **listbox + activedescendant**, j/k/Gmail muscle | ✓ scroll + tap | ✓ option roster, stable ids | probe 1: `aria-activedescendant=bmm-row-m1` |
| Open/read message | ✓ click | ✓ Enter | ✓ tap | ✓ reader `role=article`, h1 subject | focus probe |
| Row quick verbs (archive/read/snooze/delete) | ✓ hover-verbs | ✓ e/u/z/# single-key **and** Shift+F10 menu | ✓ swipe L/R + long-press `contextmenu` | ✓ verbs named (dynamic read/unread) | row-actions.js, `@media (hover:hover)` gate, list.js:181 |
| Snooze/follow-up/deadline pickers | ✓ | ✓ menu primitive (arrows/Home/End/Esc) | ✓ | ✓ menuitem/menuitemradio discipline | menu.js tests + probe |
| Bulk select & act | ✓ checkbox/bar | ✓ Ctrl+A, x per-row, verbs, Esc | ✓ checkboxes (tabindex -1 by design; tap targets 32px coarse) | ✓ `bulk-count` aria-live | bulk probe: "20 selected" |
| Search + suggestions | ✓ | ✓ /, arrows + activedescendant, Enter, Esc | ✓ | ✓ combobox → listbox, expanded/controls | suggest probe |
| Command palette | ✓ | ✓ Ctrl+K, arrows, Esc **restores focus exactly** | n/a (kbd feature) | ✓ dialog+combobox+listbox | palette probe: afterEsc → `#list` |
| Compose (incl. attach, template, draft) | ✓ | ✓ c, tab stroll **by design non-modal**, Ctrl+Enter send, Esc | ✓ | ✓ all fields named (implicit labels) | compose probe, options census |
| Timetable workspace | ✓ | ✓ opens to internal focus, Esc → **returns to `#btn-timetable`** | ✓ | ✓ `role=region` "Timetable" | tt probe |
| Activity log | ✓ (palette + rail overflow ≤860) | ✓ palette | ✓ | ✓ layer tenant | R-A5 work |
| Theme change | ✓ | ✓ (radio menu) | ✓ | ✓ | menu.js primitive |
| Undo | Ctrl+Z / toast button | ✓ | ✓ toast button | ⚠ **name frozen "Undo" (A-A1)** | AX readback |
| New-mail pill | ✓ | ✓ (real tab stop) | ✓ | ✓ text-labeled "N new — jump up", aria-live | list.js:324 |
| Exit (Back to Gmail / sign out) | ✓ | ✓ Esc ladder / palette / ≤860 overflow menu | ✓ | ✓ | R-A5 verification |
| Settings (options.html) | ✓ | ✓ native form controls | ✓ | ✓ **13/13 inputs named** | options census |

**Unavailable for any mode:** nothing shipped-but-unreachable was found. The one *conditional* reachability gap (Timetable/Sign-out at ≤860px) was fixed in the last round and is covered by `test/sidebar-more.test.mjs`.

**Mode-dependent conveniences (by design, with parity):** hover-verbs (pointer) ≡ single-key verbs (keyboard) ≡ swipes + long-press menu (touch). Row checkboxes are `tabindex="-1"` on purpose — the doctrine comment is explicit: five tab stops per row would wreck tab order for exactly the users holding a faster path. That is the correct tradeoff **given** rows keep full verbs via keys; A-A3 records the remaining naming gap.

---

## 3. Complete interaction inventory (abridged to architecture-representative classes)

Full census: `.census.mjs` over `app.html` (72 elements, region-mapped). Classes and their discipline:

| Class | Markup | Role | Name source | Keyboard | Focus | State | Notes |
|---|---|---|---|---|---|---|---|
| Chrome buttons (`#btn-*`) | `<button>` | button | title/text, aria-label where icon-only | Enter/Space | visible outline (2px, forced-colors survives) | `aria-pressed` on `#btn-rail` ✓ | `#btn-side-more` tab-stop only ≤860 |
| List rows | `<div role=option>` own ids | option | content (from/subject/date) | roster via activedescendant | row not focusable (by design) | `aria-selected` mirrors selection | content-visibility `auto` (AX retained) |
| Row checkbox `.r-check` | `<input type=checkbox tabindex=-1>` | checkbox | **static "Select message" (A-A3)** | not a stop (by design) | — | real `checked` synced by bulk.js:134 | tap target on touch |
| Menu items | primitive-built buttons | menuitem/menuitemcheckbox/menuitemradio | text | full roving + Home/End + Esc (stopPropagation) | restore-to-anchor (guarded) | `aria-checked` | single shared construction |
| Dialogs | gate/compose/palette/help/views/prompt | dialog/alertdialog | aria-labelledby **except views (A-A5)** | see §5/§7 | see §6/§7 | aria-modal honest (compose=false) | prompt traps (probe-proven) |
| Comboboxes | search, To/Cc/Bcc, palette | combobox | implicit/aria labels | arrows/Enter/Esc | focus stays in input | `aria-expanded`/`aria-controls`/activedescendant | pattern uniform (autocomplete.js) |
| Listboxes | `#list`, suggest, contact lists, palette-list | listbox | aria-label | — | owner input keeps DOM focus | — | `#search-suggest` once in tab order (see §5 note below) |
| Toggle states | star (r-star) | button | "Star" | s | — | `aria-pressed` | visible in forced colors |
| Sliders/tabs/dnd | **none exist** | — | — | — | — | — | §13: no drag-drop anywhere |

---

## 4. Semantic architecture

**Verified sound:**

- Landmarks: `banner`-equivalent `#topbar` header, `nav "Categories"`, `main`, two `complementary` (one unnamed → A-A4), `article` reader with `h1 #r-subject` — measured in the live AX tree (`navigation: Categories`, `complementary: For you`, `main`, `article`).
- Dialog discipline: `aria-modal="true"` only where exclusive operation is true (gate/palette/help/prompt). Compose carries `aria-modal="false"` *with a markup comment explaining why the promise would be a lie over live mail* — the rare honest modal declaration, and the tab-stroll probe proves behavior matches the promise.
- Headings: h1 reserved for the message subject (the reading context's title); rails/dialogs use h2. In an embedded application surface this is defensible; global heading-skim gives the overlays and rails, not chrome noise.
- Lists: rows are roster `option`s directly under the listbox (comment in `buildRow` is explicit about not letting wrappers sit between) — no invalid nested-interactive structures found anywhere (72-element census + AX roles cross-checked).
- Tables: the timetable is a CSS **grid named `.tt-grid` with region/label semantics**, not a fake table; data is a schedule (one row = one entry), so list semantics are arguably the truer model. Not a defect.
- The reader body iframe carries `title="Message body"` and an inert sandbox — correct *markup*; live AT inclusion is A-A9 (UNVERIFIED).

**Misuse found:** only A-A4/A-A5 (both MINOR) — no `div`-buttons, no role/behavior contradictions, no placeholder-as-label (compose + options use real implicit/explicit labels).

---

## 5. Accessible names & descriptions

Probe base: CDP `Accessibility.getFullAXTree` — 1131 nodes, **zero unnamed focusable controls**, and per-element `queryAXTree` wherever a name was in doubt.

**A-A1 — the toast action lies by name (MAJOR, semantic).**
- `app.html:841`: `<button id="toast-action" aria-label="Undo" hidden>` (a deliberate pre-JS default name; comment says "JS overwrites this").
- `src/app/toast.js:69-71`: `setText(el.toastAction, action.label)` — updates **text only**, never the aria-label. Accessible-name computation: `aria-label` *wins over content*.
- **INTENDED:** the runtime label names the action.
- **ACTUAL (AX readback):** coach toast — button computed name **"Undo"** while its text reads **"Got it"**. Undo toast: name "Undo" ✓ (label happens to match). Stuck-outbox toast shows "Show", reads "Undo".
- **Impact:** the highest-salience control in every non-undo toast announces a *different, destructive-sounding* verb. First-run coach is the worst case: a screen-reader user told "press Undo" to dismiss a tip. WCAG 2.5.3 (label ≠ visible text) + 4.1.2.
- **Confidence:** proven (CDP queryAXTree with the toast live, twice).
- **Fix direction (not implemented):** set `aria-label` alongside the text, or drop the manual aria-label and let content name it. One line in toast.js + a pin in a toast test.

**A-A3 — 20 identical "Select message" checkboxes (MODERATE, semantic).** `list.js:826`. Technically accessible, practically anonymous — exactly the "100 identical Open buttons" failure this audit was told to look past focusability to find. Fix direction: per-row names (aria-label with sender+subject at `fillRow`), since the inputs exist for touch/browse and are deliberately not tab stops.

**Named-well everywhere else, with special credit:** dynamic read/unread toggles rename both directions (`syncRowActions`); `#btn-rail` exposes `aria-pressed`; menu radios announce On-state via `aria-checked`; the outbox row's buttons ("Retry"/"Discard") carry plain text; all 13 options-page inputs are named; icon-only buttons uniformly carry aria-labels (census: none missing).

---

## 6. Keyboard architecture (map + flows)

Full keymap (app.js keydown + shortcuts.js + suggest-ui + autocomplete + menu primitive):

```
GLOBAL (not typing):  j/k move · Enter open · e archive · u unread · s star · z snooze
                      # delete · ! spam · / search · c compose · Ctrl+K palette
                      Ctrl+A select-all(list) · Ctrl+Z undo · ? help · Shift+F10 row menu
                      G then… mailbox jumps · Esc = layered ladder
TYPING:               suggest/combobox: ↓↑ move (activedescendant), Enter accept/run, Esc close-first
READER:               same verbs act on open message; n/p next/prev? (r-prev/r-next buttons); Esc close
COMPOSE:              Tab strolls (non-modal by design) · Ctrl+Enter send · Esc close (dirty → prompt)
MENUS:                ↓↑/Home/End roving · Enter choose · Esc close (stopPropagation, one layer)
ESCAPE LADDER:        suggestions → clear query → blur search → close menu/layer (stack) →
                      close reader → clear bulk → release to Gmail   [each layer stopPropagations]
```

**Canonical flow, measured (compose):**

```
FOCUS ENTRY   #list focus, activedescendant=bmm-row-m0 (selection context set)
NAVIGATION    c                           → compose opens, focus #c-to            ✓
ACTION        (pristine) Escape           → closes (no prompt)                    ✓
STATE CHANGE  compose closes, activedescendant PRESERVED (bmm-row-m0)             ✓
FEEDBACK      draft autosave is silent-by-design; dirty path prompts (trapped)    ✓
FOCUS DESTINATION  focus stays where the non-modal stroll left it (page)          ✓ documented
```

The same five-step walk was run for palette (`Ctrl+K → arrows → Enter/Esc → focus returns **exactly** to `#list` with activedescendant), help (`? → help-close → Esc → #list`), bulk (`Ctrl+A → bar + "20 selected" polite → Esc → bar cleared, focus kept on `#list`), views (`btn-views → pop focus inside → Esc → `**btn-views**` restored), timetable (`btn-timetable → internal focus → Esc → `**btn-timetable**` restored), snooze/menu (`z → menu focus → Esc → see A-A2`).

**Measured defects & notes:**
- **A-A2** (see §6 findings join table): menu-from-row Escape → `<body>` (restore target is a non-focusable row div; layers.js's isConnected guard passes, `.focus()` no-ops). Rescue rails: document-level keymap never dies; activedescendant survives; j/k continue immediately (probe: `stillNavigates=bmm-row-m1`). MODERATE.
- **A-A6**: after Escape closes suggestions (`hidden=true` immediately), the suggest box **reopens with an empty query** inside 600ms (history dropdown) and the second Escape neither blurs nor proceeds down the ladder (`active` stays `#search`). Visually surprising; focus semantics consistent. MINOR, intent partially unverified.
- No traps found anywhere: gate (blocks by design, modal), prompt (strict 2-button trap, probe-measured), palette/help (single-stop dialogs — Tab trivially cycles in place; that satisfies the modal Tab contract, verified).
- Shortcut conflicts: none observed; `Ctrl+K`/`Ctrl+A` are captured before the modifier guard; Gmail-host conflict surface is the class Gmail already owns (this app is embedded there).

---

## 7. Focus architecture (treated as a system)

The system's documented invariants, all probe-verified:

| Transition | Expected | Measured | Verdict |
|---|---|---|---|
| open menu (pointer or Shift+F10/z) | focus into menu | `snooze-opt` active | ✓ |
| choose/Escape menu | restore to anchor | row anchor non-focusable → body (A-A2) | ⚠ |
| open palette/help | input/close-button focus | ✓ both | ✓ |
| close palette/help/views/timetable | restore invoker | EXACT restores (list, btn-views, btn-timetable) | ✓ |
| open compose | first empty field (prefill-aware) | `#c-to` / body on prefill | ✓ |
| close compose | non-modal: leave page focus where strolled | matches doctrine, activedescendant kept | ✓ |
| open reader (Enter) | focus stays list (Gmail reading-pane doctrine) | `active=list`, activedescendant on open row | ✓ deliberate |
| close reader (Esc) | roster context restored | cursor state survives (j→next measured) | ✓ |
| open row's modal prompt (dirty discard) | trap + restore into compose | strict trap; restore target inside compose | ✓ |
| layer close after re-render | never focus a detached node | `isConnected` guard live in layers.js:96-105 | ✓ (coded defensively) |
| drawer open/close ≤1240 | toggle semantics, non-modal | `aria-pressed` flips; button focus stays on toggle; Esc closes from anywhere | ✓ |

**Where focus is allowed to go odd:** (a) A-A2; (b) after dismissing the discard prompt with Esc, focus lands on an id-less control inside compose while compose remains open — harmless because compose is the active edit surface and the prompt's restore target was indeed within it (timing artifact of probing, not a structure break; noted for completeness).

---

## 8. Modal / drawer / panel accessibility

Overlay stack, probe-mapped:

```
page (j/k context, activedescendant)
 └─ rail drawer (≤1240: fixed, NON-modal, toggle btn aria-pressed, Esc closes,
     contents = next tab stops after #list — DOM order = order of approach   ✓)
 └─ compose panel (aria-modal=false BY DESIGN: strolling into live mail is
     the point; tab walk measured exiting then re-entering cleanly           ✓)
      └─ dirty-discard prompt (.prompt-backdrop, role=alertdialog when danger,
          aria-modal=true, STRICT TRAP — 2-button spread measured cycling    ✓,
          restoreFocusTo=invoker inside compose                              ✓)
 └─ palette / help (modal, single tabbable → trivially contained, Esc exact  ✓)
 └─ views pop (dialog, focus in, invoker restored; nameless → A-A5)          ✓
 └─ gate (aria-modal=true; traps by design at sign-in; keyboard path not
     reachable in signed-in preview — static markup+layer tenancy only)      UNVERIFIED-live
```

The Escape ladder is the spine: each layer owns its `stopPropagation`, so one keypress closes exactly one layer — explicitly regression-pinned by menu.js's "one Escape must not also close the reader" comments and suggest-ui's equivalent. Nested-overlay accessibility (page→panel→prompt) is architecturally coherent: **one stack, one ladder, one trap helper, one restoration guard.** No recommendation to decompose.

---

## 9. Screen-reader flow (proxy-measured)

(True SR verification requires NVDA/VoiceOver; per §28 those runs are marked UNVERIFIED where relied upon. What follows is the AX-tree order + semantics read, which is what those tools consume.)

A first-time SR user, by AX order: sidebar landmark (unnamed — A-A4; its nav IS named "Categories") → Compose button (named, shortcuthint in title) → mailbox/category buttons with counts inside names ("All mail 8 20 20 messages, 8…" — the count naming is a touch chatty but complete) → search combobox (named) → toolbar buttons (all named + shortcut titles) → promoted-notice button → **listbox "Messages"** (options read from-subject-date because their name is content) → reader idle hints (buttons) → rail "For you" with h2s → toast region when live.

**Mental-model parity:** the visual hierarchy and the AX hierarchy coincide because chrome text is real text and rows are real option content. Two parity breaks: A-A1 (wrong verb name), A-A3 (anonymous checkboxes), and the pale one: the coach's keyboard hints are visual text read in DOM order — fine. Reader body → A-A9 UNVERIFIED.

---

## 10. Dynamic content & live regions

The announcement map (all attributes read from the live DOM):

| Change | Channel | Politeness | Verdict |
|---|---|---|---|
| Toast (actions/results) | `#toast` role=status/alert (swapped per kind), aria-live=polite | alert on error only | ✓ doctrine; hot-role-swap on one node is fragile-but-working (A-A7); missing aria-atomic mitigated by whole-text swaps |
| "N new — jump up" pill | `#newpill` aria-live=polite + real text | polite | ✓ |
| Freshness "Updated …" | `#freshness` aria-live | polite | ✓ |
| Bulk selection count | `#bulk-count` aria-live=polite ("20 selected") | polite | ✓ probe-heard |
| Search note | `#search-note` role=status | polite | ✓ |
| Attachment list | `#c-files` aria-live | polite | ✓ |
| Compose status errors | `#c-status` role=alert | assertive | ✓ |
| Gate error | `#gate-error` role=alert | assertive | ✓ |
| Reader deadline banner (`#r-due`) appears *after* open (parse) | none | — | A-A7: insertion not announced; reading-order presence makes it low-harm |
| Outbox row status (held → retrying → sent) | rerendered text (1s tick this round) | visual first | row is in rail reading order; toasts announce the final transitions; ✓ / note |
| Selection change in list | activedescendant (SR's native listbox channel) | native | ✓ the correct mechanism, not a live region |

Noise check: no assertive interruptions during routine triage; one-toast-per-failure-episode is a pinned behavior (pumpOutbox). Live regions were **not** added indiscriminately anywhere — this codebase's discipline shows.

---

## 11. Virtualization & content-visibility accessibility

- `list.js:385-394`: the 400-row render cap was *deleted* once `content-visibility:auto` + `contain-intrinsic-size` took over layout cost — i.e., **every row is a real DOM option**, no windowing, no hand-rolled virtualizer.
- `content-visibility:auto` skips rendering, not semantics: off-screen options remain in the AX tree (the design difference from `display:none`), which keeps SR browse, find-in-page, and activedescendant whole on long lists. 20 options were visible in the AX dump exactly as the list reported 20 messages.
- Row insertion/removal during bulk/undo keeps roster semantics (`replaceChildren` on the list, ids stable per message, activedescendant recomputed by id).
- No focus-on-offscreen-element trap can arise: rows aren't focusable (single-stop roster).

**Verdict: clean** — performance work and AX representation agree.

---

## 12. Touch architecture

- Targets: 32px minimum under `pointer:coarse`, 64px rows, 46px compose (measured in the responsive audit; complements this one).
- Swipes (list.js:107-112): L=archive, R=unarchive — *with* keyboard/menu parity; no swipe-only capability.
- Hover-verbs on touch: deliberately hidden (`@media (hover:hover)` gate), doctrine comment saying the row keeps its full-width tap and the context menu rides each platform's long-press (`contextmenu` listener present at list.js:181).
- Nested scrolling: pane scrolls are orthogonal; no scroll-jacking.
- Drag/drop: **none** (§13).
- Zoom: viewport meta isn't locked down; whole-page zoom funnels through the media ladder (§16).

---

## 12b. Hover dependency (explicit pass)

Every `:hover` rule in app.css was classified (the file's hover set: button washes, row affordance hint `.row:hover::after`, hover-verb reveal, chip/affordance warm-ups):

| Behavior | Class | Equivalent | Verdict |
|---|---|---|---|
| Row hover-verbs reveal | action hover | keyboard selection reveals them too (`[aria-selected='true']`, focus-within); verbs themselves exist as e/u/z/# keys and the Shift+F10 menu | ✓ parity — hover is a *preview*, never the only door |
| `.ghost`/`.primary` hover color-wash | decorative hover | none needed | ✓ |
| Row separator hint (`:hover::after`) | discoverability hover | selection state permanent | ✓ |
| Tooltips via `title` | information hover | aria-labels + help dialog + shortcut-hint feedback loop | ✓ (title is one channel of three) |
| Category/queue hover shadows | decorative | — | ✓ |

No navigation depends on hover; nothing *opens* on hover (no hover menus/flyouts to strand touch or keyboard users).

## 13. Drag & drop

`grep dragstart|draggable|ondrop` over src/ → **zero**. Attachments use a labelled file input (`#c-file` tabindex=-1 + named `#c-attach` button proxy — the proxy is the focusable, the input is hidden, correct pattern). Nothing to equalize. ✓

---

## 14. Color & visual state

- `tools/check-contrast.mjs`: **all 6 themes pass WCAG AA** (measured this session).
- Unread = bold + unread dot (dual-coded); Starred = icon + `aria-pressed` + toast text; Category = text pill (not just color); Selected = background + 2px outline + revealed verbs (triple-coded); Errors = text + role=alert; Due/overdue = text banner ("Due in 4d") not a color; Confidence = never color-only.
- Forced-colors run (§17) confirms the conceptual hierarchy survives removal of every brand color.

---

## 15. Motion accessibility

- Reduced-motion emulation measured: every animation retargets to **0.001s** (effectively instant) — the file-last `@media (prefers-reduced-motion: reduce)` block (whose ordering bug was fixed in a previous audit) squashes sweep/bloom/row-in/star-pop. `getComputedStyle` sweep: 0 meaningful motion remains.
- No information depends on motion: the bloom/sweep are redundant with state text; toasts are text; unread persists statically.
- No scroll-linked animation; no vestibular offenders (nothing parallaxes/zooms) — most animations ≤140ms spatial transitions per the amended doctrine in app.css.

---

## 16. Zoom & text scaling

- **Browser zoom** (200% ≡ 640 CSS-px effective viewport): media queries respond to real zoom, so zoomed users get the *ladder itself* — the stack step at 600 (single column, full-width reader) was probe-verified across the responsive audit. Zoom is not an afterthought; it reuses the vindicated architecture. ✓
- **OS/text-only scaling**: partially absorbed — the type/spacing system is px-tokenized, so root `font-size:200%` scaled rows but not fixed-height chrome (topbar stayed 61px). Nothing clipped or overlapped (probe: no h-scroll, no overflow). Impact: users relying on OS text-size get *less* accommodation than zoom users — **A-A8 OPPORTUNITY** (not broken; a rem-token migration would be the architectural form of the fix and should be weighed against its blast radius).
- My first zoom probe used `style.zoom` (which media queries ignore) and showed h-scroll — recorded as a *method note*, not a finding; the equivalent-viewport method is the true one.

---

## 17. High-contrast / forced colors

Emulated `forced-colors:active`, screenshot + computed-style sweep:

- Every control gains a system border (ghost buttons become outlined); primary actions map to system face/text; links to LinkText; kbd hints render.
- Selected row: 2px outline intact; verbs revealed; star black-on-canvas.
- Hairline separators (box-shadow) disappear as specced — grouping survives on spacing/typography; nothing becomes ambiguous (nav items are text; rail cards keep borders).
- Toast with action + kbd hint fully legible.
- **Verdict: hierarchy intact** — the system never encoded meaning only in color/gradient, so forced colors do not break concept. One watch-item: category color dots in the nav flatten to uniform dots; names carry, so it's cosmetic.

---

## 18. Form & input accessibility

- Compose: To/Cc/Bcc/Subject/Body all implicitly labelled (`<label><span>To</span><input>`); Comboboxes declare `aria-expanded/controls/autocomplete`; errors go to `#c-status role=alert`; send disabled-state honest; discard is confirm-gated (trapped prompt), never destroys silently (draft autosave; cancel restores).
- Options page: 13/13 inputs named (explicit census).
- Search: labelled combobox; suggestions listbox; "no matches" state present.
- Validation: no validate-on-type destruction; asynchronous Gmail errors surface via toasts/`#c-status`, focus is not yanked.
- Minor: `placeholder` is used as a *hint* in search ("Search subject or sender…") alongside a real label — acceptable.

---

## 19. Error & recovery accessibility

Walked the failure classes (per the task-flow audit):

```
FAILURE        send fails after max attempts
USER AWARENESS error toast role=alert, once-per-episode (pinned), stuck row "Could not send — <reason>"
UNDERSTANDING  plain-language error text in row, action buttons
RECOVERY       Retry / Discard real buttons; toast "Show" scrolls the rail into view
FOCUS          recovery buttons are tab stops; act restores/keeps list context
RESTORED       queue repaints ≤1s (outbox tick), rail state = storage state     ✓ equivalent across modes
```

Also probed: offline banner, gate errors (role=alert), attachment-loss states, sign-out wiping state. Recovery paths are mode-equivalent because they all terminate in *named buttons in reading order* rather than gestures. (One already-fixed historical note: retry buttons that silently no-op'd were the 65/h round.)

---

## 20. Accessibility × state synchronization

Spot-verified synchronization chains (all live-probed):

```
selection exists     state.selected=m1 → .row[aria-selected=true] → SR current option
                     = activedescendant bmm-row-m1 → keyboard focus stays #list → ✓ in sync
bulk                 set ⊆ state → r-check.checked (bulk.js:134) → bulk-count announced → Esc clears all three ✓
rail                 body.rail-open ↔ #btn-rail aria-pressed true/false          ✓ probe-verified both phases
theme                menu radio aria-checked = active theme                      ✓ (primitive)
unread/star          row visuals ↔ aria-pressed (star) ↔ toast text              ✓
snooze menu from z   menu open → focus inside → Esc → see A-A2 (only desync)
toast action         text=Got it / aria-label=Undo  →  **A-A1 desync** (the one true sync failure)
```

---

## 21. Responsive × accessibility

After every ladder transformation, measured at 1240/860/720/600 boundaries this round and last:

- Rail→drawer (≤1240): toggle gains literal `aria-pressed` state; drawer contents enter tab order at DOM position; Esc closes from anywhere; **no focus loss**.
- Sidebar→icon rail (≤860): footer verbs collapse into the `#btn-side-more` kebab (added this week) — which is *itself* a named, `aria-haspopup=menu`, tab-stopped control whose menu delegates to the same handlers. Semantics survive the compression.
- Stack step (≤600): list and reader stay separate regions (stacked, never display:none'd) — tab order unchanged, activedescendant model unaffected.
- Toolbar icon-only (≤720): labels hidden visually but titles/aria preserved (R-A7 verification) — naming intact.
- Content order never inverts (visual order = DOM order throughout the ladder; the noticed DOM-position quirk — rail content tabbing after `#list` while rendering right of it — matches the spatial model and is consistent).
- No touch-only behavior introduced at any step; no semantic element changes role by width (same nodes, same roles — the ladder changes geometry, not semantics).

---

## 22. Task parity matrix

| Task | Pointer | Keyboard | Touch | Screen reader | Equivalent? |
|---|---|---|---|---|---|
| Triage list | hover-verbs/click | j/k + e/u/z/#/s | tap, swipes, long-press menu | roster + option content + single-key verbs | **Yes** |
| Read & act on message | reader buttons | open w/ Enter, same verbs, r-more | same | article + named buttons; body → A-A9 UNVERIFIED | Yes (body pending A-A9) |
| Multi-select triage | checkboxes + bar | Ctrl+A/x + bar/verbs | checkboxes | live count + per-row names anonymous (A-A3) | Mostly — A-A3 |
| Snooze/follow-up/deadline | menus | z + menu keys | menus | menuitemradio semantics | Yes |
| Search & filter | type/click | / + combobox keys | type | combobox + listbox + status | Yes |
| Compose | panel | c + stroll + Ctrl+Enter | panel | fully named fields | Yes |
| Undo / recover | toast button | Ctrl+Z | toast button | **announces "Undo" even when it isn't (A-A1)** | **No — A-A1** |
| New-mail jump | pill click | pill tab stop | tap | live pill | Yes |
| Navigation chrome | clicks | tab stops + palette | taps | landmarks | Yes |
| Timetable | panel | button → focus → Esc restores | tap | region + h-structure | Yes |
| Settings | page controls | native | native | all named | Yes |

---

## 23–27. Architecture maps

### A. Input architecture (as-shipped, actual names)

```
Pointer/touch          Keyboard                 Screen reader
   │  click/hover/swipe   │ document keydown ladder │ AX tree (roles/names/states)
   ▼                       ▼                         ▼
 delegated handlers   single global keymap        activedescendant /
 (list.js rows,        (app.js: typing guard →     live regions /
 row-actions.js,       ctrl pair → single keys →   menu roving
 contextmenu l.181)    layer Escape → release())      │
   └───────┴──── verbs all funnel through ctx.act()/─ openMenu()/openLayer() ─┘
                               │
                    Application state (store/state{})  ← one source
                               │
              renders keep AX in sync (aria-selected, checked,
              pressed, expanded, live text) ← SAME render pass
```

### B. Focus map (probe-measured edges)

```
#list ←───────────────────────────── Esc ladder terminal (reader, bulk, palette, help)
  │c            │Ctrl+K       │?            │z / Shift+F10        │Enter        │drawer toggle
  ▼             ▼             ▼             ▼                     ▼             ▼
#c-to      #palette-input  #help-close   menu item            (stay on list,  btn-rail keeps
  │Esc        │Esc            │Esc         │Esc (A-A2: body)    activedesc.)   focus (pressed)
  ▼             ▼             ▼            ▼                    │Esc           │Esc
(page stroll) #list         #list        body*                cursor kept    closed, focus kept
  │dirty Esc                              *document keymap     │               │
  ▼                                         rescue measured    ▼               ▼
 prompt(alertdialog, TRAP) ─Cancel→ compose   j/k+verbs work  roster nav     (page)
```

### C. Semantic map (representative)

```
visual row           div.row role=option id=bmm-row-<id>   name=content(from/subject/date)   state: aria-selected
row select box       input.r-check tabindex=-1             name="Select message" (A-A3)      state: checked
topbar               header#topbar                          (banner-equivalent)                —
toolbar              #toolbar role=toolbar                  buttons named+shortcut titles      —
message roster       #list role=listbox aria-label=Messages state via aria-activedescendant    —
reader               article#reader aria-labelledby=r-subject(h1)                              —
body                 iframe#r-body title="Message body" sandboxed-inert                        (A-A9 live-read UNVERIFIED)
rail                 aside#rail aria-label="For you"        h2 sections                        hidden ↔ class toggle
sidebar              aside#sidebar (UNNAMED → A-A4)         nav "Categories" inside            —
bulk bar             #bulkbar (NO ROLE → A-A7)              live count child                   hidden ↔ selection
toast                #toast role=status|alert (hot-swap)    text whole-swap; action (A-A1)     hidden ↔ shown
dialog(palette/help) role=dialog aria-modal=true            palette labelled; views UNNAMED(A-A5)
prompt               role=dialog|alertdialog aria-modal     labelledby prompt-title; TRAPPED   —
drawer               #rail fixed                            toggle btn aria-pressed            —
```

### D. Task parity map — see §22 matrix.

### E. Overlay accessibility map — see §8 stack map (page → panel → prompt; Esc ladder; trap/restore owners named).

### F. Dynamic announcement map — see §10 table (state → visual → semantic → announcement channels). One-line summary: **announcements flow through exactly six live regions + native activedescendant + assertive alerts for errors only.**

### G. Responsive accessibility map — see §21 (transformation → preserved semantics, measured).

---

## 24. Ranked findings (register)

| ID | Severity | Class (§25) | Where | One-line |
|---|---|---|---|---|
| A-A1 | **MAJOR** | SEMANTIC | toast.js:69-71 + app.html:841 | Toast action name frozen "Undo"; coach/outbox actions misannounce |
| A-A2 | MODERATE | INTERACTION | menu.js anchor + layers.js:96-105 | Row-anchored menus Escape → body, not list context |
| A-A3 | MODERATE | SEMANTIC | list.js:826 | All row checkboxes named identically "Select message" |
| A-A4 | MINOR | SEMANTIC | app.html `#sidebar` | Sidebar landmark unnamed |
| A-A5 | MINOR | SEMANTIC | app.html `#views-pop` | Dialog without accessible name |
| A-A6 | MINOR | INTERACTION | suggest-ui.js:99 vs ladder | Suggest reopens empty after Esc; ladder blur step unreached |
| A-A7 | MINOR/OPP | SEMANTIC | `#bulkbar`, `#r-due`, toast.js:52 | Missing role/banner-announce/role-hot-swap trio |
| A-A8 | OPPORTUNITY | LAYOUT | px token type system | Text-only scaling partially absorbed |
| A-A9 | UNVERIFIED | SEMANTIC? | iframe#r-body | Body subtree absent from headless AX dump — needs a real SR pass; CRITICAL if confirmed absent |

## 25. Architectural-vs-cosmetic classification

- A-A1 SEMANTIC (one-attribute fix; conceptually the name pipeline, not paint).
- A-A2 INTERACTION (restore-target selection policy in the layer/menu seam; not more ARIA).
- A-A3 SEMANTIC (naming policy per row).
- A-A4/A-A5 SEMANTIC-cosmetic (single attributes).
- A-A6 INTERACTION (Escape ladder ordering nuance).
- A-A7 SEMANTIC trio (each one-line-ish; the banner one is a policy decision about assertiveness).
- A-A8 ARCHITECTURAL-if-pursued (px→rem token migration: large blast radius, defer)).
- A-A9 VERIFICATION-DEBT (could be architectural: reading must be re-represented if bodies are AT-invisible; do not pre-solve).
- **No finding demands interaction-model redesign.** The overlay/focus/keyboard architecture is sound and earns its complexity; fixes are seam-level.

## 26. Proposed improvements, in tradeoff order (NOT implemented)

1. **A-A1 one-liner + pin** (task accessibility): toast.js sets `aria-label` with the label (or drop the attribute); test the computed name against visible text for each canned action. Highest value/cost ratio in this audit.
2. **A-A2 restore policy** (context preservation): in layers/menu teardown, when `returnFocus` is non-focusable (row), fall back to `#list` (the roster's focusable owner). ~4 lines behind a guard + flow test.
3. **A-A3 per-row checkbox names** (comprehension): derive from sender/subject at `fillRow`; confirm no SR verbosity regression (they're not tab stops; browse-mode-only).
4. **A-A4/A-A5 attributes** (consistency): `aria-label` on `#sidebar`; `aria-labelledby="views-title"` on `#views-pop`.
5. **A-A7 trio** (consistency): `role="toolbar" aria-label` on `#bulkbar`; decide `#r-due` assertiveness (polite or none — deliberate, and pin the decision); consider two toast nodes (status/alert) or keep + document the hot-swap with `aria-atomic="true"`.
6. **A-A6** (consistency): suppress history-dropdown reopen until next genuine input/focus intent; confirm ladder ordering.
7. **A-A9 verification pass** (debt): run NVDA (Chrome) + VoiceOver (Safari) against a live build reading a message; if bodies are AT-invisible, escalate to a reading re-representation decision — that *would* be architectural and this audit's only candidate for it.
8. **A-A8** only if product priorities shift toward text-size users; the rem migration is the honest form and is not worth its blast radius today.

Constraint note (§26 ask): no existing hierarchy/state/panel constraint needs to yield for 1–6; each lands inside the already-established seam it belongs to.

---

## Method appendix (what was actually run)

- Static: `.census.mjs` (72 interactive elements, region-mapped, name sources); contrast gate (6/6 themes AA); greps for hover gates, roles, drag/drop (none), windowing (none), content-visibility, live regions.
- Live (headless Chromium 151, CDP `Accessibility`): full AX tree (1131 nodes; zero unnamed focusable); per-element `queryAXTree` for the toasts (A-A1 proof); 26-stop tab walk; isolated clean-state flows for compose/palette/help/row-menu/snooze/drawer/timetable/views/bulk/suggest; forced-colors sweep + screenshot; reduced-motion sweep (0.001s squash); zoom-equivalence via effective viewport; text-only scaling at root 200%.
- UNVERIFIED set (needs real AT): A-A9 body iframe inclusion; gate's live keyboard behavior (preview is signed in); SR browse-mode verbosity after an A-A3 fix.
