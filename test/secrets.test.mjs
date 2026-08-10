/**
 * Secret scanning (cross-audit H-1/H-2): the v1 client secret and a live PAT
 * are historical wounds; this test makes their shape unshippable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = ['src', 'tools', 'test', '.github', 'docs', 'audits'].flatMap((dir) => {
  const out = [];
  const walk = (d) => {
    for (const f of readdirSync(join(ROOT, d))) {
      const p = join(ROOT, d, f);
      if (statSync(p).isDirectory()) walk(join(d, f));
      else if (/\.(js|mjs|json|yml|md|html)$/.test(f)) out.push(p);
    }
  };
  try { walk(dir); } catch { /* optional dir */ }
  return out;
});
SCAN.push(join(ROOT, 'manifest.json'), join(ROOT, 'app.html'), join(ROOT, 'package.json'));

test('no GitHub PAT or OAuth client secret shape ships', () => {
  const bad = [];
  for (const p of SCAN) {
    const s = readFileSync(p, 'utf8');
    if (/ghp_[A-Za-z0-9]{36}/.test(s)) bad.push(p + ': GitHub PAT');
    if (/client_secret\s*[:=]\s*['"][A-Za-z0-9-]{10,}/.test(s)) bad.push(p + ': client secret');
  }
  assert.deepEqual(bad, [], bad.join('; '));
});
