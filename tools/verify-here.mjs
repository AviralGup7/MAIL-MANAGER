/**
 * Verify THE FOLDER YOU ARE ACTUALLY LOADING.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two agents and I have now all validated this repository and all three found
 * it clean. Every one of those checks ran against a FRESH CLONE in a
 * container -- the other agent's paths were
 * `/home/runner/work/MAIL-MANAGER/...`, a CI runner, not your laptop.
 *
 * So "the repo is fine" has been established three times and has not helped
 * once, because the thing failing is the copy on YOUR disk, which none of us
 * has seen. A fresh clone passing tells you nothing about a working directory
 * with local edits, a partial pull, a stale file, or a mangled manifest.
 *
 * This script has NO dependencies and does not need npm install. Copy it
 * anywhere and point it at the exact folder you selected in "Load unpacked":
 *
 *   node tools/verify-here.mjs
 *   node tools/verify-here.mjs /path/to/whatever/you/loaded
 *
 * It prints a fingerprint you can compare against the reference below, so we
 * can settle in one step whether your files differ from the ones that pass.
 */

import { readFileSync, existsSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';

const DIR = resolve(process.argv[2] || process.cwd());

/*
 * The md5s of the five service-worker modules and the manifest, as they exist
 * on the commit where every check passes. If yours differ, your working copy
 * is not the code that was verified -- and that is the whole answer.
 */
const REFERENCE = {
  'manifest.json': '52063ff7870a',
  'src/background/index.js': 'd00ee662af26',
  'src/background/auth.js': 'baa953195d11',
  'src/background/gmail.js': '93e4dd778df6',
  'src/background/sync.js': '56973bb7fdee',
  'src/app/snooze.js': 'a94c5172d27e',
};

const md5 = (p) => createHash('md5').update(readFileSync(p)).digest('hex').slice(0, 12);
const problems = [];
const say = (s = '') => console.log(s);

say();
say('Verifying the folder Chrome is loading');
say('─'.repeat(60));
say(`  ${DIR}`);
say();

/* ------------------------------------------------ is this even the right dir */

if (!existsSync(join(DIR, 'manifest.json'))) {
  say('  ✗ There is no manifest.json here.');
  say();
  say('    "Load unpacked" must point at the folder CONTAINING manifest.json.');
  say('    Not a parent folder, not src/, not a zip you extracted twice');
  say('    (which often gives you MAIL-MANAGER/MAIL-MANAGER/).');
  say();
  process.exit(1);
}

/* ------------------------------------------------------------ the fingerprint */

say('  File                              yours         reference     ');
say('  ' + '─'.repeat(58));
let drift = 0;
for (const [rel, want] of Object.entries(REFERENCE)) {
  const abs = join(DIR, rel);
  if (!existsSync(abs)) {
    say(`  ${rel.padEnd(33)} MISSING       ${want}`);
    problems.push(`${rel} does not exist in this folder`);
    drift++;
    continue;
  }
  const got = md5(abs);
  const mark = got === want ? '' : '   <-- DIFFERS';
  if (got !== want) drift++;
  say(`  ${rel.padEnd(33)} ${got}  ${want}${mark}`);
}
say();

if (drift) {
  problems.push(
    `${drift} file(s) differ from the verified commit. Your working copy is not `
    + 'the code that passes. Run: git stash && git pull'
  );
}

/* --------------------------------------------------------- manifest specifics */

let manifest = null;
try {
  const raw = readFileSync(join(DIR, 'manifest.json'), 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) {
    problems.push('manifest.json begins with a byte-order mark; Chrome rejects the file.');
  }
  manifest = JSON.parse(raw.replace(/^\uFEFF/, ''));

  // The mangling seen twice in pasted copies: valid JSON, invalid to Chrome.
  if (/\[https?:\/\/[^\]]*\]\(/.test(raw)) {
    problems.push(
      'manifest.json contains markdown link syntax like '
      + '"[https://mail.google.com/*](https://mail.google.com/*)". It parses as '
      + 'JSON, so it looks fine, and Chrome rejects the match patterns.'
    );
  }

  const sw = manifest.background?.service_worker;
  if (!sw) {
    problems.push('manifest declares no background.service_worker.');
  } else {
    const swAbs = join(DIR, sw);
    if (!existsSync(swAbs)) {
      problems.push(`background.service_worker points at "${sw}", which is not in this folder.`);
    } else {
      // Walk the import graph, on disk, exactly as the browser resolves it.
      const seen = new Set();
      const stack = [swAbs];
      while (stack.length) {
        const f = stack.pop();
        if (seen.has(f)) continue;
        seen.add(f);
        const src = readFileSync(f, 'utf8');
        for (const m of src.matchAll(/^\s*(?:import|export)(?:[\s\S]*?from)?\s*['"]([^'"]+)['"]/gm)) {
          const spec = m[1];
          if (!spec.startsWith('.')) continue;
          const target = resolve(f, '..', spec);
          if (!existsSync(target)) {
            problems.push(
              `${relative(DIR, f)} imports "${spec}" and that file is not on disk here.`
            );
            continue;
          }
          stack.push(target);
        }
      }
      say(`  Service worker graph: ${seen.size} module(s), all present on disk.`);
    }
  }
} catch (e) {
  problems.push(`manifest.json is not valid JSON: ${e.message}`);
}

/* ----------------------------------------- things Chrome refuses outright */

const walk = (dir, depth = 0) => {
  if (depth > 4) return;
  let entries = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (name === '.git' || name === 'node_modules') continue;
    const abs = join(dir, name);
    // Chrome reserves the "_" prefix and refuses the whole extension.
    if (name.startsWith('_')) {
      problems.push(
        `"${relative(DIR, abs)}" starts with an underscore. Chrome reserves that `
        + 'prefix and will refuse to load the extension.'
      );
    }
    let st;
    try { st = lstatSync(abs); } catch { continue; }
    if (st.isSymbolicLink()) {
      problems.push(`"${relative(DIR, abs)}" is a symlink; Chrome does not follow these.`);
      continue;
    }
    if (st.isDirectory()) walk(abs, depth + 1);
  }
};
walk(DIR);

if (existsSync(join(DIR, 'node_modules'))) {
  const n = (() => {
    try { return readdirSync(join(DIR, 'node_modules')).length; } catch { return 0; }
  })();
  if (n) {
    say(`  Note: node_modules/ is present (${n} entries). Harmless for loading,`);
    say('        but it is packaged into the extension and slows every reload.');
  }
}

/* ---------------------------------------------------------------- the verdict */

say();
if (!problems.length) {
  say('  ✓ This folder is byte-for-byte the verified code, and nothing here');
  say('    can cause a registration failure.');
  say();
  say('  Which means the cause is NOT in these files. Next, in order:');
  say();
  say('    1. Load tools/sw-probe as a separate unpacked extension. It is a');
  say('       manifest plus one console.log, with no permissions and no');
  say('       imports. If THAT fails too, no repository change will ever fix');
  say('       this and the fault is your browser or profile.');
  say();
  say('    2. chrome://policy  — look for ExtensionSettings or');
  say('       ExtensionInstallBlocklist. Managed or work machines routinely');
  say('       block unpacked extensions, and the failure looks exactly like');
  say('       this.');
  say();
  say('    3. Try a brand-new Chrome profile, or Chrome Canary.');
  say();
  say('    4. chrome://version — confirm 116 or newer, and check "Profile');
  say('       Path" is somewhere writable and local (not a network drive,');
  say('       not a read-only mount, not a WSL path being used from Windows).');
  say();
  process.exit(0);
}

say(`  ${problems.length} problem(s) found in THIS folder:`);
say();
for (const [i, p] of problems.entries()) say(`   ${i + 1}. ${p}`);
say();
process.exit(1);
