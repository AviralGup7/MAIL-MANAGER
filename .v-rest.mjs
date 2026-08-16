// M-12 negative releaseAt
const ob = await import('./src/features/outbox/model.js');
const norm = ob.normaliseOutbox ? ob.normaliseOutbox([{id:'x',state:'held',releaseAt:-5,queuedAt:Date.now()}]) : null;
console.log('M-12 exports normaliseOutbox?', typeof ob.normaliseOutbox, JSON.stringify(norm));
// M-11 deep link
const dl = await import('./src/app/system/deep-links.js');
console.log('M-11 parseHash("#inbox/all?m=") :', JSON.stringify(dl.parseHash('#inbox/all?m=')));
console.log('L-5  parseHash("#inbox")        :', JSON.stringify(dl.parseHash('#inbox')));
// L-7 settings.get unknown
const st = await import('./src/app/system/settings.js');
try { st.get('unknownKey'); console.log('L-7 get(unknown) -> returned'); }
catch(e){ console.log('L-7 get(unknown) THROWS:', e.message); }
