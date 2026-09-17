/**
 * Tezlify WhatsApp Gateway — Baileys-based WhatsApp Web bridge.
 *
 * This service connects to WhatsApp Web via QR pairing (multi-device),
 * persists sessions in an encrypted PostgreSQL store, and exposes a REST + WebSocket API for the
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
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { createPostgresAuthRepository } from './auth/postgres-auth-repository.js';
import { createPostgresEventOutbox } from './outbox/postgres-event-outbox.js';
import { createGatewayPostgresPool } from './database/postgres-pool.js';
import { createPostgresSessionLease } from './lease/postgres-session-lease.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.GATEWAY_PORT || '8787', 10);
const HOST = process.env.GATEWAY_HOST || '127.0.0.1';
const BACKEND_WS_URL = process.env.BACKEND_WS_URL || 'ws://127.0.0.1:8000/ws/gateway';
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(__dirname, '..', 'sessions');
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, '..', 'media');
const ENCRYPTION_KEY = process.env.GATEWAY_ENCRYPTION_KEY;
const DATABASE_URL = (process.env.GATEWAY_DATABASE_URL || process.env.DATABASE_URL || '')
  .replace('postgresql+asyncpg://', 'postgresql://');
// Durable Postgres auth is mandatory by default. Local development may
// explicitly opt into the filesystem fallback with REQUIRE_DURABLE_AUTH=false,
// but a misconfigured deployment must fail at startup rather than lose
// sessions on a restart.
const durableAuthDefault = 'true';
const REQUIRE_DURABLE_AUTH = String(process.env.REQUIRE_DURABLE_AUTH ?? durableAuthDefault).toLowerCase() === 'true';

if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length < 32) {
  throw new Error('GATEWAY_ENCRYPTION_KEY must be set to a secret of at least 32 characters.');
}

// Ensure directories exist
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// Derive a 32-byte AES key from the configured passphrase
const aesKey = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();

let authRepository = null;
let eventOutbox = null;
let leaseRepository = null;
let gatewayPool = null;
const instanceId = crypto.randomUUID();
if (DATABASE_URL) {
  gatewayPool = createGatewayPostgresPool(
    DATABASE_URL,
    parseInt(process.env.GATEWAY_DATABASE_POOL_MAX || '3', 10),
  );
  authRepository = createPostgresAuthRepository({
    encryptionKey: aesKey,
    pool: gatewayPool,
  });
  let lastError = null;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      await authRepository.assertReady();
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (lastError) throw new Error('Durable WhatsApp auth store is unavailable.', { cause: lastError });
  eventOutbox = createPostgresEventOutbox({
    encryptionKey: aesKey,
    pool: gatewayPool,
  });
  leaseRepository = createPostgresSessionLease({
    pool: gatewayPool,
    ttlSeconds: parseInt(process.env.GATEWAY_LEASE_TTL_SECONDS || '45', 10),
  });
} else if (REQUIRE_DURABLE_AUTH) {
  throw new Error('Durable WhatsApp auth is required but GATEWAY_DATABASE_URL is not configured.');
}

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
  authRepository,
  leaseRepository,
  instanceId,
  pool: gatewayPool,
});

const autoRestore = process.env.WHATSAPP_AUTO_RESTORE !== 'false' && process.env.WHATSAPP_AUTO_RESTORE !== '0';
if (autoRestore) {
  await sessionManager.restoreSessions({
    concurrency: Math.max(1, Math.min(5, parseInt(process.env.GATEWAY_RESTORE_CONCURRENCY || '2', 10))),
  });
} else {
  console.log('[gateway] WhatsApp automatic session restore is disabled by WHATSAPP_AUTO_RESTORE=false.');
}

// ---------------------------------------------------------------------------
// Event Bridge — forwards Baileys events to FastAPI backend via WebSocket
// ---------------------------------------------------------------------------
const eventBridge = createEventBridge({
  backendWsUrl: BACKEND_WS_URL,
  sessionManager,
  eventOutbox,
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

// Get session details / status
app.get('/sessions/:id', (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json({
    id: session.id,
    session_name: session.session_name,
    status: session.status,
    phone_number: session.phone_number || null,
    self_jid: session.self_jid || null,
    self_lid: session.self_lid || null,
    is_active: session.is_active,
    is_phone_online: session.is_phone_online || false,
    battery_level: session.battery_level ?? null,
    error_message: session.error_message || null,
    qr_code: session.status === 'SCAN_QR' ? session.qr_code : null,
    sync: session.sync || { phase: 'idle' },
    created_at: session.created_at,
    updated_at: session.updated_at,
  });
});

// Create a new session (returns QR code as data URI)
app.post('/sessions', async (req, res) => {
  try {
    const { name, ephemeral } = req.body || {};
    const session = await sessionManager.createSession(name || `hat-${Date.now()}`, {
      ephemeral: Boolean(ephemeral),
    });
    res.status(201).json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Refresh contact avatar from WhatsApp
app.post('/sessions/:id/avatar/refresh', async (req, res) => {
  try {
    const { jid } = req.body || {};
    if (!jid) return res.status(400).json({ error: 'jid is required' });
    const result = await sessionManager.refreshAvatar(req.params.id, jid);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Explicitly trigger session restoration (used for controlled cutover)
app.post('/sessions/restore', async (req, res) => {
  try {
    const concurrency = Math.max(1, Math.min(5, parseInt(req.query.concurrency || process.env.GATEWAY_RESTORE_CONCURRENCY || '2', 10)));
    const result = await sessionManager.restoreSessions({ concurrency });
    res.json({ status: 'ok', ...result });
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

// ---------------------------------------------------------------------------
// Veri düzlemi — HEPSİ OTURUM KAPSAMLI (güvenlik düzeltmesi).
//
// Bu uçlar eskiden `/contacts`, `/conversations/:jid/...` gibi oturumsuz
// yollardı ve gateway "bağlı olan tek oturumu" seçiyordu. Çağıranın kimliği
// hiç sorulmadığı için bir kiracının isteği, bağlı olan BAŞKA bir kiracının
// hattından veri okuyup mesaj gönderebiliyordu. Artık hangi hattın
// kastedildiği yolda AÇIKÇA belirtilir; backend çağırmadan önce oturumun
// gerçekten o kullanıcıya ait olduğunu doğrular.
// ---------------------------------------------------------------------------

// Oturumu çözer; yoksa 404 döner (fail-closed — varsayılan hat seçilmez).
function withSession(handler) {
  return async (req, res) => {
    const sessionId = req.params.sessionId;
    if (!sessionManager.getSession(sessionId)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    try {
      await handler(req, res, sessionId);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

// List contacts for one session (synced from WhatsApp)
app.get('/sessions/:sessionId/contacts', withSession(async (req, res, sessionId) => {
  res.json({ contacts: sessionManager.listContacts(sessionId) });
}));

// List conversations (chats) for one session
app.get('/sessions/:sessionId/conversations', withSession(async (req, res, sessionId) => {
  const { search, limit, offset } = req.query;
  res.json(sessionManager.listConversations(sessionId, {
    search,
    limit: limit ? parseInt(limit, 10) : undefined,
    offset: offset ? parseInt(offset, 10) : undefined,
  }));
}));

// Faz 8: grup başlıklarını (subject) toplu çöz — backend sync akışı çağırır
// (oturum başına 10 dk TTL + in-flight koruması içeride).
// Faz 10 (P1): body.force=true TTL'i atlar — "Eşitle" her basışta çözülememiş
// grupları yeniden dener (cache poisoning: "Grup" asla kalıcı değer olmaz).
app.post('/sessions/:sessionId/conversations/sync-groups', withSession(async (req, res, sessionId) => {
  const force = req.body && req.body.force === true;
  const result = await sessionManager._ensureGroupSubjects({ sessionId, force });
  // Faz 13 (truthfulness): cozumleme yapilmadiysa SAHTE basari donme.
  res.json({ success: true, force, applied: result ? result.applied : false, reason: result ? result.reason : null });
}));

// Faz 10 (P5): toplu gecmis kanali — backend initial-sync job'i sohbet basina
// ayri ayri HTTP turu atmak yerine bunu kullanir (deterministik offset sayfalama).
// Sorun 1: `perChatLimit` verildiginde her sohbet icin yalnizca en yeni N mesaj
// dondurulur — ilk senkronun maliyetini sinirlar; gecmis lazy hydration ile gelir.
app.get('/sessions/:sessionId/messages/bulk', withSession(async (req, res, sessionId) => {
  const { limit, offset, since, perChatLimit } = req.query;
  res.json(sessionManager.listAllMessages(sessionId, {
    limit: limit ? parseInt(limit, 10) : 1000,
    offset: offset ? parseInt(offset, 10) : 0,
    // Faz 6 (P0.13): opsiyonel delta suucusu (epoch saniye).
    since: since !== undefined && since !== '' ? parseInt(since, 10) : null,
    perChatLimit: perChatLimit !== undefined && perChatLimit !== '' ? parseInt(perChatLimit, 10) : null,
  }));
}));

// Get messages for a conversation (jid) within one session
app.get('/sessions/:sessionId/conversations/:jid/messages', withSession(async (req, res, sessionId) => {
  const { limit, before, fetch_provider, oldest_msg_id, oldest_msg_from_me, oldest_msg_timestamp_ms } = req.query;
  const pageSize = limit ? parseInt(limit, 10) : 50;
  const messages = await sessionManager.getMessages(sessionId, req.params.jid, {
    limit: pageSize,
    before: before ? parseInt(before, 10) : undefined,
    fetchProvider: fetch_provider === 'true' || fetch_provider === '1',
    oldestMsgId: oldest_msg_id,
    oldestMsgFromMe: oldest_msg_from_me !== undefined ? (oldest_msg_from_me === 'true' || oldest_msg_from_me === '1') : undefined,
    oldestMsgTimestampMs: oldest_msg_timestamp_ms ? parseInt(oldest_msg_timestamp_ms, 10) : undefined,
  });
  res.json({ messages, has_more: messages.length === pageSize });
}));

// Request older history explicitly via provider
app.post('/sessions/:sessionId/conversations/:jid/history', withSession(async (req, res, sessionId) => {
  const { count, oldest_msg_id, oldest_msg_from_me, oldest_msg_timestamp_ms, before, timeout_ms } = req.body || {};
  const result = await sessionManager.requestOlderHistory(sessionId, req.params.jid, {
    count: count ? parseInt(count, 10) : 50,
    oldestMsgId: oldest_msg_id,
    oldestMsgFromMe: oldest_msg_from_me,
    oldestMsgTimestampMs: oldest_msg_timestamp_ms,
    before: before ? parseInt(before, 10) : undefined,
    timeoutMs: timeout_ms ? parseInt(timeout_ms, 10) : undefined,
  });
  res.json(result);
}));

// Send a text message from one session
app.post('/sessions/:sessionId/conversations/:jid/messages', withSession(async (req, res, sessionId) => {
  const { body, client_message_id } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'Message body is required' });
  const result = await sessionManager.sendTextMessage(sessionId, req.params.jid, body.trim(), client_message_id);
  res.status(201).json(result);
}));

// Send media (URL or base64 payload from the backend/frontend uploader)
app.post('/sessions/:sessionId/conversations/:jid/media', withSession(async (req, res, sessionId) => {
  const { media_type, media_url, media_base64, mime_type, caption, filename, client_message_id } = req.body || {};
  if (!media_url && !media_base64) return res.status(400).json({ error: 'media_url or media_base64 is required' });
  const result = await sessionManager.sendMediaMessage(sessionId, req.params.jid, {
    media_type,
    media_url,
    media_base64,
    mime_type,
    caption,
    filename,
    client_message_id,
  });
  res.status(201).json(result);
}));

// Typing indicator ("yazıyor…")
app.post('/sessions/:sessionId/conversations/:jid/typing', withSession(async (req, res, sessionId) => {
  const { typing = true, duration_ms = 4000 } = req.body || {};
  const result = await sessionManager.sendTyping(sessionId, req.params.jid, !!typing, parseInt(duration_ms, 10) || 4000);
  res.json(result);
}));

// Mark conversation as read
app.post('/sessions/:sessionId/conversations/:jid/read', withSession(async (req, res, sessionId) => {
  const result = await sessionManager.markConversationRead(sessionId, req.params.jid);
  res.json(result);
}));

// Download media by media_id — yalnızca medyayı indiren oturuma servis edilir.
app.get('/sessions/:sessionId/media/:mediaId', withSession(async (req, res, sessionId) => {
  const filePath = sessionManager.getMediaPath(sessionId, req.params.mediaId);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Media not found' });
  res.sendFile(filePath);
}));

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

async function shutdown(signal) {
  console.log(`[gateway] ${signal} received; shutting down.`);
  eventBridge.close();
  await sessionManager.shutdown();
  await new Promise((resolve) => server.close(resolve));
  if (eventOutbox) await eventOutbox.close();
  if (leaseRepository) await leaseRepository.close();
  if (authRepository) await authRepository.close();
  if (gatewayPool) await gatewayPool.end();
  process.exit(0);
}

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
