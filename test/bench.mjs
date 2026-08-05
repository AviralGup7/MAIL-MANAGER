import { Store } from '../src/app/store.js';
import { classifyAll } from '../src/classify/index.js';

const N = 2000;
const raw = Array.from({length:N}, (_,i)=>({
  id:`m${i}`, threadId:`t${i}`,
  from: i%3===0 ? 'AUGSD <augsd@pilani.bits-pilani.ac.in>'
      : i%3===1 ? 'Placement Unit <placement@pilani.bits-pilani.ac.in>'
                : 'GitHub <noreply@github.com>',
  subject: i%2 ? 'Course registration and exam timetable' : 'Pull request merged',
  snippet: 'unsubscribe deadline semester', date: Date.now()-i*1000,
  unread: true, starred:false,
}));

// full pipeline: classify + store + notify
let renders = 0;
const t0 = performance.now();
const cls = classifyAll(raw);
const tClass = performance.now();
const s = new Store();
s.subscribe(()=>renders++);
s.upsertMany(raw.map((m,i)=>({...m, ...cls[i]})));
const t1 = performance.now();

console.log(`classify ${N}:  ${(tClass-t0).toFixed(1)}ms`);
console.log(`store    ${N}:  ${(t1-tClass).toFixed(1)}ms`);
console.log(`TOTAL:         ${(t1-t0).toFixed(1)}ms`);
console.log(`renders triggered: ${renders}  (old version: dozens)`);
const c = s.counts();
console.log('categories:', JSON.stringify(c));
const t2=performance.now(); for(let i=0;i<100;i++) s.search('registration');
console.log(`100 searches:  ${(performance.now()-t2).toFixed(1)}ms`);
