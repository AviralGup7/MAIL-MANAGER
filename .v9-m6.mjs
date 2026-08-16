const tt = await import('./src/app/academic/timetable.js');
const many = Array.from({length:500},(_,i)=>({id:'e'+i,courseNo:'C'+i,section:'L1',
  unresolved:[],meetings:[{day:'M',hour:1}]}));
const c = tt.detectConflicts(many).find(x=>x.kind==='overlap');
console.log('M-6 message length:', c.message.length, '(was 7525)');
console.log('  ', c.message.slice(0,120));
console.log('  entryIds still complete?', c.entryIds.length, '(machine-readable list is untouched)');
