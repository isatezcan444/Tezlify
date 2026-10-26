import assert from 'node:assert';
import { isViewOnceMessage, unwrapMessageContent } from '../src/messages/message-classifier.js';
import { normalizePreviewText, TYPE_PREVIEW_LABELS } from '../src/utils/whatsapp-formatting.js';

console.log('Testing isViewOnceMessage and view-once formatting...');

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

// 3. Ephemeral wrapped viewOnce
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

// 4. unwrapped imageMessage with viewOnce: true flag
const msgInnerViewOnce = {
  imageMessage: {
    url: 'https://mmg.whatsapp.net/4',
    mimetype: 'image/jpeg',
    viewOnce: true,
  },
};
assert.strictEqual(isViewOnceMessage(msgInnerViewOnce), true, 'Should detect imageMessage.viewOnce');

// 5. Standard non-viewOnce image
const msgNormalImage = {
  imageMessage: {
    url: 'https://mmg.whatsapp.net/5',
    mimetype: 'image/jpeg',
  },
};
assert.strictEqual(isViewOnceMessage(msgNormalImage), false, 'Should be false for normal image');

// 6. Preview text normalization
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

console.log('✅ All view-once gateway tests passed successfully!');
