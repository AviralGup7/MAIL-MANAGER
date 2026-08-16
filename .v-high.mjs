// H-1: plus-addressing
const { audienceOf } = await import('./src/app/system/audience.js');
const me = 'me@pilani.bits-pilani.ac.in';
console.log('H-1 plus-addressed :', audienceOf({to:'me+bits@pilani.bits-pilani.ac.in'}, me), '(expect direct)');
console.log('H-1 plain          :', audienceOf({to:me}, me), '(expect direct)');
console.log('H-1 dots           :', audienceOf({to:'m.e@pilani.bits-pilani.ac.in'}, me));

// H-2: RFC2047 inbound
const { normalise } = await import('./src/background/gmail.js');
const n = normalise({ id:'1', internalDate:'1700000000000', labelIds:['INBOX'],
  payload:{headers:[{name:'From',value:'=?UTF-8?B?SsO2cmc=?= <j@x.z>'},
                    {name:'Subject',value:'=?UTF-8?Q?Caf=C3=A9?='}]}});
console.log('\nH-2 from    :', JSON.stringify(n.from));
console.log('H-2 subject :', JSON.stringify(n.subject));
const { Store } = await import('./src/app/mail/store.js');
const s = new Store(); s.upsert({...n, category:'a', snippet:''});
console.log('H-2 tokens  :', [...s.searchIndex.keys()].join(' | '));
console.log("H-2 search('jörg') :", s.search('jörg').length, " search('utf') :", s.search('utf').length);

// H-3: long non-ASCII subject header folding
const g = await import('./src/background/gmail.js');
console.log('\nH-3 buildMime exported?', typeof g.buildMime);
