import { JSDOM } from 'jsdom';
const { sanitizeHtml } = await import('./src/app/core/sanitize.js');
const doc = new JSDOM('<!doctype html><body>').window.document;
const out = sanitizeHtml('<a href="https://good.example">\u202Emoc.live</a>', doc);
console.log('M-7 bidi override present?', /\u202E/.test(out), '(must be false)');
console.log('  ', JSON.stringify(out));
const rtl = sanitizeHtml('<p>\u200Fشلام עברית</p>', doc);
console.log('M-7 legitimate RLM kept?', /\u200F/.test(rtl), '(must be true)');
console.log('  ', JSON.stringify(rtl));
