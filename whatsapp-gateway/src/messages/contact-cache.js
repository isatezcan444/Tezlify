/**
 * Durable WhatsApp contact-name cache.
 *
 * Why this exists: `_resolveDisplayName()` resolves a message sender label in
 * the order contact-store name -> `msg.pushName` -> phone. The contact store
 * (`messages/message-store.js`) is a plain in-memory Map, so every gateway
 * restart started it empty. Because the gateway runs with
 * `WHATSAPP_AUTO_RESTORE=false`, restarts are routine, and each one made every
 * sender label whose message carried no `pushName` degrade to a raw phone
 * number. Observed in production: the same group participant rendered as
 * "Cevat Aydin" in messages stored before the 00:12 restart and as
 * "+905076382749" in messages stored after it, and `GET /sessions/:id/contacts`
 * reported zero contacts while the backend still held the names.
 *
 * What is persisted: only entries that carry a usable *name*. A phone-shaped
 * entry is deliberately not written, because the resolver's own last-resort
 * fallback already computes exactly that phone from the JID — storing it would
 * only grow the file without ever changing a label.
 *
 * Failure policy: this cache is an optimisation for presentation. A read or
 * write failure must never break message ingestion or socket startup, so every
 * filesystem call is caught and downgraded to a warning.
 */
import fs from 'fs';
import path from 'path';

export const CONTACTS_CACHE_FILE = 'contacts-cache.json';
export const CONTACTS_CACHE_VERSION = 1;
export const CONTACTS_CACHE_MAX_ENTRIES = 5000;
export const CONTACTS_CACHE_SAVE_DEBOUNCE_MS = 1500;

function isUsableName(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  // Raw identities ('6277...@lid', 'jid:...', '...@g.us') are never names.
  if (
    trimmed.startsWith('jid:') ||
    trimmed.includes('@lid') ||
    trimmed.endsWith('@g.us') ||
    trimmed.endsWith('@s.whatsapp.net') ||
    trimmed.endsWith('@c.us')
  ) {
    return false;
  }
  // Phone-shaped names are handled by the resolver's own fallback.
  return !/^\+?[\d\s\-()]{6,}$/.test(trimmed);
}

function sanitizeEntry(jid, contact) {
  if (!jid || typeof jid !== 'string') return null;
  if (!contact || typeof contact !== 'object') return null;
  if (!isUsableName(contact.name)) return null;
  return [
    jid,
    {
      id: contact.id || jid,
      jid: contact.jid || jid,
      name: String(contact.name).trim(),
      name_source: contact.name_source || null,
      phone: contact.phone || null,
      avatar_url: contact.avatar_url || null,
    },
  ];
}

export function createContactCache({ sessionDir, logger = null, sessionPhone = null }) {
  const file = sessionDir ? path.join(sessionDir, CONTACTS_CACHE_FILE) : null;
  let timer = null;
  let pendingStore = null;
  let loading = false;
  let phoneStamp = sessionPhone || null;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function flush() {
    clearTimer();
    const store = pendingStore;
    pendingStore = null;
    if (!store || !file) return false;
    try {
      const entries = [];
      for (const [jid, contact] of store.contacts.entries()) {
        const entry = sanitizeEntry(jid, contact);
        if (entry) entries.push(entry);
        if (entries.length >= CONTACTS_CACHE_MAX_ENTRIES) break;
      }
      const payload = {
        version: CONTACTS_CACHE_VERSION,
        saved_at: new Date().toISOString(),
        session_phone: phoneStamp || null,
        contacts: entries,
      };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Atomic swap: a crash mid-write must never leave a truncated cache that
      // would then load as "no names at all".
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch (err) {
      logger?.warn?.({ err: err?.message }, 'Failed to persist contacts cache');
      return false;
    }
  }

  function schedule(store) {
    if (loading) return;
    pendingStore = store;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, CONTACTS_CACHE_SAVE_DEBOUNCE_MS);
    // Never hold the event loop open just to persist a name cache.
    timer.unref?.();
  }

  /**
   * Restores cached names into the store. Entries are re-validated on the way
   * in: a cache written by an older build (or hand-edited) must not be able to
   * inject a raw JID as a display name.
   */
  function load(store, { currentPhone = null } = {}) {
    if (!file || !store) return 0;
    let payload;
    try {
      if (!fs.existsSync(file)) return 0;
      payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      logger?.warn?.({ err: err?.message }, 'Failed to read contacts cache');
      return 0;
    }
    if (!payload || payload.version !== CONTACTS_CACHE_VERSION) return 0;
    // Guard against a stale cache surviving a re-link onto a DIFFERENT phone
    // number on the same session id: showing another account's name would be
    // worse than showing no name at all.
    const cachedPhone = payload.session_phone || null;
    if (cachedPhone && currentPhone && String(cachedPhone) !== String(currentPhone)) {
      logger?.info?.(
        { cached: cachedPhone, current: currentPhone },
        'Contacts cache phone mismatch; discarding cached names'
      );
      return 0;
    }
    phoneStamp = currentPhone || cachedPhone || phoneStamp;
    loading = true;
    let restored = 0;
    try {
      for (const entry of payload.contacts || []) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const clean = sanitizeEntry(entry[0], entry[1]);
        if (!clean) continue;
        store.contacts.set(clean[0], clean[1]);
        restored += 1;
      }
    } finally {
      loading = false;
    }
    if (restored > 0) {
      logger?.info?.({ restored }, 'Restored contact names from disk cache');
    }
    return restored;
  }

  /** Removes the cache. Used when the session is logged out or banned, where
   * the next link may be a different WhatsApp account. */
  function clear() {
    clearTimer();
    pendingStore = null;
    if (!file) return false;
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return true;
    } catch (err) {
      logger?.warn?.({ err: err?.message }, 'Failed to clear contacts cache');
      return false;
    }
  }

  function setSessionPhone(phone) {
    if (phone) phoneStamp = phone;
  }

  return { file, load, schedule, flush, clear, setSessionPhone };
}
