/**
 * Seeded fuzz plumbing for the property tests (2026-08-14).
 *
 * WHY SEEDED: a fuzz failure must be reproducible in CI and in a debugger,
 * so every draw flows from one mulberry32 and the seed is printed in the
 * assert message. The generators favour the inputs users and importers
 * actually manage to injure — empty strings, nulls, unicode, regex
 * metacharacters, leap and boundary dates — over uniform random bytes,
 * because uniform bytes usually test nothing (the parser rejects them all).
 */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOSTILE_STRINGS = [
  '', ' ', '\n', '\0', '0', 'NaN', 'null', 'undefined', '{}', '[]',
  '__proto__', 'constructor', 'prototype',
  '.*', '(', '[', '\\', '$^', '\\b', '.*.*.*',
  'छात्रावास', '日本語のメール', '📧🔥', 'emoji 📅 deadline tomorrow',
  'deadline: tomorrow', 'submit by 32/13/2025', 'due 31 Feb', 'exam on 29/2/2025',
  'last date: 30.02.2026', 'meeting at 25:61', 'by 2025-13-45',
  'A'.repeat(5000), 'x'.repeat(999) + '@bits.ac.in',
  'From: a@b.c <b@c.d>, e@f.g', 'mailto:x@y.z',
  'due in -3 days', 'due in 9999999999 days', 'by midnight', 'EOD EOD EOD',
];

/** One hostile-or-mundane string per draw, sometimes sewn together. */
export function hostileString(rnd) {
  const a = HOSTILE_STRINGS[Math.floor(rnd() * HOSTILE_STRINGS.length)];
  if (rnd() < 0.3) {
    const b = HOSTILE_STRINGS[Math.floor(rnd() * HOSTILE_STRINGS.length)];
    return `${a} ${b}`;
  }
  return a;
}

/** Any JSON-shaped value, hostile-heavy. */
export function hostileValue(rnd, depth = 0) {
  const r = rnd();
  if (r < 0.12) return null;
  if (r < 0.2) return rnd() < 0.5 ? true : false;
  if (r < 0.36) return (rnd() - 0.5) * 10 ** Math.floor(rnd() * 12 | 0);
  if (r < 0.42) return Number(rnd() < 0.5 ? 'NaN' : Math.floor(rnd() * 1e15));
  if (r < 0.62) return hostileString(rnd);
  if (depth > 2 || r < 0.8) return hostileString(rnd);
  if (r < 0.9) {
    const n = Math.floor(rnd() * 5);
    return Array.from({ length: n }, () => hostileValue(rnd, depth + 1));
  }
  const o = {};
  const n = Math.floor(rnd() * 5);
  for (let i = 0; i < n; i++) o[hostileString(rnd).slice(0, 24) || 'k'] = hostileValue(rnd, depth + 1);
  return o;
}

/** Milliseconds across a wide-but-real span: ±120 years around today, plus
    the pathological few on purpose. */
export function hostileEpoch(rnd) {
  const r = rnd();
  if (r < 0.04) return NaN;
  if (r < 0.08) return Infinity * (r < 0.06 ? 1 : -1);
  if (r < 0.12) return 0;
  if (r < 0.16) return -Math.floor(rnd() * 1e13);
  const yearMs = 31_536_000_000;
  return Math.floor(Date.now() + (rnd() - 0.5) * 240 * yearMs);
}
