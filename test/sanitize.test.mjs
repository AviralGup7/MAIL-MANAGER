/**
 * Sanitiser tests.
 *
 * The old regex chain passed `<svg/onload=alert(1)>` straight through, because
 * its handler stripper required whitespace before the attribute and a solidus
 * is a valid HTML5 separator. It was not exploitable -- the render iframe has
 * no allow-scripts -- but it was documented as "defence in depth" while being
 * one bypass deep.
 *
 * These tests are adversarial on purpose. Every payload below is a real,
 * catalogued filter bypass, and each asserts on the OUTPUT rather than on the
 * absence of a substring, because "does not contain the word script" is how
 * sanitisers pass tests while remaining broken.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  test('sanitize (skipped: jsdom not installed)', { skip: true }, () => {});
}

const { sanitizeHtml, escapeHtml } = await import('../src/app/sanitize.js');

/** Run the sanitiser inside a jsdom document. */
function clean(html) {
  // Deliberately does NOT set globalThis.DOMParser. The first version of this
  // helper did, which masked a real bug: sanitizeHtml read the parser off
  // globalThis and threw "DOMParser is not a constructor" in the actual
  // extension. It now resolves the parser from the document's own window, and
  // this helper proves it.
  const dom = new JSDOM('<!doctype html><body></body>');
  return sanitizeHtml(html, dom.window.document);
}

/** Parse the output and ask real DOM questions about it. */
function parse(html) {
  return new JSDOM(`<!doctype html><body>${html}</body>`).window.document.body;
}

// ------------------------------------------------------------- bypasses ----

test('THE BYPASS: <svg/onload=> is neutralised', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Survived the old regex chain untouched.
  const out = clean('<svg/onload=alert(1)>');
  assert.equal(out, '', 'svg is dropped entirely');
});

test('no event handler survives, however it is written', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const payloads = [
    '<img src=x onerror=alert(1)>',
    '<img\nsrc=x\nonerror=alert(1)>',
    '<img src=x OnErRoR=alert(1)>',
    '<img/src=x/onerror=alert(1)>',
    '<div onmouseover="alert(1)">hover</div>',
    '<body onload=alert(1)>',
    '<p onfocus=alert(1) tabindex=1>x</p>',
    '<img src=x onerror\u000c=alert(1)>',
  ];
  for (const p of payloads) {
    const body = parse(clean(p));
    for (const el of body.querySelectorAll('*')) {
      for (const a of el.attributes) {
        assert.ok(!a.name.toLowerCase().startsWith('on'), `handler survived in: ${p}`);
      }
    }
  }
});

test('script content can never execute, however the tag is smuggled', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Asserts on EXECUTABILITY, not on the absence of a substring.
  //
  // The first version of this test failed on `<scr<script>ipt>` and looked
  // like a sanitiser bug. It was a test bug: the output is the escaped TEXT
  // "ipt&gt;alert(1)" -- zero script elements, nothing runs. Grepping for
  // "alert(1)" cannot tell inert text from live markup, which is exactly the
  // mistake that lets a broken sanitiser pass a green suite.
  for (const p of [
    '<script>alert(1)</script>',
    '<scr<script>ipt>alert(1)</script>',
    '<SCRIPT>alert(1)</SCRIPT>',
    '<script src="//evil.example/x.js"></script>',
    '<noscript><script>alert(1)</script></noscript>',
    '<div><script>alert(1)</script>text</div>',
  ]) {
    const body = parse(clean(p));
    assert.equal(body.querySelectorAll('script').length, 0, `script element survived: ${p}`);
    assert.equal(body.querySelectorAll('*[src]').length, 0, `a fetchable src survived: ${p}`);
  }
});

test('dangerous URL schemes are stripped from href', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const payloads = [
    '<a href="javascript:alert(1)">x</a>',
    '<a href="JaVaScRiPt:alert(1)">x</a>',
    '<a href="  javascript:alert(1)">x</a>',
    '<a href="java\tscript:alert(1)">x</a>',
    '<a href="java&#09;script:alert(1)">x</a>',
    '<a href="vbscript:msgbox(1)">x</a>',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  ];
  for (const p of payloads) {
    const body = parse(clean(p));
    const a = body.querySelector('a');
    const href = a?.getAttribute('href') || '';
    assert.ok(
      href === '' || /^(https?:|mailto:|tel:)/i.test(href),
      `unsafe href survived: ${p} -> ${href}`
    );
  }
});

test('CSS cannot smuggle a script or a tracking fetch', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const body = parse(
    clean(
      '<div style="color:red; background-image:url(https://evil.example/pixel.gif);' +
        'width:expression(alert(1)); position:fixed">x</div>'
    )
  );
  const style = body.querySelector('div').getAttribute('style') || '';
  assert.ok(style.includes('color'), 'harmless properties survive');
  assert.ok(!/url\(/i.test(style), 'url() must be stripped — it defeats the img CSP');
  assert.ok(!/expression/i.test(style), 'expression() must be stripped');
  assert.ok(!/position/i.test(style), 'position is not allow-listed — it can overlay app chrome');
});

test('framing and plugin elements are dropped', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  for (const p of [
    '<iframe src="https://evil.example"></iframe>',
    '<object data="x.swf"></object>',
    '<embed src="x.swf">',
    '<base href="https://evil.example/">',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '<link rel="stylesheet" href="https://evil.example/x.css">',
    '<form action="https://evil.example"><input name="p"></form>',
  ]) {
    const body = parse(clean(p));
    assert.equal(
      body.querySelector('iframe, object, embed, base, meta, link, form, input'),
      null,
      `survived: ${p}`
    );
  }
});

// ------------------------------------------------------- real mail works ---

test('ordinary formatted mail survives intact', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const body = parse(
    clean(
      '<p>Dear <b>student</b>,</p>' +
        '<p style="color:#333">Registration closes <em>Friday</em>.</p>' +
        '<ul><li>Item one</li><li>Item two</li></ul>'
    )
  );
  assert.equal(body.querySelectorAll('p').length, 2);
  assert.ok(body.querySelector('b'));
  assert.ok(body.querySelector('em'));
  assert.equal(body.querySelectorAll('li').length, 2);
  assert.ok(body.textContent.includes('Registration closes'));
});

test('table layouts survive — most institutional mail is a table', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const body = parse(
    clean(
      '<table width="600" cellpadding="8" bgcolor="#eee"><tr>' +
        '<td colspan="2" align="center">Notice</td></tr></table>'
    )
  );
  const td = body.querySelector('td');
  assert.ok(body.querySelector('table'));
  assert.equal(td.getAttribute('colspan'), '2');
  assert.equal(body.querySelector('table').getAttribute('width'), '600');
});

test('safe links are kept and hardened', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const a = parse(clean('<a href="https://bits-pilani.ac.in/notice">Notice</a>')).querySelector('a');
  assert.equal(a.getAttribute('href'), 'https://bits-pilani.ac.in/notice');
  assert.equal(a.getAttribute('target'), '_blank');
  const rel = a.getAttribute('rel');
  // noopener stops the target reaching back through window.opener.
  assert.ok(rel.includes('noopener') && rel.includes('noreferrer'));
});

test('images keep their src and alt', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const img = parse(clean('<img src="https://x.example/a.png" alt="Logo" width="80">')).querySelector('img');
  assert.equal(img.getAttribute('src'), 'https://x.example/a.png');
  assert.equal(img.getAttribute('alt'), 'Logo');
});

test('unknown elements are unwrapped, keeping their text', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // A mail wrapped in a custom element must still be readable.
  const out = clean('<my-widget><p>Real content</p></my-widget>');
  assert.ok(out.includes('Real content'));
  assert.ok(!out.includes('my-widget'));
});

test('text is never re-parsed as markup', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const out = clean('<p>Use &lt;script&gt; carefully</p>');
  const body = parse(out);
  assert.equal(body.querySelector('script'), null);
  assert.ok(body.textContent.includes('<script>'), 'the literal text is preserved');
});

test('empty and malformed input does not throw', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  for (const v of ['', null, undefined, '<p>unclosed', '<<<>>>', '<b><i>x</b></i>']) {
    assert.doesNotThrow(() => clean(v));
  }
});

test('deeply nested markup does not blow the stack', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Mail generators produce absurd nesting; a recursive walker must survive it.
  const deep = '<div>'.repeat(400) + 'bottom' + '</div>'.repeat(400);
  assert.doesNotThrow(() => {
    const out = clean(deep);
    assert.ok(out.includes('bottom'));
  });
});

test('escapeHtml covers every dangerous character', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(escapeHtml('plain'), 'plain');
});
