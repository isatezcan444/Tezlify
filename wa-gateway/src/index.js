const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// In-memory session registry
const sessions = new Map();

// Initialize default mock session
sessions.set("default", {
    name: "default",
    status: "CONNECTED",
    phone: "+905321002030",
    connectedAt: new Date().toISOString(),
    messagesSent: 12
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'Tezlify WhatsApp Gateway',
        activeSessions: sessions.size
    });
});

// List sessions
app.get('/api/sessions', (req, res) => {
    res.json(Array.from(sessions.values()));
});

// Create new session & generate QR
app.post('/api/sessions/create', async (req, res) => {
    const { sessionName } = req.body;
    if (!sessionName) {
        return res.status(400).json({ error: 'sessionName is required' });
    }

    const qrData = `2@tezlify_${sessionName}_${Date.now()}_pairing_code`;
    const qrImageBase64 = await QRCode.toDataURL(qrData);

    const sessionObj = {
        name: sessionName,
        status: 'SCAN_QR',
        qrData: qrData,
        qrImage: qrImageBase64,
        createdAt: new Date().toISOString(),
        messagesSent: 0
    };

    sessions.set(sessionName, sessionObj);

    res.json({
        message: 'QR Code generated for session pairing',
        session: sessionObj
    });
});

// Send Message endpoint with typing delay simulation
app.post('/api/send', async (req, res) => {
    const { session = "default", phone, message, typingDelayMs = 4000 } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ error: 'phone and message are required' });
    }

    const sessionData = sessions.get(session) || sessions.get("default");

    // Simulate realistic typing delay
    if (typingDelayMs > 0) {
        const sleepTime = Math.min(typingDelayMs, 3000); // cap simulation
        await new Promise(resolve => setTimeout(resolve, sleepTime));
    }

    const messageId = `wa_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

    if (sessionData) {
        sessionData.messagesSent = (sessionData.messagesSent || 0) + 1;
    }

    res.json({
        success: true,
        messageId: messageId,
        phone: phone,
        status: 'SENT',
        timestamp: new Date().toISOString()
    });
});

app.listen(PORT, () => {
    console.log(`[Tezlify WA-Gateway] Running on http://localhost:${PORT}`);
});
