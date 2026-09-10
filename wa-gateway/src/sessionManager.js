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

// Global active sessions map: sessionKey / sessionName -> sessionData
const activeSessions = new Map();

/**
 * Formats a tenant identifier into the canonical folder name 'tenant_{user_id}'.
 */
function formatTenantDir(tenantId) {
    if (!tenantId) return 'tenant_default';
    const raw = String(tenantId).trim();
    return raw.startsWith('tenant_') ? raw : `tenant_${raw}`;
}

/**
 * Formats a session identifier into the canonical folder name 'session_{session_id}'.
 */
function formatSessionDir(sessionId) {
    if (!sessionId) return 'session_default';
    const raw = String(sessionId).trim();
    return raw.startsWith('session_') ? raw : `session_${raw}`;
}

/**
 * Returns the immutable canonical filesystem path:
 * sessions/tenant_{user_id}/session_{session_id}/
 */
function getCanonicalSessionPath(tenantId, sessionId) {
    const tDir = formatTenantDir(tenantId);
    const sDir = formatSessionDir(sessionId);
    return path.join(SESSIONS_DIR, tDir, sDir);
}

/**
 * Generates an in-memory composite unique session key:
 * 'tenant_{user_id}:session_{session_id}'
 */
function makeSessionKey(tenantId, sessionId) {
    return `${formatTenantDir(tenantId)}:${formatSessionDir(sessionId)}`;
}

/**
 * Classifies Baileys disconnect status code into actionable lifecycle decisions.
 */
function classifyDisconnectReason(statusCode) {
    const code = Number(statusCode);
    if (code === DisconnectReason.loggedOut) {
        return {
            isLoggedOut: true,
            canReconnect: false,
            reason: 'LOGGED_OUT',
            code: 401,
            description: 'WhatsApp session logged out from device'
        };
    }
    if (code === DisconnectReason.restartRequired) {
        return {
            isLoggedOut: false,
            canReconnect: true,
            reason: 'RESTART_REQUIRED',
            delayMs: 150,
            code: 515,
            description: 'Baileys stream restart required'
        };
    }
    if (code === DisconnectReason.timedOut || code === DisconnectReason.connectionLost) {
        return {
            isLoggedOut: false,
            canReconnect: true,
            reason: 'TIMED_OUT',
            delayMs: 2000,
            code: 408,
            description: 'Connection timed out or lost'
        };
    }
    if (code === DisconnectReason.connectionClosed) {
        return {
            isLoggedOut: false,
            canReconnect: true,
            reason: 'CONNECTION_CLOSED',
            delayMs: 2000,
            code: 428,
            description: 'Connection closed by remote'
        };
    }
    if (code === DisconnectReason.connectionReplaced) {
        return {
            isLoggedOut: true,
            canReconnect: false,
            reason: 'CONNECTION_REPLACED',
            code: 440,
            description: 'Connection replaced by another session'
        };
    }
    if (code === DisconnectReason.badSession) {
        return {
            isLoggedOut: false,
            canReconnect: false,
            reason: 'BAD_SESSION',
            delayMs: 5000,
            code: 500,
            description: 'Session corrupted or invalid'
        };
    }
    // Default network or unknown disconnect
    return {
        isLoggedOut: false,
        canReconnect: true,
        reason: 'NETWORK_DISCONNECT',
        delayMs: 2000,
        code: isNaN(code) ? 0 : code,
        description: 'Network disconnect or transport error'
    };
}

/**
 * Dual lookup: finds a session by composite key, tenant+session, or legacy name.
 */
function getSession(identifier) {
    if (!identifier) return null;
    if (typeof identifier === 'object') {
        const tenantId = identifier.tenantId;
        const sessionId = identifier.sessionId;
        const sessionName = identifier.sessionName || identifier.name;
        if (tenantId && sessionId) {
            const key = makeSessionKey(tenantId, sessionId);
            if (activeSessions.has(key)) return activeSessions.get(key);
        }
        if (sessionName && activeSessions.has(sessionName)) {
            return activeSessions.get(sessionName);
        }
    }
    if (typeof identifier === 'string') {
        if (activeSessions.has(identifier)) return activeSessions.get(identifier);
        const clean = identifier.trim().toLowerCase();
        for (const [k, v] of activeSessions.entries()) {
            if (k.toLowerCase() === clean || decodeURIComponent(k).trim().toLowerCase() === clean) {
                return v;
            }
            if (v.name && v.name.toLowerCase() === clean) {
                return v;
            }
            if (v.sessionId && String(v.sessionId).toLowerCase() === clean) {
                return v;
            }
        }
    }
    return null;
}

/**
 * Strictly finds a session belonging to a specific tenant.
 */
function findSession(tenantId, sessionId) {
    const key = makeSessionKey(tenantId, sessionId);
    return activeSessions.get(key) || null;
}


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

function isPhoneJid(jid) {
    return typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');
}

function isLidJid(jid) {
    return typeof jid === 'string' && jid.endsWith('@lid');
}

function recordLidPnMapping(sessionData, lid, pn) {
    if (!sessionData || !lid || !pn || lid === pn) return;
    const cleanLid = typeof lid === 'string' && lid.includes('@')
        ? (lid.endsWith('@lid') ? lid : `${lid.split('@')[0]}@lid`)
        : `${lid}@lid`;
    let cleanPn = typeof pn === 'string' && pn.includes('@')
        ? pn
        : `${String(pn).replace(/[^\d]/g, '')}@s.whatsapp.net`;
    if (cleanPn.includes(':')) {
        const user = cleanPn.split(':')[0];
        const domain = cleanPn.split('@')[1] || 's.whatsapp.net';
        cleanPn = `${user}@${domain}`;
    }
    if (!cleanPn.endsWith('@s.whatsapp.net') && !cleanPn.endsWith('@hosted')) return;

    if (!sessionData.lidToPnMap) sessionData.lidToPnMap = new Map();
    if (!sessionData.pnToLidMap) sessionData.pnToLidMap = new Map();

    sessionData.lidToPnMap.set(cleanLid, cleanPn);
    sessionData.pnToLidMap.set(cleanPn, cleanLid);
}

function findPnForLid(sessionData, lid) {
    if (!sessionData || !lid) return null;
    const cleanLid = lid.endsWith('@lid') ? lid : `${lid.split('@')[0]}@lid`;
    if (sessionData.lidToPnMap?.has(cleanLid)) {
        return sessionData.lidToPnMap.get(cleanLid);
    }
    if (sessionData.contacts) {
        for (const [cId, contact] of sessionData.contacts.entries()) {
            if (contact.lid === cleanLid || contact.id === cleanLid) {
                if (contact.phoneNumber) {
                    const pn = isPhoneJid(contact.phoneNumber)
                        ? contact.phoneNumber
                        : `${contact.phoneNumber.replace(/[^\d]/g, '')}@s.whatsapp.net`;
                    recordLidPnMapping(sessionData, cleanLid, pn);
                    return pn;
                }
                if (isPhoneJid(cId)) {
                    recordLidPnMapping(sessionData, cleanLid, cId);
                    return cId;
                }
            }
            if (contact.jidAliases && Array.isArray(contact.jidAliases) && contact.jidAliases.includes(cleanLid)) {
                if (isPhoneJid(cId)) {
                    recordLidPnMapping(sessionData, cleanLid, cId);
                    return cId;
                }
            }
        }
    }
    if (sessionData.chats) {
        for (const [chatId, chat] of sessionData.chats.entries()) {
            if (chat.jidAliases && Array.isArray(chat.jidAliases) && chat.jidAliases.includes(cleanLid)) {
                if (isPhoneJid(chatId)) {
                    recordLidPnMapping(sessionData, cleanLid, chatId);
                    return chatId;
                }
            }
        }
    }
    return null;
}

function resolveMessageJids(msg, sessionData = null) {
    const primary = msg?.key?.remoteJid || '';
    const alternate = msg?.key?.remoteJidAlt || '';
    if (primary.endsWith('@g.us')) {
        return { canonicalJid: primary, aliasJid: null };
    }
    if (isPhoneJid(primary)) {
        if (sessionData && alternate && alternate.endsWith('@lid')) {
            recordLidPnMapping(sessionData, alternate, primary);
        }
        const mappedLid = sessionData?.pnToLidMap?.get(primary);
        return { canonicalJid: primary, aliasJid: alternate || mappedLid || null };
    }
    if (isPhoneJid(alternate)) {
        if (sessionData && primary && primary.endsWith('@lid')) {
            recordLidPnMapping(sessionData, primary, alternate);
        }
        return { canonicalJid: alternate, aliasJid: primary || null };
    }
    if (primary.endsWith('@lid')) {
        const pn = sessionData ? findPnForLid(sessionData, primary) : null;
        if (pn) {
            return { canonicalJid: pn, aliasJid: primary };
        }
        return { canonicalJid: primary, aliasJid: alternate || null };
    }
    return { canonicalJid: primary, aliasJid: alternate || null };
}

async function resolveMessageJidsAsync(msg, sessionData = null) {
    const syncRes = resolveMessageJids(msg, sessionData);
    if (syncRes.canonicalJid.endsWith('@lid') && sessionData?.sock?.signalRepository?.lidMapping?.getPNForLID) {
        try {
            const rawPn = await sessionData.sock.signalRepository.lidMapping.getPNForLID(syncRes.canonicalJid);
            if (rawPn) {
                const user = rawPn.split(':')[0].split('@')[0];
                if (user && /^\d+$/.test(user)) {
                    const pn = `${user}@s.whatsapp.net`;
                    recordLidPnMapping(sessionData, syncRes.canonicalJid, pn);
                    return { canonicalJid: pn, aliasJid: syncRes.canonicalJid };
                }
            }
        } catch (e) {}
    }
    return syncRes;
}

function mergeJidAlias(sessionData, canonicalJid, aliasJid) {
    if (!canonicalJid || !aliasJid || canonicalJid === aliasJid) return;
    if (!sessionData) return;

    if (aliasJid.endsWith('@lid') && isPhoneJid(canonicalJid)) {
        recordLidPnMapping(sessionData, aliasJid, canonicalJid);
    } else if (canonicalJid.endsWith('@lid') && isPhoneJid(aliasJid)) {
        recordLidPnMapping(sessionData, canonicalJid, aliasJid);
    }

    if (!sessionData.chats) sessionData.chats = new Map();
    const canonicalChat = sessionData.chats.get(canonicalJid) || {};
    const aliasChat = sessionData.chats.get(aliasJid) || {};

    const canonicalTs = canonicalChat.timestamp || 0;
    const aliasTs = aliasChat.timestamp || 0;

    const mergedAliases = Array.from(new Set([
        ...(canonicalChat.jidAliases || []),
        ...(aliasChat.jidAliases || []),
        aliasJid,
    ]));

    sessionData.chats.set(canonicalJid, {
        ...aliasChat,
        ...canonicalChat,
        id: canonicalJid,
        name: canonicalChat.name || aliasChat.name,
        lastMessage: canonicalTs >= aliasTs
            ? (canonicalChat.lastMessage || aliasChat.lastMessage || '')
            : (aliasChat.lastMessage || canonicalChat.lastMessage || ''),
        timestamp: Math.max(canonicalTs, aliasTs),
        unreadCount: Math.max(canonicalChat.unreadCount || 0, aliasChat.unreadCount || 0),
        jidAliases: mergedAliases,
    });
    sessionData.chats.delete(aliasJid);

    if (!sessionData.contacts) sessionData.contacts = new Map();
    const canonicalContact = sessionData.contacts.get(canonicalJid) || {};
    const aliasContact = sessionData.contacts.get(aliasJid) || {};

    sessionData.contacts.set(canonicalJid, {
        ...aliasContact,
        ...canonicalContact,
        id: canonicalJid,
        name: canonicalContact.name || aliasContact.name,
        notify: canonicalContact.notify || aliasContact.notify,
        verifiedName: canonicalContact.verifiedName || aliasContact.verifiedName,
        jidAliases: Array.from(new Set([
            ...(canonicalContact.jidAliases || []),
            ...(aliasContact.jidAliases || []),
            aliasJid,
        ])),
    });
    sessionData.contacts.delete(aliasJid);
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

/**
 * Dispatches session lifecycle events to FastAPI backend without leaking credentials.
 */
async function notifyLifecycleEvent(sessionData, eventType, extra = {}) {
    const backendUrl = (process.env.BACKEND_URL || 'http://localhost:8000').replace(/\/$/, '');
    const webhookSecret = process.env.WA_GATEWAY_WEBHOOK_SECRET || 'dev-webhook-secret';

    const payload = {
        event: eventType, // SESSION_CREATED, QR_UPDATED, CONNECTED, DISCONNECTED, LOGGED_OUT, CONNECTION_ERROR
        tenant_id: sessionData?.tenantId ? String(sessionData.tenantId) : null,
        session_id: sessionData?.sessionId ? String(sessionData.sessionId) : null,
        session_name: sessionData?.name || null,
        status: sessionData?.status || 'DISCONNECTED',
        phone_number_e164: sessionData?.phone || null,
        qr_code: (eventType === 'QR_UPDATED') ? (sessionData?.qrImage || sessionData?.qr || null) : null,
        error_code: extra?.errorCode ?? null,
        error_message: extra?.errorMessage ?? null,
        timestamp: new Date().toISOString()
    };

    // Strict security invariant: Never leak credentials or auth bundle
    delete payload.auth;
    delete payload.creds;
    delete payload.keys;
    delete payload.auth_bundle;
    delete payload.sock;

    try {
        await axios.post(`${backendUrl}/api/v1/whatsapp/webhook/session-lifecycle`, payload, {
            headers: {
                'X-Webhook-Secret': webhookSecret,
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });
        console.log(`[WA-Gateway] Lifecycle event ${eventType} dispatched for ${sessionData?.name || sessionData?.key}`);
    } catch (err) {
        console.warn(`[WA-Gateway] Lifecycle webhook ${eventType} failed for ${sessionData?.name || sessionData?.key}:`, err.message);
    }

    // Keep legacy webhooks synchronized for zero-breakage with existing backend/frontend
    const sName = sessionData?.name || sessionData?.key;
    if (sName) {
        if (eventType === 'QR_UPDATED' && sessionData.qrImage) {
            notifyBackend(sName, 'session-qr', { qr_code: sessionData.qrImage }).catch(() => {});
        } else if (eventType === 'CONNECTED') {
            notifyBackend(sName, 'session-status', { status: 'CONNECTED', phone: sessionData.phone }).catch(() => {});
        } else if (eventType === 'DISCONNECTED' || eventType === 'LOGGED_OUT') {
            notifyBackend(sName, 'session-status', { status: 'DISCONNECTED', phone: null }).catch(() => {});
        }
    }
}

// Map of debounce timers for backing up auth files to DB
const backupDebounceTimers = new Map();

/**
 * Backs up all session credentials and keys to the database via webhook.
 */
function backupSessionAuth(sessionIdentifier) {
    const sName = typeof sessionIdentifier === 'string' ? sessionIdentifier : (sessionIdentifier?.name || sessionIdentifier?.key);
    if (!sName) return;
    if (backupDebounceTimers.has(sName)) {
        clearTimeout(backupDebounceTimers.get(sName));
    }
    const timer = setTimeout(async () => {
        backupDebounceTimers.delete(sName);
        try {
            const session = getSession(sessionIdentifier);
            const sessionAuthDir = session?.authDir || path.join(SESSIONS_DIR, sName);
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
                await notifyBackend(sName, 'session-backup', { auth_bundle: authBundle });
                console.log(`[WA-Gateway] Backed up ${Object.keys(authBundle).length} auth files to database for ${sName}`);
            }
        } catch (e) {
            console.warn(`[WA-Gateway] Auth backup failed for ${sName}:`, e.message);
        }
    }, 800);
    backupDebounceTimers.set(sName, timer);
}

// Map of debounce timers for saving chats/contacts store to disk
const storeDebounceTimers = new Map();

/**
 * Persists in-memory synced chats and contacts to disk and triggers DB backup.
 */
function saveSessionStore(sessionIdentifier) {
    const sName = typeof sessionIdentifier === 'string' ? sessionIdentifier : (sessionIdentifier?.name || sessionIdentifier?.key);
    if (!sName) return;
    if (storeDebounceTimers.has(sName)) {
        clearTimeout(storeDebounceTimers.get(sName));
    }
    const timer = setTimeout(() => {
        storeDebounceTimers.delete(sName);
        try {
            const session = getSession(sessionIdentifier);
            if (!session) return;
            const sessionAuthDir = session.authDir || path.join(SESSIONS_DIR, sName);
            if (!fs.existsSync(sessionAuthDir)) {
                fs.mkdirSync(sessionAuthDir, { recursive: true });
            }
            const storePath = path.join(sessionAuthDir, 'chats_store.json');
            const data = {
                chats: Array.from((session.chats || new Map()).entries()),
                contacts: Array.from((session.contacts || new Map()).entries()),
                lidToPn: Array.from((session.lidToPnMap || new Map()).entries()),
                pnToLid: Array.from((session.pnToLidMap || new Map()).entries()),
                updatedAt: Date.now()
            };
            fs.writeFileSync(storePath, JSON.stringify(data), 'utf8');
            // Trigger DB backup so chats_store.json is mirrored in database
            backupSessionAuth(sessionIdentifier);
        } catch (e) {
            console.warn(`[WA-Gateway] Failed to save chats_store for ${sName}:`, e.message);
        }
    }, 500);
    storeDebounceTimers.set(sName, timer);
}

/**
 * Loads chats and contacts from disk for the session if available.
 */
function loadSessionStore(sessionIdentifier) {
    const session = getSession(sessionIdentifier);
    if (!session) return;
    if (!session.chats) session.chats = new Map();
    if (!session.contacts) session.contacts = new Map();
    if (!session.lidToPnMap) session.lidToPnMap = new Map();
    if (!session.pnToLidMap) session.pnToLidMap = new Map();

    const sName = session.name || session.key;
    const sessionAuthDir = session.authDir || path.join(SESSIONS_DIR, sName);
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
        if (data.lidToPn && Array.isArray(data.lidToPn)) {
            for (const [k, v] of data.lidToPn) {
                if (!session.lidToPnMap.has(k)) {
                    session.lidToPnMap.set(k, v);
                }
            }
        }
        if (data.pnToLid && Array.isArray(data.pnToLid)) {
            for (const [k, v] of data.pnToLid) {
                if (!session.pnToLidMap.has(k)) {
                    session.pnToLidMap.set(k, v);
                }
            }
        }
        console.log(`[WA-Gateway] Restored ${session.chats.size} chats, ${session.contacts.size} contacts, ${session.lidToPnMap.size} LID mappings from disk for ${sName}`);
    } catch (e) {
        console.warn(`[WA-Gateway] Failed to load chats_store for ${sName}:`, e.message);
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
    const sessionName = sessionData.name || sessionData.key;
    const sessionAuthDir = sessionData.authDir || (
        sessionData.tenantId && sessionData.sessionId
            ? getCanonicalSessionPath(sessionData.tenantId, sessionData.sessionId)
            : path.join(SESSIONS_DIR, sessionName)
    );
    sessionData.authDir = sessionAuthDir;
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
    loadSessionStore(sessionData);

    // Listen to credentials update
    sock.ev.on('creds.update', async () => {
        try {
            await saveCreds();
            backupSessionAuth(sessionData);
        } catch (e) {
            console.warn(`[WA-Gateway] Failed to save creds for ${sessionName}:`, e.message);
        }
    });

    // 1. Initial bootstrap & history sync: captures all active chats and phonebook contacts
    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, lidPnMappings }) => {
        if (lidPnMappings && Array.isArray(lidPnMappings)) {
            for (const m of lidPnMappings) {
                if (m?.lid && m?.pn) {
                    recordLidPnMapping(sessionData, m.lid, m.pn);
                }
            }
        }

        if (contacts && Array.isArray(contacts)) {
            for (const c of contacts) {
                if (!c.id) continue;
                if (c.lid && c.phoneNumber) {
                    recordLidPnMapping(sessionData, c.lid, c.phoneNumber);
                } else if (c.lid && isPhoneJid(c.id)) {
                    recordLidPnMapping(sessionData, c.lid, c.id);
                } else if (c.phoneNumber && c.id.endsWith('@lid')) {
                    recordLidPnMapping(sessionData, c.id, c.phoneNumber);
                }

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
                const { canonicalJid: remoteJid, aliasJid } = await resolveMessageJidsAsync(msg, sessionData);
                if (!remoteJid || remoteJid === 'status@broadcast') continue;
                mergeJidAlias(sessionData, remoteJid, aliasJid);

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

    // 2. Real-time LID-PN mapping updates
    sock.ev.on('lid-mapping.update', (mapping) => {
        if (mapping?.lid && mapping?.pn) {
            recordLidPnMapping(sessionData, mapping.lid, mapping.pn);
            const canonical = isPhoneJid(mapping.pn) ? mapping.pn : (isPhoneJid(mapping.lid) ? mapping.lid : null);
            const alias = canonical === mapping.pn ? mapping.lid : mapping.pn;
            if (canonical && alias) {
                mergeJidAlias(sessionData, canonical, alias);
            }
            bumpChatRevision(sessionName);
            saveSessionStore(sessionName);
        }
    });

    // 3. Real-time contacts updates
    sock.ev.on('contacts.upsert', (newContacts) => {
        for (const c of newContacts) {
            if (!c.id) continue;
            if (c.lid && c.phoneNumber) {
                recordLidPnMapping(sessionData, c.lid, c.phoneNumber);
            } else if (c.lid && isPhoneJid(c.id)) {
                recordLidPnMapping(sessionData, c.lid, c.id);
            } else if (c.phoneNumber && c.id.endsWith('@lid')) {
                recordLidPnMapping(sessionData, c.id, c.phoneNumber);
            }
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
            if (update.lid && update.phoneNumber) {
                recordLidPnMapping(sessionData, update.lid, update.phoneNumber);
            }
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
            sessionData.status = 'QR_READY';
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
                await notifyLifecycleEvent(sessionData, 'QR_UPDATED');
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
            sessionData.phone = rawPhone ? (rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`) : null;

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

            saveSessionStore(sessionData);
            bumpChatRevision(sessionName);

            if (!alreadyConnected) {
                await notifyLifecycleEvent(sessionData, 'CONNECTED');
            }

            backupSessionAuth(sessionData);

            await notifyBackend(sessionName, 'chats-synced', {
                total_chats: sessionData.chats.size,
                total_contacts: sessionData.contacts.size
            });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const classification = classifyDisconnectReason(statusCode);

            console.log(`[WA-Gateway] Session ${sessionName} closed. Status code: ${statusCode}, Reason: ${classification.reason}`);

            // Detach listeners from closed socket to avoid memory leak / ghost events
            try {
                sock?.ev?.removeAllListeners();
            } catch (e) {}

            if (classification.isLoggedOut) {
                sessionData.status = 'LOGGED_OUT';
                sessionData.phone = null;
                sessionData.qr = null;
                sessionData.qrImage = null;
                sessionData.sock = null;

                if (sessionData.reconnectTimer) {
                    clearTimeout(sessionData.reconnectTimer);
                    sessionData.reconnectTimer = null;
                }

                try {
                    if (fs.existsSync(sessionAuthDir)) {
                        fs.rmSync(sessionAuthDir, { recursive: true, force: true });
                    }
                } catch (e) {
                    console.warn(`[WA-Gateway] Could not delete auth dir for ${sessionName}:`, e);
                }

                if (sessionData.key) activeSessions.delete(sessionData.key);
                if (sessionData.name && sessionData.name !== sessionData.key) {
                    activeSessions.delete(sessionData.name);
                }

                await notifyLifecycleEvent(sessionData, 'LOGGED_OUT', {
                    errorCode: statusCode || 401,
                    errorMessage: classification.description
                });
            } else {
                // Ensure any keys generated during handshake are saved immediately before reconnect
                try {
                    await saveCreds();
                    backupSessionAuth(sessionData);
                } catch (e) {}

                sessionData.status = 'DISCONNECTED';

                await notifyLifecycleEvent(sessionData, 'DISCONNECTED', {
                    errorCode: statusCode || 0,
                    errorMessage: classification.description
                });

                if (classification.canReconnect) {
                    const wasPairing = !sessionData.phone;
                    const reconnectDelay = classification.delayMs || (wasPairing ? 250 : 2000);
                    console.log(`[WA-Gateway] Reconnecting session ${sessionName} in ${reconnectDelay}ms (reason: ${classification.reason})...`);

                    if (sessionData.reconnectTimer) {
                        clearTimeout(sessionData.reconnectTimer);
                    }
                    sessionData.reconnectTimer = setTimeout(() => {
                        sessionData.reconnectTimer = null;
                        sessionData.status = 'CONNECTING';
                        initSessionSocket(sessionData).catch(err => {
                            console.error(`[WA-Gateway] Reconnect failed for ${sessionName}:`, err.message);
                            notifyLifecycleEvent(sessionData, 'CONNECTION_ERROR', {
                                errorCode: 500,
                                errorMessage: err.message
                            }).catch(() => {});
                        });
                    }, reconnectDelay);
                }
            }
        }
    });

    // Inbound & outbound messages (updates chat preview, unread count & timestamp instantly)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (!messages || messages.length === 0) return;
        if (!sessionData.processedMsgIds) sessionData.processedMsgIds = new Set();

        for (const msg of messages) {
            if (!msg || typeof msg !== 'object') continue;
            const { canonicalJid: remoteJid, aliasJid } = await resolveMessageJidsAsync(msg, sessionData);
            if (!remoteJid || remoteJid === 'status@broadcast') continue;
            mergeJidAlias(sessionData, remoteJid, aliasJid);

            const isGroup = remoteJid.endsWith('@g.us');
            const fromMe = !!msg.key?.fromMe;
            const msgId = msg.key?.id;

            // Unwrap message containers (ephemeral, viewOnce, documentWithCaption, etc.)
            const actualMessage = msg.message?.ephemeralMessage?.message ||
                msg.message?.viewOnceMessage?.message ||
                msg.message?.viewOnceMessageV2?.message ||
                msg.message?.documentWithCaptionMessage?.message ||
                msg.message;

            let text = '';
            let messageType = 'TEXT';

            if (actualMessage?.conversation) {
                text = actualMessage.conversation;
                messageType = 'TEXT';
            } else if (actualMessage?.extendedTextMessage?.text) {
                text = actualMessage.extendedTextMessage.text;
                messageType = 'TEXT';
            } else if (actualMessage?.imageMessage) {
                text = actualMessage.imageMessage.caption || '📷 Fotoğraf';
                messageType = 'IMAGE';
            } else if (actualMessage?.videoMessage) {
                text = actualMessage.videoMessage.caption || '🎥 Video';
                messageType = 'VIDEO';
            } else if (actualMessage?.audioMessage) {
                text = '🎵 Ses';
                messageType = 'AUDIO';
            } else if (actualMessage?.documentMessage) {
                text = actualMessage.documentMessage.caption || actualMessage.documentMessage.fileName || '📄 Belge';
                messageType = 'DOCUMENT';
            } else if (actualMessage?.stickerMessage) {
                text = '🏷️ Çıkartma';
                messageType = 'STICKER';
            } else if (actualMessage?.locationMessage) {
                text = '📍 Konum';
                messageType = 'LOCATION';
            } else if (actualMessage?.contactMessage || actualMessage?.contactsArrayMessage) {
                text = '👤 Kişi Kartı';
                messageType = 'CONTACT';
            } else if (actualMessage?.reactionMessage) {
                // Ignore reaction events here
                continue;
            } else if (actualMessage) {
                messageType = 'OTHER';
                text = '';
            }

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

            // Only notify backend for live incoming customer messages:
            // 1. Not from me (never treat our sent messages as customer inbound)
            // 2. Not group chats (1:1 personal chats)
            // 3. Either type is 'notify' or unspecified (skip 'append' background history sync)
            // 4. Must not have already been processed in this session lifecycle
            const isLiveInbound = !fromMe && !isGroup && (type === 'notify' || !type);
            if (isLiveInbound && (text || messageType !== 'OTHER')) {
                if (msgId && sessionData.processedMsgIds.has(msgId)) {
                    continue;
                }
                if (msgId) {
                    sessionData.processedMsgIds.add(msgId);
                    if (sessionData.processedMsgIds.size > 1000) {
                        const oldest = sessionData.processedMsgIds.values().next().value;
                        sessionData.processedMsgIds.delete(oldest);
                    }
                }

                const isLid = remoteJid.endsWith('@lid');
                const rawUser = remoteJid.split('@')[0];
                const contactPhone = isLid ? null : (rawUser.startsWith('+') ? rawUser : `+${rawUser}`);

                await notifyBackend(sessionName, 'inbound', {
                    tenant_id: sessionData?.tenantId ? String(sessionData.tenantId) : null,
                    session_id: sessionData?.sessionId ? String(sessionData.sessionId) : null,
                    session_name: sessionData?.name || sessionName,
                    phone: contactPhone,
                    wa_jid: remoteJid,
                    lid: aliasJid || (isLid ? remoteJid : null),
                    message: text,
                    message_type: messageType,
                    wa_message_id: msgId,
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
 * Supports both legacy (sessionName) and canonical ({ tenantId, sessionId, sessionName }) calls.
 * Ensures duplicate connect calls are idempotent and prevents parallel duplicate sockets.
 */
async function getOrCreateSession(param, forceNewSocket = false) {
    let tenantId = null;
    let sessionId = null;
    let sessionName = null;
    let force = forceNewSocket;

    if (typeof param === 'object' && param !== null) {
        tenantId = param.tenantId || null;
        sessionId = param.sessionId || null;
        sessionName = param.sessionName || param.name || null;
        if (param.forceNewSocket !== undefined) {
            force = param.forceNewSocket;
        }
    } else {
        sessionName = String(param);
        if (sessionName.includes(':')) {
            const parts = sessionName.split(':');
            tenantId = parts[0];
            sessionId = parts[1];
        }
    }

    if (!sessionName && sessionId) {
        sessionName = `session_${sessionId}`;
    }

    const sessionKey = (tenantId && sessionId)
        ? makeSessionKey(tenantId, sessionId)
        : (sessionName || 'default');

    // Concurrency lock: Return existing in-flight initialization promise
    if (pendingInitializations.has(sessionKey)) {
        return await pendingInitializations.get(sessionKey);
    }

    // Check existing in-memory active session
    let sessionData = activeSessions.get(sessionKey) || (sessionName ? activeSessions.get(sessionName) : null);

    if (sessionData) {
        if (!force && sessionData.sock && sessionData.status === 'CONNECTED') {
            return sessionData;
        }
        if (!force && sessionData.status === 'CONNECTING' && sessionData.reconnectTimer) {
            return sessionData;
        }
        await initSessionSocket(sessionData);
        return sessionData;
    }

    const canonicalAuthDir = (tenantId && sessionId)
        ? getCanonicalSessionPath(tenantId, sessionId)
        : path.join(SESSIONS_DIR, sessionName);

    sessionData = {
        key: sessionKey,
        tenantId: tenantId ? String(tenantId).replace(/^tenant_/, '') : null,
        sessionId: sessionId ? String(sessionId).replace(/^session_/, '') : null,
        name: sessionName,
        authDir: canonicalAuthDir,
        status: 'CREATED',
        phone: null,
        qr: null,
        qrImage: null,
        sock: null,
        chats: new Map(),
        contacts: new Map(),
        lidToPnMap: new Map(),
        pnToLidMap: new Map(),
        createdAt: new Date().toISOString(),
        messagesSent: 0,
        reconnectTimer: null
    };

    activeSessions.set(sessionKey, sessionData);
    if (sessionName && sessionName !== sessionKey) {
        activeSessions.set(sessionName, sessionData);
    }

    const initPromise = (async () => {
        try {
            await notifyLifecycleEvent(sessionData, 'SESSION_CREATED');
            sessionData.status = 'CONNECTING';
            await initSessionSocket(sessionData);
            return sessionData;
        } finally {
            pendingInitializations.delete(sessionKey);
        }
    })();

    pendingInitializations.set(sessionKey, initPromise);
    return await initPromise;
}

// Bounded LRU-style idempotency cache for outbound messages
const sentMessagesIdempotencyCache = new Map();
const MAX_SENT_CACHE_SIZE = 2000;

/**
 * Dispatches an outbound WhatsApp message through an active session socket.
 * Supports composite tenant+session identifiers, rejects group messages fail-closed,
 * validates payload, and provides client_message_id idempotency.
 */
async function sendMessage(sessionIdentifier, phone, messageText, typingDelayMs = 0, clientMessageId = null) {
    if (clientMessageId && sentMessagesIdempotencyCache.has(clientMessageId)) {
        return sentMessagesIdempotencyCache.get(clientMessageId);
    }

    if (!phone || typeof phone !== 'string' || !phone.trim()) {
        throw new Error('Alıcı telefon numarası zorunludur.');
    }

    if (phone.endsWith('@g.us')) {
        throw new Error('Grup mesajları bu fazda desteklenmemektedir.');
    }

    const cleanDigits = phone.replace(/[^\d]/g, '');
    if (!cleanDigits || cleanDigits.length < 7) {
        throw new Error('Geçersiz alıcı telefon numarası.');
    }

    if (!messageText || typeof messageText !== 'string' || !messageText.trim()) {
        throw new Error('Mesaj metni boş olamaz.');
    }

    let session = getSession(sessionIdentifier);
    const displayName = typeof sessionIdentifier === 'object' && sessionIdentifier !== null
        ? (sessionIdentifier.sessionName || `tenant_${sessionIdentifier.tenantId}:session_${sessionIdentifier.sessionId}`)
        : String(sessionIdentifier);

    if (!session || session.status !== 'CONNECTED' || !session.sock) {
        const sDir = session?.authDir || path.join(SESSIONS_DIR, displayName);
        const credsPath = path.join(sDir, 'creds.json');
        let hasCreds = fs.existsSync(credsPath);
        if (!hasCreds && typeof sessionIdentifier === 'string') {
            hasCreds = await restoreSessionFromDatabase(sessionIdentifier);
        }
        if (hasCreds) {
            session = await getOrCreateSession(sessionIdentifier);
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
        throw new Error(`WhatsApp hattı bağlı değil (Oturum: ${displayName}, Durum: ${session ? session.status : 'BULUNAMADI'})`);
    }

    const jid = `${cleanDigits}@s.whatsapp.net`;

    if (typingDelayMs > 0) {
        try {
            await session.sock.sendPresenceUpdate('composing', jid);
            const delay = Math.min(typingDelayMs, 8000);
            await new Promise(resolve => setTimeout(resolve, delay));
            await session.sock.sendPresenceUpdate('paused', jid);
        } catch (e) {}
    }

    const sent = await session.sock.sendMessage(jid, { text: messageText.trim() });
    session.messagesSent = (session.messagesSent || 0) + 1;

    const result = {
        success: true,
        messageId: sent.key.id,
        phone: phone,
        status: 'SENT',
        timestamp: new Date().toISOString()
    };

    if (clientMessageId) {
        if (sentMessagesIdempotencyCache.size >= MAX_SENT_CACHE_SIZE) {
            const firstKey = sentMessagesIdempotencyCache.keys().next().value;
            sentMessagesIdempotencyCache.delete(firstKey);
        }
        sentMessagesIdempotencyCache.set(clientMessageId, result);
    }

    return result;
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
 * Disconnects and purges a session cleanly.
 * Invariant: LOGGED_OUT purges credentials and stops reconnect.
 */
async function disconnectSession(identifier) {
    let session = getSession(identifier);
    let sessionKey = typeof identifier === 'string' ? identifier : null;

    if (!session && typeof identifier === 'object' && identifier !== null) {
        if (identifier.tenantId && identifier.sessionId) {
            sessionKey = makeSessionKey(identifier.tenantId, identifier.sessionId);
        } else {
            sessionKey = identifier.sessionName || identifier.name;
        }
        session = activeSessions.get(sessionKey);
    }

    if (sessionKey && pendingInitializations.has(sessionKey)) {
        try {
            await Promise.race([
                pendingInitializations.get(sessionKey),
                new Promise(resolve => setTimeout(resolve, 1000))
            ]);
        } catch (e) {}
        pendingInitializations.delete(sessionKey);
    }

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
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Logout timeout')), 1000))
                ]);
            } catch (e) {
                try {
                    session.sock.end(undefined);
                } catch (err) {}
            }
            session.sock = null;
        }

        session.status = 'LOGGED_OUT';
        session.phone = null;
        session.qr = null;
        session.qrImage = null;

        await notifyLifecycleEvent(session, 'LOGGED_OUT', {
            errorCode: 401,
            errorMessage: 'Session manually disconnected'
        });

        const sKey = session.key;
        const sName = session.name;

        if (sKey) {
            const bTimer = backupDebounceTimers.get(sKey);
            if (bTimer) clearTimeout(bTimer);
            backupDebounceTimers.delete(sKey);
            const stTimer = storeDebounceTimers.get(sKey);
            if (stTimer) clearTimeout(stTimer);
            storeDebounceTimers.delete(sKey);
            activeSessions.delete(sKey);
        }
        if (sName && sName !== sKey) {
            const bTimer = backupDebounceTimers.get(sName);
            if (bTimer) clearTimeout(bTimer);
            backupDebounceTimers.delete(sName);
            const stTimer = storeDebounceTimers.get(sName);
            if (stTimer) clearTimeout(stTimer);
            storeDebounceTimers.delete(sName);
            activeSessions.delete(sName);
        }

        const authDir = session.authDir;
        if (authDir && fs.existsSync(authDir)) {
            try {
                fs.rmSync(authDir, { recursive: true, force: true });
            } catch (e) {
                console.warn(`[WA-Gateway] Could not delete auth dir for ${sName || sKey}:`, e.message);
            }
        }

        return { success: true, message: `Session ${sName || sKey} disconnected and purged` };
    }

    // Fallback: If session not in memory, try to purge directory if path exists
    if (typeof identifier === 'string') {
        const legacyDir = path.join(SESSIONS_DIR, identifier);
        if (fs.existsSync(legacyDir)) {
            try {
                fs.rmSync(legacyDir, { recursive: true, force: true });
                return { success: true, message: `Session directory ${identifier} deleted` };
            } catch (e) {
                throw new Error(`Session files could not be deleted: ${e.message}`);
            }
        }
    }

    return { success: true, message: 'Session already disconnected or not found' };
}

/**
 * Restores previously paired sessions on server startup from database backup and local disk.
 * Canonical path: sessions/tenant_{user_id}/session_{session_id}/creds.json
 * Legacy path: sessions/{sessionName}/creds.json
 */
async function restoreSavedSessions() {
    // Pre-warm version cache in background
    getCachedBaileysVersion().catch(() => {});

    await restoreAllSessionsFromDatabase();

    if (!fs.existsSync(SESSIONS_DIR)) return;

    let topEntries = [];
    try {
        topEntries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory());
    } catch (e) {
        return;
    }

    for (const entry of topEntries) {
        const topName = entry.name;
        const topPath = path.join(SESSIONS_DIR, topName);

        if (topName.startsWith('tenant_')) {
            const tenantId = topName.replace(/^tenant_/, '');
            let subEntries = [];
            try {
                subEntries = fs.readdirSync(topPath, { withFileTypes: true })
                    .filter(dirent => dirent.isDirectory());
            } catch (e) {}

            for (const sub of subEntries) {
                const subName = sub.name;
                const sessionId = subName.replace(/^session_/, '');
                const sessionDir = path.join(topPath, subName);
                const credsPath = path.join(sessionDir, 'creds.json');

                const sessionKey = makeSessionKey(tenantId, sessionId);
                if (activeSessions.has(sessionKey)) continue;

                if (fs.existsSync(credsPath)) {
                    let isValidCreds = false;
                    try {
                        const raw = fs.readFileSync(credsPath, 'utf8');
                        const parsed = JSON.parse(raw);
                        isValidCreds = Boolean(parsed && (parsed.registered || parsed.me || parsed.noiseKey));
                    } catch (err) {
                        console.warn(`[WA-Gateway] Corrupted creds.json found at ${sessionDir}, skipping restore:`, err.message);
                        continue;
                    }

                    if (isValidCreds) {
                        console.log(`[WA-Gateway] Auto-restoring saved session: ${sessionKey}`);
                        try {
                            await getOrCreateSession({
                                tenantId,
                                sessionId,
                                sessionName: `session_${sessionId}`,
                                forceNewSocket: false
                            });
                        } catch (e) {
                            console.error(`[WA-Gateway] Failed to restore session ${sessionKey}:`, e.message);
                        }
                    }
                }
            }
        } else {
            // Legacy flat directory (e.g. sessions/Line 1/creds.json)
            const sessionName = topName;
            if (activeSessions.has(sessionName)) continue;
            const credsPath = path.join(topPath, 'creds.json');
            if (fs.existsSync(credsPath)) {
                let isValidCreds = false;
                try {
                    const raw = fs.readFileSync(credsPath, 'utf8');
                    const parsed = JSON.parse(raw);
                    isValidCreds = Boolean(parsed && (parsed.registered || parsed.me || parsed.noiseKey));
                } catch (err) {
                    console.warn(`[WA-Gateway] Corrupted legacy creds.json found at ${topPath}, skipping restore:`, err.message);
                    continue;
                }

                if (isValidCreds) {
                    console.log(`[WA-Gateway] Auto-restoring legacy saved session: ${sessionName}`);
                    try {
                        await getOrCreateSession(sessionName, false);
                    } catch (e) {
                        console.error(`[WA-Gateway] Failed to restore legacy session ${sessionName}:`, e.message);
                    }
                }
            }
        }
    }
}

/**
 * Gracefully shuts down all active sessions, canceling reconnect timers and socket connections.
 */
async function shutdownAllSessions() {
    console.log(`[WA-Gateway] Gracefully shutting down ${activeSessions.size} active sessions...`);
    for (const [key, session] of activeSessions.entries()) {
        try {
            if (session.reconnectTimer) {
                clearTimeout(session.reconnectTimer);
                session.reconnectTimer = null;
            }
            if (session.sock) {
                try {
                    session.sock.ev?.removeAllListeners();
                } catch (e) {}
                try {
                    session.sock.end(undefined);
                } catch (e) {}
                session.sock = null;
            }
            session.status = 'DISCONNECTED';
        } catch (err) {
            console.warn(`[WA-Gateway] Error shutting down session ${key}:`, err.message);
        }
    }
    activeSessions.clear();
    pendingInitializations.clear();
    console.log('[WA-Gateway] All sessions shut down cleanly.');
}

/**
 * Forces a clean refresh of an un-connected session to provide a brand new QR code.
 * Replaces old QR without changing the session identity or storage path.
 */
async function refreshSessionQR(param) {
    let tenantId = null;
    let sessionId = null;
    let sessionName = null;

    if (typeof param === 'object' && param !== null) {
        tenantId = param.tenantId || null;
        sessionId = param.sessionId || null;
        sessionName = param.sessionName || param.name || null;
    } else {
        sessionName = String(param);
        if (sessionName.includes(':')) {
            const parts = sessionName.split(':');
            tenantId = parts[0];
            sessionId = parts[1];
        }
    }

    const sessionKey = (tenantId && sessionId)
        ? makeSessionKey(tenantId, sessionId)
        : (sessionName || 'default');

    if (pendingInitializations.has(sessionKey)) {
        return await pendingInitializations.get(sessionKey);
    }

    const initPromise = (async () => {
        try {
            const existing = activeSessions.get(sessionKey) || (sessionName ? activeSessions.get(sessionName) : null);
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

            const sessionAuthDir = existing?.authDir || (
                (tenantId && sessionId)
                    ? getCanonicalSessionPath(tenantId, sessionId)
                    : path.join(SESSIONS_DIR, sessionName || sessionKey)
            );

            const credsPath = path.join(sessionAuthDir, 'creds.json');
            let hasPairedCreds = false;
            if (fs.existsSync(credsPath)) {
                try {
                    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                    hasPairedCreds = !!(creds.registered || creds.me);
                } catch (e) {}
            }

            // If not yet paired, wipe un-paired handshake keys to get a fresh QR
            if (!hasPairedCreds && fs.existsSync(sessionAuthDir)) {
                try {
                    fs.rmSync(sessionAuthDir, { recursive: true, force: true });
                } catch (e) {}
            }

            const session = await getOrCreateSession({
                tenantId,
                sessionId,
                sessionName,
                forceNewSocket: true
            });

            if (!session.qrImage && session.status !== 'CONNECTED') {
                await new Promise((resolve) => {
                    const timeout = setTimeout(resolve, 6000);
                    const onUpdate = async (update) => {
                        if (update.qr) {
                            session.status = 'QR_READY';
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
            pendingInitializations.delete(sessionKey);
        }
    })();

    pendingInitializations.set(sessionKey, initPromise);
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

    // First, consolidate any pending LID chats that now have PN mappings
    for (const [jid, chat] of Array.from((session.chats || new Map()).entries())) {
        if (jid.endsWith('@lid')) {
            let pn = findPnForLid(session, jid);
            if (!pn && session.sock?.signalRepository?.lidMapping?.getPNForLID) {
                try {
                    const rawPn = await session.sock.signalRepository.lidMapping.getPNForLID(jid);
                    if (rawPn) {
                        const user = rawPn.split(':')[0].split('@')[0];
                        if (user && /^\d+$/.test(user)) {
                            pn = `${user}@s.whatsapp.net`;
                            recordLidPnMapping(session, jid, pn);
                        }
                    }
                } catch (e) {}
            }
            if (pn) {
                mergeJidAlias(session, pn, jid);
            }
        }
    }

    const chatsMap = session.chats || new Map();
    const contactsMap = session.contacts || new Map();

    // Union of all known chat JIDs and phonebook contacts, skipping LIDs aliased to existing phone chats
    const allJids = new Set();
    for (const jid of [...chatsMap.keys(), ...contactsMap.keys()]) {
        if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
        if (jid.endsWith('@lid')) {
            const mappedPn = findPnForLid(session, jid);
            if (mappedPn && (chatsMap.has(mappedPn) || contactsMap.has(mappedPn))) {
                continue;
            }
        }
        allJids.add(jid);
    }

    const result = [];

    for (const jid of allJids) {
        const isGroup = jid.endsWith('@g.us');
        const isLid = jid.endsWith('@lid');
        const chat = chatsMap.get(jid) || {};
        const contact = contactsMap.get(jid) || {};
        const rawPhone = jid.split('@')[0];
        const formattedPhone = isGroup ? jid : (isLid ? null : (rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`));

        // Resolve display name: Phonebook name -> Group subject -> Contact push name -> Formatted phone / Fallback
        const resolvedName = contact.name ||
                             chat.name ||
                             contact.notify ||
                             contact.verifiedName ||
                             (isGroup ? 'WhatsApp Grubu' : (formattedPhone || contact.notify || 'WhatsApp Kişisi'));

        const lastMsg = typeof chat.lastMessage === 'string' ? chat.lastMessage : (chat.lastMessage?.text || '');
        const ts = chat.timestamp || (chat.conversationTimestamp ? extractTimestamp(chat.conversationTimestamp) : 0);

        const aliases = new Set([
            ...(chat.jidAliases || []),
            ...(contact.jidAliases || []),
        ]);
        const mappedLid = session.pnToLidMap?.get(jid);
        if (mappedLid) aliases.add(mappedLid);
        if (contact.lid) aliases.add(contact.lid);

        result.push({
            id: jid,
            jid,
            phone: formattedPhone,
            is_lid: isLid,
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
            jid_aliases: Array.from(aliases),
            jidAliases: Array.from(aliases),
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
        if (jid.endsWith('@lid')) {
            const mappedPn = findPnForLid(session, jid);
            if (mappedPn && chatsMap.has(mappedPn)) {
                continue;
            }
        }
        const chat = chatsMap.get(jid) || {};
        const contact = contactsMap.get(jid) || {};
        const isGroup = jid.endsWith('@g.us');
        const isLid = jid.endsWith('@lid');
        const rawPhone = jid.split('@')[0];
        const formattedPhone = isGroup ? jid : (isLid ? null : (rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`));
        const resolvedName = contact.name ||
            chat.name ||
            contact.notify ||
            (isGroup ? 'WhatsApp Grubu' : (formattedPhone || contact.notify || 'WhatsApp Kişisi'));

        const aliases = new Set([
            ...(chat.jidAliases || []),
            ...(contact.jidAliases || []),
        ]);
        const mappedLid = session.pnToLidMap?.get(jid);
        if (mappedLid) aliases.add(mappedLid);
        if (contact.lid) aliases.add(contact.lid);

        changed.push({
            id: jid,
            jid,
            phone: formattedPhone,
            is_lid: isLid,
            name: resolvedName,
            is_group: isGroup,
            unread_count: chat.unreadCount || 0,
            last_message: typeof chat.lastMessage === 'string' ? chat.lastMessage : (chat.lastMessage?.text || ''),
            timestamp: chat.timestamp || 0,
            jid_aliases: Array.from(aliases),
        });
    }

    changed.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return { revision: currentRevision, changed };
}

module.exports = {
    activeSessions,
    formatTenantDir,
    formatSessionDir,
    getCanonicalSessionPath,
    makeSessionKey,
    classifyDisconnectReason,
    notifyLifecycleEvent,
    findSession,
    getSession,
    getOrCreateSession,
    refreshSessionQR,
    requestPairingCode,
    sendMessage,
    disconnectSession,
    restoreSavedSessions,
    shutdownAllSessions,
    getSessionChats,
    getSessionChatsDelta,
    bumpChatRevision,
    resolveMessageJids,
    resolveMessageJidsAsync,
    mergeJidAlias,
    recordLidPnMapping,
    findPnForLid
};
