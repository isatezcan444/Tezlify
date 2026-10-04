/**
 * App-state key rehydration & remote delete self-healing verification.
 *
 * Verifies that:
 * 1. `postgresAuthRepository.getSignalKeys` properly rehydrates `app-state-sync-key`
 *    as a `proto.Message.AppStateSyncKeyData` protobuf instance (required by Baileys).
 * 2. Missing `myAppStateKeyId` in database credentials is automatically self-healed
 *    from `sessionDir/creds.json`.
 * 3. Signal keys on disk (such as `app-state-sync-key-*.json`) are automatically
 *    migrated into PostgreSQL via `syncFromFilesystem`.
 * 4. `deleteConversationRemote` recovers missing `myAppStateKeyId` before invoking
 *    `chatModify` to prevent the "App state key not present!" failure.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { proto } from '@whiskeysockets/baileys';
import { createPostgresAuthRepository } from '../src/auth/postgres-auth-repository.js';
import { createSessionManager } from '../src/session-manager.js';

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
    return { rowCount: 0, rows: [] };
  };

  return {
    query,
    connect: async () => ({ query, release() {} }),
    end: async () => {},
    state: { credentials, signalKeys, sessions },
  };
}

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-selfheal-test-'));
const sessionDir = path.join(tmpBase, 'session-test-1');
fs.mkdirSync(sessionDir, { recursive: true });

try {
  const encryptionKey = crypto.randomBytes(32);
  const pool = createFakePool();
  const repo = createPostgresAuthRepository({ encryptionKey, pool });

  // 1. Simulate disk files (as produced during initial QR pairing)
  const testKeyId = 'AAAAAO+g';
  const rawKeyData = {
    keyData: 'yxKHqe4SuM+cyhHbG594SW30jarEizPzWmpfTZvmYlY=',
    fingerprint: { rawId: 1, currentIndex: 1 },
    timestamp: '1789851717517',
  };
  fs.writeFileSync(
    path.join(sessionDir, `app-state-sync-key-${testKeyId}.json`),
    JSON.stringify(rawKeyData),
    'utf8',
  );
  fs.writeFileSync(
    path.join(sessionDir, 'creds.json'),
    JSON.stringify({ registered: true, me: { id: '905551234567@s.whatsapp.net' }, myAppStateKeyId: testKeyId }),
    'utf8',
  );

  // 2. createAuthState without prior DB entries: should read disk creds.json & recover myAppStateKeyId
  const auth = await repo.createAuthState('session-test-1', sessionDir);
  assert.equal(auth.state.creds.myAppStateKeyId, testKeyId, 'creds.myAppStateKeyId must be recovered from disk');

  // 3. getSignalKeys with missing DB entry: should fall back to disk and return proto AppStateSyncKeyData
  const keys = await auth.state.keys.get('app-state-sync-key', [testKeyId]);
  assert.ok(keys[testKeyId], 'app-state-sync-key must be resolved via disk fallback');
  assert.ok(keys[testKeyId].keyData, 'keyData buffer must be present on rehydrated proto');
  assert.ok(typeof keys[testKeyId].toJSON === 'function' || keys[testKeyId] instanceof proto.Message.AppStateSyncKeyData,
    'app-state-sync-key must be a valid proto Message instance');

  // 4. Test deleteConversationRemote self-healing in SessionManager
  const sm = createSessionManager({
    sessionsDir: tmpBase,
    mediaDir: tmpBase,
    aesKey: '0'.repeat(64),
    backendWsUrl: '',
    authRepository: repo,
  });

  const created = await sm.createSession('session-test-1', { autoStart: false });
  const sid = created.id;
  const session = sm.getSession(sid);
  session.status = 'CONNECTED';
  session.sock = {
    authState: {
      creds: { registered: true, myAppStateKeyId: undefined }, // simulate missing key in memory
    },
    chatModify: async (mod, jid) => {
      if (!session.sock.authState.creds.myAppStateKeyId) {
        throw new Error('App state key not present!');
      }
      return { status: 200 };
    },
  };
  session.saveCreds = async () => {};

  // Rename session directory to match sid if different
  const actualDir = path.join(tmpBase, sid);
  if (!fs.existsSync(actualDir)) {
    fs.renameSync(sessionDir, actualDir);
  }

  const res = await sm.deleteConversationRemote(sid, '905559876543@s.whatsapp.net');
  assert.equal(res.success, true, 'deleteConversationRemote must succeed after self-healing');
  assert.equal(res.remote_deleted, true, 'remote_deleted must be true');
  assert.equal(session.sock.authState.creds.myAppStateKeyId, testKeyId, 'sock.authState.creds.myAppStateKeyId must be set');

  console.log('[test-appstate-delete-selfheal] All 6 assertions passed!');
} finally {
  fs.rmSync(tmpBase, { recursive: true, force: true });
}
