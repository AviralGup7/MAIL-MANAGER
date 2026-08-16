# Working on BITS Mail Manager

> **This is not an invitation to contribute.** The project is closed-source
> and **all rights are reserved** — see [COPYRIGHT.md](COPYRIGHT.md). No
> licence is granted to use, copy, modify or redistribute this code, and
> outside contributions are not being accepted.
>
> This file exists because the repository is publicly readable and the owner
> is its sole maintainer: it is the **owner's own build and house-rules
> reference**, kept in the open so the rules that keep the codebase honest are
> written down rather than remembered. Read it as documentation of how the
> project is maintained, not as an offer of participation.

## Prerequisites

- Node 20+ (the suite is plain `node --test`; no transpiler, no bundler)
- A Chromium-family browser for manual runs (Chrome, Brave, Edge, Firefox)
- Your own Google Cloud "Web application" OAuth client ID (the extension ships
  none; paste the ID in Options after loading unpacked)

## Quick start

```
cd MAIL-MANAGER        # the owner's working copy; see COPYRIGHT.md
npm ci                 # jsdom only; everything else is dependency-free
npm test               # full suite; skips nothing when jsdom is present
npm run preview        # builds preview.html — the app on synthetic mail
```

Load unpacked: `chrome://extensions` → Developer mode → Load unpacked → this
directory. Open Options, paste your client ID, open Gmail, press
`Alt+Shift+M`. Press `?` inside the app for shortcuts.

## The rules that keep this codebase honest

1. **One canonical representation per business concept.** Audience, deadline,
   address lists, search tokens and ingest records each have exactly one
   producer; consumers read the stamp or the accessor, never a re-derivation
   (the rule outlived the audit that found it; see docs/FINDINGS.md).
2. **Tests are sabotage-verified.** A new guard ships with a demonstration
   that breaking the contract fails the test.
3. **No layout animation per frame.** Discrete state-bound transitions only,
   with a measured reflow cost cited (see src/styles/80-compression.css and
   test/package.test.mjs).
4. **The worker owns the token.** The app page never sees the access token;
   do not merge layers (see SECURITY.md).
5. **Do not rewrite app.js.** Extract only proven tenants with explicit ctx
   wiring; render/selection/reader state stays shell-owned.

## Troubleshooting

| Symptom | First thing to check |
|---|---|
| "Service worker registration failed. Status code: 2" | `npm run doctor` — it checks every load-time failure mode |
| Sign-in loops at the consent screen | Redirect URI in your OAuth client must equal the one Options shows, exactly |
| Tests skip en masse | jsdom missing — `npm ci` |
| Fallback banner stuck | Worker probe runs on `online` and every 60s; check DevTools console for `[BMM]` |

## Where the knowledge lives

- `docs/` — architecture, threading, service worker, timetable provenance.
  Living documents, gated by `tools/check-docs.mjs`
- `docs/FINDINGS.md` — the finding-id ledger. Code comments cite ids like
  `AUD-C1` and `R3-02`; this is what they mean, including the withdrawn ones
- `audits/` — the four reference audits code cites by name, plus the latest
  bug hunt. The rest were retired once fixed and pinned; `audits/README.md`
  states the criterion
