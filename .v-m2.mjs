// Does a real operator-only query (is:unread) still work after the M-2 change?
const { Store } = await import('./src/app/mail/store.js');
const { parseQuery } = await import('./src/app/search/query.js');
const s = new Store();
s.upsert({id:'a',threadId:'t',from:'x@y.z',subject:'Alpha',snippet:'',date:2,category:'c',unread:true});
s.upsert({id:'b',threadId:'u',from:'x@y.z',subject:'Beta',snippet:'',date:1,category:'c',unread:false});
const p = parseQuery('is:unread', Date.now(), {});
console.log('operator-only parse -> terms:', JSON.stringify(p.terms), 'unparsed:', p.unparsed, 'has predicate:', !!p.predicate);
console.log('  store.search called? no -- terms empty means base = idsFor(category)');
// single-char + operator
const p2 = parseQuery('c is:unread', Date.now(), {});
console.log("'c is:unread' -> terms:", JSON.stringify(p2.terms), 'predicate:', !!p2.predicate);
console.log('  store.search("c") ->', s.search('c').length, '(0 after M-2; the operator can no longer save it)');
