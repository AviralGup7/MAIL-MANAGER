const { buildMime } = await import('./src/background/gmail.js');
const mime = buildMime({ to:'a@b.c', subject:'x', body:'y',
  attachments:[{ filename:'ev"il\r\nBcc: attacker@evil.com\r\n.txt', mimeType:'text/plain', data:'AA==' }]});
const line = mime.split('\r\n').find(l=>l.startsWith('Content-Disposition'));
console.log('disposition:', JSON.stringify(line));
console.log('Bcc injected? ', /^Bcc: attacker@evil\.com/m.test(mime), '(must be false)');
console.log('raw quotes   :', (line.match(/"/g)||[]).length);
console.log('UNESCAPED quotes (parameter terminators):', (line.match(/(^|[^\\])"/g)||[]).length, '(must be 2)');
// Does a real parser read the filename back correctly?
const m = /filename="((?:[^"\\]|\\.)*)"/.exec(line);
console.log('parsed filename:', JSON.stringify(m && m[1].replace(/\\(.)/g,'$1')));
