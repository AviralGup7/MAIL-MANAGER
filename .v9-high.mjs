const tt = await import('./src/app/academic/timetable.js');
const E = (o={}) => ({ id:'a', courseNo:'CS F211', section:'L1',
  meetings:[{day:'M',hour:1}], unresolved:[], ...o });

// H-1: missing `unresolved`
try {
  const r = tt.detectConflicts([{ id:'a', courseNo:'X', section:'L1', meetings:[{day:'M',hour:1}] }]);
  console.log('H-1 missing unresolved -> OK, no throw:', JSON.stringify(r));
} catch (e) { console.log('H-1 THROWS:', e.constructor.name+':', e.message); }

// H-2: duplicated meeting => self-conflict
const r2 = tt.detectConflicts([E({ meetings:[{day:'M',hour:1},{day:'M',hour:1}] })]);
console.log('\nH-2 dup meeting ->', JSON.stringify(r2));

// H-3: duplicate ids
const r3 = tt.detectConflicts([E({id:'a'}), E({id:'a'})]);
console.log('\nH-3 dup ids ->', JSON.stringify(r3.map(c=>c.entryIds)));

// entryId shape
console.log('\nentryId({}) ->', JSON.stringify(tt.entryId ? tt.entryId({}) : '(not exported)'));
