/**
 * WhatsApp Message Classification and Unwrapping Utilities.
 *
 * Implements single source of truth for message type resolution,
 * ephemeral/viewOnce unwrapping, media presence inspection, and outbound payload formatting.
 */
import { extractMessageContent, getContentType } from '@whiskeysockets/baileys';

export function resolveDownloadableMedia(messageContent) {
  const content = extractMessageContent(messageContent);
  const contentType = content ? getContentType(content) : null;
  const media = contentType ? content?.[contentType] : null;
  if (!media || typeof media !== 'object') return null;
  if (!('url' in media) && !('thumbnailDirectPath' in media)) return null;
  return { contentType, media };
}

export function classifyMessageType(content) {
  const c = extractMessageContent(content) || content || {};
  if (c.imageMessage) return 'IMAGE';
  if (c.documentMessage) return 'DOCUMENT';
  if (c.audioMessage) return 'AUDIO';
  if (c.videoMessage) return 'VIDEO';
  if (c.stickerMessage) return 'STICKER';
  if (c.conversation || c.extendedTextMessage) return 'TEXT';
  if (c.locationMessage) return 'LOCATION';
  if (c.contactMessage) return 'CONTACT';
  return 'TEXT';
}

export function hasRecognizedContent(content) {
  const c = extractMessageContent(content) || content || {};
  return Boolean(
    c.imageMessage || c.documentMessage || c.audioMessage || c.videoMessage ||
    c.stickerMessage || c.conversation || c.extendedTextMessage ||
    c.locationMessage || c.contactMessage
  );
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

export function summarizeWaMessage(waMsg) {
  const rawContent = waMsg?.message || {};
  const content = extractMessageContent(rawContent) || rawContent;
  const text =
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
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
  if (type === 'audio') {
    return { audio: source, mimetype: mime_type || 'audio/mpeg', ptt: false };
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
