/**
 * Palette recents + disabled-with-reason (round 65/f, docs/UX-AUDIT-V4 F5).
 *
 * Behavioural pins cover the pure ordering helpers; source pins cover the
 * wiring that decides WHEN recents appear (untyped only — a typed query is
 * an explicit act and outranks habit) and how inert commands stay honest.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const src = read('src/app/palette.js');
const settingsSrc = read('src/app/settings.js');
const backupTest = read('test/backup.test.mjs');

const { parseRecents, orderForEmptyQuery } = await import('../src/app/palette.js');

const cmd = (id) => ({ id, label: `Command ${id}`, run() {} });

test('parseRecents never throws — every corruption folds to empty', () => {
  assert.deepEqual(parseRecents(''), []);
  assert.deepEqual(parseRecents('not json'), []);
  assert.deepEqual(parseRecents('{"a":1}'), [], 'an object is not a list');
  assert.deepEqual(parseRecents('[1, "a", null, "b"]'), ['a', 'b'],
    'only string ids survive');
  assert.deepEqual(parseRecents('["compose","cat:augsd"]'), ['compose', 'cat:augsd']);
});

test('untyped order: MRU first (most-recent-leading), then canonical', () => {
  const cmds = ['compose', 'refresh', 'undo', 'search', 'gmail'].map(cmd);
  const { ordered, recentCount } = orderForEmptyQuery(cmds, ['search', 'undo']);
  assert.deepEqual(ordered.map((c) => c.id),
    ['search', 'undo', 'compose', 'refresh', 'gmail']);
  assert.equal(recentCount, 2);
  assert.equal(orderForEmptyQuery(cmds, []).ordered[0].id, 'compose',
    'no recents → the canonical list, untouched');
});

test('recents are deduplicated, capped, and resolve against TODAY\'s commands', () => {
  const cmds = ['a', 'b', 'c', 'd', 'e', 'f'].map(cmd);
  const dupes = orderForEmptyQuery(cmds, ['a', 'a', 'b']);
  assert.deepEqual(dupes.ordered.slice(0, 2).map((c) => c.id), ['a', 'b'],
    'a repeated id occupies one slot');
  const cap = orderForEmptyQuery(cmds, ['f', 'e', 'd', 'c', 'b', 'a']);
  assert.equal(cap.recentCount, 4, 'RECENTS_MAX bounds the habit memory');
  // A recent id whose command does not exist right now drops out silently.
  const gone = orderForEmptyQuery([cmd('a')], ['ghost']);
  assert.deepEqual(gone.ordered.map((c) => c.id), ['a'], 'a ghost id renders no lying row');
  assert.equal(gone.recentCount, 0,
    '…and counts for nothing, so no "Recent" header floats over everything');
});

test('the settings schema carries the MRU as JSON-in-string, withheld from backups', () => {
  assert.match(settingsSrc, / {2}paletteRecents: \{ type: 'string', def: '' \}/,
    'no array type exists, and ids embed label names — delimiters would split');
  assert.match(backupTest, /paletteRecents: '[^']+'/,
    'the WITHHELD list in backup.test states why usage history is not exported');
});

test('typed queries suppress recents; untyped listings lead with them', () => {
  const typed = src.match(/if \(q\.trim\(\)\) \{([\s\S]*?)\} else \{/)[1];
  assert.match(typed, /paletteRecentCount = 0/, 'a typed query is one ranked answer set');
  assert.match(src, /orderForEmptyQuery\(\s*paletteCommands, parseRecents\(settings\.get\('paletteRecents'\)\)\s*\)/,
    'untyped order derives recents from the persisted MRU');
});

test('Undo is disabled WITH its reason, and inert rows cannot run', () => {
  assert.match(src, /disabled: undoStack\.peek\(\) \? '' : 'Nothing to undo'/,
    'the one offerable-while-inert command now says why it cannot run');
  // Enter and click both refuse disabled rows WITHOUT closing: the reason
  // must stay on screen, not vanish into a silent no-op.
  assert.match(src, /if \(!cmd \|\| cmd\.disabled\) return;\s*closePalette\(\);\s*recordRecent\(cmd\.id\);\s*cmd\.run\(\);/);
  // Arrow keys skip disabled rows through a bounded walk.
  assert.match(src, /if \(!paletteFiltered\[next\]\.disabled\) break;/);
});

test('the fallback row is never recorded as a recent', () => {
  assert.match(src, /function recordRecent\(id\) \{\s*if \(!id \|\| id === 'fallback'\) return;/,
    'searching mail for an unmatched phrase is a phrase, not a habit');
  // And the render marks disabled rows for assistive tech as disabled, in
  // place — aria-disabled, never removal.
  assert.match(src, /li\.setAttribute\('aria-disabled', 'true'\)/);
  assert.match(src, /hint\.textContent = c\.disabled;/,
    'the reason sits exactly where the shortcut would');
});
