import assert from 'node:assert/strict';
import { extractQuotedMessageMetadata, bufferToDataUrl } from '../src/messages/message-classifier.js';

console.log('Testing extractQuotedMessageMetadata...');

// 1. Quoted video with thumbnail and caption
const videoMsg = {
  extendedTextMessage: {
    text: 'İsa bu tutar mı sence, sen bilirsin 😄',
    contextInfo: {
      stanzaId: '3EB0C0CEB4CC782A77EEB4',
      participant: '228269022560256@lid',
      quotedMessage: {
        videoMessage: {
          caption: 'oyun videosu',
          mimetype: 'video/mp4',
          seconds: 15,
          jpegThumbnail: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        },
      },
    },
  },
};

const res1 = extractQuotedMessageMetadata(videoMsg, (jid) => (jid === '228269022560256@lid' ? 'Tolga Cebeci' : null));
assert.ok(res1, 'Should extract quoted metadata');
assert.equal(res1.stanza_id, '3EB0C0CEB4CC782A77EEB4');
assert.equal(res1.sender_name, 'Tolga Cebeci');
assert.equal(res1.message_type, 'VIDEO');
assert.equal(res1.body, 'oyun videosu');
assert.ok(res1.thumbnail.startsWith('data:image/jpeg;base64,'), 'Thumbnail should be base64 data URL');

// 2. Quoted video with NO caption (fallback 'Video')
const videoNoCaption = {
  extendedTextMessage: {
    text: 'bak bakalım',
    contextInfo: {
      stanzaId: 'V123',
      participant: 'user@s.whatsapp.net',
      quotedMessage: {
        videoMessage: {
          mimetype: 'video/mp4',
          jpegThumbnail: Buffer.from([1, 2, 3]),
        },
      },
    },
  },
};
const res2 = extractQuotedMessageMetadata(videoNoCaption);
assert.equal(res2.message_type, 'VIDEO');
assert.equal(res2.body, 'Video');
assert.ok(res2.thumbnail.startsWith('data:image/jpeg;base64,'));

// 3. Quoted image message
const imgMsg = {
  extendedTextMessage: {
    text: 'güzelmiş',
    contextInfo: {
      stanzaId: 'IMG123',
      participant: 'me@s.whatsapp.net',
      quotedMessage: {
        imageMessage: {
          caption: 'jantlar',
          mimetype: 'image/jpeg',
          jpegThumbnail: Buffer.from([4, 5, 6]),
        },
      },
    },
  },
};
const res3 = extractQuotedMessageMetadata(imgMsg, () => 'ME');
assert.equal(res3.message_type, 'IMAGE');
assert.equal(res3.body, 'jantlar');
assert.equal(res3.sender_name, 'ME');

// 4. Quoted voice note
const audioMsg = {
  extendedTextMessage: {
    text: 'tamamdır dinledim',
    contextInfo: {
      stanzaId: 'A123',
      quotedMessage: {
        audioMessage: {
          ptt: true,
          seconds: 10,
        },
      },
    },
  },
};
const res4 = extractQuotedMessageMetadata(audioMsg);
assert.equal(res4.message_type, 'AUDIO');
assert.equal(res4.body, 'Sesli mesaj');
assert.equal(res4.thumbnail, null);

// 5. Message with no contextInfo or quotedMessage
const plainMsg = {
  conversation: 'normal mesaj',
};
const res5 = extractQuotedMessageMetadata(plainMsg);
assert.equal(res5, null);

// 6. Quoted View Once photo (MUST strip thumbnail and set is_view_once: true)
const quotedVoMsg = {
  extendedTextMessage: {
    text: 'harika fotoğrafmış',
    contextInfo: {
      stanzaId: 'VO_STANZA_1',
      participant: 'friend@s.whatsapp.net',
      quotedMessage: {
        viewOnceMessage: {
          message: {
            imageMessage: {
              mimetype: 'image/jpeg',
              jpegThumbnail: Buffer.from([0xff, 0xd8, 0xff]),
            },
          },
        },
      },
    },
  },
};
const res6 = extractQuotedMessageMetadata(quotedVoMsg, () => 'Friend');
assert.ok(res6, 'Should extract quoted VO');
assert.equal(res6.stanza_id, 'VO_STANZA_1');
assert.equal(res6.is_view_once, true);
assert.equal(res6.thumbnail, null, 'View once thumbnail must NEVER be leaked in quote');
assert.equal(res6.body, '[VIEW_ONCE_PHOTO]');

// 7. Quoted Revoked message (MUST strip body, strip thumbnail, and set is_revoked: true)
const quotedRevokedMsg = {
  extendedTextMessage: {
    text: 'ne yazmıştın?',
    contextInfo: {
      stanzaId: 'REVOKED_STANZA_1',
      participant: 'friend@s.whatsapp.net',
      quotedMessage: {
        protocolMessage: {
          key: { id: 'REVOKED_STANZA_1' },
          type: 0, // REVOKE
        },
      },
    },
  },
};
const res7 = extractQuotedMessageMetadata(quotedRevokedMsg, () => 'Friend');
assert.ok(res7, 'Should extract quoted revoked');
assert.equal(res7.stanza_id, 'REVOKED_STANZA_1');
assert.equal(res7.is_revoked, true);
assert.equal(res7.body, '');
assert.equal(res7.thumbnail, null);

console.log('✅ All extractQuotedMessageMetadata tests passed successfully!');
