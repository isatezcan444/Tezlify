import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionManager } from '../src/session-manager.js';

console.log('[test-history-orchestration] starting tests...');

const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-orch-'));
try {
  const sm = createSessionManager({ sessionsDir: dir, mediaDir: dir, aesKey: '0'.repeat(64), backendWsUrl: '' });
  const sid = (await sm.createSession('history-test', { autoStart: false })).id;
  const session = sm.getSession(sid);
  session.status = 'CONNECTED';

  let fetchHistoryCalls = [];
  // Mock sock with fetchMessageHistory
  session.sock = {
    fetchMessageHistory: async (count, oldestMsgKey, oldestMsgTimestamp) => {
      fetchHistoryCalls.push({ count, oldestMsgKey, oldestMsgTimestamp });
      return 'pdo-msg-123';
    },
    ev: {
      on: () => {},
      emit: () => {},
    },
  };

  const store = sm._storeOf(session);
  const chatJid = '905551112233@s.whatsapp.net';

  // Seed store with 2 messages
  store.messagesByChat.set(chatJid, [
    { id: 1000, wa_message_id: 'msg_older', timestamp_s: 1000, body: 'older' },
    { id: 2000, wa_message_id: 'msg_newer', timestamp_s: 2000, body: 'newer' },
  ]);

  // TEST 1: requestOlderHistory sends PDO with oldest message as anchor
  const p1 = sm.requestOlderHistory(sid, chatJid, { count: 20, timeoutMs: 50 });
  assert.equal(fetchHistoryCalls.length, 1, 'sock.fetchMessageHistory should be called once');
  assert.equal(fetchHistoryCalls[0].count, 20);
  assert.equal(fetchHistoryCalls[0].oldestMsgKey.id, 'msg_older');
  assert.equal(fetchHistoryCalls[0].oldestMsgKey.remoteJid, chatJid);

  // TEST 2: Concurrent call with same anchor reuses in-flight operation (Deduplication)
  const p2 = sm.requestOlderHistory(sid, chatJid, { count: 20, timeoutMs: 50 });
  assert.equal(fetchHistoryCalls.length, 1, 'Concurrent request should NOT trigger second provider call');

  const res1 = await p1;
  const res2 = await p2;
  assert.equal(res1.status, 'TIMEOUT');
  assert.equal(res2.status, 'TIMEOUT');

  // TEST 3: When explicit anchor provided
  fetchHistoryCalls = [];
  const p3 = sm.requestOlderHistory(sid, chatJid, {
    count: 30,
    oldestMsgId: 'custom_anchor_99',
    oldestMsgFromMe: false,
    oldestMsgTimestampMs: 500000,
    timeoutMs: 50,
  });
  assert.equal(fetchHistoryCalls.length, 1);
  assert.equal(fetchHistoryCalls[0].count, 30);
  assert.equal(fetchHistoryCalls[0].oldestMsgKey.id, 'custom_anchor_99');
  assert.equal(fetchHistoryCalls[0].oldestMsgTimestamp, 500000);
  await p3;

  // TEST 4: getMessages without fetchProvider returns local store
  const localMsgs = await sm.getMessages(sid, chatJid, { limit: 10 });
  assert.equal(localMsgs.length, 2);

  // TEST 5: getMessages with fetchProvider=true triggers requestOlderHistory when local messages < limit
  fetchHistoryCalls = [];
  const p5 = sm.getMessages(sid, chatJid, { limit: 10, fetchProvider: true, timeoutMs: 50 });
  const localAfterFetch = await p5;
  assert.equal(fetchHistoryCalls.length, 1, 'getMessages with fetchProvider should call provider');
  assert.equal(localAfterFetch.length, 2);

  console.log('[test-history-orchestration] ALL 5 assertions passed.');
} finally {
  await rm(dir, { recursive: true, force: true });
}
