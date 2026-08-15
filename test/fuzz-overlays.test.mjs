/**
 * Overlay fuzz (under-engineering audit P5).
 *
 * app/overlays was the only subsystem that renders MAIL-DERIVED, ATTACKER-
 * CONTROLLED strings and had zero fuzz coverage. Sender display names,
 * subjects and category labels all reach menu items, dialog titles and toast
 * text — the same input class fuzz-sanitize-depth and fuzz-display already
 * police one layer down.
 *
 * TWO PROPERTIES, and the second is the one that matters:
 *
 *   TOTALITY  — no generated input may throw. An overlay that dies takes the
 *               user's route out with it.
 *   INERTNESS — no generated input may become MARKUP. The overlays build
 *               their DOM with createElement/textContent, so a subject
 *               containing `<img onerror>` must land as visible text, never
 *               as an element. This is asserted structurally (querySelector
 *               finds no injected node), not by string inspection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  test('overlay fuzz (skipped: jsdom not installed)', { skip: true }, () => {});
}

/** Deterministic PRNG: a failure here must be reproducible, not a story. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** The hostile alphabet, drawn from what real mail and real attacks contain. */
const PIECES = [
  '<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '</div><svg onload=1>',
  '${}', '{{7*7}}', '`${x}`', '\u0000', '\u0007', '\u001b[31m', '\u007f',
  '\uD800', '\uDFFF', '\uFFFD', '\u202E', '\u200B', '\uFEFF',
  'परीक्षा', '考试时间表', '🎓🔥', 'Café résumé', 'ÅÄÖ',
  "'; DROP TABLE--", '../../etc/passwd', 'javascript:alert(1)', 'data:text/html,x',
  'A'.repeat(400), '\n\n\n', '\t\t', '   ', '', '&amp;&lt;&gt;', '%00%2e%2e',
  '__proto__', 'constructor', 'toString', 'prototype',
];

function hostile(rand, n = 3) {
  let out = '';
  for (let i = 0; i < n; i++) out += PIECES[Math.floor(rand() * PIECES.length)];
  return out;
}

/*
 * Elements an injected string must never be able to create.
 *
 * `input` is deliberately ABSENT: promptDialog builds one legitimately, and
 * including it would make this assert "the dialog has no text field" rather
 * than "the fuzz created no element". A tripwire that fires on correct
 * behaviour gets deleted by the next maintainer, so it has to be exact.
 */
const INJECTED = 'script,img,svg,iframe,object,embed,style,link,form,textarea,marquee';

async function withDom(fn) {
  const dom = new JSDOM(
    '<!doctype html><html lang="en"><body><main><div id="reader"></div>'
    + '<div id="overlay-root"></div></main></body></html>',
    { pretendToBeVisual: true }
  );
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const bust = `?t=${Math.random()}`;
  const mods = {
    dialog: await import(`../src/app/overlays/dialog.js${bust}`),
    menu: await import(`../src/app/overlays/menu.js${bust}`),
    cat: await import(`../src/app/overlays/category-menu.js${bust}`),
    snooze: await import(`../src/app/overlays/snooze-menu.js${bust}`),
  };
  try {
    return await fn(mods, dom.window.document);
  } finally {
    try { mods.menu.closeMenu(); } catch { /* already closed */ }
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    dom.window.close();
  }
}

test('a hostile subject cannot break or inject through the snooze menu', async (t) => {
  if (!JSDOM) return t.skip();
  await withDom(async ({ snooze, menu }, document) => {
    const rand = rng(20260815);
    for (let i = 0; i < 120; i++) {
      const subject = hostile(rand, 1 + Math.floor(rand() * 4));
      const from = `${hostile(rand, 2)} <${hostile(rand, 1)}@x.test>`;
      snooze.wireSnoozeMenu({
        getMessage: (id) => ({ id, from, subject, snippet: hostile(rand, 2) }),
        snoozeMessage: () => {},
      });
      try {
        snooze.openSnoozeMenu(`m${i}`, document.getElementById('reader'));
      } catch (err) {
        assert.fail(`threw on seedIndex ${i} subject=${JSON.stringify(subject)}: ${err.message}`);
      }
      assert.equal(
        document.querySelector(INJECTED), null,
        `input became MARKUP at seedIndex ${i}: ${JSON.stringify(subject)}`
      );
      menu.closeMenu();
    }
  });
});

test('a hostile sender cannot break or inject through the recategorise menu', async (t) => {
  if (!JSDOM) return t.skip();
  await withDom(async ({ cat, menu }, document) => {
    const rand = rng(777);
    for (let i = 0; i < 120; i++) {
      const from = `${hostile(rand, 2)} <${hostile(rand, 1)}@y.test>`;
      cat.wireCategoryMenu({
        getRules: () => ({ muted: [], autoArchive: [], corrections: {} }),
        setRules: () => {}, saveRules: async () => {},
        renderList: () => {}, renderSidebar: () => {}, toast: () => {},
        store: { idsFor: () => [], get: () => undefined },
        reclassify: () => {},
      });
      const msg = { id: `m${i}`, from, category: 'academics', subject: hostile(rand, 2) };
      try {
        cat.openRecategoriseMenu(msg, document.getElementById('overlay-root'));
      } catch (err) {
        assert.fail(`threw on seedIndex ${i} from=${JSON.stringify(from)}: ${err.message}`);
      }
      assert.equal(
        document.querySelector(INJECTED), null,
        `input became MARKUP at seedIndex ${i}: ${JSON.stringify(from)}`
      );
      menu.closeMenu();
    }
  });
});

test('an unknown category label cannot break the category menu', async (t) => {
  if (!JSDOM) return t.skip();
  // Categories come from stored rules, which survive a backup round trip and
  // an extension downgrade — so an unrecognised one is reachable state, not
  // a hypothetical.
  await withDom(async ({ cat, menu }, document) => {
    const rand = rng(31337);
    for (let i = 0; i < 80; i++) {
      const category = hostile(rand, 1 + Math.floor(rand() * 3));
      cat.wireCategoryMenu({
        getRules: () => ({ muted: [category], autoArchive: [], corrections: {} }),
        setRules: () => {}, saveRules: async () => {},
        renderList: () => {}, renderSidebar: () => {}, toast: () => {},
      });
      try {
        cat.openCategoryMenu(category, document.getElementById('overlay-root'));
      } catch (err) {
        assert.fail(`threw on category ${JSON.stringify(category)}: ${err.message}`);
      }
      assert.equal(
        document.querySelector(INJECTED), null,
        `category became MARKUP: ${JSON.stringify(category)}`
      );
      menu.closeMenu();
    }
  });
});

test('hostile dialog copy stays text, and the dialog still resolves', async (t) => {
  if (!JSDOM) return t.skip();
  await withDom(async ({ dialog }, document) => {
    const rand = rng(4242);
    for (let i = 0; i < 60; i++) {
      const title = hostile(rand, 2);
      const p = dialog.confirmDialog({
        title, body: hostile(rand, 3), confirmLabel: hostile(rand, 1),
        danger: rand() > 0.5,
      });
      assert.equal(
        document.querySelector(INJECTED), null,
        `dialog copy became MARKUP: ${JSON.stringify(title)}`
      );
      const box = document.querySelector('.prompt-box');
      assert.ok(box, 'the dialog rendered');
      // Whatever the copy, there is always a way out.
      const cancel = box.querySelector('button:not(.danger):not(.primary)')
        || box.querySelectorAll('button')[1] || box.querySelector('button');
      cancel.click();
      assert.equal(await p, false, `no route out at seedIndex ${i}`);
      assert.equal(document.querySelector('.prompt-box'), null, 'and it cleaned up');
    }
  });
});

test('a prompt seeded with hostile text round-trips it as a VALUE, not markup', async (t) => {
  if (!JSDOM) return t.skip();
  await withDom(async ({ dialog }, document) => {
    const rand = rng(99);
    for (let i = 0; i < 60; i++) {
      const seed = hostile(rand, 2);
      const p = dialog.promptDialog({ title: hostile(rand, 1), label: hostile(rand, 1), value: seed });
      assert.equal(document.querySelector(INJECTED), null, 'no injection from the seed');
      const input = document.querySelector('.prompt-box input');
      /*
       * Compared after newline stripping, because `<input type="text">` drops
       * CR/LF on assignment per the HTML spec — a platform rule, not a
       * mangling by this code. What matters is that the payload is carried as
       * a VALUE (data) rather than parsed, so the comparison targets exactly
       * that and does not fail on a browser behaviour the module cannot and
       * should not change.
       */
      assert.equal(input.value, seed.replace(/[\r\n]/g, ''),
        'the value survives as data, not markup');
      document.querySelectorAll('.prompt-box button')[1].click(); // Cancel
      assert.equal(await p, null);
    }
  });
});
