const assert = require('assert');
const {
    resolveMessageJids,
    resolveMessageJidsAsync,
    mergeJidAlias,
    recordLidPnMapping,
    findPnForLid,
    getSessionChats
} = require('../src/sessionManager');

const phoneJid = '905076382749@s.whatsapp.net';
const lidJid = '195872117768369@lid';

// Test 1: Explicit remoteJidAlt resolution
assert.deepStrictEqual(
    resolveMessageJids({ key: { remoteJid: lidJid, remoteJidAlt: phoneJid } }),
    { canonicalJid: phoneJid, aliasJid: lidJid }
);

// Test 2: Real-world scenario - Inbound message arrives with ONLY remoteJid (LID) and NO remoteJidAlt!
const sessionData = {
    name: 'test_session',
    chats: new Map([
        [phoneJid, { id: phoneJid, name: 'Cevat Aydın', lastMessage: 'selam', timestamp: 100 }],
    ]),
    contacts: new Map([
        [phoneJid, { id: phoneJid, name: 'Cevat Aydın', lid: lidJid }],
    ]),
    lidToPnMap: new Map(),
    pnToLidMap: new Map(),
};

// Record mapping as would happen during history sync / contacts sync
recordLidPnMapping(sessionData, lidJid, phoneJid);

// Ensure findPnForLid works
assert.strictEqual(findPnForLid(sessionData, lidJid), phoneJid);

// Incoming message from Cevat with ONLY lidJid
const inboundMsg = {
    key: { remoteJid: lidJid, id: 'WA_INBOUND_123', fromMe: false },
    pushName: 'Lazury',
    message: { conversation: 'aleykumselam tatlım' },
    messageTimestamp: 200
};

const resolved = resolveMessageJids(inboundMsg, sessionData);
assert.deepStrictEqual(resolved, { canonicalJid: phoneJid, aliasJid: lidJid });

// Merge the alias
mergeJidAlias(sessionData, resolved.canonicalJid, resolved.aliasJid);

// Verify merged state
assert.strictEqual(sessionData.chats.has(lidJid), false);
assert.strictEqual(sessionData.chats.has(phoneJid), true);
const canonicalChat = sessionData.chats.get(phoneJid);
assert.strictEqual(canonicalChat.name, 'Cevat Aydın');
assert.deepStrictEqual(canonicalChat.jidAliases, [lidJid]);

// Test 3: Async resolution via Baileys signalRepository
(async () => {
    const freshSession = {
        name: 'test_async_session',
        chats: new Map(),
        contacts: new Map(),
        lidToPnMap: new Map(),
        pnToLidMap: new Map(),
        sock: {
            signalRepository: {
                lidMapping: {
                    getPNForLID: async (lid) => (lid === lidJid ? '905076382749:0@s.whatsapp.net' : null)
                }
            }
        }
    };

    const asyncRes = await resolveMessageJidsAsync({ key: { remoteJid: lidJid } }, freshSession);
    assert.deepStrictEqual(asyncRes, { canonicalJid: phoneJid, aliasJid: lidJid });
    assert.strictEqual(freshSession.lidToPnMap.get(lidJid), phoneJid);

    // Test 4: Verify getSessionChats never outputs duplicate fake +1958... chat
    freshSession.chats.set(phoneJid, {
        id: phoneJid,
        name: 'Cevat Aydın',
        lastMessage: 'aleykumselam tatlım',
        timestamp: 200,
        jidAliases: [lidJid]
    });
    freshSession.contacts.set(phoneJid, {
        id: phoneJid,
        name: 'Cevat Aydın',
        notify: 'Lazury'
    });

    const { activeSessions } = require('../src/sessionManager');
    activeSessions.set('test_async_session', freshSession);

    const chatsList = await getSessionChats('test_async_session');
    assert.strictEqual(chatsList.length, 1, 'Should output exactly 1 consolidated chat, not duplicate LID chat');
    const c = chatsList[0];
    assert.strictEqual(c.phone, '+905076382749');
    assert.strictEqual(c.name, 'Cevat Aydın');
    assert.strictEqual(c.push_name, 'Lazury');
    assert.strictEqual(c.last_message, 'aleykumselam tatlım');
    assert.deepStrictEqual(c.jid_aliases, [lidJid]);

    console.log('All sessionManager identity and LID-PN deduplication tests passed successfully!');
})().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
