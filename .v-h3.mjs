const { buildMime } = await import('./src/background/gmail.js');
const mime = buildMime({ to:'a@b.c', subject:'é'.repeat(400), body:'x' });
const line = mime.split(/\r?\n/).find(l => l.startsWith('Subject:'));
console.log('H-3 Subject line octets :', Buffer.byteLength(line,'utf8'), '(RFC 2822 limit 998)');
console.log('H-3 folded (continuation lines)?', /\r\n[ \t]/.test(mime.slice(mime.indexOf('Subject:'), mime.indexOf('Subject:')+2000)));
const over = mime.split(/\r?\n/).filter(l => Buffer.byteLength(l,'utf8') > 998);
console.log('H-3 lines over 998 :', over.length);
// M-9 empty To
console.log("\nM-9 buildMime({to:''}) contains 'To: ' ->", /^To: *$/m.test(buildMime({to:'',subject:'s',body:'b'})));
// M-10 filename
const withAtt = buildMime({to:'a@b.c',subject:'s',body:'b',attachments:[{filename:'a"b.pdf',mimeType:'application/pdf',data:'AAA'}]});
console.log('M-10 filename emitted :', (withAtt.match(/filename="[^"]*"/)||['(none)'])[0]);
// L-14
console.log('L-14 CTE for plain part :', (withAtt.match(/Content-Transfer-Encoding: *\S+/)||['(none)'])[0]);
