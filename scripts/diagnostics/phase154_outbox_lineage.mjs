import crypto from 'node:crypto';
import pg from 'pg';
import { createEncryptedCodec } from '/app/src/auth/encrypted-codec.js';

const ENCRYPTION_KEY = process.env.GATEWAY_ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) {
  console.error('GATEWAY_ENCRYPTION_KEY missing');
  process.exit(1);
}
const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
const codec = createEncryptedCodec(key);
const pool = new pg.Pool({ connectionString: process.env.GATEWAY_DATABASE_URL });

async function run() {
  const targetSessions = [
    '7ca58b14-a53e-47bd-b879-b77519f119bc',
    'b010a547-7fdf-4a86-8dd4-1561e8020f6a',
    '87cf30e9-91d7-40b8-aba4-5d36494192f9',
    '2b2ed927-866c-4373-89d9-0ad8b35d63c8'
  ];

  console.log('=== EVENT OUTBOX FORENSIC LINEAGE AUDIT ===');
  
  for (const sid of targetSessions) {
    console.log(`\n--- Inspecting Gateway Session: ${sid} ---`);
    const res = await pool.query(`
      SELECT sequence, event_id, session_id, event_type, ciphertext, nonce, auth_tag, key_version, state, created_at
      FROM whatsapp_private.event_outbox
      WHERE session_id = $1
      ORDER BY sequence ASC
    `, [sid]);

    console.log(`Total outbox events for ${sid}: ${res.rowCount}`);
    if (res.rowCount === 0) continue;

    const eventTypeCounts = {};
    for (const r of res.rows) {
      eventTypeCounts[r.event_type] = (eventTypeCounts[r.event_type] || 0) + 1;
    }
    console.log('Event types breakdown:', JSON.stringify(eventTypeCounts));

    // Decrypt key lifecycle events
    const lifecycleTypes = ['session_connected', 'session_connecting', 'session_disconnected', 'history_sync_completed'];
    for (const r of res.rows) {
      if (!lifecycleTypes.includes(r.event_type)) continue;

      const ctx = 'tezlify-wa-v1:event:' + r.session_id + ':' + r.event_id;
      try {
        const decrypted = codec.decrypt(r, ctx);
        const data = JSON.parse(decrypted);
        console.log(`\n[EVENT ${r.sequence}] type=${r.event_type} created_at=${r.created_at.toISOString()}`);
        console.log('Payload summary:', JSON.stringify({
          event: data.event,
          session_id: data.session_id,
          user_id: data.user_id,
          phone_number: data.phone_number || data.phone,
          status: data.status,
          gateway_session_id: data.gateway_session_id,
          sync: data.sync,
          has_messages: Boolean(data.messages),
          message_count: Array.isArray(data.messages) ? data.messages.length : (data.messages ? 'present' : 0)
        }, null, 2));
      } catch (err) {
        console.log(`[EVENT ${r.sequence}] type=${r.event_type} Decrypt error: ${err.message}`);
      }
    }
  }

  // Also check public.conversations session_id distribution
  console.log('\n--- Checking public.conversations session_id distribution ---');
  const convRes = await pool.query(`
    SELECT session_id, count(*) FROM public.conversations GROUP BY session_id
  `);
  console.log('Conversations by session_id:', JSON.stringify(convRes.rows));

  await pool.end();
}

run().catch((err) => {
  console.error('Lineage audit failed:', err);
  process.exit(1);
});
