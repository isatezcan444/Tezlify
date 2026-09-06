const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const pino = require('pino');
const axios = require('axios');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion
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

    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1043857760] }));
    console.log(`[WA-Gateway] Starting socket for ${sessionName} with WA Web v${version.join('.')}`);

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: true,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        generateHighQualityLinkPreview: false,
        getMessage: async () => ({ conversation: '' })
    });

    sessionData.sock = sock;

    // Listen to credentials update
    sock.ev.on('creds.update', saveCreds);

    // Listen to WhatsApp initial chat & message history synchronization
    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
        console.log(`[WA-Gateway] History sync received for ${sessionName}: ${chats?.length || 0} chats, ${messages?.length || 0} messages`);
        try {
            const validChats = (chats || [])
                .filter(c => c.id && c.id.endsWith('@s.whatsapp.net'))
                .map(c => ({
                    id: c.id,
                    phone: `+${c.id.split('@')[0]}`,
                    name: c.name || ''
                }));

            const validMessages = (messages || [])
                .map(m => {
                    const remoteJid = m.key?.remoteJid || '';
                    const text = extractMessageText(m.message);
                    if (!remoteJid.endsWith('@s.whatsapp.net') || !text) return null;
                    return {
                        wa_message_id: m.key?.id,
                        fromMe: !!m.key?.fromMe,
                        phone: `+${remoteJid.split('@')[0]}`,
                        message: text,
                        timestamp: m.messageTimestamp
                    };
                })
                .filter(Boolean);

            if (validChats.length > 0 || validMessages.length > 0) {
                await notifyBackend(sessionName, 'history-sync', {
                    chats: validChats,
                    messages: validMessages
                });
            }
        } catch (err) {
            console.warn(`[WA-Gateway] History sync dispatch failed for ${sessionName}:`, err.message);
        }
    });

    // Listen to connection state & QR generation
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessionData.status = 'SCAN_QR';
            sessionData.qr = qr;
            try {
                sessionData.qrImage = await QRCode.toDataURL(qr, {
                    errorCorrectionLevel: 'M',
                    margin: 2,
                    scale: 8,
                    color: {
                        dark: '#000000',
                        light: '#FFFFFF'
                    }
                });
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
            const isLoggedOut = statusCode === DisconnectReason.loggedOut; // 401

            console.log(`[WA-Gateway] Session ${sessionName} closed. Status code: ${statusCode}, LoggedOut: ${isLoggedOut}`);

            if (isLoggedOut) {
                // Permanently logged out from phone or session unlinked
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
                // CRITICAL: For restartRequired (515), connectionClosed (428), timedOut (408), etc.:
                // NEVER delete sessionAuthDir!
                // During QR pairing, WhatsApp sends new credentials then sends 515 (restartRequired).
                // The socket must reconnect USING those saved credentials to finalize handshake.
                const isRestartRequired = statusCode === DisconnectReason.restartRequired;
                console.log(`[WA-Gateway] Reconnecting session ${sessionName} to finalize/maintain connection (status: ${statusCode})...`);

                sessionData.status = 'CONNECTING';
                activeSessions.delete(sessionName);

                // Wait 1000ms for creds.update to flush to disk before reconnecting
                setTimeout(() => {
                    getOrCreateSession(sessionName).catch(err => {
                        console.error(`[WA-Gateway] Reconnect failed for ${sessionName}:`, err.message);
                    });
                }, isRestartRequired ? 1000 : 3000);
            }
        }
    });

    // Listen to live message events (inbound from contacts & outbound from user's phone)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (!messages || messages.length === 0) return;

        for (const msg of messages) {
            const remoteJid = msg.key?.remoteJid || '';
            if (!remoteJid.endsWith('@s.whatsapp.net')) continue; // Ignore group chats, status updates

            const contactDigits = remoteJid.split('@')[0];
            const contactPhone = `+${contactDigits}`;
            const text = extractMessageText(msg.message);

            if (!text) continue;

            const fromMe = !!msg.key?.fromMe;
            console.log(`[WA-Gateway] Message (${fromMe ? 'Outbound phone' : 'Inbound'}) for ${contactPhone} on ${sessionName}: "${text}"`);

            // Dispatch message-event webhook for full two-way chat synchronization
            await notifyBackend(sessionName, 'message-event', {
                fromMe: fromMe,
                phone: contactPhone,
                message: text,
                wa_message_id: msg.key.id,
                timestamp: msg.messageTimestamp
            });

            // Backward compatibility for opt-out & lead reply processing
            if (!fromMe) {
                await notifyBackend(sessionName, 'inbound', {
                    phone: contactPhone,
                    message: text,
                    wa_message_id: msg.key.id,
                    timestamp: msg.messageTimestamp
                });
            }
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
 * Requests an 8-digit WhatsApp pairing code for linking via phone number.
 */
async function requestPairingCode(sessionName, phoneNumber) {
    const session = await getOrCreateSession(sessionName);
    if (!session || !session.sock) {
        throw new Error('Oturum soketi hazır değil.');
    }

    const cleanPhone = phoneNumber.replace(/\D/g, '');
    if (!cleanPhone || cleanPhone.length < 10) {
        throw new Error('Geçerli bir telefon numarası giriniz (örn: 905321234567).');
    }

    // Wait a brief moment for socket connection initialization
    if (session.status === 'INITIALIZING') {
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    const code = await session.sock.requestPairingCode(cleanPhone);
    session.pairingCode = code;
    return code;
}

/**
 * Disconnects and deletes a session cleanly.
 */
async function disconnectSession(sessionName) {
    const session = activeSessions.get(sessionName);
    if (session && session.sock) {
        try {
            await Promise.race([
                session.sock.logout(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Logout timeout')), 500))
            ]);
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
        const credsPath = path.join(SESSIONS_DIR, name, 'creds.json');
        if (fs.existsSync(credsPath)) {
            try {
                const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                if (creds.registered) {
                    console.log(`[WA-Gateway] Restoring saved active session: ${name}`);
                    await getOrCreateSession(name);
                }
            } catch (err) {
                console.error(`[WA-Gateway] Failed to restore session ${name}:`, err.message);
            }
        }
    }
}

module.exports = {
    activeSessions,
    getOrCreateSession,
    requestPairingCode,
    sendMessage,
    disconnectSession,
    restoreSavedSessions
};
