const { buildMime, decodeEncodedWords } = await import('./src/background/gmail.js');
for (const subj of ['é'.repeat(400), 'Café', '日本語のメール'.repeat(40), 'a'.repeat(300)+'é']) {
  const mime = buildMime({to:'a@b.c', subject: subj, body:'x'});
  const lines = mime.split('\r\n');
  const at = lines.findIndex(l => l.startsWith('Subject:'));
  // gather the folded run
  let raw = lines[at].slice('Subject:'.length).trim();
  for (let i=at+1; i<lines.length && /^[ \t]/.test(lines[i]); i++) raw += ' ' + lines[i].trim();
  const decoded = decodeEncodedWords(raw);
  const maxLine = Math.max(...mime.split('\r\n').map(l=>Buffer.byteLength(l,'utf8')));
  const words = raw.split(/\s+/).filter(w=>w.startsWith('=?'));
  const tooLong = words.filter(w=>w.length>75).length;
  console.log(`subject len ${String(subj.length).padEnd(5)} words=${String(words.length).padEnd(3)} maxWord=${Math.max(...words.map(w=>w.length))} over75=${tooLong} maxLine=${maxLine} roundTrip=${decoded===subj?'EXACT':'MISMATCH'}`);
}
