const express = require('express');
const cors = require('cors');
const {
    activeSessions,
    getOrCreateSession,
    refreshSessionQR,
    requestPairingCode,
    sendMessage,
    disconnectSession,
    restoreSavedSessions,
    getSessionChats,
    syncSessionHistoryToBackend
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

// Create new session / Trigger QR pairing
app.post('/api/sessions/create', async (req, res) => {
    const { sessionName } = req.body;
    if (!sessionName) {
        return res.status(400).json({ error: 'sessionName is required' });
    }

    try {
        let session = activeSessions.get(sessionName);
        if (!session || session.status !== 'CONNECTED') {
            session = await refreshSessionQR(sessionName);
        }
        res.json({
            message: 'Session initialized',
            session: {
                name: session.name,
                status: session.status,
                phone: session.phone,
                qrImage: session.qrImage
            }
        });
    } catch (err) {
        console.error(`[WA-Gateway] Error creating session ${sessionName}:`, err);
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
            qrImage: session.qrImage
        });
    } catch (err) {
        console.error(`[WA-Gateway] Error refreshing QR for ${sessionName}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// Get session QR Code
app.get('/api/sessions/:sessionName/qr', (req, res) => {
    const { sessionName } = req.params;
    const session = activeSessions.get(sessionName);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
        name: session.name,
        status: session.status,
        phone: session.phone,
        qrImage: session.qrImage
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
    const session = activeSessions.get(sessionName);
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

// Get all tracked chats for session
app.get('/api/sessions/:sessionName/chats', async (req, res) => {
    const { sessionName } = req.params;
    try {
        const chats = await getSessionChats(sessionName);
        res.json(chats);
    } catch (err) {
        console.error(`[WA-Gateway] Failed to get chats for ${sessionName}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// Trigger on-demand sync of session history to backend
app.post('/api/sessions/:sessionName/sync', async (req, res) => {
    const { sessionName } = req.params;
    try {
        const result = await syncSessionHistoryToBackend(sessionName);
        res.json(result);
    } catch (err) {
        console.error(`[WA-Gateway] Sync failed for ${sessionName}:`, err.message);
        res.status(500).json({ error: err.message });
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
    const { session = 'default', phone, message, typingDelayMs = 0 } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ error: 'phone and message are required' });
    }

    try {
        const result = await sendMessage(session, phone, message, typingDelayMs);
        res.json(result);
    } catch (err) {
        console.error(`[WA-Gateway] Send failed for ${phone}:`, err.message);
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`[Tezlify WA-Gateway] Running on http://localhost:${PORT}`);
    // Auto-restore saved sessions if any exist
    restoreSavedSessions().catch(err => {
        console.warn('[WA-Gateway] Session auto-restore error:', err.message);
    });
});
