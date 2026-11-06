/**
 * Tenant-scoped chat hydration for the gateway's in-memory store.
 *
 * Why the gateway hydrates chats from the backend database:
 * The gateway's in-memory `store.chats` is per-process. When the gateway restarts,
 * `store.chats` only receives participating groups via Baileys `groupFetchAllParticipating()`
 * and `0@s.whatsapp.net`. All 1-on-1 conversations are absent until a live message arrives.
 *
 * As a result:
 * 1. `GET /sessions/:id/conversations` only returns groups, completely omitting all 1-on-1 chats.
 * 2. Backend initial sync and reconciliation jobs (`_run_sync_job`, `run_bulk_message_sync`)
 *    rely on `gateway_client.list_conversations()` to snapshot chats and sync messages. Because
 *    the gateway only returned groups, 1-on-1 chats were skipped during sync.
 *
 * The backend `conversations` table is the durable, authoritative record of chats.
 * Seeding `store.chats` on startup ensures `listConversations` returns all chats immediately.
 *
 * Tenant scoping: chats are scoped to the session's owner via `whatsapp_sessions.gateway_id`.
 */
import { sanitizeAvatarUrl } from '../domain/bounded-cache.js';

export const CHAT_HYDRATE_LIMIT = 5000;

/** `+905442767554` -> `905442767554@s.whatsapp.net`; `jid:X@g.us` -> `X@g.us`. */
export function jidFromChatPhone(phoneE164) {
  if (!phoneE164) return null;
  const raw = String(phoneE164).trim();
  if (!raw) return null;
  if (raw.startsWith('jid:')) {
    const jid = raw.slice(4).trim();
    return jid && !jid.includes('@lid') ? jid : null;
  }
  if (raw.includes('@g.us') || raw.includes('@s.whatsapp.net')) {
    return raw;
  }
  if (raw.includes('@lid')) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 5 || /^0+$/.test(digits)) return null;
  return `${digits}@s.whatsapp.net`;
}

export function createChatRepository({ pool, logger }) {
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
   * Seeds `store.chats` with the session's existing conversations from PostgreSQL.
   * Never overwrites existing live chats in `store.chats`.
   * Returns the number of chats written. Never throws.
   */
  async function hydrateChats(sessionId, store) {
    if (!pool || !sessionId || !store || !store.chats) return 0;
    try {
      const ownerId = await resolveOwnerUserId(sessionId);
      if (!ownerId) {
        logger?.debug?.({ sessionId }, 'Chat hydration skipped: session owner unresolved');
        return 0;
      }

      const res = await pool.query(
        `SELECT c.id, c.last_message_at, c.last_message_preview, c.unread_count, c.is_archived, c.is_group,
                ct.phone_e164, ct.display_name, ct.avatar_url, ct.name_source
           FROM public.conversations c
           JOIN public.contacts ct ON c.contact_id = ct.id
           JOIN public.whatsapp_sessions ws ON c.session_id = ws.id
          WHERE ws.gateway_id = $1
            AND c.channel = 'WHATSAPP'
          ORDER BY c.last_message_at DESC NULLS LAST
          LIMIT $2`,
        [String(sessionId), CHAT_HYDRATE_LIMIT]
      );

      let written = 0;
      for (const row of res.rows) {
        const jid = jidFromChatPhone(row.phone_e164);
        if (!jid) continue;

        const isGroup = Boolean(row.is_group) || jid.includes('@g.us');
        const digits = jid.split('@')[0];
        const phone = isGroup ? '' : (digits ? `+${digits}` : '');
        const contact = store.contacts?.get(jid);
        const existing = store.chats.get(jid);

        if (existing) {
          // If the chat is already in store.chats, only backfill missing fields
          if (!existing.last_message_preview && row.last_message_preview) {
            existing.last_message_preview = row.last_message_preview;
          }
          if (!existing.last_message_at && row.last_message_at) {
            existing.last_message_at = new Date(row.last_message_at).toISOString();
          }
          if (existing.unread_count === undefined && row.unread_count !== undefined) {
            existing.unread_count = Number(row.unread_count) || 0;
          }
          continue;
        }

        const lastMsgAt = row.last_message_at ? new Date(row.last_message_at).toISOString() : null;
        const name = contact?.name || row.display_name || (isGroup ? 'Grup' : (phone || jid));
        const nameSource = contact?.name_source || row.name_source || (isGroup ? 'group_subject' : null);
        const avatarUrl = sanitizeAvatarUrl(contact?.avatar_url) || sanitizeAvatarUrl(row.avatar_url) || null;

        store.chats.set(jid, {
          id: jid,
          jid,
          name,
          name_source: nameSource,
          phone,
          avatar_url: avatarUrl,
          is_group: isGroup,
          archived: Boolean(row.is_archived),
          last_message_at: lastMsgAt,
          last_message_preview: row.last_message_preview || '',
          unread_count: Number(row.unread_count) || 0,
          created_at: lastMsgAt || new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        written += 1;
      }

      if (written > 0) {
        logger?.info?.({ sessionId, written }, 'Hydrated conversations from backend database');
      }
      return written;
    } catch (err) {
      logger?.warn?.({ err: err?.message, sessionId }, 'Failed to hydrate conversations from database');
      return 0;
    }
  }

  return { hydrateChats, resolveOwnerUserId };
}
