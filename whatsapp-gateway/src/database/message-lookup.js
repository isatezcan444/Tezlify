/**
 * Database Message Lookup Helper.
 *
 * Resolves persistent conversation metadata, chat JID, and original message
 * fields for revokes, edits, and receipt processing across gateway restarts.
 */
import { logger } from '../utils/baileys-logger.js';
import { resolveJidKey } from '../utils/whatsapp-identity.js';

export async function lookupMessageDbInfo(pool, waMessageId, store = null) {
  if (!pool || !waMessageId) return null;
  try {
    const res = await pool.query(
      `SELECT
         m.id,
         m.conversation_id,
         m.direction,
         m.message_type,
         m.body,
         m.media_id,
         m.media_mime_type,
         m.media_filename,
         m.media_caption,
         m.status,
         m.created_at,
         m.recipient_phone,
         m.sender_phone,
         c.is_group,
         c.parent_jid,
         ct.phone_e164 as contact_phone
       FROM messages m
       JOIN conversations c ON m.conversation_id = c.id
       LEFT JOIN contacts ct ON c.contact_id = ct.id
       WHERE m.wa_message_id = $1
       LIMIT 1`,
      [String(waMessageId)]
    );
    const row = res.rows[0];
    if (!row) return null;

    let resolvedJid = row.jid || null;
    if (!resolvedJid) {
      if (row.is_group) {
        if (row.parent_jid && row.parent_jid.includes('@g.us')) {
          resolvedJid = row.parent_jid;
        } else if (row.contact_phone && row.contact_phone.startsWith('jid:')) {
          resolvedJid = row.contact_phone.slice(4).trim();
        }
      } else {
        const rawPhone = row.contact_phone || row.recipient_phone || row.sender_phone;
        if (rawPhone) {
          if (rawPhone.startsWith('jid:')) {
            resolvedJid = rawPhone.slice(4).trim();
          } else if (rawPhone.includes('@s.whatsapp.net')) {
            resolvedJid = rawPhone;
          } else {
            const digits = rawPhone.replace(/\D/g, '');
            if (digits.length >= 5 && !/^0+$/.test(digits)) {
              resolvedJid = `${digits}@s.whatsapp.net`;
            }
          }
        }
      }
    }
    const normalizedChatJid = resolvedJid ? resolveJidKey(store, resolvedJid) : null;
    return {
      ...row,
      chat_jid: normalizedChatJid,
    };
  } catch (err) {
    logger.debug({ err: err?.message, waMessageId }, 'lookupMessageDbInfo failed');
    return null;
  }
}
