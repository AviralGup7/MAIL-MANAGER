# Audit 5 — Architecture & Maintainability

Scope: module boundaries, dead code, duplication, and whether the codebase
resists the specific decay that killed v1.
Method: dependency reading, dead-code tracing, and grep-verified claims about
what is actually wired up.

**Verdict: the layering is correct and the generated-data approach is the
strongest decision in the project. Three concrete cleanups, and one structural
risk that will matter in six months.**

---

## Structure as built

```
content script  ──postMessage──►  app (iframe, extension origin)
     │                                  │
     │                            chrome.runtime.sendMessage
     ▼                                  ▼
  Gmail DOM                      service worker ──fetch──► Gmail API
  (suspended)                    (sole token holder)
```

The boundary that matters is right: **the document rendering untrusted mail
never holds a credential**. A total compromise of the app still cannot read the
token. This is the correct MV3 shape and it is worth protecting in review.

Layering within `src/` is clean and acyclic:

```
classify/   pure, no I/O, no DOM, no chrome.*   ← testable on bare Node
app/store   pure data structure, no chrome.*
app/app.js  DOM + messaging
background/ chrome.* + network
takeover/   Gmail page only
```

`classify/` having zero dependencies on anything is why it can be benchmarked
and fuzzed directly, and why the 891-key rule set could be verified against the
data pack mechanically.

---

## A-1 — GOOD — generated data files are the best decision here

`pattern-rules.js` (891 keys) and `address-map.js` (152 addresses) are
generated from `docs/CLASSIFICATION_DATA_PACK.md`, carry do-not-edit banners,
and are guarded by a sync test.

This directly prevents the failure that already happened once: a hand-written
port that silently dropped 802 of 891 keys and rewrote 70 weights while its own
header comment claimed a faithful carry-over. Code review did not catch it;
reading did not catch it; only a mechanical diff did.

**Keep this property.** Any future rule change goes into the pack, then
regenerate. If a rule ever needs to be hand-edited, that is the signal to
extend the generator, not to edit the output.

---

## A-2 — MODERATE — dead code in the service worker

Two things are wired up and never called.

**The `GMAIL` message proxy.** `background/index.js:74` routes `type:'GMAIL'`
to a `gmail(path, init)` helper at line 114. Nothing sends that message:

```
$ grep -rn "'GMAIL'" src/
src/background/index.js:74      ← the only hit, the handler itself
```

The app uses the specific verbs (`SYNC_PAGE`, `GET_BODY`, `STAR`, …) instead.
The generic escape hatch is a strictly worse interface — it lets any future
caller construct an arbitrary Gmail path from the app document, which is
exactly the capability the worker/app split exists to deny. It should not
survive as a convenience.

**The `alarms` permission.** Declared in `manifest.json` and never used:

```
$ grep -rn "chrome.alarms" src/
(no matches)
```

The permission-minimisation story in `SECURITY.md` (7 → 3) is undermined by one
of the remaining three being unused. Either implement periodic background
refresh — which is the obvious reason to want it — or drop it to 2.

**Fix:** delete the `GMAIL` case and the `gmail()` helper; remove `alarms` from
the manifest until something needs it. Both are one-line removals that tighten
the security posture rather than just tidying.

---

## A-3 — MODERATE — `app.js` is 891 lines and holds five responsibilities

It contains: the render loop, the sidebar, the reader, triage actions, sync
orchestration, keyboard handling, the body sanitiser, and date formatting. It
is well sectioned (13 banner comments) and currently readable, but it is the
file every future feature touches, which makes it the file most likely to
accumulate the coupling that made v1 slow.

Specifically, the render loop's invariant — *data changes go to the Store, the
Store notifies once, rendering happens once per frame, nothing else touches
list DOM* — is documented at the top of the file and enforced only by
convention. That is the single most important property in the codebase and it
has no test.

**Fix, in priority order:**
1. Add a test that asserts the invariant directly: mutate the store N times
   inside a batch, assert exactly one render occurred. `test/bench.mjs` counts
   renders already; promote that into a real assertion in the integration
   suite.
2. Extract `renderBody`/`escapeHtml`/`escapeDoc` into `src/app/sanitize.js` —
   it is a security-relevant unit and deserves its own test file.
3. Extract the reader (`openMessage`, `closeReader`, tag rendering) into
   `src/app/reader.js`.

Do not restructure further than that. Splitting for its own sake would obscure
the render loop, which benefits from being readable in one pass.

---

## A-4 — LOW — MIME/body handling is split across two layers for a good reason that is not written down

`background/index.js:141` `extractBody()` walks the MIME tree in the worker;
`app.js:420` `renderBody()` builds the srcdoc in the app. This looks like
duplication but is not — the split is deliberate and correct: extraction runs
where there is **no DOM**, so a malformed body cannot do anything, and only
inert strings cross the boundary.

That reasoning appears in the worker's comment but not in the app's, so a
future maintainer consolidating "duplicated body logic" into one place would
undo it.

**Fix:** one comment in `renderBody()` pointing at `extractBody()` and stating
that the split is a security boundary, not an accident.

---

## A-5 — LOW — the `docs/` copy of the data pack can drift from `uploads/`

`docs/CLASSIFICATION_DATA_PACK.md` is a committed copy of the user-supplied
file. `test/package.test.mjs` verifies the generated files match **the committed
copy**, which is right. But nothing records the provenance of that copy — if the
user supplies a revised pack, there is no version marker to compare against.

**Fix:** add a header line to the committed copy recording its origin and the
date received, and have the generators stamp the source file's byte length into
the generated banner.

---

## Resistance to v1's decay — scorecard

The specific mechanisms that made v1 slow, and whether this build can regress
into them:

| v1 failure | Prevented? | By what |
|---|---|---|
| Render coupled to every store mutation | Partly | Documented invariant, **no test** — see A-3 |
| Permanent rAF animation loop | Yes | No rAF loop exists; animation is one-shot with a timeout |
| Undebounced re-entrant MutationObserver | Yes | Zero observers in `src/` |
| Full index rebuild per mutation | Yes | Incremental indexes, tested with shuffled input |
| Whole-array persistence per mutation | N/A | Nothing persists at all — see `01-CORRECTNESS.md` C-2 |
| Async classification with a semaphore | Yes | Synchronous, benchmarked |
| Rule drift during a port | **Yes** | Generated files + sync test — the strongest guard here |
| Permission creep | Yes | `package.test.mjs` fails if scopes or permissions grow |
| Animation-token sprawl (11 durations, 12 easings) | Convention only | Documented in `app.css`; no lint rule |

The gaps are the two marked "partly"/"convention": the render invariant and the
animation tokens. Both are one test away from being enforced rather than hoped
for.
