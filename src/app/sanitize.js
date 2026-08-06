/**
 * Mail body sanitiser.
 *
 * WHY THIS REPLACED A REGEX CHAIN
 * -------------------------------
 * The previous implementation stripped dangerous tags and `on*` attributes
 * with a sequence of regexes and described itself as "defence in depth". It
 * was not. Executed against real payloads it neutralised nested `<script>`,
 * `javascript:` URLs and newline-separated attributes, but
 * `<svg/onload=alert(1)>` passed through untouched: the handler stripper
 * required whitespace before the attribute, and a solidus is a valid
 * separator in HTML5. That is the oldest bypass in the catalogue.
 *
 * It was not exploitable, because the iframe that renders this has no
 * `allow-scripts`. But the comment invited a future maintainer to believe two
 * layers existed when there was one, and the realistic path to a breach is
 * someone adding `allow-scripts` to make a newsletter render.
 *
 * So: a real parse-and-walk with an allow-list. `DOMParser` builds an INERT
 * document -- scripts do not execute, `<img>` does not fetch, no resource
 * loads -- and we copy across only what is on the list. Anything unrecognised
 * is dropped rather than escaped, because "escape what I know is bad" is the
 * wrong default and is how the old version failed.
 *
 * THE SANDBOX REMAINS THE PRIMARY CONTROL. This is genuinely a second layer
 * now, not a substitute for the first.
 */

/** Elements allowed through. Everything else is unwrapped or dropped. */
const ALLOWED = new Set([
  // structure
  'div', 'p', 'span', 'br', 'hr', 'section', 'article', 'header', 'footer', 'main', 'aside',
  // text
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'sub', 'sup',
  'small', 'big', 'mark', 'abbr', 'cite', 'q', 'code', 'pre', 'kbd', 'samp', 'var',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote',
  // lists
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  // tables — mail is full of them
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  // media
  'img', 'figure', 'figcaption',
  'center', 'font', 'address', 'time', 'wbr',
]);

/**
 * Elements dropped WITH their contents.
 *
 * Everything else that is not allowed gets unwrapped — its children are kept —
 * because a mail wrapped in an unknown custom element should still be
 * readable. But the contents of a `<script>` or `<style>` are not prose and
 * must never be surfaced as text.
 */
const DROP_ENTIRELY = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'applet', 'noscript',
  'template', 'link', 'meta', 'base', 'title', 'head',
  'form', 'input', 'button', 'select', 'option', 'textarea', 'label', 'fieldset',
  'svg', 'math', 'canvas', 'audio', 'video', 'source', 'track', 'portal',
]);

/** Attributes allowed on any element. */
const GLOBAL_ATTRS = new Set(['title', 'dir', 'lang', 'align', 'valign']);

/** Attributes allowed per element. */
const ATTRS = {
  a: new Set(['href', 'target', 'rel']),
  img: new Set(['src', 'alt', 'width', 'height']),
  td: new Set(['colspan', 'rowspan', 'width', 'height', 'bgcolor']),
  th: new Set(['colspan', 'rowspan', 'width', 'height', 'bgcolor']),
  table: new Set(['width', 'cellpadding', 'cellspacing', 'border', 'bgcolor']),
  tr: new Set(['bgcolor']),
  col: new Set(['span', 'width']),
  colgroup: new Set(['span', 'width']),
  font: new Set(['color', 'size', 'face']),
  ol: new Set(['start', 'type']),
};

/** URL schemes permitted in href. */
const SAFE_SCHEME = /^(https?:|mailto:|tel:)/i;

/**
 * `style` is allowed but filtered.
 *
 * Mail is unreadable without inline colour and spacing, but CSS is an attack
 * surface of its own: `position:fixed` can overlay the app chrome, `url()` can
 * fetch a tracking pixel the CSP would otherwise block, and `expression()` was
 * script execution in older engines. Allow-list the harmless properties.
 */
const SAFE_CSS_PROPS = new Set([
  'color', 'background-color', 'font-size', 'font-weight', 'font-style',
  'font-family', 'text-align', 'text-decoration', 'line-height', 'padding',
  'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
  'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
  'border', 'border-top', 'border-bottom', 'border-left', 'border-right',
  'border-color', 'border-width', 'border-style', 'border-radius',
  'width', 'max-width', 'height', 'vertical-align', 'white-space',
  'letter-spacing', 'text-transform', 'font-variant', 'list-style-type',
]);

function safeStyle(value) {
  const out = [];
  for (const decl of String(value).split(';')) {
    const i = decl.indexOf(':');
    if (i === -1) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    if (!SAFE_CSS_PROPS.has(prop)) continue;
    // No url(), no expression(), no javascript: hidden in a value.
    if (/url\s*\(|expression\s*\(|javascript:|@import|<|\\/i.test(val)) continue;
    out.push(`${prop}: ${val}`);
  }
  return out.join('; ');
}

/**
 * Sanitise a mail body into safe HTML.
 *
 * @param {string} html   untrusted
 * @param {Document} doc  a Document to parse with; defaults to the global one
 * @returns {string} HTML containing only allow-listed elements and attributes
 */
export function sanitizeHtml(html, doc = globalThis.document) {
  if (!html) return '';

  // Resolve DOMParser from the document's OWN window, not from globalThis.
  //
  // Reading globalThis.DOMParser threw "not a constructor" in any context
  // where the global was not the browsing context that owns `doc` -- which is
  // every test harness, and would also be any future worker or off-thread use.
  // The parser must in any case come from the same realm as the document it
  // parses into, or the nodes belong to a different realm than the ones we
  // create with `doc.createElement`.
  const Parser =
    doc?.defaultView?.DOMParser || globalThis.DOMParser;
  if (typeof Parser !== 'function') {
    // No parser available: return nothing rather than unsanitised HTML.
    return '';
  }
  const parser = new Parser();
  // text/html gives an inert document: no scripts run, no resources load.
  const parsed = parser.parseFromString(String(html), 'text/html');
  const out = doc.implementation.createHTMLDocument('').body;

  walk(parsed.body, out, doc);
  return out.innerHTML;
}

function walk(src, dest, doc) {
  for (const node of Array.from(src.childNodes)) {
    // Text is always safe: it is inserted as a text node, never parsed.
    if (node.nodeType === 3) {
      dest.appendChild(doc.createTextNode(node.nodeValue));
      continue;
    }
    if (node.nodeType !== 1) continue; // comments, CDATA, processing instructions

    const tag = node.localName?.toLowerCase();
    if (!tag || DROP_ENTIRELY.has(tag)) continue;

    if (!ALLOWED.has(tag)) {
      // Unknown element: keep the text inside it, discard the element itself.
      walk(node, dest, doc);
      continue;
    }

    const el = doc.createElement(tag);
    copyAttributes(node, el, tag);

    // Links open in a new tab and must not leak the referrer or hand the
    // opener to the target.
    if (tag === 'a') {
      if (!el.getAttribute('href')) {
        walk(node, dest, doc);
        continue;
      }
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer nofollow');
    }

    walk(node, el, doc);
    dest.appendChild(el);
  }
}

function copyAttributes(from, to, tag) {
  const allowed = ATTRS[tag];
  for (const attr of Array.from(from.attributes || [])) {
    const name = attr.name.toLowerCase();
    const value = attr.value;

    // Belt and braces: an event handler can never be allow-listed, but if one
    // is ever added to a set by mistake this still refuses it.
    if (name.startsWith('on')) continue;

    if (name === 'style') {
      const safe = safeStyle(value);
      if (safe) to.setAttribute('style', safe);
      continue;
    }

    if (!GLOBAL_ATTRS.has(name) && !allowed?.has(name)) continue;

    if (name === 'href' || name === 'src') {
      const url = value.trim().replace(/[\u0000-\u001F\u007F\s]/g, '');
      // Blocks javascript:, data: (which can carry HTML), vbscript:, and any
      // scheme we have not explicitly permitted.
      if (!SAFE_SCHEME.test(url)) continue;
      to.setAttribute(name, url);
      continue;
    }

    to.setAttribute(name, value);
  }
}

/** Escape text for interpolation into an HTML string. */
export function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
