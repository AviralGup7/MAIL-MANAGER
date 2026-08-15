# Under-Engineered Parts Audit — where the codebase is thin *relative to itself*

**Commit:** `a18f6a5` (main, clean tree, in sync with origin)
**Question asked:** not "what is broken" — **which portions are lacking compared
to the other parts.**
**Method:** every number below was produced by a script run against this
commit, not estimated. The scripts are reproduced inline so the measurements
can be re-run.

This is a *relative* audit. The standard is not an external ideal; it is **this
project's own best work**. `platform/`, `app/core/`, `features/` and
`background/` show what this author does when engineering carefully. The
finding is that several subsystems were built to a visibly lower standard, and
the gap is measurable, consistent across independent metrics, and concentrated
in a way that predicts where the next defect will come from.

---

## 0 · The one-paragraph answer

**The UI presentation layer is under-engineered relative to the data layer, and
`app/overlays/` is the weakest subsystem in the codebase.** Behavioural test
density spans a **20× range** across subsystems (5.9 → 118.7 assertions per 100
lines of code). The four thinnest — `app/overlays`, `app/workspace`,
`app/compose`, `app/search` — are all presentation, all have zero fuzz
coverage, all sit outside the type-checked scope, and none of their open states
is ever seen by the accessibility gate. Meanwhile `classify/` is a special
case: strong tests, but the **lowest comment density in the tree (0.20)** in a
codebase whose defining characteristic is explanatory comments, and 1,059 lines
of it are generated. The single largest untested surface is **7,997 lines of
CSS**, 3,512 of which no test references at all.

---

## 1 · Behavioural test density — the primary measure

Each test file was attributed to the subsystem it imports most; assertions in
files that read source text with `readFileSync` and assert with
`assert.match` are counted separately as **source pins**, because those pass on
dead code and fail on renames. "Behavioural" = total assertions minus source
pins.

| Subsystem | code LOC | asserts | src pins | **behavioural / 100 LOC** |
|---|---:|---:|---:|---:|
| **app/overlays** | 1,537 | 126 | 36 | **5.9** ← weakest |
| classify | 1,788 | 123 | 0 | 6.9 |
| **app/workspace** | 500 | 73 | 21 | **10.4** |
| **app/compose** | 853 | 121 | 2 | **14.0** |
| **app/search** | 872 | 152 | 21 | **15.0** |
| app/mail | 2,598 | 478 | 77 | 15.4 |
| background (worker) | 1,506 | 341 | 13 | 21.8 |
| app/motion | 932 | 222 | 7 | 23.1 |
| app/academic | 3,207 | 854 | 73 | 24.4 |
| app/system | 1,649 | 683 | 91 | 35.9 |
| features (outbox/snooze) | 420 | 226 | 18 | 49.5 |
| platform | 107 | 91 | 21 | 65.4 |
| app/core | 599 | 804 | 93 | **118.7** ← strongest |

**`app/core` is tested 20× more densely than `app/overlays`.** Both are app-layer
code. That is not a difference in kind, it is a difference in care.

**Correction applied honestly:** `app/main.js` (2,000 code lines) and
`src/takeover/` show 0 here, which is an attribution artefact, not reality.
They are exercised through `test/helpers/app-harness.mjs`, which boots the real
`main.js` in jsdom — **765 assertions across 8 integration parts, 223 tests**.
`content.js` is exercised by `takeover.test.mjs` via `win.eval(SRC)`. Both are
covered; they are simply covered *indirectly*, which is its own finding (§5).

## 2 · Comment density — this project's own signature, unevenly applied

The defining quality of this codebase is that non-obvious decisions carry a
paragraph explaining the bug that motivated them. Measured as comment lines ÷
code lines:

| Subsystem | files | code | comment | **c/c** | JSDoc per 100 LOC |
|---|---:|---:|---:|---:|---:|
| **classify** | 7 | 1,788 | 364 | **0.20** ← thinnest | 1.8 |
| **options** | 1 | 346 | 129 | **0.37** | 2.3 |
| **app/overlays** | 10 | 1,537 | 840 | **0.55** | 3.8 |
| app/motion | 13 | 932 | 537 | 0.58 | 7.8 |
| app/compose | 4 | 853 | 515 | 0.60 | 4.1 |
| app/search | 6 | 872 | 566 | 0.65 | 6.2 |
| app/academic | 15 | 3,207 | 2,084 | 0.65 | 6.2 |
| app/workspace | 5 | 500 | 367 | 0.73 | 4.2 |
| app/mail | 15 | 2,598 | 2,145 | 0.83 | 6.3 |
| app/system | 15 | 1,649 | 1,392 | 0.84 | 6.4 |
| app/main.js | 1 | 2,000 | 1,709 | 0.85 | 3.5 |
| app/core | 8 | 599 | 532 | 0.89 | 8.7 |
| background | 8 | 1,506 | 1,623 | **1.08** | 7.0 |
| features | 2 | 420 | 459 | **1.09** | 8.3 |
| platform | 4 | 111 | 157 | **1.41** ← richest | 9.9 |

`classify/` at 0.20 is partly explained: 1,059 of its 1,788 lines are
**generated** (`pattern-rules.js`, `address-map.js`, regenerated from the data
pack and drift-checked in CI). Excluding generated files it rises to roughly
0.50 — still the thinnest hand-written subsystem, and it holds the scoring
weights nobody has re-tuned since v1 (`SENDER_EXACT_BONUS = 80`,
`DIMINISHING_RETURNS_FACTOR = 0.6`) with a comment that says only "carried over
verbatim… I have no better numbers".

**`app/overlays` at 0.55 with 3.8 JSDoc/100 has no such excuse.** It is
hand-written UI with the second-thinnest documentation and the thinnest tests.

## 3 · Type checking — 14% of modules

```
tsconfig include: src/globals.d.ts, src/app/system/**, src/app/mail/store.js
→ 16 of 115 modules (14%), and strict: false
```

Deliberate and documented ("SCOPE IS DELIBERATE… widening is a separate
decision per folder"). But the effect is that the compiler-checked 14% is
*already* the best-tested 14%. **Type checking was added where confidence was
highest, not where risk was highest.** Unchecked: all of `src/background/`
(the worker, OAuth, the Gmail wire layer), all of `app/main.js`, all of
`classify/`, all of `features/`, and every UI module except `store.js`.

## 4 · Fuzz / property coverage — presentation has none

15 fuzz suites exist. Mapped to the subsystem they target:

| Subsystem | fuzz suites |
|---|---:|
| app/academic | 4 |
| background | 3 |
| app/system | 2 |
| classify · features · app/mail · app/search · app/compose | 1 each |
| **app/overlays** | **0** |
| **app/workspace** | **0** |
| **app/motion** | **0** |
| **platform** | 0 (but 65.4 behavioural/100 — covered conventionally) |

The three zeros are all presentation. `app/overlays` renders **user-controlled
and mail-derived strings** into menus, dialogs, toasts and the palette — the
same class of input that `fuzz-sanitize-depth` and `fuzz-display` exist to
police elsewhere.

## 5 · Accessibility — the gate is far narrower than it looks

```
test/a11y.test.mjs: axe.run() on 2 static documents (app.html, options.html)
                    restricted to 9 rules
grep -rn "axe" test/*.mjs → appears in NO other test file
```

The extension has **10 overlay modules** (dialog, menu, palette, category-menu,
snooze-menu, rules-editor, settings-panel, toast, help, layers). Not one is
ever opened in front of axe. The audited surface is the *empty shell* — before
any dialog opens, any menu roves, any toast announces, or any focus is trapped.

Three of those ten have **no dedicated test file at all**: `dialog.js`,
`category-menu.js`, `snooze-menu.js`. `dialog.js` is the modal primitive —
focus trapping, escape handling and focus restoration are exactly the things
axe on a static shell cannot see and a modal primitive must get right.

Mitigating: `announce-semantics.test.mjs`, `focus-restore.test.mjs`,
`layers.test.mjs` and the integration parts do test focus and live regions
behaviourally. So the *behaviour* has some cover; the **automated a11y gate**
does not extend past two static files, and the repo's own A-A9 debt (no real
screen-reader pass) is still open.

## 6 · CSS — the largest wholly-unguarded surface

**7,997 lines** across 30 files. 22 test files reference *some* CSS, but only
12 files by name. **19 files totalling 3,512 lines are referenced by no test:**

| Unreferenced | lines |
|---|---:|
| 72-timetable.css | 850 |
| 62-features.css | 359 |
| 60-appearance.css | 328 |
| 44-reader-head.css | 237 |
| 64-motion.css | 234 |
| 14-panes.css | 218 |
| 30-reader.css | 197 |
| 68-depth.css | 194 |
| 42-rails.css | 169 |
| 50-gate.css | 161 |
| …9 more | 565 |

`check-contrast.mjs` audits theme token colours and `visual-regression.mjs`
exists, but neither reads these files. The reader's own stylesheets
(`30-reader.css`, `44-reader-head.css` = 434 lines) are unguarded, and the
reader is where untrusted mail is displayed.

## 7 · Coverage of the modules the gate does not protect

The coverage gate fences **6 of 115 modules**. Measured across the fast
non-jsdom suites, the weakest genuinely-critical modules are:

| Module | line | branch | func |
|---|---:|---:|---:|
| **src/background/auth.js** | 41–68% | **35–47%** | **6–65%** |
| src/app/academic/deadlines.js | 42.6% | — | 0% |
| src/background/sync.js | 48–64% | 22–94% | 28–71% |
| src/app/system/audience.js | 56.3% | — | 0% |
| src/app/search/query.js | 79.7% | 68.7% | 54.2% |

`auth.js` is the **security-critical module with the worst branch coverage in
the tree**, and it is not in the gate. Its uncovered ranges are the ones that
matter: the interactive `authorize()` path, the `renew()` mismatch/revocation
ladder, `signOut()` revocation, and `scheduleRenewRetry`. This is the module
implementing a flow (implicit grant) that OAuth 2.1 removed — the place where
change is most likely and verification is thinnest.

`sync.js` shows 94% branch on one path and 22% on another depending on which
suite drives it, which means the *branch* number in the gate (floor: 85) is
measuring one narrow slice, not the module.

## 8 · Ranking — most under-engineered first

Combining behavioural density, comment density, fuzz, types, and a11y reach.
"Relative gap" is against this project's own median, not an external standard.

| Rank | Portion | Evidence | Relative gap |
|---|---|---|---|
| **1** | **`app/overlays/` (1,537 LOC)** | 5.9 behavioural/100 (worst), c/c 0.55, 3.8 JSDoc/100, **0 fuzz**, unchecked by tsc, **0 axe**, 3 of 10 modules untested (incl. `dialog.js`, the modal primitive) | **Severe** |
| **2** | **CSS (7,997 LOC)** | 3,512 lines referenced by no test; reader stylesheets unguarded; contrast gate covers tokens only | **Severe** |
| **3** | **`src/background/auth.js`** | 35–47% branch, 6–65% function, not in the coverage gate, implements a sunsetting flow | **High** |
| **4** | **`app/workspace/` (500 LOC)** | 10.4 behavioural/100, 29% of its assertions are source pins, 0 fuzz, c/c 0.73 | **High** |
| **5** | **`classify/` (1,788 LOC)** | c/c 0.20 — thinnest in a comment-driven codebase; untuned v1 scoring constants; only 1 fuzz suite for the subsystem that decides where every message lands | **High** |
| **6** | **`app/compose/` (853 LOC)** | 14.0 behavioural/100, c/c 0.60, 4.1 JSDoc/100 — and it builds MIME and sends mail | **Medium-High** |
| **7** | **`app/search/` (872 LOC)** | 15.0 behavioural/100, 21 source pins, O(vocabulary) prefix scan still unaddressed | **Medium** |
| **8** | **`src/options/` (346 LOC)** | c/c 0.37, never loaded as a module by any test (HTML-driven only), ships v1's client ID behind a one-click button | **Medium** |
| **9** | **`app/motion/` (932 LOC)** | 0 fuzz, c/c 0.58 — but 23.1 behavioural/100 is respectable; risk is cosmetic | **Low-Medium** |
| **10** | **`app/main.js` (2,000 code lines)** | Well covered *indirectly* (765 integration assertions) but has **no unit-level test of its own**; 22 catches, 41% of them empty | **Low-Medium** (a structural risk, not a coverage one) |

## 9 · The pattern behind the ranking

Three consistent signals, all pointing the same way:

1. **Data layer engineered, presentation layer assembled.** `platform` (65
   behavioural/100, c/c 1.41), `features` (49.5, 1.09) and `background` (21.8,
   1.08) are the top three on *both* measures. `overlays` (5.9, 0.55),
   `workspace` (10.4, 0.73) and `compose` (14.0, 0.60) are near the bottom on
   both. The correlation is not a coincidence — the same care produces both
   the tests and the comments.

2. **Verification was added where it was easy, not where it was risky.** The
   type-checked 14% is the best-tested 14%. The coverage gate fences 6 modules,
   5 of which already exceed 86% line. `auth.js` — worst branch coverage,
   highest security stakes — is in neither.

3. **The a11y and CSS gates measure the static shell.** Both stop precisely
   where the dynamic, user-facing behaviour begins.

## 10 · Cheapest high-value closures

Ordered by value ÷ effort, smallest first. None is started here — this is an
audit.

1. **Add `auth.js` to the coverage gate** with floors at its current measured
   values, then raise them. One line in `tools/coverage-gate.mjs`; makes the
   worst-covered security module unable to get worse.
2. **Run axe against opened overlays.** The harness already boots the app and
   can open a dialog; `a11y.test.mjs` already has the axe runner. Wiring one to
   the other covers 10 modules and closes the largest a11y blind spot.
3. **Give `dialog.js`, `category-menu.js`, `snooze-menu.js` dedicated tests.**
   Three files, and `dialog.js` is a focus-management primitive.
4. **Widen `tsconfig.include` to `src/background/**`.** Highest-risk unchecked
   code; the seam modules already prove the pattern works.
5. **One fuzz suite for `app/overlays`** feeding mail-derived strings into menu
   and toast rendering — the input class already fuzzed elsewhere.
6. **Document the classifier's scoring constants** or mark them explicitly
   untuned-and-inherited, so the next reader knows they are v1 artefacts rather
   than measured values.
7. **Extend the CSS guard** to at least the reader stylesheets (434 lines),
   which style untrusted content.

## 11 · What I did not measure, and why

- **Runtime behaviour.** Same standing limitation as every audit in this
  directory: never executed in Chrome. All CSS and a11y findings are static.
- **Mutation score.** `tools/mutate.mjs` exists but is not in CI, so the
  *quality* of the dense test areas is unverified — `app/core` at 118
  assertions/100 LOC could still be shallow. Density is a proxy for care, not a
  proof of it.
- **`app/academic` (3,207 LOC, the largest subsystem)** scores mid-table
  (24.4 behavioural/100, 4 fuzz suites) and was not read closely. It is not
  under-engineered by these measures; it may still hold defects.
- **Per-file coverage is noisy** under `--experimental-test-coverage` with
  multiple processes; ranges are quoted rather than single figures, and the
  ranking uses them only as corroboration, never as the sole basis.

---

*Audit only. No production file was modified.*
