/**
 * WhatsApp Multi-Tenant LID (Large Identity) Scoping & Persistence.
 *
 * Implements tenant-scoped LID-to-phone mappings (G-3) with fail-closed bounds
 * and disk-to-PostgreSQL synchronization.
 */
import fs from 'fs';
import path from 'path';
import { sessionRef } from '../observability.js';
import { rememberLidPair } from '../utils/whatsapp-identity.js';

export function lidScopeSessionIds(sessionId, ownerId, sessions) {
  const scope = new Set();
  if (!sessionId) return scope;
  scope.add(String(sessionId));
  if (!ownerId) return scope;
  for (const s of sessions || []) {
    if (!s || !s.sessionId) continue;
    if (s.ownerId && String(s.ownerId) === String(ownerId)) {
      scope.add(String(s.sessionId));
    }
  }
  return scope;
}

export function createLidRepository({ pool, sessionsDir, logger }) {
  function getSessionDir(baseDir, sessionId) {
    return path.join(baseDir, sessionId);
  }

  async function loadSessionOwners() {
    if (!pool) return [];
    try {
      const res = await pool.query(
        `SELECT gateway_id, user_id FROM public.whatsapp_sessions WHERE gateway_id IS NOT NULL`
      );
      return res.rows.map((r) => ({
        sessionId: String(r.gateway_id),
        ownerId: r.user_id ? String(r.user_id) : null,
      }));
    } catch (err) {
      logger.warn({ err: err?.message }, 'Failed to load session owners for LID scoping');
      return [];
    }
  }

  async function lidScopeFor(sessionId) {
    const sessions = await loadSessionOwners();
    const own = sessions.find((s) => s.sessionId === String(sessionId));
    const ownerId = own ? own.ownerId : null;
    return { scope: lidScopeSessionIds(sessionId, ownerId, sessions), ownerId, sessions };
  }

  async function persistLidMappingToDb(sessionId, lid, phoneJid) {
    if (!pool || !sessionId || !lid || !phoneJid) return;
    try {
      await pool.query(
        `INSERT INTO whatsapp_private.lid_mappings (session_id, lid_jid, phone_jid, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (session_id, lid_jid) DO UPDATE SET phone_jid = EXCLUDED.phone_jid, created_at = NOW()`,
        [String(sessionId), String(lid), String(phoneJid)]
      );
    } catch (err) {
      logger.warn(
        { err: err?.message, session_ref: sessionRef(sessionId) },
        'Failed to persist LID mapping to PostgreSQL'
      );
    }
  }

  async function syncLidMappingsFromDisk(sessionId, store, onLearned) {
    let count = 0;
    try {
      const scanDirs = new Set();
      const { scope } = await lidScopeFor(sessionId);
      if (sessionId) {
        scanDirs.add(getSessionDir(sessionsDir, sessionId));
      }
      if (fs.existsSync(sessionsDir)) {
        for (const item of fs.readdirSync(sessionsDir)) {
          const itemPath = path.join(sessionsDir, item);
          try {
            if (!fs.statSync(itemPath).isDirectory()) continue;
          } catch {
            continue;
          }
          if (sessionId && !scope.has(String(item))) continue;
          scanDirs.add(itemPath);
        }
      }

      for (const dir of scanDirs) {
        if (!fs.existsSync(dir)) continue;
        const dirSessionId = path.basename(dir);
        let files = [];
        try {
          files = fs.readdirSync(dir);
        } catch {
          continue;
        }
        for (const file of files) {
          if (!file.startsWith('lid-mapping-') || !file.endsWith('.json')) continue;
          let pnUser = null;
          let lidUser = null;
          const fullPath = path.join(dir, file);
          if (file.endsWith('_reverse.json')) {
            lidUser = file.slice('lid-mapping-'.length, -'_reverse.json'.length);
            try {
              const raw = fs.readFileSync(fullPath, 'utf8').trim();
              pnUser = JSON.parse(raw);
            } catch { /* ignore */ }
          } else {
            pnUser = file.slice('lid-mapping-'.length, -'.json'.length);
            try {
              const raw = fs.readFileSync(fullPath, 'utf8').trim();
              lidUser = JSON.parse(raw);
            } catch { /* ignore */ }
          }
          if (
            pnUser &&
            lidUser &&
            typeof pnUser === 'string' &&
            typeof lidUser === 'string' &&
            !pnUser.includes('@') &&
            !lidUser.includes('@')
          ) {
            const lidJid = `${lidUser}@lid`;
            const phoneJid = `${pnUser}@s.whatsapp.net`;
            if (store) {
              rememberLidPair(store, lidJid, phoneJid);
            }
            void persistLidMappingToDb(sessionId || dirSessionId, lidJid, phoneJid);
            if (typeof onLearned === 'function') {
              onLearned(lidJid, phoneJid);
            }
            count += 1;
          }
        }
      }
      if (count > 0) {
        logger.info({ sessionId, count }, 'Synced LID mappings from disk to memory & DB');
      }
    } catch (diskErr) {
      logger.warn({ err: diskErr?.message, sessionId }, 'Failed to sync LID mappings from disk');
    }
    return count;
  }

  async function loadLidMappingsFromDb(sessionId, store, onLearned) {
    if (!sessionId || !store) return 0;
    await syncLidMappingsFromDisk(sessionId, store, onLearned);
    if (!pool) return 0;
    try {
      const { scope } = await lidScopeFor(sessionId);
      const res = await pool.query(
        `SELECT DISTINCT ON (lid_jid) lid_jid, phone_jid 
         FROM whatsapp_private.lid_mappings 
         WHERE session_id = ANY($2::text[])
         ORDER BY lid_jid, (session_id = $1) DESC, created_at DESC`,
        [String(sessionId), Array.from(scope)]
      );
      let count = 0;
      for (const row of res.rows) {
        if (row.lid_jid && row.phone_jid) {
          rememberLidPair(store, row.lid_jid, row.phone_jid);
          if (typeof onLearned === 'function') {
            onLearned(row.lid_jid, row.phone_jid);
          }
          count += 1;
        }
      }
      if (count > 0) {
        logger.info({ sessionId, count }, 'Loaded persistent LID mappings from PostgreSQL');
      }
      return count;
    } catch (err) {
      logger.warn(
        { err: err?.message, sessionId },
        'Failed to load persistent LID mappings from PostgreSQL'
      );
      return 0;
    }
  }

  return {
    lidScopeSessionIds,
    loadSessionOwners,
    lidScopeFor,
    persistLidMappingToDb,
    syncLidMappingsFromDisk,
    loadLidMappingsFromDb,
  };
}
