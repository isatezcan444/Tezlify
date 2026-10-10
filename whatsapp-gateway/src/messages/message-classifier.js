/**
 * WhatsApp Message Classification and Unwrapping Utilities.
 *
 * Implements single source of truth for message type resolution,
 * ephemeral/viewOnce unwrapping, media presence inspection, and outbound payload formatting.
 */
import { extractMessageContent, getContentType } from '@whiskeysockets/baileys';

/**
 * Deeply unwrap nested WhatsApp message envelopes.
 * Handles deviceSentMessage (phone-sent multi-device echo), viewOnce, ephemeral,
 * documentWithCaption, editedMessage, and Baileys extractMessageContent.
 */
export function unwrapMessageContent(content) {
  if (!content || typeof content !== 'object') return content;
  let current = content;
  for (let i = 0; i < 6; i++) {
    if (!current || typeof current !== 'object') break;
    if (current.deviceSentMessage?.message) {
      current = current.deviceSentMessage.message;
    } else if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
    } else if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
    } else if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
    } else if (current.viewOnceMessageV2Extension?.message) {
      current = current.viewOnceMessageV2Extension.message;
    } else if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
    } else if (current.editedMessage?.message?.protocolMessage?.editedMessage) {
      current = current.editedMessage.message.protocolMessage.editedMessage;
    } else if (current.protocolMessage?.editedMessage) {
      current = current.protocolMessage.editedMessage;
    } else if (current.associatedChildMessage?.message) {
      current = current.associatedChildMessage.message;
    } else if (current.groupStatusMessage?.message) {
      current = current.groupStatusMessage.message;
    } else if (current.groupStatusMessageV2?.message) {
      current = current.groupStatusMessageV2.message;
    } else if (current.botInvokeMessage?.message) {
      current = current.botInvokeMessage.message;
    } else {
      break;
    }
  }
  const extracted = extractMessageContent(current);
  return extracted || current;
}

export function resolveDownloadableMedia(messageContent) {
  const content = unwrapMessageContent(messageContent);
  const contentType = content ? getContentType(content) : null;
  const media = contentType ? content?.[contentType] : null;
  if (!media || typeof media !== 'object') return null;
  const hasDownloadable = Boolean(
    ('url' in media && media.url) ||
    ('directPath' in media && media.directPath) ||
    ('thumbnailDirectPath' in media && media.thumbnailDirectPath) ||
    ('mediaKey' in media && media.mediaKey) ||
    ('jpegThumbnail' in media && media.jpegThumbnail)
  );
  if (!hasDownloadable) return null;
  const mediaType = contentType ? contentType.replace('Message', '') : 'image';
  return { contentType, mediaType, media };
}

export function classifyMessageType(content) {
  const c = unwrapMessageContent(content) || {};
  if (c.imageMessage) return 'IMAGE';
  if (c.documentMessage) return 'DOCUMENT';
  if (c.audioMessage) return 'AUDIO';
  if (c.videoMessage || c.ptvMessage) return 'VIDEO';
  if (c.stickerMessage) return 'STICKER';
  if (c.locationMessage || c.liveLocationMessage) return 'LOCATION';
  if (c.contactMessage || c.contactsArrayMessage) return 'CONTACT';
  if (c.pollCreationMessage || c.pollCreationMessageV2 || c.pollCreationMessageV3 || c.pollUpdateMessage) return 'OTHER';
  if (c.templateMessage) return 'TEMPLATE';
  if (c.conversation || c.extendedTextMessage || c.interactiveMessage || c.buttonsMessage || c.buttonsResponseMessage || c.listResponseMessage || c.groupInviteMessage || c.orderMessage) return 'TEXT';
  return 'TEXT';
}

export function hasRecognizedContent(content) {
  const c = unwrapMessageContent(content) || {};
  return Boolean(
    c.imageMessage || c.documentMessage || c.audioMessage || c.videoMessage || c.ptvMessage ||
    c.stickerMessage || c.conversation || c.extendedTextMessage ||
    c.locationMessage || c.liveLocationMessage || c.contactMessage || c.contactsArrayMessage ||
    c.pollCreationMessage || c.pollCreationMessageV2 || c.pollCreationMessageV3 || c.pollUpdateMessage ||
    c.interactiveMessage || c.templateMessage || c.buttonsMessage || c.buttonsResponseMessage ||
    c.listResponseMessage || c.groupInviteMessage || c.orderMessage
  );
}

export function bufferToDataUrl(val, mimeType = 'image/jpeg') {
  if (!val) return null;
  try {
    let buf = null;
    if (Buffer.isBuffer(val)) {
      buf = val;
    } else if (val instanceof Uint8Array) {
      buf = Buffer.from(val);
    } else if (typeof val === 'string') {
      if (val.startsWith('data:')) return val;
      buf = Buffer.from(val, 'base64');
    }
    if (buf && buf.length > 0) {
      return `data:${mimeType};base64,${buf.toString('base64')}`;
    }
  } catch {
    return null;
  }
  return null;
}

export function extractQuotedMessageMetadata(messageContent, resolveSenderName) {
  const content = unwrapMessageContent(messageContent) || messageContent || {};
  const contextInfo =
    content.extendedTextMessage?.contextInfo ||
    content.imageMessage?.contextInfo ||
    content.videoMessage?.contextInfo ||
    content.documentMessage?.contextInfo ||
    content.audioMessage?.contextInfo ||
    content.stickerMessage?.contextInfo ||
    content.locationMessage?.contextInfo ||
    content.contactMessage?.contextInfo ||
    content.buttonsResponseMessage?.contextInfo ||
    content.templateButtonReplyMessage?.contextInfo ||
    content.listResponseMessage?.contextInfo;

  if (!contextInfo || !contextInfo.quotedMessage) {
    return null;
  }

  const rawQuoted = extractMessageContent(contextInfo.quotedMessage) || contextInfo.quotedMessage;
  if (!rawQuoted || typeof rawQuoted !== 'object') {
    return null;
  }

  const stanzaId = contextInfo.stanzaId || null;
  const participant = contextInfo.participant || null;

  let messageType = 'TEXT';
  let body = '';
  let thumbnail = null;

  if (rawQuoted.videoMessage) {
    messageType = 'VIDEO';
    body = rawQuoted.videoMessage.caption?.trim() || 'Video';
    if (rawQuoted.videoMessage.jpegThumbnail) {
      thumbnail = bufferToDataUrl(rawQuoted.videoMessage.jpegThumbnail, 'image/jpeg');
    }
  } else if (rawQuoted.imageMessage) {
    messageType = 'IMAGE';
    body = rawQuoted.imageMessage.caption?.trim() || 'Fotoğraf';
    if (rawQuoted.imageMessage.jpegThumbnail) {
      thumbnail = bufferToDataUrl(rawQuoted.imageMessage.jpegThumbnail, 'image/jpeg');
    }
  } else if (rawQuoted.documentMessage) {
    messageType = 'DOCUMENT';
    body = (rawQuoted.documentMessage.fileName || rawQuoted.documentMessage.title || rawQuoted.documentMessage.caption || 'Belge').trim();
    if (rawQuoted.documentMessage.jpegThumbnail) {
      thumbnail = bufferToDataUrl(rawQuoted.documentMessage.jpegThumbnail, 'image/jpeg');
    }
  } else if (rawQuoted.audioMessage) {
    messageType = 'AUDIO';
    body = rawQuoted.audioMessage.ptt ? 'Sesli mesaj' : 'Ses kaydı';
  } else if (rawQuoted.stickerMessage) {
    messageType = 'STICKER';
    body = 'Çıkartma';
    if (rawQuoted.stickerMessage.pngThumbnail) {
      thumbnail = bufferToDataUrl(rawQuoted.stickerMessage.pngThumbnail, 'image/png');
    }
  } else if (rawQuoted.locationMessage) {
    messageType = 'LOCATION';
    body = rawQuoted.locationMessage.name || rawQuoted.locationMessage.address || 'Konum';
    if (rawQuoted.locationMessage.jpegThumbnail) {
      thumbnail = bufferToDataUrl(rawQuoted.locationMessage.jpegThumbnail, 'image/jpeg');
    }
  } else if (rawQuoted.contactMessage) {
    messageType = 'CONTACT';
    body = rawQuoted.contactMessage.displayName || 'Kişi';
  } else if (rawQuoted.conversation) {
    messageType = 'TEXT';
    body = rawQuoted.conversation;
  } else if (rawQuoted.extendedTextMessage) {
    messageType = 'TEXT';
    body = rawQuoted.extendedTextMessage.text || '';
    if (rawQuoted.extendedTextMessage.jpegThumbnail) {
      thumbnail = bufferToDataUrl(rawQuoted.extendedTextMessage.jpegThumbnail, 'image/jpeg');
    }
  }

  let senderName = null;
  if (typeof resolveSenderName === 'function' && participant) {
    try {
      senderName = resolveSenderName(participant);
    } catch {
      senderName = null;
    }
  }

  return {
    stanza_id: stanzaId,
    participant: participant,
    sender_name: senderName || null,
    message_type: messageType,
    body: body || '',
    thumbnail: thumbnail || null,
  };
}

export function extractLinkPreviewMetadata(messageContent) {
  const content = extractMessageContent(messageContent) || messageContent || {};
  const ext = content.extendedTextMessage;
  if (!ext || typeof ext !== 'object') return null;
  const url = ext.matchedText || ext.canonicalUrl || null;
  const title = ext.title || null;
  const description = ext.description || null;
  let jpegThumbnailBuffer = null;
  if (ext.jpegThumbnail) {
    if (Buffer.isBuffer(ext.jpegThumbnail)) {
      jpegThumbnailBuffer = ext.jpegThumbnail;
    } else if (typeof ext.jpegThumbnail === 'string') {
      try {
        jpegThumbnailBuffer = Buffer.from(ext.jpegThumbnail, 'base64');
      } catch {
        jpegThumbnailBuffer = null;
      }
    } else if (ext.jpegThumbnail instanceof Uint8Array) {
      jpegThumbnailBuffer = Buffer.from(ext.jpegThumbnail);
    }
  }
  if (!url && !title && !description && !jpegThumbnailBuffer) return null;
  return {
    url,
    title,
    description,
    jpegThumbnailBuffer,
  };
}

/**
 * Metinsiz sistem/protokol/ifade/arama mesajlari icin bir preview isareti uretir.
 *
 * Bu turler `classifyMessageType`ta 'TEXT'e duser ve govdeleri bostur; eski
 * davranista `normalizePreviewText('TEXT', '')` bos dondugu icin sohbetin
 * onizlemesi BOS kaliyordu. Bos onizleme sadece kozmetik degil: backend
 * `last_message_at` guncellemesini onizleme dolu mu diye kapiladigi icin bu
 * sohbetlerin SIRALAMA damgasi da ilerlemiyordu (canli olcum 2026-09-26:
 * 113 sohbetin 21'i bos onizlemeli).
 *
 * Donen deger `[CALL]` gibi bir isarettir — `normalizePreviewText` bunu
 * `TYPE_PREVIEW_LABELS` uzerinden okunabilir etikete cevirir. Bilerek
 * `message_type` DEGISTIRILMEZ: DB enum'unda SYSTEM/REACTION degeri yok ve
 * bu yardimci yalnizca onizleme icindir.
 */
export function systemContentMarker(waMsg) {
  const rawContent = waMsg?.message || {};
  const c = extractMessageContent(rawContent) || rawContent || {};
  if (c.protocolMessage) {
    // REVOKE (0) = "Bu mesaji sildiniz"; digerleri (duzenleme, ephemeral ayari,
    // gecmis senkronu...) da WhatsApp Web'de sistem satiri olarak gorunur.
    const ptype = Number(c.protocolMessage.type);
    return ptype === 0 ? '[REVOKED]' : '[SYSTEM]';
  }
  if (c.reactionMessage) return '[REACTION]';
  if (c.call || c.callLogMessage) return '[CALL]';
  if (
    c.pollCreationMessage || c.pollCreationMessageV2 ||
    c.pollCreationMessageV3 || c.pollUpdateMessage
  ) {
    return '[POLL]';
  }
  if (c.eventMessage) return '[EVENT]';
  // Grup bildirimleri ("... ayarlarini degistirdiniz", "X gruba eklendi",
  // "kullanici adini olusturdu") icerik tasimaz; tur wrapper'daki
  // `messageStubType` alanindadir. 0 = UNKNOWN, yani stub DEGIL.
  const stub = waMsg?.messageStubType;
  const stubNum = typeof stub?.toNumber === 'function' ? stub.toNumber() : Number(stub);
  if (Number.isFinite(stubNum) && stubNum > 0) return '[SYSTEM]';
  return null;
}

export function parseVCardPhone(vcard) {
  if (!vcard) return '';
  const lines = String(vcard).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^TEL/i.test(trimmed)) {
      const idx = trimmed.indexOf(':');
      if (idx !== -1) {
        return trimmed.slice(idx + 1).trim();
      }
    }
  }
  return '';
}

export function parseVCardName(vcard) {
  if (!vcard) return '';
  const lines = String(vcard).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^FN/i.test(trimmed)) {
      const idx = trimmed.indexOf(':');
      if (idx !== -1) {
        return trimmed.slice(idx + 1).trim();
      }
    }
  }
  return '';
}

export function extractContactPayload(content) {
  const c = unwrapMessageContent(content) || {};
  if (c.contactMessage) {
    const cm = c.contactMessage;
    const vcard = cm.vcard || '';
    const phone = parseVCardPhone(vcard);
    const displayName = cm.displayName || parseVCardName(vcard) || phone || 'Kişi';
    return {
      displayName,
      vcard,
      phone,
      contacts: [{ displayName, vcard, phone }],
    };
  }
  if (c.contactsArrayMessage) {
    const cam = c.contactsArrayMessage;
    const rawList = Array.isArray(cam.contacts) ? cam.contacts : [];
    const contacts = rawList.map((item) => {
      const vc = item.vcard || '';
      const ph = parseVCardPhone(vc);
      const name = item.displayName || parseVCardName(vc) || ph || 'Kişi';
      return { displayName: name, vcard: vc, phone: ph };
    });
    const displayName =
      cam.displayName ||
      (contacts.length > 0
        ? contacts.length === 1
          ? contacts[0].displayName
          : `${contacts.length} kişi`
        : 'Kişi');
    return {
      displayName,
      contacts,
      phone: contacts[0]?.phone || '',
    };
  }
  return null;
}

export function extractLocationPayload(content) {
  const c = unwrapMessageContent(content) || {};
  if (c.locationMessage) {
    const lm = c.locationMessage;
    const lat = lm.degreesLatitude;
    const lng = lm.degreesLongitude;
    const url = lm.url || (lat != null && lng != null ? `https://maps.google.com/?q=${lat},${lng}` : '');
    return {
      latitude: lat,
      longitude: lng,
      name: lm.name || '',
      address: lm.address || '',
      url,
      comment: lm.comment || '',
      jpegThumbnail: bufferToDataUrl(lm.jpegThumbnail, 'image/jpeg'),
      isLive: false,
    };
  }
  if (c.liveLocationMessage) {
    const llm = c.liveLocationMessage;
    const lat = llm.degreesLatitude;
    const lng = llm.degreesLongitude;
    const url = lat != null && lng != null ? `https://maps.google.com/?q=${lat},${lng}` : '';
    return {
      latitude: lat,
      longitude: lng,
      caption: llm.caption || '',
      url,
      isLive: true,
      jpegThumbnail: bufferToDataUrl(llm.jpegThumbnail, 'image/jpeg'),
    };
  }
  return null;
}

export function extractPollPayload(content) {
  const c = unwrapMessageContent(content) || {};
  const poll = c.pollCreationMessage || c.pollCreationMessageV2 || c.pollCreationMessageV3;
  if (poll) {
    return {
      question: poll.name || '',
      options: (poll.options || []).map((o) => (typeof o === 'string' ? o : o.optionName || '')),
      selectableOptionsCount: poll.selectableOptionsCount || 1,
    };
  }
  return null;
}

export function summarizeWaMessage(waMsg) {
  const rawContent = waMsg?.message || {};
  const content = unwrapMessageContent(rawContent) || rawContent;
  const contact = extractContactPayload(content);
  if (contact) {
    return { message_type: 'CONTACT', body: JSON.stringify(contact) };
  }
  const location = extractLocationPayload(content);
  if (location) {
    return { message_type: 'LOCATION', body: JSON.stringify(location) };
  }
  const poll = extractPollPayload(content);
  if (poll) {
    return { message_type: 'OTHER', body: JSON.stringify(poll) };
  }
  const text =
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.interactiveMessage?.body?.text ||
    content.templateMessage?.hydratedTemplate?.hydratedContentText ||
    content.templateMessage?.fourRowTemplate?.content?.text ||
    content.buttonsMessage?.contentText ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    content.groupInviteMessage?.caption ||
    content.orderMessage?.orderTitle ||
    '';
  if (text) return { message_type: classifyMessageType(content), body: text };
  // Metin yok. Medya tipleri icin `normalizePreviewText` kendi etiketini uretir;
  // metinsiz sistem turleri icin isareti biz veriyoruz ki preview bos kalmasin.
  return { message_type: classifyMessageType(content), body: systemContentMarker(waMsg) || '' };
}

export function buildMediaContent({
  media_type,
  media_url,
  media_base64,
  mime_type,
  caption,
  filename,
}) {
  const type = (media_type || 'document').toLowerCase();
  const buffer = media_base64 ? Buffer.from(media_base64, 'base64') : null;
  const source = buffer || { url: media_url };
  if (type === 'image') {
    return { image: source, mimetype: mime_type || undefined, caption: caption || '' };
  }
  const isAudio = Boolean(
    type === 'audio' ||
    type === 'voice' ||
    type === 'ptt' ||
    (mime_type && mime_type.startsWith('audio/')) ||
    (filename && (filename.toLowerCase().startsWith('voice_') || filename.toLowerCase().endsWith('.ogg') || filename.toLowerCase().endsWith('.opus')))
  );
  if (isAudio) {
    const isPtt = Boolean(
      type === 'voice' ||
      type === 'ptt' ||
      (filename && filename.toLowerCase().includes('voice')) ||
      (mime_type && (mime_type.includes('ogg') || mime_type.includes('opus') || mime_type.includes('webm')))
    );
    return {
      audio: source,
      mimetype: isPtt ? 'audio/ogg; codecs=opus' : (mime_type || 'audio/mpeg'),
      ptt: isPtt,
    };
  }
  if (type === 'video') {
    return { video: source, mimetype: mime_type || undefined, caption: caption || '' };
  }
  return {
    document: source,
    mimetype: mime_type || 'application/octet-stream',
    fileName: filename || 'belge.bin',
    caption: caption || '',
  };
}
