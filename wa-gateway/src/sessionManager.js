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
    jidNormalizedUser
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
            console.log(`[WA-Gateway] Restored ${Object.keys(res.data.auth_bundle).length} auth files from database for ${sessionName}`);
            return true;
        }
    } catch (e) {
        // Not found or network error
    }
    return false;
}

/**
 * Restores all active sessions backed up in the database.
 */
async function restoreAllSessionsFromDatabase() {
    const backendUrl = (process.env.BACKEND_URL || 'http://localhost:8000').replace(/\/$/, '');
    const webhookSecret = process.env.WA_GATEWAY_WEBHOOK_SECRET || 'dev-webhook-secret';
    try {
        const res = await axios.get(`${backendUrl}/api/v1/whatsapp/webhook/session-restore-all`, {
            headers: { 'X-Webhook-Secret': webhookSecret },
            timeout: 6000
        });
        if (Array.isArray(res.data) && res.data.length > 0) {
            for (const item of res.data) {
                const sName = item.session_name;
                const bundle = item.auth_bundle;
                if (!sName || !bundle) continue;
                const dir = path.join(SESSIONS_DIR, sName);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                for (const [file, content] of Object.entries(bundle)) {
                    fs.writeFileSync(path.join(dir, file), content, 'utf8');
                }
                console.log(`[WA-Gateway] Restored session files for ${sName} from database (${Object.keys(bundle).length} files)`);
                await getOrCreateSession(sName).catch(err => {
                    console.warn(`[WA-Gateway] Auto-start restored session ${sName} failed:`, err.message);
                });
            }
        }
    } catch (e) {
        console.warn(`[WA-Gateway] Failed to restore sessions from database:`, e.message);
    }
}


/**
 * Safely converts Baileys Long objects, milliseconds or number timestamps to Unix epoch seconds.
 */
function toUnixTimestamp(ts) {
    if (!ts) return 0;
    if (typeof ts === 'object' && ts.low !== undefined) {
        return Number(ts.low);
    }
    if (typeof ts === 'number') {
        return ts > 1e11 ? Math.floor(ts / 1000) : ts;
    }
    const n = Number(ts);
    return isNaN(n) ? 0 : (n > 1e11 ? Math.floor(n / 1000) : n);
}

/**
 * Validates if JID is a supported WhatsApp contact or group chat.
 * NOTE: @lid (Linked Identity) JIDs are accepted too — modern WhatsApp
 * addresses group authors (and sometimes DMs) by LID instead of phone.
 * Dropping them loses messages; fabricating +<lid> as a phone corrupts data.
 * LID senders are resolved to phone (PN) via resolveParticipantPN().
 */
function isSupportedJid(jid) {
    if (!jid || typeof jid !== 'string') return false;
    return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@g.us') || jid.endsWith('@lid');
}

function isLidJid(jid) {
    return typeof jid === 'string' && jid.endsWith('@lid');
}

/**
 * Resolves a participant JID to its phone-number (PN) JID using Baileys'
 * LID mapping store. Returns '<digits>@s.whatsapp.net' or null.
 * Phone JIDs pass through normalized; LIDs map only when the store knows
 * them — otherwise null (caller must NOT fabricate a phone number).
 */
async function resolveParticipantPN(sessionData, participantJid) {
    if (!participantJid || typeof participantJid !== 'string') return null;
    let norm = participantJid;
    try {
        norm = jidNormalizedUser(participantJid) || participantJid;
    } catch (e) {
        // fall through with raw value
    }
    if (!isLidJid(norm)) {
        return norm;
    }
    try {
        const mapping = sessionData?.sock?.signalRepository?.lidMapping;
        if (mapping && typeof mapping.getPNForLID === 'function') {
            // Pass the full LID JID; the store decodes it internally.
            // Returns e.g. "9053...:0@s.whatsapp.net" or null on miss.
            const pn = await mapping.getPNForLID(norm);
            if (pn && typeof pn === 'string' && pn.trim()) {
                const pnUser = pn.split('@')[0].split(':')[0];
                if (pnUser && /^\d+$/.test(pnUser)) {
                    return `${pnUser}@s.whatsapp.net`;
                }
            }
        }
    } catch (e) {
        // Mapping miss — caller falls back to pushName/contacts honestly.
    }
    return null;
}

/**
 * Fetches and caches WhatsApp avatar URL with strict 2.5s timeout to prevent socket hanging.
 */
async function fetchAvatar(sessionData, jid) {
    if (!sessionData || !sessionData.sock || !jid) return null;
    if (sessionData.avatars && sessionData.avatars.has(jid)) {
        return sessionData.avatars.get(jid);
    }
    try {
        const urlPromise = sessionData.sock.profilePictureUrl(jid, 'preview');
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Avatar timeout')), 2500));
        const url = await Promise.race([urlPromise, timeoutPromise]);
        if (url) {
            if (!sessionData.avatars) sessionData.avatars = new Map();
            sessionData.avatars.set(jid, url);
            return url;
        }
    } catch (e) {
        // If profile photo doesn't exist or is blocked, cache empty string to prevent redundant queries
        if (e && (e.output?.statusCode === 404 || e.message?.includes('item-not-found') || e.message?.includes('not-authorized'))) {
            if (!sessionData.avatars) sessionData.avatars = new Map();
            sessionData.avatars.set(jid, '');
        }
        // If temporary timeout, do not poison cache so future sync can retry
    }
    return null;
}

/**
 * Updates or adds a contact in session memory.
 */
function updateContact(sessionData, contact) {
    if (!contact || !contact.id) return;
    const jid = contact.id;
    if (!isSupportedJid(jid)) return;
    if (!(sessionData.contacts instanceof Map)) sessionData.contacts = new Map();
    // Bound memory: traffic-learned entries stop at 10k (chat/contact churn
    // on busy phones is unbounded over months).
    if (!sessionData.contacts.has(jid) && sessionData.contacts.size >= 10000) return;
    const isGroup = jid.endsWith('@g.us');
    // A @lid value is opaque — never fabricate a phone number from it.
    const phone = isGroup ? jid : (isLidJid(jid) ? null : `+${jid.split('@')[0]}`);
    const existing = sessionData.contacts.get(jid) || {};
    const contactName = contact.name || contact.notify || contact.verifiedName || contact.subject || existing.name || '';
    sessionData.contacts.set(jid, {
        id: jid,
        phone,
        name: contactName,
        isGroup
    });
    // If contact has a linked LID property, register contact under that LID too
    if (contact.lid && isLidJid(contact.lid)) {
        const existingLid = sessionData.contacts.get(contact.lid) || {};
        sessionData.contacts.set(contact.lid, {
            id: contact.lid,
            phone: phone || existingLid.phone || null,
            name: contactName || existingLid.name || '',
            isGroup: false
        });
        if (!sessionData.resolvedLidPairs) sessionData.resolvedLidPairs = new Map();
        if (phone) sessionData.resolvedLidPairs.set(contact.lid, phone);
    }
    // Alias phone-form JIDs under their normalized form too, so lookups hit
    // regardless of which representation a message carries.
    if (!isGroup && !isLidJid(jid)) {
        try {
            const norm = (jidNormalizedUser(jid) || jid);
            if (norm !== jid && !sessionData.contacts.has(norm)) {
                const stored = sessionData.contacts.get(jid);
                sessionData.contacts.set(norm, { ...stored, id: norm });
            }
        } catch (e) {
            // normalization is best-effort only
        }
    }
    // Save contacts and schedule sync whenever contacts are added/updated
    saveContactsToDisk(sessionData);
}

const contactsSyncTimers = new Map();

/**
 * Saves in-memory contacts map to contacts.json in sessionAuthDir.
 * Automatically included in session-backup because it ends with .json.
 */
function saveContactsToDisk(sessionData) {
    if (!sessionData?.name || !(sessionData.contacts instanceof Map)) return;
    try {
        const sessionAuthDir = path.join(SESSIONS_DIR, sessionData.name);
        if (!fs.existsSync(sessionAuthDir)) {
            fs.mkdirSync(sessionAuthDir, { recursive: true });
        }
        const arr = Array.from(sessionData.contacts.values());
        fs.writeFileSync(path.join(sessionAuthDir, 'contacts.json'), JSON.stringify(arr), 'utf8');
    } catch (err) {
        console.warn(`[WA-Gateway] Failed to save contacts to disk for ${sessionData.name}:`, err.message);
    }
}

/**
 * Loads contacts from contacts.json in sessionAuthDir into sessionData.contacts.
 */
function loadContactsFromDisk(sessionData) {
    if (!sessionData?.name) return;
    try {
        const sessionAuthDir = path.join(SESSIONS_DIR, sessionData.name);
        const contactsFile = path.join(sessionAuthDir, 'contacts.json');
        if (fs.existsSync(contactsFile)) {
            const content = fs.readFileSync(contactsFile, 'utf8');
            const arr = JSON.parse(content);
            if (Array.isArray(arr)) {
                if (!(sessionData.contacts instanceof Map)) sessionData.contacts = new Map();
                for (const c of arr) {
                    if (c && c.id) {
                        sessionData.contacts.set(c.id, c);
                    }
                }
                console.log(`[WA-Gateway] Loaded ${sessionData.contacts.size} contacts from disk for ${sessionData.name}`);
            }
        }
    } catch (err) {
        console.warn(`[WA-Gateway] Failed to load contacts from disk for ${sessionData.name}:`, err.message);
    }
}

/**
 * Pushes contacts to the backend webhook so the CRM database (leads) always has
 * truthful contact names from the connected phone's address book.
 */
async function syncContactsToBackend(sessionData) {
    if (!sessionData?.name || !(sessionData.contacts instanceof Map)) return;
    const contactsList = [];
    for (const c of sessionData.contacts.values()) {
        if (c && (c.name || c.phone) && !c.isGroup) {
            contactsList.push({
                id: c.id,
                phone: c.phone,
                name: c.name
            });
        }
    }
    if (contactsList.length > 0) {
        try {
            await notifyBackend(sessionData.name, 'contacts-sync', {
                contacts: contactsList
            });
            console.log(`[WA-Gateway] Synced ${contactsList.length} contacts to backend for ${sessionData.name}`);
        } catch (e) {
            console.warn(`[WA-Gateway] Failed to sync contacts to backend:`, e.message);
        }
    }
}

function scheduleContactsSync(sessionData) {
    if (!sessionData?.name) return;
    saveContactsToDisk(sessionData);
    backupSessionAuth(sessionData.name);

    if (contactsSyncTimers.has(sessionData.name)) {
        clearTimeout(contactsSyncTimers.get(sessionData.name));
    }
    const timer = setTimeout(() => {
        contactsSyncTimers.delete(sessionData.name);
        syncContactsToBackend(sessionData).catch(err => {
            console.warn(`[WA-Gateway] syncContactsToBackend error:`, err.message);
        });
    }, 1500);
    contactsSyncTimers.set(sessionData.name, timer);
}

/**
 * Resolves human-readable sender name for group chats or inbound messages.
 * Uses jidNormalizedUser() to strip Baileys multi-device ":1" device index suffix
 * before looking up contacts.
 *
 * Priority:
 * 1. Saved address book name from phone (sessionData.contacts, e.g. "Annem", "Tolga Cebeci").
 * 2. pushName (WhatsApp nickname set by user on their app).
 * 3. Formatted phone number (+90...).
 */
function resolveSenderName(sessionData, msg, participantJid, fromMe, participantPn = null) {
    if (fromMe) return 'Siz';
    if (!participantJid && !participantPn) return null;

    // 1. Normalize the JID to strip multi-device index (e.g. "9053xxx:1@s.whatsapp.net" -> "9053xxx@s.whatsapp.net")
    let normJid = participantJid;
    try {
        normJid = (participantJid && jidNormalizedUser(participantJid)) || participantJid;
    } catch (e) {
        // jidNormalizedUser may throw on unsupported JID formats – fallback to raw
    }

    // 2. Check session contact book (this phone's address book) FIRST under every known form.
    //    The user's own saved contact name always has the highest precedence.
    const candidates = [];
    if (normJid) candidates.push(normJid);
    if (participantJid && participantJid !== normJid) candidates.push(participantJid);
    if (participantPn && participantPn !== normJid && participantPn !== participantJid) {
        candidates.push(participantPn);
    }
    if (sessionData?.contacts) {
        for (const key of candidates) {
            const contact = sessionData.contacts.get(key);
            if (contact?.name && typeof contact.name === 'string' && contact.name.trim()) {
                return contact.name.trim();
            }
        }
        // Backfill: remember the PN alias so future lookups hit directly
        if (participantPn && normJid && isLidJid(normJid)) {
            const lidContact = sessionData.contacts.get(normJid);
            if (lidContact && !sessionData.contacts.has(participantPn)) {
                sessionData.contacts.set(participantPn, { ...lidContact, id: participantPn });
            }
            const lidUser = normJid.split('@')[0].split(':')[0];
            const pnUser = participantPn.split('@')[0].split(':')[0];
            if (lidUser && pnUser && sessionData.resolvedLidPairs instanceof Map) {
                sessionData.resolvedLidPairs.set(lidUser, pnUser);
            }
        }
    }

    // 3. Check msg.pushName (WhatsApp push name sent in message packet)
    if (msg?.pushName && typeof msg.pushName === 'string' && msg.pushName.trim()) {
        return msg.pushName.trim();
    }

    // 4. Fallback to formatted phone number — ONLY for genuine phone JIDs.
    const refJid = participantPn || normJid || participantJid;
    if (refJid && !isLidJid(refJid)) {
        const rawNumber = refJid.split(':')[0].split('@')[0];
        if (rawNumber && /^\d+$/.test(rawNumber)) {
            return `+${rawNumber}`;
        }
    }

    return null;
}

/**
 * Extracts plain text from any Baileys message object with recursive unwrapping
 * and descriptive fallbacks for media types.
 */
function extractMessageText(message) {
    if (!message) return '';

    // Unwrap wrappers
    if (message.ephemeralMessage?.message) {
        return extractMessageText(message.ephemeralMessage.message);
    }
    if (message.viewOnceMessage?.message) {
        return extractMessageText(message.viewOnceMessage.message);
    }
    if (message.viewOnceMessageV2?.message) {
        return extractMessageText(message.viewOnceMessageV2.message);
    }
    if (message.viewOnceMessageV2Extension?.message) {
        return extractMessageText(message.viewOnceMessageV2Extension.message);
    }
    if (message.documentWithCaptionMessage?.message) {
        return extractMessageText(message.documentWithCaptionMessage.message);
    }
    if (message.protocolMessage?.editedMessage) {
        return extractMessageText(message.protocolMessage.editedMessage);
    }

    // Text & extended text
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;

    // Media messages with caption or descriptive fallback
    if (message.imageMessage) {
        return message.imageMessage.caption || '[Fotoğraf]';
    }
    if (message.videoMessage) {
        return message.videoMessage.caption || '[Video]';
    }
    if (message.audioMessage) {
        return message.audioMessage.ptt ? '[Sesli Mesaj]' : '[Ses Dosyası]';
    }
    if (message.ptvMessage) {
        return '[Video Notu]';
    }
    if (message.stickerMessage) {
        return '[Çıkartma]';
    }
    if (message.documentMessage) {
        return message.documentMessage.fileName 
            ? `[Belge: ${message.documentMessage.fileName}]` 
            : (message.documentMessage.caption || '[Belge]');
    }
    if (message.contactMessage) {
        return `[Kişi: ${message.contactMessage.displayName || 'Kişi Kartı'}]`;
    }
    if (message.contactsArrayMessage) {
        return `[${message.contactsArrayMessage.contacts?.length || 0} Kişi Kartı]`;
    }
    if (message.locationMessage || message.liveLocationMessage) {
        return '[Konum]';
    }
    if (message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3) {
        const pollName = message.pollCreationMessage?.name || message.pollCreationMessageV2?.name || message.pollCreationMessageV3?.name;
        return pollName ? `[Anket: ${pollName}]` : '[Anket]';
    }
    if (message.reactionMessage) {
        return message.reactionMessage.text || '';
    }

    return '';
}

/**
 * Records a message in session memory buffer (up to 100 recent messages per chat).
 */
function recordChatMessage(sessionData, msg) {
    if (!sessionData || !msg) return;
    if (!sessionData.chatMessages) sessionData.chatMessages = new Map();
    const remoteJid = msg.remote_jid || msg.remoteJid || msg.phone;
    if (!remoteJid) return;
    let list = sessionData.chatMessages.get(remoteJid);
    if (!list) {
        list = [];
        sessionData.chatMessages.set(remoteJid, list);
    }
    // Deduplicate by wa_message_id if present
    if (msg.wa_message_id && list.some(existing => existing.wa_message_id === msg.wa_message_id)) {
        return;
    }
    list.push(msg);
    // Sort ascending by timestamp
    list.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    if (list.length > 100) {
        list.splice(0, list.length - 100);
    }
    scheduleMessagesSave(sessionData);
}

/**
 * Updates or adds a chat in session memory with strict sorting timestamps.
 */
function updateChat(sessionData, chat) {
    if (!chat || !chat.id) return;
    const jid = chat.id;
    if (!isSupportedJid(jid)) return;
    const isGroup = jid.endsWith('@g.us');
    const phone = isGroup ? jid : (isLidJid(jid) ? null : `+${jid.split('@')[0]}`);
    const existing = sessionData.chats.get(jid) || {};
    const contact = sessionData.contacts.get(jid) || {};
    const name = chat.name || chat.subject || contact.name || existing.name || (isGroup ? 'WhatsApp Grubu' : '');
    const unreadCount = chat.unreadCount ?? existing.unreadCount ?? 0;

    let rawTs = chat.conversationTimestamp || chat.lastMessageRecvTimestamp || chat.lastMsgTimestamp || existing.conversationTimestamp;
    let lastMessage = chat.lastMessageText || existing.lastMessage || '';
    let lastMessageFromMe = chat.lastMessageFromMe ?? existing.lastMessageFromMe ?? false;
    let lastMessageSenderName = chat.lastMessageSenderName || existing.lastMessageSenderName || null;
    let lastMessageParticipant = chat.lastMessageParticipant || existing.lastMessageParticipant || null;
    let lastMessageParticipantPn = chat.lastMessageParticipantPn || existing.lastMessageParticipantPn || null;

    // If chat has Baileys messages array (IHistorySyncMsg[]), extract all messages and track latest!
    if (chat.messages && Array.isArray(chat.messages) && chat.messages.length > 0) {
        let latestFound = false;
        for (let i = 0; i < chat.messages.length; i++) {
            const histMsg = chat.messages[i]?.message || chat.messages[i];
            if (!histMsg) continue;
            const text = extractMessageText(histMsg.message);
            if (!text) continue;
            const msgTs = toUnixTimestamp(histMsg.messageTimestamp);
            const histFromMe = !!histMsg.key?.fromMe;
            const partJid = histMsg.key?.participant || (histFromMe ? null : (isGroup ? null : jid));
            const senderName = resolveSenderName(sessionData, histMsg, partJid, histFromMe);

            recordChatMessage(sessionData, {
                wa_message_id: histMsg.key?.id,
                fromMe: histFromMe,
                phone: phone,
                remote_jid: jid,
                participant: partJid,
                participant_pn: null,
                sender_name: senderName,
                is_group: isGroup,
                message: text,
                timestamp: msgTs
            });

            if (!latestFound || (msgTs > 0 && msgTs >= toUnixTimestamp(rawTs))) {
                lastMessage = text;
                if (msgTs > 0) rawTs = msgTs;
                lastMessageFromMe = histFromMe;
                lastMessageParticipant = partJid;
                lastMessageSenderName = senderName;
                latestFound = true;
            }
        }
    }

    const conversationTimestamp = toUnixTimestamp(rawTs);

    sessionData.chats.set(jid, {
        id: jid,
        phone,
        name,
        isGroup,
        unreadCount,
        conversationTimestamp,
        lastMessage,
        lastMessageFromMe,
        lastMessageSenderName,
        lastMessageParticipant,
        lastMessageParticipantPn
    });

    // Schedule persistent chat caching to disk and database backup
    scheduleChatsSave(sessionData);
}

const chatsSaveTimers = new Map();
const messagesSaveTimers = new Map();

/**
 * Saves in-memory chats to chats.json in sessionAuthDir.
 * Automatically backed up to database via backupSessionAuth.
 */
function saveChatsToDisk(sessionData) {
    if (!sessionData?.name || !(sessionData.chats instanceof Map)) return;
    try {
        const sessionAuthDir = path.join(SESSIONS_DIR, sessionData.name);
        if (!fs.existsSync(sessionAuthDir)) {
            fs.mkdirSync(sessionAuthDir, { recursive: true });
        }
        const arr = Array.from(sessionData.chats.values());
        fs.writeFileSync(path.join(sessionAuthDir, 'chats.json'), JSON.stringify(arr), 'utf8');
    } catch (err) {
        console.warn(`[WA-Gateway] Failed to save chats to disk for ${sessionData.name}:`, err.message);
    }
}

/**
 * Loads chats from chats.json in sessionAuthDir into sessionData.chats on startup.
 */
function loadChatsFromDisk(sessionData) {
    if (!sessionData?.name) return;
    try {
        const sessionAuthDir = path.join(SESSIONS_DIR, sessionData.name);
        const chatsFile = path.join(sessionAuthDir, 'chats.json');
        if (fs.existsSync(chatsFile)) {
            const content = fs.readFileSync(chatsFile, 'utf8');
            const arr = JSON.parse(content);
            if (Array.isArray(arr)) {
                if (!(sessionData.chats instanceof Map)) sessionData.chats = new Map();
                for (const c of arr) {
                    if (c && c.id) {
                        sessionData.chats.set(c.id, c);
                    }
                }
                console.log(`[WA-Gateway] Loaded ${sessionData.chats.size} chats from disk for ${sessionData.name}`);
            }
        }
    } catch (err) {
        console.warn(`[WA-Gateway] Failed to load chats from disk for ${sessionData.name}:`, err.message);
    }
}

function scheduleChatsSave(sessionData) {
    if (!sessionData?.name) return;
    saveChatsToDisk(sessionData);
    backupSessionAuth(sessionData.name);

    if (chatsSaveTimers.has(sessionData.name)) {
        clearTimeout(chatsSaveTimers.get(sessionData.name));
    }
    const timer = setTimeout(() => {
        chatsSaveTimers.delete(sessionData.name);
        saveChatsToDisk(sessionData);
        backupSessionAuth(sessionData.name);
    }, 1500);
    chatsSaveTimers.set(sessionData.name, timer);
}

/**
 * Saves in-memory chat messages to messages.json in sessionAuthDir.
 * Automatically backed up to database via backupSessionAuth.
 */
function saveMessagesToDisk(sessionData) {
    if (!sessionData?.name || !(sessionData.chatMessages instanceof Map)) return;
    try {
        const sessionAuthDir = path.join(SESSIONS_DIR, sessionData.name);
        if (!fs.existsSync(sessionAuthDir)) {
            fs.mkdirSync(sessionAuthDir, { recursive: true });
        }
        const obj = {};
        for (const [jid, msgs] of sessionData.chatMessages.entries()) {
            if (Array.isArray(msgs) && msgs.length > 0) {
                obj[jid] = msgs.slice(-100);
            }
        }
        fs.writeFileSync(path.join(sessionAuthDir, 'messages.json'), JSON.stringify(obj), 'utf8');
    } catch (err) {
        console.warn(`[WA-Gateway] Failed to save messages to disk for ${sessionData.name}:`, err.message);
    }
}

/**
 * Loads messages from messages.json in sessionAuthDir into sessionData.chatMessages on startup.
 */
function loadMessagesFromDisk(sessionData) {
    if (!sessionData?.name) return;
    try {
        const sessionAuthDir = path.join(SESSIONS_DIR, sessionData.name);
        const messagesFile = path.join(sessionAuthDir, 'messages.json');
        if (fs.existsSync(messagesFile)) {
            const content = fs.readFileSync(messagesFile, 'utf8');
            const obj = JSON.parse(content);
            if (obj && typeof obj === 'object') {
                if (!(sessionData.chatMessages instanceof Map)) sessionData.chatMessages = new Map();
                for (const [jid, msgs] of Object.entries(obj)) {
                    if (Array.isArray(msgs) && msgs.length > 0) {
                        sessionData.chatMessages.set(jid, msgs);
                    }
                }
                console.log(`[WA-Gateway] Loaded message caches for ${sessionData.chatMessages.size} chats from disk for ${sessionData.name}`);
            }
        }
    } catch (err) {
        console.warn(`[WA-Gateway] Failed to load messages from disk for ${sessionData.name}:`, err.message);
    }
}

function scheduleMessagesSave(sessionData) {
    if (!sessionData?.name) return;
    saveMessagesToDisk(sessionData);
    backupSessionAuth(sessionData.name);

    if (messagesSaveTimers.has(sessionData.name)) {
        clearTimeout(messagesSaveTimers.get(sessionData.name));
    }
    const timer = setTimeout(() => {
        messagesSaveTimers.delete(sessionData.name);
        saveMessagesToDisk(sessionData);
        backupSessionAuth(sessionData.name);
    }, 2000);
    messagesSaveTimers.set(sessionData.name, timer);
}

/**
 * Fetches messages for a specific chat, optionally querying the phone for older history.
 */
async function fetchChatMessages(sessionName, chatJid, options = {}) {
    const session = activeSessions.get(sessionName);
    if (!session) {
        throw new Error(`Session not found: ${sessionName}`);
    }
    if (!(session.chatMessages instanceof Map)) {
        session.chatMessages = new Map();
    }

    let msgs = session.chatMessages.get(chatJid) || [];

    if (options.fetchOlder && session.sock && typeof session.sock.fetchMessageHistory === 'function') {
        try {
            let oldestKey = null;
            let oldestTsMs = null;

            if (msgs.length > 0) {
                const oldest = msgs[0];
                if (oldest && oldest.wa_message_id) {
                    oldestKey = {
                        remoteJid: chatJid,
                        id: oldest.wa_message_id,
                        fromMe: !!oldest.fromMe
                    };
                    oldestTsMs = (oldest.timestamp || Math.floor(Date.now() / 1000)) * 1000;
                }
            } else if (options.oldestMsgId) {
                oldestKey = {
                    remoteJid: chatJid,
                    id: options.oldestMsgId,
                    fromMe: !!options.oldestFromMe
                };
                oldestTsMs = (options.oldestTimestamp || Math.floor(Date.now() / 1000)) * 1000;
            }

            if (oldestKey) {
                console.log(`[WA-Gateway] Requesting older message history for ${chatJid} (${oldestKey.id}) from phone...`);
                await session.sock.fetchMessageHistory(50, oldestKey, oldestTsMs);
                await new Promise(r => setTimeout(r, 1200));
                msgs = session.chatMessages.get(chatJid) || msgs;
            }
        } catch (err) {
            console.warn(`[WA-Gateway] fetchMessageHistory failed for ${chatJid}:`, err.message);
        }
    }

    return {
        success: true,
        chat_jid: chatJid,
        messages: msgs
    };
}

/**
 * Queries WhatsApp Multi-Device servers for all groups the session participates in,
 * ensuring groups (such as "3hacker") are populated in session memory with their titles.
 * Uses a strict 3.5s timeout to prevent socket hanging.
 */
async function discoverParticipatingGroups(sessionData) {
    if (!sessionData || !sessionData.sock || typeof sessionData.sock.groupFetchAllParticipating !== 'function') {
        return;
    }
    try {
        const groupsPromise = sessionData.sock.groupFetchAllParticipating();
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Group fetch timeout')), 3500));
        const groups = await Promise.race([groupsPromise, timeoutPromise]);
        if (groups && typeof groups === 'object') {
            for (const [groupId, group] of Object.entries(groups)) {
                if (!groupId.endsWith('@g.us')) continue;
                const subject = (group.subject || 'WhatsApp Grubu').trim();
                const existing = sessionData.chats.get(groupId);
                const existingTs = existing?.conversationTimestamp || 0;
                if (existing) {
                    if (!existing.name || existing.name === 'WhatsApp Grubu') {
                        existing.name = subject;
                    }
                    existing.isGroup = true;
                } else {
                    updateChat(sessionData, {
                        id: groupId,
                        name: subject,
                        isGroup: true,
                        conversationTimestamp: existingTs
                    });
                }
            }
        }
    } catch (err) {
        console.warn(`[WA-Gateway] Could not fetch participating groups for ${sessionData.name || 'session'}:`, err.message);
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

    // Restore persistent contacts, chats and messages from disk if available
    loadContactsFromDisk(sessionData);
    loadChatsFromDisk(sessionData);
    loadMessagesFromDisk(sessionData);

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
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1043857760] }));
    console.log(`[WA-Gateway] Starting socket for ${sessionName} with WA Web v${version.join('.')}`);

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Chrome'),
        syncFullHistory: true,
        markOnlineOnConnect: true,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        generateHighQualityLinkPreview: false,
        keepAliveIntervalMs: 25000,
        getMessage: async (key) => {
            return undefined;
        }
    });

    sessionData.sock = sock;

    // Listen to credentials update
    sock.ev.on('creds.update', async () => {
        await saveCreds();
        backupSessionAuth(sessionName);
    });

    // Listen to contacts updates from phone
    sock.ev.on('contacts.upsert', (contacts) => {
        if (!contacts || !Array.isArray(contacts)) return;
        for (const c of contacts) {
            updateContact(sessionData, c);
        }
        scheduleContactsSync(sessionData);
    });

    sock.ev.on('contacts.update', (updates) => {
        if (!updates || !Array.isArray(updates)) return;
        for (const u of updates) {
            updateContact(sessionData, u);
        }
        scheduleContactsSync(sessionData);
    });

    // Listen to chat list updates from phone
    sock.ev.on('chats.upsert', (chats) => {
        if (!chats || !Array.isArray(chats)) return;
        for (const c of chats) {
            updateChat(sessionData, c);
        }
    });

    sock.ev.on('chats.update', (updates) => {
        if (!updates || !Array.isArray(updates)) return;
        for (const u of updates) {
            updateChat(sessionData, u);
        }
    });

    // Listen to WhatsApp initial chat & message history synchronization
    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
        console.log(`[WA-Gateway] History sync received for ${sessionName}: ${chats?.length || 0} chats, ${contacts?.length || 0} contacts, ${messages?.length || 0} messages`);
        try {
            // Ingest contacts into memory
            for (const c of (contacts || [])) {
                updateContact(sessionData, c);
            }
            scheduleContactsSync(sessionData);

            // Ingest chats into memory
            for (const c of (chats || [])) {
                updateChat(sessionData, c);
            }

            // Update chats with latest message details from message history
            for (const m of (messages || [])) {
                const remoteJid = m.key?.remoteJid;
                if (!isSupportedJid(remoteJid)) continue;
                const text = extractMessageText(m.message);
                const ts = toUnixTimestamp(m.messageTimestamp);
                const fromMe = !!m.key?.fromMe;
            const partJid = m.key?.participant || (fromMe ? null : remoteJid);
            const partPn = (!fromMe && partJid) ? await resolveParticipantPN(sessionData, partJid) : null;
            // Learn contacts from traffic: a pushName on any message is the
            // author's self-chosen name — persist under both JID forms.
            if (!fromMe && partJid && m.pushName && typeof m.pushName === 'string' && m.pushName.trim()) {
                updateContact(sessionData, { id: partJid, notify: m.pushName.trim() });
                if (partPn) updateContact(sessionData, { id: partPn, notify: m.pushName.trim() });
            }
            const senderName = resolveSenderName(sessionData, m, partJid, fromMe, partPn);

                if (text && remoteJid) {
                    const existingChat = sessionData.chats.get(remoteJid);
                    if (existingChat) {
                        if (!existingChat.conversationTimestamp || ts >= existingChat.conversationTimestamp) {
                            existingChat.lastMessage = text;
                            existingChat.conversationTimestamp = ts;
                            existingChat.lastMessageFromMe = fromMe;
                            existingChat.lastMessageSenderName = senderName;
                            existingChat.lastMessageParticipant = partJid;
                            existingChat.lastMessageParticipantPn = partPn;
                        }
                    } else {
                        updateChat(sessionData, {
                            id: remoteJid,
                            lastMessageText: text,
                            conversationTimestamp: ts,
                            lastMessageFromMe: fromMe,
                            lastMessageSenderName: senderName,
                            lastMessageParticipant: partJid,
                            lastMessageParticipantPn: partPn
                        });
                    }
                }
            }

            const validChats = Array.from(sessionData.chats.values()).map(c => {
                const contact = sessionData.contacts.get(c.id);
                return {
                    id: c.id,
                    phone: c.phone,
                    name: c.name || contact?.name || (c.isGroup ? 'WhatsApp Grubu' : ''),
                    is_group: !!c.isGroup,
                    conversation_timestamp: toUnixTimestamp(c.conversationTimestamp),
                    last_message_preview: c.lastMessage || '',
                    last_message_from_me: !!c.lastMessageFromMe,
                last_message_sender_name: c.lastMessageSenderName || null,
                    last_message_participant: c.lastMessageParticipant || null,
                    last_message_participant_pn: c.lastMessageParticipantPn || null
                };
            });
            validChats.sort((a, b) => (b.conversation_timestamp || 0) - (a.conversation_timestamp || 0));

            const validMessages = [];
            const seenMsgIds = new Set();

            for (const m of (messages || [])) {
                const remoteJid = m.key?.remoteJid || '';
                if (!isSupportedJid(remoteJid)) continue;
                const text = extractMessageText(m.message);
                if (!text) continue;
                const isGroup = remoteJid.endsWith('@g.us');
                const fromMe = !!m.key?.fromMe;
                const partJid = m.key?.participant || (fromMe ? null : remoteJid);
                const partPn = (!fromMe && partJid) ? await resolveParticipantPN(sessionData, partJid) : null;
                // DM chat identity prefers the resolved phone; raw LID is kept
                // separately so the backend can key the conversation honestly.
                let phone;
                if (isGroup) {
                    phone = remoteJid;
                } else if (partPn) {
                    phone = `+${partPn.split('@')[0]}`;
                } else if (isLidJid(remoteJid)) {
                    phone = remoteJid;
                } else {
                    phone = `+${remoteJid.split('@')[0]}`;
                }
                const senderName = resolveSenderName(sessionData, m, partJid, fromMe, partPn);
                const msgObj = {
                    wa_message_id: m.key?.id,
                    fromMe: fromMe,
                    phone: phone,
                    remote_jid: remoteJid,
                    participant: partJid,
                    participant_pn: partPn,
                    sender_name: senderName,
                    is_group: isGroup,
                    message: text,
                    timestamp: toUnixTimestamp(m.messageTimestamp)
                };

                if (msgObj.wa_message_id) seenMsgIds.add(msgObj.wa_message_id);
                validMessages.push(msgObj);
                recordChatMessage(sessionData, msgObj);
            }

            // Merge messages captured from chat.messages during updateChat
            if (sessionData.chatMessages && sessionData.chatMessages.size > 0) {
                for (const msgList of sessionData.chatMessages.values()) {
                    for (const cachedMsg of msgList) {
                        if (!cachedMsg.wa_message_id || !seenMsgIds.has(cachedMsg.wa_message_id)) {
                            if (cachedMsg.wa_message_id) seenMsgIds.add(cachedMsg.wa_message_id);
                            validMessages.push(cachedMsg);
                        }
                    }
                }
            }

            validMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

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
                    errorCorrectionLevel: 'L',
                    margin: 4,
                    scale: 10,
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

            // Persist full auth state to database
            backupSessionAuth(sessionName);

            // Asynchronously discover all participating WhatsApp groups (e.g. "3hacker") on connection
            setTimeout(() => {
                discoverParticipatingGroups(sessionData).catch(() => {});
            }, 500);
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
                // For transient disconnects or Baileys 515 restartRequired, recreate socket
                const isRestartRequired = statusCode === DisconnectReason.restartRequired;
                console.log(`[WA-Gateway] Reconnecting session ${sessionName} (status: ${statusCode}, restartRequired: ${isRestartRequired})...`);

                sessionData.status = 'CONNECTING';

                if (sessionData.reconnectTimer) {
                    clearTimeout(sessionData.reconnectTimer);
                }
                sessionData.reconnectTimer = setTimeout(() => {
                    sessionData.reconnectTimer = null;
                    initSessionSocket(sessionData).catch(err => {
                        console.error(`[WA-Gateway] Reconnect failed for ${sessionName}:`, err.message);
                    });
                }, isRestartRequired ? 500 : 3000);
            }
        }
    });

    // Listen to live message events (inbound from contacts/groups & outbound from user's phone)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (!messages || messages.length === 0) return;

        for (const msg of messages) {
            const remoteJid = msg.key?.remoteJid || '';
            if (!isSupportedJid(remoteJid)) continue; // Allow @s.whatsapp.net, @g.us and @lid

            const isGroup = remoteJid.endsWith('@g.us');
            const fromMe = !!msg.key?.fromMe;
            const ts = toUnixTimestamp(msg.messageTimestamp) || Math.floor(Date.now() / 1000);
            const partJid = msg.key?.participant || (fromMe ? null : remoteJid);
            // Resolve LID -> phone via the signal store (per connected phone).
            const partPn = (!fromMe && partJid) ? await resolveParticipantPN(sessionData, partJid) : null;
            // Learn contacts from traffic (see history handler above).
            if (!fromMe && partJid && msg.pushName && typeof msg.pushName === 'string' && msg.pushName.trim()) {
                updateContact(sessionData, { id: partJid, notify: msg.pushName.trim() });
                if (partPn) updateContact(sessionData, { id: partPn, notify: msg.pushName.trim() });
            }
            // DM chat identity prefers the resolved phone; raw LID is kept
            // separately so the backend keys honestly instead of dropping.
            let contactPhone;
            if (isGroup) {
                contactPhone = remoteJid;
            } else if (!isLidJid(remoteJid)) {
                contactPhone = `+${remoteJid.split('@')[0]}`;
            } else {
                const remotePn = await resolveParticipantPN(sessionData, remoteJid);
                contactPhone = remotePn ? `+${remotePn.split('@')[0]}` : remoteJid;
            }
            const text = extractMessageText(msg.message);

            if (!text) continue;

            const senderName = resolveSenderName(sessionData, msg, partJid, fromMe, partPn);

            console.log(`[WA-Gateway] Message (${fromMe ? 'Outbound phone' : 'Inbound'}) for ${contactPhone} on ${sessionName}: "${text}" (sender: ${senderName || 'unknown'})`);

            // Update in-memory chat cache
            updateChat(sessionData, {
                id: remoteJid,
                lastMessageText: text,
                conversationTimestamp: ts,
                lastMessageFromMe: fromMe,
                lastMessageSenderName: senderName,
                lastMessageParticipant: partJid,
                lastMessageParticipantPn: partPn,
                unreadCount: fromMe ? 0 : ((sessionData.chats?.get(remoteJid)?.unreadCount || 0) + 1)
            });

            recordChatMessage(sessionData, {
                wa_message_id: msg.key?.id,
                fromMe: fromMe,
                phone: contactPhone,
                remote_jid: remoteJid,
                participant: partJid,
                participant_pn: partPn,
                sender_name: senderName,
                is_group: isGroup,
                message: text,
                timestamp: ts
            });

            // Dispatch message-event webhook for full two-way chat synchronization
            await notifyBackend(sessionName, 'message-event', {
                fromMe: fromMe,
                phone: contactPhone,
                remote_jid: remoteJid,
                participant: partJid,
                participant_pn: partPn,
                sender_name: senderName,
                is_group: isGroup,
                message: text,
                wa_message_id: msg.key?.id,
                timestamp: ts
            });

            // Backward compatibility for opt-out & lead reply processing (DMs only)
            if (!fromMe && !isGroup) {
                await notifyBackend(sessionName, 'inbound', {
                    phone: contactPhone,
                    message: text,
                    wa_message_id: msg.key?.id,
                    timestamp: ts
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
        resolvedLidPairs: new Map(),
        avatars: new Map(),
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
 * If session is not currently in memory, attempts on-the-fly recovery from database/disk.
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
            console.log(`[WA-Gateway] Session ${sessionName} found during sendMessage, restoring...`);
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

    // Update in-memory chat immediately
    updateChat(session, {
        id: jid,
        lastMessageText: messageText,
        conversationTimestamp: Math.floor(Date.now() / 1000),
        lastMessageFromMe: true,
        lastMessageSenderName: 'Siz',
        unreadCount: 0
    });

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
    // 1. Restore all sessions backed up to database
    await restoreAllSessionsFromDatabase();

    // 2. Scan local disk for any registered sessions not yet loaded
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

    // Only wipe stale un-registered keys if creds are not already paired/pairing
    if (!hasPairedCreds && fs.existsSync(sessionAuthDir)) {
        try {
            fs.rmSync(sessionAuthDir, { recursive: true, force: true });
        } catch (e) {}
    }

    const session = await getOrCreateSession(sessionName, true);

    // Wait up to 3.5s for initial QR to be generated
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
}

/**
 * Returns all in-memory tracked chats for a session, enriched with avatars and sorted by latest activity.
 */
async function getSessionChats(sessionName, options = {}) {
    const { includeAvatars = true } = options || {};
    let session = activeSessions.get(sessionName);
    if (!session || !session.chats) {
        // Attempt on-the-fly restoration from disk or DB
        const credsPath = path.join(SESSIONS_DIR, sessionName, 'creds.json');
        let hasCreds = fs.existsSync(credsPath);
        if (!hasCreds) {
            hasCreds = await restoreSessionFromDatabase(sessionName);
        }
        if (hasCreds) {
            console.log(`[WA-Gateway] Auto-restoring session for getSessionChats: ${sessionName}`);
            session = await getOrCreateSession(sessionName);
        }
    }
    if (!session || !session.chats) return [];

    // Ensure participating groups are discovered asynchronously without blocking chat listing response
    discoverParticipatingGroups(session).catch(() => {});

    const chatList = Array.from(session.chats.values()).map((c) => {
        let contact = session.contacts?.get(c.id);
        let resolvedPhone = c.phone;
        // If chat id is LID, resolve phone and contact if mapped
        if (isLidJid(c.id)) {
            if (!resolvedPhone && session.resolvedLidPairs?.has(c.id)) {
                resolvedPhone = session.resolvedLidPairs.get(c.id);
            }
            if (!contact && resolvedPhone) {
                contact = session.contacts?.get(resolvedPhone);
            }
        }
        const name = c.name || contact?.name || contact?.notify || (c.isGroup ? 'WhatsApp Grubu' : (resolvedPhone || ''));
        const msgs = session.chatMessages?.get(c.id) || [];
        return {
            id: c.id,
            phone: resolvedPhone || c.phone,
            name: name,
            is_group: !!c.isGroup,
            unread_count: c.unreadCount || 0,
            conversation_timestamp: toUnixTimestamp(c.conversationTimestamp),
            last_message_preview: c.lastMessage || '',
            last_message_from_me: !!c.lastMessageFromMe,
            last_message_sender_name: c.lastMessageSenderName || null,
            last_message_participant: c.lastMessageParticipant || null,
            last_message_participant_pn: c.lastMessageParticipantPn || null,
            avatar_url: session.avatars?.get(c.id) || null,
            messages: msgs
        };
    });

    // Sort strictly descending by latest message activity
    chatList.sort((a, b) => (b.conversation_timestamp || 0) - (a.conversation_timestamp || 0));

    if (includeAvatars === false) {
        return chatList;
    }

    // Fetch avatars in small batches of 4 for top 25 chats to prevent socket saturation
    const pendingAvatars = chatList.slice(0, 25).filter(c => !c.avatar_url);
    if (pendingAvatars.length > 0 && session.sock) {
        const chunkSize = 4;
        for (let i = 0; i < pendingAvatars.length; i += chunkSize) {
            const chunk = pendingAvatars.slice(i, i + chunkSize);
            await Promise.allSettled(chunk.map(async (c) => {
                const avatar = await fetchAvatar(session, c.id);
                if (avatar) c.avatar_url = avatar;
            }));
        }
    }

    return chatList;
}


/**
 * Pushes all known chats, avatars, and timestamps to the FastAPI backend webhook.
 */
async function syncSessionHistoryToBackend(sessionName) {
    const session = activeSessions.get(sessionName);
    if (!session) {
        throw new Error(`Oturum bulunamadı: ${sessionName}`);
    }

    const chats = await getSessionChats(sessionName);
    if (chats.length > 0) {
        const allMessages = [];
        for (const c of chats) {
            if (c.messages && c.messages.length > 0) {
                allMessages.push(...c.messages);
            }
        }
        await notifyBackend(sessionName, 'history-sync', {
            chats: chats.map((c) => ({
                id: c.id,
                phone: c.phone,
                name: c.name,
                is_group: c.is_group,
                avatar_url: c.avatar_url,
                conversation_timestamp: c.conversation_timestamp,
                last_message_preview: c.last_message_preview,
                last_message_from_me: c.last_message_from_me,
                last_message_sender_name: c.last_message_sender_name,
                last_message_participant: c.last_message_participant,
                last_message_participant_pn: c.last_message_participant_pn
            })),
            messages: allMessages
        });
    }

    return { success: true, count: chats.length };
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
    syncSessionHistoryToBackend,
    fetchChatMessages
};
