/**
 * The storage schema registry (roadmap Phase 3, M-1).
 *
 * RESPONSIBILITY  One flat, complete table of EVERY key this extension
 *                 writes to chrome.storage, with owner, purpose and the
 *                 backup decision. Before this existed, keys were maintained
 *                 by convention across ~15 modules and backup.js kept a
 *                 hand-mirrored list — the exact gap that let the fictional
 *                 'settings' key ship a silent empty backup and the fictional
 *                 'imageAllowList' key skip the allow-list for months.
 * OWNS            nothing at runtime: pure data + derivation.
 * DOES NOT OWN    the values, the storage area, or the degrade behaviour of
 *                 each loader (each module still degrades for itself).
 * DEPENDS ON      settings.js SCHEMA (single source for preference keys).
 *
 * RULES
 *  - A new storage key anywhere in src/ MUST appear here; the registry test
 *    sweeps every module's KEY literal and fails on an unlisted one.
 *  - Settings keys are derived from SCHEMA, so a new preference cannot be
 *    forgotten; per-key backup exceptions are declared below, never by
 *    omission.
 *  - backup:true means user-invested data that survives a reinstall;
 *    backup:false requires a REASON — transient, reconstructible, or
 *    dangerous to restore.
 */

import { SCHEMA } from './settings.js';

/**
 * Preference keys deliberately excluded from backup. clientId is the user's
 * own Google Cloud OAuth client id — credentials-adjacent, per-installation,
 * and restoring it onto another machine is rarely what is wanted (a backup
 * file is something people mail to themselves).
 */
const SETTINGS_NO_BACKUP = new Set(['clientId']);

/** The preference keys, straight from the schema — cannot drift. */
const SETTINGS_KEYS = Object.keys(SCHEMA).map((key) => ({
  key,
  owner: 'src/app/system/settings.js',
  purpose: 'user preference (typed, schema-validated)',
  backup: !SETTINGS_NO_BACKUP.has(key),
  reason: SETTINGS_NO_BACKUP.has(key)
    ? 'credentials-adjacent, per-installation'
    : '',
}));

/** Every non-preference key in the system. */
const DOMAIN_KEYS = [
  { key: 'categoryRules', owner: 'src/app/mail/rules.js', purpose: 'mutes, auto-archive, sender corrections, thread mutes', backup: true, reason: '' },
  { key: 'automationRules', owner: 'src/app/academic/rule-engine.js', purpose: 'user automation rules', backup: true, reason: '' },
  { key: 'savedViews', owner: 'src/app/system/view-store.js', purpose: 'saved searches', backup: true, reason: '' },
  { key: 'templates', owner: 'src/app/compose/templates.js', purpose: 'reply/forward templates', backup: true, reason: '' },
  { key: 'followups', owner: 'src/app/academic/followups.js', purpose: 'awaited-reply tracking', backup: true, reason: '' },
  { key: 'deadlineOverrides', owner: 'src/app/academic/deadline-store.js', purpose: 'user deadline corrections/dismissals', backup: true, reason: '' },
  { key: 'myCourses', owner: 'src/app/academic/my-courses.js', purpose: 'course enrolment', backup: true, reason: '' },
  { key: 'snoozed', owner: 'src/features/snooze/model.js', purpose: 'snooze schedule', backup: true, reason: '' },
  { key: 'imageAllow', owner: 'src/app/mail/reader.js', purpose: 'remote-image sender allow-list', backup: true, reason: '' },
  { key: 'timetable', owner: 'src/app/academic/timetable-store.js', purpose: 'user-built timetable', backup: true, reason: '' },
  { key: 'composeDraft', owner: 'src/app/compose/draft-store.js', purpose: 'compose crash-recovery draft', backup: false, reason: 'transient by design; a stale draft restored on another machine is a surprise, not a recovery' },
  { key: 'queryHistory', owner: 'src/app/search/suggest.js', purpose: 'recent search suggestions', backup: false, reason: 'reconstructible convenience, not investment' },
  { key: 'msgCache', owner: 'src/app/system/cache.js', purpose: 'warm-start message cache', backup: false, reason: 'reconstructed by sync' },
  { key: 'bodyCache', owner: 'src/app/system/body-cache.js', purpose: 'offline body floor for the reader (M1)', backup: false, reason: 're-remembered on next open; the worker is the source of truth, a backup copy would only grow stale' },
  { key: 'activityLog', owner: 'src/app/academic/activity.js', purpose: 'what the app did to your mail', backup: false, reason: 'a log about THIS installation' },
  { key: 'outbox', owner: 'src/features/outbox/model.js', purpose: 'pending-send queue', backup: false, reason: 'importing pending sends on a second machine would send them twice' },
  { key: 'intents', owner: 'src/app/mail/intents.js', purpose: 'queued offline triage verbs (G3)', backup: false, reason: 'pending verbs must not travel — same class as outbox: an archive queued on one machine landing on another is a betrayal, not a sync' },
  { key: 'outboxClaims', owner: 'src/features/outbox/model.js', purpose: 'dispatch coordination claims', backup: false, reason: 'transient coordination state' },
  { key: 'outboxPumpLock', owner: 'src/features/outbox/model.js', purpose: 'one pump writer per window across tabs', backup: false, reason: 'transient coordination state; TTL is the crash backstop' },
  { key: 'historyId', owner: 'src/background/sync.js', purpose: 'Gmail delta-sync cursor', backup: false, reason: 'server-side truth; a stale cursor forces a resync at worst' },
  { key: 'accountEmail', owner: 'src/background/auth.js', purpose: 'identity of the consenting account — every silent renewal is validated against it (audit 2026-08-15, AUD-C1)', backup: false, reason: 'per-account identity; restoring it onto another account context is exactly the hazard it exists to catch' },
  { key: 'diagCounters', owner: 'src/background/diag.js', purpose: 'worker-side request/retry/notification/renewal/mismatch counters, flushed on the sweep tick (audit 2026-08-15, AUD-Q1)', backup: false, reason: "process-scoped diagnostics — restoring another dead worker's counts would be fiction, and MV3 makes them lossy by design" },
  { key: 'activeAuthUser', owner: 'src/app/main.js (writer) + src/background/index.js (reader)', purpose: "the /mail/u/N/ of the tab hosting the takeover, so openGmailTab reuses the session's account (audit 2026-08-15, AUD-M2)", backup: false, reason: 'session ambience — which tab hosted us; a restored stamp from another day is the AUD-M2 hazard inverted, and absence degrades to the first-tab fallback' },
  { key: 'accessToken', owner: 'src/background/auth.js', purpose: 'OAuth token (session area preferred)', backup: false, reason: 'credential — never travels' },
  { key: 'expiresAt', owner: 'src/background/auth.js', purpose: 'OAuth token expiry', backup: false, reason: 'credential metadata — never travels' },
];

export const STORAGE_REGISTRY = [...SETTINGS_KEYS, ...DOMAIN_KEYS];

/** Keys a backup file carries: the invested, restorable data. */
export const BACKUP_KEYS = STORAGE_REGISTRY.filter((k) => k.backup).map((k) => k.key);

/** Read-only lookup for tests and tooling. */
export function keyEntry(key) {
  return STORAGE_REGISTRY.find((k) => k.key === key) || null;
}
