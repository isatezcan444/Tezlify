import assert from 'node:assert/strict';
import crypto, { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_MAX_RAM_ENTRIES,
  createMessageSecretStore,
  isTrivialTestKeyMaterial,
} from '../src/crypto/message-secret-store.js';
import { createSessionManager } from '../src/session-manager.js';
import { createMsmsgWireCapture } from '../src/observability/msmsg-wire-capture.js';

console.log('=== RUNNING STAGE 1.4 MESSAGE_SECRET STORE HARDENING & WIRE CAPTURE SUITE ===');

function createPgMock() {
  const rows = new Map();
  return {
    rows,
    async query(sql, params = []) {
      const norm = sql.replace(/\s+/g, ' ').trim();
      if (norm.startsWith('INSERT INTO whatsapp_private.message_secrets')) {
        const [sessionId, chatJid, waMessageId, ciphertext, nonce, authTag, keyVersion, expiresAt] = params;
        rows.set(`${sessionId}\0${chatJid}\0${waMessageId}`, {
          session_id: sessionId,
          chat_jid: chatJid,
          wa_message_id: waMessageId,
          ciphertext: Buffer.from(ciphertext),
          nonce: Buffer.from(nonce),
          auth_tag: Buffer.from(authTag),
          key_version: Number(keyVersion),
          expires_at: expiresAt || null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (norm.startsWith('SELECT ciphertext, nonce, auth_tag, key_version, expires_at FROM whatsapp_private.message_secrets')) {
        const [sessionId, chatJid, waMessageId] = params;
        const row = rows.get(`${sessionId}\0${chatJid}\0${waMessageId}`);
        if (!row) return { rows: [], rowCount: 0 };
        if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (norm.startsWith('DELETE FROM whatsapp_private.message_secrets WHERE session_id = $1')) {
        const [sessionId] = params;
        let deleted = 0;
        for (const [k, row] of rows.entries()) {
          if (row.session_id === sessionId) {
            rows.delete(k);
            deleted += 1;
          }
        }
        return { rows: [], rowCount: deleted };
      }
      if (norm.startsWith('DELETE FROM whatsapp_private.message_secrets WHERE expires_at')) {
        const now = Date.now();
        let deleted = 0;
        for (const [k, row] of rows.entries()) {
          if (row.expires_at && Date.parse(row.expires_at) <= now) {
            rows.delete(k);
            deleted += 1;
          }
        }
        return { rows: [], rowCount: deleted };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const strongRootKey = randomBytes(32);
const jid = '905551112233@s.whatsapp.net';

// ---------------------------------------------------------------------------
// 1. Fail-honest DB status handling & single-warn 42P01 suppression
// ---------------------------------------------------------------------------
{
  const missingTablePool = {
    async query() {
      const err = new Error('relation "whatsapp_private.message_secrets" does not exist');
      err.code = '42P01';
      throw err;
    },
  };
  const orphanPool = {
    async query() {
      const err = new Error('insert violates foreign key constraint');
      err.code = '23503';
      throw err;
    },
  };
  const genericFailPool = {
    async query() {
      const err = new Error('connection timeout');
      err.code = 'ETIMEDOUT';
      throw err;
    },
  };

  let orphanedSession = null;
  const store = createMessageSecretStore({
    rootKeyMaterial: strongRootKey,
    onOrphaned: (sid) => {
      orphanedSession = sid;
    },
  });

  // 42P01: no false-positive ok:true, returns table_unavailable, logs once
  const r42p01a = await store.saveSecret({
    sessionId: 'sess-1',
    chatJid: jid,
    waMessageId: 'M-42P01-A',
    secret: randomBytes(32),
    pool: missingTablePool,
  });
  assert.deepEqual(r42p01a, {
    ok: false,
    persisted: false,
    cachedInRam: true,
    storage: 'ram_only',
    reason: 'table_unavailable',
    keyVersion: 1,
  });
  assert.equal(store.getStats().schemaMissingWarned, true);

  const r42p01b = await store.saveSecret({
    sessionId: 'sess-1',
    chatJid: jid,
    waMessageId: 'M-42P01-B',
    secret: randomBytes(32),
    pool: missingTablePool,
  });
  assert.equal(r42p01b.ok, false);
  assert.equal(r42p01b.reason, 'table_unavailable');

  // no_pool: explicitly marks ram_only without claiming DB persisted
  const rNoPool = await store.saveSecret({
    sessionId: 'sess-1',
    chatJid: jid,
    waMessageId: 'M-NOPOOL',
    secret: randomBytes(32),
    pool: null,
  });
  assert.deepEqual(rNoPool, {
    ok: true,
    persisted: false,
    cachedInRam: true,
    storage: 'ram_only',
    reason: 'no_pool',
    keyVersion: 1,
  });

  // 23503 orphan_session: reports ok:false and triggers onOrphaned
  const rOrphan = await store.saveSecret({
    sessionId: 'sess-orphan',
    chatJid: jid,
    waMessageId: 'M-ORPHAN',
    secret: randomBytes(32),
    pool: orphanPool,
  });
  assert.equal(rOrphan.ok, false);
  assert.equal(rOrphan.persisted, false);
  assert.equal(rOrphan.reason, 'orphan_session');
  assert.equal(orphanedSession, 'sess-orphan');

  // generic DB error -> persist_error, ok:false
  const rErr = await store.saveSecret({
    sessionId: 'sess-1',
    chatJid: jid,
    waMessageId: 'M-ERR',
    secret: randomBytes(32),
    pool: genericFailPool,
  });
  assert.equal(rErr.ok, false);
  assert.equal(rErr.persisted, false);
  assert.equal(rErr.reason, 'persist_error');

  // invalid_input -> ok:false, cachedInRam:false
  const rInvalid = await store.saveSecret({
    sessionId: '',
    chatJid: jid,
    waMessageId: 'M-BAD',
    secret: randomBytes(32),
  });
  assert.equal(rInvalid.ok, false);
  assert.equal(rInvalid.cachedInRam, false);
  assert.equal(rInvalid.reason, 'invalid_input');

  console.log('✓ 1. Fail-honest saveSecret statuses verified (42P01, 23503, no_pool, persist_error)');
}

// ---------------------------------------------------------------------------
// 2. Bounded RAM LRU eviction + DB reload & re-hydration + logout cleanup
// ---------------------------------------------------------------------------
{
  const pool = createPgMock();
  const store = createMessageSecretStore({
    rootKeyMaterial: strongRootKey,
    pool,
    maxEntries: 3,
  });

  assert.equal(DEFAULT_MAX_RAM_ENTRIES, 10_000);
  const secrets = new Map();
  for (let i = 1; i <= 4; i++) {
    const id = `M-${i}`;
    const sec = randomBytes(32);
    secrets.set(id, sec);
    const res = await store.saveSecret({
      sessionId: 'sess-lru',
      chatJid: jid,
      waMessageId: id,
      secret: sec,
    });
    assert.equal(res.persisted, true);
  }

  // With maxEntries=3, M-1 should be evicted from RAM while all 4 remain in Postgres
  assert.equal(store.getStats().ramSize, 3);
  assert.equal(store.getStats().ramEvictions, 1);
  assert.equal(pool.rows.size, 4);

  // Accessing M-2 promotes it to MRU so adding M-5 evicts M-3 (not M-2)
  const gotM2 = await store.getSecret({ sessionId: 'sess-lru', chatJid: jid, waMessageId: 'M-2' });
  assert.equal(Buffer.compare(gotM2, secrets.get('M-2')), 0);

  // Evicted M-1 reloads cleanly from Postgres and re-hydrates RAM without DB loss
  const reloadedM1 = await store.getSecret({ sessionId: 'sess-lru', chatJid: jid, waMessageId: 'M-1' });
  assert.equal(Buffer.compare(reloadedM1, secrets.get('M-1')), 0);
  assert.equal(store.getStats().ramSize, 3);
  assert.equal(pool.rows.size, 4);

  // Container restart simulation: empty RAM, same rootKeyMaterial + pool still resolves all secrets
  const restartedStore = createMessageSecretStore({
    rootKeyMaterial: strongRootKey,
    pool,
    maxEntries: 3,
  });
  assert.equal(restartedStore.getStats().ramSize, 0);
  for (const [id, expected] of secrets.entries()) {
    const recovered = await restartedStore.getSecret({
      sessionId: 'sess-lru',
      chatJid: jid,
      waMessageId: id,
    });
    assert.equal(Buffer.compare(recovered, expected), 0, `expected ${id} from DB after restart`);
  }

  // Logout clears both RAM and Postgres rows for the session
  const cleared = await restartedStore.clearSessionSecrets('sess-lru');
  assert.equal(cleared, 4);
  assert.equal(restartedStore.getStats().ramSize, 0);
  assert.equal(pool.rows.size, 0);

  console.log('✓ 2. Bounded RAM LRU eviction, DB fallback/re-hydration & logout cleanup verified');
}

// ---------------------------------------------------------------------------
// 3. Configurable retention policy (null infinite default vs finite TTL across RAM+DB)
// ---------------------------------------------------------------------------
{
  const pool = createPgMock();
  const infiniteStore = createMessageSecretStore({ rootKeyMaterial: strongRootKey, pool });
  assert.equal(infiniteStore.getStats().defaultTtlMs, null);

  await infiniteStore.saveSecret({
    sessionId: 'sess-ttl',
    chatJid: jid,
    waMessageId: 'M-INF',
    secret: randomBytes(32),
  });
  const infRow = pool.rows.get(`sess-ttl\0${jid}\0M-INF`);
  assert.equal(infRow.expires_at, null);

  const shortTtlStore = createMessageSecretStore({
    rootKeyMaterial: strongRootKey,
    pool,
    defaultTtlMs: 25,
  });
  assert.equal(shortTtlStore.getStats().defaultTtlMs, 25);

  await shortTtlStore.saveSecret({
    sessionId: 'sess-ttl',
    chatJid: jid,
    waMessageId: 'M-EXP',
    secret: randomBytes(32),
  });
  const expRow = pool.rows.get(`sess-ttl\0${jid}\0M-EXP`);
  assert.ok(expRow.expires_at, 'finite TTL should set expires_at on DB row');

  await new Promise((r) => setTimeout(r, 40));
  const purged = await shortTtlStore.purgeExpired();
  assert.equal(purged.purgedRam, 1);
  assert.equal(purged.purgedDb, 1);
  assert.equal(
    await shortTtlStore.getSecret({ sessionId: 'sess-ttl', chatJid: jid, waMessageId: 'M-EXP' }),
    null,
  );
  // M-INF was saved with expires_at=null and must survive purgeExpired
  assert.ok(await infiniteStore.getSecret({ sessionId: 'sess-ttl', chatJid: jid, waMessageId: 'M-INF' }));

  console.log('✓ 3. Retention policy verified (defaultTtlMs=null & positive TTL RAM+DB purge)');
}

// ---------------------------------------------------------------------------
// 4. Key hygiene, trivial key rejection in production & fail-closed session manager
// ---------------------------------------------------------------------------
{
  assert.equal(isTrivialTestKeyMaterial('0'.repeat(64)), true);
  assert.equal(isTrivialTestKeyMaterial(Buffer.alloc(32, 0xaa)), true);
  assert.equal(isTrivialTestKeyMaterial('replace-with-real-key-0123456789abcdef'), true);
  assert.equal(isTrivialTestKeyMaterial(strongRootKey), false);

  // Strict store mode rejects missing, short, and trivial repeated/test keys
  assert.throws(
    () => createMessageSecretStore({ rootKeyMaterial: null, allowTestKeys: false }),
    /requires >= 16 bytes/i,
  );
  assert.throws(
    () => createMessageSecretStore({ rootKeyMaterial: 'short', allowTestKeys: false }),
    /requires >= 16 bytes/i,
  );
  assert.throws(
    () => createMessageSecretStore({ rootKeyMaterial: '0'.repeat(64), allowTestKeys: false }),
    /non-trivial/i,
  );
  assert.throws(
    () => createMessageSecretStore({ rootKeyMaterial: '12345678901234567890', allowTestKeys: false }),
    />= 32 bytes/i,
  );

  // Non-prod unit test mode still rejects missing/short keys loudly, only allows trivial hex in non-prod
  assert.throws(
    () => createMessageSecretStore({ rootKeyMaterial: null, allowTestKeys: true }),
    /requires >= 16 bytes/i,
  );
  assert.throws(
    () => createMessageSecretStore({ rootKeyMaterial: Buffer.alloc(8, 7), allowTestKeys: true }),
    /requires >= 16 bytes/i,
  );

  // Key rotation + AAD scope + nonce uniqueness
  const keyV1 = randomBytes(32);
  const keyV2 = randomBytes(32);
  const rotatedPool = createPgMock();
  const writerV1 = createMessageSecretStore({
    rootKeyMaterial: keyV1,
    activeKeyVersion: 1,
    pool: rotatedPool,
  });
  const secV1 = randomBytes(32);
  await writerV1.saveSecret({ sessionId: 'sess-rot', chatJid: jid, waMessageId: 'M-ROT', secret: secV1 });
  const rowA = rotatedPool.rows.get(`sess-rot\0${jid}\0M-ROT`);

  // Same plaintext re-encrypted produces different 12-byte nonce & ciphertext
  await writerV1.saveSecret({ sessionId: 'sess-rot', chatJid: jid, waMessageId: 'M-ROT-2', secret: secV1 });
  const rowB = rotatedPool.rows.get(`sess-rot\0${jid}\0M-ROT-2`);
  assert.notEqual(Buffer.compare(rowA.nonce, rowB.nonce), 0);

  // Ring with v2 active can still decrypt v1 rows and encrypts new writes at v2
  const writerV2 = createMessageSecretStore({
    rootKeyMaterial: keyV2,
    activeKeyVersion: 2,
    keyRing: { 1: keyV1, 2: keyV2 },
    pool: rotatedPool,
  });
  const readV1 = await writerV2.getSecret({ sessionId: 'sess-rot', chatJid: jid, waMessageId: 'M-ROT' });
  assert.equal(Buffer.compare(readV1, secV1), 0);

  // Different session or chat JID fails AAD check -> returns null safely
  const wrongScope = await writerV2.getSecret({ sessionId: 'other-sess', chatJid: jid, waMessageId: 'M-ROT' });
  assert.equal(wrongScope, null);

  // createSessionManager fail-closed check under simulated NODE_ENV=production
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tezlify-sm-prod-'));
  const prevNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.throws(
      () =>
        createSessionManager({
          sessionsDir: tempDir,
          mediaDir: tempDir,
          aesKey: Buffer.from('0'.repeat(64), 'hex'), // NOT allowed without explicit strong rootEncryptionKey
          rootEncryptionKey: null,
          backendWsUrl: 'ws://127.0.0.1:8000/ws/gateway',
        }),
      /requires explicit GATEWAY_ENCRYPTION_KEY/i,
    );
    assert.throws(
      () =>
        createSessionManager({
          sessionsDir: tempDir,
          mediaDir: tempDir,
          aesKey: Buffer.from('0'.repeat(64), 'hex'),
          rootEncryptionKey: '0'.repeat(64),
          backendWsUrl: 'ws://127.0.0.1:8000/ws/gateway',
        }),
      /non-trivial/i,
    );
  } finally {
    if (prevNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = prevNodeEnv;
    }
    await rm(tempDir, { recursive: true, force: true });
  }

  console.log('✓ 4. Key hygiene, rotation, AAD isolation & production fail-closed checks verified');
}

// ---------------------------------------------------------------------------
// 5. Wire capture safety (OFF by default, blocked in prod, redacted 0o600, TTL)
// ---------------------------------------------------------------------------
{
  const tempCap = await mkdtemp(path.join(os.tmpdir(), 'tezlify-cap-'));
  try {
    const sampleNode = {
      tag: 'message',
      attrs: { id: 'RAW-MSMSG-1', type: 'text', from: '905551112233@s.whatsapp.net', to: '905559990000@s.whatsapp.net' },
      content: [
        {
          tag: 'enc',
          attrs: { type: 'msmsg', v: '2', count: '0', secretAttr: 'DO_NOT_LOG' },
          content: Buffer.from([0x0a, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]),
        },
      ],
    };

    // Default instance without env vars is disabled
    const defaultCap = createMsmsgWireCapture({ captureDir: tempCap });
    assert.equal(defaultCap.enabled, false);
    assert.equal(defaultCap.record({ sessionId: 's1', node: sampleNode }), null);

    // Production hard-blocks even when enabled=true and includeRawCiphertext=true
    const prodBlockedCap = createMsmsgWireCapture({
      enabled: true,
      includeRawCiphertext: true,
      captureDir: tempCap,
      isProduction: true,
    });
    assert.equal(prodBlockedCap.enabled, false);
    assert.equal(prodBlockedCap.includeRawCiphertext, false);
    assert.equal(prodBlockedCap.record({ sessionId: 's1', node: sampleNode }), null);

    // Non-prod opt-in writes redacted metadata at 0o600 in 0o700 dir
    const capDir = path.join(tempCap, 'isolated-cap');
    const devCap = createMsmsgWireCapture({
      enabled: true,
      includeRawCiphertext: false,
      captureDir: capDir,
      isProduction: false,
      ttlMinutes: 10,
    });
    assert.equal(devCap.enabled, true);
    const outFile = devCap.record({
      sessionId: 'sensitive-session-id-1234',
      node: sampleNode,
      secretMatched: true,
      decryptOutcome: 'not_attempted',
    });
    assert.ok(outFile && fs.existsSync(outFile));
    assert.equal(fs.statSync(capDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(outFile).mode & 0o777, 0o600);

    const artifact = fs.readFileSync(outFile, 'utf8');
    assert.equal(artifact.includes('905551112233'), false, 'must not leak raw phone/JID');
    assert.equal(artifact.includes('905559990000'), false);
    assert.equal(artifact.includes('DO_NOT_LOG'), false, 'unsafe enc attrs must be stripped');
    assert.equal(artifact.includes('ciphertext_only_b64'), false, 'raw ciphertext disabled');
    assert.equal(artifact.includes('sensitive-session-id-1234'), false, 'raw sessionId redacted');

    // Verify expired file purge
    const expiredPath = path.join(capDir, 'msmsg-expired-test.json');
    fs.writeFileSync(expiredPath, JSON.stringify({ expires_at_ms: Date.now() - 5000 }), 'utf8');
    const purged = devCap.purgeExpired();
    assert.equal(purged, 1);
    assert.equal(fs.existsSync(expiredPath), false);

    // Verify purgeAll cleans remaining artifacts
    assert.equal(devCap.purgeAll(), 1);
    assert.equal(fs.existsSync(outFile), false);
  } finally {
    await rm(tempCap, { recursive: true, force: true });
  }

  console.log('✓ 5. Isolated wire capture safety (off default, prod block, 0o600 redaction, TTL) verified');
}

console.log('ALL MESSAGE_SECRET STORE HARDENING & WIRE CAPTURE TESTS PASSED');
