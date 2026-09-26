/**
 * Tenant-scoped contact-name hydration for the gateway's in-memory store.
 *
 * Why the gateway reads names from the backend database: `_resolveDisplayName()`
 * resolves a message sender label as contact-store name -> `msg.pushName` ->
 * phone. The store is per-process and, empirically, is NOT repopulated when a
 * session reconnects ("Reconnection with existing sync data, skipping history
 * sync wait"): production messages stored minutes after the 00:12 restart still
 * carried `+905076382749` where the same participant had been "Cevat Aydin"
 * before it. So an empty store silently degrades every label to a phone number.
 *
 * The backend `contacts` table is the authoritative, durable record of the names
 * the gateway itself learned earlier, so it is the correct bootstrap source.
 *
 * Scoping (AGENTS.md tenant isolation): names are per *user*, not per session, so
 * a session may only hydrate contacts belonging to the user that owns it. The
 * owner is resolved through `whatsapp_sessions.gateway_id -> user_id` — the same
 * route `lid-repository.js` uses for LID scoping — and the contact query is
 * joined on `user_id`, never on phone alone. An unresolvable owner hydrates
 * nothing rather than falling back to a global scan.
 */
import { mergeContactName } from '../utils/whatsapp-identity.js';

export const CONTACT_HYDRATE_LIMIT = 20000;

/** `+905321002030` -> `905321002030@s.whatsapp.net`; `jid:X@g.us` -> `X@g.us`. */
export function jidFromContactPhone(phoneE164) {
  if (!phoneE164) return null;
  const raw = String(phoneE164).trim();
  if (!raw) return null;
  if (raw.startsWith('jid:')) {
    const jid = raw.slice(4).trim();
    // `jid:...@lid` is an unresolved LID sentinel, not a usable store key.
    return jid && !jid.includes('@lid') ? jid : null;
  }
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 5 || /^0+$/.test(digits)) return null;
  return `${digits}@s.whatsapp.net`;
}

/** Only real names are worth hydrating; a phone-shaped or raw-jid value adds
 * nothing the resolver's own phone fallback would not already produce. */
function isHydratableName(displayName, phoneE164) {
  if (typeof displayName !== 'string') return false;
  const name = displayName.trim();
  if (!name) return false;
  if (name === phoneE164) return false;
  if (name.startsWith('+')) return false;
  if (name.startsWith('jid:')) return false;
  if (name.includes('@')) return false;
  return true;
}

export function createContactRepository({ pool, logger }) {
  async function resolveOwnerUserId(sessionId) {
    if (!pool || !sessionId) return null;
    const res = await pool.query(
      'SELECT user_id FROM public.whatsapp_sessions WHERE gateway_id = $1 LIMIT 1',
      [String(sessionId)]
    );
    const row = res.rows[0];
    return row && row.user_id ? String(row.user_id) : null;
  }

  /**
   * Seeds `store.contacts` with the owning user's known names.
   *
   * Merge policy: entries are inserted at `history` rank via `mergeContactName`,
   * so a fresher name already in the store (e.g. an `addressbook` entry learned
   * live in this process) is never overwritten, and a later `push` nickname
   * cannot clobber the hydrated name.
   *
   * Returns the number of names written. Never throws: hydration is a naming
   * improvement and must not block socket startup.
   */
  async function hydrateContactNames(sessionId, store) {
    if (!pool || !sessionId || !store) return 0;
    try {
      const ownerId = await resolveOwnerUserId(sessionId);
      if (!ownerId) {
        logger?.debug?.({ sessionId }, 'Contact hydration skipped: session owner unresolved');
        return 0;
      }
      const res = await pool.query(
        `SELECT ct.phone_e164, ct.display_name
           FROM public.contacts ct
          WHERE ct.user_id = $1::uuid
            AND ct.display_name IS NOT NULL
          LIMIT $2`,
        [ownerId, CONTACT_HYDRATE_LIMIT]
      );
      let written = 0;
      for (const row of res.rows) {
        if (!isHydratableName(row.display_name, row.phone_e164)) continue;
        const jid = jidFromContactPhone(row.phone_e164);
        if (!jid) continue;
        const existing = store.contacts.get(jid) || {};
        const merged = mergeContactName(existing, String(row.display_name).trim(), 'history');
        if (merged.name === existing.name && merged.name_source === existing.name_source) continue;
        store.contacts.set(jid, {
          ...merged,
          id: jid,
          jid,
          phone: jid.includes('@g.us') ? '' : `+${jid.split('@')[0]}`,
        });
        written += 1;
      }
      if (written > 0) {
        logger?.info?.({ sessionId, written }, 'Hydrated contact names from backend database');
      }
      return written;
    } catch (err) {
      logger?.warn?.({ err: err?.message, sessionId }, 'Failed to hydrate contact names from database');
      return 0;
    }
  }

  return { hydrateContactNames, resolveOwnerUserId };
}
