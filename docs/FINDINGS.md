# Finding-ID ledger — what the code comments point at

**Why this file exists.** Roughly a hundred comments in `src/`, `test/` and
`tools/` justify a rule by citing a finding id — `AUD-C1`, `R3-02`,
`EXT2-C2`. Those ids were defined in dated audit documents, and most of those
documents have been retired: their findings are fixed, pinned by tests, and
the reasoning that mattered was copied into the code at the point it applies.

Retiring the documents without this ledger would have left every one of those
comments pointing at nothing, which is worse than the documents were. So the
ids survive their sources: this table is the stable home. **A comment citing
an id below is resolvable here; the full narrative is in git history.**

Ids are never reused. A new audit picks a fresh namespace.

---

## How to read a citation

```js
/* Through the seam (ARCH-R2-1), not `chrome.storage` directly. */
```

means: *this line exists because architectural audit R2 finding 1 found the
opposite, and the test named below fails if it regresses.* The comment is the
reason; this table is the provenance; the test is the enforcement.

---

## AUD-* · System-wide audit, 2026-08-15 (`2b82f0e`)

The account-identity round. Root cause shared by both criticals: **the account
was an assumption, not an identity.**

| Id | Finding | Status |
|---|---|---|
| `AUD-C1` | Silent OAuth renewal followed the browser's current account with no profile validation — a renewal could hand you a different mailbox | fixed; the account is proved at renewal |
| `AUD-C2` | The outbox was neither account-scoped nor cleared at sign-out | fixed; `clearOutboxOnSignOut` (default true) |
| `AUD-M1` | `SYNC_PAGE` on the snoozed mailbox read as *empty* when offline rather than as unavailable | fixed; honest error surface |
| `AUD-M2` | `openGmailTab()` focused the first Gmail tab regardless of which account it held | fixed; prefers the matching `authuser` |
| `AUD-M3` | Duplicate-notification race in the dedupe sweep | fixed; merge moved out of the sweep |
| `AUD-M4` | Renewal retry was weaker than its own comment claimed | fixed |
| `AUD-L1` | A non-finite snooze `at` reached `alarms.create` | fixed; `scheduleWake` type-filters |
| `AUD-L2` | Notification cards scrubbed the sender but not the subject | fixed; one gate for both (`cardText`) |
| `AUD-L3` | No double-injection guard on the content script | fixed; DOM-level guard |
| `AUD-Q1` | No instrumentation for the failure classes that strand a user | fixed; minimal counters |
| `AUD-Q2` | `parseBatch` did not validate ids, and had no adversarial pins | fixed; validation + fixtures |
| `AUD-I08` | Integration suites leaked jsdom/document state between files | fixed; see `R3-01` |

## EXT-* · External system-wide audit, 2026-08-15 (`ac0cbf2`)

| Id | Finding | Status |
|---|---|---|
| `EXT-H2` | The declared `npm test` command was red — the integration suite exhausted the heap | fixed; see `R3-01` |

## EXT2-* · External deep audit + remediation, 2026-08-15 (`16e0d97`)

Root cause shared by the first two: **a string-typed error taxonomy**, now
carried as `status`/`code`/`kind` across the worker boundary.

| Id | Finding | Status |
|---|---|---|
| `EXT2-C2` | A `404` **substring** anywhere in an error triggered the destructive resync path — it could destroy the local mailbox | fixed; the destructive branch requires an actual 404 |
| `EXT2-H3` | `Store.idsFor(category)` leaked its live memo array to callers | fixed |
| `EXT2-H4` | A hex message id *containing* `401` signed the user out | fixed |
| `EXT2-H5` | A killed worker could re-send mail | fixed; demoted to `uncertain`, not immediately-due `failed` |
| `EXT2-H6` | A granted `notifications` permission with no caller — and the tightened test then found a genuinely unguarded `chrome.notifications.clear` | fixed |
| `EXT2-L3` | Diagnostics that never flushed | fixed |
| `EXT2-M1` | **False positive** — the repro used invalid JSON | withdrawn |
| `EXT2-M6` | Outbox dispatch fails open. Implemented, measured to strand mail in seven scenarios, and **reverted** | withdrawn after implementing |

## R3-* · External round-3 deep audit, 2026-08-15 (`f53175c`, rated 7.0/10)

Every finding reproduced by execution in a clean clone rather than inferred.

| Id | Finding | Status |
|---|---|---|
| `R3-01` | HIGH — `npm test` OOMed | fixed; integration suites split (mail 108 boots → 4 parts, features 115 → 4), harness extracted to `test/helpers/app-harness.mjs`, heap budget **lowered** 3072 → 1400 MB |
| `R3-02` | HIGH — non-ASCII mail entirely unsearchable; the tokeniser split on `[^a-z0-9@.-]` and fed lanes and counts too | fixed; `\p{L}\p{M}\p{N}` split, NFKD folding on **both** sides, CJK bigrams. Indic marks deliberately not folded |
| `R3-03` | HIGH — a partially-failed Gmail batch was treated as authoritative and the cursor advanced past unfetched ids | fixed; `missingIds`, cursor withheld |
| `R3-04` | HIGH — six account-scoped stores survived an account change | fixed; `accountScoped` on every registry key, registry-driven teardown, in-memory mirrors reset |
| `R3-07` | MED — cursor exhaustion was indistinguishable from cursor expiry | fixed; `exhausted: true` |
| `R3-08` | MED — an evicted insert was reported as stored | fixed; `upsertMany` returns survivors |
| `R3-10` | MED — no counters for the classes that strand users | fixed; `batchShortfall`, `resyncs`, `historyExhausted`, `cursorWithheld` |
| `R3-13` | **WITHDRAWN — the audit was wrong.** Pre-1970 dates are a deliberate contract | withdrawn |
| `R3-14` | LOW — `parseBatch` split on an unanchored delimiter, so a boundary string inside a body vanished the part | fixed; line-anchored |
| `R3-15` | LOW — unbounded quote folding | fixed; capped at 40 blockquotes |

## ARCH-R2-* · Architectural audit R2, 2026-08-15 (`0229ed6`)

Measured clean: 0 dependency cycles across 116 modules / 319 edges, 0 layer
violations. The findings were all **drift between the documented architecture
and the enforced one** — a rule claimed but not enforced is worse than no
rule, because it is read as a guarantee.

| Id | Finding | Status |
|---|---|---|
| `ARCH-R2-1` | The platform seam's header claimed to be "the one module that owns `chrome.*`" while ten modules touched it and nothing checked; four were real app-layer breaches | fixed; seam test bites |
| `ARCH-R2-2` | `ctx` was documented with 12 of its 29 members, untyped and unpinned, read by ~12 modules — the exact shape that produced the palette defect | fixed; `shell-contract.d.ts` |
| `ARCH-R2-5` | Modules missing the header that states what they own | fixed |

---

## Where the surviving audits live

Four audit documents are **not** retired, because code cites them by name and
they are reference material rather than a fix list — see
[`../audits/README.md`](../audits/README.md).
