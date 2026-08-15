# BITS Mail Manager — UI Innovation and Cyberpunk Reference Audit

**Date:** 2026-08-15  
**Scope:** every UI-facing or UI-adjacent source volume in `app.html`, `options.html`, `src/app/**`, `src/styles/**`, `src/options/**`, and `src/takeover/**`; current Cyberpunk theme; downloaded Cyberpunk 2077 interface references; general product-interface opportunities.  
**Mode:** analysis only. This report proposes no copied artwork, fonts, icons, sounds, text, or proprietary assets.

---

## 1. Executive conclusion

The existing interface is far more mature than a typical extension: it has a coherent token system, seven themes, strong focus semantics, a real overlay layer, deliberate reduced-motion behavior, bounded spectacle, a capable mail workspace, a command palette, saved searches, responsive rails, and unusually rigorous visual tests. The Cyberpunk skin is also technically disciplined: it is isolated behind one theme gate, uses finite motion, obeys user texture/sound settings, avoids copyrighted game assets, and preserves the application’s behavior.

Its main weakness is not lack of polish. It is that the visual language is **broad “neon cyberpunk” rather than a complete operational interface system**. The current skin relies on scanlines, cyan glow, uppercase controls, chamfers, red/cyan text fringing, and occasional yellow slabs. Cyberpunk 2077’s strongest interface work is more structured:

- dense but disciplined perimeter telemetry;
- subsystem-specific color coding;
- thin, measured rules rather than glow everywhere;
- large negative-space fields surrounded by compact data clusters;
- asymmetric panel composition;
- segmented top-level navigation;
- a single obvious active slab/cursor;
- layered micro-labels, coordinates, indexes, and status numerals;
- contextual diagrams, node graphs, brackets, and focus frames;
- distinct visual modes for character data, terminal operations, warnings, and selection.

The current Cyberpunk theme therefore scores:

| Dimension | Score | Judgment |
|---|---:|---|
| Technical isolation | **9.5/10** | Excellent gate discipline; other themes do not inherit the skin. |
| Accessibility restraint | **8.5/10** | Reduced motion, texture and sound authority are strong. Some microtext/glow proposals must remain optional. |
| General cyberpunk mood | **8/10** | Cyan/red/black, scanlines, hard geometry and glitch cues read immediately. |
| Cyberpunk 2077 UI grammar similarity | **6/10** | Captures surface motifs, but not enough hierarchy, navigation grammar, subsystem palettes or telemetry structure. |
| Product usefulness | **7.5/10** | Most styling does not harm workflow; a few effects are decorative rather than informative. |
| Depth and completeness across surfaces | **6.5/10** | Buttons/dialogs/list/toast are covered; reader, search, settings, timetable, activity, compose internals and empty/loading states need a stronger unified system. |
| Overall current Cyberpunk theme | **7.3/10** | Safe and attractive foundation; ready for a system-level second generation. |

### Primary recommendation

Do **not** add more indiscriminate glow, scanlines, glitch, particles or uppercase text. Instead, make the theme feel like an information system:

1. Build a Cyberpunk-specific **information grammar**, not merely a skin.
2. Give each product subsystem a controlled accent role.
3. Use telemetry, IDs, status codes and diagrams only when they communicate real state.
4. Reserve solid slabs and high luminance for the current target/action.
5. Keep content text calm; concentrate spectacle in chrome, transitions and state boundaries.
6. Preserve every existing accessibility escape hatch.

---

## 2. Reference images downloaded and analyzed

The five downloaded references are stored under:

- `image-search/cyberpunk-2077-ui-hud-menu-inventory-scr-1.png`
- `image-search/cyberpunk-2077-ui-hud-menu-inventory-scr-2.png`
- `image-search/cyberpunk-2077-ui-hud-menu-inventory-scr-3.png`
- `image-search/cyberpunk-2077-ui-hud-menu-inventory-scr-4.png`
- `image-search/cyberpunk-2077-ui-hud-menu-inventory-scr-5.png`

Source gallery: `https://interfaceingame.com/games/cyberpunk-2077/`

These are used strictly as visual references for comparative analysis.

### Reference 1 — attribute/perk overview

Observed characteristics:

- Extremely dark blue-black field with a restrained red top rail.
- Cyan is reserved for the active node, its connector and its detail-card controls.
- The central diagram is the composition anchor; surrounding labels are secondary.
- Hexagonal and chamfered nodes carry numeric state and icons, not decoration alone.
- The right inspection card is a separate dark panel with thin red border and cyan body copy.
- Tiny perimeter marks and footer commands create a device-frame feeling without filling the center.
- Top navigation is compressed, evenly spaced and stateful; content begins below a very thin rule.
- Brightness is concentrated in the selected node and current title.

Mail Manager comparison:

- Existing chamfers and cyan active accents align well.
- Current theme glows many controls uniformly; the reference makes one target bright and leaves most options dim.
- Mail Manager lacks a comparable “state diagram” view. Rules, categories, sync lifecycle, timetable conflict resolution and automation would benefit from diagrammatic modes.

### Reference 2 — perk detail tree

Observed characteristics:

- Layered navigation: global navigation, category tabs, then the node canvas.
- Red is structural; cyan is selection/interaction; yellow signals available resources.
- Locked/unavailable nodes are present but visually recede rather than disappear.
- The active node has a cyan square cursor and emits a local halo; neighboring nodes remain low contrast.
- A small detail card is anchored near the selection rather than detached in a modal.
- Progress bars and resource counts provide immediate “what changes if I act?” context.

Mail Manager comparison:

- Saved views, automation rules and category corrections could expose a similarly layered model.
- Current menus often replace context with an overlay. Anchored inspectors could reduce mode switches.
- The existing command palette’s active row is a good foundation, but locked/unavailable states need richer explanation.

### Reference 3 — terminal/minigame interface

Observed characteristics:

- A subsystem palette shift: acid green dominates instead of the normal red/cyan shell.
- Monospaced data list, buffer rail, breach-time status and sequence target all share one task vocabulary.
- Thick bright green selection slabs coexist with thin lime structural lines.
- Dense texture is localized to the terminal, not applied uniformly to every screen.
- The interface communicates urgency through counters and constrained space, not through continuous animation.

Mail Manager comparison:

- Current Cyberpunk skin is globally red/cyan/yellow. It could assign controlled mode palettes: search cyan, deadlines amber, destructive actions red, timetable green, sync/status blue.
- The timetable workspace is the best candidate for a terminal mode, but must retain contrast and avoid turning normal text into tiny monospaced data.
- “Sync diagnostics” and rule dry-run could use a bounded terminal presentation.

### Reference 4 — character database

Observed characteristics:

- Left navigation is a compact hierarchical database; selected row is a solid red slab.
- The subject occupies the visual center; biography data is in a narrow right rail.
- Index glyphs and folder-like icons make hierarchy legible.
- Category headings are small and quiet. Selected data, not every heading, gets saturation.
- Red copy is used against near-black with careful size and spacing; the layout relies on large negative space.

Mail Manager comparison:

- Current sidebar uses a conventional mail navigation pattern. A Cyberpunk variant could add quiet section codes and stronger selected-row slabs without changing semantics.
- The reader could become the “subject dossier”: sender identity left/center, metadata and actionable intelligence in a narrow right rail.
- Current reader tags are visually secondary but lack structured dossier groupings.

### Reference 5 — appearance editor

Observed characteristics:

- Strong three-column composition: presets, visual subject, property editor.
- Each property row has a label, current value and directional controls.
- Selection is explicit and rectangular; values align to a strict rhythm.
- The central visual receives space; controls remain dense but scannable.
- A warning/status strip sits under the title rather than becoming a modal.

Mail Manager comparison:

- Settings currently use forms and theme tiles. Cyberpunk mode could use an inspector-style settings layout with aligned values and immediate preview.
- The theme picker should show a miniature live shell sample, not only a color dot/name.
- Density, motion, texture and sound settings should become a single visual “interface calibration” panel.

---

## 3. Cyberpunk 2077 visual grammar extracted from the references

### 3.1 Color is semantic, not merely atmospheric

- **Red:** global structure, navigation, danger, system framing.
- **Cyan:** active selection, confirmed interaction, data focus.
- **Yellow/amber:** resources, warnings, attention, availability.
- **Green/lime:** terminal operations, successful data execution, constrained technical modes.
- **Dark navy/black:** the dominant field; not every container needs a visibly different surface.

Recommended Mail Manager mapping:

| Product state | Theme role |
|---|---|
| Current message, selected filter, active command | Cyan |
| Destructive action, authentication failure, permanent send failure | Red |
| Deadline, account mismatch warning, uncertain delivery | Amber |
| Successful sync, local cache health, timetable validation | Green |
| Structural rules, global chrome, inactive navigation | Muted red/neutral line |
| User-created label/category color | Preserve user color, constrained to a chip/marker |

### 3.2 Brightness is scarce

The references do not make every border neon. Most lines are dim. The active target receives the strongest fill or halo. Mail Manager should reduce default glows and create a strict luminance ladder:

1. background;
2. passive structural line;
3. readable text;
4. current region;
5. active target;
6. urgent exception.

### 3.3 Interfaces are composed around a dominant object

- Perk tree: central graph.
- Character database: character model.
- Appearance editor: avatar.
- Terminal: active code grid.

For Mail Manager, dominant objects should be:

- inbox: selected conversation and message trajectory;
- reader: sender/message dossier;
- timetable: week grid;
- search: query intent and result set;
- settings: live interface preview;
- activity: operation timeline;
- rules: rule graph and dry-run result.

### 3.4 Dense data lives at edges

The reference screens leave center space and push telemetry to borders, headers and footers. Mail Manager currently distributes secondary controls throughout the topbar and rails. A Cyberpunk-specific layout should consolidate low-frequency telemetry at the perimeter while keeping core mail actions near the message.

### 3.5 Geometry communicates hierarchy

- Solid rectangular slab: selected target.
- Thin outlined panel: available context.
- Chamfered card: inspected entity/module.
- Small square cursor: focus/selection.
- Connector line: relationship or flow.
- Bracket frame: current region.

Current theme applies chamfers broadly. It should diversify geometry by meaning.

### 3.6 Microcopy looks machine-generated but remains human-readable

Useful additions include real IDs, counts, statuses and timestamps—not fake random hex everywhere. Examples:

- `INBOX / 042`
- `SYNC / COMMITTED`
- `CACHE / 487 RECORDS`
- `THREAD / 6 MESSAGES`
- `DELIVERY / UNCERTAIN`
- `RULE / MATCHED 18`
- `ACCOUNT / VERIFIED`

Avoid meaningless coordinates, fake error codes or constantly changing numerals.

---

## 4. Current Cyberpunk theme: what works and what does not

### What works

1. All skin selectors are gated by `html[data-theme='cyberpunk']`.
2. Arrival motion is finite and reduced-motion-safe.
3. Texture and synthesized interface sounds can be disabled independently.
4. Theme color comes from tokens rather than uncontrolled literals.
5. Scanlines are subtle enough to avoid fully obscuring content.
6. Chamfered menus/dialogs/toasts create a clear theme identity.
7. Selection slab, square tags and masthead strips are closer to the reference grammar than generic neon styling.
8. Cyan/red subject fringing is static and bounded to hover.
9. Theme isolation tests are unusually strong.
10. No game art, fonts or audio are shipped.

### What should change

1. **Glow is too democratic.** Every hovered button receives a similar corona; references reserve intense light for the active target.
2. **Geometry is too uniform.** Buttons, dialogs and compose share the same cut vocabulary; selected rows, inspectors, terminal panels and navigation should have distinct shapes.
3. **The theme lacks a navigation system.** Topbar controls remain ordinary buttons rather than a segmented operating strip.
4. **No subsystem palettes.** Timetable, search, settings, activity and compose all use the same broad theme expression.
5. **Scanlines are global.** References localize heavier texture to terminals or specific modes.
6. **Micro-label hierarchy is underdeveloped.** There are few section codes, state captions, resource counts or perimeter labels.
7. **Reader is under-themed.** It remains a conventional mail reader rather than a dossier/inspection interface.
8. **Settings are under-themed.** Theme selection does not preview the actual design language.
9. **Search does not feel like a query console.** Operators/chips exist functionally but lack a visual parsing hierarchy.
10. **Timetable does not capitalize on the terminal/operations reference.**
11. **Empty/error/loading states do not form one Cyberpunk state language.**
12. **Motion is motif-based rather than state-based.** Flicker/glitch indicates theme arrival but not data prepare/commit/uncertain transitions.
13. **The current yellow masthead can dominate too many rails.** Yellow should signal attention/availability, not every section heading.
14. **All-uppercase buttons reduce shape contrast and can harm scanning.** Keep caps for system verbs and labels; allow sentence case for explanatory actions.
15. **No strong active square cursor across major lists.** The selected row’s edge glow is present, but the focus grammar is not reused consistently.

---

## 5. General innovative UI improvements

The following ideas apply across themes unless explicitly marked Cyberpunk-only.

### 5.1 Inbox and list intelligence

1. Add a **conversation trajectory rail** showing oldest→newest participants, reply count and latest state.
2. Add a **reason lens**: hover/focus category to reveal why the classifier chose it.
3. Introduce **confidence-aware styling**: uncertain classification gets a quiet dotted marker and one-click correction.
4. Add **time-density modes**: chronological, deadline-first, sender-clustered and thread-activity views.
5. Add a **new-since-last-visit divider** based on committed sync state.
6. Add a **mail provenance marker**: live Gmail, local cache, server search overlay, queued local action.
7. Show **action outcome states** directly on rows: pending, committed, failed, uncertain.
8. Add an **inbox health strip** with unread, overdue, uncertain-send and stale-cache counts.
9. Add **semantic row preview expansion** without opening the reader.
10. Let users pin **three persistent lenses** (deadline, sender, course, label, attachment).
11. Add **thread heat** based on recent participant activity, not arbitrary color.
12. Add **quiet bulk preview**: before committing, show exact affected count and Gmail labels.
13. Add **mail age histogram** as a small optional navigator.
14. Add a **“why is this here?” action** combining mailbox, label and classification explanations.
15. Add **review queue mode** for low-confidence classifications and failed automation.

### 5.2 Reader and message comprehension

16. Turn the reader header into a **message dossier** with identity, account, thread and authenticity cues.
17. Add a **thread timeline** that reveals message order and gaps without rendering full bodies.
18. Add **key facts extraction cards**: deadline, location, course, contact, attachment and requested action.
19. Add a **reply intent preview**: who will receive reply/reply-all before compose opens.
20. Add a **quote minimap** for long threads.
21. Add a **trusted-sender image policy badge** near sender identity.
22. Add **attachment risk and type summaries** without opening files.
23. Add **reader reading-position persistence** per thread.
24. Add **compare revisions** when a draft or thread metadata changes.
25. Add **message source transparency**: header date versus Gmail internal date, only in advanced diagnostics.
26. Add a **focus reading mode** that removes rails but preserves actions in a compact edge toolbar.
27. Add **structured keyboard hints** that appear contextually after an action, not permanently.
28. Add a **summary-vs-original split** if summarization is ever introduced; never replace original content invisibly.

### 5.3 Search and command system

29. Make query chips a **live parse tree**, grouping AND/OR/negation visually.
30. Add **query result explanations** for a selected message.
31. Add **search scope controls**: local cache, Gmail server, current mailbox, all mail.
32. Add a **query cost/freshness indicator**: instant local versus remote Gmail.
33. Add **saved-view previews** showing likely count before activation.
34. Add **operator autocomplete with examples**, not only syntax names.
35. Add a **search history timeline** with pin/rename/delete.
36. Add a **natural-language-to-query preview** only if translation remains inspectable and editable.
37. Add command-palette **result grouping** by navigation, action, setting, label and view.
38. Add **command consequences** in secondary text: “archives 12 selected messages.”
39. Add **recent/frequent/adaptive commands** while preserving deterministic keyboard ordering.
40. Add **zero-result recovery suggestions** that never silently broaden the query.

### 5.4 Compose and outbox

41. Make the outbox a first-class **delivery center** with pending, held, uncertain, failed and sent states.
42. Add a **send transaction timeline**: queued → hold → dispatch → Gmail acknowledgement.
43. For uncertain delivery, show **Check Sent**, Retry and Discard as distinct choices.
44. Add **recipient chips with domain/account warnings**.
45. Add **reply-context preview** showing thread, recipients and quoted section.
46. Add **attachment budget visualization**.
47. Add **draft recovery history** with a small number of local checkpoints.
48. Add a **scheduled/held send countdown** that pauses when offline.
49. Show **account identity** beside Send when multiple Google sessions exist.
50. Add **template variables preview** and unresolved-variable blocking.
51. Add a **compose focus mode** with a calm central editor and compact metadata rails.
52. Add a **delivery ledger** so queued = sent + failed + cancelled + pending + uncertain is visible.

### 5.5 Timetable and academic intelligence

53. Add a **conflict radar** with exact overlaps and recommended alternatives.
54. Add **mail-to-course linking** visible in both timetable and reader.
55. Add a **deadline axis** over the week grid.
56. Add **class-change diff mode** showing old and new schedule.
57. Add a **day compression slider** for dense weeks.
58. Add **travel-time warnings** between rooms if campus map data becomes reliable.
59. Add **exam-period mode** with a different information hierarchy.
60. Add **academic source provenance** for every extracted timetable fact.
61. Add **what changed since import** summary.
62. Add **calendar export preview** with timezone and recurrence details.

### 5.6 Settings and personalization

63. Replace plain theme tiles with **live miniature shell previews**.
64. Add a **visual calibration screen** for density, motion, texture, contrast and sound.
65. Add **per-theme intensity**, not only on/off textures.
66. Add a **focus-profile preset**: calm, balanced, information-dense.
67. Add **keyboard profile visualization** and conflict detection.
68. Add **settings search** with matched-section highlighting.
69. Add **reset scope preview** explaining exactly what will be cleared.
70. Add **privacy/storage dashboard** showing counts and approximate local size.
71. Add **account transition settings** with explicit retained/quarantined data policy.
72. Add **accessibility preview** for reduced motion, high contrast and text scaling.

### 5.7 Reliability as interface

73. Show committed facts separately from optimistic state.
74. Use a consistent **pending/committed/failed/uncertain** visual vocabulary.
75. Add an **operation center** for sync, outbox, account and storage events.
76. Add **recovery actions next to errors**, not only descriptions.
77. Add **safe diagnostic export** with privacy preview.
78. Show **offline capabilities**: what remains available and what is queued.
79. Distinguish **Gmail unavailable**, **worker unavailable**, **authentication needed** and **local storage full**.
80. Add a **last successful full reconciliation** indicator separate from last delta.
81. Add **repair progress** for cache rebuild/migration.
82. Add a **state provenance tooltip** to freshness indicators.

### 5.8 Accessibility innovation

83. Add a persistent, optional **keyboard mode map** that updates by context.
84. Add **screen-reader verbosity settings** for row summaries.
85. Add **focus history restoration** across workspace changes.
86. Add a **high-visibility current target cursor** independent of color.
87. Add **motion intent labels** in settings: functional, spatial, decorative.
88. Add **forced-colors-specific testing and tokens**.
89. Add **reading-order visualization** in development diagnostics.
90. Add **large-text stress mode** in preview tooling.
91. Add **one-handed/pointer-coarse layout tuning** beyond larger hit targets.
92. Add **sound alternatives as visual/haptic-like cues**; never make sound carry unique information.

---

## 6. Detailed Cyberpunk theme improvement backlog

### 6.1 Foundation and tokens

**CP-001.** Add explicit Cyberpunk tokens for structural red, active cyan, warning amber, terminal lime and passive telemetry. Do not overload `accent`, `danger` and `star` for every role.

**CP-002.** Add a luminance ladder (`--cp-line-passive`, `--cp-line-active`, `--cp-fill-selected`, `--cp-text-data`) derived from existing theme colors.

**CP-003.** Add separate shape tokens for slab, inspector, terminal and navigation—not one universal cut.

**CP-004.** Add micro-label typography tokens: size floor, line height, caps tracking and monospaced fallback. Keep body/subject typography unchanged.

**CP-005.** Add texture intensity token controlled by settings: off, low and standard.

**CP-006.** Add a “calm Cyberpunk” accessibility preset that keeps color/geometry but removes scan, sound, fringing and glitch.

**CP-007.** Reduce default button glow by approximately half; reserve strong glow for current selection and keyboard focus.

**CP-008.** Replace some box shadows with one-pixel edge lights; this is closer to the references and cheaper visually.

### 6.2 Global shell

**CP-009.** Turn the topbar into a segmented operating strip with compact section labels and one active region.

**CP-010.** Add quiet perimeter telemetry: account verified, cache state, sync commit state and current mailbox count.

**CP-011.** Add corner registration marks to major panes using pseudo-elements; no extra DOM.

**CP-012.** Add a thin global red structural rule and reserve cyan for focus/selection.

**CP-013.** Introduce a bottom status rail on wide layouts for keyboard hints and operation state; collapse it entirely on narrow layouts.

**CP-014.** Make the brand block read as a system identity plate rather than a conventional logo lockup.

**CP-015.** Add real version/build information only in an advanced hover/focus detail, not permanent noise.

**CP-016.** Replace the global vignette’s red dominance with a subtler neutral field; red should be structural, not a constant error mood.

### 6.3 Sidebar and navigation

**CP-017.** Use a solid slab for the selected mailbox/category, matching the character database reference.

**CP-018.** Add square focus cursor independent of the slab so keyboard position remains obvious.

**CP-019.** Add compact group codes such as `SYS / MAILBOXES`, `IDX / CATEGORIES`, but keep accessible names human-readable.

**CP-020.** Make unread/total counts align as tabular numerals.

**CP-021.** Reduce yellow rail mastheads; use amber only for groups needing attention.

**CP-022.** Add a low-contrast connector line from group heading to selected child.

**CP-023.** Treat muted categories like locked nodes: present but receded, with reason on focus.

**CP-024.** Add a data-state glyph for account-owned, local-only or quarantined rails.

### 6.4 Message list

**CP-025.** Add a small cyan square cursor on the active row.

**CP-026.** Use a solid dark-red or cyan-tinted slab only for actual selection, not hover.

**CP-027.** Turn row metadata into aligned columns with tabular time/count figures.

**CP-028.** Add a quiet thread connector for consecutive messages from the same conversation.

**CP-029.** Use category color as a two-pixel data marker rather than a large decorative chip where density matters.

**CP-030.** Add a confidence notch/pattern for classification uncertainty.

**CP-031.** Add committed-state micro-labels: `LOCAL`, `LIVE`, `PENDING`, `UNCERTAIN` only when relevant.

**CP-032.** Reduce chromatic text fringe frequency; apply only during explicit pointer hover and never to unread body text.

**CP-033.** Add row “inspection brackets” on keyboard focus.

**CP-034.** Make bulk selection a temporary subsystem mode with a clear mode header and exit route.

**CP-035.** Show the new-mail divider as a thin cyan transmission line with count.

**CP-036.** Give empty states a diagnostic structure: state code, human explanation, next action.

### 6.5 Reader dossier

**CP-037.** Restyle the reader as an inspected entity: subject as title, sender/account/thread as data rail.

**CP-038.** Add a narrow right-side intelligence rail on wide screens for deadline, category, labels, attachments and thread count.

**CP-039.** Use a centered message body on a calm surface; do not apply scanlines over body content.

**CP-040.** Add thread timeline nodes with one active cyan node.

**CP-041.** Present sender details as a compact identity card with trust/image policy.

**CP-042.** Use amber for uncertain or extracted facts and cyan for confirmed Gmail metadata.

**CP-043.** Add a small source marker for cached/offline copies.

**CP-044.** Convert reader action overflow into grouped system verbs: communication, organization, destructive.

**CP-045.** Add an anchored contextual inspector instead of opening a modal for simple category/deadline corrections.

**CP-046.** Make attachments rectangular data modules with type, size, source and action.

### 6.6 Search and palette

**CP-047.** Render query operators as a parse chain with connector rules.

**CP-048.** Use different accent roles for operator, value, negation and grouping while preserving contrast.

**CP-049.** Add a query execution status: `LOCAL / 18`, `REMOTE / RUNNING`, `COMMITTED / 42`.

**CP-050.** Present suggestions like terminal completions: active slab, command class, consequence.

**CP-051.** Give the palette a central-cursor grammar and dim nonmatching command groups.

**CP-052.** Add an inline detail inspector for the active command/saved view.

**CP-053.** Keep search text in normal readable typography; use monospace only for operators and state labels.

### 6.7 Compose and outbox

**CP-054.** Treat compose as a communication console with a calm editor center and narrow metadata rails.

**CP-055.** Add an account identity plate beside Send.

**CP-056.** Show recipient validation as small status modules rather than colored text alone.

**CP-057.** Turn outbox rows into transaction records with a real state timeline.

**CP-058.** Give uncertain delivery an amber state, not the same red as permanent failure.

**CP-059.** Use a finite dispatch sweep tied to actual state transition, never a decorative loop.

**CP-060.** Add a sent acknowledgement pulse only after Gmail returns an ID.

**CP-061.** Present Retry as a deliberate override when outcome is unknown; require clearer copy than ordinary failure retry.

### 6.8 Timetable and academic surfaces

**CP-062.** Give timetable an optional terminal-lime subsystem palette inspired by the breach interface.

**CP-063.** Use a top buffer/status strip for conflicts, source validity and selected course.

**CP-064.** Present course sections as data nodes with connectors to meetings.

**CP-065.** Add a selected-course inspector instead of crowding every grid cell.

**CP-066.** Use amber availability/resource cues for unresolved sections.

**CP-067.** Animate only the selected course trajectory, not the full grid.

**CP-068.** Add a real operation log for imports and timetable changes.

### 6.9 Settings and options

**CP-069.** Reframe theme settings as `SET UI PROFILE` with live preview.

**CP-070.** Show Cyberpunk intensity controls beside the preview: texture, sound, motion, glow.

**CP-071.** Align settings rows like the appearance editor: label, value, control.

**CP-072.** Use left presets, center preview, right property inspector on wide options pages.

**CP-073.** Add immediate keyboard and screen-reader summaries for each appearance change.

**CP-074.** Remove hardcoded inline status colors in `src/options/options.js`; use semantic classes/tokens so options can truly share themes.

**CP-075.** Make backup/reset/auth sections visually distinct system modules, not identical fieldsets.

### 6.10 Loading, error and recovery states

**CP-076.** Define four state colors and labels: preparing, committed, failed, uncertain.

**CP-077.** Replace generic skeleton shimmer in Cyberpunk with low-motion block acquisition while keeping the shared fallback.

**CP-078.** Add a clear `WORKER / DEGRADED` status module rather than relying only on a warning banner.

**CP-079.** Present account mismatch as a security boundary event with exact recovery action.

**CP-080.** Present storage-full as capacity telemetry with approximate usage.

**CP-081.** Present migration/repair as step progress with safe cancel/resume semantics.

**CP-082.** Never use glitch for errors; glitch implies instability without explaining recovery.

### 6.11 Motion and sound

**CP-083.** Map motion to state transitions: prepare, commit, reject, switch, inspect.

**CP-084.** Keep the theme-arrival flicker, but shorten or remove it on repeated same-session selection.

**CP-085.** Add a single active-node handoff animation between list and reader.

**CP-086.** Use connector-line drawing for rule/timetable relationships, bounded to the active path.

**CP-087.** Reduce hover animation; use immediate edge-light state for dense controls.

**CP-088.** Assign sounds only to commit, error, open console and selection—not every hover/click.

**CP-089.** Provide independent volume/intensity only if sound remains a substantial feature; otherwise preserve on/off simplicity.

**CP-090.** Ensure every sound has simultaneous visual state and never carries unique information.

### 6.12 Responsive behavior

**CP-091.** On narrow screens, collapse telemetry before content or core actions.

**CP-092.** Convert dossier side rail to a bottom sheet without losing reading position.

**CP-093.** Preserve the selected square cursor when labels truncate.

**CP-094.** Avoid multi-line uppercase system labels at 480–600 px.

**CP-095.** Remove scan textures on low-end/reduced-data profiles if paint cost is measured.

**CP-096.** Test every chamfer against clipped focus outlines and popover overflow.

---

## 7. Priority roadmap

### P0 — clarify the visual grammar

- Define semantic subsystem colors and luminance ladder.
- Decide geometry meanings.
- Reduce generic glow.
- Write a one-page Cyberpunk design doctrine.
- Add a live reference page containing every component/state.

### P1 — high-impact shell and list

- Selected slab/cursor system.
- Segmented top navigation.
- Perimeter telemetry using real state.
- Row provenance and pending/uncertain state.
- Revised sidebar group hierarchy.

### P2 — reader and compose

- Reader dossier structure.
- Thread timeline.
- Attachment data modules.
- Compose communication console.
- Outbox transaction presentation.

### P3 — subsystem modes

- Search/query console.
- Timetable terminal-lime mode.
- Activity operation timeline.
- Rules graph/dry-run inspector.

### P4 — settings and calibration

- Live theme previews.
- Cyberpunk intensity controls.
- Three-column wide options layout.
- Tokenize options-page status colors.

### P5 — evidence and accessibility

- Screenshot matrix for Cyberpunk at 480/600/860/1280 and three densities.
- Contrast and forced-colors checks.
- Reduced-motion and texture-off screenshots.
- Paint/scroll benchmark with texture on/off.
- Manual keyboard and screen-reader pass.

---

## 8. Acceptance criteria

1. One active target is always visually dominant; passive controls do not glow equally.
2. Color roles remain semantic across all surfaces.
3. Body text and email content never receive scanline or chromatic distortion.
4. Keyboard focus is visible without relying on glow or color alone.
5. Texture, sound and motion remain independently suppressible.
6. Cyberpunk selectors remain completely gated.
7. No proprietary game asset, font, icon, audio, text or logo ships.
8. Every telemetry label reflects real product state.
9. Narrow layouts remove decorative telemetry before core functionality.
10. Theme-on/theme-off screenshots prove no geometry leaks to other themes.
11. Contrast passes for every theme-specific state, not only token pairs.
12. Performance remains within existing render thresholds with textures enabled.

---

## 9. File-by-file audit appendix

The generated appendix below inventories every UI or remotely UI-relevant source file and assigns its design-review lens. “Review” does not mean the file is defective; it identifies how it participates in a future UI overhaul.

| File | LOC | Audit lens / recommended role |
|---|---:|---|
| `app.html` | 979 | Static semantics and surface inventory: preserve accessible structure; add only meaningful state/preview regions. |
| `options.html` | 337 | Static semantics and surface inventory: preserve accessible structure; add only meaningful state/preview regions. |
| `src/app/academic/activity-ui.js` | 88 | Academic UI: conflict/deadline/course provenance, selected-object inspector and bounded subsystem mode. |
| `src/app/academic/activity.js` | 233 | Academic UI: conflict/deadline/course provenance, selected-object inspector and bounded subsystem mode. |
| `src/app/academic/deadline-store.js` | 280 | Academic UI: conflict/deadline/course provenance, selected-object inspector and bounded subsystem mode. |
| `src/app/academic/deadlines.js` | 369 | Academic UI: conflict/deadline/course provenance, selected-object inspector and bounded subsystem mode. |
| `src/app/academic/followups.js` | 211 | Academic UI: conflict/deadline/course provenance, selected-object inspector and bounded subsystem mode. |
| `src/app/academic/lanes.js` | 221 | Academic UI: conflict/deadline/course provenance, selected-object inspector and bounded subsystem mode. |
| `src/app/academic/my-courses.js` | 239 | Academic UI: conflict/deadline/course provenance, selected-object inspector and bounded subsystem mode. |
| `src/app/academic/notices-rail.js` | 62 | Academic UI: conflict/deadline/course provenance, selected-object inspector and bounded subsystem mode. |
| `src/app/academic/notices.js` | 271 | Academic UI: conflict/deadline/course provenance, selected-object inspector and bounded subsystem mode. |
| `src/app/academic/radar.js` | 210 | Academic UI: conflict/deadline/course provenance, selected-object inspector and bounded subsystem mode. |
| `src/app/academic/rule-engine.js` | 349 | Academic UI: conflict/deadline/course provenance, selected-object inspector and bounded subsystem mode. |
| `src/app/academic/timetable-mail.js` | 517 | Academic UI: conflict/deadline/course provenance, selected-object inspector and bounded subsystem mode. |
| `src/app/academic/timetable-store.js` | 206 | Academic UI: conflict/deadline/course provenance, selected-object inspector and bounded subsystem mode. |
| `src/app/academic/timetable-ui.js` | 1434 | Academic UI: conflict/deadline/course provenance, selected-object inspector and bounded subsystem mode. |
| `src/app/academic/timetable.js` | 1102 | Academic UI: conflict/deadline/course provenance, selected-object inspector and bounded subsystem mode. |
| `src/app/compose/autocomplete.js` | 157 | Compose/outbox UI: communication console, recipient/account certainty, delivery transaction timeline and recovery actions. |
| `src/app/compose/compose.js` | 837 | Compose/outbox UI: communication console, recipient/account certainty, delivery transaction timeline and recovery actions. |
| `src/app/compose/draft-store.js` | 178 | Compose/outbox UI: communication console, recipient/account certainty, delivery transaction timeline and recovery actions. |
| `src/app/compose/outbox.js` | 678 | Compose/outbox UI: communication console, recipient/account certainty, delivery transaction timeline and recovery actions. |
| `src/app/compose/templates.js` | 302 | Compose/outbox UI: communication console, recipient/account certainty, delivery transaction timeline and recovery actions. |
| `src/app/core/contacts.js` | 245 | Shared UI primitive/trust boundary: preserve semantics, text safety, icon coherence and framework-independent reuse. |
| `src/app/core/display.js` | 112 | Shared UI primitive/trust boundary: preserve semantics, text safety, icon coherence and framework-independent reuse. |
| `src/app/core/dom.js` | 27 | Shared UI primitive/trust boundary: preserve semantics, text safety, icon coherence and framework-independent reuse. |
| `src/app/core/icons.js` | 140 | Shared UI primitive/trust boundary: preserve semantics, text safety, icon coherence and framework-independent reuse. |
| `src/app/core/reset-registry.js` | 44 | Shared UI primitive/trust boundary: preserve semantics, text safety, icon coherence and framework-independent reuse. |
| `src/app/core/sanitize.js` | 385 | Shared UI primitive/trust boundary: preserve semantics, text safety, icon coherence and framework-independent reuse. |
| `src/app/core/selectors.js` | 114 | Shared UI primitive/trust boundary: preserve semantics, text safety, icon coherence and framework-independent reuse. |
| `src/app/core/shortcuts.js` | 141 | Shared UI primitive/trust boundary: preserve semantics, text safety, icon coherence and framework-independent reuse. |
| `src/app/mail/bulk.js` | 368 | Mail workflow UI: align pending/committed/failed/uncertain states and preserve keyboard behavior. |
| `src/app/mail/bulkbar.js` | 48 | Mail workflow UI: align pending/committed/failed/uncertain states and preserve keyboard behavior. |
| `src/app/mail/intents.js` | 207 | Mail workflow UI: align pending/committed/failed/uncertain states and preserve keyboard behavior. |
| `src/app/mail/list.js` | 1144 | Message-list renderer: add semantic classes/data attributes for cursor, provenance, confidence and operation state. |
| `src/app/mail/mailboxes.js` | 154 | Mail workflow UI: align pending/committed/failed/uncertain states and preserve keyboard behavior. |
| `src/app/mail/reader-frame.js` | 50 | Mail workflow UI: align pending/committed/failed/uncertain states and preserve keyboard behavior. |
| `src/app/mail/reader.js` | 1137 | Reader controller: expose dossier/thread/provenance state without putting styling policy in JS. |
| `src/app/mail/row-actions.js` | 199 | Mail workflow UI: align pending/committed/failed/uncertain states and preserve keyboard behavior. |
| `src/app/mail/rules.js` | 317 | Mail workflow UI: align pending/committed/failed/uncertain states and preserve keyboard behavior. |
| `src/app/mail/selection.js` | 216 | Mail workflow UI: align pending/committed/failed/uncertain states and preserve keyboard behavior. |
| `src/app/mail/snippet.js` | 279 | Mail workflow UI: align pending/committed/failed/uncertain states and preserve keyboard behavior. |
| `src/app/mail/store.js` | 600 | UI data source: preserve deterministic derived state; expose real counts/status rather than fake telemetry. |
| `src/app/mail/undo-actions.js` | 72 | Mail workflow UI: align pending/committed/failed/uncertain states and preserve keyboard behavior. |
| `src/app/mail/undo.js` | 116 | Mail workflow UI: align pending/committed/failed/uncertain states and preserve keyboard behavior. |
| `src/app/main.js` | 3892 | Composition root: keep design policy in modules/CSS; wire real state for telemetry and prevent new monolithic UI branches. |
| `src/app/motion/camera.js` | 115 | Motion primitive: reuse for functional focus/handoff only; cap lifetime and honor reduced motion. |
| `src/app/motion/light.js` | 128 | Motion primitive: reuse for functional focus/handoff only; cap lifetime and honor reduced motion. |
| `src/app/motion/magnetic.js` | 163 | Motion primitive: reuse for functional focus/handoff only; cap lifetime and honor reduced motion. |
| `src/app/motion/morph.js` | 161 | Motion primitive: reuse for functional focus/handoff only; cap lifetime and honor reduced motion. |
| `src/app/motion/numbers.js` | 67 | Motion primitive: reuse for functional focus/handoff only; cap lifetime and honor reduced motion. |
| `src/app/motion/particles.js` | 256 | Motion primitive: reuse for functional focus/handoff only; cap lifetime and honor reduced motion. |
| `src/app/motion/pill.js` | 109 | Motion primitive: reuse for functional focus/handoff only; cap lifetime and honor reduced motion. |
| `src/app/motion/press.js` | 110 | Motion primitive: reuse for functional focus/handoff only; cap lifetime and honor reduced motion. |
| `src/app/motion/reader-morph.js` | 156 | Motion primitive: reuse for functional focus/handoff only; cap lifetime and honor reduced motion. |
| `src/app/motion/ripple.js` | 89 | Motion primitive: reuse for functional focus/handoff only; cap lifetime and honor reduced motion. |
| `src/app/motion/spring.js` | 143 | Motion primitive: reuse for functional focus/handoff only; cap lifetime and honor reduced motion. |
| `src/app/motion/tokens.js` | 50 | Motion primitive: reuse for functional focus/handoff only; cap lifetime and honor reduced motion. |
| `src/app/motion/wire-micro.js` | 73 | Motion primitive: reuse for functional focus/handoff only; cap lifetime and honor reduced motion. |
| `src/app/overlays/category-menu.js` | 213 | Overlay interaction: active slab, anchored inspector, focus lifecycle, escape order and consequence text. |
| `src/app/overlays/dialog.js` | 212 | Overlay interaction: active slab, anchored inspector, focus lifecycle, escape order and consequence text. |
| `src/app/overlays/help.js` | 44 | Overlay interaction: active slab, anchored inspector, focus lifecycle, escape order and consequence text. |
| `src/app/overlays/layers.js` | 309 | Overlay interaction: active slab, anchored inspector, focus lifecycle, escape order and consequence text. |
| `src/app/overlays/menu.js` | 304 | Overlay interaction: active slab, anchored inspector, focus lifecycle, escape order and consequence text. |
| `src/app/overlays/palette.js` | 502 | Overlay interaction: active slab, anchored inspector, focus lifecycle, escape order and consequence text. |
| `src/app/overlays/rules-editor.js` | 226 | Overlay interaction: active slab, anchored inspector, focus lifecycle, escape order and consequence text. |
| `src/app/overlays/settings-panel.js` | 560 | Overlay interaction: active slab, anchored inspector, focus lifecycle, escape order and consequence text. |
| `src/app/overlays/snooze-menu.js` | 50 | Overlay interaction: active slab, anchored inspector, focus lifecycle, escape order and consequence text. |
| `src/app/overlays/toast.js` | 121 | Overlay interaction: active slab, anchored inspector, focus lifecycle, escape order and consequence text. |
| `src/app/search/query.js` | 562 | Search UI: visual parse hierarchy, local/remote scope, result explanation and active-command inspector. |
| `src/app/search/saved-views.js` | 159 | Search UI: visual parse hierarchy, local/remote scope, result explanation and active-command inspector. |
| `src/app/search/search-chips.js` | 194 | Search UI: visual parse hierarchy, local/remote scope, result explanation and active-command inspector. |
| `src/app/search/server-search.js` | 139 | Search UI: visual parse hierarchy, local/remote scope, result explanation and active-command inspector. |
| `src/app/search/suggest-ui.js` | 258 | Search UI: visual parse hierarchy, local/remote scope, result explanation and active-command inspector. |
| `src/app/search/suggest.js` | 254 | Search UI: visual parse hierarchy, local/remote scope, result explanation and active-command inspector. |
| `src/app/system/backup.js` | 262 | UI-adjacent system state: expose truthful provenance/recovery information without leaking infrastructure into components. |
| `src/app/system/body-cache.js` | 324 | UI-adjacent system state: expose truthful provenance/recovery information without leaking infrastructure into components. |
| `src/app/system/cache.js` | 365 | UI-adjacent system state: expose truthful provenance/recovery information without leaking infrastructure into components. |
| `src/app/system/cyberpunk-fx.js` | 153 | Cyberpunk behavior owner: state-based finite effects and sparse sound; maintain theme/sound/reduced-motion gates. |
| `src/app/system/deep-links.js` | 215 | UI-adjacent system state: expose truthful provenance/recovery information without leaking infrastructure into components. |
| `src/app/system/direct.js` | 151 | UI-adjacent system state: expose truthful provenance/recovery information without leaking infrastructure into components. |
| `src/app/system/fallback.js` | 370 | UI-adjacent system state: expose truthful provenance/recovery information without leaking infrastructure into components. |
| `src/app/system/root-attrs.js` | 58 | Preference authority: add intensity/calibration controls with explicit user authority. |
| `src/app/system/settings.js` | 370 | Preference authority: add intensity/calibration controls with explicit user authority. |
| `src/app/system/snooze.js` | 218 | UI-adjacent system state: expose truthful provenance/recovery information without leaking infrastructure into components. |
| `src/app/system/storage-registry.js` | 85 | UI-adjacent system state: expose truthful provenance/recovery information without leaking infrastructure into components. |
| `src/app/system/themes.js` | 343 | Theme data authority: add semantic Cyberpunk roles and live-preview metadata; reset every shape token on switch. |
| `src/app/system/view-store.js` | 203 | UI-adjacent system state: expose truthful provenance/recovery information without leaking infrastructure into components. |
| `src/app/workspace/rail-visibility.js` | 104 | Workspace navigation/rails: selected slab/cursor, real telemetry, account-aware queue state and narrow-layout collapse. |
| `src/app/workspace/rails.js` | 349 | Workspace navigation/rails: selected slab/cursor, real telemetry, account-aware queue state and narrow-layout collapse. |
| `src/app/workspace/sidebar-more.js` | 71 | Workspace navigation/rails: selected slab/cursor, real telemetry, account-aware queue state and narrow-layout collapse. |
| `src/app/workspace/sidebar.js` | 359 | Workspace navigation/rails: selected slab/cursor, real telemetry, account-aware queue state and narrow-layout collapse. |
| `src/styles/00-tokens.css` | 460 | Token authority: add reusable luminance, geometry, telemetry and intensity scales without theme-specific leakage. |
| `src/styles/10-shell.css` | 395 | Global shell/depth: segmented navigation, scarce glow, semantic geometry, perimeter telemetry. |
| `src/styles/12-topbar.css` | 70 | Global shell/depth: segmented navigation, scarce glow, semantic geometry, perimeter telemetry. |
| `src/styles/14-panes.css` | 218 | Inbox/list hierarchy: selected slab, square cursor, metadata rhythm, provenance and state markers. |
| `src/styles/20-list.css` | 514 | Inbox/list hierarchy: selected slab, square cursor, metadata rhythm, provenance and state markers. |
| `src/styles/22-skeleton.css` | 57 | Shared visual volume: verify Cyberpunk additions compose without specificity, overflow, contrast or theme leakage. |
| `src/styles/30-reader.css` | 197 | Reader dossier: identity, thread timeline, intelligence rail, calm content field. |
| `src/styles/32-text-discipline.css` | 118 | Shared visual volume: verify Cyberpunk additions compose without specificity, overflow, contrast or theme leakage. |
| `src/styles/40-suggest.css` | 175 | Shared visual volume: verify Cyberpunk additions compose without specificity, overflow, contrast or theme leakage. |
| `src/styles/42-rails.css` | 169 | Shared visual volume: verify Cyberpunk additions compose without specificity, overflow, contrast or theme leakage. |
| `src/styles/44-reader-head.css` | 237 | Reader dossier: identity, thread timeline, intelligence rail, calm content field. |
| `src/styles/50-gate.css` | 161 | Shared visual volume: verify Cyberpunk additions compose without specificity, overflow, contrast or theme leakage. |
| `src/styles/52-toast.css` | 22 | Shared visual volume: verify Cyberpunk additions compose without specificity, overflow, contrast or theme leakage. |
| `src/styles/54-responsive.css` | 50 | Responsive/density authority: remove telemetry before content; preserve focus and target geometry. |
| `src/styles/60-appearance.css` | 328 | Calibration/settings: live previews, aligned property editor and intensity controls. |
| `src/styles/62-features.css` | 359 | Overlay/compose/palette surfaces: inspector hierarchy, active target and consequence copy. |
| `src/styles/64-motion.css` | 234 | Motion authority: map movement to state transitions; prevent decorative competition. |
| `src/styles/66-iconography.css` | 58 | Shared visual volume: verify Cyberpunk additions compose without specificity, overflow, contrast or theme leakage. |
| `src/styles/68-depth.css` | 1078 | Global shell/depth: segmented navigation, scarce glow, semantic geometry, perimeter telemetry. |
| `src/styles/72-timetable.css` | 850 | Academic terminal mode: selected-course inspector, conflict/status strip, bounded lime subsystem palette. |
| `src/styles/80-compression.css` | 75 | Responsive/density authority: remove telemetry before content; preserve focus and target geometry. |
| `src/styles/82-spatial-memory.css` | 36 | Shared visual volume: verify Cyberpunk additions compose without specificity, overflow, contrast or theme leakage. |
| `src/styles/84-dialogs.css` | 79 | Overlay/compose/palette surfaces: inspector hierarchy, active target and consequence copy. |
| `src/styles/86-v3-skin.css` | 748 | Global shell/depth: segmented navigation, scarce glow, semantic geometry, perimeter telemetry. |
| `src/styles/87-settings.css` | 341 | Calibration/settings: live previews, aligned property editor and intensity controls. |
| `src/styles/88-cyberpunk.css` | 339 | Cyberpunk system owner: implement semantic palettes, hierarchy, cursor/slab grammar and surface completeness here. |
| `src/styles/90-motion-system.css` | 112 | Motion authority: map movement to state transitions; prevent decorative competition. |
| `src/styles/99-reduced-motion.css` | 28 | Accessibility authority: verify every new theme motion and delay is neutralized. |
| `src/options/options.js` | 534 | Full options UI: remove inline colors, share tokens, add live preview and clear system-module hierarchy. |
| `src/takeover/content.js` | 417 | Takeover transition: preserve Gmail restoration, iframe isolation, reduced motion and fast handoff. |
| `src/takeover/takeover.css` | 106 | Takeover transition: preserve Gmail restoration, iframe isolation, reduced motion and fast handoff. |

---

## 10. Final recommendation

The next Cyberpunk iteration should be judged by whether it makes the mail system easier to read, navigate and trust—not by how many neon effects it contains. The highest-value move is a semantic operating grammar: one active target, scarce brightness, real telemetry, account/delivery provenance, subsystem palettes, dossier-style inspection and calm content fields. Build that grammar first; then let scanlines, sound, glitch and particles remain optional seasoning.
