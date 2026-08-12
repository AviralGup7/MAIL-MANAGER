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
function clean(html, opts) {
  // Deliberately does NOT set globalThis.DOMParser. The first version of this
  // helper did, which masked a real bug: sanitizeHtml read the parser off
  // globalThis and threw "DOMParser is not a constructor" in the actual
  // extension. It now resolves the parser from the document's own window, and
  // this helper proves it.
  const dom = new JSDOM('<!doctype html><body></body>');
  return sanitizeHtml(html, dom.window.document, opts);
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

/*
 * REMOTE IMAGES.
 *
 * The old test here asserted that an https src survived. That was asserting a
 * BUG: the src survived the sanitiser and was then refused by the frame's
 * `img-src data:` CSP, so the user saw an empty box with no explanation. The
 * decision now lives in one place and these tests pin both branches.
 */
test('remote images are blocked by default, and parked for later', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const stats = {};
  const img = parse(
    clean('<img src="https://x.example/a.png" alt="Logo" width="80">', { stats })
  ).querySelector('img');
  assert.equal(img.getAttribute('src'), null, 'must not emit a src the CSP will refuse');
  assert.equal(img.getAttribute('data-bmm-src'), 'https://x.example/a.png');
  assert.equal(img.getAttribute('alt'), 'Logo', 'alt survives so the placeholder says something');
  assert.equal(stats.blockedRemote, 1, 'the reader needs a count to offer an unblock');
});

test('remote images load when the user has opted in', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const stats = {};
  const img = parse(
    clean('<img src="https://x.example/a.png" alt="Logo">', { allowRemote: true, stats })
  ).querySelector('img');
  assert.equal(img.getAttribute('src'), 'https://x.example/a.png');
  assert.equal(img.getAttribute('data-bmm-src'), null);
  assert.equal(stats.blockedRemote, 0, 'nothing blocked means no bar');
});

test('opting in to images does not also unblock scripts or other schemes', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // allowRemote widens img-src ONLY. A javascript: href must still die.
  const out = clean('<a href="javascript:alert(1)">x</a><img src="vbscript:evil">', {
    allowRemote: true,
  });
  assert.ok(!/javascript:/i.test(out));
  assert.ok(!/vbscript:/i.test(out));
});

// ------------------------------------------------------------ cid images ----

test('cid: images resolve against the message own parts', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const cid = new Map([['logo@bits', 'data:image/png;base64,AAAA']]);
  const stats = {};
  const img = parse(
    clean('<img src="cid:logo@bits" alt="Logo">', { cid, stats })
  ).querySelector('img');
  assert.equal(img.getAttribute('src'), 'data:image/png;base64,AAAA');
  assert.equal(stats.inlineResolved, 1);
  // Inline images are NOT remote: they must never trigger the privacy bar.
  assert.equal(stats.blockedRemote, 0);
});

test('cid: tolerates angle brackets and percent-encoding', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const cid = new Map([['a@b', 'data:image/png;base64,BBBB']]);
  const bracket = parse(clean('<img src="cid:<a@b>">', { cid })).querySelector('img');
  assert.equal(bracket.getAttribute('src'), 'data:image/png;base64,BBBB');
  const encoded = parse(clean('<img src="cid:a%40b">', { cid })).querySelector('img');
  assert.equal(encoded.getAttribute('src'), 'data:image/png;base64,BBBB');
});

test('an unresolved cid becomes a marked placeholder, not a silent gap', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const stats = {};
  const img = parse(clean('<img src="cid:missing@x" alt="Chart">', { stats })).querySelector('img');
  assert.equal(img.getAttribute('src'), null);
  assert.equal(img.getAttribute('data-bmm-missing'), '1');
  assert.equal(stats.inlineMissing, 1);
});

test('a cid value cannot smuggle a script URL through the resolver', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // A hostile map entry is the threat: the resolver must not be a way to set
  // an arbitrary src. Values come from our own fetch, but assert the shape.
  const cid = new Map([['x@y', 'javascript:alert(1)']]);
  const out = clean('<img src="cid:x@y">', { cid });
  assert.ok(!/javascript:/i.test(out), 'resolver output must still be scheme-checked');
});

test('inline data: images are limited to real raster types', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // data:image/svg+xml can carry script. It must not survive.
  const svg = parse(
    clean('<img src="data:image/svg+xml;base64,PHN2Zz4=">')
  ).querySelector('img');
  assert.equal(svg.getAttribute('src'), null);
  const png = parse(clean('<img src="data:image/png;base64,AAAA">')).querySelector('img');
  assert.equal(png.getAttribute('src'), 'data:image/png;base64,AAAA');
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

/* ========================================================================== *
 * XSS VECTOR SWEEP
 *
 * The sandbox (no allow-scripts, no allow-same-origin) is the primary control
 * and these vectors cannot execute even if the sanitiser missed one. This is
 * defence in depth, and it is tested by EXECUTABILITY rather than by grepping
 * the output string.
 *
 * That distinction matters: an early version of this sweep flagged the
 * `noscript` vector as a leak because `onerror=` appeared in the output. It
 * appeared inside a `title` ATTRIBUTE VALUE — inert text. Re-parsing the
 * output and asking the DOM what is actually there is the only reliable
 * check, because a regex cannot tell markup from text.
 * ========================================================================== */

const XSS_VECTORS = [
  ['nested script tags', '<scr<script>ipt>alert(1)</script>'],
  ['svg onload', '<svg onload=alert(1)>'],
  ['img onerror', '<img src=x onerror=alert(1)>'],
  ['case-mixed handler', '<div OnClIcK=alert(1)>x</div>'],
  ['javascript: href', '<a href="javascript:alert(1)">x</a>'],
  ['javascript: with tab', '<a href="java\tscript:alert(1)">x</a>'],
  ['javascript: with newline', '<a href="java\nscript:alert(1)">x</a>'],
  ['entity-encoded javascript:', '<a href="&#106;avascript:alert(1)">x</a>'],
  ['data:text/html', '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
  ['vbscript:', '<a href="vbscript:msgbox(1)">x</a>'],
  ['form with js action', '<form action="javascript:alert(1)"><input></form>'],
  ['iframe', '<iframe src="javascript:alert(1)"></iframe>'],
  ['object data', '<object data="javascript:alert(1)">'],
  ['meta refresh', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">'],
  ['base href hijack', '<base href="javascript:alert(1)//">'],
  ['css expression()', '<div style="width:expression(alert(1))">x</div>'],
  ['css url() tracker', '<div style="background:url(http://evil/pixel)">x</div>'],
  ['position:fixed overlay', '<div style="position:fixed;top:0;left:0">overlay</div>'],
  ['style @import', '<style>@import "http://evil"</style>'],
  ['img srcset', '<img srcset="http://evil/x 1x">'],
  ['button formaction', '<button formaction="javascript:alert(1)">x</button>'],
  ['svg xlink:href', '<svg><a xlink:href="javascript:alert(1)">x</a></svg>'],
  ['null byte in scheme', '<a href="java\u0000script:alert(1)">x</a>'],
  ['comment break-out', '<!--><script>alert(1)</script>-->'],
  ['noscript attribute break', '<noscript><p title="</noscript><img src=x onerror=alert(1)>">'],
  ['template smuggling', '<template><script>alert(1)</script></template>'],
  ['mathml smuggling', '<math><mtext><script>alert(1)</script></mtext></math>'],
];

test('no XSS vector survives as an executable element', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');

  for (const [name, payload] of XSS_VECTORS) {
    let out;
    assert.doesNotThrow(() => { out = clean(payload); }, `${name} threw`);

    // Re-parse and ask the DOM, rather than pattern-matching the string.
    const body = parse(out);

    assert.equal(body.querySelectorAll('script').length, 0, `${name}: script survived`);
    assert.equal(body.querySelectorAll('iframe, object, embed, form, base, meta, style')
      .length, 0, `${name}: dangerous element survived`);

    for (const el of body.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        assert.ok(
          !attr.name.toLowerCase().startsWith('on'),
          `${name}: event handler ${attr.name} survived`
        );
        if (attr.name === 'href' || attr.name === 'src') {
          assert.ok(
            !/^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value),
            `${name}: executable URL survived in ${attr.name}`
          );
        }
      }
      const style = el.getAttribute('style');
      if (style) {
        assert.ok(!/expression\s*\(/i.test(style), `${name}: css expression survived`);
        assert.ok(!/url\s*\(/i.test(style), `${name}: css url() survived (tracking pixel)`);
        assert.ok(!/position\s*:\s*fixed/i.test(style), `${name}: fixed overlay survived`);
      }
    }
  }
});

test('the vector sweep would notice if the sanitiser stopped working', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Guards against the sweep passing because `clean()` returns ''. Benign
  // markup must survive intact, or the tests above prove nothing.
  const out = clean('<p><b>Bold</b> and <a href="https://x.example">a link</a></p>');
  const body = parse(out);
  assert.equal(body.querySelectorAll('b').length, 1);
  assert.equal(body.querySelector('a').getAttribute('href'), 'https://x.example');
  assert.match(body.textContent, /Bold/);
});

/*
 * THE ATTRIBUTE ALLOW-LIST, TESTED INDEPENDENTLY.
 *
 * Found by mutation testing: disabling `if (!GLOBAL_ATTRS.has(name) &&
 * !allowed?.has(name)) continue;` broke ZERO tests. The `on*` guard silently
 * compensated for event handlers, so the two controls were covering for each
 * other and neither was independently verified.
 *
 * What actually leaks without the allow-list is not script execution — it is
 * `ping` (a fire-and-forget tracking beacon the CSP does not cover),
 * `contenteditable`, `tabindex` (focus hijacking) and `aria-live="assertive"`
 * (hijacking the screen-reader announcement queue). None of those are caught
 * by looking for `<script>`.
 */
test('only allow-listed attributes survive, beyond event handlers', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');

  const cases = [
    ['<div data-evil="1" contenteditable="true" tabindex="5">x</div>',
      ['data-evil', 'contenteditable', 'tabindex']],
    ['<a href="https://ok.example" download="x" ping="http://evil/track">l</a>',
      ['download', 'ping']],
    ['<img src="data:image/png;base64,AAAA" loading="eager" usemap="#m">',
      ['loading', 'usemap']],
    ['<p id="steal" class="x" role="button" aria-live="assertive">y</p>',
      ['id', 'class', 'role', 'aria-live']],
  ];

  for (const [payload, forbidden] of cases) {
    const body = parse(clean(payload));
    for (const el of body.querySelectorAll('*')) {
      for (const name of forbidden) {
        assert.ok(
          !el.hasAttribute(name),
          `"${name}" survived sanitisation in ${payload}`
        );
      }
    }
  }
});

test('the attributes mail genuinely needs still survive', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The negative test above passes if everything is stripped. Mail is mostly
  // tables and inline colour; removing those would make it unreadable.
  const body = parse(clean(
    '<table width="100" bgcolor="#eee"><tr><td colspan="2" align="center">' +
    '<img src="data:image/png;base64,AAAA" alt="Logo" width="80">' +
    '<span style="color:#333" title="hint" dir="ltr">text</span></td></tr></table>'
  ));
  assert.equal(body.querySelector('table').getAttribute('width'), '100');
  assert.equal(body.querySelector('td').getAttribute('colspan'), '2');
  assert.equal(body.querySelector('img').getAttribute('alt'), 'Logo');
  assert.equal(body.querySelector('span').getAttribute('title'), 'hint');
  assert.match(body.querySelector('span').getAttribute('style'), /color/);
});

/*
 * DROP_ENTIRELY vs unwrapping.
 *
 * Unknown elements are UNWRAPPED (their text is kept) so that mail inside a
 * custom element is still readable. A specific set is dropped WITH its
 * contents instead, because the contents are not prose.
 *
 * Mutation testing showed the distinction was untested: removing the
 * DROP_ENTIRELY check broke nothing, because `<script>` and `<style>` bodies
 * happen to be discarded by the parser anyway. The case that actually
 * regresses is `<textarea>`, whose contents leak into the message as visible
 * text — a form value the sender never intended to display.
 */
test('dropped elements take their contents with them', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');

  for (const [payload, mustNotAppear] of [
    ['<textarea>secret value</textarea>', 'secret value'],
    ['<title>page title</title>', 'page title'],
    ['<select><option>choice</option></select>', 'choice'],
    ['<button>press</button>', 'press'],
    ['<style>body{color:red}</style>', 'color'],
  ]) {
    const out = clean(payload);
    assert.ok(
      !out.includes(mustNotAppear),
      `"${mustNotAppear}" leaked out of ${payload}: ${out}`
    );
  }
});

test('unknown elements are unwrapped, not dropped', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The counterpart: a custom wrapper must not cost the reader the message.
  const out = clean('<mj-section><mj-column><p>Real content</p></mj-column></mj-section>');
  assert.match(out, /Real content/);
  assert.ok(!out.includes('mj-section'));
});

test('FAIL CLOSED: no parser means no HTML, and the reader is told why', async (t) => {
  /*
   * Roadmap Phase 1 / HIGH #3. The safe failure must not LOOK like an empty
   * email: the sanitiser returns nothing AND raises a flag the reader turns
   * into an honest notice with an alternative. Silent blankness was the bug.
   */
  const { sanitizeHtml } = await import('../src/app/sanitize.js');
  const stats = {};
  const out = sanitizeHtml('<p>hidden content</p>', { defaultView: {} }, { stats });
  assert.equal(out, '', 'no parser -> no HTML, never unsanitised HTML');
  assert.equal(stats.failedClosed, true, 'and the failure is reported');

  // The flag is for the FAILURE, not for ordinary emptiness: an empty input
  // is a message with nothing to show, not a rendering refusal.
  const stats2 = {};
  assert.equal(sanitizeHtml('', { defaultView: {} }, { stats2 }), '');
  assert.ok(!stats2.failedClosed, 'empty input is not a fail-closed event');
});
