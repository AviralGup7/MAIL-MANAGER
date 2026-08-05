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

/** The domain part of a `From` header, lowercased. */
export function extractDomain(from) {
  const addr = extractAddress(from);
  const at = addr.lastIndexOf('@');
  return at === -1 ? '' : addr.slice(at + 1);
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

    // A BITS-internal sender that matched an EXTERNAL bucket is almost always
    // a false positive — e.g. a club mail whose footer says "unsubscribe", or
    // a department newsletter. Internal mail is never external promotions.
    if (
      isBits &&
      (r.category === 'external-promotions' ||
        r.category === 'external-services')
    ) {
      continue;
    }

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
