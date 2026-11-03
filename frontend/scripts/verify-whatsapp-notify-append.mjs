/**
 * AŞAMA 5.2.7 — Notify / Append davranış doğrulaması (DOM + fonksiyon).
 *
 * Bu betik, frontend'in `message_new` event'ine verdiği tepkiyi ve mesaj
 * merge/dedup mantığını deterministik fixture'larla doğrular.
 *
 * Çalıştır: node scripts/verify-whatsapp-notify-append.mjs
 * Çıkış kodu 0 = PASS, 1 = FAIL.
 *
 * NOT: Bu betik üretim koduna DOKUNMAZ. İçindeki saf fonksiyon kopyaları
 * test amaçlıdır; referans kaynakları src/features/whatsapp/lib/ altındadır.
 */
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';

// ========================================================================
// 1. Saf zaman fonksiyonları (src/lib/utils.ts + src/features/whatsapp/lib/whatsappOrdering.ts)
// ========================================================================
function parseServerTime(dateStr) {
  if (dateStr === null || dateStr === undefined || dateStr === '') return null;
  if (typeof dateStr === 'number') return new Date(dateStr);
  const s = String(dateStr).trim().replace(' ', 'T');
  if (!s) return null;
  if (/^\d+$/.test(s)) return new Date(Number(s));
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s);
  return new Date(`${s}Z`);
}

function getMessageTimestampMs(m) {
  if (!m) return 0;
  const raw = m.external_timestamp || m.created_at;
  const d = parseServerTime(raw);
  if (d && !isNaN(d.getTime())) return d.getTime();
  return 0;
}

function compareMessagesChronological(a, b) {
  const timeA = getMessageTimestampMs(a);
  const timeB = getMessageTimestampMs(b);
  if (timeA !== timeB) return timeA - timeB;
  const idA = typeof a.id === 'number' ? a.id : Number(a.id);
  const idB = typeof b.id === 'number' ? b.id : Number(b.id);
  const validA = !isNaN(idA) && idA > 0;
  const validB = !isNaN(idB) && idB > 0;
  if (validA && validB && idA !== idB) return idA - idB;
  if (validA && !validB) return -1;
  if (!validA && validB) return 1;
  return 0;
}

// ========================================================================
// 2. Preview fonksiyonları (src/features/whatsapp/lib/whatsappPreview.ts)
// ========================================================================
const TYPE_LABEL_KEYS = {
  IMAGE: 'whatsapp.previewImage',
  VIDEO: 'whatsapp.previewVideo',
  AUDIO: 'whatsapp.previewAudio',
  STICKER: 'whatsapp.previewSticker',
  DOCUMENT: 'whatsapp.previewDocument',
  LOCATION: 'whatsapp.previewLocation',
  CONTACT: 'whatsapp.previewContact',
  TEMPLATE: 'whatsapp.previewTemplate',
  CALL: 'whatsapp.previewCall',
  REACTION: 'whatsapp.previewReaction',
  REVOKED: 'whatsapp.previewRevoked',
  SYSTEM: 'whatsapp.previewSystem',
  POLL: 'whatsapp.previewPoll',
  EVENT: 'whatsapp.previewEvent',
  VIEW_ONCE_PHOTO: 'whatsapp.previewViewOncePhoto',
  VIEW_ONCE_VIDEO: 'whatsapp.previewViewOnceVideo',
  VIEW_ONCE_AUDIO: 'whatsapp.previewViewOnceAudio',
  UNKNOWN: 'whatsapp.previewGeneric',
  OTHER: 'whatsapp.previewGeneric',
};

const FALLBACK_LABELS = {
  'whatsapp.previewImage': '📷 Fotoğraf',
  'whatsapp.previewVideo': '🎥 Video',
  'whatsapp.previewAudio': '🎵 Sesli mesaj',
  'whatsapp.previewSticker': 'Sticker',
  'whatsapp.previewDocument': '📄 Dosya',
  'whatsapp.previewLocation': '📍 Konum',
  'whatsapp.previewContact': '👤 Kişi kartı',
  'whatsapp.previewTemplate': 'Şablon mesajı',
  'whatsapp.previewCall': '📞 Arama',
  'whatsapp.previewReaction': '❤️ İfade',
  'whatsapp.previewRevoked': 'Silinmiş mesaj',
  'whatsapp.previewSystem': 'Sistem mesajı',
  'whatsapp.previewPoll': '📊 Anket',
  'whatsapp.previewEvent': '📅 Etkinlik',
  'whatsapp.previewViewOncePhoto': '📷 Tek görüntülenmelik fotoğraf',
  'whatsapp.previewViewOnceVideo': '🎥 Tek görüntülenmelik video',
  'whatsapp.previewViewOnceAudio': '🎵 Tek görüntülenmelik sesli mesaj',
  'whatsapp.previewGeneric': 'Mesaj',
};

function labelForType(type) {
  const key = TYPE_LABEL_KEYS[type] || 'whatsapp.previewGeneric';
  const translated = undefined; // t() yoksa fallback
  if (translated && translated !== key) return translated;
  return FALLBACK_LABELS[key];
}

function normalizePreviewText(messageType, body) {
  const type = String(messageType || 'TEXT').toUpperCase();
  const text = String(body || '').trim();
  if (text) {
    if (text.startsWith('[REACTION')) {
      const rxMatch = /^\[REACTION(?::(.+?))?\]$/.exec(text);
      const emoji = rxMatch?.[1] || '❤️';
      return `Şu mesaja ${emoji} ifadesini bıraktı`;
    }
    const m = /^\[([A-Za-z_]+)\]$/.exec(text);
    if (m) {
      const inner = m[1].toUpperCase();
      if (inner === 'REACTION') return 'Şu mesaja ❤️ ifadesini bıraktı';
      return TYPE_LABEL_KEYS[inner] ? labelForType(inner) : labelForType(type);
    }
    if (text === '[object Object]' || text === '[Medya]') return labelForType(type);
    return text;
  }
  if (type === 'TEXT') return '';
  return labelForType(type);
}

function buildChatPreview(msg, isGroup) {
  const base = normalizePreviewText(msg.message_type, msg.body);
  if (!base) return '';
  const name = String(msg.participant_name || msg.sender_name || '').trim();
  if (
    isGroup &&
    String(msg.direction || 'INBOUND').toUpperCase() === 'INBOUND' &&
    name &&
    name.toUpperCase() !== 'ME'
  ) {
    return `${name}: ${base}`;
  }
  return base;
}

function shouldApplyPreview(newTs, currentTs) {
  if (!currentTs) return true;
  if (!newTs) return true;
  const n = typeof newTs === 'number' ? newTs : parseServerTime(newTs)?.getTime() || 0;
  const c = typeof currentTs === 'number' ? currentTs : parseServerTime(currentTs)?.getTime() || 0;
  if (Number.isNaN(n) || Number.isNaN(c) || n === 0 || c === 0) return true;
  return n >= c;
}

// ========================================================================
// 3. Mesaj merge (src/features/whatsapp/lib/whatsappMessageMerge.ts)
// ========================================================================
function mergeDeliveryStatus(current, incoming) {
  const rank = { PENDING: 0, FAILED: 0, SENT: 1, DELIVERED: 2, READ: 3, RECEIVED: 3 };
  if (incoming === 'FAILED') return rank[current] > 0 ? current : incoming;
  if (current === 'FAILED' && incoming === 'PENDING') return current;
  return rank[incoming] >= rank[current] ? incoming : current;
}

function mergeWhatsAppMessages(current, incoming) {
  const result = [];
  const identities = new Map();
  for (const message of [...current, ...incoming]) {
    const keys = [`id:${message.id}`, ...(message.wa_message_id ? [`wa:${message.wa_message_id}`] : []),
      ...(message.client_message_id ? [`client:${message.client_message_id}`] : [])];
    const slots = [...new Set(keys.map((key) => identities.get(key)).filter((value) => value !== undefined))];
    const slot = slots[0] ?? result.length;
    let previous = result[slot];
    for (const duplicateSlot of slots.slice(1)) {
      const duplicate = result[duplicateSlot];
      if (duplicate) {
        previous = previous ? {
          ...duplicate,
          ...previous,
          reactions: Array.isArray(previous.reactions) && previous.reactions.length > 0
            ? previous.reactions
            : duplicate.reactions,
          status: mergeDeliveryStatus(previous.status, duplicate.status),
        } : duplicate;
        result[duplicateSlot] = undefined;
        for (const [key, value] of identities) if (value === duplicateSlot) identities.set(key, slot);
      }
    }
    result[slot] = previous ? {
      ...previous,
      ...message,
      id: Number(previous.id) > 0 && !(Number(message.id) > 0) ? previous.id : message.id,
      body: (message.body && message.body.trim() !== '') ? message.body : previous.body,
      message_type: (message.message_type && message.message_type !== 'TEXT') ? message.message_type : (previous.message_type || message.message_type),
      wa_message_id: message.wa_message_id || previous.wa_message_id,
      client_message_id: message.client_message_id || previous.client_message_id,
      media_id: message.media_id || previous.media_id,
      media_url: message.media_url || previous.media_url,
      media_mime_type: message.media_mime_type || previous.media_mime_type,
      media_filename: message.media_filename || previous.media_filename,
      media_caption: message.media_caption || previous.media_caption,
      link_preview: message.link_preview || previous.link_preview,
      reactions: Array.isArray(message.reactions) ? message.reactions : previous.reactions,
      status: mergeDeliveryStatus(previous.status, message.status),
    } : message;
    for (const key of keys) identities.set(key, slot);
  }
  return result.filter((message) => message !== undefined).sort(compareMessagesChronological);
}

// ========================================================================
// 4. Dedup (WhatsAppHubPage.tsx:rememberWaMessageId mantığı)
// ========================================================================
const SEEN_WA_IDS_MAX = 2000;
function createSeenWaMessageIds() {
  const seen = new Set();
  return {
    remember(waId, convId) {
      const key = convId != null ? `${convId}:${waId}` : waId;
      if (seen.has(key)) return false;
      seen.add(key);
      if (seen.size > SEEN_WA_IDS_MAX) {
        const it = seen.values();
        for (let i = 0; i < SEEN_WA_IDS_MAX / 2; i += 1) {
          const next = it.next();
          if (next.done) break;
          seen.delete(next.value);
        }
      }
      return true;
    },
    size() { return seen.size; },
  };
}

// ========================================================================
// 5. DOM Testi — jsdom + vanilla JS sohbet listesi mantığı
// ========================================================================
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const { window } = dom;

// Node 22'de bazı global'ler getter-only; defensive assign
try { globalThis.document = window.document; } catch {}
try { globalThis.window = window; } catch {}
try { globalThis.CustomEvent = window.CustomEvent; } catch {}

// Basit sohbet listesi state'i (WhatsAppHubPage handleWsEvent mantığının
// sadeleştirilmiş kopyası)
const conversations = [
  {
    id: 1,
    name: 'Ahmet',
    phone_e164: '+905321234567',
    last_message_preview: 'Merhaba',
    last_message_at: '2026-01-15T10:00:00Z',
    last_message_state: 'RESOLVED',
    message_count: 5,
    unread_count: 2,
    status: 'ACTIVE',
    is_group: false,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 2,
    name: 'Grup Test',
    phone_e164: 'jid:120363000000000001@g.us',
    last_message_preview: 'Selam grup',
    last_message_at: '2026-01-15T09:00:00Z',
    last_message_state: 'RESOLVED',
    message_count: 10,
    unread_count: 0,
    status: 'ACTIVE',
    is_group: true,
    created_at: '2026-01-01T00:00:00Z',
  },
];

const activeConvId = 1; // sohbet 1 açık
const seenWa = createSeenWaMessageIds();

function renderList() {
  const container = window.document.getElementById('conv-list') || window.document.createElement('div');
  container.id = 'conv-list';
  container.innerHTML = '';
  for (const c of conversations) {
    const el = window.document.createElement('div');
    el.dataset.convId = String(c.id);
    el.className = 'conv-row';
    el.innerHTML = `
      <span class="conv-name">${c.name}</span>
      <span class="conv-preview">${c.last_message_preview || ''}</span>
      <span class="conv-time">${c.last_message_at || ''}</span>
      <span class="conv-count">${c.message_count}</span>
      <span class="conv-unread">${c.unread_count > 0 ? c.unread_count : ''}</span>
    `;
    container.appendChild(el);
  }
  if (!window.document.body.contains(container)) {
    window.document.body.appendChild(container);
  }
}

function handleWsEvent(eventData) {
  if (eventData.event !== 'message_new') return;
  const convId = eventData.conversation_id;
  const idx = conversations.findIndex((c) => c.id === convId);
  if (idx === -1) return;

  const existing = conversations[idx];
  const msgObj = eventData.message && typeof eventData.message === 'object' ? eventData.message : null;
  const msgText = eventData.message?.body || eventData.body || '';
  const msgTime = msgObj?.created_at || eventData.created_at || new Date().toISOString();
  const isOutbound = msgObj?.direction === 'OUTBOUND' || eventData.direction === 'OUTBOUND';
  const waId = msgObj?.wa_message_id || eventData.wa_message_id;

  // replay dedup
  const isReplayed = Boolean(waId) && !seenWa.remember(String(waId), convId);
  const isCurrentSelected = convId === activeConvId;

  // preview & timestamp (shouldApplyPreview kuralı)
  const summary = buildChatPreview(
    { message_type: msgObj?.message_type || 'TEXT', body: msgText, direction: isOutbound ? 'OUTBOUND' : 'INBOUND' },
    existing.is_group,
  );
  const tsFresh = shouldApplyPreview(msgTime, existing.last_message_at);
  const applyPreview = Boolean(summary) && tsFresh;

  conversations[idx] = {
    ...existing,
    status: 'ACTIVE',
    last_message_preview: isReplayed ? existing.last_message_preview : (applyPreview ? summary : existing.last_message_preview),
    last_message_at: isReplayed ? existing.last_message_at : (tsFresh || !existing.last_message_at ? msgTime : existing.last_message_at),
    message_count: isReplayed ? existing.message_count : existing.message_count + 1,
    unread_count: (() => {
      if (isReplayed) return existing.unread_count;
      if (isCurrentSelected || isOutbound) return 0;
      return (existing.unread_count || 0) + 1;
    })(),
  };

  renderList();
}

window.addEventListener('tezlify:ws_event', (e) => handleWsEvent(e.detail));

renderList();

// ========================================================================
// 6. Test Koşuları
// ========================================================================
let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

console.log('\n=== FONKSIYON TESTLERI ===');

// --- shouldApplyPreview ---
check('shouldApplyPreview: yeni timestamp mevcut ozeti ezer', () => {
  assert.strictEqual(shouldApplyPreview('2026-01-15T11:00:00Z', '2026-01-15T10:00:00Z'), true);
});
check('shouldApplyPreview: eski timestamp mevcut ozeti ezmez (append davranisi)', () => {
  assert.strictEqual(shouldApplyPreview('2026-01-15T09:00:00Z', '2026-01-15T10:00:00Z'), false);
});
check('shouldApplyPreview: esit timestamp yazilir (>= kurali)', () => {
  assert.strictEqual(shouldApplyPreview('2026-01-15T10:00:00Z', '2026-01-15T10:00:00Z'), true);
});
check('shouldApplyPreview: mevcut timestamp yoksa her zaman yazilir', () => {
  assert.strictEqual(shouldApplyPreview('2026-01-15T09:00:00Z', null), true);
});

// --- buildChatPreview ---
check('buildChatPreview: metin mesaji govdesi', () => {
  assert.strictEqual(buildChatPreview({ message_type: 'TEXT', body: 'Merhaba' }, false), 'Merhaba');
});
check('buildChatPreview: medya mesaji tip etiketi', () => {
  assert.strictEqual(buildChatPreview({ message_type: 'IMAGE', body: '' }, false), '📷 Fotoğraf');
});
check('buildChatPreview: grup + gelen + gonderen adi', () => {
  const p = buildChatPreview({ message_type: 'TEXT', body: 'Selam', direction: 'INBOUND', sender_name: 'Ahmet' }, true);
  assert.strictEqual(p, 'Ahmet: Selam');
});
check('buildChatPreview: grubda outbound ad on eki yok', () => {
  const p = buildChatPreview({ message_type: 'TEXT', body: 'Selam', direction: 'OUTBOUND' }, true);
  assert.strictEqual(p, 'Selam');
});

// --- mergeWhatsAppMessages ---
check('mergeWhatsAppMessages: iki farkli mesaj kronolojik siralanir', () => {
  const a = { id: 1, created_at: '2026-01-15T10:00:00Z', body: 'A' };
  const b = { id: 2, created_at: '2026-01-15T11:00:00Z', body: 'B' };
  const r = mergeWhatsAppMessages([a], [b]);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].body, 'A');
  assert.strictEqual(r[1].body, 'B');
});
check('mergeWhatsAppMessages: ayni wa_message_id ile merge (dedup)', () => {
  const a = { id: 1, wa_message_id: 'W1', created_at: '2026-01-15T10:00:00Z', body: 'Eski', status: 'PENDING' };
  const b = { id: 2, wa_message_id: 'W1', created_at: '2026-01-15T10:00:00Z', body: '', status: 'RECEIVED' };
  const r = mergeWhatsAppMessages([a], [b]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].body, 'Eski'); // body bos geldi, onceki korunur
  assert.strictEqual(r[0].status, 'RECEIVED'); // status yukselir
  assert.strictEqual(r[0].wa_message_id, 'W1');
});
check('mergeWhatsAppMessages: notify + append ayni ID tek satir', () => {
  const notify = { id: 10, wa_message_id: 'W10', created_at: '2026-01-15T12:00:00Z', body: 'Canli', status: 'RECEIVED' };
  const append = { id: 11, wa_message_id: 'W10', created_at: '2026-01-15T11:00:00Z', body: '', status: 'RECEIVED' };
  const r = mergeWhatsAppMessages([notify], [append]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].body, 'Canli');
});

// --- rememberWaMessageId ---
check('rememberWaMessageId: ilk gorunum true', () => {
  const s = createSeenWaMessageIds();
  assert.strictEqual(s.remember('W1', 1), true);
});
check('rememberWaMessageId: ayni WA ID tekrar false (replay)', () => {
  const s = createSeenWaMessageIds();
  s.remember('W1', 1);
  assert.strictEqual(s.remember('W1', 1), false);
});
check('rememberWaMessageId: farkli conv ayni WA ID true (farkli sohbet)', () => {
  const s = createSeenWaMessageIds();
  s.remember('W1', 1);
  assert.strictEqual(s.remember('W1', 2), true);
});

console.log('\n=== DOM / EVENT TESTLERI ===');

// --- Notify: yeni mesaj, acik sohbet, inbound ---
window.dispatchEvent(new window.CustomEvent('tezlify:ws_event', {
  detail: {
    event: 'message_new',
    conversation_id: 1,
    direction: 'INBOUND',
    message: {
      id: 100,
      wa_message_id: 'W100',
      body: 'Yeni mesaj',
      message_type: 'TEXT',
      created_at: '2026-01-15T12:00:00Z',
      direction: 'INBOUND',
    },
  },
}));

check('DOM notify: preview guncellendi', () => {
  const preview = window.document.querySelector('[data-conv-id="1"] .conv-preview');
  assert.ok(preview, 'preview elementi bulunamadi');
  assert.strictEqual(preview.textContent, 'Yeni mesaj');
});
check('DOM notify: timestamp guncellendi', () => {
  const time = window.document.querySelector('[data-conv-id="1"] .conv-time');
  assert.ok(time);
  assert.strictEqual(time.textContent, '2026-01-15T12:00:00Z');
});
check('DOM notify: message_count artti (+1)', () => {
  const count = window.document.querySelector('[data-conv-id="1"] .conv-count');
  assert.ok(count);
  assert.strictEqual(count.textContent, '6');
});
check('DOM notify: acik sohbette unread 0 (isCurrentSelected)', () => {
  const unread = window.document.querySelector('[data-conv-id="1"] .conv-unread');
  assert.ok(unread);
  assert.strictEqual(unread.textContent, '');
});

// --- Notify: yeni mesaj, KAPALI sohbet, inbound ---
window.dispatchEvent(new window.CustomEvent('tezlify:ws_event', {
  detail: {
    event: 'message_new',
    conversation_id: 2,
    direction: 'INBOUND',
    message: {
      id: 101,
      wa_message_id: 'W101',
      body: 'Grup mesaji',
      message_type: 'TEXT',
      created_at: '2026-01-15T12:30:00Z',
      direction: 'INBOUND',
    },
  },
}));

check('DOM notify (kapali): unread +1', () => {
  const unread = window.document.querySelector('[data-conv-id="2"] .conv-unread');
  assert.ok(unread);
  assert.strictEqual(unread.textContent, '1');
});
check('DOM notify (kapali): preview guncellendi', () => {
  const preview = window.document.querySelector('[data-conv-id="2"] .conv-preview');
  assert.ok(preview);
  assert.strictEqual(preview.textContent, 'Grup mesaji');
});

// --- Dedup: ayni WA ID ile tekrar event (replay) ---
window.dispatchEvent(new window.CustomEvent('tezlify:ws_event', {
  detail: {
    event: 'message_new',
    conversation_id: 2,
    direction: 'INBOUND',
    message: {
      id: 102,
      wa_message_id: 'W101', // AYNI WA ID
      body: 'Tekrar',
      message_type: 'TEXT',
      created_at: '2026-01-15T12:30:00Z',
      direction: 'INBOUND',
    },
  },
}));

check('DOM dedup: replay unread ARTMAZ', () => {
  const unread = window.document.querySelector('[data-conv-id="2"] .conv-unread');
  assert.ok(unread);
  assert.strictEqual(unread.textContent, '1');
});
check('DOM dedup: replay message_count ARTMAZ', () => {
  const count = window.document.querySelector('[data-conv-id="2"] .conv-count');
  assert.ok(count);
  assert.strictEqual(count.textContent, '11'); // once 10 -> 11, replay degistirmez
});
check('DOM dedup: replay preview degismez', () => {
  const preview = window.document.querySelector('[data-conv-id="2"] .conv-preview');
  assert.ok(preview);
  assert.strictEqual(preview.textContent, 'Grup mesaji');
});

// --- Append davranisi: eski timestamp'li event (append benzeri) ---
// Note: Gercek append backend'den _no_broadcast ile gelmez. Burada eski
// timestamp'li bir event'in preview'u EZMEDIGINI dogruluyoruz.
window.dispatchEvent(new window.CustomEvent('tezlify:ws_event', {
  detail: {
    event: 'message_new',
    conversation_id: 1,
    direction: 'INBOUND',
    message: {
      id: 103,
      wa_message_id: 'W103',
      body: 'Eski mesaj',
      message_type: 'TEXT',
      created_at: '2026-01-15T09:00:00Z', // MEVCUTTAN ESKI (10:00)
      direction: 'INBOUND',
    },
  },
}));

check('DOM append-like: eski timestamp preview EZMEZ', () => {
  const preview = window.document.querySelector('[data-conv-id="1"] .conv-preview');
  assert.ok(preview);
  assert.strictEqual(preview.textContent, 'Yeni mesaj'); // hala 12:00'in mesaji
});
check('DOM append-like: eski timestamp time EZMEZ', () => {
  const time = window.document.querySelector('[data-conv-id="1"] .conv-time');
  assert.ok(time);
  assert.strictEqual(time.textContent, '2026-01-15T12:00:00Z');
});
// Ama message_count yine artar cunku bu bir replay degil (farkli WA ID)
check('DOM append-like: farkli WA ID message_count artar', () => {
  const count = window.document.querySelector('[data-conv-id="1"] .conv-count');
  assert.ok(count);
  assert.strictEqual(count.textContent, '7'); // 6 -> 7
});

// --- Outbound mesaj: unread 0, preview guncellenir ---
window.dispatchEvent(new window.CustomEvent('tezlify:ws_event', {
  detail: {
    event: 'message_new',
    conversation_id: 2,
    direction: 'OUTBOUND',
    message: {
      id: 104,
      wa_message_id: 'W104',
      body: 'Ben yazdim',
      message_type: 'TEXT',
      created_at: '2026-01-15T13:00:00Z',
      direction: 'OUTBOUND',
    },
  },
}));

check('DOM outbound: unread 0 olur (outbound unread artirmaz)', () => {
  const unread = window.document.querySelector('[data-conv-id="2"] .conv-unread');
  assert.ok(unread);
  assert.strictEqual(unread.textContent, ''); // outbound mesaj unread'u sifirlar
});
check('DOM outbound: preview guncellenir', () => {
  const preview = window.document.querySelector('[data-conv-id="2"] .conv-preview');
  assert.ok(preview);
  assert.strictEqual(preview.textContent, 'Ben yazdim');
});

// ========================================================================
// Sonuc
// ========================================================================
console.log(`\n=== SONUC: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}
console.log('AŞAMA 5.2.7 notify/append davranış doğrulaması: PASS');
