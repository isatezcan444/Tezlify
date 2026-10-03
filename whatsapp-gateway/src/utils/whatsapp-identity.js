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

/**
 * Strict LID side: must ALREADY be a LID jid.
 *
 * Deliberately not `asLid`, which appends `@lid` to any bare string. Here a
 * bare number is not evidence of a LID and must not be promoted into one.
 */
function _asLidSide(v) {
  if (typeof v !== 'string') return null;
  const clean = v.replace(/^jid:/, '').trim();
  return isLidJid(clean) ? clean : null;
}

/**
 * Strict phone side: a real user jid, never a group or broadcast.
 *
 * The strictness is load-bearing. `asPn` passes anything containing `@`
 * straight through, so a GROUP jid would be accepted as the "phone" half of a
 * pair and would poison `store.lidToJid` with a LID→group mapping — after which
 * every message from that LID would be filed under the group.
 */
function _asPhoneSide(v) {
  if (typeof v !== 'string') return null;
  const clean = v.replace(/^jid:/, '').trim();
  if (!clean.includes('@')) return null;
  if (isLidJid(clean)) return null;
  if (clean.includes('@g.us')) return null;
  if (isBroadcastOnlyJid(clean)) return null;
  return clean.endsWith('@c.us')
    ? `${clean.slice(0, -'@c.us'.length)}@s.whatsapp.net`
    : clean;
}

/**
 * (lid, phone) identity pairs carried on a message key as ALTERNATE addressing.
 *
 * Baileys exposes `remoteJidAlt` / `participantAlt` on `WAMessageKey`: the same
 * entity's other address. When `remoteJid` is a LID the alt holds the phone jid,
 * and vice versa.
 *
 * Reading them is what lets a message be filed under its phone identity at
 * INGEST time instead of being held as a LID until some later mapping event
 * arrives. That matters most during a first QR pairing, when no mapping has been
 * learned yet and the message would otherwise be held indefinitely.
 */
export function lidPairsFromMessageKey(key) {
  if (!key || typeof key !== 'object') return [];
  const pairs = [];
  const consider = (lidCandidate, phoneCandidate) => {
    const lid = _asLidSide(lidCandidate);
    const pn = _asPhoneSide(phoneCandidate);
    if (lid && pn && lid !== pn) pairs.push([lid, pn]);
  };
  // Both orders on purpose: either field may be the LID one depending on how
  // the message was addressed (PN-addressed messages still reveal the LID).
  consider(key.remoteJid, key.remoteJidAlt);
  consider(key.remoteJidAlt, key.remoteJid);
  consider(key.participant, key.participantAlt);
  consider(key.participantAlt, key.participant);
  return pairs;
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
  // WhatsApp official announcements channel
  if (clean === '0@s.whatsapp.net') return false;
  const at = clean.indexOf('@');
  if (at < 0) return false;
  const domain = clean.slice(at + 1);
  const local = clean.slice(0, at).replace(/:\d+$/, '');
  if (!local) return true;
  // Group JIDs can be digits or digits-timestamp
  if (domain === 'g.us') {
    return !/^\d+(?:-\d+)?$/.test(local);
  }
  // Newsletter JIDs.
  // The 5-digit minimum applies here too: a short numeric local part is a
  // truncated/placeholder id, and letting it through created a contact for an
  // identity WhatsApp never issued. This branch previously only checked that
  // the local part was numeric, so `123@newsletter` was accepted.
  if (domain === 'newsletter') {
    if (!/^\d+$/.test(local)) return true;
    return local.length < 5 || /^0+$/.test(local);
  }
  // User phone / LID JIDs
  if (!/^\d+$/.test(local)) return true;
  return local.length < 5 || /^0+$/.test(local);
}

export function isRawIdentityName(value) {
  if (!value || typeof value !== 'string') return true;
  const v = value.trim();
  if (!v) return true;
  if (v.toLowerCase() === 'whatsapp') return false;
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

export function isSavedContactName(name, phone) {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (phone && (trimmed === phone || trimmed === String(phone).trim())) return false;
  if (trimmed.startsWith('+')) return false;
  if (isRawIdentityName(trimmed)) return false;
  if (isPhoneLikeName(trimmed)) return false;
  const letters = trimmed.replace(/[\s\d+().\-_/]/g, '');
  return letters.length > 0;
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
  // Keep both indexes as a bijection.  A refreshed mapping can move a LID to
  // another phone JID (or reuse a phone JID for a newer LID); retaining either
  // inverse entry makes raw-message lookup resolve through stale identity.
  const previousPhone = store.lidToJid.get(l);
  if (previousPhone && store.jidToLid.get(previousPhone) === l) {
    store.jidToLid.delete(previousPhone);
  }
  const previousLid = store.jidToLid.get(p);
  if (previousLid && previousLid !== l && store.lidToJid.get(previousLid) === p) {
    store.lidToJid.delete(previousLid);
  }
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
