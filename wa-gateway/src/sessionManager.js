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
    fetchLatestBaileysVersion,
    proto
} = require('@whiskeysockets/baileys');

const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');

// Ensure sessions directory exists
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Global active sessions map: sessionName -> sessionData
const activeSessions = new Map();

// In-flight initialization promises to avoid race conditions and double-socket creation
const pendingInitializations = new Map();

// Cached Baileys version to avoid slow external HTTP requests on every socket creation
let cachedBaileysVersion = null;
let lastVersionFetchTime = 0;

async function getCachedBaileysVersion() {
    const now = Date.now();
    if (cachedBaileysVersion && (now - lastVersionFetchTime < 24 * 60 * 60 * 1000)) {
        return cachedBaileysVersion;
    }
    try {
        const { version } = await fetchLatestBaileysVersion();
        cachedBaileysVersion = version;
        lastVersionFetchTime = now;
        return cachedBaileysVersion;
    } catch (e) {
        return cachedBaileysVersion || [2, 3000, 1043857760];
    }
}

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
            timeout: 15000
        });
        console.log(`[WA-Gateway] Webhook dispatched to ${endpoint} for ${sessionName}`);
    } catch (err) {
        console.warn(`[WA-Gateway] Webhook to ${endpoint} failed for ${sessionName}:`, err.message);
    }
}

// Map of debounce timers for backing up auth files to DB
const backupDebounceTimers = new Map();

/**
 * Backs up all session credentials and keys to the database via webhook.
 */
function backupSessionAuth(sessionName) {
    if (backupDebounceTimers.has(sessionName)) {
        clearTimeout(backupDebounceTimers.get(sessionName));
    }
    const timer = setTimeout(async () => {
        backupDebounceTimers.delete(sessionName);
        try {
            const sessionAuthDir = path.join(SESSIONS_DIR, sessionName);
            if (!fs.existsSync(sessionAuthDir)) return;
            const files = fs.readdirSync(sessionAuthDir);
            const authBundle = {};
            for (const file of files) {
                if (file.endsWith('.json')) {
                    try {
                        const content = fs.readFileSync(path.join(sessionAuthDir, file), 'utf8');
                        authBundle[file] = content;
                    } catch (err) {}
                }
            }
            if (authBundle['creds.json']) {
                await notifyBackend(sessionName, 'session-backup', { auth_bundle: authBundle });
                console.log(`[WA-Gateway] Backed up ${Object.keys(authBundle).length} auth files to database for ${sessionName}`);
            }
        } catch (e) {
            console.warn(`[WA-Gateway] Auth backup failed for ${sessionName}:`, e.message);
        }
    }, 800);
    backupDebounceTimers.set(sessionName, timer);
}

/**
 * Restores session auth files from database backup into the local SESSIONS_DIR.
 */
async function restoreSessionFromDatabase(sessionName) {
    const backendUrl = (process.env.BACKEND_URL || 'http://localhost:8000').replace(/\/$/, '');
    const webhookSecret = process.env.WA_GATEWAY_WEBHOOK_SECRET || 'dev-webhook-secret';
    try {
        const res = await axios.get(`${backendUrl}/api/v1/whatsapp/webhook/session-restore/${encodeURIComponent(sessionName)}`, {
            headers: { 'X-Webhook-Secret': webhookSecret },
            timeout: 5000
        });
        if (res.data && res.data.auth_bundle) {
            const sessionAuthDir = path.join(SESSIONS_DIR, sessionName);
            if (!fs.existsSync(sessionAuthDir)) {
                fs.mkdirSync(sessionAuthDir, { recursive: true });
            }
            for (const [file, content] of Object.entries(res.data.auth_bundle)) {
                fs.writeFileSync(path.join(sessionAuthDir, file), content, 'utf8');
            }
            console.log(`[WA-Gateway] Restored ${Object.keys(res.data.auth_bundle).length} auth files for ${sessionName} from database`);
            return true;
        }
    } catch (e) {
        console.warn(`[WA-Gateway] Could not restore auth from database for ${sessionName}:`, e.message);
    }
    return false;
}

/**
 * Auto-restores all sessions that exist in the database upon gateway startup.
 */
async function restoreAllSessionsFromDatabase() {
    const backendUrl = (process.env.BACKEND_URL || 'http://localhost:8000').replace(/\/$/, '');
    const webhookSecret = process.env.WA_GATEWAY_WEBHOOK_SECRET || 'dev-webhook-secret';
    try {
        const res = await axios.get(`${backendUrl}/api/v1/whatsapp/webhook/sessions-all`, {
            headers: { 'X-Webhook-Secret': webhookSecret },
            timeout: 6000
        });
        if (res.data && Array.isArray(res.data.sessions)) {
            for (const item of res.data.sessions) {
                const sName = item.session_name;
                const sDir = path.join(SESSIONS_DIR, sName);
                if (item.auth_bundle && Object.keys(item.auth_bundle).length > 0) {
                    if (!fs.existsSync(sDir)) fs.mkdirSync(sDir, { recursive: true });
                    for (const [f, content] of Object.entries(item.auth_bundle)) {
                        fs.writeFileSync(path.join(sDir, f), content, 'utf8');
                    }
                }
                const credsPath = path.join(sDir, 'creds.json');
                if (fs.existsSync(credsPath) && !activeSessions.has(sName)) {
                    console.log(`[WA-Gateway] Auto-restoring session from DB: ${sName}`);
                    getOrCreateSession(sName).catch(err => console.warn(`Error auto-restoring ${sName}:`, err.message));
                }
            }
        }
    } catch (e) {
        console.warn(`[WA-Gateway] Failed to restore sessions from database:`, e.message);
    }
}

/**
 * Initializes or re-initializes the underlying Baileys WhatsApp socket and its listeners.
 */
async function initSessionSocket(sessionData) {
    const sessionName = sessionData.name;
    const sessionAuthDir = path.join(SESSIONS_DIR, sessionName);
    if (!fs.existsSync(sessionAuthDir)) {
        fs.mkdirSync(sessionAuthDir, { recursive: true });
    }

    if (sessionData.reconnectTimer) {
        clearTimeout(sessionData.reconnectTimer);
        sessionData.reconnectTimer = null;
    }

    // Clean up any existing socket and listeners cleanly
    if (sessionData.sock) {
        try {
            sessionData.sock.ev?.removeAllListeners();
        } catch (e) {}
        try {
            sessionData.sock.end(undefined);
        } catch (e) {}
        sessionData.sock = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionAuthDir);
    // Initialize accountSyncCounter so Baileys skips the 20-second AwaitingInitialSync wait
    if (!state.creds.accountSyncCounter || state.creds.accountSyncCounter < 1) {
        state.creds.accountSyncCounter = 1;
    }
    const version = await getCachedBaileysVersion();
    console.log(`[WA-Gateway] Starting socket for ${sessionName} with WA Web v${version.join('.')}`);

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Chrome'),
        syncFullHistory: false,
        shouldSyncHistoryMessage: (msg) => {
            // Prevent mobile phone from hanging on "Giriş yapılıyor..." (Logging in...)
            // By skipping RECENT and FULL history dumps, the phone finishes companion login immediately
            const syncType = msg?.syncType;
            return syncType !== proto.HistorySync.HistorySyncType.RECENT &&
                   syncType !== proto.HistorySync.HistorySyncType.FULL;
        },
        markOnlineOnConnect: true,
        fireInitQueries: true,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        generateHighQualityLinkPreview: false,
        keepAliveIntervalMs: 25000,
    });

    sessionData.sock = sock;

    // Listen to credentials update
    sock.ev.on('creds.update', async () => {
        await saveCreds();
        backupSessionAuth(sessionName);
    });

    // Listen to connection state & QR generation
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessionData.status = 'SCAN_QR';
            sessionData.qr = qr;
            try {
                sessionData.qrImage = await QRCode.toDataURL(qr, {
                    errorCorrectionLevel: 'L',
                    margin: 2,
                    scale: 6,
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
            const alreadyConnected = sessionData.status === 'CONNECTED';
            sessionData.status = 'CONNECTED';
            sessionData.qr = null;
            sessionData.qrImage = null;

            // Extract phone number from JID (e.g. "905321002030:1@s.whatsapp.net" -> "+905321002030")
            const userJid = sock.user?.id || '';
            const rawPhone = userJid.split(':')[0].split('@')[0];
            sessionData.phone = rawPhone ? `+${rawPhone}` : null;

            console.log(`[WA-Gateway] Session ${sessionName} connected as ${sessionData.phone}`);

            if (!alreadyConnected) {
                await notifyBackend(sessionName, 'session-status', {
                    status: 'CONNECTED',
                    phone: sessionData.phone
                });
            }

            backupSessionAuth(sessionName);
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
                const isRestartRequired = statusCode === DisconnectReason.restartRequired;
                const wasPairing = sessionData.status === 'SCAN_QR' || !sessionData.phone;
                const reconnectDelay = isRestartRequired || wasPairing ? 80 : 2500;
                console.log(`[WA-Gateway] Reconnecting session ${sessionName} in ${reconnectDelay}ms (status: ${statusCode}, restartRequired: ${isRestartRequired}, wasPairing: ${wasPairing})...`);

                sessionData.status = 'CONNECTING';

                if (sessionData.reconnectTimer) {
                    clearTimeout(sessionData.reconnectTimer);
                }
                sessionData.reconnectTimer = setTimeout(() => {
                    sessionData.reconnectTimer = null;
                    initSessionSocket(sessionData).catch(err => {
                        console.error(`[WA-Gateway] Reconnect failed for ${sessionName}:`, err.message);
                    });
                }, reconnectDelay);
            }
        }
    });

    // Inbound messages (for opt-out / STOP keyword detection only)
    sock.ev.on('messages.upsert', async ({ messages }) => {
        if (!messages || messages.length === 0) return;

        for (const msg of messages) {
            const remoteJid = msg.key?.remoteJid || '';
            const isGroup = remoteJid.endsWith('@g.us');
            const fromMe = !!msg.key?.fromMe;

            if (fromMe || isGroup) continue;

            const text = msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                '';

            if (!text) continue;

            const contactPhone = `+${remoteJid.split('@')[0]}`;
            const ts = typeof msg.messageTimestamp === 'number'
                ? msg.messageTimestamp
                : Math.floor(Date.now() / 1000);

            await notifyBackend(sessionName, 'inbound', {
                phone: contactPhone,
                message: text,
                wa_message_id: msg.key?.id,
                timestamp: ts
            });
        }
    });

    return sessionData;
}

/**
 * Initializes or retrieves an active Baileys WhatsApp socket session.
 */
async function getOrCreateSession(sessionName, forceNewSocket = false) {
    let sessionData = activeSessions.get(sessionName);

    if (sessionData) {
        if (!forceNewSocket && sessionData.sock && sessionData.status === 'CONNECTED') {
            return sessionData;
        }
        if (!forceNewSocket && sessionData.status === 'CONNECTING' && sessionData.reconnectTimer) {
            return sessionData;
        }
        await initSessionSocket(sessionData);
        return sessionData;
    }

    sessionData = {
        name: sessionName,
        status: 'INITIALIZING',
        phone: null,
        qr: null,
        qrImage: null,
        sock: null,
        createdAt: new Date().toISOString(),
        messagesSent: 0,
        reconnectTimer: null
    };

    activeSessions.set(sessionName, sessionData);
    await initSessionSocket(sessionData);
    return sessionData;
}

/**
 * Dispatches an outbound WhatsApp message through an active session socket.
 */
async function sendMessage(sessionName, phone, messageText, typingDelayMs = 0) {
    let session = activeSessions.get(sessionName);
    if (!session || session.status !== 'CONNECTED' || !session.sock) {
        const credsPath = path.join(SESSIONS_DIR, sessionName, 'creds.json');
        let hasCreds = fs.existsSync(credsPath);
        if (!hasCreds) {
            hasCreds = await restoreSessionFromDatabase(sessionName);
        }
        if (hasCreds) {
            session = await getOrCreateSession(sessionName);
            if (session.status !== 'CONNECTED') {
                await new Promise((resolve) => {
                    const timeout = setTimeout(resolve, 3500);
                    const onUpdate = (update) => {
                        if (update.connection === 'open') {
                            clearTimeout(timeout);
                            session.sock?.ev?.off('connection.update', onUpdate);
                            resolve();
                        }
                    };
                    session.sock?.ev?.on('connection.update', onUpdate);
                });
            }
        }
    }

    if (!session || session.status !== 'CONNECTED' || !session.sock) {
        throw new Error(`WhatsApp hattı bağlı değil (Oturum: ${sessionName}, Durum: ${session ? session.status : 'BULUNAMADI'})`);
    }

    const isGroup = phone.endsWith('@g.us');
    const jid = isGroup ? phone : `${phone.replace(/[^\d]/g, '')}@s.whatsapp.net`;

    if (typingDelayMs > 0) {
        try {
            await session.sock.sendPresenceUpdate('composing', jid);
            const delay = Math.min(typingDelayMs, 8000);
            await new Promise(resolve => setTimeout(resolve, delay));
            await session.sock.sendPresenceUpdate('paused', jid);
        } catch (e) {}
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

    if (!session.sock.requestPairingCode || session.status === 'INITIALIZING') {
        let attempts = 0;
        while (attempts < 15 && (!session.sock?.requestPairingCode || session.status === 'INITIALIZING')) {
            await new Promise(resolve => setTimeout(resolve, 80));
            attempts++;
        }
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
    if (session) {
        if (session.reconnectTimer) {
            clearTimeout(session.reconnectTimer);
            session.reconnectTimer = null;
        }
        if (session.sock) {
            try {
                session.sock.ev?.removeAllListeners();
            } catch (e) {}
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
 * Restores previously paired sessions on server startup from database backup and local disk.
 */
async function restoreSavedSessions() {
    // Pre-warm version cache in background
    getCachedBaileysVersion().catch(() => {});

    await restoreAllSessionsFromDatabase();

    if (!fs.existsSync(SESSIONS_DIR)) return;

    const dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

    for (const name of dirs) {
        if (activeSessions.has(name)) continue;
        const credsPath = path.join(SESSIONS_DIR, name, 'creds.json');
        if (fs.existsSync(credsPath)) {
            try {
                const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                if (creds.registered || creds.me) {
                    console.log(`[WA-Gateway] Restoring saved active session from disk: ${name}`);
                    await getOrCreateSession(name);
                }
            } catch (err) {
                console.error(`[WA-Gateway] Failed to restore session ${name}:`, err.message);
            }
        }
    }
}

/**
 * Forces a clean refresh of an un-connected session to provide a brand new QR code.
 */
async function refreshSessionQR(sessionName) {
    const existing = activeSessions.get(sessionName);
    if (existing && existing.status === 'CONNECTED') {
        return existing;
    }

    if (pendingInitializations.has(sessionName)) {
        console.log(`[WA-Gateway] Awaiting in-flight initialization for ${sessionName}`);
        return await pendingInitializations.get(sessionName);
    }

    const initPromise = (async () => {
        try {
            if (existing && existing.reconnectTimer) {
                clearTimeout(existing.reconnectTimer);
                existing.reconnectTimer = null;
            }

            if (existing && existing.sock) {
                try {
                    existing.sock.ev?.removeAllListeners();
                } catch (e) {}
                try {
                    existing.sock.end(undefined);
                } catch (e) {}
            }

            const sessionAuthDir = path.join(SESSIONS_DIR, sessionName);
            const credsPath = path.join(sessionAuthDir, 'creds.json');
            let hasPairedCreds = false;
            if (fs.existsSync(credsPath)) {
                try {
                    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                    hasPairedCreds = !!(creds.registered || creds.me);
                } catch (e) {}
            }

            if (!hasPairedCreds && fs.existsSync(sessionAuthDir)) {
                try {
                    fs.rmSync(sessionAuthDir, { recursive: true, force: true });
                } catch (e) {}
            }

            const session = await getOrCreateSession(sessionName, true);

            if (!session.qrImage && session.status !== 'CONNECTED') {
                await new Promise((resolve) => {
                    const timeout = setTimeout(resolve, 3500);
                    const onUpdate = (update) => {
                        if (update.qr || update.connection === 'open') {
                            clearTimeout(timeout);
                            session.sock?.ev?.off('connection.update', onUpdate);
                            resolve();
                        }
                    };
                    session.sock?.ev?.on('connection.update', onUpdate);
                });
            }

            return session;
        } finally {
            pendingInitializations.delete(sessionName);
        }
    })();

    pendingInitializations.set(sessionName, initPromise);
    return await initPromise;
}

module.exports = {
    activeSessions,
    getOrCreateSession,
    refreshSessionQR,
    requestPairingCode,
    sendMessage,
    disconnectSession,
    restoreSavedSessions
};
