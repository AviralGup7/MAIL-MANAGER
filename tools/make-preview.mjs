/**
 * Build a single self-contained preview.html.
 *
 * Purpose: let a human look at the actual UI without installing the extension,
 * granting OAuth, or having a BITS inbox. It inlines app.html and app.css,
 * stubs `chrome.*` and the service worker, and feeds the app synthetic BITS
 * mail through the REAL classifier and the REAL store.
 *
 * What is real here: app.js, store.js, the whole of src/classify. Only the
 * network is fake. So if the classifier mis-files something, the preview
 * mis-files it too — which is the point.
 *
 * Run:  node tools/make-preview.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** Inline an ES module graph into one <script type="module">. */
function bundle(entry) {
  const seen = new Map();
  const order = [];

  visit(entry);

  // Emit each module inside its OWN closure, wired together by a tiny
  // registry.
  //
  // The first version concatenated every file into one scope and stripped the
  // import/export keywords. That works only while no two modules share a
  // top-level name -- and the moment two of them each defined `DAY_MS`, and
  // later `$`, the bundle died with "Identifier has already been declared".
  //
  // That is a bundler defect, not a source defect: both files are correct ES
  // modules and Node loads them fine. Renaming symbols to appease the preview
  // would have been fixing the wrong thing.
  const chunks = order.map((p) => {
    let src = read(p);
    const exported = [];

    // `export { a, b } from './x.js'` -> re-export
    src = src.replace(/^\s*export\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"];?\s*$/gm, (_m, names, from) => {
      const dep = join(dirname(p), from).replace(/\\/g, '/');
      return names
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
        .map((n) => {
          const [orig, alias = orig] = n.split(/\s+as\s+/).map((x) => x.trim());
          exported.push(alias);
          return `const ${alias} = __m[${JSON.stringify(dep)}].${orig};`;
        })
        .join('\n');
    });

    // `import { a, b as c } from './x.js'`
    src = src.replace(/^\s*import\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"];?\s*$/gm, (_m, names, from) => {
      const dep = join(dirname(p), from).replace(/\\/g, '/');
      return names
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
        .map((n) => {
          const [orig, alias = orig] = n.split(/\s+as\s+/).map((x) => x.trim());
          return `const ${alias} = __m[${JSON.stringify(dep)}].${orig};`;
        })
        .join('\n');
    });

    // `import * as ns from './x.js'` — namespace import. Twelve modules use
    // this shape; left in the bundle it is a SyntaxError (`Unexpected token
    // '*'`). The registry entry IS the namespace, for preview purposes.
    src = src.replace(/^\s*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"];?\s*$/gm, (_m, name, from) => {
      const dep = join(dirname(p), from).replace(/\\/g, '/');
      return `const ${name} = __m[${JSON.stringify(dep)}];`;
    });

    // Bare `export { a, b };` — a deliberate idiom in rules.js (re-exporting
    // a local binding with no `from`). Unhandled it survives as the word
    // `export` inside the closure: `Unexpected token 'export'`.
    src = src.replace(/^\s*export\s+\{([^}]*)\}\s*;?\s*$/gm, (_m, names) => {
      for (const n of names.split(',').map((x) => x.trim()).filter(Boolean)) {
        exported.push(n.split(/\s+as\s+/).pop().trim());
      }
      return '';
    });

    // Bare side-effect imports.
    src = src.replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '');

    // `export const/let/function/class/async function`
    src = src.replace(/^\s*export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/gm, (_m, kw, name) => {
      exported.push(name);
      return `${kw} ${name}`;
    });
    src = src.replace(/^\s*export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, (_m, asy, name) => {
      exported.push(name);
      return `${asy || ''}function ${name}`;
    });
    src = src.replace(/^\s*export\s+class\s+([A-Za-z_$][\w$]*)/gm, (_m, name) => {
      exported.push(name);
      return `class ${name}`;
    });

    const uniq = [...new Set(exported)];
    return (
      `// ==== ${p} ====\n` +
      `__m[${JSON.stringify(p)}] = (function () {\n${src}\n` +
      `return { ${uniq.join(', ')} };\n})();`
    );
  });

  return `const __m = {};\n\n${chunks.join('\n\n')}`;

  function visit(p) {
    if (seen.has(p)) return;
    seen.set(p, seen.size);
    const src = read(p);
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const dep = join(dirname(p), m[1]).replace(/\\/g, '/');
      visit(dep);
    }
    order.push(p);
  }
}

export { bundle };

// Building is a side effect of RUNNING this file, not of importing it:
// the bundle-parse test imports `bundle` and must not rewrite preview.html.
const IS_MAIN = Boolean(process.argv[1]) &&
  resolve(process.argv[1]) === join(ROOT, 'tools', 'make-preview.mjs');
if (IS_MAIN) {
const appJs = bundle('src/app/app.js');
const css = read('src/app/app.css');

let html = read('app.html');
/*
 * FUNCTION REPLACERS, not template strings. The replacement text is the
 * bundle, and the bundle contains the standard regex-escape idiom `'$&'`
 * (contacts.js); in a string replacement `$&` means "the matched text", so
 * the builder used to splice the very tag it was replacing into the middle
 * of a string literal — a SyntaxError before the first statement. Audit 33.
 */
html = html.replace(/<link rel="stylesheet"[^>]*>/, () => `<style>\n${css}\n</style>`);
html = html.replace(
  /<script type="module" src="src\/app\/app\.js"><\/script>/,
  () => `<script type="module">\n${MOCK()}\n${appJs}\n</script>`
);
html = html.replace(
  '<title>BITS Mail Manager</title>',
  () => '<title>BITS Mail Manager — preview (synthetic data)</title>'
);

writeFileSync(join(ROOT, 'preview.html'), html);
console.log(`preview.html  ${(html.length / 1024).toFixed(1)} KB`);
}

// ---------------------------------------------------------------- the mock --

function MOCK() {
  return `
/* ===================== PREVIEW MOCK — not shipped ====================== */
/* Fakes chrome.* and the service worker. Everything else is the real app.  */

const NOW = Date.now();
const H = 3600000;

/** Synthetic mail shaped like a real Pilani inbox. */
const SEED = [
  ['AUGSD <augsd@pilani.bits-pilani.ac.in>', 'Registration for Semester II 2025-26 — deadlines', 'Course registration opens on Monday. Students with pending fee payment will not be able to register.', 0.4, true],
  ['Practice School Division <psd@pilani.bits-pilani.ac.in>', 'PS-II Station Allotment Round 2 — response required', 'The second round of station allotment is now live on the PS portal. Confirm your preference within 48 hours.', 2, true],
  ['Placement Unit <placementunit@pilani.bits-pilani.ac.in>', 'Pre-placement talk: Quantitative Research role', 'PPT scheduled in the FD-III auditorium. Attendance is mandatory for all registered candidates.', 3.5, true],
  ['Department of Computer Science <cs@pilani.bits-pilani.ac.in>', 'CS F364 Design & Analysis of Algorithms — makeup class', 'Makeup lecture for the cancelled session will be held Saturday 9 AM in LTC 305.', 5, false],
  ['Controller of Examinations <exams@pilani.bits-pilani.ac.in>', 'Comprehensive examination seating arrangement', 'Seating plans for the comprehensive examinations have been published on the notice board and the ERP.', 7, true],
  ['ACM BITS Pilani <acm@pilani.bits-pilani.ac.in>', 'Recruitment 2025 — technical round shortlist', 'Congratulations, you have been shortlisted for the technical interview round. Slots are on the linked sheet.', 9, true],
  ['Department of Visual Arts <dva@pilani.bits-pilani.ac.in>', 'Auditions for the annual production', 'Open auditions this weekend at the Amphitheatre. No prior experience needed, just show up.', 11, false],
  ['APOGEE <apogee@pilani.bits-pilani.ac.in>', 'Call for volunteers — technical festival', 'Registrations for the organising committee close Friday. Departments with open positions are listed inside.', 13, false],
  ['Chief Warden <chiefwarden@pilani.bits-pilani.ac.in>', 'Hostel room vacation notice before winter break', 'All residents must vacate rooms by 5 PM on the last day of examinations. Luggage rooms will remain open.', 15, true],
  ['Mess Committee <mess@pilani.bits-pilani.ac.in>', 'Mess rebate applications for the winter break', 'Apply for the rebate through the ERP before the deadline. Late applications will not be entertained.', 18, false],
  ['Library <library@pilani.bits-pilani.ac.in>', 'Overdue notice: 2 items due for return', 'The following borrowed items are overdue. A fine accrues daily until the items are returned to the circulation desk.', 21, true],
  ['IT Services <itservices@pilani.bits-pilani.ac.in>', 'Scheduled network maintenance — Saturday 2 AM to 6 AM', 'Campus Wi-Fi and the ERP will be unavailable during the maintenance window. Plan submissions accordingly.', 26, false],
  ['Registrar <registrar@pilani.bits-pilani.ac.in>', 'Issue of provisional degree certificates', 'Eligible students may collect their provisional certificates from the Academic Registration & Counselling Division.', 30, false],
  ['Nirmaan Organisation <nirmaan@pilani.bits-pilani.ac.in>', 'Teaching volunteers needed for the weekend programme', 'We are short of volunteers for the Saturday session at the village school. Transport is arranged.', 34, false],
  ['Coding Club <codingclub@pilani.bits-pilani.ac.in>', 'ICPC regionals practice contest this Sunday', 'A five-hour mirror contest will run on the club judge. Teams of three, register through the portal.', 38, false],
  ['GitHub <notifications@github.com>', '[AviralGup7/MAIL-MANAGER] Run failed: CI on main', 'The workflow run for commit e0044f2 failed. View the run log for details. Unsubscribe from these notifications.', 41, true],
  ['arXiv <no-reply@arxiv.org>', 'New submissions in cs.CR you may find relevant', 'Six new preprints matching your saved interests were announced today. Unsubscribe from daily digests.', 46, false],
  ['Internshala <noreply@internshala.com>', 'Flat 60% OFF on all placement training programmes', 'Limited period offer, hurry! Enrol now and get lifetime access to all our courses. Unsubscribe here.', 52, false],
  ['Unstop <team@unstop.com>', 'National case study competition — register before Friday', 'Cash prizes worth two lakh rupees. Open to all undergraduate students across India. Apply now.', 58, false],
  ['Google <no-reply@accounts.google.com>', 'Security alert: new sign-in on Chrome', 'A new device signed in to your account. If this was you, no action is needed.', 64, false],
];

const MESSAGES = SEED.map(([from, subject, snippet, hoursAgo, unread], i) => ({
  id: 'm' + i,
  threadId: 't' + i,
  from,
  subject,
  snippet,
  date: NOW - hoursAgo * H,
  unread,
  starred: i === 1 || i === 5,
  labels: ['INBOX'],
}));

const store_ = {};
globalThis.chrome = {
  runtime: {
    id: 'preview',
    lastError: null,
    openOptionsPage() { alert('Options page — not available in the preview.'); },
    sendMessage(msg, cb) {
      setTimeout(() => cb(respond(msg)), msg.type === 'GET_BODY' ? 90 : 140);
    },
  },
  storage: {
    local: {
      async get(k) {
        if (Array.isArray(k)) { const o = {}; for (const key of k) if (key in store_) o[key] = store_[key]; return o; }
        if (typeof k === 'string') return k in store_ ? { [k]: store_[k] } : {};
        return { ...store_ };
      },
      async set(o) { Object.assign(store_, o); },
      async remove(k) { for (const key of [].concat(k)) delete store_[key]; },
    },
  },
  identity: { getRedirectURL: () => 'https://preview.chromiumapp.org/' },
};

function respond(msg) {
  switch (msg.type) {
    case 'AUTH_STATUS': return { ok: true, data: { signedIn: true } };
    case 'PROFILE': return { ok: true, data: { emailAddress: 'f20240294@pilani.bits-pilani.ac.in' } };
    case 'SYNC_PAGE':
      return { ok: true, data: { messages: msg.opts?.pageToken ? [] : MESSAGES, nextPageToken: '' } };
    case 'SYNC_DELTA': {
      // Review seam: queued messages arrive as a delta, so the new-mail pill
      // (concept #6 R3) is exercisable in the preview.
      const q = globalThis.__bmmDeltaQueue || [];
      globalThis.__bmmDeltaQueue = [];
      return { ok: true, data: { kind: 'delta', added: q, removed: [], patched: [] } };
    }
    case 'GET_BODY': {
      const m = MESSAGES.find((x) => x.id === msg.id);
      // One message carries an attachment, so the chip and its download path
      // are actually exercisable in review rather than dead UI.
      const withAtt = msg.id === 'm1'
        ? [{ filename: 'Registration-Schedule.pdf', mimeType: 'application/pdf',
             size: 284_112, attachmentId: 'att-1' }]
        : [];
      return { ok: true, data: {
        id: msg.id, attachments: withAtt,
        html: '<p>' + esc(m.snippet) + '</p>' +
              '<p>This is preview content. The real extension renders the actual message body here, ' +
              'inside a sandboxed iframe with no allow-scripts and no allow-same-origin.</p>' +
              '<p style="color:#8a91a0;font-size:12.5px">— ' + esc(m.from) + '</p>',
        text: '' } };
    }
    // Compose. Without these the preview leaves the status stuck on
    // "Saving…" forever, and a reviewer cannot exercise compose at all --
    // which is exactly what happened the first time I tried.
    case 'SEND':       return { ok: true, data: { id: 'sent-1' } };
    case 'SAVE_DRAFT': return { ok: true, data: { id: 'draft-1' } };
    case 'LIST_LABELS':return { ok: true, data: [] };
    case 'GET_ATTACHMENT':
      return { ok: true, data: { dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK' } };
    case 'UNARCHIVE':
    case 'UNTRASH':    return { ok: true, data: {} };
    default: return { ok: true, data: {} };  // triage actions all "succeed"
  }
}

function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

/* The app posts BMM_READY to its parent. With no content script above us,
   parent === window, so it posts to itself. Harmless — nothing listens for
   BMM_READY here. We answer with BMM_SHOWN so the scroller takes focus and
   the j/k shortcuts work immediately, exactly as they do in the extension. */
window.addEventListener('message', (e) => {
  if (e.data?.type === 'BMM_READY') {
    window.postMessage({ type: 'BMM_SHOWN' }, '*');
  }
});
/* ==================== END PREVIEW MOCK ==================== */
`;
}
