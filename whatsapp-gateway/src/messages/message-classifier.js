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
  return { message_type: classifyMessageType(content), body: text };
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
