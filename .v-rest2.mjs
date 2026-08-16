const ob = await import('./src/features/outbox/model.js');
const now = Date.now();
const rec = {id:'x', state:'held', releaseAt:-5, queuedAt:now, to:'a@b.c', subject:'s', body:'b'};
const out = ob.normaliseOutbox([rec]);
console.log('M-12 normalised:', JSON.stringify(out));
if (out.length) console.log('  releaseAt kept?', out[0].releaseAt, ' due now?', ob.dueItems(out, now).length);
else console.log('  -> record was DROPPED entirely, not kept with a negative releaseAt');

const dl = await import('./src/app/system/deep-links.js');
const valid = (m) => ['inbox','sent','drafts'].includes(m);
console.log('\nM-11 parseHash("#inbox/all?m=") :', JSON.stringify(dl.parseHash('#inbox/all?m=', {validMailbox: valid})));
console.log('L-5  parseHash("#inbox")        :', JSON.stringify(dl.parseHash('#inbox', {validMailbox: valid})));
