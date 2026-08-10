# Audit 32 — The mail signature: final composition and plan

Design only. No code. Follows audits 30 and 31.

**Brief:** fixed metadata plate with a micro-label, composed so the four facts
read as *one* object rather than a 2×2 dashboard.

---

## 1 · Two findings that changed the design before drawing it

### The timestamp is not a fixed-width ruler

`shortDate()` has three formats, and `tabular-nums` aligns digits — it does not
make strings the same length:

```
9:07        ~23px      today, single-digit hour
14:32       ~29px      today
9 Aug       ~28px      this year
23 Sept     ~40px      this year
Aug 2024    ~47px      older
Sept 2023   ~53px      older
```

**A 30px range.** Concept B from audit 31 was built on the time being a stable
anchor. It is not. B is withdrawn.

This also means the plate cannot be sized to "the date" — it must be sized to
the widest thing it will ever hold, and then never move.

### Colour cannot carry the category

I checked the separation between `CAT_COLOR` values:

| pair | RGB distance |
|---|---|
| `other` vs `external-promotions` | **0 — identical hex** |
| `academics` vs `technology` | 38 |
| `administration` vs `technology` | 44 |
| `admin` vs `administration` | 49 |

Two categories share one colour exactly, and four blues sit within a range no
one can name apart on a 6px dot.

**So the micro-label is not a "safe fallback" to colour — it is the primary
identifier, and colour is a secondary grouping cue.** That inverts what I
implied in audit 31 and it is the right way round: the code says *which*, the
colour says *what family*.

### The `ADM` collision, and what it reveals

`admin` and `administration` are both live (32 and 70 address-map entries) and
sit adjacent in `SIDEBAR_ORDER`. Both naïvely shorten to `ADM`.

They cannot be separated by three letters because they are barely separable in
words — `Admin` vs `Administration`. Reading the data: `admin` is generic
institutional accounts (`admin@`, `admin.wilp@`), `administration` is named
offices and deans (`ad.swd@`, `associatedean.fad@`).

**Resolution:** `ADM` (admin) and `OFC` (administration — "office"). Recorded
as a compromise rather than a win. The real fix is to ask whether two
categories a user cannot name apart should be one category, which is a
classifier question and out of scope here.

---

## 2 · The composition

The goal is *one signature*, not four controls. What makes it one object:

**A shared right edge.** Every element is right-aligned to the same invisible
line. Two lines, one edge, one object.

**A deliberate asymmetry.** Not a 2×2 grid — a 2×2 grid reads as a table, which
is exactly the "tiny dashboard" to avoid. Instead: **line one is a single
element, line two is a cluster.** The eye reads it as a heading with a subtitle,
which is a shape people already parse as one unit.

```
        ┌───────────────┐
        │        14:32  │   ← WHEN.  alone, right-aligned, the primary datum
        │  ● ACA     ★  │   ← WHAT.  dot+code grouped left, star anchored right
        └───────────────┘
             58px fixed
```

**Why the time leads.** It is the only fact present on every row, it is what
people navigate by ("the one from Tuesday"), and it is the most frequently
*read* of the four. Putting the variable-width element on its own line is also
what lets the plate stay fixed: the date can be 23px or 53px and the plate
never notices.

**Why the dot and code touch.** `● ACA` is one token, not two — a coloured
bullet immediately followed by its abbreviation is a form people already read as
a single tag (a bullet list, a legend entry). Gap of 4px, not 8: close enough to
bind, far enough not to collide.

**Why the star sits at the far right of line two.** It is the only
*interactive* element in the plate. Separating it from the informational cluster
by the line's free space means the eye never confuses "thing I read" with "thing
I press", and the 28px hit target has room without pushing anything.

**Why 58px and not 62.** The plate is sized to its widest possible content
(`● SPM ★` ≈ 54px, `Sept 2023` ≈ 53px, plus breathing room). That is *narrower*
than today's `min-width: 62px` — so subject lines get wider on every row, and
identically wider on every row.

### The four states

| state | plate |
|---|---|
| unread | code at full contrast, dot at full saturation |
| read | code drops to `--fg-faint`, dot to 60% opacity |
| starred | star filled, `--star` colour |
| low-confidence | code in dashed-underline style (reusing `.tag.low`'s dashed language) |

All four are `color`/`opacity` only. Nothing moves.

### What happens when a course exists

The course chip is the fourth fact and the one that is *usually absent* — it
only shows for enrolled courses. Rather than reserving a permanent slot for it
(which would leave most rows with a hole), **it replaces the code on line two
when present**, with the category demoted to the dot alone:

```
no course:   ● ACA     ★
course:      ● CS F111 ★
```

Justification: if a message is from a course you are enrolled in, the course
*is* the category, more specifically than `ACA` is. The dot still carries the
category, and `title` carries both in full. This is the one place the plate
shows different content — but the geometry, the edge, and the number of lines
are identical.

`CS F111` at 10px ≈ 45px, plus dot and star ≈ 61px — 3px over. So the plate is
**60px** and the course code is the sizing constraint, not the date.

---

## 3 · Implementation plan

No code yet. This is the order I would do it in.

### Step 1 — Data: the micro-label map

New export in `src/classify/categories.js`:

```
CATEGORY_CODES = { augsd:'AUG', academics:'ACA', admin:'ADM',
                   administration:'OFC', ps:'PS', internship:'INT',
                   competitions:'CMP', clubs:'CLB', events:'EVT',
                   library:'LIB', technology:'TEC',
                   'external-services':'SVC', 'external-promotions':'PRO',
                   spam:'SPM', other:'—' }
```

**Test first:** every key in `CATEGORY_LABELS` has a code; every code is unique;
every code is ≤3 characters. That test is what stops a future category being
added with no code, or a second `ADM` slipping in.

### Step 2 — Markup: restructure `.r-right`

`buildRow()` changes from four siblings to two lines:

```html
<span class="r-right">
  <span class="r-date"></span>
  <span class="r-sig">
    <span class="r-dot" aria-hidden="true"></span>
    <span class="r-code"></span>
    <button class="r-star" type="button" tabindex="-1" aria-label="Star"></button>
  </span>
</span>
```

`.r-course` and `.tag` are **removed from the row** — their content moves into
`.r-code` and their full text into `title`. The reader keeps the full tag pill
unchanged.

### Step 3 — CSS

- `.r-right { width: 60px }` — hard, replacing `min-width: 62px`.
- `.r-sig { display:flex; align-items:center; gap:var(--s-1) }` with the star
  pushed right by `margin-left:auto`.
- `.r-dot` reuses the existing `--c` custom-property pattern from `.r-bar`.
- Transitions on `color` and `opacity` only.

### Step 4 — Accessibility

This is where the design can quietly fail, so it gets its own step:

- `.r-code` carries `title` with the **full** category label, so hover and
  most AT read "Academics" not "ACA".
- The row's accessible name must still include the category. Today the `.tag`
  text contributes to it; once shortened, add an `aria-label` on `.r-code` with
  the full label so nothing is lost to a screen reader.
- `.r-dot` is `aria-hidden` — it duplicates `.r-code`.
- Star keeps its 28px target and `aria-pressed`.

### Step 5 — Tests, each sabotage-verified

1. Every category has a unique ≤3-char code *(catches the ADM collision)*.
2. `.r-right` has a fixed width, not `min-width` *(the whole point)*.
3. The plate's width does not vary with category *(render all 15, compare)*.
4. Full category label is reachable via `title`/`aria-label` *(nothing lost)*.
5. Course replaces code when enrolled, dot still shows category.
6. No layout-animating transitions added *(the existing rule)*.
7. Row height unchanged in all three densities *(the sacred constraint)*.

### Step 6 — Verify

`npm run contrast` (the code at `--fg-faint` on all six themes),
`node --test` on the affected files, rebuild `preview.html` and look at it.

---

## 4 · Risks I am carrying into implementation

- **`OFC` is a compromise.** Nobody will guess it means "administration". The
  `title` covers it; the underlying problem is two categories that should
  probably be one.
- **Fifteen codes is a vocabulary to learn.** Mitigated by the sidebar legend
  being permanently visible with full labels, and by the codes being
  prefixes of the words in twelve of fifteen cases.
- **`—` for `other`** is deliberate: a code for "we could not tell" should not
  look like a classification.
- **Contrast at 10px.** Small text has a higher contrast requirement in
  practice than the checker enforces. Worth a manual look on Solarised and
  Nord specifically, which have the lowest-contrast `--fg-faint`.
