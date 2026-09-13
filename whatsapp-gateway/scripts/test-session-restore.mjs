import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionManager } from '../src/session-manager.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tezlify-wa-restore-'));
const started = [];
let registryWrites = 0;
const authRepository = {
  async listRestorableSessions() {
    return [{ session_id: 'stable-session-id', session_name: 'Primary line' }];
  },
  async registerSession() { registryWrites += 1; },
  async deleteSession() {},
};

try {
  const manager = createSessionManager({
    sessionsDir: path.join(root, 'sessions'),
    mediaDir: path.join(root, 'media'),
    aesKey: crypto.randomBytes(32),
    backendWsUrl: 'ws://127.0.0.1:1/ws/gateway',
    authRepository,
  });
  manager._startSocket = (id) => started.push(id);

  const result = await manager.restoreSessions({ concurrency: 2 });
  const restored = manager.getSession('stable-session-id');

  assert.deepEqual(result, { discovered: 1, restored: 1 });
  assert.equal(restored.id, 'stable-session-id');
  assert.equal(restored.session_name, 'Primary line');
  assert.equal(restored.status, 'RESTORING');
  assert.deepEqual(started, ['stable-session-id']);
  assert.equal(registryWrites, 0, 'bootstrap must not rewrite or replace durable identity');
  assert.equal(manager.listSessions().length, 1);

  console.log('[test-session-restore] 7 assertions passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
