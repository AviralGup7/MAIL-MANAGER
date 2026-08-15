import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('one-off UI census lives in tools and has a package script', () => {
  assert.equal(existsSync(join(ROOT, '.census.mjs')), false);
  assert.equal(existsSync(join(ROOT, 'tools/ui-census.mjs')), true);
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json')));
  assert.equal(pkg.scripts['ui:census'], 'node tools/ui-census.mjs');
});

test('test filenames describe contracts rather than chronology or numbered copies', () => {
  const names = readdirSync(join(ROOT, 'test'));
  const bad = names.filter((n) => /(^round\d|integration2|^(features|parity|pipeline|polish)\.test)/.test(n));
  assert.deepEqual(bad, []);
  for (const expected of [
    'workflow-contracts.test.mjs', 'ui-regression-guards.test.mjs',
    'extraction-integrity.test.mjs', 'worker-fallback-parity.test.mjs',
    'ingestion-pipeline.test.mjs', 'ui-polish-contracts.test.mjs',
  ]) assert.ok(names.includes(expected), expected);

  /*
   * The two integration suites are SPLIT INTO PARTS (audit R3-01): 108 and
   * 115 jsdom boots in one process each exhausted the V8 heap and aborted
   * with SIGABRT, which made `npm test` red on a clean clone. node --test
   * gives each FILE its own process, so parts bound peak heap by
   * construction. This gate therefore requires the parts to exist rather
   * than the monoliths -- and requires the monoliths to be GONE, so nobody
   * silently reassembles one.
   */
  for (const family of ['app.mail.integration', 'app.features.integration']) {
    const parts = names.filter((n) => n.startsWith(`${family}.part`) && n.endsWith('.test.mjs'));
    assert.ok(parts.length >= 3, `${family} must stay split into parts, found ${parts.length}`);
    assert.equal(names.includes(`${family}.test.mjs`), false,
      `${family}.test.mjs must not come back as a monolith`);
  }
  assert.ok(existsSync(join(ROOT, 'test/helpers/app-harness.mjs')),
    'the split parts share one harness so they cannot drift');
});

test('active documentation has no broken relative Markdown links', () => {
  const files = ['README.md', ...readdirSync(join(ROOT, 'docs')).filter((n) => n.endsWith('.md')).map((n) => `docs/${n}`)];
  const broken = [];
  for (const rel of files) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    for (const match of text.matchAll(/\[[^\]]*\]\((?!https?:|mailto:|#)([^)#]+)[^)]*\)/g)) {
      const target = join(ROOT, rel.includes('/') ? 'docs' : '', match[1]);
      if (!existsSync(target)) broken.push(`${rel} -> ${match[1]}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('CSS volumes stay bounded and named by owned families', () => {
  const dir = join(ROOT, 'src/styles');
  const oversized = readdirSync(dir).filter((n) => n.endsWith('.css')).filter((n) => {
    const lines = readFileSync(join(dir, n), 'utf8').split('\n').length;
    return lines > 900;
  });
  assert.deepEqual(oversized, []);
  for (const name of ['69-selection-and-attachments.css', '70-overlays-and-rails.css', '86-v3a-rows.css', '86-v3b-motion-responsive.css']) {
    assert.ok(statSync(join(dir, name)).isFile(), name);
  }
});
