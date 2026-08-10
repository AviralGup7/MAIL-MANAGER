import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '..', 'test');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.mjs')).sort();
const results = [];

for (const f of files) {
  const start = Date.now();
  let out = '', err = '';
  let timedOut = false;
  try {
    out = execFileSync('node', ['--test', path.join(dir, f)], {
      timeout: 120000, encoding: 'utf8', stdio: ['ignore','pipe','pipe'],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    if (e.killed) { timedOut = true; }
    out = e.stdout || ''; err = (e.stderr || '').toString().slice(0, 500);
  }
  const ms = Date.now() - start;
  const m = out.match(/# (tests|pass|fail|cancelled|skipped)\s+(\d+)/g) || [];
  const kv = {};
  for (const line of m) { const [k, v] = line.replace('# ','').split(/\s+/); kv[k] = +v; }
  const fails = (out.match(/# fail\s+(\d+)/)||[])[1] || '0';
  results.push({ file: f, ms, tests: kv.tests ?? '?', pass: kv.pass ?? '?', fail: kv.fail ?? '?', skip: kv.skipped ?? '?', timedOut, err: err.slice(0,120) });
  console.log(`${String(ms).padStart(6)}ms  ${f.padEnd(34)} tests=${kv.tests ?? '?'} fail=${kv.fail ?? '?'} skip=${kv.skipped ?? '?'}${timedOut ? '  [TIMEOUT]' : ''}${err ? '  ERR:'+err : ''}`);
}

// summary
const total = results.reduce((a,r)=>a+r.ms,0);
console.log('\n=== SUMMARY ===');
console.log(`files: ${results.length}  total sequential: ${(total/1000).toFixed(1)}s  median: ${[...results].sort((a,b)=>a.ms-b.ms)[Math.floor(results.length/2)].ms}ms`);
console.log('slowest 10:');
[...results].sort((a,b)=>b.ms-a.ms).slice(0,10).forEach(r=>console.log(`  ${r.ms}ms ${r.file}`));
fs.writeFileSync(path.join(here, '..', 'audit-times.json'), JSON.stringify(results, null, 1));
