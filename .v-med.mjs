const { Store } = await import('./src/app/mail/store.js');
const s = new Store();
['C++ and (parens) [brackets]','CS F211 notes','plain mail'].forEach((sub,i)=>
  s.upsert({id:'m'+i,threadId:'t'+i,from:'a@b.c',subject:sub,snippet:'',date:i,category:'a'}));
console.log('M-3 tokens        :', [...s.searchIndex.keys()].join(' | '));
console.log("M-3 search('c++') :", s.search('c++').length, '(expect 1)');
console.log("M-2 search('c')   :", s.search('c').length, 'of', s.size, '(single char -> whole mailbox?)');
console.log("M-2 search('')    :", s.search('').length);

const q = await import('./src/app/search/query.js');
for (const bad of ['a OR','((','"unclosed']) {
  const parsed = q.parseQuery(bad);
  console.log(`M-1 parseQuery(${JSON.stringify(bad)}) isEmpty=${parsed.isEmpty} terms=${JSON.stringify(parsed.terms)} ops=${(parsed.operators||[]).length}`);
}
const { headerMap, toEpoch } = await import('./src/background/gmail.js');
console.log('\nM-4 dup Subject   :', JSON.stringify(headerMap([{name:'Subject',value:'first'},{name:'Subject',value:'second'}])));
console.log('M-5 toEpoch huge  :', new Date(toEpoch('99999999999999','')).getUTCFullYear());
