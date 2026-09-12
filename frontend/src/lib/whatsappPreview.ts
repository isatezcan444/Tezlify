/**
 * Faz 10 (P2): Son mesaj özeti — FRONTEND tarafındaki tek kural.
 *
 * Backend `build_last_message_summary` (whatsapp_service.py) ve gateway
 * `buildChatPreview` (session-manager.js) ile birebir aynı semantiği
 * uygular; realtime WS olaylarında UI kendi özeti için AYNI fonksiyonu
 * kullanır — sohbet öeti hiçbir yerde farklı hesaplanmaz.
 *
 * Kurallar:
 *  - Metin mesajında gövde; medyada tip etiketi (📷/🎥/🎵/📄/Sticker...).
 *  - Eski köşeli değerler ([IMAGE] vb.) aynı etiketlere normalize edilir;
 *    UI'a asla '[IMAGE]' veya '[object Object]' sızmaz.
 *  - Grup + gelen mesajda çözülmüş gönderen adı ön ek olur ("Ahmet: ...");
 *    ham JID/LID veya telefon görünümlü ad ASLA ön ek olmaz.
 *  - Uygulama zaman-damgalı sıralamayadır: daha eski mesaj yeniyi ezemez
 *    (`shouldApplyPreview`).
 */

export interface PreviewMessageLike {
  message_type?: string | null;
  body?: string | null;
  sender_name?: string | null;
  participant_name?: string | null;
  direction?: string | null;
}

export type PreviewTranslator = (key: string) => string;

const TYPE_LABEL_KEYS: Record<string, string> = {
  IMAGE: 'whatsapp.previewImage',
  VIDEO: 'whatsapp.previewVideo',
  AUDIO: 'whatsapp.previewAudio',
  STICKER: 'whatsapp.previewSticker',
  DOCUMENT: 'whatsapp.previewDocument',
  LOCATION: 'whatsapp.previewLocation',
  CONTACT: 'whatsapp.previewContact',
  TEMPLATE: 'whatsapp.previewTemplate',
  UNKNOWN: 'whatsapp.previewGeneric',
  OTHER: 'whatsapp.previewGeneric',
};

const FALLBACK_LABELS: Record<string, string> = {
  'whatsapp.previewImage': '📷 Fotoğraf',
  'whatsapp.previewVideo': '🎥 Video',
  'whatsapp.previewAudio': '🎵 Sesli mesaj',
  'whatsapp.previewSticker': 'Sticker',
  'whatsapp.previewDocument': '📄 Dosya',
  'whatsapp.previewLocation': '📍 Konum',
  'whatsapp.previewContact': '👤 Kişi kartı',
  'whatsapp.previewTemplate': 'Şablon mesajı',
  'whatsapp.previewGeneric': 'Mesaj',
};

function labelForType(type: string, t?: PreviewTranslator): string {
  const key = TYPE_LABEL_KEYS[type] || 'whatsapp.previewGeneric';
  const translated = t ? t(key) : undefined;
  // t() çevirisi eksikse (anahtar yoksa anahtarın kendisini döner) fallback.
  if (translated && translated !== key) return translated;
  return FALLBACK_LABELS[key];
}

function isRawIdentityName(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  return (
    v.startsWith('jid:') ||
    v.includes('@lid') ||
    v.endsWith('@g.us') ||
    v.endsWith('@s.whatsapp.net') ||
    v.endsWith('@c.us') ||
    /^\d+@/.test(v)
  );
}

function isPhoneLikeName(value: string): boolean {
  const v = value.trim();
  return /^\+?[\d\s-()]{6,}$/.test(v) || /@\w+\.\w+$/.test(v);
}

/** Bir mesajdan (tip + gövde) yüzük preview metnini üretir (backend kuralı). */
export function normalizePreviewText(
  messageType: string | null | undefined,
  body: string | null | undefined,
  t?: PreviewTranslator,
): string {
  const type = String(messageType || 'TEXT').toUpperCase();
  const text = String(body || '').trim();
  if (text) {
    const m = /^\[([A-Za-z_]+)\]$/.exec(text);
    if (m) {
      const inner = m[1].toUpperCase();
      return TYPE_LABEL_KEYS[inner] ? labelForType(inner, t) : labelForType(type, t);
    }
    if (text === '[object Object]' || text === '[Medya]') return labelForType(type, t);
    return text;
  }
  if (type === 'TEXT') return '';
  return labelForType(type, t);
}

/** Sohbet listesi satırı için son-mesaj özeti (tek paylaşılan kural). */
export function buildChatPreview(
  msg: PreviewMessageLike,
  isGroup: boolean,
  t?: PreviewTranslator,
): string {
  const base = normalizePreviewText(msg.message_type, msg.body, t);
  if (!base) return '';
  const name = String(msg.participant_name || msg.sender_name || '').trim();
  if (
    isGroup &&
    String(msg.direction || 'INBOUND').toUpperCase() === 'INBOUND' &&
    name &&
    name.toUpperCase() !== 'ME' &&
    !isRawIdentityName(name) &&
    !isPhoneLikeName(name)
  ) {
    return `${name}: ${base}`;
  }
  return base;
}

/** Zaman-damgalı sıralama kuralı: daha eski mesaj, daha yeni özeti ezemez. */
export function shouldApplyPreview(
  newTs: string | number | null | undefined,
  currentTs: string | number | null | undefined,
): boolean {
  if (!currentTs) return true;
  if (!newTs) return true; // timestampsiz realtime güncelleme: yaz
  const n = typeof newTs === 'number' ? newTs : new Date(newTs).getTime();
  const c = typeof currentTs === 'number' ? currentTs : new Date(currentTs).getTime();
  if (Number.isNaN(n) || Number.isNaN(c)) return true;
  return n >= c;
}
