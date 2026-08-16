const { decodeEncodedWords, headerMap } = await import('./src/background/gmail.js');
const cases = [
  ['=?UTF-8?B?SsO2cmc=?=', 'Jörg'],
  ['=?UTF-8?Q?Caf=C3=A9?=', 'Café'],
  ['=?ISO-8859-1?Q?a=E9b?=', 'aéb'],
  ['=?UTF-8?Q?a_b?=', 'a b'],
  ['=?UTF-8?B?SGVsbG8=?= =?UTF-8?B?V29ybGQ=?=', 'HelloWorld (adjacent words joined)'],
  ['plain subject', 'plain subject'],
  ['=?UTF-8?B?!!!notbase64!!!?=', 'INVALID -> unchanged'],
  ['=?NOSUCHCHARSET?B?SGk=?=', 'unknown charset -> unchanged'],
  ['=?UTF-8?X?zzz?=', 'unknown encoding -> unchanged'],
  ['prefix =?UTF-8?B?SsO2cmc=?= suffix', 'prefix Jörg suffix'],
  ['', '(empty)'],
];
for (const [inp, expect] of cases) {
  let out; try { out = decodeEncodedWords(inp); } catch(e){ out='THREW '+e.message; }
  console.log(JSON.stringify(inp).padEnd(48), '->', JSON.stringify(out), ' | expect:', expect);
}
// totality against hostile types
for (const bad of [null, undefined, 42, {}, [], true]) {
  console.log('type', JSON.stringify(bad), '->', JSON.stringify(decodeEncodedWords(bad)));
}
console.log('\nheaderMap null-safe:', JSON.stringify(headerMap([{name:'Subject',value:null},{name:'From'}])));
