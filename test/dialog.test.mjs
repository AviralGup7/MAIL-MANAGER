/**
 * The modal primitive (under-engineering audit P3).
 *
 * dialog.js had NO dedicated test. It is the module that replaced the
 * browser's native prompt() and confirm(), which means it owns the two things
 * a native dialog gave for free and a hand-built one must earn: focus
 * management, and a keyboard route out. It is also the module the audit found
 * at the intersection of every weakness — thinnest-tested subsystem, zero
 * fuzz, outside the typechecked scope, never seen by axe.
 *
 * These are BEHAVIOURAL: the real functions run in a real jsdom document and
 * the promise's resolution is the assertion. No source-text pins — the last
 * round found three bugs that shipped green because their tests asserted on
 * the source instead of the behaviour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  test('dialog (skipped: jsdom not installed)', { skip: true }, () => {});
}

/**
 * A document per test. The dialog reads `globalThis.document` at call time,
 * and layers.js keeps module state keyed to the live document, so each test
 * gets a clean world and puts the old one back.
 */
async function withDom(fn) {
  const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  // Fresh module instances per document: layers.js holds the open-layer stack.
  const mod = await import(`../src/app/overlays/dialog.js?t=${Math.random()}`);
  try {
    return await fn(mod, dom.window.document, dom.window);
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    dom.window.close();
  }
}

const key = (win, el, k) => el.dispatchEvent(
  new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
);

// ------------------------------------------------------------- promptDialog --

test('promptDialog resolves with the typed value', async () => {
  await withDom(async ({ promptDialog }, doc) => {
    const p = promptDialog({ title: 'Save view', label: 'Name' });
    const input = doc.querySelector('.prompt-box input');
    input.value = '  Placements  ';
    doc.querySelector('.prompt-box button.primary').click();
    assert.equal(await p, 'Placements', 'the value is trimmed');
  });
});

test('promptDialog seeds and selects the existing value', async () => {
  await withDom(async ({ promptDialog }, doc) => {
    const p = promptDialog({ title: 'Rename', label: 'Name', value: 'Old name' });
    const input = doc.querySelector('.prompt-box input');
    assert.equal(input.value, 'Old name');
    assert.equal(doc.activeElement, input, 'focus lands in the field, not on a button');
    doc.querySelectorAll('.prompt-box button')[1].click(); // Cancel
    await p;
  });
});

test('CANCELLING RESOLVES null, NOT a rejection', async () => {
  // The contract every caller relies on: cancellation is an ordinary answer,
  // so a `catch` is never required to dismiss a dialog.
  await withDom(async ({ promptDialog }, doc) => {
    const p = promptDialog({ title: 'Save view', label: 'Name' });
    const buttons = [...doc.querySelectorAll('.prompt-box button')];
    buttons.find((b) => /cancel/i.test(b.textContent)).click();
    assert.equal(await p, null);
  });
});

test('ESCAPE IS A WAY OUT, and it resolves null', async () => {
  // A hand-built modal that cannot be dismissed by keyboard is a trap. The
  // native prompt() this replaced always had this.
  await withDom(async ({ promptDialog }, doc, win) => {
    const p = promptDialog({ title: 'Save view', label: 'Name' });
    key(win, doc.querySelector('.prompt-box input'), 'Escape');
    assert.equal(await p, null);
  });
});

test('Enter submits from the field', async () => {
  await withDom(async ({ promptDialog }, doc, win) => {
    const p = promptDialog({ title: 'Save view', label: 'Name' });
    const input = doc.querySelector('.prompt-box input');
    input.value = 'Quick';
    key(win, input, 'Enter');
    assert.equal(await p, 'Quick');
  });
});

test('an empty name is refused WITHOUT closing the dialog', async () => {
  await withDom(async ({ promptDialog }, doc, win) => {
    const p = promptDialog({ title: 'Save view', label: 'Name' });
    const input = doc.querySelector('.prompt-box input');
    input.value = '   ';
    key(win, input, 'Enter');
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(doc.querySelector('.prompt-box'), 'still open — the work is not lost');
    assert.match(doc.querySelector('.prompt-box').textContent, /name/i, 'and it says why');
    assert.equal(doc.activeElement, input, 'focus returns to the field to fix it');
    key(win, input, 'Escape');
    await p;
  });
});

test('A REJECTED SUBMIT KEEPS THE DIALOG OPEN AND SHOWS THE REASON', async () => {
  /*
   * The whole reason this module exists instead of native prompt(): a
   * duplicate view name must be correctable in place, not bounce the user
   * back to a toast having lost what they typed.
   */
  await withDom(async ({ promptDialog }, doc) => {
    let calls = 0;
    const p = promptDialog({
      title: 'Save view',
      label: 'Name',
      submit: async (name) => (++calls === 1
        ? { ok: false, error: 'That name is taken.' }
        : { ok: true, name }),
    });
    const input = doc.querySelector('.prompt-box input');
    const save = doc.querySelector('.prompt-box button.primary');
    input.value = 'Placements';
    save.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(doc.querySelector('.prompt-box'), 'still open');
    assert.match(doc.querySelector('.prompt-box').textContent, /taken/i);
    assert.equal(save.disabled, false, 're-armed so the user can retry');
    assert.equal(input.value, 'Placements', 'the typing survived');

    input.value = 'Placements 2';
    save.click();
    assert.equal(await p, 'Placements 2');
    assert.equal(calls, 2);
  });
});

test('a THROWING submit is contained, not leaked to the caller', async () => {
  await withDom(async ({ promptDialog }, doc) => {
    const p = promptDialog({
      title: 'Save', label: 'Name',
      submit: async () => { throw new Error('storage exploded'); },
    });
    const input = doc.querySelector('.prompt-box input');
    input.value = 'x';
    doc.querySelector('.prompt-box button.primary').click();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(doc.querySelector('.prompt-box'), 'stays open rather than vanishing');
    assert.match(doc.querySelector('.prompt-box').textContent, /could not save/i);
    assert.doesNotMatch(doc.querySelector('.prompt-box').textContent, /exploded/,
      'the internal message is not shown to the user');
    doc.querySelectorAll('.prompt-box button')[1].click(); // Cancel
    await p;
  });
});

test('the dialog announces itself as a modal with a name', async () => {
  await withDom(async ({ promptDialog }, doc) => {
    const p = promptDialog({ title: 'Save view', label: 'Name' });
    const box = doc.querySelector('.prompt-box');
    assert.equal(box.getAttribute('role'), 'dialog');
    assert.equal(box.getAttribute('aria-modal'), 'true');
    const labelledBy = box.getAttribute('aria-labelledby');
    assert.ok(labelledBy, 'it must have an accessible name');
    assert.equal(doc.getElementById(labelledBy)?.textContent, 'Save view',
      'and the name must resolve to the visible title');
    doc.querySelectorAll('.prompt-box button')[1].click(); // Cancel
    await p;
  });
});

// ------------------------------------------------------------ confirmDialog --

test('confirmDialog resolves true only on the action button', async () => {
  await withDom(async ({ confirmDialog }, doc) => {
    const p = confirmDialog({ title: 'Discard?', body: 'Unsent changes.', confirmLabel: 'Discard' });
    const btns = [...doc.querySelectorAll('.prompt-box button')];
    btns.find((b) => b.textContent === 'Discard').click();
    assert.equal(await p, true);
  });
});

test('THE SAFE CHOICE IS FOCUSED, so a reflex Enter cannot destroy anything', async () => {
  await withDom(async ({ confirmDialog }, doc) => {
    const p = confirmDialog({
      title: 'Delete for ever?', body: 'This cannot be undone.',
      confirmLabel: 'Delete', danger: true,
    });
    const focused = doc.activeElement;
    assert.equal(focused.tagName, 'BUTTON');
    assert.notEqual(focused.textContent, 'Delete',
      'the destructive button must never hold initial focus');
    focused.click();
    assert.equal(await p, false);
  });
});

test('a destructive question is an alertdialog and its button is marked', async () => {
  await withDom(async ({ confirmDialog }, doc) => {
    const p = confirmDialog({ title: 'Delete?', body: 'Gone.', confirmLabel: 'Delete', danger: true });
    const box = doc.querySelector('.prompt-box');
    assert.equal(box.getAttribute('role'), 'alertdialog',
      'assistive tech must hear that this one is different');
    assert.ok(doc.querySelector('.prompt-box button.danger'));
    doc.querySelector('.prompt-box button:not(.danger)').click();
    await p;
  });
});

test('a non-destructive question stays a plain dialog', async () => {
  await withDom(async ({ confirmDialog }, doc) => {
    const p = confirmDialog({ title: 'Send now?', body: 'It will go immediately.' });
    assert.equal(doc.querySelector('.prompt-box').getAttribute('role'), 'dialog');
    assert.equal(doc.querySelector('.prompt-box button.danger'), null);
    doc.querySelectorAll('.prompt-box button')[0].click();
    await p;
  });
});

test('Escape declines a confirm — never accepts it', async () => {
  await withDom(async ({ confirmDialog }, doc, win) => {
    const p = confirmDialog({ title: 'Delete?', body: 'Gone.', danger: true });
    key(win, doc.querySelector('.prompt-box'), 'Escape');
    assert.equal(await p, false, 'dismissal is refusal, for a destructive question above all');
  });
});

test('both dialogs remove themselves from the DOM when they resolve', async () => {
  await withDom(async ({ promptDialog, confirmDialog }, doc) => {
    const p1 = promptDialog({ title: 'A', label: 'n' });
    doc.querySelectorAll('.prompt-box button')[1].click(); // Cancel
    await p1;
    assert.equal(doc.querySelector('.prompt-box'), null, 'prompt cleaned up');
    assert.equal(doc.querySelector('.prompt-backdrop'), null, 'and so did its backdrop');

    const p2 = confirmDialog({ title: 'B', body: 'b' });
    doc.querySelectorAll('.prompt-box button')[0].click();
    await p2;
    assert.equal(doc.querySelector('.prompt-box'), null, 'confirm cleaned up');
  });
});

test('no document means null, not a crash', async () => {
  // The module is imported by the worker-adjacent graph in some contexts.
  const prev = globalThis.document;
  globalThis.document = undefined;
  try {
    const { promptDialog, confirmDialog } = await import(
      `../src/app/overlays/dialog.js?t=${Math.random()}`);
    assert.equal(await promptDialog({ title: 'x', label: 'y' }), null);
    assert.equal(await confirmDialog({ title: 'x', body: 'y' }), false);
  } finally {
    globalThis.document = prev;
  }
});
