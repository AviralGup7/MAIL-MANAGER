# Contributing to BITS Mail Manager

## Prerequisites

- Node 20+ (the suite is plain `node --test`; no transpiler, no bundler)
- A Chromium-family browser for manual runs (Chrome, Brave, Edge, Firefox)
- Your own Google Cloud "Web application" OAuth client ID (the extension ships
  none; paste the ID in Options after loading unpacked)

## Quick start

```
git clone <this repo> && cd MAIL-MANAGER
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
   (see audits/39-BUSINESS-LOGIC.md, cross-audit in audits/40-*).
2. **Tests are sabotage-verified.** A new guard ships with a demonstration
   that breaking the contract fails the test.
3. **No layout animation per frame.** Discrete state-bound transitions only,
   with a measured reflow cost cited (see the SPATIAL COMPRESSION section in
   src/app/app.css and test/package.test.mjs).
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

- `docs/` — architecture, threading, service worker, timetable provenance
- `audits/` — ten audits plus the cross-audit consolidation; findings stay
  retracted-in-place, never deleted
- `notes/` — bug post-mortems (SYNC_BUGS.md is the history API's scar tissue)
