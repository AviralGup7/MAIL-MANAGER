/**
 * Per-row checkbox identity (accessibility audit A-A3).
 *
 * WHY: the audit's "100 identical Open buttons" clause applied here exactly
 * -- every row checkbox announced "Select message". The roster's doctrine
 * (one tab stop, aria-activedescendant) is CORRECT and stays; the defect
 * was naming, and the fix names the OBJECT, following the star button's
 * existing state-naming precedent two lines up in fillRow.
 *
 * Browser-verified post-fix (CDP queryAXTree, 2026-08-13): three sampled
 * checkboxes returned three distinct names, each = sender + subject.
 *
 * These pins are source-level because fillRow is not exported and needs no
 * new seam: the *behavioral* assertion lives in the integration suites
 * (rows render through the real path), and the live-browser evidence is
 * recorded in audits/ACCESSIBILITY-INPUT-ARCHITECTURE-AUDIT.md.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const listjs = read('src/app/mail/list.js');
const html = read('app.html'); // eslint-disable-line no-unused-vars -- markup contract lives in list.js's skeleton

test('fillRow names each checkbox sender + subject (never the bare placeholder)', () => {
  // The label assignment must sit INSIDE fillRow's refresh (the sync path),
  // so renamed subjects/re-sorted rosters cannot strand a stale identity.
  const fillStart = listjs.indexOf('function fillRow');
  assert.ok(fillStart > 0, 'fillRow exists');
  const body = listjs.slice(fillStart, listjs.indexOf('aria-selected', fillStart) + 200);
  assert.match(body, /Select: \$\{who\} — \$\{what\}/,
    'the label carries the row identity');
  assert.match(body, /displayName\(/, 'sender is humanised the same way as the visible column');
  assert.match(body, /\.subject \|\| '\(no subject\)'\)/, 'subjectless mail still names honestly');
  assert.match(body, /slice\(0, 60\)/,
    'brevity is deliberate: the option content already carries the full subject');
});

test('the roster doctrine is untouched by the naming fix', () => {
  // tabindex="-1" on the checkbox is design, not neglect: pinned here so a
  // well-meaning "make it reachable" pass has to read WHY first.
  const skeleton = listjs.slice(listjs.indexOf("'<span class=\"r-pick\">"), listjs.indexOf("'<span class=\"r-mid\">"));
  assert.match(skeleton, /class="r-check" type="checkbox" tabindex="-1"/,
    'checkboxes are still not tab stops');
  assert.match(skeleton, /aria-label="Select message"/,
    'the static skeleton keeps a pre-fill placeholder name (like the toast default)');
});
