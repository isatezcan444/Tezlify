import crypto from 'node:crypto';
import pg from 'pg';
import { createEncryptedCodec } from '/app/src/auth/encrypted-codec.js';

const ENCRYPTION_KEY = process.env.GATEWAY_ENCRYPTION_KEY;
const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
const codec = createEncryptedCodec(key);
const pool = new pg.Pool({ connectionString: process.env.GATEWAY_DATABASE_URL });

const USER_ID = 'f65642ab-4ae5-4d69-945c-8f30c8454bac';
const GATEWAY_ID = '7ca58b14-a53e-47bd-b879-b77519f119bc';
const SESSION_ID = 57;

async function run() {
  console.log('[RECOVERY] Starting WhatsApp production state restoration...');

  // 1. Ensure Session 57 exists
  await pool.query(`
    INSERT INTO whatsapp_sessions (id, user_id, gateway_id, session_name, status, phone_number, is_active, is_phone_online, created_at, updated_at)
    VALUES ($1, $2, $3, 'Hat 1', 'CONNECTED', '+905413749073', true, true, NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET gateway_id = EXCLUDED.gateway_id, status = 'CONNECTED', is_active = true, is_phone_online = true
  `, [SESSION_ID, USER_ID, GATEWAY_ID]);
  console.log('[RECOVERY] Session 57 ensured.');

  // 2. Scan event_outbox for session
  const outboxRes = await pool.query(`
    SELECT sequence, event_id, session_id, event_type, ciphertext, nonce, auth_tag, key_version
    FROM whatsapp_private.event_outbox
    WHERE session_id = $1
    ORDER BY sequence ASC
  `, [GATEWAY_ID]);

  const convMap = new Map();
  const msgList = [];
  const lidMap = new Map();

  for (const r of outboxRes.rows) {
    const ctx = 'tezlify-wa-v1:event:' + r.session_id + ':' + r.event_id;
    try {
      const data = JSON.parse(codec.decrypt(r, ctx));
      if (r.event_type === 'conversation_updated' && data.conversation) {
        const c = data.conversation;
        const jid = c.jid || c.id;
        convMap.set(jid, c);
      } else if (r.event_type === 'message_new' && data.message) {
        msgList.push(data.message);
      } else if (r.event_type === 'lid_mapped' && data.phone_jid && data.lid_jid) {
        lidMap.set(data.lid_jid, data.phone_jid);
      }
    } catch (e) {
      // skip
    }
  }
  console.log(`[RECOVERY] Decrypted from outbox: ${convMap.size} unique conversations, ${msgList.length} messages, ${lidMap.size} LID mappings.`);

  // 3. Upsert contacts and conversations
  let insertedConvs = 0;
  const jidToConvId = new Map();

  for (const [jid, c] of convMap.entries()) {
    let phoneE164 = null;
    if (jid.endsWith('@s.whatsapp.net')) {
      const digits = jid.split('@')[0].replace(/\D/g, '');
      phoneE164 = '+' + digits;
    } else if (jid.endsWith('@lid') || jid.endsWith('@g.us')) {
      phoneE164 = 'jid:' + jid;
    }

    // Find or create contact
    let contactId = null;
    if (phoneE164) {
      const contRes = await pool.query(`
        SELECT id, display_name FROM contacts WHERE user_id = $1 AND phone_e164 = $2 LIMIT 1
      `, [USER_ID, phoneE164]);
      if (contRes.rowCount > 0) {
        contactId = contRes.rows[0].id;
        if (!contRes.rows[0].display_name && c.name) {
          await pool.query(`UPDATE contacts SET display_name = $1 WHERE id = $2`, [c.name, contactId]);
        }
      } else {
        const newCont = await pool.query(`
          INSERT INTO contacts (user_id, phone_e164, display_name, created_at, updated_at)
          VALUES ($1, $2, $3, NOW(), NOW())
          RETURNING id
        `, [USER_ID, phoneE164, c.name || phoneE164]);
        contactId = newCont.rows[0].id;
      }
    }

    // Upsert conversation
    const lastMsgAt = c.last_message_at ? new Date(c.last_message_at) : null;
    const isGroup = Boolean(c.is_group);
    const isArchived = Boolean(c.archived);
    const preview = c.last_message_preview || '';
    const unread = c.unread_count || 0;

    const convCheck = await pool.query(`
      SELECT id FROM conversations
      WHERE user_id = $1 AND contact_id = $2 AND channel = 'WHATSAPP' AND session_id = $3
      LIMIT 1
    `, [USER_ID, contactId, SESSION_ID]);

    let convId = null;
    if (convCheck.rowCount > 0) {
      convId = convCheck.rows[0].id;
      await pool.query(`
        UPDATE conversations
        SET last_message_at = COALESCE($1, last_message_at),
            last_message_preview = COALESCE($2, last_message_preview),
            is_group = $3,
            is_archived = $4,
            unread_count = $5,
            status = $6,
            updated_at = NOW()
        WHERE id = $7
      `, [lastMsgAt, preview, isGroup, isArchived, unread, isArchived ? 'ARCHIVED' : 'ACTIVE', convId]);
    } else {
      const newConv = await pool.query(`
        INSERT INTO conversations (
          user_id, contact_id, session_id, channel, status,
          last_message_at, last_message_preview, is_group, is_archived, unread_count,
          created_at, updated_at
        ) VALUES ($1, $2, $3, 'WHATSAPP', $4, $5, $6, $7, $8, $9, NOW(), NOW())
        RETURNING id
      `, [
        USER_ID, contactId, SESSION_ID,
        isArchived ? 'ARCHIVED' : 'ACTIVE',
        lastMsgAt, preview, isGroup, isArchived, unread
      ]);
      convId = newConv.rows[0].id;
      insertedConvs++;
    }
    jidToConvId.set(jid, convId);
  }
  console.log(`[RECOVERY] Total conversations ensured: ${jidToConvId.size} (newly inserted: ${insertedConvs})`);

  // 4. Insert messages
  let insertedMsgs = 0;
  for (const m of msgList) {
    const remoteJid = m.conversation_id || m.remote_jid;
    const convId = jidToConvId.get(remoteJid);
    if (!convId) continue;

    const waMsgId = m.wa_message_id;
    if (!waMsgId) continue;

    const dir = (m.direction === 'OUTBOUND') ? 'OUTBOUND' : 'INBOUND';
    const type = 'TEXT';
    const body = m.body || '';
    const sPhone = m.sender_phone || (dir === 'OUTBOUND' ? '+905413749073' : '');
    const rPhone = m.recipient_phone || (dir === 'OUTBOUND' ? '' : '+905413749073');
    const sName = m.sender_name || null;
    const status = m.status === 'SENT' ? 'SENT' : (dir === 'OUTBOUND' ? 'DELIVERED' : 'READ');
    const ts = m.created_at ? new Date(m.created_at) : new Date();

    const mRes = await pool.query(`
      INSERT INTO messages (
        conversation_id, direction, message_type, body,
        sender_phone, recipient_phone, status, external_timestamp,
        created_at, updated_at, user_id, sender_name, wa_message_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11, $12)
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [convId, dir, type, body, sPhone, rPhone, status, ts, ts, USER_ID, sName, waMsgId]);
    if (mRes.rowCount > 0) insertedMsgs++;
  }
  console.log(`[RECOVERY] Total messages inserted: ${insertedMsgs}`);

  // 5. Populate history_sync_states for ALL 98 conversations with Phase 15 states
  const statsRes = await pool.query(`
    SELECT c.id, c.contact_id, ct.phone_e164, count(m.id) as msg_count, min(m.external_timestamp) as oldest_ts
    FROM conversations c
    JOIN contacts ct ON c.contact_id = ct.id
    LEFT JOIN messages m ON m.conversation_id = c.id
    WHERE c.channel = 'WHATSAPP' AND c.user_id = $1
    GROUP BY c.id, c.contact_id, ct.phone_e164
  `, [USER_ID]);

  let statesUpdated = 0;
  for (const row of statsRes.rows) {
    const phoneVal = row.phone_e164 || '';
    let jid = '';
    if (phoneVal.startsWith('jid:')) {
      jid = phoneVal.slice(4);
    } else if (phoneVal.startsWith('+')) {
      jid = phoneVal.slice(1) + '@s.whatsapp.net';
    }
    if (!jid) continue;

    const count = parseInt(row.msg_count, 10) || 0;
    const oldestTs = row.oldest_ts ? new Date(row.oldest_ts).getTime() : null;

    const curRes = await pool.query(`
      SELECT state, has_more, completed_at, timeout_count, stall_count, oldest_timestamp_ms
      FROM whatsapp_private.history_sync_states
      WHERE session_id = $1 AND jid = $2
    `, [GATEWAY_ID, jid]);

    if (curRes.rowCount === 0) {
      if (count === 0) {
        await pool.query(`
          INSERT INTO whatsapp_private.history_sync_states (
            session_id, jid, has_more, completed_at, state, stall_count, timeout_count, error_count, updated_at
          ) VALUES ($1, $2, false, NOW(), 'NO_MESSAGES', 0, 0, 0, NOW())
        `, [GATEWAY_ID, jid]);
      } else {
        await pool.query(`
          INSERT INTO whatsapp_private.history_sync_states (
            session_id, jid, has_more, oldest_timestamp_ms, state, stall_count, timeout_count, error_count, updated_at
          ) VALUES ($1, $2, true, $3, 'HAS_MORE', 0, 0, 0, NOW())
        `, [GATEWAY_ID, jid, oldestTs]);
      }
      statesUpdated++;
    } else {
      const cur = curRes.rows[0];
      let newState = 'HAS_MORE';
      let hasMore = cur.has_more;
      let completedAt = cur.completed_at;

      if (count === 0) {
        newState = 'NO_MESSAGES';
        hasMore = false;
        completedAt = completedAt || new Date();
      } else if (cur.completed_at || !cur.has_more) {
        newState = 'FULLY_EXHAUSTED';
        hasMore = false;
        completedAt = cur.completed_at || new Date();
      } else if (cur.stall_count >= 3) {
        newState = 'CURSOR_STALLED';
        hasMore = false;
      } else if (cur.timeout_count > 0) {
        newState = 'TEMPORARY_TIMEOUT';
        hasMore = true;
      } else {
        newState = 'HAS_MORE';
        hasMore = true;
      }

      await pool.query(`
        UPDATE whatsapp_private.history_sync_states
        SET state = $1,
            has_more = $2,
            completed_at = $3,
            oldest_timestamp_ms = COALESCE(oldest_timestamp_ms, $4),
            updated_at = NOW()
        WHERE session_id = $5 AND jid = $6
      `, [newState, hasMore, completedAt, oldestTs, GATEWAY_ID, jid]);
      statesUpdated++;
    }
  }

  console.log(`[RECOVERY] history_sync_states updated for ${statesUpdated} conversations.`);

  const summaryRes = await pool.query(`
    SELECT state, count(*) FROM whatsapp_private.history_sync_states WHERE session_id = $1 GROUP BY state
  `, [GATEWAY_ID]);
  console.log('\n--- HISTORY STATE DISTRIBUTION ---');
  for (const r of summaryRes.rows) {
    console.log(`${r.state}: ${r.count}`);
  }

  await pool.end();
  console.log('[RECOVERY] Production state restoration successfully completed!');
}

run().catch(err => {
  console.error('[ERROR]', err);
  process.exit(1);
});
