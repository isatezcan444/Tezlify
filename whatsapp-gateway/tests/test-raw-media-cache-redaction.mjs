import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  RAW_MEDIA_CACHE_FILE,
  RAW_MEDIA_CACHE_VERSION,
  createRawMediaCache,
  sanitizeMediaCacheMessage,
} from '../src/messages/raw-media-cache.js';
import {
  createSessionStore,
  lookupRawMessage,
  rememberRawMessage,
} from '../src/messages/message-store.js';
import {
  extractQuotedMessageMetadata,
  isViewOnceMessage,
  resolveDownloadableMedia,
} from '../src/messages/message-classifier.js';

console.log('=== RUNNING STAGE 1.4 RAW MEDIA CACHE REDACTION & LIFECYCLE SUITE ===');

function b64Secret(label) {
  return Buffer.concat([Buffer.from(label, 'utf8'), randomBytes(24)]).toString('base64');
}

const audioSecret = b64Secret('audio_secret_');
const imageSecret = b64Secret('image_secret_');
const docSecret = b64Secret('doc_secret_');
const quotedSecret = b64Secret('quoted_secret_');
const futureSecret = b64Secret('future_secret_');
const viewOnceSecret = b64Secret('vo_secret_');
const deviceSentSecret = b64Secret('ds_secret_');

const dummyMediaKey = randomBytes(32).toString('base64');
const dummySha = randomBytes(32).toString('base64');
const dummyThumb = Buffer.from('fake-jpeg-thumb').toString('base64');

// ---------------------------------------------------------------------------
// 1. Recursive sanitization preserves media + reply metadata, removes secrets
// ---------------------------------------------------------------------------
{
  const audioMsg = {
    audioMessage: {
      url: 'https://mmg.whatsapp.net/v/t62.7117-24/audio.enc',
      directPath: '/v/t62.7117-24/audio.enc',
      mediaKey: dummyMediaKey,
      mediaKeyTimestamp: 1730000000,
      fileSha256: dummySha,
      fileEncSha256: dummySha,
      mimetype: 'audio/ogg; codecs=opus',
      seconds: 4,
      ptt: true,
      contextInfo: {
        stanzaId: 'QUOTED-ORIGIN-1',
        participant: '905551112233@s.whatsapp.net',
        futureUnknownSecret: futureSecret,
        encSecret: futureSecret,
        quotedMessage: {
          conversation: 'Alinti yapilan mesaj',
          messageContextInfo: {
            messageSecret: quotedSecret,
            botMessageSecret: quotedSecret,
          },
        },
      },
    },
    messageContextInfo: {
      messageSecret: audioSecret,
      reportingTokenInfo: { reportingTag: 'secret-tag-1' },
      deviceListMetadata: {
        senderTimestamp: 1730000000,
        senderKeyHash: 'not-a-secret-keyhash-or-is-it',
        ratchetKey: futureSecret,
      },
    },
  };

  const { sanitized, redactedCount } = sanitizeMediaCacheMessage(audioMsg);
  assert.ok(redactedCount >= 5, `expected multiple secrets stripped, got ${redactedCount}`);
  const serialized = JSON.stringify(sanitized);

  for (const leaked of [audioSecret, quotedSecret, futureSecret, 'secret-tag-1']) {
    assert.equal(serialized.includes(leaked), false, `must not contain secret marker ${leaked}`);
  }
  assert.equal('messageSecret' in (sanitized.messageContextInfo || {}), false);
  assert.equal('futureUnknownSecret' in (sanitized.audioMessage?.contextInfo || {}), false);
  assert.equal('encSecret' in (sanitized.audioMessage?.contextInfo || {}), false);

  // Legitimate media download & quote/reply fields must remain untouched
  const media = resolveDownloadableMedia(sanitized);
  assert.equal(media.mediaType, 'audio');
  assert.equal(media.media.mediaKey, dummyMediaKey);
  assert.equal(media.media.directPath, '/v/t62.7117-24/audio.enc');

  const quoted = extractQuotedMessageMetadata(sanitized);
  assert.equal(quoted.stanza_id, 'QUOTED-ORIGIN-1');
  assert.equal(quoted.participant, '905551112233@s.whatsapp.net');
  assert.equal(quoted.body, 'Alinti yapilan mesaj');
  console.log('✓ 1. AUDIO + contextInfo + quotedMessage secrets stripped; media & quote intact');
}

// ---------------------------------------------------------------------------
// 2. View Once, deviceSentMessage, IMAGE, DOCUMENT preservation & redaction
// ---------------------------------------------------------------------------
{
  const viewOnceImage = {
    viewOnceMessageV2: {
      message: {
        imageMessage: {
          url: 'https://mmg.whatsapp.net/v/t62.7118-24/vo.enc',
          directPath: '/v/t62.7118-24/vo.enc',
          mediaKey: dummyMediaKey,
          fileSha256: dummySha,
          fileEncSha256: dummySha,
          mimetype: 'image/jpeg',
          jpegThumbnail: dummyThumb,
          viewOnce: true,
        },
        messageContextInfo: {
          messageSecret: viewOnceSecret,
        },
      },
    },
    messageContextInfo: {
      messageSecret: imageSecret,
    },
  };

  const { sanitized } = sanitizeMediaCacheMessage(viewOnceImage);
  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes(viewOnceSecret), false);
  assert.equal(serialized.includes(imageSecret), false);
  assert.equal(isViewOnceMessage(sanitized), true);

  const media = resolveDownloadableMedia(sanitized);
  assert.equal(media.mediaType, 'image');
  assert.equal(media.media.mediaKey, dummyMediaKey);
  assert.equal(media.media.jpegThumbnail, dummyThumb);

  const deviceSentAudio = {
    deviceSentMessage: {
      destinationJid: '905551112233@s.whatsapp.net',
      message: {
        audioMessage: {
          url: 'https://mmg.whatsapp.net/v/t62.7117-24/ds-audio.enc',
          directPath: '/v/t62.7117-24/ds-audio.enc',
          mediaKey: dummyMediaKey,
          mimetype: 'audio/ogg; codecs=opus',
        },
        messageContextInfo: {
          messageSecret: deviceSentSecret,
        },
      },
    },
  };
  const { sanitized: cleanDs } = sanitizeMediaCacheMessage(deviceSentAudio);
  assert.equal(JSON.stringify(cleanDs).includes(deviceSentSecret), false);
  assert.equal(resolveDownloadableMedia(cleanDs)?.mediaType, 'audio');
  console.log('✓ 2. ViewOnce & deviceSentMessage secrets stripped; media descriptors preserved');
}

// ---------------------------------------------------------------------------
// 3. Disk persistence (0o600), reload, media download compatibility, scope check
// ---------------------------------------------------------------------------
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tezlify-raw-cache-'));
try {
  const sessionDir = path.join(tempRoot, 'session-a');
  const store1 = createSessionStore({ sessionDir });
  const jid = '905551112233@s.whatsapp.net';

  const imgMsg = {
    imageMessage: {
      url: 'https://mmg.whatsapp.net/v/t62.7118-24/img.enc',
      directPath: '/v/t62.7118-24/img.enc',
      mediaKey: dummyMediaKey,
      fileSha256: dummySha,
      fileEncSha256: dummySha,
      mimetype: 'image/jpeg',
      jpegThumbnail: dummyThumb,
      thumbnailDirectPath: '/v/t62.7118-24/img-thumb.enc',
    },
    messageContextInfo: { messageSecret: imageSecret },
  };
  const docMsg = {
    documentMessage: {
      url: 'https://mmg.whatsapp.net/v/t62.7119-24/doc.enc',
      directPath: '/v/t62.7119-24/doc.enc',
      mediaKey: dummyMediaKey,
      fileSha256: dummySha,
      fileEncSha256: dummySha,
      mimetype: 'application/pdf',
      fileName: 'teklif.pdf',
    },
    messageContextInfo: { messageSecret: docSecret },
  };
  const audioMsg = {
    audioMessage: {
      url: 'https://mmg.whatsapp.net/v/t62.7117-24/voice.enc',
      directPath: '/v/t62.7117-24/voice.enc',
      mediaKey: dummyMediaKey,
      fileSha256: dummySha,
      fileEncSha256: dummySha,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true,
    },
    messageContextInfo: { messageSecret: audioSecret },
  };

  rememberRawMessage(store1, jid, 'MSG-IMG-1', imgMsg);
  rememberRawMessage(store1, jid, 'MSG-DOC-1', docMsg);
  rememberRawMessage(store1, jid, 'MSG-AUD-1', audioMsg);
  store1.rawMediaCache.flush();

  const cacheFile = path.join(sessionDir, RAW_MEDIA_CACHE_FILE);
  assert.equal(fs.existsSync(cacheFile), true);

  const stat = fs.statSync(cacheFile);
  assert.equal(stat.mode & 0o777, 0o600, `expected 0o600 mode, got ${(stat.mode & 0o777).toString(8)}`);

  const rawText = fs.readFileSync(cacheFile, 'utf8');
  for (const secret of [imageSecret, docSecret, audioSecret]) {
    assert.equal(rawText.includes(secret), false, 'raw-media-cache.json leaked a messageSecret');
  }
  assert.equal(rawText.includes('messageSecret'), false);

  const parsed = JSON.parse(rawText);
  assert.equal(parsed.version, RAW_MEDIA_CACHE_VERSION);
  assert.equal(parsed.items.length, 3);

  // Simulate restart: new store loads sanitized cache from disk
  const store2 = createSessionStore({ sessionDir });
  for (const [id, expectedType] of [
    ['MSG-IMG-1', 'image'],
    ['MSG-DOC-1', 'document'],
    ['MSG-AUD-1', 'audio'],
  ]) {
    const reloaded = lookupRawMessage(store2, { remoteJid: jid, id });
    assert.ok(reloaded, `expected ${id} after reload`);
    const resolved = resolveDownloadableMedia(reloaded);
    assert.equal(resolved?.mediaType, expectedType);
    assert.equal(resolved?.media?.mediaKey, dummyMediaKey);
  }

  // Cross-chat lookup via disk cache fallback must respect jid scope
  store2.rawMessagesByChat.clear();
  const wrongChatLookup = lookupRawMessage(store2, {
    remoteJid: '905559998877@s.whatsapp.net',
    id: 'MSG-IMG-1',
  });
  assert.equal(wrongChatLookup, undefined, 'cross-chat cache lookup must not leak raw message');
  const rightChatLookup = lookupRawMessage(store2, { remoteJid: jid, id: 'MSG-IMG-1' });
  assert.ok(rightChatLookup);

  console.log('✓ 3. Disk cache is v2, mode 0o600, zero secrets, reload & jid scope verified');

  // -------------------------------------------------------------------------
  // 4. Legacy v1 cache migration: scrubs secrets in place without data loss
  // -------------------------------------------------------------------------
  const legacyDir = path.join(tempRoot, 'session-legacy');
  fs.mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
  const legacySecret = b64Secret('legacy_leak_');
  const legacyFile = path.join(legacyDir, RAW_MEDIA_CACHE_FILE);
  fs.writeFileSync(
    legacyFile,
    JSON.stringify({
      version: 1,
      saved_at: '2026-01-01T00:00:00.000Z',
      items: [
        {
          jid,
          id: 'LEGACY-AUD-1',
          saved_at: 1700000000000,
          message: {
            audioMessage: {
              url: 'https://mmg.whatsapp.net/v/t62.7117-24/legacy.enc',
              directPath: '/v/t62.7117-24/legacy.enc',
              mediaKey: dummyMediaKey,
              mimetype: 'audio/ogg; codecs=opus',
              contextInfo: {
                stanzaId: 'LEGACY-Q-1',
                quotedMessage: {
                  conversation: 'Eski alinti',
                  messageContextInfo: { messageSecret: legacySecret },
                },
              },
            },
            messageContextInfo: {
              messageSecret: legacySecret,
              botMessageSecret: legacySecret,
            },
          },
        },
      ],
    }),
    'utf8',
  );

  const infoLogs = [];
  const legacyStore = createSessionStore({
    sessionDir: legacyDir,
    logger: {
      info: (meta, msg) => infoLogs.push({ meta, msg }),
      warn: () => {},
      debug: () => {},
    },
  });

  // Legacy item must still be usable for media download & quote extraction
  const migratedMsg = lookupRawMessage(legacyStore, { remoteJid: jid, id: 'LEGACY-AUD-1' });
  assert.ok(migratedMsg, 'legacy media entry must NOT be wiped');
  assert.equal(resolveDownloadableMedia(migratedMsg)?.media?.mediaKey, dummyMediaKey);
  assert.equal(extractQuotedMessageMetadata(migratedMsg)?.body, 'Eski alinti');

  // Legacy disk file must have been rewritten at v2 without any leaked secret
  const scrubbedDisk = fs.readFileSync(legacyFile, 'utf8');
  assert.equal(scrubbedDisk.includes(legacySecret), false, 'legacy secret must be scrubbed from disk');
  assert.equal(scrubbedDisk.includes('messageSecret'), false);
  const scrubbedJson = JSON.parse(scrubbedDisk);
  assert.equal(scrubbedJson.version, RAW_MEDIA_CACHE_VERSION);
  assert.equal(scrubbedJson.items.length, 1);
  assert.equal(fs.statSync(legacyFile).mode & 0o777, 0o600);
  assert.ok(
    infoLogs.some((l) => l.msg.includes('Sanitized legacy raw media cache')),
    'expected structured info log for legacy cache sanitization',
  );

  // delete(id) works cleanly
  assert.equal(legacyStore.rawMediaCache.has('LEGACY-AUD-1'), true);
  legacyStore.rawMediaCache.delete('LEGACY-AUD-1');
  assert.equal(legacyStore.rawMediaCache.has('LEGACY-AUD-1'), false);

  // Also test createRawMediaCache directly with empty secret-only message -> not cached (no downloadable media)
  const directCache = createRawMediaCache({ sessionDir: path.join(tempRoot, 'direct') });
  directCache.schedule(jid, 'TEXT-ONLY', {
    conversation: 'plain text',
    messageContextInfo: { messageSecret: b64Secret('text_') },
  });
  assert.equal(directCache.has('TEXT-ONLY'), false);

  console.log('✓ 4. Legacy v1 cache scrubbed to v2 on startup without deleting media history');
  console.log('ALL RAW MEDIA CACHE REDACTION TESTS PASSED');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
