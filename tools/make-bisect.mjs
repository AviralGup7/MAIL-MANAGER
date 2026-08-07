/**
 * Build loadable extension folders that bisect a registration failure.
 *
 * WHY THIS EXISTS
 * ---------------
 * The user reports the extension loaded fine before the timetable and
 * modularization work, and fails now. Every static comparison says that
 * should not be true:
 *
 *   - manifest.json is IDENTICAL to the last-working commit (e8fd607)
 *   - all five service-worker modules evaluate cleanly in a worker-like
 *     global at every commit from e8fd607 to HEAD -- tested, not reasoned
 *   - the worker's import graph never changed: same five files, same
 *     specifiers, byte-identical
 *   - no long, non-ASCII or reserved filenames; 2.8MB total
 *
 * So reading the code has stopped producing information. What is left is the
 * difference between "these files are fine" and "this folder loads", and only
 * a browser can answer that.
 *
 * This writes four self-contained extension folders under tools/bisect/.
 * Load them one at a time. Each isolates one suspect, so whichever fails
 * first names the cause.
 *
 *   node tools/make-bisect.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tools', 'bisect');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

/** Copy the files a real load needs, optionally skipping some. */
function copyPayload(dest, { timetable = true } = {}) {
  for (const rel of ['app.html', 'options.html', 'icons', 'src']) {
    const from = join(ROOT, rel);
    if (!existsSync(from)) continue;
    cpSync(from, join(dest, rel), {
      recursive: true,
      filter: (src) => {
        if (timetable) return true;
        // Drop the timetable payload: 1MB of JSON and source text.
        return !src.includes(`${'src'}/timetable`);
      },
    });
  }
}

const cases = [];

/* 1 ─────────────────────────────────────────────────────────── bare worker */
{
  const dir = join(OUT, '1-bare-worker');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'BMM bisect 1 — bare worker',
    version: '1.0',
    background: { service_worker: 'sw.js', type: 'module' },
  }, null, 2) + '\n');
  writeFileSync(join(dir, 'sw.js'), "console.log('[BISECT 1] bare worker registered');\n");
  cases.push(['1-bare-worker',
    'A manifest and one console.log. No key, no permissions, no imports.',
    'FAILS -> the fault is your browser or profile, not this repo at all.']);
}

/* 2 ──────────────────────────────────── real worker, nothing else attached */
{
  const dir = join(OUT, '2-real-worker-only');
  mkdirSync(join(dir, 'src', 'app'), { recursive: true });
  mkdirSync(join(dir, 'src', 'background'), { recursive: true });
  for (const f of [
    'src/background/index.js', 'src/background/auth.js',
    'src/background/gmail.js', 'src/background/sync.js', 'src/app/snooze.js',
  ]) {
    cpSync(join(ROOT, f), join(dir, f));
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'BMM bisect 2 — real worker only',
    version: '1.0',
    permissions: manifest.permissions,
    host_permissions: manifest.host_permissions,
    background: manifest.background,
  }, null, 2) + '\n');
  cases.push(['2-real-worker-only',
    'The genuine five-module worker and its permissions. No key, no pages, '
    + 'no content script, no timetable.',
    'FAILS -> the worker code or a permission is the cause.']);
}

/* 3 ─────────────────────────────────── everything except the manifest key */
{
  const dir = join(OUT, '3-no-key');
  mkdirSync(dir, { recursive: true });
  const m = { ...manifest };
  delete m.key;
  m.name = 'BMM bisect 3 — no key';
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  copyPayload(dir);
  cases.push(['3-no-key',
    'The complete extension with the "key" field removed, so Chrome assigns '
    + 'a fresh ID instead of pinning one.',
    'LOADS while 4 fails -> an ID collision in your profile is the cause.']);
}

/* 4 ──────────────────────────────────────── everything except the timetable */
{
  const dir = join(OUT, '4-no-timetable');
  mkdirSync(dir, { recursive: true });
  const m = { ...manifest, name: 'BMM bisect 4 — no timetable' };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  copyPayload(dir, { timetable: false });
  cases.push(['4-no-timetable',
    'The complete extension, key included, with src/timetable/ omitted '
    + '(1MB of JSON and source text added after the last working build).',
    'LOADS while the real one fails -> the timetable payload is the cause.']);
}

/* 5 ──────────────────────────────── the whole extension, worker deleted */
{
  const dir = join(OUT, '5-no-worker');
  mkdirSync(dir, { recursive: true });
  const m = { ...manifest, name: 'BMM bisect 5 — no service worker' };
  delete m.background;
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  copyPayload(dir);
  cases.push(['5-no-worker',
    'Everything, with the "background" key deleted outright. The content '
    + 'script still injects and app.html still renders; nothing answers the '
    + '27 verbs, so sign-in and sync will fail.',
    'LOADS -> the worker really was blocking the load. STILL FAILS -> the '
    + 'worker was never the cause and the fault is the manifest, profile or '
    + 'browser.']);
}

/* 6 ──────────── the decisive one: a DIFFERENT extension ID ─────────── */
{
  const dir = join(OUT, '6-fresh-id');
  mkdirSync(dir, { recursive: true });
  const m = { ...manifest, name: 'BMM bisect 6 - fresh extension ID' };
  /*
   * No key => Chrome mints a new ID => a CLEAN service-worker registration
   * slot in the profile.
   *
   * This is the decisive test. A profile that holds an UNREGISTERED slot for
   * an extension ID will not re-create it on reload, and a pinned key means
   * remove + load-unpacked hands you the same ID and the same poisoned slot
   * every time -- which is exactly why reinstalling never helped here.
   *
   * If this variant registers while the real extension does not, the fault
   * is the profile's registration slot, not one line of our code.
   */
  delete m.key;
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  copyPayload(dir);
  cases.push(['6-fresh-id',
    'The complete extension with "key" removed, so Chrome assigns a NEW id '
    + 'and therefore a clean registration slot.',
    'LOADS -> the profile\'s slot for the pinned ID is poisoned. That is the '
    + 'bug, and no code change fixes it: use the popup\'s Repair button, or '
    + 'ship without the key.']);
}

console.log('\nBisect folders written to tools/bisect/\n');
console.log('Load each with "Load unpacked", in order, and note which is the');
console.log('FIRST to fail. Remove the previous one before loading the next.\n');
for (const [name, what, meaning] of cases) {
  console.log(`  ${name}`);
  console.log(`     ${what}`);
  console.log(`     ${meaning}\n`);
}
console.log('Whichever one first shows "Service worker registration failed"');
console.log('names the cause, and that is the answer neither static analysis');
console.log('nor the test suite has been able to reach.\n');
