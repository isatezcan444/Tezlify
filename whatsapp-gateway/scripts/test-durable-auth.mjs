import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createEncryptedCodec } from '../src/auth/encrypted-codec.js';
import { createPostgresAuthRepository } from '../src/auth/postgres-auth-repository.js';

function createFakePool() {
  const credentials = new Map();
  const signalKeys = new Map();
  const sessions = new Map();

  const query = async (sql, params = []) => {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      return { rowCount: 0, rows: [] };
    }
    if (normalized.startsWith('INSERT INTO whatsapp_private.gateway_sessions')) {
      sessions.set(params[0], { session_id: params[0], session_name: params[1], is_active: params[2] });
      return { rowCount: 1, rows: [] };
    }
    if (normalized.startsWith('SELECT session_id, session_name')) {
      return { rows: [...sessions.values()].filter((row) => row.is_active), rowCount: sessions.size };
    }
    if (normalized.startsWith('SELECT ciphertext, nonce, auth_tag, key_version')) {
      const row = credentials.get(params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (normalized.startsWith('INSERT INTO whatsapp_private.session_credentials')) {
      credentials.set(params[0], {
        ciphertext: params[1], nonce: params[2], auth_tag: params[3], key_version: params[4],
      });
      return { rowCount: 1, rows: [] };
    }
    if (normalized.startsWith('SELECT key_hash, ciphertext')) {
      const wanted = new Set(params[2]);
      const rows = [...signalKeys.values()].filter(
        (row) => row.session_id === params[0] && row.key_type === params[1] && wanted.has(row.key_hash),
      );
      return { rows, rowCount: rows.length };
    }
    if (normalized.startsWith('INSERT INTO whatsapp_private.signal_keys')) {
      signalKeys.set(`${params[0]}:${params[1]}:${params[2]}`, {
        session_id: params[0], key_type: params[1], key_hash: params[2],
        ciphertext: params[3], nonce: params[4], auth_tag: params[5], key_version: params[6],
      });
      return { rowCount: 1, rows: [] };
    }
    if (normalized.startsWith('DELETE FROM whatsapp_private.signal_keys')) {
      if (params.length === 3) signalKeys.delete(`${params[0]}:${params[1]}:${params[2]}`);
      else for (const key of signalKeys.keys()) if (key.startsWith(`${params[0]}:`)) signalKeys.delete(key);
      return { rowCount: 1, rows: [] };
    }
    if (normalized.startsWith('DELETE FROM whatsapp_private.session_credentials')) {
      credentials.delete(params[0]);
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected SQL in fake pool: ${normalized}`);
  };

  return {
    query,
    connect: async () => ({ query, release() {} }),
    end: async () => {},
    state: { credentials, signalKeys, sessions },
  };
}

const encryptionKey = crypto.randomBytes(32);
const codec = createEncryptedCodec(encryptionKey);
const plaintext = JSON.stringify({ secret: 'not-visible', nested: { ok: true } });
const encrypted = codec.encrypt(plaintext, 'auth:session-a');

assert.equal(encrypted.ciphertext.includes(Buffer.from('not-visible')), false);
assert.equal(codec.decrypt(encrypted, 'auth:session-a'), plaintext);
assert.throws(() => codec.decrypt(encrypted, 'auth:session-b'));
const tampered = { ...encrypted, ciphertext: Buffer.from(encrypted.ciphertext) };
tampered.ciphertext[0] ^= 1;
assert.throws(() => codec.decrypt(tampered, 'auth:session-a'));

const pool = createFakePool();
const repository = createPostgresAuthRepository({ encryptionKey, pool });
await repository.registerSession('session-a', 'Primary line');
const first = await repository.createAuthState('session-a');
first.state.creds.registered = true;
first.state.creds.me = { id: '905551112233:1@s.whatsapp.net', name: 'Owner' };
await first.saveCreds();
await first.state.keys.set({
  'pre-key': {
    'key-1': { keyPair: { private: Buffer.from([1, 2, 3]), public: Buffer.from([4, 5, 6]) } },
  },
});

const restored = await repository.createAuthState('session-a');
assert.equal(restored.state.creds.registered, true);
assert.equal(restored.state.creds.me.id, '905551112233:1@s.whatsapp.net');
const restoredKeys = await restored.state.keys.get('pre-key', ['key-1']);
assert.deepEqual(restoredKeys['key-1'].keyPair.private, Buffer.from([1, 2, 3]));
assert.deepEqual(restoredKeys['key-1'].keyPair.public, Buffer.from([4, 5, 6]));
assert.equal(pool.state.credentials.values().next().value.ciphertext.includes(Buffer.from('905551112233')), false);

await restored.state.keys.set({ 'pre-key': { 'key-1': null } });
assert.deepEqual(await restored.state.keys.get('pre-key', ['key-1']), {});
assert.deepEqual(await repository.listRestorableSessions(), [
  { session_id: 'session-a', session_name: 'Primary line', is_active: true },
]);

console.log('[test-durable-auth] 12 assertions passed');
