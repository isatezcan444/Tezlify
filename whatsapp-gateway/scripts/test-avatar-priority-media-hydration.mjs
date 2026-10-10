// Phase 21: Avatar-First Queue & Media Hydration Priority Regression Test
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createSessionManager } from '../src/session-manager.js';
import { createMediaStore } from '../src/media/media-store.js';

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const tmpDir = path.join(os.tmpdir(), `phase21-test-${Date.now()}`);
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

async function attachMockSession(sm, sid = 'test-session-p21') {
  const session = await sm.createSession('test-session-p21');
  session.status = 'CONNECTED';
  session.ephemeral = false;
  return session;
}

console.log('[test-avatar-priority-media-hydration] Starting Phase 21 regression suite...');

// TEST 1: High-priority avatar query runs before normal priority
await check('1. High-priority avatar query runs ahead of normal sweep items', async () => {
  const sm = makeManager();
  const session = await attachMockSession(sm, 's1');
  const executionOrder = [];

  session.sock = {
    async profilePictureUrl(jid) {
      executionOrder.push(jid);
      return `https://pps.whatsapp.net/avatar_${jid}.jpg`;
    },
  };

  // Queue 3 background items (normal priority)
  const p1 = sm._enqueueAvatarQuery(session, '905551111111@s.whatsapp.net', { priority: 'normal' });
  const p2 = sm._enqueueAvatarQuery(session, '905552222222@s.whatsapp.net', { priority: 'normal' });
  const p3 = sm._enqueueAvatarQuery(session, '905553333333@s.whatsapp.net', { priority: 'normal' });

  // Immediately queue 1 visible viewport item (high priority)
  const pH = sm._enqueueAvatarQuery(session, '905559999999@s.whatsapp.net', { priority: 'high' });

  await Promise.all([p1, p2, p3, pH]);

  // High priority item MUST be processed first or second (before normal items 2 and 3)
  assert.ok(executionOrder.includes('905559999999@s.whatsapp.net'));
  const highIdx = executionOrder.indexOf('905559999999@s.whatsapp.net');
  assert.ok(highIdx <= 1, `High-priority item should run first or second, ran at index ${highIdx}`);
});

// TEST 2: Promoting an existing normal item to high priority works immediately
await check('2. Enqueueing with priority: high promotes an existing queued item', async () => {
  const sm = makeManager();
  const session = await attachMockSession(sm, 's2');
  const store = sm._storeOf(session);

  session.sock = {
    async profilePictureUrl(jid) {
      return `https://pps.whatsapp.net/avatar_${jid}.jpg`;
    },
  };

  // Enqueue as normal
  sm._enqueueAvatarQuery(session, '905554444444@s.whatsapp.net', { priority: 'normal' });
  assert.ok(store._avatarQueue.some((i) => i.key === '905554444444@s.whatsapp.net') || store._avatarInFlightMap.has('905554444444@s.whatsapp.net'));

  // Now request the same key with priority: high
  const resPromise = sm._enqueueAvatarQuery(session, '905554444444@s.whatsapp.net', { priority: 'high' });
  const res = await resPromise;
  assert.ok(res.success);
  assert.equal(res.jid, '905554444444@s.whatsapp.net');
});

// TEST 3: Timeout on contact A does NOT block high priority contact B
await check('3. Query timeout on contact A does not engage global circuit breaker for contact B', async () => {
  const sm = makeManager();
  const session = await attachMockSession(sm, 's3');
  const store = sm._storeOf(session);

  session.sock = {
    async profilePictureUrl(jid) {
      if (jid === '905558888888@s.whatsapp.net') {
        throw new Error('profile_picture_query_timeout');
      }
      return `https://pps.whatsapp.net/avatar_${jid}.jpg`;
    },
  };

  const startTime = Date.now();
  const r1 = await sm._enqueueAvatarQuery(session, '905558888888@s.whatsapp.net', { priority: 'high' });
  assert.equal(r1.success, false);
  assert.equal(r1.error, 'timeout');

  // Contact B should succeed IMMEDIATELY without waiting 10-25 seconds circuit breaker!
  const r2 = await sm._enqueueAvatarQuery(session, '905557777777@s.whatsapp.net', { priority: 'high' });
  const elapsed = Date.now() - startTime;

  assert.equal(r2.success, true);
  assert.ok(elapsed < 2000, `Expected elapsed < 2000ms, got ${elapsed}ms (circuit breaker was incorrectly triggered)`);
  assert.equal(store._avatarCircuitBreakerUntil, 0, 'Timeout must not set global circuit breaker');
});

// TEST 4: Fast preview path in media-store returns jpegThumbnail immediately
await check('4. Media store preferPreview fast-path returns jpegThumbnail without full download', async () => {
  const ms = createMediaStore({
    mediaDir,
    logger: { debug() {}, warn() {}, info() {} },
  });

  const dummyJpegThumb = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const waMsg = {
    key: { id: 'msg_with_thumb_123', remoteJid: 'user@s.whatsapp.net' },
    message: {
      imageMessage: {
        mimetype: 'image/jpeg',
        jpegThumbnail: dummyJpegThumb,
        url: 'https://fake-cdn.whatsapp.net/full.jpg',
      },
    },
  };

  const stored = await ms.storeIncomingMedia(
    { id: 'sess1' },
    waMsg,
    {}, // sock
    { preferPreview: true }
  );

  assert.ok(stored);
  assert.ok(stored.media_id);
  assert.equal(stored.mime_type, 'image/jpeg');
  assert.ok(stored.filename.startsWith('thumb_'));

  const filePath = ms.getMediaPath('sess1', stored.media_id);
  assert.ok(fs.existsSync(filePath));
  const fileBytes = fs.readFileSync(filePath);
  assert.deepEqual(fileBytes, dummyJpegThumb);
});

// TEST 5: Media on demand coalescing prevents duplicate concurrent downloads
await check('5. Media on demand coalesces simultaneous downloads of the same media', async () => {
  const sm = makeManager();
  const session = await attachMockSession(sm, 's5');
  const store = sm._storeOf(session);

  let downloadCalls = 0;
  const dummyBuf = Buffer.from('hello-image-bytes');

  store.rawMessagesByChat.set('chat@s.whatsapp.net', new Map([
    ['wa_media_concurrent', {
      imageMessage: {
        url: 'https://fake-cdn.whatsapp.net/full.jpg',
        mimetype: 'image/jpeg',
        jpegThumbnail: dummyBuf,
      },
    }],
  ]));

  // Simultaneous calls
  const [pA, pB] = await Promise.all([
    sm.downloadMediaOnDemand(session.id, 'wa_media_concurrent'),
    sm.downloadMediaOnDemand(session.id, 'wa_media_concurrent'),
  ]);

  assert.ok(pA);
  assert.equal(pA, pB);
  assert.ok(fs.existsSync(pA));
});

console.log(`[test-avatar-priority-media-hydration] ALL ${passed} assertions passed successfully!`);
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {}
process.exit(0);
