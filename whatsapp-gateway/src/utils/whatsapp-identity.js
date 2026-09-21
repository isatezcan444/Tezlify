/**
 * WhatsApp Identity, JID, and Phone Normalization Utilities.
 *
 * Implements pure identity logic, E.164 phone extraction, LID checking,
 * and contact name rank resolution according to AGENTS.md §1.3.
 */

export const NAME_RANK = {
  addressbook: 5,
  group_subject: 4,
  verified: 4,
  history: 3,
  push: 2,
  phone: 1,
};

export function isLidJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@lid');
}

export function isStatusBroadcastJid(jid) {
  return jid === 'status@broadcast';
}

export function isNewsletterJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@newsletter');
}

export function isBroadcastOnlyJid(jid) {
  return isStatusBroadcastJid(jid) || isNewsletterJid(jid);
}

export function asLid(v) {
  if (!v || typeof v !== 'string') return null;
  return v.includes('@') ? v : `${v}@lid`;
}

export function asPn(v) {
  if (!v || typeof v !== 'string') return null;
  if (!v.includes('@')) return `${v}@s.whatsapp.net`;
  return v.endsWith('@c.us') ? `${v.slice(0, -'@c.us'.length)}@s.whatsapp.net` : v;
}

export function jidToPhone(jid) {
  if (!jid) return null;
  if (isLidJid(jid)) return null;
  if (jid.includes('@g.us')) return null;
  const match = jid.match(/^(\d+)(?::\d+)?@/);
  if (!match) return null;
  const digits = match[1];
  if (digits.length < 5 || /^0+$/.test(digits)) return null;
  return `+${digits}`;
}

export function isDegenerateJid(jid) {
  if (!jid) return false;
  const clean = String(jid).replace(/^jid:/, '').trim();
  const at = clean.indexOf('@');
  if (at < 0) return false;
  const local = clean.slice(0, at).replace(/:\d+$/, '');
  if (!/^\d+$/.test(local)) return true;
  return local.length < 5 || /^0+$/.test(local);
}

export function isRawIdentityName(value) {
  if (!value || typeof value !== 'string') return true;
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

export function isPhoneLikeName(value) {
  if (!value || typeof value !== 'string') return false;
  const v = value.trim();
  return /^\+?[\d\s-()]{6,}$/.test(v) || /@\w+\.(\w+)$/.test(v);
}

export function contactPhoneJid(contact) {
  if (!contact || typeof contact !== 'object') return null;
  const candidates = [contact.phoneNumber, contact.pnJid, contact.pn, contact.jid, contact.phone];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const value = candidate.trim();
    const normalized = /^\+?\d+$/.test(value) ? value.replace(/^\+/, '') : value;
    const jid = asPn(normalized);
    if (!jid || isLidJid(jid) || jid.includes('@g.us') || isBroadcastOnlyJid(jid)) continue;
    if (jidToPhone(jid)) return jid;
  }
  return null;
}

export function normalizePairingPhone(phone) {
  const raw = String(phone || '').trim();
  const isInternational = raw.startsWith('+') || raw.startsWith('00');
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (!isInternational) {
    if (/^0\d{10}$/.test(digits)) digits = `90${digits.slice(1)}`;
    if (/^5\d{9}$/.test(digits)) digits = `90${digits}`;
  }
  if (digits.length < 10 || digits.length > 15) {
    throw new Error('Geçersiz telefon numarası. Ülke kodu ile birlikte girin (örn. +90 5XX XXX XX XX).');
  }
  return digits;
}

export function mergeContactName(existing, name, source) {
  const base = existing || {};
  if (!name) return base;
  if (source === 'push') {
    return {
      ...base,
      push_name: name,
      name_source: base.name_source || 'push',
    };
  }
  const currentRank = NAME_RANK[base.name_source] || (base.name ? NAME_RANK.history : 0);
  const newRank = NAME_RANK[source] || NAME_RANK.history;
  const phoneLike = !base.name || /^\+\d+$/.test(base.name) || base.name === base.phone;
  if (phoneLike || newRank >= currentRank) {
    return { ...base, name, name_source: source };
  }
  return base;
}

export function rememberLidPair(store, lid, phoneJid) {
  const l = asLid(lid);
  const p = asPn(phoneJid);
  if (!store || !l || !p || !isLidJid(l) || isLidJid(p)) return false;
  if (store.lidToJid.get(l) === p) return false;
  store.lidToJid.set(l, p);
  store.jidToLid.set(p, l);
  return true;
}

export function resolveJidKey(store, jid) {
  if (!jid) return jid;
  let clean = String(jid).replace(/^jid:/, '').trim();
  if (clean.includes('@g.us')) return clean;
  clean = clean.replace(/(:\d+)?(@.*)$/, '$2');
  if (clean.endsWith('@c.us')) clean = `${clean.slice(0, -'@c.us'.length)}@s.whatsapp.net`;
  if (isLidJid(clean)) {
    const phone = store?.lidToJid?.get(clean);
    return phone || clean;
  }
  if (clean.includes('@s.whatsapp.net')) return clean;
  if (clean.includes('@')) return clean;
  const digits = clean.replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : clean;
}
