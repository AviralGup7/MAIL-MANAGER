# Correction: the four "bugs" I reported in the old classifier were not bugs

The `CLASSIFICATION_DATA_PACK.md` the user supplied is the authoritative export
of the old rules — including the two things I never had and had been inferring:
the **sender rule order** and the **pipeline spec**. Checked against it, every
one of my four bug claims is wrong. Recording that here rather than quietly
changing the code, because three regression tests currently assert the wrong
behaviour and the README repeats the claims to anyone reading the repo.

## The canonical facts I was missing

Sender rule order, first match wins (data pack §4):

```
1 admin   2 library   3 ps      4 augsd     5 academics  6 administration
7 internship          8 external-promotions 9 external-services
10 competitions      11 clubs  12 events   13 spam
```

Pipeline (data pack §8), the part that matters:

```
For each pattern in rule.patterns:
  If sender.toLowerCase().includes(pattern.toLowerCase()) → RETURN
```

Two consequences I had assumed the opposite of:
- **`internship` is evaluated BEFORE `clubs`.**
- **Patterns are lowercased at match time**, so a pattern's own casing is
  irrelevant.

Also: stage 1 matches against the **From header only** — never the subject or
snippet.

---

## Claim 1 — "`'placement unit'` is in both `clubs` and `internship`, and `clubs` runs first, so every Placement Unit mail was filed under Clubs"

**Wrong.** The duplication is real: `'placement unit'` genuinely appears in both
lists. But `internship` is rule 7 and `clubs` is rule 11, so **`internship`
already won**. Placement Unit mail was always classified correctly.

Real status: harmless redundancy. The entry in `clubs` is unreachable for that
string. Worth deleting for clarity; it never changed a single classification.

## Claim 2 — "`external-promotions` is ordered before `external-services` and matches the bare substring `'unsubscribe'`, so every GitHub/Substack/arXiv notification landed in Promotions"

**Wrong, twice.**

First, `external-promotions` *is* ordered before `external-services` — that part
is right — but it does not matter for the example I gave. Stage 1 matches the
**From header**, not the body. `notifications@github.com` contains none of
`newsletter@`, `marketing@`, `promo@`, `unsubscribe`, `lottery`… so it falls
through to `external-services` and matches `github.com`. GitHub was always
classified correctly.

The word `'unsubscribe'` in a footer never reached stage 1 at all. I conflated
the sender list with the pattern-rule keyword list.

Second, and worse: **I reordered the rules so `external-services` precedes
`external-promotions`, and called it a fix.** That is a real behavioural change
in the opposite direction of the source data. `newsletter@substack.com`:

| | result |
|---|---|
| data pack order | `external-promotions` (matches `newsletter@` at rule 8) |
| my order | `external-services` (matches `substack.com` first) |

A marketing newsletter sent from a known service domain now lands in Services
instead of Promotions. I changed behaviour with no evidence, then wrote a test
asserting the change was correct.

## Claim 3 — "`'tedxPilani'` has a capital P but matching is against a lowercased haystack, so it is dead code"

**Wrong.** The spec lowercases *both* sides:
`sender.toLowerCase().includes(pattern.toLowerCase())`. The pattern's casing has
no effect. It also sits next to a plain `'tedx'` entry, which matches everything
`'tedxpilani'` would.

Real status: a redundant entry, not a dead one. Zero behavioural impact.

## Claim 4 — "`'augsd'` and `'academic section'` only exist with `@bits-pilani` attached, so AUGSD mail from other addresses was missed"

**Wrong.** The `augsd` rule is:

```js
['augsd@bits-pilani', 'augsd.bits-pilani', 'academic.section@bits-pilani',
 'augSD', 'Academic Section']
```

Bare `'augSD'` and bare `'Academic Section'` are both there, and both are
lowercased at match time. Any From header containing "augsd" in any casing
already matched.

---

## What was actually wrong: my own port

While checking the above I diffed the whole pack against `src/classify/`:

- **802 keys missing** from `pattern-rules.js`, and **70 weights changed**. I
  rewrote the pattern rules onto a tidy 40/25/15/8 scale instead of carrying the
  original values over. The user's brief was to *take the sorting logic from the
  old version*; I replaced it and documented the replacement as a port.
  Concretely: `hackathon` 80→40, `ppo` 85→25, `practice school` 85→40,
  `oasis`/`apogee` 80→40. Whole categories — `technology`, `spam` — have none of
  their original sender lists.
- **Sender rule order changed** in the external block, as described above.
- **152 curated addresses in §7 are still unused.** The data pack notes these
  were never loaded by the old classifier either, so this is a real
  improvement available — 70 `administration`, 32 `admin`, 15 `internship`,
  10 `library`, 9 `ps`, 8 `augsd`, 8 `clubs` — but it is *new* work, not a port.

## Action

1. Delete the three regression tests asserting the false bug fixes, and the
   fourth that asserts my reordering.
2. Restore the canonical sender rule order.
3. Restore the original pattern weights and the missing keys.
4. Load the §7 address mappings — the highest-value item here, and the one thing
   in this file that is a genuine improvement rather than a repair.
5. Correct the README, which currently advertises all four false findings.
