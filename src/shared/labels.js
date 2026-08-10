/**
 * Shared constants that cross the app/worker seam.
 *
 * R-5 (architecture audit): `SNOOZE_LABEL` used to live in src/app/snooze.js,
 * which forced the service worker — the most security-critical module set —
 * to import from the app layer. One shared module keeps the dependency
 * direction honest: worker and app both point DOWN at shared, never at each
 * other.
 */
export const SNOOZE_LABEL = 'BMM/Snoozed';
