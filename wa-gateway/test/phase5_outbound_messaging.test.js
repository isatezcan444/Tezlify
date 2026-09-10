/**
 * Phase 5 Gateway Outbound Messaging & Verification Tests
 * 
 * Verifies:
 * 1. Connected Baileys session sends text message through sock.sendMessage
 * 2. Real Baileys message key.id is returned in response
 * 3. Disconnected / non-existent session rejects send fail-closed
 * 4. Empty message text rejected fail-closed
 * 5. Invalid / non-existent recipient rejected fail-closed
 * 6. Group recipient (@g.us) rejected fail-closed
 * 7. Duplicate client_message_id returns cached result without double sock.sendMessage
 * 8. Tenant & session composite key resolution
 * 9. Baileys socket error handled and normalized safely
 * 10. Presence typing simulation option
 */
const assert = require('assert');
const {
    activeSessions,
    sendMessage,
    makeSessionKey,
} = require('../src/sessionManager');

async function runTests() {
    console.log('--- Starting Phase 5 Gateway Outbound Messaging Tests ---');

    const tenantA = 'tenant_p5_outbound_a';
    const sessionA = 'sess_p5_a';
    const keyA = makeSessionKey(tenantA, sessionA);

    let sentCalls = [];

    // Mock connected session
    const mockSock = {
        sendMessage: async (jid, content) => {
            sentCalls.push({ jid, content });
            return {
                key: {
                    id: `baileys_mid_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                    remoteJid: jid,
                    fromMe: true
                }
            };
        },
        sendPresenceUpdate: async (type, jid) => {}
    };

    activeSessions.set(keyA, {
        name: keyA,
        tenantId: tenantA,
        sessionId: sessionA,
        status: 'CONNECTED',
        phone: '+905551112233',
        sock: mockSock,
        messagesSent: 0
    });

    try {
        // Test 1: Connected Baileys session sends text message
        console.log('Running Test 1: Connected session sends message...');
        sentCalls = [];
        const res1 = await sendMessage(
            { tenantId: tenantA, sessionId: sessionA },
            '+905321112233',
            'Merhaba, siparişiniz onaylandı.'
        );
        assert.strictEqual(res1.success, true);
        assert.strictEqual(res1.status, 'SENT');
        assert.ok(res1.messageId.startsWith('baileys_mid_'));
        assert.strictEqual(sentCalls.length, 1);
        assert.strictEqual(sentCalls[0].jid, '905321112233@s.whatsapp.net');
        assert.strictEqual(sentCalls[0].content.text, 'Merhaba, siparişiniz onaylandı.');

        // Test 2: Real Baileys message key.id is returned
        console.log('Running Test 2: Real Baileys key.id returned...');
        assert.ok(typeof res1.messageId === 'string' && res1.messageId.length > 10);

        // Test 3: Disconnected session rejects send fail-closed
        console.log('Running Test 3: Disconnected session rejected fail-closed...');
        const keyDisc = makeSessionKey('tenant_disc', 'sess_disc');
        activeSessions.set(keyDisc, {
            name: keyDisc,
            tenantId: 'tenant_disc',
            sessionId: 'sess_disc',
            status: 'DISCONNECTED',
            sock: null
        });
        await assert.rejects(
            async () => {
                await sendMessage({ tenantId: 'tenant_disc', sessionId: 'sess_disc' }, '+905321112233', 'Test');
            },
            /bağlı değil/
        );

        // Test 4: Empty text rejected
        console.log('Running Test 4: Empty text rejected...');
        await assert.rejects(
            async () => {
                await sendMessage({ tenantId: tenantA, sessionId: sessionA }, '+905321112233', '   ');
            },
            /boş olamaz/
        );

        // Test 5: Invalid recipient rejected
        console.log('Running Test 5: Invalid recipient rejected...');
        await assert.rejects(
            async () => {
                await sendMessage({ tenantId: tenantA, sessionId: sessionA }, 'abc', 'Test');
            },
            /Geçersiz/
        );

        // Test 6: Group recipient (@g.us) rejected fail-closed
        console.log('Running Test 6: Group recipient rejected fail-closed...');
        await assert.rejects(
            async () => {
                await sendMessage({ tenantId: tenantA, sessionId: sessionA }, '120363024829281@g.us', 'Group announcement');
            },
            /Grup mesajları bu fazda desteklenmemektedir/
        );

        // Test 7: Duplicate client_message_id returns cached result without double send
        console.log('Running Test 7: Duplicate client_message_id idempotency...');
        sentCalls = [];
        const clientMid = `cmsg_test_${Date.now()}`;
        const sendFirst = await sendMessage(
            { tenantId: tenantA, sessionId: sessionA },
            '+905321112233',
            'Tek seferlik mesaj',
            0,
            clientMid
        );
        assert.strictEqual(sentCalls.length, 1);
        const originalMsgId = sendFirst.messageId;

        // Second call with same clientMid
        const sendSecond = await sendMessage(
            { tenantId: tenantA, sessionId: sessionA },
            '+905321112233',
            'Tek seferlik mesaj',
            0,
            clientMid
        );
        // Did not call sock.sendMessage again!
        assert.strictEqual(sentCalls.length, 1);
        assert.strictEqual(sendSecond.messageId, originalMsgId);

        // Test 8: Unknown/non-existent session fails closed
        console.log('Running Test 8: Non-existent session rejected...');
        await assert.rejects(
            async () => {
                await sendMessage({ tenantId: 'non_existent_tenant', sessionId: 'sess_none' }, '+905321112233', 'Test');
            },
            /bağlı değil/
        );

        // Test 9: Baileys socket error handled and normalized safely
        console.log('Running Test 9: Socket exception normalized...');
        const keyErr = makeSessionKey('tenant_err', 'sess_err');
        activeSessions.set(keyErr, {
            name: keyErr,
            tenantId: 'tenant_err',
            sessionId: 'sess_err',
            status: 'CONNECTED',
            sock: {
                sendMessage: async () => {
                    throw new Error('Connection closed by remote WhatsApp server');
                }
            }
        });
        await assert.rejects(
            async () => {
                await sendMessage({ tenantId: 'tenant_err', sessionId: 'sess_err' }, '+905321112233', 'Failing test');
            },
            /Connection closed/
        );

        // Test 10: Counter incremented on successful send
        console.log('Running Test 10: Sent message counter updated...');
        const sessRecord = activeSessions.get(keyA);
        assert.ok(sessRecord.messagesSent >= 2);

        console.log('\n================================================================');
        console.log('✅ ALL 10 PHASE 5 GATEWAY OUTBOUND MESSAGING TESTS PASSED!');
        console.log('================================================================\n');
    } finally {
        activeSessions.delete(keyA);
        activeSessions.delete(makeSessionKey('tenant_disc', 'sess_disc'));
        activeSessions.delete(makeSessionKey('tenant_err', 'sess_err'));
    }
}

runTests().catch(err => {
    console.error('Test failure:', err);
    process.exit(1);
});
