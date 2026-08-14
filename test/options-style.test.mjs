/**
 * The all-code sweep, finding #1 (2026-08-14): the options page's rule
 * list shipped UNSTYLED.
 *
 * options.html never linked a stylesheet — its inline <style> carried the
 * body, fields and buttons but not #rule-list/.rule-row/.rule-text/
 * #rule-preview/#backup-status, which sat styled over in the APP's
 * 40-suggest.css, a bundle this page cannot see. So the shipped rule
 * editor rendered as a browser-default bulleted list and a destructive
 * dry run never turned red. Two doors, both fake: a page using selectors
 * it does not style, and a bundle styling selectors nobody mounts.
 *
 * These pins keep the pairing honest, in BOTH directions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

test('the options page styles every rules/backup selector it ships', () => {
  const html = read('options.html');
  const styleStart = html.indexOf('<style>');
  const styleEnd = html.indexOf('</style>');
  assert.ok(styleStart !== -1 && styleEnd > styleStart, 'the inline style block exists');
  const inline = html.slice(styleStart, styleEnd);
  for (const sel of ['#rule-list', '.rule-row', '.rule-text', '#rule-preview', '#backup-status']) {
    assert.ok(inline.includes(sel), `${sel} is used by this page and must be styled by this page`);
  }
  /* [data-bad] is the destructive-dry-run colour: a rule about to archive
     300 messages says so in red, and the red must exist. */
  assert.match(inline, /#rule-preview\[data-bad='true'\][^}]*color:\s*#/s, 'the destructive readout is red');
});

test('the app bundle carries no selector for markup it never mounts', () => {
  const appCss = read('src/styles/40-suggest.css');
  assert.ok(!appCss.includes('#backup-status'),
    'options-only markup stays out of the app bundle — a selector that can never match is a fake door');
});
