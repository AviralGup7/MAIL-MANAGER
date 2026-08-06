# 09 · Post-change architectural audit

**Subject:** BITS Mail Manager at `04125bf`, after roughly twenty commits of
feature work, defect hunting and refactoring.
**Question answered:** is this codebase still safe to build on?
**Method:** dependency mapping, module sizing, boundary tracing, and running
the system to prove staleness claims. Where I could not prove something from
the code, I say so.

**Verdict: structurally healthy, with one class of defect that recurs and now
needs a standing guard.** 639 tests pass. Two real architectural bugs were
found during this audit and fixed; both were invisible to the test suite
because both were *correct-looking code with a stale reference behind it*.

---

## 1 · Executive architectural summary

The system still has the shape it was designed with: a service worker owning
credentials and network, an app document owning render and interaction, a
sandboxed frame owning untrusted content, and a pure classifier in between.
**No layer inversion was found.** The background layer contains zero DOM
references; the app layer never touches `fetch` or a token.

What has degraded is not the layering but the **centre of gravity**.
`src/app/app.js` is now 3,190 lines — 27% of the codebase — holding 21 pieces
of module-level mutable state and importing 17 modules. It is the file every
change touches, and it is where both bugs found in this audit lived.

The recurring failure mode, seen three times now, is:

> A value is captured once, then the thing it refers to is reassigned.

That produced `ctx.store` frozen to the inbox, `window.__bmmStore` likewise,
and previously `store.clear()` meaning "clear the active mailbox" when the
author meant "clear everything". All three trace to the same source: **the
per-mailbox store refactor turned a singleton into a collection, and code
written against the singleton kept compiling.**

---

## 2 · What improved

Genuine structural gains, not politeness:

- **Persistence is now modular and uniform.** Nine storage keys, each owned by
  exactly one module (`cache`, `rules`, `snooze`, `draft-store`, `views`,
  `settings`, plus auth's three). Every loader degrades on corrupt input; every
  mutator reports failure through the same `{ok, error}` shape. Failure
  injection across all 18 entry points produces zero unhandled rejections.
- **One header parser.** `headerMap()` replaced three hand-rolled loops that
  each crashed on a nameless header.
- **One loading flag per mailbox**, and `state.loading` is now *derived* in
  exactly one place rather than assigned in three.
- **A real session lifecycle.** The auth epoch means "this session is over" is
  a fact that in-flight work can observe, rather than a hope that storage was
  cleared in time.
- **The classifier stayed pure.** `src/classify/` imports nothing from `app/`
  or `background/`, has no I/O, and is still fully generated from the data
  pack — I re-ran both generators and confirmed byte-identical output.
- **Test architecture is behaviour-weighted**: 85 tests boot the real app and
  drive it, against 46 source-text assertions. That ratio is the right way
  round, and it is why the seam bugs were findable at all.

---

## 3 · What degraded

### 3.1 `app.js` has become the system's centre of gravity — **Medium-High**

| Section | Lines |
|---|---|
| render | 490 |
| reader | 404 |
| help | 296 |
| sync | 260 |
| events | 246 |
| bulk selection | 210 |
| start | 187 |
| sidebar | 181 |
| server search | 145 |
| theme | 120 |
| triage | 108 |
| category rules | 100 |
| snooze | 91 |

**Why it matters architecturally.** Several of those sections are *whole
features* that happen to live in the shell: the snooze picker, the category
rule menu, the help overlay, the theme menu, saved views and bulk selection are
each self-contained UI with their own state and event wiring. They sit in
`app.js` only because that is where the DOM handles are.

`features.js` (702 lines) already exists as the home for exactly this kind of
thing — the palette, compose, radar and undo live there behind the `ctx`
contract. So the codebase has **an established pattern that half the features
follow and half do not.** That is the inconsistency, more than the line count.

**Risk if left alone.** Every new surface has two plausible homes and no rule
to choose between them. Merge conflicts concentrate in one file. And the next
`store`-like refactor has 21 pieces of module state to audit rather than a
handful per module.

**Localized or systemic?** Systemic in effect, localized in cause.

**Urgency: medium.** It is not blocking, but the cost of *not* doing it rises
with each feature. Threading — the next large item — will add list-grouping
logic to the render section, which is already the largest.

### 3.2 The `ctx` boundary was ceremonial in one place — **was Critical, now fixed**

`ctx` is the declared contract between `app.js` and `features.js`. It captured
`store` **by value** while `store` is a `let` reassigned on every mailbox
switch. Consumers therefore read the inbox forever.

Proven by driving the app: switch to Sent, open compose, type `inbox` — four
inbox contacts were suggested. The deadline radar had the same flaw.

**What caused it:** the per-mailbox refactor. `ctx` was written when `store`
was effectively a constant, and nothing flagged that it had stopped being one.

**Fixed** with a getter, and the same flaw fixed in `window.__bmmStore`. Two
tests pin it, both verified to fail against the old code.

### 3.3 One domain concept had four implementations — **was Medium, now fixed**

"The address in a `From` header" existed as `addressOf` in `app.js`,
`addressOf` in `rules.js`, `addr` in `query.js` — three byte-identical copies —
and `parseAddress` in `contacts.js`, which is **deliberately different**.

Measured, the lenient and strict versions **disagree on 6 of 9 representative
inputs** (`'no-at-sign'`, `''`, `'Weird <not-an-email>'`, `'A <a@x.com>
trailing'`, `'<>'`, whitespace). That is not tidiness; that is one concept with
two incompatible definitions and three chances to drift apart silently.

**Fixed:** `contacts.js` owns both, and their difference is now documented as
intentional (grouping key vs. validated mailbox). A lint fails if a fifth copy
appears — verified by adding one.

### 3.4 A schema key nothing used — **was Low-Medium, now fixed**

`theme` was declared in `settings.js` while `setTheme()` wrote
`chrome.storage.local` directly and `boot()` read it directly. The schema entry
was decorative: two writers, one concept, and the module's coercion and
defaults bypassed.

Routing it through the owner **exposed a second-order bug**: `settings.get()`
is synchronous by contract, so `loadSettings()` must precede the first read —
and it was running ~120 lines later. Had the theme been routed without moving
the load, every launch would have silently fallen back to the default.

This is the shape of the whole audit: the surface issue was tidiness, the
issue underneath was an ordering assumption nobody had written down.

---

## 4 · Layer-by-layer findings

| Layer | State | Evidence |
|---|---|---|
| **Domain (classify/)** | **Healthy.** Pure, generated, zero outward deps. | no imports from `app/` or `background/` |
| **Data (background/)** | **Healthy.** No DOM references at all. 24 named verbs, no generic passthrough. | `grep document\|window` → 0 hits |
| **Persistence (app/*store*, cache, settings…)** | **Healthy.** One owner per key, uniform failure contract. | `test/resilience.test.mjs` |
| **Sync** | **Healthy.** Cursor advance correctly gated to the inbox. | `anchorHistory` |
| **Orchestration (app.js)** | **Strained.** 3,190 lines, 21 mutable bindings, 17 imports. | §3.1 |
| **Feature layer (features.js)** | **Healthy but half-populated.** The pattern is right; only half the features use it. | §3.1 |
| **UI composition** | **Mixed.** Static shell in `app.html` is good; feature DOM is built imperatively in two different files. | — |
| **Security boundary** | **Healthy.** Sandboxed frame, named verbs, session epoch, no token in the app document. | `audits/02` + §2 |
| **Test architecture** | **Healthy.** Behaviour-weighted 85:46. Mutation harness exists. | §2 |

---

## 5 · Cross-cutting concerns

**Error handling** is now consistent at the persistence layer and inconsistent
above it. Modules return `{ok, error}`; UI callers mostly `try/catch` and
`toast()`. There is no single "how does a failure reach the user" rule — it is
convention, and it holds today because one person wrote it all. *Low risk now,
medium once anyone else contributes.*

**Accessibility** is architecturally sound: roving tabindex, one live region
per concern, focus restoration on every overlay. It is enforced by tests rather
than by structure, which is the correct trade for a codebase this size.

**Performance-sensitive design** has one explicit invariant — one render per
settled state — and it is now genuinely enforced (the `{changed, structural}`
payload reaches `scheduleRender`). This is stronger than it was.

**Configuration** is the weakest cross-cutting story. Six settings exist; the
things a user would actually want to change (density, notification rules,
auto-archive thresholds) are either absent or hardcoded in `app.js`. Not a
flaw, but it means `app.js` accumulates constants: `CAT_COLOR`,
`LOW_CONFIDENCE`, `PAGE`, `SERVER_SEARCH_MS`, `MAX_INLINE_BYTES`.

---

## 6 · Dependency and boundary analysis

**No cycles.** The graph is a clean DAG:

```
app.js ──> 16 leaf/near-leaf modules
features.js ──> deadlines, query, undo, icons, draft-store, settings, contacts
query.js ──> deadlines, contacts
mailboxes.js ──> snooze
background/index.js ──> auth, gmail, snooze, sync
gmail.js ──> auth
classify/index.js ──> categories, sender, address-map, pattern-rules, scoring
```

Two observations worth recording:

- **`mailboxes.js` → `snooze.js`** is the only app-layer module importing
  another feature module, for the `BMM/Snoozed` label name. That is a shared
  constant, not a dependency; it would be cleaner as a constant both import.
  *Low risk, cosmetic.*
- **`background/index.js` imports `../app/snooze.js`** — the worker depending
  on an app-layer module. It works because `snooze.js` is pure, but the
  directory names now lie about the direction. *Low risk, worth renaming the
  module or moving it to a shared location before it grows I/O.*

---

## 7 · Areas of hidden fragility

Things that work today and would break quietly:

1. **`settings.get()` is synchronous with an async warm-up.** Now correct and
   tested, but the contract lives in a comment. Any new early reader
   reintroduces the bug. *This is the most likely next repeat.*
2. **`store` is a live binding published in three ways** — the `let`, the
   `ctx` getter, and `window.__bmmStore`. All three are now correct. A fourth
   publication would not be.
3. **`renderedIds` is the safety mechanism for bulk actions.** `bulkAct`
   resolves through it, which is why muted mail cannot be archived. That safety
   is *emergent from the data flow*, not stated as an invariant. A refactor
   that passed `store.idsFor('all')` instead would silently remove it. There is
   now a test, but no comment at the definition.
4. **`app.html` and `app.js` must agree on element IDs.** ~60 `getElementById`
   calls with no build-time check. A typo is a runtime `null`. The `el` map
   centralises most of it; the feature sections do not use it.

---

## 8 · Refactor priorities

### Do next (before threading)

1. **Extract the four self-contained overlays from `app.js` into the
   `features.js` pattern**: snooze picker, category rule menu, help overlay,
   theme menu. ~600 lines, no behaviour change, and it makes the `ctx`
   contract the *only* way features reach the shell rather than one of two
   ways. Do this **before** threading, because threading will enlarge the
   render section further.
2. **State the `renderedIds` invariant** where it is defined, and the
   `settings` ordering contract in `settings.js` rather than only at the call
   site.

### Do when convenient

3. Move `snooze.js`'s label constant somewhere both `mailboxes.js` and
   `background/index.js` can import without crossing layers.
4. Give the feature sections access to the `el` map instead of raw
   `getElementById`.

### Do not do

- **Do not split `app.js` by line count.** The render loop, sidebar, reader and
  triage sections are genuinely coupled through `renderedIds`, `nodeById` and
  the store subscription. Splitting them would create the hidden coupling this
  audit is looking for. Only the *self-contained overlays* should move.
- **Do not introduce a state-management library.** The current model — one
  store per mailbox, a derived render, an explicit `ctx` — is comprehensible
  and its invariants are testable. A framework would obscure exactly the class
  of bug found here.
- **Do not unify `addressOf` and `parseAddress`.** They differ on purpose and
  the difference is now measured and documented.

---

## 9 · What I could not determine

- **Whether `app.js`'s size actually slows contributors.** I have one author's
  codebase and no velocity data. The line count and the 21 mutable bindings are
  facts; the productivity claim is inference.
- **Whether the overlay extraction is worth its regression risk.** It touches
  ~600 lines of working, tested code. I believe it is, because it happens
  before threading rather than after — but that is a judgement, not a
  measurement.
- **Real-browser behaviour of any of this.** Unchanged and still the largest
  gap in confidence overall.

---

## 10 · Verdict

**Ready for more feature work, with one caveat.**

The boundaries are real, the dependency graph is acyclic, the domain layer is
pure, and the persistence layer is uniform. Nothing found here is a
"stop and rewrite" problem.

The caveat is that **`app.js` should absorb no more features before the four
overlays move out.** The file is not yet unmanageable, but it is the single
place where every recurring bug in this audit lived, and threading will add to
exactly its largest section.

The recurring defect class — *a captured value whose referent was later
reassigned* — has now appeared three times. It is worth treating as a known
hazard of this codebase rather than three coincidences: whenever a singleton
becomes a collection, every existing capture of it is suspect.
