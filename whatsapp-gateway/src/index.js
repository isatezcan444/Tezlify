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
import { createSessionManager, logger } from './session-manager.js';
import { countCachedMessages } from './messages/message-store.js';
import { createEventBridge } from './events.js';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { requireGatewayToken, verifyWsToken } from './security/gateway-auth.js';
import { registerMediaRoutes } from './media/media-routes.js';
import { createPostgresAuthRepository } from './auth/postgres-auth-repository.js';
import { createPostgresEventOutbox } from './outbox/postgres-event-outbox.js';
import { createGatewayPostgresPool } from './database/postgres-pool.js';
import { createPostgresSessionLease } from './lease/postgres-session-lease.js';
import {
  installEgressFirewall,
  getEgressAuditStats,
  resetEgressAuditStats,
  probeEgress,
} from './security/egress-firewall.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// G-2: `logger` bir zamanlar burada hic tanimli degildi; `logger.warn`
// ReferenceError firlatip ASIL LID hatasini maskeliyordu. Artik gateway'in TEK
// pino logger'i `session-manager.js`'ten import edilir — ikinci bir pino
// ornegi/abstraksiyonu YOK. Global `console` degistirilmez; token/secret
// loglanmaz.
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

const isTestModeAllowed = process.env.GATEWAY_TEST_MODE === 'true' && process.env.NODE_ENV !== 'production';
if (isTestModeAllowed || process.env.GATEWAY_EGRESS_FIREWALL === 'strict') {
  installEgressFirewall();
  console.log('[gateway] Network Egress Firewall active (fail-closed strict loopback isolation)');
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
    onLidMappingDiscovered: (sessionId, lidJid, phoneJid) => {
      try {
        const session = sessionManager.getSession(sessionId);
        if (session) {
          sessionManager._applyLidMapping(session, lidJid, phoneJid);
        }
      } catch (err) {
        logger.warn({ err: err?.message, sessionId, lidJid, phoneJid }, 'Failed to apply discovered LID mapping');
      }
    },
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
    // Re-pairing deletes the old whatsapp_sessions row while this in-memory
    // session keeps emitting. Marking it here is what lets the UI say "this
    // session is not being stored" instead of the operator discovering it as
    // missing history days later.
    onOrphaned: (sessionId, detail) => {
      sessionManager.markOrphaned(sessionId, detail);
    },
  });
  leaseRepository = createPostgresSessionLease({
    pool: gatewayPool,
    ttlSeconds: parseInt(process.env.GATEWAY_LEASE_TTL_SECONDS || '45', 10),
  });
} else if (REQUIRE_DURABLE_AUTH) {
  throw new Error('Durable WhatsApp auth is required but GATEWAY_DATABASE_URL is not configured.');
}

const app = express();
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

const server = http.createServer(app);
// noServer mode: the raw HTTP upgrade is inspected below so we can reject
// unauthenticated WebSocket clients BEFORE the socket is attached.
const wss = new WebSocketServer({ noServer: true });

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

// Health check — the ONLY unauthenticated route (returns counts, no secrets).
app.get('/health', async (_req, res) => {
  const sessions = sessionManager.listSessions();
  const connected = sessions.filter((s) => s.status === 'CONNECTED').length;
  const pending = sessions.filter((s) => s.status === 'SCAN_QR').length;
  let dbOk = true;
  let poolStats = null;
  if (gatewayPool) {
    try {
      // Bounded 1500ms probe: so high sync pool load never stalls health checks
      await Promise.race([
        gatewayPool.query('SELECT 1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('db_probe_timeout')), 1500)),
      ]);
      poolStats = { total: gatewayPool.totalCount, idle: gatewayPool.idleCount, waiting: gatewayPool.waitingCount };
    } catch {
      // If pool has active clients (totalCount > 0), mark as busy rather than completely down
      if (gatewayPool.totalCount > 0) {
        dbOk = true;
        poolStats = { total: gatewayPool.totalCount, idle: gatewayPool.idleCount, waiting: gatewayPool.waitingCount, busy: true };
      } else {
        dbOk = false;
      }
    }
  }
  const isHealthy = dbOk;
  // An orphaned session is not a gateway fault: the service is fine, but one
  // session's events are going nowhere. Reported separately from `status` so a
  // monitoring check that only looks at the status code is not silenced, while
  // the admin UI can still show the operator exactly what is not being stored.
  const orphaned = sessionManager.listOrphaned();
  // WHATSAPP_AUTO_RESTORE is deliberately disabled in production, so a gateway
  // restart leaves ZERO live sessions while the database still says CONNECTED.
  // That combination is the confusing one: the UI reports a healthy line that
  // cannot receive anything. Exposing the reason is what lets the admin screen
  // explain it instead of leaving the operator to guess.
  const liveSessions = sessionManager.listSessions();
  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'degraded',
    service: 'tezlify-whatsapp-gateway',
    database: gatewayPool ? (dbOk ? 'connected' : 'error') : 'disabled',
    pool: poolStats,
    sessions: { total: sessions.length, connected, pending_qr: pending },
    orphaned_sessions: orphaned.length,
    orphaned_detail: orphaned,
    auto_restore: autoRestore,
    // Session ids the gateway can actually serve. The backend compares these
    // against the rows it believes are CONNECTED to spot a line that is
    // "connected" only in the database.
    live_session_ids: liveSessions
      .filter((s) => s.status === 'CONNECTED')
      .map((s) => s.id),
    // RAM kapasitesi ve eviction görünürlüğü (P2-1). Bu blok EK'tir: mevcut
    // alanların hiçbiri değişmedi, yalnızca yeni bir anahtar eklendi.
    // Mesaj kimliği / gövdesi / telefon numarası YOKTUR — yalnızca sayımlar.
    capacity: sessionManager.ramCapacitySummary(),
    // Medya diski gözlemlenebilirliği: dosya/sidecar sayıları, boyut ve boş
    // alan. Bu blok yalnızca okuma amaçlıdır; hiçbir silme kararı üretmez.
    // İçerik, dosya adı veya yol bilgisi yoktur — yalnızca sayımlar.
    media_capacity: await sessionManager.mediaCapacitySummary(),
  });
});

// Security: every other REST route requires the shared gateway token
// (Authorization: Bearer <WHATSAPP_GATEWAY_SECRET> or ?token=...). Fail-closed:
// if the secret is not configured, all requests are rejected with 503.
app.use(requireGatewayToken);

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
    sync: session.sync ? {
      ...session.sync,
      chats_unique: Math.max(session.store?.chats ? session.store.chats.size : 0, session.sync.chats_unique || 0),
      chats_synced: Math.max(session.store?.chats ? session.store.chats.size : 0, session.sync.chats_synced || 0),
      contacts_unique: Math.max(session.store?.contacts ? session.store.contacts.size : 0, session.sync.contacts_unique || 0),
      contacts_synced: Math.max(session.store?.contacts ? session.store.contacts.size : 0, session.sync.contacts_synced || 0),
      messages_cached: Math.max(countCachedMessages(session.store), session.sync.messages_cached || 0),
    } : { phase: 'idle' },
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
    const { jid, force, priority } = req.body || {};
    if (!jid) return res.status(400).json({ error: 'jid is required' });
    const result = await sessionManager.refreshAvatar(req.params.id, jid, Boolean(force), priority || 'normal');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eksik sohbet avatarları için backfill sweep'i tetikler (WhatsApp Web
// paritesi: QR sonrası tüm profil fotoğrafları kademeli olarak iner).
// Sweep, eksik kalmayana dek backoff'lu turlarla çalışır (session-manager).
app.post('/sessions/:sessionId/avatars/backfill', withSession(async (req, res, sessionId) => {
  const force = Boolean(req.body && req.body.force);
  const result = sessionManager.requestAvatarBackfill(sessionId, force);
  res.json(result);
}));

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
    const force = req.body?.force === true;
    const result = await sessionManager.logoutSession(req.params.id, { force });
    res.json({ success: true, ...result });
  } catch (err) {
    // A failed logout is never reported as success. When the provider failed but
    // the local session was still closed, `local_status` lets the backend persist
    // the reconciled state without pretending the provider call worked.
    // `local_status`/`reason` come first: the backend truncates the response
    // body to 300 chars, and a long provider message must not hide the fields
    // that tell it the local session was already closed.
    const body = { success: false };
    if (err.localStatus) body.local_status = err.localStatus;
    if (err.logoutReason) body.reason = err.logoutReason;
    body.error = err.message;
    res.status(500).json(body);
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

// Fetch contact About / Status from WhatsApp via Baileys sock.fetchStatus
app.get('/sessions/:sessionId/contacts/:jid/status', withSession(async (req, res, sessionId) => {
  const { jid } = req.params;
  const session = sessionManager.getSession(sessionId);
  if (!session || !session.sock) {
    return res.status(404).json({ error: 'Session not connected' });
  }
  try {
    const rawJid = jid.includes('@') ? jid : `${jid.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    const result = await session.sock.fetchStatus(rawJid);
    const item = Array.isArray(result) ? result[0] : result;
    let statusText = null;
    let setAtTime = null;
    if (item) {
      if (typeof item === 'string') {
        statusText = item;
      } else if (typeof item.status === 'string') {
        statusText = item.status;
        setAtTime = item.setAt || null;
      } else if (item.status && typeof item.status === 'object') {
        statusText = typeof item.status.status === 'string'
          ? item.status.status
          : typeof item.status.text === 'string'
            ? item.status.text
            : null;
        setAtTime = item.status.setAt || item.setAt || null;
      } else if (typeof item.text === 'string') {
        statusText = item.text;
        setAtTime = item.setAt || null;
      }
    }
    if (!statusText && session.store?.contacts) {
      const stored = session.store.contacts.get(rawJid);
      if (stored?.status && typeof stored.status === 'string') {
        statusText = stored.status;
      }
    }
    if (statusText && typeof statusText === 'string') {
      statusText = statusText.trim();
      if (!statusText) statusText = null;
    }
    return res.json({
      status: statusText,
      setAt: setAtTime,
    });
  } catch (err) {
    return res.json({ status: null, error: err.message });
  }
}));

// Group participants & metadata
app.get('/sessions/:sessionId/groups/:jid/participants', withSession(async (req, res, sessionId) => {
  try {
    const result = await sessionManager.getGroupMetadata(sessionId, req.params.jid);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Update group description
app.patch('/sessions/:sessionId/groups/:jid/description', withSession(async (req, res, sessionId) => {
  try {
    const { description } = req.body || {};
    const result = await sessionManager.updateGroupDescription(sessionId, req.params.jid, description);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Update group subject (title)
app.patch('/sessions/:sessionId/groups/:jid/subject', withSession(async (req, res, sessionId) => {
  try {
    const { subject } = req.body || {};
    const result = await sessionManager.updateGroupSubject(sessionId, req.params.jid, subject);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Leave group
app.post('/sessions/:sessionId/groups/:jid/leave', withSession(async (req, res, sessionId) => {
  try {
    const result = await sessionManager.leaveGroup(sessionId, req.params.jid);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Update group participants (add, remove, promote, demote)
app.post('/sessions/:sessionId/groups/:jid/participants', withSession(async (req, res, sessionId) => {
  try {
    const { action, participants } = req.body || {};
    const result = await sessionManager.updateGroupParticipants(sessionId, req.params.jid, participants, action);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Update group profile picture (avatar)
app.post('/sessions/:sessionId/groups/:jid/avatar', withSession(async (req, res, sessionId) => {
  try {
    const { image_base64 } = req.body || {};
    if (!image_base64) {
      return res.status(400).json({ error: 'image_base64 is required' });
    }
    const cleanBase64 = String(image_base64).replace(/^data:image\/[a-z]+;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');
    const result = await sessionManager.updateGroupProfilePicture(sessionId, req.params.jid, buffer);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Remove group profile picture (avatar)
app.delete('/sessions/:sessionId/groups/:jid/avatar', withSession(async (req, res, sessionId) => {
  try {
    const result = await sessionManager.removeGroupProfilePicture(sessionId, req.params.jid);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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
  // Phase 2.1.A: optional DB-known @g.us jid list forwarded by the backend
  // bootstrap. The list is the source of truth for known groups whose
  // subjects the gateway has not yet been able to resolve (zero-message
  // groups, archived groups, etc.). The list is generic — it is not a
  // hardcoded fixture and it does not replace `groupFetchAllParticipating`.
  const rawExtraJids = (req.body && Array.isArray(req.body.extraJids)) ? req.body.extraJids : [];
  const extraJids = rawExtraJids
    .map((j) => (typeof j === 'string' ? j.trim() : ''))
    .filter((j) => j && j.includes('@g.us'))
    .slice(0, 200);
  const result = await sessionManager._ensureGroupSubjects({ sessionId, force, extraJids });
  const applied = result ? result.applied : false;
  res.json({ success: applied, force, applied, reason: result ? result.reason : null, extraJids_count: extraJids.length });
}));

app.post('/sessions/:sessionId/resync-app-state', withSession(async (req, res, sessionId) => {
  const result = await sessionManager.resyncAppState(sessionId);
  res.json(result);
}));

// Faz 10 (P5): toplu gecmis kanali — backend initial-sync job'i sohbet basina
// ayri ayri HTTP turu atmak yerine bunu kullanir (deterministik offset sayfalama).
// Sorun 1: `perChatLimit` verildiginde her sohbet icin yalnizca en yeni N mesaj
// dondurulur — ilk senkronun maliyetini sinirlar; gecmis lazy hydration ile gelir.
app.get('/sessions/:sessionId/messages/bulk', withSession(async (req, res, sessionId) => {
  const { limit, offset, since, perChatLimit, jids, afterSeq, seqEpoch } = req.query;
  res.json(sessionManager.listAllMessages(sessionId, {
    limit: limit ? parseInt(limit, 10) : 1000,
    offset: offset ? parseInt(offset, 10) : 0,
    // Faz 6 (P0.13): opsiyonel delta suucusu (epoch saniye).
    since: since !== undefined && since !== '' ? parseInt(since, 10) : null,
    perChatLimit: perChatLimit !== undefined && perChatLimit !== '' ? parseInt(perChatLimit, 10) : null,
    // Kapsamli geri doldurma: `since` suucunun disladigi sohbetler icin
    // yalnizca bu jid'ler sorulur (virgulle ayrilmis). Bos/verilmemis →
    // davranis degismez (tum sohbetler).
    jids: jids !== undefined && jids !== '' ? String(jids).split(',').filter(Boolean) : null,
    // Sabit (keyset) sayfalama: `afterSeq` bir KONUM değil, ekleme anında
    // atanmış benzersiz bir sıra DEĞERİdir. Liste başından eviction olduğunda
    // kaymaz; `seqEpoch` süreç yeniden kurulduğunda imlecin sıfırlanmasını
    // sağlar. İki parametre de opsiyoneldir — verilmezse eski `offset`
    // davranışı AYNEN korunur.
    afterSeq: afterSeq !== undefined && afterSeq !== '' ? parseInt(afterSeq, 10) : null,
    seqEpoch: seqEpoch !== undefined && seqEpoch !== '' ? String(seqEpoch) : null,
  }));
}));

// Get messages for a conversation (jid) within one session
app.get('/sessions/:sessionId/conversations/:jid/messages', withSession(async (req, res, sessionId) => {
  const { limit, before, fetch_provider, oldest_msg_id, oldest_msg_from_me, oldest_msg_timestamp_ms, timeout_ms, request_id } = req.query;
  const pageSize = limit ? parseInt(limit, 10) : 50;
  const result = await sessionManager.getMessages(sessionId, req.params.jid, {
    limit: pageSize,
    before: before ? parseInt(before, 10) : undefined,
    fetchProvider: fetch_provider === 'true' || fetch_provider === '1',
    oldestMsgId: oldest_msg_id,
    oldestMsgFromMe: oldest_msg_from_me !== undefined ? (oldest_msg_from_me === 'true' || oldest_msg_from_me === '1') : undefined,
    oldestMsgTimestampMs: oldest_msg_timestamp_ms ? parseInt(oldest_msg_timestamp_ms, 10) : undefined,
    // Caller-supplied budget for waiting on the phone's history PDO. Absent ->
    // getMessages keeps its own 15 s default. Callers that already hold local
    // rows pass a short value so the pane is not blocked on a slow phone.
    timeoutMs: timeout_ms ? parseInt(timeout_ms, 10) : undefined,
    // Çağıranın ürettiği korelasyon kimliği. Loglarda istek/chunk/eşleşme
    // zincirini tek bir kimlikle birleştirir; yoksa da istek çalışır.
    requestId: request_id ? String(request_id).slice(0, 64) : undefined,
  });
  const messages = Array.isArray(result) ? result : (result?.messages || []);
  const providerStatus = result?.provider_status || 'NOT_REQUESTED';
  res.json({
    messages,
    has_more: messages.length === pageSize,
    provider_status: providerStatus,
  });
}));

// Get receipts for a specific message within one session
app.get('/sessions/:sessionId/conversations/:jid/messages/:messageId/receipts', withSession(async (req, res, sessionId) => {
  const receipts = sessionManager.getMessageReceipts(sessionId, req.params.jid, req.params.messageId);
  res.json({ success: true, receipts });
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
  const { body, client_message_id, quoted_wa_message_id, quoted_message_id, quoted } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'Message body is required' });
  const options = {
    quoted_wa_message_id,
    quoted_message_id,
    quoted,
  };
  const result = await sessionManager.sendTextMessage(sessionId, req.params.jid, body.trim(), client_message_id, options);
  res.status(201).json(result);
}));

// Send media (URL or base64 payload from the backend/frontend uploader)
app.post('/sessions/:sessionId/conversations/:jid/media', withSession(async (req, res, sessionId) => {
  const {
    media_type,
    media_url,
    media_base64,
    mime_type,
    caption,
    filename,
    client_message_id,
    view_once,
    is_view_once,
    quoted_wa_message_id,
    quoted_message_id,
    quoted,
  } = req.body || {};
  if (!media_url && !media_base64) return res.status(400).json({ error: 'media_url or media_base64 is required' });
  const result = await sessionManager.sendMediaMessage(sessionId, req.params.jid, {
    media_type,
    media_url,
    media_base64,
    mime_type,
    caption,
    filename,
    client_message_id,
    view_once: Boolean(view_once || is_view_once),
    is_view_once: Boolean(view_once || is_view_once),
    quoted_wa_message_id,
    quoted_message_id,
    quoted,
  });
  res.status(201).json(result);
}));

// Forward an existing message to this conversation
app.post('/sessions/:sessionId/conversations/:jid/forward', withSession(async (req, res, sessionId) => {
  const {
    source_jid,
    wa_message_id,
    body,
    media_type,
    media_id,
    media_url,
    media_base64,
    media_mime_type,
    media_filename,
    media_caption,
    client_message_id,
  } = req.body || {};
  const result = await sessionManager.forwardMessage(sessionId, req.params.jid, {
    source_jid,
    wa_message_id,
    body,
    media_type,
    media_id,
    media_url,
    media_base64,
    media_mime_type,
    media_filename,
    media_caption,
    client_message_id,
  });
  res.status(201).json(result);
}));

// React to an existing message (an empty `emoji` withdraws the reaction)
app.post('/sessions/:sessionId/conversations/:jid/reactions', withSession(async (req, res, sessionId) => {
  const { target_wa_message_id, target_from_me, emoji, participant_jid } = req.body || {};
  if (!target_wa_message_id) {
    return res.status(400).json({ error: 'target_wa_message_id is required' });
  }
  const result = await sessionManager.sendReaction(sessionId, req.params.jid, {
    target_wa_message_id,
    target_from_me,
    emoji,
    participant_jid,
  });
  res.status(201).json(result);
}));

// Pin or unpin an existing message
app.post('/sessions/:sessionId/conversations/:jid/pin', withSession(async (req, res, sessionId) => {
  const { target_wa_message_id, target_from_me, action = 'PIN', duration_seconds = 86400, participant_jid } = req.body || {};
  if (!target_wa_message_id) {
    return res.status(400).json({ error: 'target_wa_message_id is required' });
  }
  const result = await sessionManager.pinMessage(sessionId, req.params.jid, {
    target_wa_message_id,
    target_from_me,
    action,
    duration_seconds,
    participant_jid,
  });
  res.status(200).json(result);
}));

// Edit an existing message
app.post('/sessions/:sessionId/conversations/:jid/messages/:messageId/edit', withSession(async (req, res, sessionId) => {
  const { text, target_from_me = true } = req.body || {};
  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }
  const result = await sessionManager.editMessage(sessionId, req.params.jid, {
    target_wa_message_id: req.params.messageId,
    target_from_me,
    text,
  });
  res.status(200).json(result);
}));

// Delete an existing message (everyone or for_me)
app.delete('/sessions/:sessionId/conversations/:jid/messages/:messageId', withSession(async (req, res, sessionId) => {
  const deleteType = req.query.delete_type || req.body?.delete_type || 'everyone';
  const { target_from_me, participant_jid } = req.body || {};
  const result = await sessionManager.deleteMessage(sessionId, req.params.jid, {
    target_wa_message_id: req.params.messageId,
    target_from_me,
    participant_jid,
    delete_type: deleteType,
  });
  res.status(200).json(result);
}));

// Star or unstar an existing message
app.post('/sessions/:sessionId/conversations/:jid/messages/:messageId/star', withSession(async (req, res, sessionId) => {
  const { star = true, target_from_me, participant_jid } = req.body || {};
  const result = await sessionManager.starMessage(sessionId, req.params.jid, {
    target_wa_message_id: req.params.messageId,
    target_from_me,
    participant_jid,
    star: Boolean(star),
  });
  res.status(200).json(result);
}));

// Typing indicator ("yazıyor…")
app.post('/sessions/:sessionId/conversations/:jid/typing', withSession(async (req, res, sessionId) => {
  const { typing = true, duration_ms = 4000 } = req.body || {};
  const result = await sessionManager.sendTyping(sessionId, req.params.jid, !!typing, parseInt(duration_ms, 10) || 4000);
  res.json(result);
}));

// Subscribe to live presence updates ("yazıyor…", online status)
app.post('/sessions/:sessionId/conversations/:jid/presence/subscribe', withSession(async (req, res, sessionId) => {
  const result = await sessionManager.subscribePresence(sessionId, req.params.jid);
  res.json(result);
}));

// Mark conversation as read
app.post('/sessions/:sessionId/conversations/:jid/read', withSession(async (req, res, sessionId) => {
  const result = await sessionManager.markConversationRead(sessionId, req.params.jid);
  res.json(result);
}));

// Delete a conversation on WhatsApp itself (deleteChatAction app-state patch).
// This is the OUTBOUND half of delete sync: a local-only delete leaves the
// account's other devices (the phone) holding the chat, and the next history
// sync can bring it back. Session-scoped like every other data-plane route.
app.delete('/sessions/:sessionId/conversations/:jid', withSession(async (req, res, sessionId) => {
  const lastMessageHint = req.body?.last_message || null;
  const result = await sessionManager.deleteConversationRemote(sessionId, req.params.jid, lastMessageHint);
  res.json(result);
}));

// ---------------------------------------------------------------------------
// Media serving: verification and the response body share ONE open file
// descriptor (see media/media-routes.js). Path/file names are never put in
// responses or logs — only HTTP status codes and stable error codes.
// ---------------------------------------------------------------------------
registerMediaRoutes(app, { sessionManager, logger });

// ---------------------------------------------------------------------------
// WebSocket — realtime events to connected clients (FastAPI backend)
// ---------------------------------------------------------------------------
// Security: the upgrade request is authenticated BEFORE the socket is attached.
// Invalid/missing token → HTTP 401 on the upgrade; unset secret → fail-closed 503.
server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try {
    pathname = new URL(req.url || '', 'http://localhost').pathname;
  } catch {
    pathname = '';
  }
  if (pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!verifyWsToken(req)) {
    const secretConfigured = Boolean(process.env.WHATSAPP_GATEWAY_SECRET);
    const statusLine = secretConfigured ? '401 Unauthorized' : '503 Service Unavailable';
    socket.write(`HTTP/1.1 ${statusLine}\r\n\r\n`);
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  eventBridge.attachClient(ws);
  ws.on('close', () => eventBridge.detachClient(ws));
});

// ---------------------------------------------------------------------------
// Isolated Test Adapter (L4 Integration Testing — disabled by default in production)
// ---------------------------------------------------------------------------
if (isTestModeAllowed) {
  // Network Egress Audit & Probe Endpoints (Phase 8.0.11)
  app.get('/test/egress/audit', (_req, res) => {
    res.json(getEgressAuditStats());
  });

  app.post('/test/egress/reset', (_req, res) => {
    resetEgressAuditStats();
    res.json({ success: true, stats: getEgressAuditStats() });
  });

  app.post('/test/egress/probe', async (req, res) => {
    const { host = '1.1.1.1', port = 443 } = req.body || {};
    const result = await probeEgress(String(host), Number(port));
    res.json(result);
  });

  app.post('/test/sessions/register', async (req, res) => {
    const { id, session_name, phone_number } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });
    if (String(id) === '201' || String(session_name || '').includes('Hat 1')) {
      return res.status(403).json({ error: 'BLOCKED: PRODUCTION SESSION 201 IS STRICTLY PROTECTED' });
    }
    try {
      const registered = await sessionManager.registerTestSession(id, req.body);
      res.json({
        success: true,
        session: {
          id: registered.id,
          session_name: registered.session_name,
          status: registered.status,
          phone_number: registered.phone_number,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/test/events/emit', async (req, res) => {
    const event = req.body || {};
    const sid = String(event.gateway_session_id || event.session_id || '');
    if (sid === '201' || sid.includes('201')) {
      return res.status(403).json({ error: 'BLOCKED: PRODUCTION SESSION 201 IS STRICTLY PROTECTED' });
    }
    try {
      const result = await sessionManager._emit(event);
      res.json({ success: true, result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Baileys Provider Boundary Event Injection (Phase 8.0.9)
  // Emits directly on `session.sock.ev` to execute the real Baileys socket event handlers
  app.post('/test/provider/emit', async (req, res) => {
    const { sessionId, event, payload } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    if (!event) return res.status(400).json({ error: 'event is required' });
    const sid = String(sessionId);
    if (sid === '201' || sid.includes('201')) {
      return res.status(403).json({ error: 'BLOCKED: PRODUCTION SESSION 201 IS STRICTLY PROTECTED' });
    }
    const session = sessionManager.getSession(sid);
    if (!session) return res.status(404).json({ error: `Session ${sessionId} not found` });
    if (!session.sock?.ev) {
      return res.status(500).json({ error: 'Session has no Baileys event emitter attached' });
    }
    try {
      session.sock.ev.emit(event, payload);
      res.json({ success: true, event, emitted: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Baileys Provider Event Listener Introspection (Phase 8.0.9)
  app.get('/test/provider/listeners', (req, res) => {
    const { sessionId, event } = req.query || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    const sid = String(sessionId);
    if (sid === '201' || sid.includes('201')) {
      return res.status(403).json({ error: 'BLOCKED: PRODUCTION SESSION 201 IS STRICTLY PROTECTED' });
    }
    const session = sessionManager.getSession(sid);
    if (!session) return res.status(404).json({ error: `Session ${sessionId} not found` });
    if (!session.sock?.ev) {
      return res.status(500).json({ error: 'Session has no Baileys event emitter attached' });
    }
    const eventName = event ? String(event) : null;
    const count = eventName && session.sock.ev.listenerCount ? session.sock.ev.listenerCount(eventName) : null;
    const eventNames = session.sock.ev.eventNames ? session.sock.ev.eventNames() : [];
    res.json({
      sessionId: sid,
      event: eventName,
      listenerCount: count,
      registeredEvents: eventNames,
    });
  });

  // Baileys Real Socket Provenance & Info (Phase 8.0.10)
  app.get('/test/provider/socket/info', (req, res) => {
    const { sessionId } = req.query || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    const sid = String(sessionId);
    if (sid === '201' || sid.includes('201')) {
      return res.status(403).json({ error: 'BLOCKED: PRODUCTION SESSION 201 IS STRICTLY PROTECTED' });
    }
    const session = sessionManager.getSession(sid);
    if (!session) return res.status(404).json({ error: `Session ${sessionId} not found` });
    if (!session.sock) return res.status(404).json({ error: `Session ${sessionId} has no socket attached` });

    const isRealBaileys = Boolean(
      session.sock.type === 'md' &&
      typeof session.sock.generateMessageTag === 'function' &&
      typeof session.sock.query === 'function'
    );

    res.json({
      sessionId: sid,
      baileys_package_version: '7.0.0-rc14',
      make_wa_socket_provenance: '@whiskeysockets/baileys/lib/Socket/index.js',
      socket_constructor: session.sock.constructor?.name || typeof session.sock,
      socket_type: session.sock.type || 'unknown',
      sock_ev_type: session.sock.ev?.constructor?.name || typeof session.sock.ev,
      socket_generation: session.lifecycle?.generation || 1,
      is_real_baileys_socket: isRealBaileys,
      has_ws_transport: Boolean(session.sock.ws),
      network_egress_blocked: Boolean(
        process.env.GATEWAY_BAILEYS_WS_URL &&
        process.env.GATEWAY_BAILEYS_WS_URL.includes('127.0.0.1')
      ),
      egress_firewall_active: getEgressAuditStats().active,
      egress_wan_blocked_count: getEgressAuditStats().wan_blocked_count,
      wa_websocket_url: process.env.GATEWAY_BAILEYS_WS_URL || 'default',
      status: session.status,
      registered_events: session.sock.ev?.eventNames ? session.sock.ev.eventNames() : [],
      listener_count_upsert: session.sock.ev?.listenerCount ? session.sock.ev.listenerCount('messages.upsert') : 0,
    });
  });

  // Socket Replacement Test Adapter (Phase 8.0.10)
  app.post('/test/provider/socket/replace', async (req, res) => {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    const sid = String(sessionId);
    if (sid === '201' || sid.includes('201')) {
      return res.status(403).json({ error: 'BLOCKED: PRODUCTION SESSION 201 IS STRICTLY PROTECTED' });
    }
    try {
      const result = await sessionManager.replaceTestSessionSocket(sid);
      res.json({
        success: true,
        sessionId: sid,
        old_generation: result.old_generation,
        new_generation: result.new_generation,
        socket_type: result.session.sock.type,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Socket Close Test Adapter (Phase 8.0.10)
  app.post('/test/provider/socket/close', async (req, res) => {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    const sid = String(sessionId);
    if (sid === '201' || sid.includes('201')) {
      return res.status(403).json({ error: 'BLOCKED: PRODUCTION SESSION 201 IS STRICTLY PROTECTED' });
    }
    const session = sessionManager.getSession(sid);
    if (!session) return res.status(404).json({ error: `Session ${sessionId} not found` });
    try {
      if (session.sock) {
        try { session.sock.ev?.removeAllListeners(); } catch (e) {}
        try { session.sock.end(); } catch (e) {}
      }
      session.status = 'DISCONNECTED';
      session.is_phone_online = false;
      session.lifecycle.invalidate();
      res.json({
        success: true,
        sessionId: sid,
        status: session.status,
        generation: session.lifecycle.generation,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/test/bridge/status', (_req, res) => {
    res.json({ connected: eventBridge.isOpen() });
  });

  app.post('/test/bridge/disconnect', (_req, res) => {
    eventBridge.disconnect();
    res.json({ success: true, connected: false });
  });

  app.post('/test/bridge/reconnect', (_req, res) => {
    eventBridge.reconnect();
    res.json({ success: true, connected: true });
  });
}

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

// ---------------------------------------------------------------------------
// Process Error Boundary: Protect gateway from transient socket/fetch terminations
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err) => {
  const isNetworkDrop =
    err?.code === 'UND_ERR_SOCKET' ||
    err?.code === 'ECONNRESET' ||
    err?.code === 'EPIPE' ||
    err?.code === 'ETIMEDOUT' ||
    err?.message?.includes('terminated') ||
    err?.message?.includes('other side closed') ||
    err?.message?.includes('Connection Terminated') ||
    err?.message?.includes('Connection Closed');

  if (isNetworkDrop) {
    logger?.warn({ err: err?.message, code: err?.code }, 'Transient network error caught in gateway; process kept alive');
    return;
  }
  logger?.error({ err }, 'Fatal uncaughtException in WhatsApp Gateway');
});

process.on('unhandledRejection', (reason) => {
  logger?.warn({ reason: reason instanceof Error ? reason.message : reason }, 'Unhandled promise rejection caught in WhatsApp Gateway');
});
