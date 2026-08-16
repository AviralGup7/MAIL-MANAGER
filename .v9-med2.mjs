const { addressOf } = await import('./src/app/core/contacts.js');
console.log("M-7 addressOf('a@b.c, d@e.f') ->", JSON.stringify(addressOf('a@b.c, d@e.f')));
const bk = await import('./src/app/system/backup.js');
console.log("M-8 validateBackup(data:[]) ->", JSON.stringify(bk.validateBackup({format:bk.BACKUP_FORMAT||'bits-mail-manager-backup',version:1,data:[]})));
console.log("M-9 validateBackup(version:NaN) ->", JSON.stringify(bk.validateBackup({format:bk.BACKUP_FORMAT||'bits-mail-manager-backup',version:NaN,data:{}})));
const sn = await import('./src/app/mail/snippet.js');
const fn = sn.cleanSnippet || sn.default;
console.log("M-10 ctrl chars ->", JSON.stringify(fn('a\u0000b\u0007c')));
console.log("M-11 bidi ->", JSON.stringify(fn('a\u202Eb')));
