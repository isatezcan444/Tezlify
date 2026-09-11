/**
 * Tezlify WhatsApp Gateway — Baileys-based WhatsApp Web bridge.
 *
 * This service connects to WhatsApp Web via QR pairing (multi-device),
 * persists sessions locally, and exposes a REST + WebSocket API for the
 * FastAPI backend to consume. It forwards realtime events (messages,
 * contacts, chats, presence) to the backend via WebSocket.
 *
 * Security: This service binds to 127.0.0.1 by default and is intended
 * to be reachable ONLY by the FastAPI backend (private network / same host).
 * It stores NO credentials in plain text — Baileys auth state is encrypted
 * with a key derived from GATEWAY_ENCRYPTION_KEY.
 */
import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { createSessionManager } from './session-manager.js';
import { createEventBridge } from './events.js';
import { createMediaRouter } from './media.js';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.GATEWAY_PORT || '8787', 10);
const HOST = process.env.GATEWAY_HOST || '127.0.0.1';
const BACKEND_WS_URL = process.env.BACKEND_WS_URL || 'ws://127.0.0.1:8000/ws/gateway';
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(__dirname, '..', 'sessions');
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, '..', 'media');
const ENCRYPTION_KEY = process.env.GATEWAY_ENCRYPTION_KEY;

if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length < 32) {
  throw new Error('GATEWAY_ENCRYPTION_KEY must be set to a secret of at least 32 characters.');
}

// Ensure directories exist
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// Derive a 32-byte AES key from the configured passphrase
const aesKey = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();

const app = express();
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---------------------------------------------------------------------------
// Session Manager (Baileys)
// ---------------------------------------------------------------------------
const sessionManager = createSessionManager({
  sessionsDir: SESSIONS_DIR,
  mediaDir: MEDIA_DIR,
  aesKey,
  backendWsUrl: BACKEND_WS_URL,
});

// ---------------------------------------------------------------------------
// Event Bridge — forwards Baileys events to FastAPI backend via WebSocket
// ---------------------------------------------------------------------------
const eventBridge = createEventBridge({
  backendWsUrl: BACKEND_WS_URL,
  sessionManager,
});

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

// Health check
app.get('/health', (_req, res) => {
  const sessions = sessionManager.listSessions();
  const connected = sessions.filter((s) => s.status === 'CONNECTED').length;
  const pending = sessions.filter((s) => s.status === 'SCAN_QR').length;
  res.json({
    status: 'ok',
    service: 'tezlify-whatsapp-gateway',
    sessions: { total: sessions.length, connected, pending_qr: pending },
  });
});

// List sessions
app.get('/sessions', (_req, res) => {
  res.json({ sessions: sessionManager.listSessions() });
});

// Create a new session (returns QR code as data URI)
app.post('/sessions', async (req, res) => {
  try {
    const { name } = req.body || {};
    const session = await sessionManager.createSession(name || `hat-${Date.now()}`);
    res.status(201).json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get session QR (if still in SCAN_QR state)
app.get('/sessions/:id/qr', (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status === 'CONNECTED') {
    return res.json({ status: session.status, qr_code: null, phone: session.phone_number || null, error_message: null });
  }
  res.json({
    status: session.status,
    qr_code: session.qr_code || null,
    phone: session.phone_number || null,
    error_message: session.error_message || null,
  });
});

// Refresh QR code
app.post('/sessions/:id/qr/refresh', async (req, res) => {
  try {
    const session = await sessionManager.refreshQr(req.params.id);
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pairing code — "Telefon Numarası ile Bağlan" (8 haneli kod üretir)
app.post('/sessions/:id/pair', async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone || !String(phone).trim()) {
      return res.status(400).json({ error: 'Telefon numarası zorunludur.' });
    }
    const result = await sessionManager.requestPairingCode(req.params.id, phone);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disconnect / logout a session
app.post('/sessions/:id/logout', async (req, res) => {
  try {
    await sessionManager.logoutSession(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a session
app.delete('/sessions/:id', async (req, res) => {
  try {
    await sessionManager.deleteSession(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all contacts (synced from WhatsApp)
app.get('/contacts', (req, res) => {
  res.json({ contacts: sessionManager.listContacts() });
});

// List conversations (chats)
app.get('/conversations', (req, res) => {
  const { search, limit, offset } = req.query;
  res.json(sessionManager.listConversations({ search, limit: limit ? parseInt(limit, 10) : undefined, offset: offset ? parseInt(offset, 10) : undefined }));
});

// Get messages for a conversation (jid)
app.get('/conversations/:jid/messages', async (req, res) => {
  try {
    const { limit, before } = req.query;
    const messages = await sessionManager.getMessages(req.params.jid, {
      limit: limit ? parseInt(limit, 10) : 50,
      before: before ? parseInt(before, 10) : undefined,
    });
    res.json({ messages, has_more: messages.length === (limit ? parseInt(limit, 10) : 50) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send a text message
app.post('/conversations/:jid/messages', async (req, res) => {
  try {
    const { body, client_message_id } = req.body || {};
    if (!body || !body.trim()) return res.status(400).json({ error: 'Message body is required' });
    const result = await sessionManager.sendTextMessage(req.params.jid, body.trim(), client_message_id);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send media (URL or base64 payload from the backend/frontend uploader)
app.post('/conversations/:jid/media', async (req, res) => {
  try {
    const { media_type, media_url, media_base64, mime_type, caption, filename, client_message_id } = req.body || {};
    if (!media_url && !media_base64) return res.status(400).json({ error: 'media_url or media_base64 is required' });
    const result = await sessionManager.sendMediaMessage(req.params.jid, {
      media_type,
      media_url,
      media_base64,
      mime_type,
      caption,
      filename,
      client_message_id,
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Typing indicator ("yazıyor…")
app.post('/conversations/:jid/typing', async (req, res) => {
  try {
    const { typing = true, duration_ms = 4000 } = req.body || {};
    const result = await sessionManager.sendTyping(req.params.jid, !!typing, parseInt(duration_ms, 10) || 4000);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark conversation as read
app.post('/conversations/:jid/read', async (req, res) => {
  try {
    await sessionManager.markConversationRead(req.params.jid);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download media by media_id
app.get('/media/:mediaId', (req, res) => {
  const filePath = sessionManager.getMediaPath(req.params.mediaId);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Media not found' });
  res.sendFile(filePath);
});

// Media router (handles incoming media storage)
app.use('/media', createMediaRouter({ mediaDir: MEDIA_DIR, sessionManager }));

// ---------------------------------------------------------------------------
// WebSocket — realtime events to connected clients (FastAPI backend)
// ---------------------------------------------------------------------------
wss.on('connection', (ws) => {
  eventBridge.attachClient(ws);
  ws.on('close', () => eventBridge.detachClient(ws));
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
server.listen(PORT, HOST, () => {
  console.log(`[gateway] Tezlify WhatsApp Gateway listening on http://${HOST}:${PORT}`);
  console.log(`[gateway] WebSocket endpoint: ws://${HOST}:${PORT}/ws`);
  console.log(`[gateway] Sessions dir: ${SESSIONS_DIR}`);
  console.log(`[gateway] Media dir: ${MEDIA_DIR}`);
});
