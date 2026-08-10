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

/** Remote image schemes. `img[src]` is handled separately from `a[href]`. */
const REMOTE_IMG = /^https?:/i;

/**
 * Raster data: images only.
 *
 * `data:image/svg+xml` is deliberately excluded: SVG is a document format that
 * can carry `<script>`, so permitting it here would reintroduce script
 * execution through an attribute the sandbox does not police.
 */
const SAFE_DATA_IMG = /^data:image\/(png|jpe?g|gif|webp|bmp|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=]*$/i;

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
export function sanitizeHtml(html, doc = globalThis.document, opts = {}) {
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

  const ctx = {
    allowRemote: !!opts.allowRemote,
    // cid -> data: URL, resolved by the caller from the message's own parts.
    cid: opts.cid instanceof Map ? opts.cid : new Map(),
    stats: opts.stats && typeof opts.stats === 'object' ? opts.stats : {},
  };
  ctx.stats.blockedRemote = 0;
  ctx.stats.inlineResolved = 0;
  ctx.stats.inlineMissing = 0;

  walk(parsed.body, out, doc, ctx);

  /*
   * SPATIAL COMPRESSION O16 (audit 37): long quoted history folds behind a
   * native <details>. The new words stay above the fold; the old ones stay
   * one click away. Native disclosure means the sandbox needs no script and
   * screen readers get a real control. Threshold ~6 lines of prose; shorter
   * quotes are part of the conversation and stay open.
   */
  if (opts.foldQuotes !== false) {
    for (const bq of [...out.querySelectorAll('blockquote')]) {
      if ((bq.textContent || '').trim().length <= 480) continue;
      if (bq.closest('details')) continue;
      const det = doc.createElement('details');
      det.className = 'quote-fold';
      const sum = doc.createElement('summary');
      sum.textContent = 'Show quoted text';
      det.appendChild(sum);
      bq.parentNode.insertBefore(det, bq);
      det.appendChild(bq);
    }
  }

  return out.innerHTML;
}

/**
 * Resolve a `cid:` reference against the message's own attached parts.
 *
 * Mail references its inline images as `cid:xyz@host`, matching a part whose
 * `Content-ID` header is `<xyz@host>`. Some authors omit the angle brackets,
 * some URL-encode the value, and a few reference the part's filename instead,
 * so all three are tried before giving up.
 */
function resolveCid(raw, cid) {
  const key = raw.slice(4).trim();
  if (!key) return '';
  const candidates = [key, decodeURIComponent(key)];
  for (const c of candidates) {
    const hit = cid.get(c) || cid.get(c.replace(/^<|>$/g, ''));
    if (hit) return hit;
  }
  return '';
}

function walk(src, dest, doc, ctx) {
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
      walk(node, dest, doc, ctx);
      continue;
    }

    const el = doc.createElement(tag);
    copyAttributes(node, el, tag, ctx);

    // Links open in a new tab and must not leak the referrer or hand the
    // opener to the target.
    if (tag === 'a') {
      if (!el.getAttribute('href')) {
        walk(node, dest, doc, ctx);
        continue;
      }
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer nofollow');
    }

    walk(node, el, doc, ctx);
    dest.appendChild(el);
  }
}

function copyAttributes(from, to, tag, ctx) {
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

    if (name === 'src' && tag === 'img') {
      const url = value.trim().replace(/[\u0000-\u001F\u007F\s]/g, '');

      /*
       * INLINE IMAGES. `cid:` is not a fetchable scheme in any browser: it is
       * a pointer into this message's own MIME tree. Resolve it to a data:
       * URL, which the frame CSP already permits, so no CSP change is needed
       * and no network request is made. An unresolved reference becomes a
       * marked placeholder rather than a silently missing image.
       */
      if (/^cid:/i.test(url)) {
        const data = resolveCid(url, ctx.cid);
        // The resolved value is scheme-checked even though it comes from our
        // own fetch. A resolver that can set an arbitrary src is a bypass of
        // every rule below it, and defence in depth means not trusting our
        // own inputs either.
        if (data && SAFE_DATA_IMG.test(data)) {
          to.setAttribute('src', data);
          ctx.stats.inlineResolved++;
        } else {
          to.setAttribute('data-bmm-missing', '1');
          ctx.stats.inlineMissing++;
        }
        continue;
      }

      /*
       * REMOTE IMAGES. Previously `https:` passed here and was then killed by
       * the frame's `img-src data:` CSP, so the tag rendered as an empty box
       * with no explanation and no way to load it -- the sanitiser and the CSP
       * disagreed about policy.
       *
       * Now the decision is made in ONE place. Blocked images keep their URL
       * in `data-bmm-src` so the reader can offer to load them, and the caller
       * widens the CSP only when the user has actually opted in.
       */
      if (REMOTE_IMG.test(url)) {
        if (ctx.allowRemote) {
          to.setAttribute('src', url);
        } else {
          to.setAttribute('data-bmm-src', url);
          ctx.stats.blockedRemote++;
        }
        continue;
      }

      // data: images are inert as pixels but can carry SVG, which can script.
      // Same predicate as the cid resolver uses, deliberately: two copies of
      // this rule would eventually disagree.
      if (SAFE_DATA_IMG.test(url)) {
        to.setAttribute('src', url);
      }
      continue;
    }

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
