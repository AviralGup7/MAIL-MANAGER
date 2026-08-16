const { headerMap } = await import('./src/background/gmail.js');
const m = headerMap([{name:'Subject',value:'=?UTF-8?Q?Caf=C3=A9?='}]);
console.log('typeof:', Object.getPrototypeOf(m));
console.log('keys:', Object.keys(m), 'subject:', JSON.stringify(m.subject));
