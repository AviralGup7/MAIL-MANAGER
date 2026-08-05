/**
 * The BITS category set.
 *
 * Carried over verbatim from the previous version's `constants.js`. The names
 * are load-bearing: they are used as Gmail label suffixes and as storage keys,
 * so renaming one silently orphans every message already labelled with it.
 *
 * NOTE ON `admin` vs `administration`: these are genuinely different in the
 * BITS context and the old version was right to separate them.
 *   - `admin`         = the Registrar / Controller / IT-support machinery
 *   - `administration`= Deans, Directors, Wardens, hostel, mess, campus ops
 * They are easy to confuse when reading the code, hence this note.
 */

export const CATEGORIES = /** @type {const} */ ([
  'admin',
  'administration',
  'augsd',
  'academics',
  'ps',
  'competitions',
  'clubs',
  'events',
  'internship',
  'library',
  'technology',
  'external-promotions',
  'external-services',
  'spam',
  'other',
]);

/** Human-facing names. Shown in the sidebar and on Gmail labels. */
export const CATEGORY_LABELS = {
  admin: 'Admin',
  administration: 'Administration',
  augsd: 'AUGSD',
  academics: 'Academics',
  ps: 'Practice School',
  clubs: 'Clubs',
  events: 'Events',
  internship: 'Internship',
  competitions: 'Competitions',
  library: 'Library',
  technology: 'Technology',
  'external-promotions': 'Ext Promotions',
  'external-services': 'Ext Services',
  spam: 'Spam',
  other: 'Other',
};

/**
 * Display order in the sidebar.
 *
 * Deliberately NOT alphabetical and NOT the declaration order. Ordered by how
 * much a student needs to see it: things with deadlines first, noise last.
 * `other` is always last because it is the fallback bucket.
 */
export const SIDEBAR_ORDER = [
  'augsd',
  'academics',
  'admin',
  'administration',
  'ps',
  'internship',
  'competitions',
  'clubs',
  'events',
  'library',
  'technology',
  'external-services',
  'external-promotions',
  'spam',
  'other',
];

/** The bucket used when nothing matches. */
export const FALLBACK_CATEGORY = 'other';

/** Categories that should be visually de-emphasised. */
export const MUTED_CATEGORIES = new Set([
  'external-promotions',
  'spam',
  'other',
]);

/**
 * Every BITS Pilani campus domain.
 *
 * Used to decide whether a message is "internal". Internal mail gets a
 * different classification path — a mail from a `@pilani.bits-pilani.ac.in`
 * address is treated very differently from an identically-worded mail from
 * outside.
 */
export const BITS_DOMAINS = [
  'pilani.bits-pilani.ac.in',
  'goa.bits-pilani.ac.in',
  'hyderabad.bits-pilani.ac.in',
  'dubai.bits-pilani.ac.in',
  'bits-pilani.ac.in',
];

export function isValidCategory(c) {
  return CATEGORIES.includes(c);
}

export function labelFor(category) {
  return CATEGORY_LABELS[category] ?? category;
}
