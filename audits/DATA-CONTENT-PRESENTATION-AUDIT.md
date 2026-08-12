# DATA & CONTENT PRESENTATION ARCHITECTURE AUDIT (Round 63)

**Charter:** what information does the system present, where, in what
representation, and is every piece worth the space and attention it
consumes? Audit only — **no fixes implemented**. Fourth of the series
(58 hierarchy → 60 interaction → 62 state → 63 content). Evidence standard:
file/symbol for every claim; **UNVERIFIED** where browser measurement would
be needed and wasn't taken; **INTENDED/ACTUAL** where they differ.

---

## 1. EXECUTIVE DIAGNOSIS

**The presentation layer is the most-audited layer in the project (audits
21–26, 30–38, 44–45 all touched it), and it shows: most representation
decisions are explicit, commented, and pinned. The diagnosis is therefore
narrow but real:**

1. **The vocabulary discipline is the layer's crown jewel and it holds.**
   Every temporal question has one formatter matched to the question it
   answers (§11): recency (`shortDate`), calendar deadlines (`relativeLabel`,
   calendar-day math), wake countdowns (`wakeLabel`), send countdowns
   (`statusOf`), sync age (`freshnessLabel`). Cross-surface agreement is
   pinned (radar ≡ reader deadline wording; sidebar ≡ listhead counts).

2. **Truncation is principled but has one genuine gap (F-3):** everything
   clipped carries its full value in a `title` (pinned), filenames use
   middle-truncation (extension survives), but the **timetable week cells**
   clip course text with no full-value recovery on touch (titles exist on
   most, not all, cell contents — §10).

3. **Diagnostic information is correctly gated, not removed:** confidence %,
   classifier reason, deadline evidence, and category corrections appear ONLY
   when they matter (uncertain classification, overridable deadline). This is
   the right answer to "metadata overload" and should be preserved exactly.

4. **Two content costs are worth paying differently (§4, §25):** the row's
   category TAG duplicates the sidebar's position for mail in a
   category-filtered view (context-dependent redundancy — F-2), and the
   conversation COUNT on collapsed rows is valuable but visually equal-weight
   to the sender (F-5, minor).

5. **No critical or major presentation defect found.** What remains is
   moderate-to-opportunity grade, and several "missing information" items
   were already added in rounds 61–62 (in-flight mark, mode readout,
   deadline menu effective value).

---

## 2. COMPLETE CONTENT INVENTORY (source → presentation)

### Message-derived content

| Content | Source | Transform | Presented | Hidden/truncated |
|---|---|---|---|---|
| sender | Gmail `from` | `displayName` (display.js) strips address | row `.r-from`, reader `#r-from` | row: ellipsis + full title; reader: full |
| participants | thread aggregation | `thread().participants` | row `.r-from` (joined) when collapsed | full list in title |
| subject | Gmail `subject` | none (highlighted on query match) | row `.r-subj`, reader `#r-subject`, thread strip | row: nowrap+ellipsis+title; reader full |
| snippet | Gmail snippet → `rowSnippet` (snippet.js) strips salutations/disclaimers/quotes/signatures, '' if it restates subject | row `.r-snip` | hidden in compact density; ellipsis+title |
| body | GET_BODY → sanitize.js | srcdoc iframe, remote images blocked by default | reader body | remote images hidden w/ announce bar |
| date | `date` | `shortDate` (row) / `fullDate` (reader, titles) | row `.r-date`, reader `#r-date` | row relative-form; exact in title/reader |
| category | classifier (`classify`) + corrections | label via CATEGORY_LABELS | row `.tag`, sidebar highlight+counts, reader tag | — |
| confidence | classifier | shown ONLY when < 0.7 or source='you' | reader tag "N% · source" | hidden when confident (diagnostic-on-demand) |
| reason | classifier | shown only when uncertain | reader tag | hidden otherwise |
| unread | Gmail label | bold weight + color + counts | row weight, sidebar/listhead counts, tab title `(N)` | — |
| starred | Gmail label | filled/stroked star icon + aria-pressed | row `.r-star`, reader action, ctx-icon | — |
| attachments | GET_BODY parts | `formatBytes`, `middleTruncate` | reader chips | names middle-truncated, full in title |
| deadline | `extractDeadline` + overrides | `relativeLabel` + urgency band | radar item, reader `#r-due` banner (with evidence quote), lanes | evidence in radar title / reader inline |
| courses | classifier courses + enrolment | `courseChip` (only enrolled courses) | row `.r-course` chip | hidden when not enrolled (anti-noise) |
| thread size | thread().count | plain number | row `.r-count` | hidden for single messages |

### System/queue content

| Content | Source | Presented | Notes |
|---|---|---|---|
| sync age | `state.lastSync` → `freshnessLabel` | sidebar freshness button | "Updated N min ago"; empty until first SUCCESS (trust rule) |
| outbox state | queue item → `statusOf` | outbox rail row | live countdown "Sending in Ns", stuck names the error |
| snoozed | schedule → `wakeLabel` | snoozed rail | "in N hours" + Wake action |
| in-flight verb | inFlight Map (round 62) | row `.in-flight` opacity | the pending-truth mark |
| counts | Store via collapseThreads | sidebar + listhead | ONE choke point, pinned agreement |
| suggestions | store senders + labels + views + history | combobox listbox | label + hint, capped |
| errors | verb failures | toast + banners (offline/worker) | classified by reportError |
| mode | modeOf aggregate (round 62) | listquery readout + bulkbar | stated, not inferred |
| timetable | timetable model | week cells, entries, conflicts, exams | provenance recorded per field |
| activity | activity log | activity layer | truncated on disk, no addresses/subjects |

---

## 3. DATA → UI TRACE MAPS (actual symbols)

### Mail pipeline
```
Gmail API → background/gmail.js (threads/messages)
 → sync.js shaping → app.js ingest()
 → classify/index.js {category, confidence, source, reason}
 → shapeRecords → {dueAt,dueKind,dueText} via deadlines.extractDeadline
 → Store (batch → ONE notify) → scheduleRender (ONE rAF)
 → list.js fillRow ──┬─ .r-from  ← displayName(m.from) [+participants]
                     ├─ .r-subj  ← subject (+setHighlighted on query)
                     ├─ .r-snip  ← rowSnippet(m)
                     ├─ .r-date  ← shortDate(m.date)
                     ├─ .tag     ← CATEGORY_LABELS[m.category] (+low class if <0.7)
                     ├─ .r-course← courseChip(m.courses, enrolment)
                     └─ .r-star / .r-check / .r-count
 → reader.js openMessage ── subject/from/date/tags/#r-due/#r-timetable
                            → loadBody → sanitize → srcdoc
```

### Deadline pipeline (one vocabulary everywhere)
```
mail text → extractDeadline → {dueAt,dueKind,dueText} on the record
 → overrides (deadline-store) → effectiveDeadline (ONE resolver)
 ├─ radar.js: relativeLabel + urgency band, evidence in title
 ├─ reader #r-due: relativeLabel + evidence inline
 ├─ lanes: dueAtOf for lane placement
 └─ deadline menu (round 62): states effective value + source
```

### Outbox pipeline
```
compose doSend → outbox.enqueue (hold window)
 → rail: statusOf(item) live vocabulary (held countdown / sending / retry
   backoff / stuck error) → pump transitions → removal
 → in-flight truth for single mail verbs: inFlight Map → .in-flight row mark
```

---

## 4. INFORMATION VALUE & COST

Value classes assigned (critical / frequent / contextual / occasional /
diagnostic / decorative / redundant / obsolete):

| Content | Value class | Cost | Verdict |
|---|---|---|---|
| subject | critical | 1 row line | earns space |
| sender | critical | part of line 1 | earns space |
| unread state | critical | weight only (no extra element) | cheapest possible |
| snippet | frequent | 1 row line, hideable by density | earns space |
| date | frequent | trailing, xs size | earns space |
| category tag | contextual | small tag | **context-dependent** (F-2) |
| course chip | contextual | small chip, gated by enrolment | earns space (gating is the point) |
| thread count | contextual | inline number | earns space (F-5: weight) |
| confidence/reason | diagnostic | only when uncertain | correct gating |
| deadline evidence | diagnostic | radar: tooltip; reader: inline | correct split (§7) |
| freshness | contextual | one stamp | earns space (trust) |
| in-flight mark | contextual | opacity only | earns (round 62) |
| star icon | frequent | icon slot | earns |
| tab-title count | contextual | outside the app | earns (glanceable) |
| activity entries | occasional | layer, on demand | correct deferral |
| confidence on confident mail | would be noise | — | correctly ABSENT |

**No content found that consumes substantial space with little value.** The
historic noise candidates (confidence everywhere, evidence everywhere,
hover-previews) were each CUT in earlier audits (17 elimination audit) and
have not grown back.

---

## 5. REDUNDANCY AUDIT

| Concept | Appearances | Classification |
|---|---|---|
| category | row tag · reader tag · sidebar highlight/counts | **necessary**: navigation (sidebar) + identification (row/reader). In a category-FILTERED view the row tag restates the filter → F-2 (contextual redundancy) |
| unread | row weight · sidebar count · listhead count · tab title | **useful reinforcement** across glance distances (app glance / tab glance); one source, projections |
| deadline | radar · reader banner · menu | **necessary**: three different tasks (what's coming / what is THIS / correct it). ONE vocabulary pinned |
| counts | sidebar · listhead | **pinned agreement** (R-6) — same derivation, two glance points |
| starred | row · reader · ctx | necessary (both surfaces actionable) |
| freshness | sidebar only | single |
| outbox status | rail only | single |
| suggestions vs views vs palette | three access paths to the same queries | **good redundancy** (round-60 §18: convergent, one engine) |
| draft content | compose panel + autosave copy | **two-layer safety**, not display redundancy |

**Harmful duplication found: none.** The one arguable case (F-2) is
contextual, not accidental.

---

## 6. REPRESENTATION AUDIT (does the form match the meaning?)

| Content | Representation | Match? |
|---|---|---|
| recency | relative ('12m') → clock → date → date+year ladder | ✔ matches "is it recent?" |
| deadline proximity | relative + urgency colour band | ✔ matches "act on it?" |
| deadline evidence | quoted phrase (radar title / reader inline) | ✔ converts uncanny→trustworthy |
| send progress | live countdown text ("Sending in 12s") | ✔ matches "is it going?" |
| stuck send | named error + Retry/Discard | ✔ matches "what failed / what now" |
| unread | weight+color (not a dot) | ✔ cheapest signal that scans |
| confidence | "72% · rule" tag only when uncertain | ✔ diagnostic-on-demand |
| thread-ness | count beside sender | ✔ (F-5: equal weight, minor) |
| mode | text readout chip (round 62) | ✔ stated over inferred |
| in-flight | opacity | ✔ quiet truth, no layout shift |
| category | colored dot + label | ✔ color is reinforcement, never sole carrier (a11y) |
| counts | two numbers, weight/color separated (not "3/41") | ✔ pre-attentive, pinned history |
| sync state | one stamp + banners | ✔ |
| attachments | chips with icon+name+size | ✔ actionable where the frame can't be |
| conflicts | grouped list with both values ("5105 → 6101") | ✔ change reads as change |

**Representation mismatches found: none structural.** F-5 (thread-count
weight) is the only one, minor.

---

## 7. METADATA OVERLOAD

Dense surfaces checked: row (10 elements), reader header (subject/from/date/
tags/actions ≈ 4 metadata rows), timetable cell (course/section/time/room),
outbox row, radar item (2 cols), suggestion (label+hint).

- **Row:** metadata is one line beneath subject; primary (subject/sender)
  dominates. Compact density drops the snippet — density serves scanning.
- **Reader header:** confidence/reason gated; recat is one quiet button;
  banners appear only with content. No metadata competes with the body.
- **Timetable cell:** 3–4 fields; evidence (provenance) is on demand, not
  inline. No overload.
- **Radar:** 2 columns in a narrow rail; evidence deliberately in the title
  (documented: "the one change at risk of reading as noise"). Correct.
- **Suggestion:** label+hint, capped at 8. Correct.

**Verdict:** no metadata overload. Every dense surface has an explicit,
commented hierarchy. The discipline to cite: evidence-in-tooltip for the
narrow rail vs evidence-inline for the wide reader is the SAME fact sized to
its surface — the pattern to reuse.

---

## 8. CONTENT DENSITY AUDIT

| Surface | Elements | Task | Density verdict |
|---|---|---|---|
| list row | subj+from+snip+date+star+tag(+count/course) | scan+decide | supports task; density tunable (3 densities) |
| reader | full header + body | read | spacious by design (68ch measure) |
| sidebar | nav + up to 3 rails | navigate+glance | rails hide when empty (anti dead-whitespace doctrine) |
| timetable grid | 6 day cols × cells | week at a glance | pruned to classed days (round 54) — sparse=correct |
| bulkbar | count + 5 actions | act on N | count dominant, correct |
| suggestions | ≤8 × (label+hint) | complete fast | capped, correct |

Density tracks task everywhere; no surface is dense-for-nothing or
sparse-when-it-shouldn't-be.

---

## 9. TRUNCATION & CLIPPING AUDIT

| Location | Mechanism | Lost? | Recovery | Verdict |
|---|---|---|---|---|
| row subject | nowrap+ellipsis, `.subj-clip` measured | end | full value in `title` (pinned) | ✔ |
| row snippet | nowrap+ellipsis | end | title | ✔ |
| row from | ellipsis | end | title | ✔ |
| attachment names | `middleTruncate` | middle | full in chip title | ✔ extension survives |
| listquery readout | ellipsis, max-width 40ch | end | search box has the full query | ✔ |
| radar what | rail width | end | title carries subject+evidence | ✔ |
| sidebar category names | none (full) | — | — | ✔ |
| timetable cells | cell width | **UNVERIFIED per field**: course text clips; titles exist on most cell contents but coverage per field not measured | partial | **F-3** |
| toast text | none (wraps) | — | — | ✔ |

The truncation doctrine is explicit and pinned ("every ellipsis can actually
fire" gate; "truncated row text carries the full value in a title"). F-3 is
the one gap: **verify timetable cell truncation carries full values on
touch paths** (titles are hover-biased by nature; the audit standard asks
for keyboard/touch recovery).

---

## 10. LONG-CONTENT AUDIT

Realistic worst cases (BITS institutional mail):
- **Subjects** ("Notification regarding revised schedule for the comprehensive
  examination…"): ellipsis+title; bloom gate measures real clipping. ✔
- **Sender names** (department lists): displayName truncation + title. ✔
- **Course codes/names** (chip): gated to enrolled; chip is compact. ✔
- **Attachment names** (institutional PDF naming): middle-truncate preserves
  the extension — the discriminating part. ✔ (the audit that introduced it)
- **Recipient lists** (compose): chips per recipient; long lists scroll. UNVERIFIED at extreme counts.
- **Error messages**: named, wrapped, no truncation. ✔
- **Timetable course text in cells**: F-3 (verify full-value recovery).

No long value found that distorts surrounding architecture (each has a
contained representation).

---

## 11. TEMPORAL INFORMATION AUDIT

| Question asked | Formatter | Representation | Right question? |
|---|---|---|---|
| "Is this recent?" (list) | `shortDate` ladder ('12m'→clock→'12 Aug'→'Aug 2025') | relative→absolute ladder | ✔ |
| "When exactly?" (reader) | `fullDate` | full timestamp | ✔ |
| "When is it due / how soon?" | `relativeLabel` (CALENDAR days, midnight math) | 'due tomorrow' | ✔ (the calendar-day fix is documented) |
| "When does snoozed come back?" | `wakeLabel` | 'in 3 hours' | ✔ |
| "Is it sending now?" | `statusOf` | live 'Sending in 12s' | ✔ |
| "How current is my mail?" | `freshnessLabel` | 'Updated 4 min ago', success-only | ✔ trust rule |
| "What should I act on first?" | urgency bands (radar) | color + order | ✔ |

**One vocabulary per question; no formatter reuse across mismatched
questions.** Cross-surface agreement pinned (radar ≡ reader deadline
wording). This is the layer's strongest property.

---

## 12. STATUS & STATE REPRESENTATION

| State | Representation | Understandable? | Redundant? | Consistent? |
|---|---|---|---|---|
| unread | weight+color+counts | ✔ | projections, one source | ✔ |
| selected | aria-selected + row style | ✔ | a11y+visual agree | ✔ |
| starred | filled/stroked icon + aria-pressed | ✔ | both surfaces | ✔ |
| in-flight | opacity mark (round 62) | ✔ new | single | ✔ |
| pending send | rail countdown | ✔ | single | ✔ |
| stuck | named error + actions | ✔ | single | ✔ |
| due/overdue | urgency band | ✔ | radar+reader agree | ✔ |
| low confidence | dashed/% tag | ✔ only when relevant | gated | ✔ |
| categorized | dot+label | ✔ | sidebar+row agree | ✔ |
| synced/degraded/offline | stamp + banners | ✔ | distinct truths | ✔ |
| muted | dim + data-muted | ✔ | discoverable in place | ✔ |

No state relies on color alone (each has text/weight/aria); no state is
represented inconsistently across surfaces.

---

## 13. INFORMATION PRIORITIZATION (per surface, actual vs ideal)

| Surface | PRIMARY | SECONDARY | CONTEXTUAL | OPTIONAL/DIAGNOSTIC | Actual matches? |
|---|---|---|---|---|---|
| row | subject, sender | snippet, date, unread | category tag, course chip, count | confidence (gated) | ✔ |
| reader | body | subject/from/date | banners, attachments | confidence/reason | ✔ |
| sidebar | nav | counts | rails | freshness | ✔ |
| bulkbar | count | actions | — | — | ✔ |
| timetable | grid/entries | conflicts | provenance | — | ✔ |
| suggestions | label | hint | — | — | ✔ |

No case where secondary dominates primary or diagnostic consumes primary
space.

---

## 14. CONTENT GROUPING

- Row groups by identity (one row = one conversation) — correct for a mail
  client; threading collapse keeps identity grouping honest.
- Radar/outbox/snoozed group by status/task — correct (they are queues).
- Timetable groups by chronology (week grid) + by course (entries) — both
  offered, both correct for their tasks.
- Suggestions group by kind (implicit by order) — acceptable.
- No grouping relies on proximity alone; each group has a heading or rail
  label; empty groups hide (no "heading over dead whitespace").

---

## 15. CROSS-SURFACE CONSISTENCY

| Concept | Surfaces | Consistent? |
|---|---|---|
| deadline wording | radar · reader · menu | ✔ ONE relativeLabel, pinned |
| counts | sidebar · listhead | ✔ one collapseThreads, pinned |
| category color | dot/tag/menu | ✔ one CAT_COLOR |
| date formatting | row(relative)/reader(full) | ✔ deliberately different per question |
| outbox status | rail only | single |
| action labels | bar/bulk/keys/palette | ✔ same verbs |
| star | filled/stroked everywhere | ✔ |
| freshness | sidebar only | single |

The consistency discipline is enforced by pins (R-6 counts, deadline
vocabulary test). No unjustified divergence found.

---

## 16. CONTENT TRANSFORMATION AUDIT

| Raw | Transform chain | Single source? |
|---|---|---|
| timestamp | shortDate(row) / fullDate(reader) / relativeLabel(deadline) / wakeLabel(snooze) / statusOf(outbox) / freshnessLabel(sync) | ✔ one formatter per question, all in display/deadlines/snooze/outbox |
| sender | displayName (display.js) | ✔ |
| snippet | rowSnippet (snippet.js) | ✔ |
| category | CATEGORY_LABELS + CAT_COLOR | ✔ |
| bytes | formatBytes (reader) | ✔ |
| filename | middleTruncate (icons.js) | ✔ |
| count | collapseThreads + setCount | ✔ one choke point |
| deadline | effectiveDeadline → relativeLabel | ✔ |
| selection count | selectionLabel | ✔ |

**No duplicated formatting logic found** — the historic drift (two date
vocabularies for one deadline) was fixed and pinned (R-6). No precision loss
beyond intentional summarization (snippet cleaning is documented and tested).

---

## 17. HIDDEN INFORMATION AUDIT

| Hidden | Where | Appropriate? |
|---|---|---|
| deadline evidence | radar title / reader inline | ✔ sized to surface |
| confidence/reason | shown only when uncertain | ✔ diagnostic-on-demand |
| full clipped values | title tooltips | ✔ (F-3: verify touch/keyboard recovery for timetable cells) |
| provenance | timetable on-demand | ✔ |
| activity log | layer on demand | ✔ (was palette-only; sidebar button added round 58) |
| query history | suggestions | ✔ contextual |
| image allow-list | implicit in the bar | ✔ |
| worker/degraded detail | banner text | ✔ named, not buried |
| undo stack contents | toast drain + Ctrl+Z | ✔ the drain makes the window visible |

No important information is buried; everything hidden is contextual-by-design
with a documented reason. The one verification gap is F-3 (touch/keyboard
access to full clipped values in timetable cells).

---

## 18. INFORMATION THAT SHOULD BE REMOVED

Honest sweep — **almost nothing qualifies**, because the noisy candidates
were already cut in earlier rounds and have not returned:
- Confidence on confident mail: already absent. KEEP absent.
- Evidence on every radar item: already tooltip-only. KEEP.
- Hover preview cards: eliminated (audit era). KEEP eliminated.
- Empty-rail headings: hide-when-empty doctrine. KEEP.

**No removal recommended.** This is itself a finding: the presentation layer
has no dead weight left to cut.

---

## 19. INFORMATION THAT SHOULD BE ADDED

| Addition | Problem solved | Status |
|---|---|---|
| In-flight mark | "landed vs pending" | ✔ ADDED round 62 (H1) |
| Mode readout | mode blindness | ✔ ADDED round 62 (P-3) |
| Deadline effective value | two-store inference | ✔ ADDED round 62 (P-2) |
| Remaining-pages volume | "Load more" gives no sense of remaining | OPEN (L2, minor, deferred) |
| Mark-read grace visibility | grace timer invisible | OPEN (L3, minor, deferred — behavior correct) |
| Outbox live projection | rail lag | GATED on Chrome verdict (H2) |

No further additions recommended beyond the already-tracked minors; the
layer communicates what users need.

---

## 20. REPRESENTATION ALTERNATIVES (evaluated for the open findings)

**F-2 (category tag in filtered view):**
- Current: tag always shown.
- Alt A: hide tag when the view IS that category. Scan speed ↑, but a row's
  category in "All mail" vs a category view becomes inconsistent.
- Alt B: keep, but dim when it matches the active filter.
- Verdict: **DEFER** — cost is one small tag; consistency argues for
  keeping it; revisit only if density work demands.
**F-3 (timetable cell truncation):**
- Alt A: full-value title on every cell field (verify coverage).
- Alt B: tap-to-expand cell.
- Verdict: **RESTRUCTURE** (A first — cheap, matches the row doctrine).
**F-5 (thread-count weight):**
- Alt: lighter weight/size for the count so sender dominates.
- Verdict: **OPPORTUNITY**, minor; cheap.

---

## 21. CONTENT ARCHITECTURE BY SURFACE (condensed)

| Surface | Required | Supporting | Contextual | Doesn't belong |
|---|---|---|---|---|
| list row | subject, sender, unread | snippet, date | tag, course, count | confidence (correctly absent) |
| reader | body | subject/from/date | banners, attachments | confidence except when uncertain |
| sidebar | nav | counts | rails | settings (correctly elsewhere) |
| topbar | search | mode readout | save-view | theme/density (moved to Appearance) |
| compose | fields | draft state | invalid-address warn | — |
| outbox rail | status | countdown | retry/discard | — |
| timetable | grid/entries | conflicts/exams | provenance | — |
| empty/error | what+why+next | — | — | — |

Every surface's "doesn't belong" column is already respected.

---

## 22. COMPLETE CONTENT ARCHITECTURE MAPS

### A. Data → Presentation
```
Gmail → sync → classify/extractDeadline → Store(batch→1 notify→1 rAF)
 → fillRow(subject/sender/snippet/date/tag/course/count/star)
 → reader(subject/from/date/tags/#r-due/#r-timetable/body)
 → radar(relativeLabel) · lanes(dueAtOf) · menu(effective value)
```
### B. Information hierarchy
```
Row:    subject/sender → snippet/date → tag/course/count → confidence(gated)
Reader: body → subject/from/date → banners → attachments → confidence
Sidebar: nav → counts → rails → freshness
```
### C. Cross-surface concept map
```
deadline: radar(relativeLabel) ≡ reader(#r-due) ≡ menu(effective) [pinned]
count:    sidebar ≡ listhead [collapseThreads, pinned]
category: row.tag ≡ reader.tag ≡ sidebar highlight [CAT_COLOR]
unread:   row.weight · counts · tab-title [one source]
```
### D. Transformation map — §16 table.
### E. Hidden-information map — §17 table.
### F. Redundancy map — §5 table.

---

## 23. RANKED FINDINGS

### CRITICAL — none.
No information is missing, misleading, or incorrectly represented in a way
that harms task completion.

### MAJOR — none.

### MODERATE
- **F-3 timetable cell truncation recovery.** Cell text clips; full-value
  recovery relies on hover-biased titles. Verify/extend full-value access on
  touch/keyboard. (§9, §10, §17)

### MINOR
- **F-2 category tag restates the active filter.** Contextual redundancy;
  cheap to dim; defer unless density demands. (§5, §13)
- **F-5 thread-count equal weight.** Count reads equal to sender; a lighter
  weight would let sender dominate. (§6)
- **L2 remaining-pages volume** and **L3 grace visibility** — carried from
  the interaction audit, still minor. (§19)

### OPPORTUNITY
- **Evidence-sized-to-surface** as a reusable pattern (radar-tooltip vs
  reader-inline for the same fact) — document as the house pattern. (§7)

**Finding count is deliberately small.** The presentation layer is the most
audited in the project; inflating findings here would misrepresent it.

---

## 24. VALUE VS COST (for each open recommendation)

| Change | User value | Cost | Verdict |
|---|---|---|---|
| F-3 cell full-value recovery | touches every timetable glance; touch users | small (titles/expand) | DO (cheap, real) |
| F-2 dim tag in filtered view | tiny scan gain | small; consistency risk | DEFER |
| F-5 count weight | tiny | trivial | OPPORTUNITY |
| L2 remaining volume | reduces "how much more" uncertainty | needs total from API | DEFER (needs data) |
| L3 grace visibility | explains a correct-but-invisible timer | risks noise | DEFER |

---

## 25. FINAL RECOMMENDATIONS

### KEEP (the crown jewels)
- One-vocabulary-per-temporal-question discipline (pinned).
- Diagnostic-on-demand gating (confidence/reason/evidence).
- Hide-when-empty rails; counts via one choke point.
- Truncation-with-full-title doctrine (pinned gates).
- Evidence-sized-to-surface pattern.

### RESTRUCTURE
- **F-3:** ensure every timetable cell field carries its full value for
  touch/keyboard (title coverage or tap-to-expand).

### RELOCATE / CONSOLIDATE / REMOVE
- None. Nothing is misplaced, over-represented, or dead weight.

### DEFER
- F-2 (dim redundant tag), L2 (remaining volume), L3 (grace visibility).

### ADD
- None beyond already-tracked minors.

### REDESIGN
- None. No representation is fundamentally wrong.

---

## 26. EXECUTIVE SUMMARY (for the next agent)

The content layer is healthy and heavily disciplined. Every temporal
question has one matched formatter, cross-surface agreement is pinned,
truncation always carries the full value, diagnostic metadata is gated to
appear only when it matters, and there is no dead weight left to remove.
Three findings remain, none above moderate: **F-3** timetable cell
full-value recovery on touch/keyboard (do it — cheap and real), **F-2**
redundant category tag in filtered views (defer), and **F-5** thread-count
weight (opportunity). The house pattern worth carrying forward: **size the
same fact to its surface** (evidence in a tooltip on the narrow rail, inline
on the wide reader). No redesign is warranted; the layer needs at most a
small, targeted fix.
