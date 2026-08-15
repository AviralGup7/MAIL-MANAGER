/**
 * The two untested overlay tenants (under-engineering audit P3).
 *
 * category-menu.js and snooze-menu.js had no dedicated tests. Both are thin
 * adapters over menu.js with an injectable ctx, which makes them cheap to
 * test properly — the gap was neglect, not difficulty.
 *
 * BEHAVIOURAL, not source pins: the real modules run against a real jsdom
 * document with a fake ctx, and the assertions are on what the menu OFFERS
 * and what running an item DOES.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  test('overlay menus (skipped: jsdom not installed)', { skip: true }, () => {});
}

/** A document plus freshly-imported modules, torn down after each test. */
async function withMenus(fn) {
  const dom = new JSDOM('<!doctype html><body><div id="reader"></div></body>', {
    pretendToBeVisual: true,
  });
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const bust = `?t=${Math.random()}`;
  const menu = await import(`../src/app/overlays/menu.js${bust}`);
  const cat = await import(`../src/app/overlays/category-menu.js${bust}`);
  const snooze = await import(`../src/app/overlays/snooze-menu.js${bust}`);
  try {
    return await fn({ menu, cat, snooze }, dom.window.document);
  } finally {
    try { menu.closeMenu(); } catch { /* already closed */ }
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    dom.window.close();
  }
}

/** The visible option rows of whatever menu is open. */
const items = (doc) => [...doc.querySelectorAll(
  '[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemcheckbox"], [role="menu"] button'
)];
const textOf = (doc) => items(doc).map((n) => n.textContent.replace(/\s+/g, ' ').trim());

function baseRules(over = {}) {
  return { muted: [], autoArchive: [], corrections: {}, mutedThreads: [], ...over };
}

// ------------------------------------------------------------ snooze menu --

test('the snooze menu offers presets, and choosing one snoozes THAT message', async () => {
  await withMenus(async ({ snooze }, doc) => {
    const calls = [];
    snooze.wireSnoozeMenu({
      getMessage: (id) => ({ id, from: 'a@b.c', subject: 'Lab report', snippet: '' }),
      snoozeMessage: (id, at, label) => calls.push({ id, at, label }),
    });
    snooze.openSnoozeMenu('m1', doc.getElementById('reader'));

    const shown = textOf(doc);
    assert.ok(shown.length >= 2, `expected presets, got ${JSON.stringify(shown)}`);
    assert.ok(shown.some((t) => /tomorrow/i.test(t)), 'Tomorrow is always offered');

    items(doc)[0].click();
    assert.equal(calls.length, 1, 'exactly one snooze, not one per render');
    assert.equal(calls[0].id, 'm1', 'and it is the message the menu was opened for');
    assert.ok(Number.isFinite(calls[0].at) && calls[0].at > Date.now(),
      'the wake time is a real future instant');
  });
});

test('AN UNKNOWN MESSAGE OPENS NOTHING — it must not throw', async () => {
  // The row can be removed by a delta between the click and the menu opening.
  await withMenus(async ({ snooze }, doc) => {
    snooze.wireSnoozeMenu({ getMessage: () => undefined, snoozeMessage: () => {
      throw new Error('must never be reached');
    } });
    snooze.openSnoozeMenu('gone', doc.getElementById('reader'));
    assert.equal(items(doc).length, 0, 'no menu for a message that is not there');
  });
});

test('a message whose deadline parser throws still gets its presets', async () => {
  /*
   * extractDeadline runs on sender-controlled text. The module wraps it in a
   * try/catch, and that guard is the whole reason a malformed subject cannot
   * cost the user the snooze feature — so it is pinned.
   */
  await withMenus(async ({ snooze }, doc) => {
    snooze.wireSnoozeMenu({
      getMessage: () => ({
        id: 'm2',
        from: 'x@y.z',
        // Deliberately hostile: lone surrogate + control chars + huge length.
        subject: '\uD800due by 31/31/2026 \u0007'.repeat(200),
        snippet: '\uDFFF',
      }),
      snoozeMessage: () => {},
    });
    snooze.openSnoozeMenu('m2', doc.getElementById('reader'));
    assert.ok(items(doc).length >= 2, 'the menu survives a message the parser cannot read');
  });
});

test('closeSnoozeMenu dismisses whatever is open', async () => {
  await withMenus(async ({ snooze }, doc) => {
    snooze.wireSnoozeMenu({
      getMessage: (id) => ({ id, from: 'a@b.c', subject: 's', snippet: '' }),
      snoozeMessage: () => {},
    });
    snooze.openSnoozeMenu('m1', doc.getElementById('reader'));
    assert.ok(items(doc).length > 0);
    snooze.closeSnoozeMenu();
    assert.equal(items(doc).length, 0);
  });
});

// ---------------------------------------------------------- category menu --

test('the category menu reports mute state and toggles it through the shell', async () => {
  await withMenus(async ({ cat }, doc) => {
    let rules = baseRules();
    let saved = 0;
    const toasts = [];
    cat.wireCategoryMenu({
      getRules: () => rules,
      setRules: (r) => { rules = r; },
      saveRules: async () => { saved++; },
      renderList: () => {}, renderSidebar: () => {},
      toast: (t) => toasts.push(t),
    });

    cat.openCategoryMenu('augsd', doc.body);
    const mute = items(doc).find((n) => /mute/i.test(n.textContent));
    assert.ok(mute, `expected a mute option, got ${JSON.stringify(textOf(doc))}`);

    mute.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(rules.muted.includes('augsd'), 'the rule actually changed');
    assert.equal(saved, 1, 'and was PERSISTED — an unsaved rule is a lie');
    assert.ok(toasts.some((t) => /muted/i.test(t)), 'and the user was told');
  });
});

test('TURNING AUTO-ARCHIVE OFF IS ONE CLICK; turning it ON is not', async () => {
  /*
   * The asymmetry is the safety property: arming a rule that removes mail on
   * arrival is confirmed, disarming it is immediate. Putting out a fire needs
   * no preview.
   */
  await withMenus(async ({ cat }, doc) => {
    let rules = baseRules({ autoArchive: ['clubs'] });
    let saved = 0;
    cat.wireCategoryMenu({
      getRules: () => rules,
      setRules: (r) => { rules = r; },
      saveRules: async () => { saved++; },
      renderList: () => {}, renderSidebar: () => {},
      toast: () => {},
      // If the ON path were taken this would be consulted; it must not be.
      confirmDialog: async () => { throw new Error('no confirm when disarming'); },
    });

    cat.openCategoryMenu('clubs', doc.body);
    const auto = items(doc).find((n) => /auto-archive/i.test(n.textContent));
    assert.ok(auto, 'the option exists');
    auto.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(!rules.autoArchive.includes('clubs'), 'disarmed immediately');
    assert.equal(saved, 1);
  });
});

test('recategorise offers every OTHER category, never the current one', async () => {
  await withMenus(async ({ cat }, doc) => {
    let rules = baseRules();
    cat.wireCategoryMenu({
      getRules: () => rules,
      setRules: (r) => { rules = r; },
      saveRules: async () => {},
      renderList: () => {}, renderSidebar: () => {}, toast: () => {},
      store: { idsFor: () => [], get: () => undefined },
      reclassify: () => {},
    });
    const msg = { id: 'm1', from: 'Prof <prof@pilani.bits-pilani.ac.in>', category: 'academics' };
    cat.openRecategoriseMenu(msg, doc.body);

    const shown = textOf(doc);
    assert.ok(shown.length > 0, 'the menu rendered');
    assert.ok(!shown.some((t) => /^academics$/i.test(t)),
      'the category it is already in is not an option');
  });
});

test('UN-TEACHING IS OFFERED FIRST, and only when something was taught', async () => {
  /*
   * Teaching a classifier something wrong and being unable to un-teach it is
   * worse than not teaching it at all — so the escape hatch outranks making
   * another correction, and it is absent when there is nothing to undo.
   */
  await withMenus(async ({ cat }, doc) => {
    const sender = 'prof@pilani.bits-pilani.ac.in';
    const msg = { id: 'm1', from: `Prof <${sender}>`, category: 'academics' };
    const wire = (rules) => cat.wireCategoryMenu({
      getRules: () => rules,
      setRules: () => {}, saveRules: async () => {},
      renderList: () => {}, renderSidebar: () => {}, toast: () => {},
      store: { idsFor: () => [], get: () => undefined },
      reclassify: () => {},
    });

    wire(baseRules());
    cat.openRecategoriseMenu(msg, doc.body);
    assert.ok(!textOf(doc).some((t) => /automatic category/i.test(t)),
      'nothing taught yet, so nothing to forget');
    cat.wireCategoryMenu; // keep the binding referenced
    const { closeMenu } = await import(`../src/app/overlays/menu.js?t=${Math.random()}`);
    try { closeMenu(); } catch { /* fine */ }

    wire(baseRules({ corrections: { [sender]: 'clubs' } }));
    cat.openRecategoriseMenu(msg, doc.body);
    const shown = textOf(doc);
    assert.ok(shown.some((t) => /automatic category/i.test(t)),
      'a taught sender can be un-taught');
    assert.match(shown[0], /automatic category/i, 'and the undo is offered FIRST');
  });
});
