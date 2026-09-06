const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const pino = require('pino');
const axios = require('axios');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers
} = require('@whiskeysockets/baileys');

const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');

// Ensure sessions directory exists
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Global active sessions map: sessionName -> sessionData
const activeSessions = new Map();

/**
 * Dispatches webhook notifications to the FastAPI backend.
 */
async function notifyBackend(sessionName, endpoint, payload) {
    const backendUrl = (process.env.BACKEND_URL || 'http://localhost:8000').replace(/\/$/, '');
    const webhookSecret = process.env.WA_GATEWAY_WEBHOOK_SECRET || 'dev-webhook-secret';

    try {
        await axios.post(`${backendUrl}/api/v1/whatsapp/webhook/${endpoint}`, {
            session_name: sessionName,
            ...payload
        }, {
            headers: {
                'X-Webhook-Secret': webhookSecret,
                'Content-Type': 'application/json'
            },
            timeout: 5000
        });
        console.log(`[WA-Gateway] Webhook dispatched to ${endpoint} for ${sessionName}`);
    } catch (err) {
        console.warn(`[WA-Gateway] Webhook to ${endpoint} failed for ${sessionName}:`, err.message);
    }
}

/**
 * Extracts plain text from any Baileys message object.
 */
function extractMessageText(message) {
    if (!message) return '';
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    if (message.documentMessage?.caption) return message.documentMessage.caption;
    return '';
}

/**
 * Initializes or retrieves an active Baileys WhatsApp socket session.
 */
async function getOrCreateSession(sessionName) {
    if (activeSessions.has(sessionName)) {
        const existing = activeSessions.get(sessionName);
        return existing;
    }

    const sessionAuthDir = path.join(SESSIONS_DIR, sessionName);
    if (!fs.existsSync(sessionAuthDir)) {
        fs.mkdirSync(sessionAuthDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionAuthDir);

    const sessionData = {
        name: sessionName,
        status: 'INITIALIZING',
        phone: null,
        qr: null,
        qrImage: null,
        sock: null,
        createdAt: new Date().toISOString(),
        messagesSent: 0
    };

    activeSessions.set(sessionName, sessionData);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000
    });

    sessionData.sock = sock;

    // Listen to credentials update
    sock.ev.on('creds.update', saveCreds);

    // Listen to connection state & QR generation
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessionData.status = 'SCAN_QR';
            sessionData.qr = qr;
            try {
                sessionData.qrImage = await QRCode.toDataURL(qr);
                await notifyBackend(sessionName, 'session-qr', {
                    qr_code: sessionData.qrImage
                });
            } catch (err) {
                console.error(`[WA-Gateway] Failed to generate QR data URL for ${sessionName}:`, err);
            }
        }

        if (connection === 'open') {
            sessionData.status = 'CONNECTED';
            sessionData.qr = null;
            sessionData.qrImage = null;

            // Extract phone number from JID (e.g. "905321002030:1@s.whatsapp.net" -> "+905321002030")
            const userJid = sock.user?.id || '';
            const rawPhone = userJid.split(':')[0].split('@')[0];
            sessionData.phone = rawPhone ? `+${rawPhone}` : null;

            console.log(`[WA-Gateway] Session ${sessionName} connected as ${sessionData.phone}`);

            await notifyBackend(sessionName, 'session-status', {
                status: 'CONNECTED',
                phone: sessionData.phone
            });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;

            console.log(`[WA-Gateway] Session ${sessionName} closed. Status code: ${statusCode}, LoggedOut: ${isLoggedOut}`);

            if (isLoggedOut) {
                sessionData.status = 'DISCONNECTED';
                sessionData.phone = null;
                sessionData.qr = null;
                sessionData.qrImage = null;

                try {
                    fs.rmSync(sessionAuthDir, { recursive: true, force: true });
                } catch (e) {
                    console.warn(`[WA-Gateway] Could not delete auth dir for ${sessionName}:`, e);
                }

                activeSessions.delete(sessionName);

                await notifyBackend(sessionName, 'session-status', {
                    status: 'DISCONNECTED',
                    phone: null
                });
            } else {
                sessionData.status = 'CONNECTING';
                // Automatically attempt reconnect after 3 seconds
                setTimeout(() => {
                    activeSessions.delete(sessionName);
                    getOrCreateSession(sessionName).catch(err => {
                        console.error(`[WA-Gateway] Reconnect failed for ${sessionName}:`, err.message);
                    });
                }, 3000);
            }
        }
    });

    // Listen to incoming messages from contacts
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' || !messages || messages.length === 0) return;

        for (const msg of messages) {
            if (msg.key.fromMe) continue; // Ignore outbound messages sent by self

            const remoteJid = msg.key.remoteJid || '';
            if (!remoteJid.endsWith('@s.whatsapp.net')) continue; // Ignore group chats, status updates

            const senderDigits = remoteJid.split('@')[0];
            const senderPhone = `+${senderDigits}`;
            const text = extractMessageText(msg.message);

            if (!text) continue;

            console.log(`[WA-Gateway] Inbound message from ${senderPhone} on ${sessionName}: "${text}"`);

            await notifyBackend(sessionName, 'inbound', {
                phone: senderPhone,
                message: text,
                wa_message_id: msg.key.id,
                timestamp: msg.messageTimestamp
            });
        }
    });

    return sessionData;
}

/**
 * Dispatches an outbound WhatsApp message through an active session socket.
 */
async function sendMessage(sessionName, phone, messageText, typingDelayMs = 0) {
    const session = activeSessions.get(sessionName);
    if (!session || session.status !== 'CONNECTED' || !session.sock) {
        throw new Error(`WhatsApp hattı bağlı değil (Oturum: ${sessionName}, Durum: ${session ? session.status : 'BULUNAMADI'})`);
    }

    const cleanPhone = phone.replace(/[^\d]/g, '');
    const jid = `${cleanPhone}@s.whatsapp.net`;

    // Simulated human typing
    if (typingDelayMs > 0) {
        try {
            await session.sock.sendPresenceUpdate('composing', jid);
            const delay = Math.min(typingDelayMs, 8000);
            await new Promise(resolve => setTimeout(resolve, delay));
            await session.sock.sendPresenceUpdate('paused', jid);
        } catch (e) {
            // Non-critical if presence fails
        }
    }

    const sent = await session.sock.sendMessage(jid, { text: messageText });
    session.messagesSent = (session.messagesSent || 0) + 1;

    return {
        success: true,
        messageId: sent.key.id,
        phone: phone,
        status: 'SENT',
        timestamp: new Date().toISOString()
    };
}

/**
 * Disconnects and deletes a session cleanly.
 */
async function disconnectSession(sessionName) {
    const session = activeSessions.get(sessionName);
    if (session && session.sock) {
        try {
            await session.sock.logout();
        } catch (e) {
            try {
                session.sock.end();
            } catch (err) {}
        }
    }

    const sessionAuthDir = path.join(SESSIONS_DIR, sessionName);
    try {
        if (fs.existsSync(sessionAuthDir)) {
            fs.rmSync(sessionAuthDir, { recursive: true, force: true });
        }
    } catch (e) {}

    activeSessions.delete(sessionName);

    return { success: true, message: `Session ${sessionName} disconnected` };
}

/**
 * Restores previously paired sessions on server startup.
 */
async function restoreSavedSessions() {
    if (!fs.existsSync(SESSIONS_DIR)) return;

    const dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

    for (const name of dirs) {
        console.log(`[WA-Gateway] Restoring saved session: ${name}`);
        try {
            await getOrCreateSession(name);
        } catch (err) {
            console.error(`[WA-Gateway] Failed to restore session ${name}:`, err.message);
        }
    }
}

module.exports = {
    activeSessions,
    getOrCreateSession,
    sendMessage,
    disconnectSession,
    restoreSavedSessions
};
