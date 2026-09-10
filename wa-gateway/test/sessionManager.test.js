const assert = require('assert');
const { resolveMessageJids, mergeJidAlias } = require('../src/sessionManager');

const phoneJid = '905321234567@s.whatsapp.net';
const lidJid = '123456789012345@lid';

assert.deepStrictEqual(
    resolveMessageJids({ key: { remoteJid: lidJid, remoteJidAlt: phoneJid } }),
    { canonicalJid: phoneJid, aliasJid: lidJid }
);

const session = {
    chats: new Map([
        [phoneJid, { id: phoneJid, name: 'Cevat Aydin', lastMessage: 'Giden', timestamp: 10 }],
        [lidJid, { id: lidJid, name: 'lazury', lastMessage: 'Gelen', timestamp: 20, unreadCount: 1 }],
    ]),
    contacts: new Map([
        [phoneJid, { id: phoneJid, name: 'Cevat Aydin' }],
        [lidJid, { id: lidJid, notify: 'lazury' }],
    ]),
};

mergeJidAlias(session, phoneJid, lidJid);

assert.strictEqual(session.chats.has(lidJid), false);
assert.strictEqual(session.contacts.has(lidJid), false);
assert.strictEqual(session.chats.get(phoneJid).name, 'Cevat Aydin');
assert.strictEqual(session.chats.get(phoneJid).lastMessage, 'Gelen');
assert.strictEqual(session.chats.get(phoneJid).unreadCount, 1);
assert.deepStrictEqual(session.chats.get(phoneJid).jidAliases, [lidJid]);

console.log('sessionManager identity tests passed');
