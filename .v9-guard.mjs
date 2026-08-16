const tt = await import('./src/app/academic/timetable.js');
const E = (o={}) => ({ id:'a', courseNo:'CS F211', section:'L1',
  meetings:[{day:'M',hour:1}], unresolved:[], ...o });

// A REAL clash between two different courses must still be reported.
const real = tt.detectConflicts([
  E({id:'a', courseNo:'CS F211'}),
  E({id:'b', courseNo:'MATH F211', section:'L2'}),
]);
console.log('real 2-course clash detected?', real.length===1 && real[0].kind==='overlap', JSON.stringify(real.map(c=>c.entryIds)));

// Three-way clash
const three = tt.detectConflicts([E({id:'a'}),E({id:'b',courseNo:'B'}),E({id:'c',courseNo:'C'})]);
console.log('3-way clash entryIds:', JSON.stringify(three.filter(c=>c.kind==='overlap').map(c=>c.entryIds)));

// Distinct anonymous entries must NOT merge into one
const anon = tt.detectConflicts([
  {courseNo:'X',section:'1',meetings:[{day:'M',hour:1}]},
  {courseNo:'Y',section:'2',meetings:[{day:'M',hour:1}]},
]);
console.log('two id-less entries still clash?', anon.filter(c=>c.kind==='overlap').length===1, JSON.stringify(anon.filter(c=>c.kind==='overlap').map(c=>c.entryIds)));

// unresolved still reported when present
const un = tt.detectConflicts([E({unresolved:['room']})]);
console.log('unresolved still reported?', un.some(c=>c.kind==='unresolved'), JSON.stringify(un.filter(c=>c.kind==='unresolved').map(c=>c.fields)));
