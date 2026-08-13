import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
const html = readFileSync('app.html', 'utf8');
const dom = new JSDOM(html);
const doc = dom.window.document;

// Region chain for every interactive element, so the census reads as a map.
const regionOf = (el) => {
  const ids = [];
  let n = el;
  while (n && n !== doc.body) {
    if (n.id) ids.unshift(n.id);
    n = n.parentElement;
  }
  return ids.slice(-2).join(' > ');
};
const nameOf = (el) =>
  el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') ||
  el.title || el.textContent.trim().replace(/\s+/g, ' ').slice(0, 30) || null;

const inter = [...doc.querySelectorAll(
  'button, a[href], input, textarea, select, [role="button"], [role="menuitem"], [role="tab"], [tabindex], [role="combobox"], [role="listbox"], summary'
)];
console.log(`TOTAL interactive-in-markup: ${inter.length}\n`);
let unnamed = 0;
for (const el of inter) {
  const nm = nameOf(el);
  if (!nm) unnamed++;
  console.log([
    el.tagName.toLowerCase(),
    el.id ? `#${el.id}` : (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''),
    el.getAttribute('role') ? `role=${el.getAttribute('role')}` : (el.tagName === 'BUTTON' ? 'btn' : el.tagName.toLowerCase()),
    `tab=${el.getAttribute('tabindex') ?? '-'}`,
    `name=${nm ? JSON.stringify(nm) : 'NONE!!'}`,
    `@ ${regionOf(el)}`,
  ].join('  '));
}
console.log(`\nUNNAMED: ${unnamed}`);
// Landmarks / headings / live regions.
console.log('\n--- landmarks / structure ---');
for (const sel of ['header','nav','main','aside','footer','[role="dialog"]','[role="alert"]','[role="status"]','[aria-live]','h1','h2','[role="article"]','[role="menu"]','[role="listbox"]','[role="tablist"]']) {
  console.log(sel, [...doc.querySelectorAll(sel)].map(e => e.id ? `#${e.id}` : '(no id)').join(', ') || '—');
}
