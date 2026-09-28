/**
 * Faz 8/10 — WhatsApp kimlik görüntüleme kuralı (TEK kanonik yardımcı).
 *
 * Bu modül, kullanıcıya gösterilen ad/telefon etiketlerinin çözümlendiği TEK
 * yerdir. Sohbet listesi, sohbet başlığı, arama sonuçları ve grup mesaj
 * balonları aynı fonksiyonları kullanır — böylece ham teknik kimlik
 * (`jid:`, `@lid`, `@g.us`, `@s.whatsapp.net`, `@c.us`) hiçbir yüzeyde
 * kullanıcıya etiket olarak sızamaz.
 *
 * Çözümleme sırası (`getConversationDisplayName`):
 *   1. Grup  -> grup adı, yoksa `whatsapp.groupFallback`
 *   2. Rehberde kayıtlı ad -> ad
 *   3. Çözümlenebilir PN JID/telefon -> biçimlendirilmiş telefon
 *   4. RESOLVING_TRANSIENT -> `whatsapp.pendingIdentity`
 *   5. Aksi halde -> `whatsapp.contactFallback` (deterministik; asla sonsuz spinner)
 * Ham teknik JID HİÇBİR ZAMAN döndürülmez.
 */
import { Conversation } from '../../../types';

export function formatPhoneNumber(phone?: string | null): string {
  if (!phone) return '';
  let raw = stripJidPrefix(phone);
  if (raw.endsWith('@s.whatsapp.net') || raw.endsWith('@c.us')) {
    raw = raw.split('@')[0];
  }
  if (raw.includes(':')) {
    raw = raw.split(':')[0];
  }

  let digits = raw.replace(/\D/g, '');
  if (!digits || digits.length < 5) return raw;

  // Turkish 10 digits starting with 5 (e.g. 5322334968) -> 905322334968
  if (digits.length === 10 && digits.startsWith('5')) {
    digits = `90${digits}`;
  } else if (digits.length === 11 && digits.startsWith('05')) {
    digits = `90${digits.slice(1)}`;
  }

  // 1. Turkey (+90) - Mobile: 12 digits (+90 5XX XXX XX XX)
  if (digits.startsWith('90') && digits.length === 12) {
    return `+90 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8, 10)} ${digits.slice(10, 12)}`;
  }

  // 2. North America (+1) (USA, Canada) - 11 digits: +1 XXX XXX XXXX
  if (digits.startsWith('1') && digits.length === 11) {
    return `+1 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7, 11)}`;
  }

  // 3. United Kingdom (+44) - Mobile (+44 7XXX XXXXXX) or standard
  if (digits.startsWith('44')) {
    if (digits.length === 12) {
      return `+44 ${digits.slice(2, 6)} ${digits.slice(6, 12)}`;
    }
    if (digits.length === 11) {
      return `+44 ${digits.slice(2, 5)} ${digits.slice(5, 11)}`;
    }
  }

  // 4. Germany (+49)
  if (digits.startsWith('49') && digits.length >= 11 && digits.length <= 13) {
    return `+49 ${digits.slice(2, 5)} ${digits.slice(5)}`;
  }

  // 5. France (+33) - 11 digits: +33 X XX XX XX XX
  if (digits.startsWith('33') && digits.length === 11) {
    return `+33 ${digits.slice(2, 3)} ${digits.slice(3, 5)} ${digits.slice(5, 7)} ${digits.slice(7, 9)} ${digits.slice(9, 11)}`;
  }

  // 6. Generic international fallback:
  let ccLength = 2;
  if (digits.startsWith('1') || digits.startsWith('7')) {
    ccLength = 1;
  } else if (
    digits.startsWith('971') || digits.startsWith('966') ||
    digits.startsWith('351') || digits.startsWith('352') ||
    digits.startsWith('353') || digits.startsWith('354') ||
    digits.startsWith('358') || digits.startsWith('370') ||
    digits.startsWith('371') || digits.startsWith('372') ||
    digits.startsWith('380') || digits.startsWith('381') ||
    digits.startsWith('385') || digits.startsWith('420') ||
    digits.startsWith('421') || digits.startsWith('852') ||
    digits.startsWith('886')
  ) {
    ccLength = 3;
  }

  if (digits.length > ccLength + 3) {
    const cc = digits.slice(0, ccLength);
    const rest = digits.slice(ccLength);
    const chunks: string[] = [];
    let i = 0;
    while (i < rest.length) {
      const remaining = rest.length - i;
      if (remaining === 4) {
        chunks.push(rest.slice(i, i + 4));
        break;
      } else if (remaining > 4) {
        chunks.push(rest.slice(i, i + 3));
        i += 3;
      } else {
        chunks.push(rest.slice(i));
        break;
      }
    }
    return `+${cc} ${chunks.join(' ')}`;
  }

  return `+${digits}`;
}

/**
 * Strips the frontend-internal `jid:` prefix and surrounding whitespace.
 *
 * §31: this is the ONLY place the `jid:` prefix is removed. Callers that need to
 * compare two identifiers for *exact* JID equality use this; callers that need a
 * phone number use `extractCleanPhone` instead (a JID is not a phone).
 */
export function stripJidPrefix(value?: string | null): string {
  if (!value) return '';
  return String(value).replace(/^jid:/, '').trim();
}

export function extractCleanPhone(phone?: string | null): string | null {
  if (!phone) return null;
  const raw = stripJidPrefix(phone);
  if (raw.endsWith('@lid') || raw.includes('@g.us')) return null;
  const userPart = (raw.includes('@') ? raw.split('@')[0] : raw).split(':')[0];
  let digits = userPart.replace(/\D/g, '');
  if (digits.length < 5 || /^0+$/.test(digits)) return null;
  if (digits.length === 10 && digits.startsWith('5')) {
    digits = `90${digits}`;
  } else if (digits.length === 11 && digits.startsWith('05')) {
    digits = `90${digits.slice(1)}`;
  }
  return `+${digits}`;
}

export function isRawWhatsAppJid(value?: string | null): boolean {
  if (!value) return false;
  const v = String(value).trim();
  return (
    v.startsWith('jid:') ||
    v.includes('@lid') ||
    v.includes('@g.us') ||
    v.includes('@s.whatsapp.net') ||
    v.includes('@c.us')
  );
}

export function isRealContactName(name?: string | null): boolean {
  if (!name) return false;
  const trimmed = String(name).trim();
  if (!trimmed) return false;
  if (isRawWhatsAppJid(trimmed)) return false;

  const digitsOnly = trimmed.replace(/\D/g, '');
  const lettersOnly = trimmed.replace(/[^a-zA-ZğüşıöçĞÜŞİÖÇ]/g, '');
  if (digitsOnly.length >= 5 && lettersOnly.length === 0) {
    return false;
  }

  const lower = trimmed.toLowerCase();
  if (
    lower === 'lead' ||
    lower === 'kişi' ||
    lower === 'kisi' ||
    lower === 'contact' ||
    lower === 'contacts' ||
    lower === 'isimsiz müşteri' ||
    lower === 'isimsiz musteri' ||
    lower === 'whatsapp kişisi' ||
    lower === 'whatsapp kisi' ||
    lower === 'whatsapp contact' ||
    lower.includes('kişi kimliği') ||
    lower.includes('kisi kimligi') ||
    lower.includes('resolving identity')
  ) {
    return false;
  }

  return true;
}

export function getConversationDisplayName(
  conv: Conversation,
  t: (key: string) => string
): string {
  const rawPhone =
    conv.lead_phone ||
    (conv as any).phone ||
    (conv as any).jid ||
    (conv as any).phone_number ||
    (conv as any).recipient_phone ||
    (conv as any).sender_phone ||
    null;
  const rawName = conv.lead_name || (conv as any).name || null;

  // 1. Group conversation check
  const isGroup = Boolean(conv.is_group || (rawPhone && rawPhone.includes('@g.us')));
  if (isGroup) {
    if (rawName && !isRawWhatsAppJid(rawName)) {
      return rawName;
    }
    return t('whatsapp.groupFallback');
  }

  // 2. Saved contact in address book ("Kişi rehberde kayıtlıysa: Ahmet Yılmaz")
  if (isRealContactName(rawName)) {
    return rawName!;
  }

  // 3. Unsaved contact with resolvable phone number ("Kişi rehberde kayıtlı değilse: +90 532 233 49 68")
  const cleanPhone = extractCleanPhone(rawPhone) || extractCleanPhone(rawName);
  if (cleanPhone) {
    return formatPhoneNumber(cleanPhone);
  }

  // 4. Transient resolving (ONLY if active resolution is genuinely in-flight)
  if (conv.identity_state === 'RESOLVING_TRANSIENT') {
    return t('whatsapp.pendingIdentity');
  }

  // 5. Stable permanent fallback (Never show "Kişi (XXXX)")
  return t('whatsapp.contactFallback');
}

// ---------------------------------------------------------------------------
// Canonical conversation identity (single authority for "is this the SAME
// conversation?").
//
// Why this exists: a WhatsApp conversation is identified by a JID
// (`905550000777@s.whatsapp.net`, `905550000777:12@s.whatsapp.net`,
// `123456789:12@lid`) while the database row usually stores a phone
// (`+905550000777`). A raw string comparison between those two forms NEVER
// matches, so realtime events that carry only a JID silently failed to match
// the open chat.
//
// `stripJidPrefix` above is deliberately only a display/unwrapping helper —
// it is NOT a comparator. These helpers are the comparator, and they live here
// so the conversation list and the open chat thread cannot drift apart again.
//
// Contract:
//  * `identityKeys` returns a SET of aliases for one identity. Two identities
//    are the same conversation iff their key sets intersect.
//  * A bare phone and its PN JID collapse onto the same `jid:` key, so
//    `+905550000777` and `905550000777@s.whatsapp.net` match.
//  * A device suffix (`:12`) is stripped, so the same person always matches.
//  * `@lid` is preserved verbatim and NEVER collapsed onto a phone: LID -> PN
//    reconciliation stays owned by the backend, which broadcasts the already
//    reconciled numeric `conversation_id`. We only ever compare a LID to a LID.
// ---------------------------------------------------------------------------

/** Canonical `local@domain` form; strips `jid:`, the device suffix and `+`. */
export function canonicalJid(value?: string | null): string | null {
  if (!value) return null;
  let raw = String(value).replace(/^jid:/, '').trim();
  if (!raw) return null;
  const at = raw.indexOf('@');
  const localRaw = at >= 0 ? raw.slice(0, at) : raw;
  let domain = at >= 0 ? raw.slice(at + 1).toLowerCase() : '';
  const local = localRaw.replace(/^\+/, '').replace(/:\d+$/, '');
  if (!local) return null;
  // `@c.us` is the legacy spelling of the phone JID — one identity.
  if (domain === 'c.us' || domain === 's.whatsapp.net') domain = 's.whatsapp.net';
  if (!domain) return local;
  return `${local}@${domain}`;
}

/**
 * All aliases of a single identity value. Accepts a JID, a bare phone, or a
 * conversation-ish object carrying `lead_phone` / `phone`.
 */
export function identityKeys(value?: string | null | Record<string, any>): Set<string> {
  const keys = new Set<string>();
  if (value == null) return keys;

  const candidates: string[] = [];
  if (typeof value === 'string') {
    candidates.push(value);
  } else {
    if (value.lead_phone) candidates.push(String(value.lead_phone));
    if (value.phone) candidates.push(String(value.phone));
  }

  for (const candidate of candidates) {
    const jid = canonicalJid(candidate);
    if (!jid) continue;
    const domain = jid.includes('@') ? jid.slice(jid.indexOf('@')) : '';
    // A phone-number JID and a bare phone are the same identity.
    keys.add(`jid:${domain && domain !== '@lid' ? jid : `${jid}@s.whatsapp.net`}`);
    const phone = extractCleanPhone(candidate);
    if (phone) keys.add(`phone:${phone}`);
  }
  return keys;
}

/** True when two identities describe the same conversation. */
export function isSameConversation(
  a?: string | null | Record<string, any>,
  b?: string | null | Record<string, any>,
): boolean {
  const left = identityKeys(a);
  if (left.size === 0) return false;
  for (const key of identityKeys(b)) if (left.has(key)) return true;
  return false;
}

