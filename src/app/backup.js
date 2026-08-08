/**
 * Local export and import.  (Feature 87.)
 *
 * WHY THIS IS A KEEP
 * ------------------
 * This roadmap asks the user to invest real effort: rules they wrote, senders
 * they recategorised, deadlines they corrected, templates they tuned, courses
 * they enrolled in. All of it lives in one Chrome profile's local storage and
 * is one reinstall, one profile corruption or one "clear browsing data" away
 * from gone.
 *
 * Export is what makes the investment safe, and asking someone to configure a
 * tool that cannot be backed up is asking them to take a risk they have not
 * been told about.
 *
 * WHAT IS AND IS NOT EXPORTED
 *
 *   exported:     settings, rules, corrections, saved views, templates,
 *                 follow-ups, deadline overrides, enrolment, thread mutes
 *   NOT exported: the message cache, the activity log, OAuth tokens
 *
 * The cache is derived data -- it comes back on the next sync, and including
 * it would turn a 20KB config file into a multi-megabyte partial copy of the
 * mailbox. The activity log is diagnostic and per-device. The tokens are
 * credentials and MUST NEVER LEAVE THE MACHINE: a backup file containing an
 * OAuth token is a credential leak in a file people mail to themselves.
 *
 * That exclusion is enforced by an allow-list, not a deny-list. A deny-list
 * fails open -- the day someone adds a new storage key holding something
 * sensitive, a deny-list exports it and nobody notices.
 *
 * VERSIONED FROM THE FIRST RELEASE
 * A backup format without a version is a format that can never change. The
 * envelope carries one and `importBackup` refuses anything it does not
 * understand rather than importing it partially.
 */

/** Bumped when the shape changes incompatibly. */
export const BACKUP_VERSION = 1;

/**
 * THE ALLOW-LIST. Nothing outside this is ever written to a backup file.
 *
 * Each entry is a storage key. Adding a feature with new persistent state
 * means adding it here deliberately, which is the point.
 */
export const EXPORTED_KEYS = [
  /*
   * EVERY SETTINGS KEY IS LISTED INDIVIDUALLY, and that is not a style choice.
   *
   * This list originally contained a single entry, `'settings'`. No such
   * storage key exists and never has: `settings.js` stores each preference as
   * a FLAT TOP-LEVEL KEY -- `loadSettings` does
   * `storage.get(Object.keys(SCHEMA))`, not `storage.get('settings')`.
   *
   * So the backup exported a key that is always absent and captured ZERO
   * preferences, silently. `exportBackup` skips missing keys by design (a
   * partial backup beats none), which is exactly what hid it: the file looked
   * valid, validated cleanly, imported without error, and restored nothing.
   *
   * The unit tests did not catch it because they seeded the same fictional
   * shape the exporter was looking for -- a fake agreeing with the code under
   * test rather than with the system. Found by exporting from a double built
   * from `settings.js`'s ACTUAL contract.
   *
   * Spelling them out means a new preference must be added here deliberately.
   * There is a test that walks SCHEMA and fails if one is missing, so the list
   * cannot silently fall behind.
   */
  'theme',
  'density',
  'remoteImages',
  'markReadOnOpen',
  'threaded',
  'lanes',
  'markReadDelayMs',
  'autoRefreshMs',
  'signature',
  'undoSendSeconds',
  /*
   * `clientId` is IN the schema and deliberately NOT here. It is the user's
   * own Google Cloud OAuth client id -- not a secret in the way a token is,
   * but it is per-installation credentials-adjacent configuration, and a
   * backup file is something people mail to themselves. Restoring it onto
   * another machine is also rarely what is wanted.
   */

  'categoryRules',      // mute, auto-archive, corrections, thread mutes
  'automationRules',    // the rule engine
  'savedViews',
  'templates',
  'followups',
  'deadlineOverrides',
  'myCourses',
  'snoozed',
  'imageAllowList',
];

/**
 * Keys that must NEVER be exported, listed explicitly so the intent is
 * documented and so a test can assert it.
 *
 * This is belt-and-braces on top of the allow-list: the allow-list is what
 * enforces the rule, this is what explains it.
 */
export const NEVER_EXPORT = ['token', 'accessToken', 'refreshToken', 'auth', 'messageCache', 'activityLog', 'outbox'];

/**
 * Build a backup object.
 *
 * `outbox` is excluded on purpose despite being user data: importing a queue
 * of pending sends onto a second machine would send them twice.
 */
export async function exportBackup(storage = chrome.storage?.local, { now = Date.now() } = {}) {
  const data = {};
  for (const key of EXPORTED_KEYS) {
    try {
      const got = (await storage.get(key)) || {};
      if (key in got && got[key] !== undefined) data[key] = got[key];
    } catch {
      // One unreadable key must not fail the whole export. A partial backup is
      // far better than none, and the manifest below records what was included.
    }
  }
  return {
    format: 'bits-mail-manager-backup',
    version: BACKUP_VERSION,
    exportedAt: now,
    keys: Object.keys(data),
    data,
  };
}

/** Serialise for download. Pretty-printed: people do open these files. */
export function toJson(backup) {
  return JSON.stringify(backup, null, 2);
}

/** A filename with the date in it, so successive backups do not overwrite. */
export function filenameFor(backup) {
  const d = new Date(backup?.exportedAt || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `bmm-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
}

/**
 * Validate a candidate backup.
 *
 * @returns {{ok:true, backup:object} | {ok:false, reason:string}}
 */
export function validateBackup(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'That file is not valid JSON.' };
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'That file is empty or not a backup.' };
  }
  if (parsed.format !== 'bits-mail-manager-backup') {
    return { ok: false, reason: 'That file was not produced by this extension.' };
  }
  if (!Number.isFinite(parsed.version) || parsed.version > BACKUP_VERSION) {
    return {
      ok: false,
      reason: `That backup was made by a newer version (v${parsed.version}). Update the extension first.`,
    };
  }
  if (!parsed.data || typeof parsed.data !== 'object') {
    return { ok: false, reason: 'That backup has no data in it.' };
  }
  return { ok: true, backup: parsed };
}

/**
 * What WOULD an import change?  (The same discipline as the rule dry run.)
 *
 * An import that silently replaces a semester of accumulated corrections is
 * exactly the kind of irreversible surprise this project keeps designing
 * against. The user sees this before anything is written.
 */
export async function previewImport(raw, storage = chrome.storage?.local) {
  const check = validateBackup(raw);
  if (!check.ok) return check;

  const changes = [];
  for (const key of EXPORTED_KEYS) {
    const incoming = check.backup.data[key];
    if (incoming === undefined) continue;
    let current;
    try {
      current = (await storage.get(key))?.[key];
    } catch {
      current = undefined;
    }
    changes.push({
      key,
      action: current === undefined ? 'add' : 'replace',
      /*
       * A COUNT, NOT A DIFF. A structural diff of two arbitrary JSON blobs is
       * a lot of code to produce something most people will not read, and the
       * decision the user is actually making is "replace my 12 rules with
       * these 5, yes or no".
       */
      incomingCount: countOf(incoming),
      currentCount: countOf(current),
    });
  }

  return { ok: true, backup: check.backup, changes };
}

function countOf(v) {
  if (v === undefined || v === null) return 0;
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'object') {
    // Views and templates are `{items, hidden}`; count what matters.
    if (Array.isArray(v.items)) return v.items.length;
    if (Array.isArray(v.views)) return v.views.length;
    return Object.keys(v).length;
  }
  return 1;
}

/**
 * Apply a backup.
 *
 * WRITES ARE PER-KEY, NOT ONE BIG SET. If storage rejects one key -- a quota
 * error on a large template list, say -- the rest still land, and the result
 * reports exactly what happened. An all-or-nothing write that fails halfway is
 * the worst of both, and Chrome's storage API gives no transaction to make it
 * genuinely atomic.
 *
 * @param {{mode?:'replace'|'merge'}} [opts]
 */
export async function importBackup(raw, storage = chrome.storage?.local, { mode = 'replace' } = {}) {
  const check = validateBackup(raw);
  if (!check.ok) return { ok: false, reason: check.reason, applied: [], failed: [] };

  const applied = [];
  const failed = [];

  for (const key of EXPORTED_KEYS) {
    const incoming = check.backup.data[key];
    if (incoming === undefined) continue;
    try {
      let value = incoming;
      if (mode === 'merge') value = await mergeKey(key, incoming, storage);
      await storage.set({ [key]: value });
      applied.push(key);
    } catch {
      failed.push(key);
    }
  }

  return { ok: failed.length === 0, applied, failed, version: check.backup.version };
}

/**
 * Merge rather than replace, for the "I have two machines" case.
 *
 * Only shapes where a merge is UNAMBIGUOUS are merged. Settings are not: two
 * different values for `theme` have no correct combination, and picking one
 * silently is worse than saying replace-only.
 */
async function mergeKey(key, incoming, storage) {
  const current = (await storage.get(key))?.[key];
  if (current === undefined) return incoming;

  if (Array.isArray(current) && Array.isArray(incoming)) {
    // Arrays of records with ids: union by id, incoming wins on conflict.
    const byId = new Map();
    for (const item of current) byId.set(item?.id ?? item?.threadId ?? JSON.stringify(item), item);
    for (const item of incoming) byId.set(item?.id ?? item?.threadId ?? JSON.stringify(item), item);
    return [...byId.values()];
  }

  if (
    current && incoming &&
    typeof current === 'object' && typeof incoming === 'object' &&
    !Array.isArray(current) && !Array.isArray(incoming)
  ) {
    return { ...current, ...incoming };
  }

  return incoming;
}
