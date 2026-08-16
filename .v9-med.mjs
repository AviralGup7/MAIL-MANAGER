const { Store } = await import('./src/app/mail/store.js');
const { headerMap } = await import('./src/background/gmail.js');
// M-14 / M-15 / M-16: claimed unfixed — re-verify against CURRENT HEAD
const s = new Store();
s.upsert({id:'a',threadId:'t',from:'x@y.z',subject:'C++ notes',snippet:'',date:1,category:'c'});
s.upsert({id:'b',threadId:'u',from:'x@y.z',subject:'Other',snippet:'',date:2,category:'c'});
console.log("M-14 search('c') ->", s.search('c').length, 'of', s.size, '(report says whole mailbox)');
console.log("M-15 search('c++') ->", s.search('c++').length, '(report says 0)');
console.log("M-16 dup Subject ->", JSON.stringify(headerMap([{name:'Subject',value:'first'},{name:'Subject',value:'second'}]).subject), "(report says 'second')");

// M-1..M-4: fmtTime
const tt = await import('./src/app/academic/timetable.js');
if (tt.fmtTime) {
  for (const v of [NaN, -1, 1440, 1e9, 0, 720, 1439]) console.log('fmtTime('+v+') ->', JSON.stringify(tt.fmtTime(v)));
} else console.log('fmtTime not exported');
// M-5
try { tt.detectConflicts(null); console.log('M-5 detectConflicts(null) -> ok'); }
catch(e){ console.log('M-5 detectConflicts(null) THROWS:', e.message); }
