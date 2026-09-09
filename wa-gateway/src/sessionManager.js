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

/**
 * Safely converts protobuf Long, number, or string timestamps to unix seconds.
 */
function extractTimestamp(ts) {
    if (!ts) return 0;
    if (typeof ts === 'number') return ts;
    if (typeof ts === 'string') {
        const n = Number(ts);
        return isNaN(n) ? 0 : n;
    }
    if (typeof ts === 'object') {
        if (typeof ts.low === 'number') return ts.low;
        if (typeof ts.toNumber === 'function') return ts.toNumber();
    }
    return 0;
}

/**
 * Robustly extracts the display preview text from any Baileys message structure.
 */
function extractMessageText(msg) {
    if (!msg) return '';
    const m = msg.message?.message || msg.message || msg;
    if (typeof m === 'string') return m;
    return m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        (m.imageMessage ? '📷 Fotoğraf' : '') ||
        (m.videoMessage?.caption || (m.videoMessage ? '🎥 Video' : '')) ||
        (m.documentMessage?.title || m.documentMessage?.fileName || (m.documentMessage ? '📄 Belge' : '')) ||
        (m.audioMessage ? '🎵 Ses' : '') ||
        (m.stickerMessage ? '💟 Çıkartma' : '') ||
        (m.contactMessage ? '👤 Kişi kartı' : '') ||
        (m.locationMessage ? '📍 Konum' : '') ||
        '';
}

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

// Map of debounce timers for saving chats/contacts store to disk
const storeDebounceTimers = new Map();

/**
 * Persists in-memory synced chats and contacts to disk and triggers DB backup.
 */
function saveSessionStore(sessionName) {
    if (storeDebounceTimers.has(sessionName)) {
        clearTimeout(storeDebounceTimers.get(sessionName));
    }
    const timer = setTimeout(() => {
        storeDebounceTimers.delete(sessionName);
        try {
            const session = activeSessions.get(sessionName);
            if (!session) return;
            const sessionAuthDir = path.join(SESSIONS_DIR, sessionName);
            if (!fs.existsSync(sessionAuthDir)) {
                fs.mkdirSync(sessionAuthDir, { recursive: true });
            }
            const storePath = path.join(sessionAuthDir, 'chats_store.json');
            const data = {
                chats: Array.from((session.chats || new Map()).entries()),
                contacts: Array.from((session.contacts || new Map()).entries()),
                updatedAt: Date.now()
            };
            fs.writeFileSync(storePath, JSON.stringify(data), 'utf8');
            // Trigger DB backup so chats_store.json is mirrored in database
            backupSessionAuth(sessionName);
        } catch (e) {
            console.warn(`[WA-Gateway] Failed to save chats_store for ${sessionName}:`, e.message);
        }
    }, 500);
    storeDebounceTimers.set(sessionName, timer);
}

/**
 * Loads chats and contacts from disk for the session if available.
 */
function loadSessionStore(sessionName) {
    const session = activeSessions.get(sessionName);
    if (!session) return;
    if (!session.chats) session.chats = new Map();
    if (!session.contacts) session.contacts = new Map();

    const sessionAuthDir = path.join(SESSIONS_DIR, sessionName);
    const storePath = path.join(sessionAuthDir, 'chats_store.json');
    if (!fs.existsSync(storePath)) return;

    try {
        const raw = fs.readFileSync(storePath, 'utf8');
        const data = JSON.parse(raw);
        if (data.chats && Array.isArray(data.chats)) {
            for (const [k, v] of data.chats) {
                if (!session.chats.has(k)) {
                    session.chats.set(k, v);
                }
            }
        }
        if (data.contacts && Array.isArray(data.contacts)) {
            for (const [k, v] of data.contacts) {
                if (!session.contacts.has(k)) {
                    session.contacts.set(k, v);
                }
            }
        }
        console.log(`[WA-Gateway] Restored ${session.chats.size} chats and ${session.contacts.size} contacts from disk for ${sessionName}`);
    } catch (e) {
        console.warn(`[WA-Gateway] Failed to load chats_store for ${sessionName}:`, e.message);
    }
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
    const version = await getCachedBaileysVersion();
    console.log(`[WA-Gateway] Starting socket for ${sessionName} with WA Web v${version.join('.')}`);

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.appropriate('Chrome'),
        syncFullHistory: true,
        shouldSyncHistoryMessage: () => true, // CRITICAL: Never drop FULL or RECENT history sync notifications
        markOnlineOnConnect: true,
        fireInitQueries: true,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        generateHighQualityLinkPreview: false,
        keepAliveIntervalMs: 25000,
        getMessage: async () => undefined,
    });

    sessionData.sock = sock;

    if (!sessionData.chats) sessionData.chats = new Map();
    if (!sessionData.contacts) sessionData.contacts = new Map();
    loadSessionStore(sessionName);

    // Listen to credentials update
    sock.ev.on('creds.update', async () => {
        await saveCreds();
        backupSessionAuth(sessionName);
    });

    // 1. Initial bootstrap & history sync: captures all active chats and phonebook contacts
    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
        if (contacts && Array.isArray(contacts)) {
            for (const c of contacts) {
                if (!c.id) continue;
                const existing = sessionData.contacts.get(c.id) || {};
                sessionData.contacts.set(c.id, {
                    ...existing,
                    ...c,
                    name: c.name || c.displayName || c.verifiedName || existing.name,
                    notify: c.notify || existing.notify,
                    verifiedName: c.verifiedName || existing.verifiedName,
                });
            }
        }
        if (chats && Array.isArray(chats)) {
            for (const chat of chats) {
                if (!chat.id) continue;
                const existing = sessionData.chats.get(chat.id) || {};
                const lastMsg = chat.messages?.[0];
                const lastText = extractMessageText(lastMsg) || existing.lastMessage || '';

                const rawTs = chat.conversationTimestamp || chat.lastMsgTimestamp || lastMsg?.messageTimestamp;
                const ts = extractTimestamp(rawTs) || existing.timestamp || 0;

                sessionData.chats.set(chat.id, {
                    ...existing,
                    ...chat,
                    id: chat.id,
                    name: chat.name || chat.displayName || existing.name,
                    unreadCount: chat.unreadCount != null ? Number(chat.unreadCount) : (existing.unreadCount ?? 0),
                    lastMessage: lastText,
                    timestamp: ts,
                    isGroup: chat.id.endsWith('@g.us'),
                });
            }
        }
        if (messages && Array.isArray(messages)) {
            for (const msg of messages) {
                const remoteJid = msg.key?.remoteJid;
                if (!remoteJid || remoteJid === 'status@broadcast') continue;

                const text = extractMessageText(msg);
                const ts = extractTimestamp(msg.messageTimestamp) || 0;

                if (msg.pushName) {
                    const existingC = sessionData.contacts.get(remoteJid) || {};
                    sessionData.contacts.set(remoteJid, {
                        ...existingC,
                        id: remoteJid,
                        notify: msg.pushName || existingC.notify
                    });
                }

                const existingChat = sessionData.chats.get(remoteJid) || {};
                if (!existingChat.lastMessage || (ts && ts >= (existingChat.timestamp || 0))) {
                    sessionData.chats.set(remoteJid, {
                        ...existingChat,
                        id: remoteJid,
                        lastMessage: text || existingChat.lastMessage || '',
                        timestamp: ts || existingChat.timestamp || 0,
                        isGroup: remoteJid.endsWith('@g.us'),
                    });
                }
            }
        }

        saveSessionStore(sessionName);
        bumpChatRevision(sessionName);
        console.log(`[WA-Gateway] Synced ${sessionData.chats.size} chats and ${sessionData.contacts.size} contacts for ${sessionName}`);

        await notifyBackend(sessionName, 'chats-synced', {
            total_chats: sessionData.chats.size,
            total_contacts: sessionData.contacts.size
        });
    });

    // 2. Real-time contacts updates
    sock.ev.on('contacts.upsert', (newContacts) => {
        for (const c of newContacts) {
            if (!c.id) continue;
            const existing = sessionData.contacts.get(c.id) || {};
            sessionData.contacts.set(c.id, {
                ...existing,
                ...c,
                name: c.name || c.displayName || existing.name,
                notify: c.notify || existing.notify,
                verifiedName: c.verifiedName || existing.verifiedName,
            });
        }
        bumpChatRevision(sessionName);
        saveSessionStore(sessionName);
    });

    sock.ev.on('contacts.update', (updates) => {
        for (const update of updates) {
            if (!update.id) continue;
            const existing = sessionData.contacts.get(update.id) || {};
            sessionData.contacts.set(update.id, {
                ...existing,
                ...update,
                name: update.name || update.displayName || existing.name,
            });
        }
        bumpChatRevision(sessionName);
        saveSessionStore(sessionName);
    });

    // 3. Real-time chat list updates
    sock.ev.on('chats.upsert', (newChats) => {
        for (const chat of newChats) {
            if (!chat.id) continue;
            const existing = sessionData.chats.get(chat.id) || {};
            const ts = extractTimestamp(chat.conversationTimestamp || chat.lastMsgTimestamp) || existing.timestamp || 0;
            sessionData.chats.set(chat.id, {
                ...existing,
                ...chat,
                id: chat.id,
                name: chat.name || chat.displayName || existing.name,
                timestamp: ts || existing.timestamp || 0,
                isGroup: chat.id.endsWith('@g.us'),
            });
        }
        bumpChatRevision(sessionName);
        saveSessionStore(sessionName);
    });

    sock.ev.on('chats.update', (updates) => {
        for (const update of updates) {
            if (!update.id) continue;
            const existing = sessionData.chats.get(update.id) || {};
            const ts = extractTimestamp(update.conversationTimestamp || update.lastMsgTimestamp);
            sessionData.chats.set(update.id, {
                ...existing,
                ...update,
                name: update.name || update.displayName || existing.name,
                timestamp: ts || existing.timestamp || 0,
                unreadCount: update.unreadCount !== undefined ? Number(update.unreadCount) : existing.unreadCount,
            });
        }
        bumpChatRevision(sessionName);
        saveSessionStore(sessionName);
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

            // Fetch participating WhatsApp groups immediately
            try {
                const groups = await sock.groupFetchAllParticipating();
                if (groups && typeof groups === 'object') {
                    for (const [jid, grp] of Object.entries(groups)) {
                        const existing = sessionData.chats.get(jid) || {};
                        sessionData.chats.set(jid, {
                            ...existing,
                            id: jid,
                            name: grp.subject || existing.name,
                            isGroup: true,
                            timestamp: grp.creation || existing.timestamp || Math.floor(Date.now() / 1000),
                        });
                    }
                    console.log(`[WA-Gateway] Fetched ${Object.keys(groups).length} WhatsApp groups for ${sessionName}`);
                }
            } catch (gErr) {
                console.warn(`[WA-Gateway] groupFetchAllParticipating error for ${sessionName}:`, gErr.message);
            }

            // Resync app state collections (contacts, blocklists, chat updates)
            try {
                if (typeof sock.resyncAppState === 'function') {
                    await sock.resyncAppState(['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'], false);
                    console.log(`[WA-Gateway] Resynced app state for ${sessionName}`);
                }
            } catch (appStateErr) {
                console.warn(`[WA-Gateway] resyncAppState warning for ${sessionName}:`, appStateErr.message);
            }

            saveSessionStore(sessionName);
            bumpChatRevision(sessionName);

            if (!alreadyConnected) {
                await notifyBackend(sessionName, 'session-status', {
                    status: 'CONNECTED',
                    phone: sessionData.phone
                });
            }

            backupSessionAuth(sessionName);

            await notifyBackend(sessionName, 'chats-synced', {
                total_chats: sessionData.chats.size,
                total_contacts: sessionData.contacts.size
            });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            const isRestartRequired = statusCode === DisconnectReason.restartRequired;

            console.log(`[WA-Gateway] Session ${sessionName} closed. Status code: ${statusCode}, LoggedOut: ${isLoggedOut}, RestartRequired: ${isRestartRequired}`);

            // Ensure any keys generated during handshake are saved immediately before reconnect
            try {
                await saveCreds();
                backupSessionAuth(sessionName);
            } catch (e) {}

            // Detach listeners from closed socket to avoid memory leak / ghost events
            try {
                sock?.ev?.removeAllListeners();
            } catch (e) {}

            if (isLoggedOut) {
                sessionData.status = 'DISCONNECTED';
                sessionData.phone = null;
                sessionData.qr = null;
                sessionData.qrImage = null;
                sessionData.sock = null;

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
                const wasPairing = sessionData.status === 'SCAN_QR' || !sessionData.phone;
                // Fast 150ms reconnect on restartRequired to ensure mobile WhatsApp completes pairing on first attempt
                const reconnectDelay = isRestartRequired ? 150 : (wasPairing ? 250 : 2000);
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

    // Inbound & outbound messages (updates chat preview, unread count & timestamp instantly)
    sock.ev.on('messages.upsert', async ({ messages }) => {
        if (!messages || messages.length === 0) return;

        for (const msg of messages) {
            const remoteJid = msg.key?.remoteJid || '';
            if (!remoteJid || remoteJid === 'status@broadcast') continue;

            const isGroup = remoteJid.endsWith('@g.us');
            const fromMe = !!msg.key?.fromMe;

            const text = msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption ||
                (msg.message?.imageMessage ? '📷 Fotoğraf' : '') ||
                (msg.message?.documentMessage ? '📄 Belge' : '') ||
                (msg.message?.audioMessage ? '🎵 Ses' : '') ||
                '';

            const ts = typeof msg.messageTimestamp === 'number'
                ? msg.messageTimestamp
                : Math.floor(Date.now() / 1000);

            // Update in-memory chat immediately
            const existingChat = sessionData.chats.get(remoteJid) || {};
            const unreadDelta = (!fromMe && !existingChat.unreadCount) ? 1 : (existingChat.unreadCount || 0);

            sessionData.chats.set(remoteJid, {
                ...existingChat,
                id: remoteJid,
                lastMessage: text || existingChat.lastMessage || '',
                timestamp: ts,
                unreadCount: fromMe ? 0 : unreadDelta,
                isGroup,
            });
            bumpChatRevision(sessionName);

            // If pushName exists on message, update contact
            if (msg.pushName) {
                const existingContact = sessionData.contacts.get(remoteJid) || {};
                sessionData.contacts.set(remoteJid, {
                    ...existingContact,
                    id: remoteJid,
                    notify: msg.pushName,
                });
                bumpChatRevision(sessionName);
            }

            if (!fromMe && !isGroup && text) {
                const contactPhone = `+${remoteJid.split('@')[0]}`;
                await notifyBackend(sessionName, 'inbound', {
                    phone: contactPhone,
                    message: text,
                    wa_message_id: msg.key?.id,
                    timestamp: ts,
                    push_name: msg.pushName || null,
                });
            }
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
        chats: new Map(),
        contacts: new Map(),
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
    let pendingSession = null;
    const pendingInit = pendingInitializations.get(sessionName);
    pendingInitializations.delete(sessionName);
    if (pendingInit) {
        try {
            pendingSession = await Promise.race([
                pendingInit,
                new Promise(resolve => setTimeout(() => resolve(null), 1000))
            ]);
        } catch (e) {}
    }

    const session = activeSessions.get(sessionName) || pendingSession;
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

    const backupTimer = backupDebounceTimers.get(sessionName);
    if (backupTimer) clearTimeout(backupTimer);
    backupDebounceTimers.delete(sessionName);
    const storeTimer = storeDebounceTimers.get(sessionName);
    if (storeTimer) clearTimeout(storeTimer);
    storeDebounceTimers.delete(sessionName);

    activeSessions.delete(sessionName);

    const sessionAuthDir = path.join(SESSIONS_DIR, sessionName);
    try {
        if (fs.existsSync(sessionAuthDir)) {
            fs.rmSync(sessionAuthDir, { recursive: true, force: true });
        }
    } catch (e) {
        throw new Error(`Session files could not be deleted: ${e.message}`);
    }

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

    for (const sessionName of dirs) {
        if (activeSessions.has(sessionName)) continue;
        const credsPath = path.join(SESSIONS_DIR, sessionName, 'creds.json');
        if (fs.existsSync(credsPath)) {
            console.log(`[WA-Gateway] Auto-restoring saved session: ${sessionName}`);
            try {
                await getOrCreateSession(sessionName, false);
            } catch (e) {
                console.error(`[WA-Gateway] Failed to restore session ${sessionName}:`, e.message);
            }
        }
    }
}

/**
 * Forces a clean refresh of an un-connected session to provide a brand new QR code.
 */
async function refreshSessionQR(sessionName) {
    if (pendingInitializations.has(sessionName)) {
        return await pendingInitializations.get(sessionName);
    }

    const initPromise = (async () => {
        try {
            const existing = activeSessions.get(sessionName);
            if (existing) {
                if (existing.reconnectTimer) {
                    clearTimeout(existing.reconnectTimer);
                    existing.reconnectTimer = null;
                }
                try {
                    existing.sock?.ev?.removeAllListeners();
                    existing.sock?.end(undefined);
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
                    const timeout = setTimeout(resolve, 5000);
                    const onUpdate = async (update) => {
                        if (update.qr) {
                            session.status = 'SCAN_QR';
                            session.qr = update.qr;
                            if (!session.qrImage) {
                                try {
                                    session.qrImage = await QRCode.toDataURL(update.qr, {
                                        errorCorrectionLevel: 'L',
                                        margin: 2,
                                        scale: 6,
                                        color: { dark: '#000000', light: '#FFFFFF' }
                                    });
                                } catch (e) {}
                            }
                            clearTimeout(timeout);
                            session.sock?.ev?.off('connection.update', onUpdate);
                            resolve();
                        } else if (update.connection === 'open') {
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

/**
 * Builds a per-session revision counter that increments whenever chats/contacts mutate.
 * Used by the backend to cheaply detect deltas without transferring full payloads.
 */
function bumpChatRevision(sessionName) {
    const session = activeSessions.get(sessionName);
    if (session) {
        session.chatsRevision = (session.chatsRevision || 0) + 1;
    }
}

/**
 * Retrieves all synced chats with resolved contact names from memory and disk.
 */
async function getSessionChats(sessionName) {
    let session = activeSessions.get(sessionName);
    if (!session) {
        // Fallback 1: Case-insensitive and decoded lookup
        const cleanName = (sessionName || '').trim().toLowerCase();
        for (const [k, v] of activeSessions.entries()) {
            if (k.toLowerCase() === cleanName || decodeURIComponent(k).trim().toLowerCase() === cleanName) {
                session = v;
                sessionName = k;
                break;
            }
        }
    }
    if (!session) {
        const sessionAuthDir = path.join(SESSIONS_DIR, sessionName);
        if (fs.existsSync(sessionAuthDir)) {
            try {
                session = await getOrCreateSession(sessionName, false);
            } catch (e) {}
        }
    }
    if (!session) return [];

    // Merge persisted chats and contacts from disk store
    loadSessionStore(sessionName);

    // If still empty and socket is connected, fetch groups and resync app state immediately
    if ((!session.chats || session.chats.size === 0) && session.sock && session.status === 'CONNECTED') {
        try {
            const groups = await session.sock.groupFetchAllParticipating();
            if (groups && typeof groups === 'object') {
                for (const [jid, grp] of Object.entries(groups)) {
                    const existing = session.chats.get(jid) || {};
                    session.chats.set(jid, {
                        ...existing,
                        id: jid,
                        name: grp.subject || existing.name,
                        isGroup: true,
                        timestamp: grp.creation || existing.timestamp || Math.floor(Date.now() / 1000),
                    });
                }
            }
        } catch (e) {
            console.warn(`[WA-Gateway] On-demand group fetch failed:`, e.message);
        }

        try {
            if (typeof session.sock.resyncAppState === 'function') {
                await session.sock.resyncAppState(['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'], false);
            }
        } catch (e) {
            console.warn(`[WA-Gateway] On-demand app-state resync failed:`, e.message);
        }

        saveSessionStore(sessionName);
    }

    const chatsMap = session.chats || new Map();
    const contactsMap = session.contacts || new Map();

    // Union of all known chat JIDs and phonebook contacts
    const allJids = new Set([...chatsMap.keys(), ...contactsMap.keys()]);
    const result = [];

    for (const jid of allJids) {
        if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;

        const isGroup = jid.endsWith('@g.us');
        const chat = chatsMap.get(jid) || {};
        const contact = contactsMap.get(jid) || {};
        const rawPhone = jid.split('@')[0];
        const formattedPhone = isGroup ? jid : (rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`);

        // Resolve display name: Phonebook name -> Group subject -> Contact push name -> Formatted phone
        const resolvedName = contact.name ||
                             chat.name ||
                             contact.notify ||
                             contact.verifiedName ||
                             (isGroup ? 'WhatsApp Grubu' : formattedPhone);

        const lastMsg = typeof chat.lastMessage === 'string' ? chat.lastMessage : (chat.lastMessage?.text || '');
        const ts = chat.timestamp || (chat.conversationTimestamp ? extractTimestamp(chat.conversationTimestamp) : 0);

        result.push({
            id: jid,
            jid,
            phone: formattedPhone,
            name: resolvedName,
            push_name: contact.notify || null,
            pushName: contact.notify || null,
            is_group: isGroup,
            isGroup,
            unread_count: chat.unreadCount || 0,
            unreadCount: chat.unreadCount || 0,
            last_message: lastMsg,
            lastMessage: lastMsg,
            timestamp: ts || 0,
        });
    }

    // Sort reverse-chronological by timestamp (newest active chats first, exactly like WhatsApp Web)
    result.sort((a, b) => {
        if (b.timestamp !== a.timestamp) {
            return (b.timestamp || 0) - (a.timestamp || 0);
        }
        return (a.name || '').localeCompare(b.name || '');
    });
    return result;
}

/**
 * Returns only the chats changed since the caller's last revision (WhatsApp-Web-style delta).
 * Zero-lag design: pure in-memory scan, no disk or network I/O.
 * Returns { revision, changed } — changed is empty when the caller is already up to date.
 */
function getSessionChatsDelta(sessionName, sinceRevision) {
    let session = activeSessions.get(sessionName);
    if (!session) {
        const cleanName = (sessionName || '').trim().toLowerCase();
        for (const [k, v] of activeSessions.entries()) {
            if (k.toLowerCase() === cleanName || decodeURIComponent(k).trim().toLowerCase() === cleanName) {
                session = v;
                sessionName = k;
                break;
            }
        }
    }
    if (!session) {
        return { revision: 0, changed: [] };
    }

    const currentRevision = session.chatsRevision || 0;
    if (typeof sinceRevision === 'number' && sinceRevision === currentRevision) {
        return { revision: currentRevision, changed: [] };
    }

    const chatsMap = session.chats || new Map();
    const contactsMap = session.contacts || new Map();
    const changed = [];

    for (const jid of chatsMap.keys()) {
        if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
        const chat = chatsMap.get(jid) || {};
        const isGroup = jid.endsWith('@g.us');
        const rawPhone = jid.split('@')[0];
        const formattedPhone = isGroup ? jid : (rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`);
        const resolvedName = chat.name ||
            (contactsMap.get(jid) || {}).notify ||
            (isGroup ? 'WhatsApp Grubu' : formattedPhone);
        changed.push({
            id: jid,
            jid,
            phone: formattedPhone,
            name: resolvedName,
            is_group: isGroup,
            unread_count: chat.unreadCount || 0,
            last_message: typeof chat.lastMessage === 'string' ? chat.lastMessage : (chat.lastMessage?.text || ''),
            timestamp: chat.timestamp || 0,
        });
    }

    changed.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return { revision: currentRevision, changed };
}

module.exports = {
    activeSessions,
    getOrCreateSession,
    refreshSessionQR,
    requestPairingCode,
    sendMessage,
    disconnectSession,
    restoreSavedSessions,
    getSessionChats,
    getSessionChatsDelta,
    bumpChatRevision
};
