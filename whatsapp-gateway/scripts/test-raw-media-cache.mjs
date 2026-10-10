import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionStore, rememberRawMessage } from '../src/messages/message-store.js';
import {
  RAW_MEDIA_CACHE_FILE,
  RAW_MEDIA_CACHE_SAVE_DEBOUNCE_MS,
} from '../src/messages/raw-media-cache.js';

function tmpSessionDir(label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `gw-raw-media-${label}-`));
  return path.join(base, 'session-1');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const warnings = [];
const logger = { warn: (o) => warnings.push(o), info: () => {}, debug: () => {} };

const CHAT_JID = '905551234567@s.whatsapp.net';
const MEDIA_MSG_ID = 'TEST_MEDIA_MSG_123';
const SAMPLE_IMAGE_MESSAGE = {
  imageMessage: {
    url: 'https://mmg.whatsapp.net/v/t62.7118-24/test.enc',
    mimetype: 'image/jpeg',
    fileSha256: Buffer.from('fake-sha256'),
    fileLength: 1024,
    mediaKey: Buffer.from('fake-media-key-32-bytes-long!!!'),
    directPath: '/v/t62.7118-24/test.enc',
  },
};

const SAMPLE_TEXT_MESSAGE = {
  conversation: 'Hello without media',
};

console.log('[test-raw-media-cache] Running regression tests...');

// 1. Text messages are NOT cached in raw-media-cache
{
  const dir = tmpSessionDir('text-ignore');
  const store = createSessionStore({ sessionDir: dir, logger });
  rememberRawMessage(store, CHAT_JID, 'TEXT_1', SAMPLE_TEXT_MESSAGE);
  store.rawMediaCache.flush();

  const file = path.join(dir, RAW_MEDIA_CACHE_FILE);
  assert.equal(fs.existsSync(file), false, 'plain text message should not trigger media cache file');
}

// 2. Media messages ARE scheduled and persisted
{
  const dir = tmpSessionDir('media-persist');
  const store = createSessionStore({ sessionDir: dir, logger });
  rememberRawMessage(store, CHAT_JID, MEDIA_MSG_ID, SAMPLE_IMAGE_MESSAGE);

  // Before debounce: file not written yet
  const file = path.join(dir, RAW_MEDIA_CACHE_FILE);
  assert.equal(fs.existsSync(file), false, 'file not written before flush/debounce');

  // Explicit flush writes immediately
  store.rawMediaCache.flush();
  assert.equal(fs.existsSync(file), true, 'file written after flush');

  const content = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(content.items.length, 1);
  assert.equal(content.items[0].id, MEDIA_MSG_ID);
  assert.equal(content.items[0].jid, CHAT_JID);
  assert.ok(content.items[0].message.imageMessage);
  console.log('  ok - 1. Media message scheduled and persisted cleanly');
}

// 3. Restarting session store on same directory restores raw media into memory
{
  const dir = tmpSessionDir('restart-restore');
  const firstStore = createSessionStore({ sessionDir: dir, logger });
  rememberRawMessage(firstStore, CHAT_JID, MEDIA_MSG_ID, SAMPLE_IMAGE_MESSAGE);
  firstStore.rawMediaCache.flush();

  // Fresh session store simulating gateway container restart
  const secondStore = createSessionStore({ sessionDir: dir, logger });
  assert.ok(secondStore.rawMessagesByChat.get(CHAT_JID)?.has(MEDIA_MSG_ID), 'raw media message restored into memory');
  const restoredMsg = secondStore.rawMessagesByChat.get(CHAT_JID)?.get(MEDIA_MSG_ID);
  assert.equal(restoredMsg.imageMessage.mimetype, 'image/jpeg');
  assert.equal(restoredMsg.imageMessage.directPath, '/v/t62.7118-24/test.enc');
  console.log('  ok - 2. Container restart simulation successfully restored raw media proto');
}

// 4. Debounced auto-save without manual flush
{
  const dir = tmpSessionDir('debounce');
  const store = createSessionStore({ sessionDir: dir, logger });
  rememberRawMessage(store, CHAT_JID, 'AUTO_SAVE_MSG', SAMPLE_IMAGE_MESSAGE);
  await sleep(RAW_MEDIA_CACHE_SAVE_DEBOUNCE_MS + 250);

  const file = path.join(dir, RAW_MEDIA_CACHE_FILE);
  assert.equal(fs.existsSync(file), true, 'debounce timer wrote cache file automatically');
  console.log('  ok - 3. Debounce timer persists automatically without manual intervention');
}

// 5. DirectPath-only messages (no url) and deviceSentMessage wrapped media
{
  const dir = tmpSessionDir('directpath-devicesent');
  const store = createSessionStore({ sessionDir: dir, logger });

  const directPathOnlyMsg = {
    imageMessage: {
      directPath: '/v/t62.7118-24/direct-only.enc',
      mimetype: 'image/png',
      mediaKey: Buffer.from('fake-media-key-direct-path-32!!'),
      fileSha256: Buffer.from('sha256-direct-only'),
    },
  };

  const deviceSentMsg = {
    deviceSentMessage: {
      destinationJid: CHAT_JID,
      message: {
        imageMessage: {
          directPath: '/v/t62.7118-24/device-sent.enc',
          mimetype: 'image/jpeg',
          mediaKey: Buffer.from('fake-media-key-device-sent-32!!'),
        },
      },
    },
  };

  rememberRawMessage(store, CHAT_JID, 'DIRECT_ONLY_ID', directPathOnlyMsg);
  rememberRawMessage(store, CHAT_JID, 'DEVICE_SENT_ID', deviceSentMsg);
  store.rawMediaCache.flush();

  assert.equal(store.rawMediaCache.has('DIRECT_ONLY_ID'), true, 'directPath-only message cached');
  assert.equal(store.rawMediaCache.has('DEVICE_SENT_ID'), true, 'deviceSentMessage unwrapped and cached');

  const cachedDirect = store.rawMediaCache.get('DIRECT_ONLY_ID');
  assert.equal(cachedDirect?.id, 'DIRECT_ONLY_ID');
  assert.equal(cachedDirect?.jid, CHAT_JID);

  const cachedDeviceSent = store.rawMediaCache.get('DEVICE_SENT_ID');
  assert.equal(cachedDeviceSent?.id, 'DEVICE_SENT_ID');

  console.log('  ok - 4. directPath without url and deviceSentMessage correctly cached and retrieved via get()');
}

console.log('[test-raw-media-cache] All assertions passed successfully!');
