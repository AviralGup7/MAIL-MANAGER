/**
 * The profile page (2026-08-16).
 *
 * WHAT MUST NOT DRIFT
 * -------------------
 *   1. HONESTY. Every figure is measured or omitted. A profile page is where
 *      dashboards invent things, and an invented number here is read as
 *      authoritative because the screen is *about the user*. A row whose
 *      value cannot be computed must be ABSENT, never a confident zero.
 *   2. TOTALITY. It opens against a half-booted app — no store, no profile
 *      call returned yet, a damaged cache row — without throwing. The page
 *      exists to be readable when things are odd.
 *   3. ISOLATION. The cyberpunk re-composition is gated like the rest of the
 *      skin, so the calm themes are pixel-identical to before it existed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  initialsOf, mailboxStats, accountScopedKeyCount, renderProfile,
} from '../src/app/overlays/profile.js';
import { ACCOUNT_SCOPED_KEYS } from '../src/app/system/storage-registry.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

/* ---------------------------------------------------------------- initials */

test('initials come from the person, not the institution', () => {
  /*
   * MEASURED BUG, FIXED BEFORE SHIPPING. Splitting the whole address gave
   * `f20240294@pilani.bits-pilani.ac.in` the initials "FB" — F from the roll
   * number, B from *bits*, which is the domain. Every student at one
   * institution would have shared that second letter, which is the opposite
   * of what an initial is for.
   */
  assert.equal(initialsOf('f20240294@pilani.bits-pilani.ac.in', ''), 'F2');
  assert.equal(initialsOf('augsd@pilani.bits-pilani.ac.in', ''), 'AU');

  // A display name is two words: use them.
  assert.equal(initialsOf('a@b.com', 'Aviral Gupta'), 'AG');
  assert.equal(initialsOf('x@y.z', 'Prof. M. Rao'), 'PM');
  // A dotted local part is a name too.
  assert.equal(initialsOf('first.last@x.com', ''), 'FL');
});

test('initialsOf is total and never renders empty', () => {
  /* An avatar with no content collapses and takes the header layout with it,
     so the fallback is a glyph rather than ''. */
  for (const [e, n] of [['', ''], [null, null], [undefined, undefined],
    ['   ', '  '], ['@nolocal.com', ''], ['!!!@x.com', '']]) {
    const out = initialsOf(e, n);
    assert.equal(typeof out, 'string');
    assert.ok(out.length >= 1 && out.length <= 2, `${JSON.stringify([e, n])} -> ${out}`);
  }
  /* A punctuated roll number is ONE identifier, not a first and last name:
     two initials require two words that both begin with a letter. */
  assert.equal(initialsOf('f2024.0294@x.com', ''), 'F2');
});

/* ------------------------------------------------------------------- stats */

test('an absent store yields nulls, not zeroes', () => {
  /*
   * THE WHOLE POINT OF THIS PAGE. "0 messages" is a claim about the mailbox;
   * null means "not measured yet" and the renderer drops the row. Before the
   * first sync those are completely different statements to a user deciding
   * whether the app is working.
   */
  for (const bad of [null, undefined, {}, 'nope', 0]) {
    const s = mailboxStats(bad);
    assert.deepEqual(s, { total: null, unread: null, categories: null },
      `mailboxStats(${JSON.stringify(bad)})`);
  }
});

test('a damaged store cannot take the page down', () => {
  /* Totality, the same law display.js and the classifier hold: one poisoned
     record costs its own verdict, never the whole surface. */
  const hostile = {
    get size() { throw new Error('boom'); },
    counts() { throw new Error('boom'); },
    unreadCounts() { throw new Error('boom'); },
  };
  assert.doesNotThrow(() => mailboxStats(hostile));
  const s = mailboxStats(hostile);
  assert.equal(s.total, null, 'an unreadable figure is unknown, not zero');
});

test('real figures are read straight from the live store', () => {
  const store = {
    size: 20,
    counts: () => ({ inbox: 12, clubs: 3, admin: 5 }),
    unreadCounts: () => ({ inbox: 6, admin: 2 }),
  };
  assert.deepEqual(mailboxStats(store), { total: 20, unread: 8, categories: 3 });
});

test('the scoped-key figure is the registry, not a copy of it', () => {
  /* A hand-maintained "18" would drift the moment a key is added. It is
     derived, so the page cannot disagree with the teardown that uses it. */
  assert.equal(accountScopedKeyCount(), ACCOUNT_SCOPED_KEYS.length);
  assert.ok(accountScopedKeyCount() > 0, 'some keys really are account-scoped');
});

/* ------------------------------------------------------------------ render */

/** The smallest DOM that renderProfile needs. */
function fakeDoc() {
  const mk = (tag) => {
    const node = {
      tagName: tag.toUpperCase(), children: [], attributes: {}, _text: '',
      className: '', id: '', hidden: false,
      appendChild(c) { this.children.push(c); return c; },
      replaceChildren() { this.children = []; },
      setAttribute(k, v) { this.attributes[k] = String(v); },
      addEventListener() {},
      querySelector: () => null,
      get textContent() {
        return this._text + this.children.map((c) => c.textContent).join('');
      },
      set textContent(v) { this._text = String(v); this.children = []; },
    };
    return node;
  };
  return { createElement: mk, createElementNS: mk };
}

test('renderProfile is total against a half-booted shell', () => {
  /* Opened before PROFILE returns, before the first sync, with no ctx members
     wired: the page must still build. This is the state a user hits when they
     click the account line during boot. */
  const doc = fakeDoc();
  for (const ctx of [{}, { state: {} }, { state: { selfEmail: '' }, store: null }]) {
    const body = doc.createElement('div');
    assert.doesNotThrow(() => renderProfile(body, ctx, doc), JSON.stringify(ctx));
    assert.ok(body.children.length > 0, 'something is always rendered');
  }
});

test('a mailbox figure that cannot be measured is omitted, not zeroed', () => {
  /*
   * With no store, the three MAILBOX figures are unknown — and they simply
   * do not appear. My first version of this test expected the whole grid to
   * collapse to a sentence; that was wrong, because the scoped-key count is
   * derived from the registry and is knowable with no mail at all. Omitting
   * per row is the stronger behaviour: the page shows exactly what it can
   * prove and stays silent about the rest.
   */
  const doc = fakeDoc();
  const body = doc.createElement('div');
  renderProfile(body, { state: {}, store: null }, doc);
  const text = body.textContent;

  for (const gone of ['messages held', 'unread', 'categories in use']) {
    assert.ok(!text.includes(gone), `"${gone}" is unknown and must be absent`);
  }
  assert.match(text, /keys scoped to you/, 'what IS knowable is still shown');
  assert.ok(!/\b0\b/.test(text), 'no fabricated zero reaches the screen');
});

test('with NOTHING measurable at all, the page explains itself', () => {
  /*
   * The registry figure is always knowable, so the empty branch cannot be
   * reached through renderProfile alone. Assert it where it lives instead of
   * writing a test that passes without exercising anything: the source must
   * carry the sentence AND the guard that reaches it.
   */
  const src = read('src/app/overlays/profile.js');
  assert.match(src, /if \(!rows\.length\)/,
    'an empty figure list takes its own branch');
  assert.match(src, /nothing to summarise/i,
    'and that branch is a sentence, not an empty grid');
  /* The filter that makes omission possible in the first place. */
  assert.match(src, /if \(value == null \|\| value === ''\) return null;/,
    'stat() drops an unknown rather than printing it');
});

test('the BITS badge uses an anchored suffix, never a bare includes', () => {
  /*
   * Round 10's H-1: `includes('bits-pilani.ac.in')` accepted
   * `evil@pilani.bits-pilani.ac.in.attacker.com`, a domain an attacker can
   * register. A badge is a trust signal, so it gets the anchored rule.
   */
  const doc = fakeDoc();
  const badgeText = (email) => {
    const body = doc.createElement('div');
    renderProfile(body, { state: { selfEmail: email } }, doc);
    return body.textContent;
  };
  assert.match(badgeText('a@pilani.bits-pilani.ac.in'), /BITS account/);
  assert.ok(!/BITS account/.test(badgeText('evil@pilani.bits-pilani.ac.in.attacker.com')),
    'a lookalike suffix domain must not earn the badge');
  assert.ok(!/BITS account/.test(badgeText('x@notbits-pilani.ac.in')));
  assert.ok(!/BITS account/.test(badgeText('x@gmail.com')));
});

/* --------------------------------------------------------------- isolation */

test('the cyberpunk profile is a re-composition, and it is gated', () => {
  const skin = read('src/styles/88-cyberpunk.css');
  const base = read('src/styles/85-profile.css');

  /* The skin must actually restate STRUCTURE here, not just colour — that is
     the claim the commit makes. */
  const profileRules = skin.split('\n').filter((l) => /\.pf-|#profile/.test(l));
  assert.ok(profileRules.length >= 12,
    'the skin should genuinely re-compose the page, not tint it');

  /* Every one of those selectors carries the gate, or the calm themes inherit
     a dossier they never asked for. */
  for (const line of profileRules.filter((l) => /\{\s*$/.test(l))) {
    assert.match(line, /\[data-theme='cyberpunk'\]/,
      `ungated profile rule in the skin volume: ${line.trim()}`);
  }

  /* And the base volume must carry no cyberpunk RULES: one owner per skin.
     Comments may name it — recording why the volume is numbered 85- is
     decision-record, the same precedent cyberpunk-theme.test.mjs sets. */
  const baseRules = base.replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.ok(!baseRules.includes('cyberpunk'),
    '85-profile.css must not carry theme-specific rules');
});

test('the base profile box does not clip the chamfer a skin cuts into it', () => {
  /*
   * MEASURED: `overflow: hidden` on #profile-box amputated the bottom-right
   * corner 88-cyberpunk clips onto that same element — visible in a render
   * before it was caught. `clip` bounds the box without creating the
   * scroll-container behaviour that ate the chamfer.
   */
  const base = read('src/styles/85-profile.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const box = base.slice(base.indexOf('#profile-box {'), base.indexOf('}', base.indexOf('#profile-box {')));
  assert.ok(!/overflow:\s*hidden/.test(box), 'hidden amputates a skin chamfer');
  assert.match(box, /overflow:\s*clip/);
});

test('the scan respects calm intensity and the textures override', () => {
  /* Both are promises the skin already makes everywhere else; a new surface
     that ignored them would be the leak this project keeps closing. */
  const skin = read('src/styles/88-cyberpunk.css');
  const at = skin.indexOf('the profile, re-composed');
  const section = skin.slice(at);
  assert.match(section, /\[data-cp-intensity='calm'\][^{]*#profile-box/,
    'calm clears the page texture');
  assert.match(section, /\[data-textures='off'\][^{]*#profile-box/,
    'textures off outranks the theme at any intensity');
});
