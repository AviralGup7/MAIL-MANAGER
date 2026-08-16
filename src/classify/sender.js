/**
 * Stage 1: classify by sender.
 *
 * Runs before pattern scoring. If the sender is recognised, we are done — a
 * mail from the Registrar is Admin regardless of what the subject says.
 *
 * PERFORMANCE: the old version walked a nested array on every message. Here the
 * rules are flattened ONCE at module load into a single array of
 * `[pattern, category]` pairs, sorted longest-pattern-first so the most
 * specific match wins even within a category. Classification is then a single
 * linear scan of ~200 `String.includes` calls, which is a few microseconds.
 *
 * There is no regex anywhere in this path. That is deliberate: every pattern is
 * a literal, and `includes` cannot backtrack.
 */

import { SENDER_RULES } from './sender-rules.js';
import { BITS_DOMAINS } from './categories.js';

/**
 * Flattened rules, built once.
 * Order: rule order first (precedence), then longest pattern first within a
 * rule so `registrar@pilani.bits` beats a hypothetical `registrar`.
 */
const FLAT_RULES = (() => {
  const out = [];
  for (let i = 0; i < SENDER_RULES.length; i++) {
    const { category, patterns } = SENDER_RULES[i];
    const sorted = [...patterns].sort((a, b) => b.length - a.length);
    for (const p of sorted) {
      out.push({ pattern: p.toLowerCase(), category, ruleIndex: i });
    }
  }
  return out;
})();

/** Exposed for tests and the rule-tester UI. */
export function ruleCount() {
  return FLAT_RULES.length;
}

/**
 * Pull the bare email address out of a `From` header.
 * Handles `Name <a@b.c>`, `<a@b.c>`, and a naked `a@b.c`.
 */
export function extractAddress(from) {
  if (!from) return '';
  const angle = from.lastIndexOf('<');
  if (angle !== -1) {
    const close = from.indexOf('>', angle);
    if (close !== -1) return from.slice(angle + 1, close).trim().toLowerCase();
  }
  return from.trim().toLowerCase();
}

/**
 * A syntactically plausible DNS name: labels of letters/digits/hyphens joined
 * by dots. Deliberately narrow — anything else is not a domain we will treat
 * as proof of anything.
 */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * The domain part of a `From` header, lowercased, or `''` if the header does
 * not carry one address-shaped token.
 *
 * WHY THE SHAPE IS CHECKED (round 10, H-1 follow-through). Splitting on the
 * LAST `@` of an unbracketed header is right for `a@b.c` and wrong for a
 * hostile one-liner: `spoof@evil.com?x=@pilani.bits-pilani.ac.in` has no
 * angle brackets, so the last `@` handed back `pilani.bits-pilani.ac.in` and
 * `detectBitsSource` said yes. An addr-spec has exactly one `@` and a domain
 * made of DNS labels; rejecting everything else costs honest mail nothing and
 * closes the parse-level half of the spoof.
 */
export function extractDomain(from) {
  const addr = extractAddress(from);
  const at = addr.lastIndexOf('@');
  if (at === -1) return '';
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  if (!local || local.includes('@')) return '';
  return DOMAIN_RE.test(domain) ? domain : '';
}

/**
 * Is this an internal BITS message?
 *
 * Matches the domain OR any subdomain of it, so `cs.pilani.bits-pilani.ac.in`
 * counts. Uses an endsWith check on a dot-prefixed form rather than a bare
 * `includes`, because `includes` would also match a lookalike domain such as
 * `bits-pilani.ac.in.evil.com` — a real phishing shape for a university.
 */
export function detectBitsSource(from) {
  const domain = extractDomain(from);
  if (!domain) return { isBits: false, domain: '' };
  for (const d of BITS_DOMAINS) {
    if (domain === d || domain.endsWith('.' + d)) {
      return { isBits: true, domain };
    }
  }
  return { isBits: false, domain };
}

/**
 * Classify by sender. Returns null if nothing matches, so the caller falls
 * through to pattern scoring.
 *
 * @param {string} from  raw `From` header
 * @param {boolean} isBits  from detectBitsSource
 * @returns {{category:string, confidence:number, matchedPattern:string}|null}
 */
export function classifyBySender(from, isBits) {
  if (!from) return null;
  const haystack = from.toLowerCase();

  for (let i = 0; i < FLAT_RULES.length; i++) {
    const r = FLAT_RULES[i];
    if (!haystack.includes(r.pattern)) continue;

    // The isBits filter, both halves of it. Data pack section 8, STEP 2:
    //
    //   If isBits && rule.category starts with "external-"          -> SKIP
    //   If !isBits && category NOT external- && !== "spam"          -> SKIP
    //
    // The first half stops a BITS club mail whose footer says "unsubscribe"
    // being filed as a promotion.
    //
    // The second half is the one this file was missing, and it matters more.
    // Without it, an OUTSIDE sender can match an internal BITS rule purely on
    // a display-name substring. Concretely: a stranger sending as
    // "Placement Office <careers@spam.example>" matched the `internship` rule
    // and was presented to the user as internal placement mail. That is a
    // phishing shape, and it is the exact category a student is most likely to
    // act on. External senders can now only reach external-* and spam.
    const isExternalRule = r.category.startsWith('external-');
    if (isBits && isExternalRule) continue;
    if (!isBits && !isExternalRule && r.category !== 'spam') continue;

    return {
      category: r.category,
      // Sender matches are the strongest signal we have. A longer, more
      // specific pattern earns more confidence than a short generic one.
      confidence: r.pattern.length >= 12 ? 0.95 : 0.85,
      matchedPattern: r.pattern,
    };
  }

  return null;
}
