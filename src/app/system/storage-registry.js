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
  /*
   * Preferences belong to the PERSON at this installation, not to the
   * mailbox: density, theme and undo-send are the same choices whichever
   * account is signed in, and wiping them on an account change would be a
   * hostile surprise. clientId is per-installation for the same reason.
   */
  accountScoped: false,
  scopeReason: 'a preference is set by the person, not by the mailbox',
}));

/** Every non-preference key in the system. */
const DOMAIN_KEYS = [
  { key: 'categoryRules', owner: 'src/app/mail/rules.js', purpose: 'mutes, auto-archive, sender corrections, thread mutes', backup: true, reason: '', accountScoped: true, scopeReason: 'names the senders and threads of ONE mailbox' },
  { key: 'automationRules', owner: 'src/app/academic/rule-engine.js', purpose: 'user automation rules', backup: true, reason: '', accountScoped: false, scopeReason: 'rules are authored by the person, not the mailbox; they re-apply cleanly to a new account' },
  { key: 'savedViews', owner: 'src/app/system/view-store.js', purpose: 'saved searches', backup: true, reason: '', accountScoped: false, scopeReason: 'a query is a question, not data about one mailbox' },
  { key: 'templates', owner: 'src/app/compose/templates.js', purpose: 'reply/forward templates', backup: true, reason: '', accountScoped: false, scopeReason: 'prose the user wrote; useful from any account' },
  { key: 'followups', owner: 'src/app/academic/followups.js', purpose: 'awaited-reply tracking', backup: true, reason: '', accountScoped: true, scopeReason: 'holds threadId/messageId of ONE mailbox plus the note written about it (audit R3-04)' },
  { key: 'deadlineOverrides', owner: 'src/app/academic/deadline-store.js', purpose: 'user deadline corrections/dismissals', backup: true, reason: '', accountScoped: true, scopeReason: 'keyed by message id, which is meaningless in another account (audit R3-04)' },
  { key: 'myCourses', owner: 'src/app/academic/my-courses.js', purpose: 'course enrolment', backup: true, reason: '', accountScoped: false, scopeReason: 'the student is enrolled, not the mailbox' },
  { key: 'snoozed', owner: 'src/features/snooze/model.js', purpose: 'snooze schedule', backup: true, reason: '', accountScoped: true, scopeReason: 'message ids of ONE mailbox; waking them under another account 404s or mislabels' },
  { key: 'imageAllow', owner: 'src/app/mail/reader.js', purpose: 'remote-image sender allow-list', backup: true, reason: '', accountScoped: true, scopeReason: 'a trust decision about senders of ONE mailbox; inheriting it silently loads remote images for a new account (audit R3-04)' },
  { key: 'timetable', owner: 'src/app/academic/timetable-store.js', purpose: 'user-built timetable', backup: true, reason: '', accountScoped: false, scopeReason: 'the timetable belongs to the student' },
  { key: 'composeDraft', owner: 'src/app/compose/draft-store.js', purpose: 'compose crash-recovery draft', accountScoped: true, scopeReason: 'unsent prose addressed from one identity', backup: false, reason: 'transient by design; a stale draft restored on another machine is a surprise, not a recovery' },
  { key: 'queryHistory', owner: 'src/app/search/suggest.js', purpose: 'recent search suggestions', accountScoped: true, scopeReason: 'the terms someone typed while reading ONE mailbox — names and subjects (audit R3-04)', backup: false, reason: 'reconstructible convenience, not investment' },
  { key: 'msgCache', owner: 'src/app/system/cache.js', purpose: 'warm-start message cache', accountScoped: true, scopeReason: 'message headers of ONE mailbox', backup: false, reason: 'reconstructed by sync' },
  { key: 'bodyCache', owner: 'src/app/system/body-cache.js', purpose: 'offline body floor for the reader (M1)', accountScoped: true, scopeReason: 'message bodies of ONE mailbox', backup: false, reason: 're-remembered on next open; the worker is the source of truth, a backup copy would only grow stale' },
  { key: 'activityLog', owner: 'src/app/academic/activity.js', purpose: 'what the app did to your mail', accountScoped: true, scopeReason: 'verbs against message ids of ONE mailbox (audit R3-04)', backup: false, reason: 'a log about THIS installation' },
  { key: 'outbox', owner: 'src/features/outbox/model.js', purpose: 'pending-send queue', accountScoped: true, scopeReason: 'AUD-C2: sending account A drafts under account B', backup: false, reason: 'importing pending sends on a second machine would send them twice' },
  { key: 'intents', owner: 'src/app/mail/intents.js', purpose: 'queued offline triage verbs (G3)', accountScoped: true, scopeReason: 'armed verbs pointed at ONE mailbox', backup: false, reason: 'pending verbs must not travel — same class as outbox: an archive queued on one machine landing on another is a betrayal, not a sync' },
  { key: 'outboxClaims', owner: 'src/features/outbox/model.js', purpose: 'dispatch coordination claims', accountScoped: true, scopeReason: 'claims over account-scoped outbox rows', backup: false, reason: 'transient coordination state' },
  { key: 'outboxPumpLock', owner: 'src/features/outbox/model.js', purpose: 'one pump writer per window across tabs', accountScoped: false, scopeReason: 'a cross-tab mutex, TTL-bounded; clearing it mid-window would let two writers in', backup: false, reason: 'transient coordination state; TTL is the crash backstop' },
  { key: 'historyId', owner: 'src/background/sync.js', purpose: 'Gmail delta-sync cursor', accountScoped: true, scopeReason: 'applying one account deltas to another is silent corruption', backup: false, reason: 'server-side truth; a stale cursor forces a resync at worst' },
  { key: 'accountEmail', owner: 'src/background/auth.js', purpose: 'identity of the consenting account — every silent renewal is validated against it (audit 2026-08-15, AUD-C1)', accountScoped: true, scopeReason: 'IS the account identity', backup: false, reason: 'per-account identity; restoring it onto another account context is exactly the hazard it exists to catch' },
  { key: 'diagCounters', owner: 'src/background/diag.js', purpose: 'worker-side request/retry/notification/renewal/mismatch counters, flushed on the sweep tick (audit 2026-08-15, AUD-Q1)', accountScoped: false, scopeReason: 'process health, not mailbox content', backup: false, reason: "process-scoped diagnostics — restoring another dead worker's counts would be fiction, and MV3 makes them lossy by design" },
  { key: 'activeAuthUser', owner: 'src/app/main.js (writer) + src/background/index.js (reader)', purpose: "the /mail/u/N/ of the tab hosting the takeover, so openGmailTab reuses the session's account (audit 2026-08-15, AUD-M2)", accountScoped: true, scopeReason: 'names which account slot the session used', backup: false, reason: 'session ambience — which tab hosted us; a restored stamp from another day is the AUD-M2 hazard inverted, and absence degrades to the first-tab fallback' },
  { key: 'accessToken', owner: 'src/background/auth.js', purpose: 'OAuth token (session area preferred)', accountScoped: true, scopeReason: 'the credential itself', backup: false, reason: 'credential — never travels' },
  { key: 'expiresAt', owner: 'src/background/auth.js', purpose: 'OAuth token expiry', accountScoped: true, scopeReason: 'credential metadata', backup: false, reason: 'credential metadata — never travels' },
];

export const STORAGE_REGISTRY = [...SETTINGS_KEYS, ...DOMAIN_KEYS];

/** Keys a backup file carries: the invested, restorable data. */
export const BACKUP_KEYS = STORAGE_REGISTRY.filter((k) => k.backup).map((k) => k.key);

/**
 * Keys that belong to ONE Google account and must not survive a change of
 * account (audit R3-04).
 *
 * WHY THIS IS DERIVED HERE RATHER THAN LISTED IN main.js
 * ------------------------------------------------------
 * The account tripwire (AUD-C1) was built well — identity proven on every
 * silent renewal, worker and surface torn down together, once-guarded — and
 * it still leaked, because the LIST of what to clear lived in the teardown
 * function and was maintained by memory. Six keys were missed: followups,
 * imageAllow, queryHistory, activityLog, categoryRules and deadlineOverrides.
 * The result was that signing in as B inherited A's search terms, A's
 * remote-image trust decisions and notes A wrote about A's threads.
 *
 * A control that looks complete but is not is worse than an obviously
 * partial one. So the enforcement point is the registry: every key declares
 * `accountScoped`, the teardown iterates THIS list, and the registry test
 * fails the build when a new key declares neither. Forgetting is now a red
 * build rather than a privacy leak discovered by an auditor.
 *
 * Note the deliberate exclusions: preferences, templates, saved views,
 * automation rules, myCourses and the timetable belong to the PERSON, and
 * outboxPumpLock is a TTL-bounded cross-tab mutex that must not be yanked
 * mid-window.
 */
export const ACCOUNT_SCOPED_KEYS = STORAGE_REGISTRY
  .filter((k) => k.accountScoped)
  .map((k) => k.key);

/** Read-only lookup for tests and tooling. */
export function keyEntry(key) {
  return STORAGE_REGISTRY.find((k) => k.key === key) || null;
}
