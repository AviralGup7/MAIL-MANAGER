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
    'app.mail.integration.test.mjs', 'app.features.integration.test.mjs',
    'workflow-contracts.test.mjs', 'ui-regression-guards.test.mjs',
    'extraction-integrity.test.mjs', 'worker-fallback-parity.test.mjs',
    'ingestion-pipeline.test.mjs', 'ui-polish-contracts.test.mjs',
  ]) assert.ok(names.includes(expected), expected);
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
