const { cleanSnippet } = await import('./src/app/mail/snippet.js');
console.log('rtl marks kept? ', JSON.stringify(cleanSnippet('\u200Fشلام עברית')));
console.log('newline -> space:', JSON.stringify(cleanSnippet('a\nb\tc')));
console.log('normal text    :', JSON.stringify(cleanSnippet('Course registration opens Monday.')));
