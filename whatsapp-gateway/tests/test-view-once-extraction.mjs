import assert from 'node:assert';
import { isViewOnceMessage, classifyMessageType, unwrapMessageContent, hasRecognizedContent } from '../src/messages/message-classifier.js';
import { normalizePreviewText, TYPE_PREVIEW_LABELS } from '../src/utils/whatsapp-formatting.js';

console.log('Testing isViewOnceMessage, classifyMessageType and view-once formatting...');

// 1. Direct viewOnceMessage wrapper
const msgViewOnceV1 = {
  viewOnceMessage: {
    message: {
      imageMessage: {
        url: 'https://mmg.whatsapp.net/1',
        mimetype: 'image/jpeg',
      },
    },
  },
};
assert.strictEqual(isViewOnceMessage(msgViewOnceV1), true, 'Should detect viewOnceMessage');
assert.strictEqual(classifyMessageType(msgViewOnceV1), 'IMAGE', 'Should classify viewOnceMessage as IMAGE');

// 2. Direct viewOnceMessageV2 wrapper
const msgViewOnceV2 = {
  viewOnceMessageV2: {
    message: {
      videoMessage: {
        url: 'https://mmg.whatsapp.net/2',
        mimetype: 'video/mp4',
      },
    },
  },
};
assert.strictEqual(isViewOnceMessage(msgViewOnceV2), true, 'Should detect viewOnceMessageV2');
assert.strictEqual(classifyMessageType(msgViewOnceV2), 'VIDEO', 'Should classify viewOnceMessageV2 as VIDEO');

// 3. viewOnceMessageV2Extension
const msgViewOnceV2Ext = {
  viewOnceMessageV2Extension: {
    message: {
      audioMessage: {
        url: 'https://mmg.whatsapp.net/ext',
        mimetype: 'audio/ogg',
      },
    },
  },
};
assert.strictEqual(isViewOnceMessage(msgViewOnceV2Ext), true, 'Should detect viewOnceMessageV2Extension');
assert.strictEqual(classifyMessageType(msgViewOnceV2Ext), 'AUDIO', 'Should classify viewOnceMessageV2Extension audio as AUDIO');

// 4. Ephemeral wrapped viewOnce
const msgEphemeralViewOnce = {
  ephemeralMessage: {
    message: {
      viewOnceMessageV2: {
        message: {
          imageMessage: {
            url: 'https://mmg.whatsapp.net/3',
            mimetype: 'image/jpeg',
          },
        },
      },
    },
  },
};
assert.strictEqual(isViewOnceMessage(msgEphemeralViewOnce), true, 'Should detect viewOnce inside ephemeralMessage');
assert.strictEqual(classifyMessageType(msgEphemeralViewOnce), 'IMAGE', 'Should classify ephemeral viewOnce as IMAGE');

// 5. deviceSentMessage wrapped viewOnce
const msgDeviceSentViewOnce = {
  deviceSentMessage: {
    message: {
      viewOnceMessage: {
        message: {
          imageMessage: {
            url: 'https://mmg.whatsapp.net/ds',
            mimetype: 'image/jpeg',
          },
        },
      },
    },
  },
};
assert.strictEqual(isViewOnceMessage(msgDeviceSentViewOnce), true, 'Should detect viewOnce inside deviceSentMessage');
assert.strictEqual(classifyMessageType(msgDeviceSentViewOnce), 'IMAGE', 'Should classify deviceSent viewOnce as IMAGE');

// 6. unwrapped imageMessage with viewOnce: true flag
const msgInnerViewOnce = {
  imageMessage: {
    url: 'https://mmg.whatsapp.net/4',
    mimetype: 'image/jpeg',
    viewOnce: true,
  },
};
assert.strictEqual(isViewOnceMessage(msgInnerViewOnce), true, 'Should detect imageMessage.viewOnce');
assert.strictEqual(classifyMessageType(msgInnerViewOnce), 'IMAGE', 'Should classify imageMessage.viewOnce as IMAGE');

// 7. ptvMessage with viewOnce
const msgPtvViewOnce = {
  ptvMessage: {
    url: 'https://mmg.whatsapp.net/ptv',
    mimetype: 'video/mp4',
    viewOnce: true,
  },
};
assert.strictEqual(isViewOnceMessage(msgPtvViewOnce), true, 'Should detect ptvMessage with viewOnce');
assert.strictEqual(classifyMessageType(msgPtvViewOnce), 'VIDEO', 'Should classify ptvMessage viewOnce as VIDEO');

// 8. Baileys companion stanza: key.isViewOnce = true, message = undefined
const keyViewOnce = { id: '3A3722FDB1BAA33AB219', isViewOnce: true, remoteJid: '12345@g.us' };
assert.strictEqual(isViewOnceMessage(undefined, keyViewOnce), true, 'Should detect viewOnce from key when message is undefined');
assert.strictEqual(isViewOnceMessage(null, keyViewOnce), true, 'Should detect viewOnce from key when message is null');
assert.strictEqual(classifyMessageType(undefined, keyViewOnce), 'UNKNOWN', 'Should classify key-only viewOnce as UNKNOWN');

// 9. Baileys companion stanza: key.isViewOnce = true, message = empty object {}
assert.strictEqual(isViewOnceMessage({}, keyViewOnce), true, 'Should detect viewOnce from key when message is empty object');
assert.strictEqual(classifyMessageType({}, keyViewOnce), 'UNKNOWN', 'Should classify empty message with key.isViewOnce as UNKNOWN');

// 10. Message with embedded key: { key: { isViewOnce: true } }
const msgWithKeyViewOnce = { key: { isViewOnce: true, id: 'WA_KEY_VO' } };
assert.strictEqual(isViewOnceMessage(msgWithKeyViewOnce), true, 'Should detect viewOnce when content has key.isViewOnce');
assert.strictEqual(classifyMessageType(msgWithKeyViewOnce), 'UNKNOWN', 'Should classify key-embedded message as UNKNOWN');

// 11. Standard non-viewOnce image
const msgNormalImage = {
  imageMessage: {
    url: 'https://mmg.whatsapp.net/5',
    mimetype: 'image/jpeg',
  },
};
assert.strictEqual(isViewOnceMessage(msgNormalImage), false, 'Should be false for normal image');
assert.strictEqual(classifyMessageType(msgNormalImage), 'IMAGE', 'Should classify normal image as IMAGE');

// 12. Standard text message
const msgNormalText = {
  conversation: 'Merhaba Dünya',
};
assert.strictEqual(isViewOnceMessage(msgNormalText), false, 'Should be false for normal text');
assert.strictEqual(classifyMessageType(msgNormalText), 'TEXT', 'Should classify normal text as TEXT');

// 13. Non-view-once ciphertext/stub message
const msgStub = {
  key: { id: 'STUB_ID', isViewOnce: false },
  messageStubType: 2,
};
assert.strictEqual(isViewOnceMessage(msgStub), false, 'Should be false for stub message without isViewOnce');

// 14. Preview text normalization
assert.strictEqual(
  normalizePreviewText('IMAGE', '[VIEW_ONCE_PHOTO]'),
  '📷 Tek görüntülenmelik fotoğraf',
  'Should normalize [VIEW_ONCE_PHOTO]'
);
assert.strictEqual(
  normalizePreviewText('VIDEO', '[VIEW_ONCE_VIDEO]'),
  '🎥 Tek görüntülenmelik video',
  'Should normalize [VIEW_ONCE_VIDEO]'
);
assert.strictEqual(
  normalizePreviewText('AUDIO', '[VIEW_ONCE_AUDIO]'),
  '🎵 Tek görüntülenmelik sesli mesaj',
  'Should normalize [VIEW_ONCE_AUDIO]'
);
assert.strictEqual(
  normalizePreviewText('UNKNOWN', '[VIEW_ONCE_MEDIA]'),
  '👁️ Tek görüntülenmelik medya',
  'Should normalize [VIEW_ONCE_MEDIA]'
);

console.log('✅ All view-once gateway tests passed successfully!');
