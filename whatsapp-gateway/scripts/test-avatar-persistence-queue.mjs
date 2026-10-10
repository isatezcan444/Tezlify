// Phase 22: WhatsApp Gateway Avatar Queue & Persistence Regression Test
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createSessionManager } from '../src/session-manager.js';

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const tmpDir = path.join(os.tmpdir(), `phase22-gateway-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
const sessionsDir = path.join(tmpDir, 'sessions');
const mediaDir = path.join(tmpDir, 'media');
fs.mkdirSync(sessionsDir, { recursive: true });
fs.mkdirSync(mediaDir, { recursive: true });

function makeManager() {
  return createSessionManager({
    sessionsDir,
    mediaDir,
    aesKey: '1'.repeat(64),
    backendWsUrl: '',
  });
}

async function attachMockSession(sm, sid = 'test-session-p22') {
  const session = await sm.createSession(sid);
  session.status = 'CONNECTED';
  session.ephemeral = false;
  return session;
}

console.log('[test-avatar-persistence-queue] Starting Phase 22 Gateway regression suite...');

// Scenario 11: Aynı JID için high-priority ve normal queue arasında mükerrer iş oluşmaz
await check('Scenario 11: Queue deduplicates queries for the same JID across priorities', async () => {
  const sm = makeManager();
  const session = await attachMockSession(sm, 's-dedup');
  let networkCalls = 0;
  const targetJid = '905551112233@s.whatsapp.net';

  session.sock = {
    async profilePictureUrl(jid) {
      if (jid === targetJid) networkCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return `https://pps.whatsapp.net/avatar_${jid}.jpg`;
    },
  };

  // Queue same JID as normal, then as high priority
  const pNormal = sm._enqueueAvatarQuery(session, targetJid, { priority: 'normal' });
  const pHigh = sm._enqueueAvatarQuery(session, targetJid, { priority: 'high' });

  const [resNormal, resHigh] = await Promise.all([pNormal, pHigh]);

  assert.equal(networkCalls, 1, 'Exactly 1 network call should be issued for identical concurrent JID query');
  assert.equal(resNormal.avatar_url, resHigh.avatar_url, 'Both callers must resolve to the same avatar URL');
  assert.ok(resNormal.avatar_url.includes(targetJid));
});

// Scenario 12: Bir avatar sorgusu timeout olduğunda diğer sohbetlerin avatarları yüklenmeye devam eder
await check('Scenario 12: Query failure/timeout on one contact does not block remaining avatars', async () => {
  const sm = makeManager();
  const session = await attachMockSession(sm, 's-timeout');
  const slowFailingJid = '905550000000@s.whatsapp.net';
  const fastSuccessJid = '905559999999@s.whatsapp.net';

  session.sock = {
    async profilePictureUrl(jid) {
      if (jid === slowFailingJid) {
        throw new Error('408 Request Timeout');
      }
      return `https://pps.whatsapp.net/avatar_success.jpg`;
    },
  };

  const pFailing = sm._enqueueAvatarQuery(session, slowFailingJid, { priority: 'high' });
  const pSuccess = sm._enqueueAvatarQuery(session, fastSuccessJid, { priority: 'normal' });

  const [resFailing, resSuccess] = await Promise.all([pFailing, pSuccess]);

  assert.equal(resFailing.success, false, 'Failing avatar should resolve to success: false without crashing');
  assert.equal(resSuccess.avatar_url, 'https://pps.whatsapp.net/avatar_success.jpg', 'Other contact must successfully load its avatar');
});

// Scenario 13: Session değiştiğinde önceki session\'ın geç tamamlanan işi yeni session state\'ini kirletmez
await check('Scenario 13: Stale avatar work from closed session does not pollute new session store', async () => {
  const sm = makeManager();
  const oldSession = await attachMockSession(sm, 's-old');
  const newSession = await attachMockSession(sm, 's-new');
  
  const testJid = '905558887766@s.whatsapp.net';
  let finishWork;
  const delayedPromise = new Promise((resolve) => { finishWork = resolve; });

  oldSession.sock = {
    async profilePictureUrl() {
      await delayedPromise;
      return 'https://pps.whatsapp.net/avatar_old_leak.jpg';
    },
  };

  const pOld = sm._enqueueAvatarQuery(oldSession, testJid, { priority: 'normal' });

  // Simulate old session disconnecting / closing
  oldSession.status = 'DISCONNECTED';
  oldSession.lifecycle.beginAttempt(); // Advance generation to invalidate old socket work

  finishWork();
  await pOld;

  const newStore = sm._storeOf(newSession);
  const newChat = newStore.chats.get(testJid);
  assert.equal(newChat, undefined, 'New session store must not contain contaminated data from old session');
});

// Gateway Avatar Persistence Test 1: _touchChat preserves avatar_url
await check('Gateway: _touchChat preserves avatar_url from contact or existing chat', async () => {
  const sm = makeManager();
  const session = await attachMockSession(sm, 's-touch');
  const store = sm._storeOf(session);
  const jid = '905557778899@s.whatsapp.net';

  // Seed contact with avatar
  store.contacts.set(jid, {
    id: jid,
    jid,
    name: 'Merve',
    avatar_url: 'https://pps.whatsapp.net/merve.jpg',
  });

  // Touch chat with a new inbound message
  sm._touchChat(session, jid, { timestamp: new Date().toISOString(), preview: 'Selam' });

  const chat = store.chats.get(jid);
  assert.ok(chat, 'Chat must be created');
  assert.equal(chat.avatar_url, 'https://pps.whatsapp.net/merve.jpg', 'Chat must inherit avatar_url from contact');

  // Touch chat again with empty update - avatar must be preserved
  sm._touchChat(session, jid, { timestamp: new Date().toISOString(), preview: 'İkinci mesaj' });
  const chat2 = store.chats.get(jid);
  assert.equal(chat2.avatar_url, 'https://pps.whatsapp.net/merve.jpg', 'Subsequent touch must preserve avatar_url');
});

// Gateway Avatar Persistence Test 2: _mergeLidChatIntoPhone preserves avatar_url
await check('Gateway: _mergeLidChatIntoPhone preserves avatar_url across LID reconciliation', async () => {
  const sm = makeManager();
  const session = await attachMockSession(sm, 's-lid-merge');
  const store = sm._storeOf(session);
  const phoneJid = '905553334455@s.whatsapp.net';
  const lidJid = '12345678901234@lid';

  // Existing phone chat with known avatar
  store.chats.set(phoneJid, {
    id: phoneJid,
    jid: phoneJid,
    name: 'Can',
    avatar_url: 'https://pps.whatsapp.net/can_avatar.jpg',
  });

  // Incoming LID chat with null avatar
  store.chats.set(lidJid, {
    id: lidJid,
    jid: lidJid,
    name: 'Can (LID)',
    avatar_url: null,
  });

  // Merge LID chat into phone chat via _applyLidMapping
  sm._applyLidMapping(session, lidJid, phoneJid);

  const merged = store.chats.get(phoneJid);
  assert.ok(merged, 'Merged chat must exist');
  assert.equal(merged.avatar_url, 'https://pps.whatsapp.net/can_avatar.jpg', 'avatar_url must not be clobbered by null in LID chat');
});

console.log(`\nAll ${passed} Phase 22 Gateway avatar tests PASSED!`);
process.exit(0);
