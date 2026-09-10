const express = require('express');
const cors = require('cors');
const {
    activeSessions,
    refreshSessionQR,
    requestPairingCode,
    sendMessage,
    disconnectSession,
    restoreSavedSessions,
    shutdownAllSessions,
    getSession,
    findSession,
    getSessionChats,
    getSessionChatsDelta,
} = require('./sessionManager');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Optional auth token verification
const GATEWAY_AUTH_TOKEN = process.env.WA_GATEWAY_AUTH_TOKEN || '';
function authMiddleware(req, res, next) {
    if (!GATEWAY_AUTH_TOKEN) return next();
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${GATEWAY_AUTH_TOKEN}`) {
        return res.status(401).json({ error: 'Unauthorized gateway request' });
    }
    next();
}

app.use(authMiddleware);

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'Tezlify WhatsApp Gateway (Baileys)',
        activeSessions: activeSessions.size
    });
});

// List all sessions
app.get('/api/sessions', (req, res) => {
    const list = Array.from(activeSessions.values()).map(s => ({
        name: s.name,
        status: s.status,
        phone: s.phone,
        hasQr: !!s.qrImage,
        createdAt: s.createdAt,
        messagesSent: s.messagesSent
    }));
    res.json(list);
});

// Canonical Tenant-Aware Endpoints (Phase 2)
app.post('/api/tenants/:tenantId/sessions/:sessionId/init', async (req, res) => {
    const { tenantId, sessionId } = req.params;
    const { sessionName } = req.body || {};
    try {
        let session = findSession(tenantId, sessionId);
        if (!session || session.status !== 'CONNECTED') {
            session = await refreshSessionQR({ tenantId, sessionId, sessionName });
        }
        res.json({
            success: true,
            session: {
                tenantId,
                sessionId,
                name: session.name,
                status: session.status,
                phone: session.phone,
                qrImage: session.qrImage || session.qr
            }
        });
    } catch (err) {
        console.error(`[WA-Gateway] Error initializing session for tenant ${tenantId}, session ${sessionId}:`, err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/tenants/:tenantId/sessions/:sessionId/qr', (req, res) => {
    const { tenantId, sessionId } = req.params;
    const session = findSession(tenantId, sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found for this tenant' });
    }
    res.json({
        tenantId,
        sessionId,
        name: session.name,
        status: session.status,
        phone: session.phone,
        qrImage: session.qrImage || session.qr
    });
});

app.post('/api/tenants/:tenantId/sessions/:sessionId/refresh-qr', async (req, res) => {
    const { tenantId, sessionId } = req.params;
    const { sessionName } = req.body || {};
    try {
        const session = await refreshSessionQR({ tenantId, sessionId, sessionName });
        res.json({
            success: true,
            status: session.status,
            qrImage: session.qrImage || session.qr
        });
    } catch (err) {
        console.error(`[WA-Gateway] Error refreshing QR for tenant ${tenantId}, session ${sessionId}:`, err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/tenants/:tenantId/sessions/:sessionId/status', (req, res) => {
    const { tenantId, sessionId } = req.params;
    const session = findSession(tenantId, sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found for this tenant' });
    }
    res.json({
        tenantId,
        sessionId,
        name: session.name,
        status: session.status,
        phone: session.phone,
        messagesSent: session.messagesSent
    });
});

app.post('/api/tenants/:tenantId/sessions/:sessionId/disconnect', async (req, res) => {
    const { tenantId, sessionId } = req.params;
    try {
        const result = await disconnectSession({ tenantId, sessionId });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/tenants/:tenantId/sessions/:sessionId', async (req, res) => {
    const { tenantId, sessionId } = req.params;
    try {
        const result = await disconnectSession({ tenantId, sessionId });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Canonical Tenant-Aware Outbound Message Send (Phase 5)
app.post('/api/tenants/:tenantId/sessions/:sessionId/messages/send', async (req, res) => {
    const { tenantId, sessionId } = req.params;
    const { phone, message, typingDelayMs = 0, clientMessageId } = req.body || {};

    if (!phone || !message) {
        return res.status(400).json({ error: 'phone and message are required' });
    }

    try {
        const result = await sendMessage(
            { tenantId, sessionId },
            phone,
            message,
            typingDelayMs,
            clientMessageId
        );
        res.json(result);
    } catch (err) {
        console.error(`[WA-Gateway] Send failed for tenant ${tenantId}, session ${sessionId}:`, err.message);
        const status = err.message.includes('bağlı değil') || err.message.includes('Grup') || err.message.includes('Geçersiz') || err.message.includes('boş olamaz') ? 400 : 500;
        res.status(status).json({
            success: false,
            error: err.message
        });
    }
});

// Create new session / Trigger QR pairing (supports both legacy and tenant-aware payloads)
app.post('/api/sessions/create', async (req, res) => {
    const { sessionName, tenantId, sessionId } = req.body;
    if (!sessionName && !sessionId) {
        return res.status(400).json({ error: 'sessionName or sessionId is required' });
    }

    try {
        const param = (tenantId && sessionId)
            ? { tenantId, sessionId, sessionName }
            : (sessionName || `session_${sessionId}`);
        let session = getSession(param);
        const hasValidQR = session && !!(session.qrImage || session.qr);
        const isAlreadyActive = session && (
            session.status === 'CONNECTED' ||
            (session.status === 'SCAN_QR' && hasValidQR) ||
            session.status === 'CONNECTING'
        );

        if (!session || !isAlreadyActive) {
            session = await refreshSessionQR(param);
        }
        res.json({
            message: 'Session initialized',
            session: {
                name: session.name,
                status: session.status,
                phone: session.phone,
                qrImage: session.qrImage || session.qr
            }
        });
    } catch (err) {
        console.error(`[WA-Gateway] Error creating session:`, err);
        res.status(500).json({ error: err.message });
    }
});

// Refresh QR Code on demand
app.post('/api/sessions/:sessionName/refresh-qr', async (req, res) => {
    const { sessionName } = req.params;
    try {
        const session = await refreshSessionQR(sessionName);
        res.json({
            success: true,
            status: session.status,
            qrImage: session.qrImage || session.qr
        });
    } catch (err) {
        console.error(`[WA-Gateway] Error refreshing QR for ${sessionName}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// Get session QR Code
app.get('/api/sessions/:sessionName/qr', (req, res) => {
    const { sessionName } = req.params;
    const session = getSession(sessionName);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
        name: session.name,
        status: session.status,
        phone: session.phone,
        qrImage: session.qrImage || session.qr
    });
});

// Request 8-digit WhatsApp Pairing Code for phone linking
app.post('/api/sessions/:sessionName/pairing-code', async (req, res) => {
    const { sessionName } = req.params;
    const { phone } = req.body || {};
    if (!phone) {
        return res.status(400).json({ error: 'Telefon numarası gereklidir.' });
    }

    try {
        const code = await requestPairingCode(sessionName, phone);
        res.json({
            success: true,
            sessionName,
            pairingCode: code
        });
    } catch (err) {
        console.error(`[WA-Gateway] Pairing code request failed for ${sessionName}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// Get session Status
app.get('/api/sessions/:sessionName/status', (req, res) => {
    const { sessionName } = req.params;
    const session = getSession(sessionName);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
        name: session.name,
        status: session.status,
        phone: session.phone,
        messagesSent: session.messagesSent
    });
});

// Get synced chats with contact names and last messages from active session
app.get('/api/sessions/:sessionName/chats', async (req, res) => {
    const { sessionName } = req.params;
    try {
        const chats = await getSessionChats(sessionName);
        res.json({
            success: true,
            sessionName,
            total: chats.length,
            chats
        });
    } catch (err) {
        console.warn(`[WA-Gateway] getSessionChats error for ${sessionName}:`, err.message);
        res.status(500).json({ success: false, error: err.message, chats: [] });
    }
});


// Fast in-memory chats delta poll: returns only changes since last revision (zero I/O)
app.get('/api/sessions/:sessionName/chats/delta', (req, res) => {
    const { sessionName } = req.params;
    const since = Number(req.query.since);
    try {
        const delta = getSessionChatsDelta(sessionName, Number.isFinite(since) ? since : undefined);
        res.json({ success: true, sessionName, ...delta });
    } catch (err) {
        console.warn(`[WA-Gateway] chats delta error for ${sessionName}:`, err.message);
        res.status(500).json({ success: false, error: err.message, revision: 0, changed: [] });
    }
});

// Disconnect session
app.post('/api/sessions/:sessionName/disconnect', async (req, res) => {
    const { sessionName } = req.params;
    try {
        const result = await disconnectSession(sessionName);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete session
app.delete('/api/sessions/:sessionName', async (req, res) => {
    const { sessionName } = req.params;
    try {
        const result = await disconnectSession(sessionName);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Send Message endpoint with presence typing
app.post('/api/send', async (req, res) => {
    const { session = 'default', phone, message, typingDelayMs = 0, clientMessageId } = req.body || {};

    if (!phone || !message) {
        return res.status(400).json({ error: 'phone and message are required' });
    }

    try {
        const result = await sendMessage(session, phone, message, typingDelayMs, clientMessageId);
        res.json(result);
    } catch (err) {
        console.error(`[WA-Gateway] Send failed for ${phone}:`, err.message);
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

const server = app.listen(PORT, () => {
    console.log(`[Tezlify WA-Gateway] Running on http://localhost:${PORT}`);
    // Auto-restore saved sessions if any exist
    restoreSavedSessions().catch(err => {
        console.warn('[WA-Gateway] Session auto-restore error:', err.message);
    });
});

// Graceful process shutdown handling
process.on('SIGTERM', async () => {
    console.log('[WA-Gateway] SIGTERM received, shutting down all sessions cleanly...');
    await shutdownAllSessions();
    server.close(() => {
        process.exit(0);
    });
});

process.on('SIGINT', async () => {
    console.log('[WA-Gateway] SIGINT received, shutting down all sessions cleanly...');
    await shutdownAllSessions();
    server.close(() => {
        process.exit(0);
    });
});
