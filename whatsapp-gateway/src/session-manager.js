/**
 * Session Manager - Baileys WhatsApp Web session lifecycle.

 * Handles:
 * - Session creation with QR pairing (multi-device)
 * - Session persistence (encrypted PostgreSQL auth state in production)
 * - Contact / chat / message sync into in-memory stores
 * - Text & media message sending
 * - Media download & storage
 * - Realtime event emission to the event bridge
 */
import { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason, fetchLatestBaileysVersion, Browsers, downloadMediaMessage, extractMessageContent, getContentType } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import { diagnostic, sessionRef } from './observability.js';
import { SocketLifecycle } from './domain/socket-lifecycle.js';
import { createBoundedCache } from './domain/bounded-cache.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

/**
 * Baileys soket loglayıcısı için sarmalayıcı (Proxy).
 *
 * WhatsApp multi-device Signal protokolünde yeni oturum açıldığında veya yeniden
 * bağlanıldığında, cihaz eski anahtarlarla şifrelenmiş paketler ya da @lid mesajları
 * aldığında Baileys libsignal katmanında 'Bad MAC' ya da 'No matching sessions'
 * fırlatılır. Baileys bunu `getMessage` üzerinden yeniden talep eder (retry receipt).
 * Bu olağan el sıkışma döngüleri ile 'init queries' zaman aşımları ve akış kopmaları
 * Pino level 50 (hata) veya level 40 (uyarı) yerine level 20 (debug) olarak yapılandırılmış formatta loglanır;
 * böylece sahte 500 ve alarm üretilmezken gerçek hatalar level 50'de korunur.
 */
function createBaileysLogger(baseLogger) {
  return new Proxy(baseLogger, {
    get(target, prop, receiver) {
      if (prop === 'error') {
        return function (obj, msg, ...args) {
          const msgStr = typeof obj === 'string' ? obj : (msg || '');
          const objErrStr = obj instanceof Error ? obj.message : (obj?.err?.message || obj?.message || '');
          const fullText = `${msgStr} ${objErrStr}`.toLowerCase();
          const isHandshakeRetry =
            fullText.includes('failed to decrypt message') ||
            fullText.includes("unexpected error in 'init queries'") ||
            fullText.includes('stream errored out') ||
            fullText.includes('error in handling message') ||
            fullText.includes('bad mac') ||
            fullText.includes('no matching sessions') ||
            fullText.includes('timed out');

          if (isHandshakeRetry) {
            const errSummary = objErrStr || (typeof obj === 'object' && obj !== null ? obj?.msg : '') || msgStr;
            const remoteJid = typeof obj === 'object' && obj !== null ? (obj.key?.remoteJid || '') : '';
            return target.debug(
              { key: remoteJid ? { remoteJid } : undefined, err: errSummary },
              `[baileys-handshake] ${msgStr || errSummary}`
            );
          }
          return target.error(obj, msg, ...args);
        };
      }
      if (prop === 'child') {
        return function (bindings) {
          const childLogger = target.child(bindings);
          return createBaileysLogger(childLogger);
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    }
  });
}

// ---------------------------------------------------------------------------
// In-memory stores
//
// OTURUM BAZLI (güvenlik düzeltmesi): kişiler, sohbetler, mesajlar, LID
// eşleşmeleri ve ham mesaj deposu artık MODÜL SEVİYESİNDE GLOBAL DEĞİLDİR —
// her biri ilgili `session` kaydının içinde yaşar (`session.store`).
//
// Önceki model bu Map'leri yalnızca JID ile anahtarlıyordu; birden fazla
// WhatsApp hattı bağlandığında iki kiracının sohbetleri, rehberleri ve mesaj
// geçmişi aynı haritada karışıyordu. Kod bunu `_assertUnambiguousScope()` ile
// "1'den fazla oturum varsa isteği reddet" diyerek örtüyordu; yani sistem
// fiilen tek hatlıydı ve tek hat bağlıyken BAŞKA bir kiracının isteği o hattın
// verisini okuyup o hattan mesaj gönderebiliyordu. Store'lar oturuma taşınınca
// hem bu sızıntı kapanır hem çok hatlı kullanım mümkün olur.
// ---------------------------------------------------------------------------
/** Bir oturumun kendine ait bellek depoları. */
function createSessionStore() {
  return {
    contacts: new Map(), // jid -> contact
    chats: new Map(), // jid -> chat summary
    messagesByChat: new Map(), // jid -> Message[]
    // Faz 6e: WhatsApp'ın LID (Large Identity) dönemi — W:Contact app-state
    // yamaları ve bazı mesaj anahtarları artık telefon JID'i yerine
    // `xxx@lid` kimliğiyle anahtarlanır. Bu haritalar LID ↔ telefon JID
    // köprüsünü kurar; rehber adları böylece telefon-anahtarlı sohbetlere
    // işlenebilir (WhatsApp Web paritesi). Eşleşmeler hesaba özeldir.
    lidToJid: new Map(), // lid jid -> phone jid
    jidToLid: new Map(), // phone jid -> lid jid
    // Faz 5: profil/grup resmi fetch durum takibi (retry storm önleme)
    avatarFetchInFlight: new Set(),
    avatarFetchAttemptedAt: new Map(), // jid -> ms timestamp
    rawMessagesByChat: new Map(), // jid -> Map<waMessageId, proto.IMessage>
    rawMessageCount: 0,
  };
}

// Sorun (Render log: `failed to decrypt message | err=No session record` /
// `Bad MAC`): Baileys, sifresi cozulemeyen bir mesaji kurtarmak icin gonderen
// taraftan YENIDEN GONDERIM (retry receipt) ister — ancak bunun icin
// `makeWASocket({ getMessage })` saglanmis olmalidir. Saglanmadigi surece
// Baileys yalnizca log yaziyor ve mesaj KALICI olarak kayboluyordu.
//
// Bu harita, gelen mesajin HAM proto icerigini (`msg.message`) sinirli
// sayida tutar; `getMessage(key)` buradan beslenir. Ham govde tutuldugu icin
// `messagesByChat` kayitlari DEGISMEZ (onlar normalize edilmis kayitlardir).
const RAW_MESSAGE_STORE_MAX = 2000;

function rememberRawMessage(store, jid, id, message) {
  if (!store || !jid || !id || !message) return;
  const { rawMessagesByChat } = store;
  let byId = rawMessagesByChat.get(jid);
  if (!byId) {
    byId = new Map();
    rawMessagesByChat.set(jid, byId);
  }
  if (!byId.has(id)) store.rawMessageCount += 1;
  byId.set(id, message);
  // Sinirli bellek: en eski kayitlar FIFO atilir (per-chat 500 mesaj siniriyla
  // ayni ruh — sinirsiz buyume yok).
  if (byId.size > 500) {
    const oldest = byId.keys().next().value;
    byId.delete(oldest);
    store.rawMessageCount -= 1;
  }
  while (store.rawMessageCount > RAW_MESSAGE_STORE_MAX) {
    const firstChat = rawMessagesByChat.keys().next().value;
    const firstMap = rawMessagesByChat.get(firstChat);
    if (!firstMap || firstMap.size === 0) {
      rawMessagesByChat.delete(firstChat);
      continue;
    }
    const oldest = firstMap.keys().next().value;
    firstMap.delete(oldest);
    store.rawMessageCount -= 1;
    if (firstMap.size === 0) rawMessagesByChat.delete(firstChat);
  }
}

function lookupRawMessage(store, key) {
  if (!store || !key?.remoteJid || !key?.id) return undefined;
  const { rawMessagesByChat, lidToJid, jidToLid } = store;
  const direct = rawMessagesByChat.get(key.remoteJid)?.get(key.id);
  if (direct) return direct;
  // LID ↔ telefon köprüsü: ayni mesaj her iki anahtar altinda da aranir.
  const alt = key.remoteJid.includes('@lid')
    ? lidToJid.get(key.remoteJid)
    : jidToLid.get(key.remoteJid);
  return alt ? rawMessagesByChat.get(alt)?.get(key.id) : undefined;
}

// Sorun (Render log: `Failed to store incoming media | err=No message
// present`): `downloadMediaMessage` TAM WAMessage bekler ve icindeki
// `message.message` alanini `extractMessageContent` ile kendisi acar
// (viewOnce / ephemeral / documentWithCaption sarmalayicilari dahil). Bu
// yardimci ayni cozumlemeyi ONCEDEN yapar; boylece hem indirilebilir medya
// olup olmadigina karar verilebilir (yoksa `downloadMediaMessage` her
// cagrida `Boom('No message present')` firlatirdi) hem de mime/dosya adi
// dogru dugumden okunur. Saf fonksiyon — ag/dosya sistemi erismi yok.
function resolveDownloadableMedia(messageContent) {
  const content = extractMessageContent(messageContent);
  const contentType = content ? getContentType(content) : null;
  const media = contentType ? content?.[contentType] : null;
  if (!media || typeof media !== 'object') return null;
  // Baileys'in KENDI kabul kosulu (Utils/messages.js -> downloadMsg):
  // medya dugumu `url` VEYA `thumbnailDirectPath` tasimalidir. Yalnizca
  // "nesne mi" kontrolu yetersizdi — `extendedTextMessage` gibi METIN
  // paketleri de nesnedir ve indirme denemesi
  // `"extendedTextMessage" message is not a media message` hatasiyla
  // duserdi (log gurultusu). Kabul kosulu burada birebir uygulanir.
  if (!('url' in media) && !('thumbnailDirectPath' in media)) return null;
  return { contentType, media };
}

// Baileys/WA ack seviyeleri → WhatsApp Web tik anlamları.
// proto.WebMessageInfo.Status: 1=SERVER_ACK(✓) 2=DELIVERY_ACK(✓✓) 3=READ(✓✓ mavi) 4=PLAYED
const ACK_RANK = { 1: 'SENT', 2: 'DELIVERED', 3: 'READ', 4: 'READ' };
const ACK_ORDER = { PENDING: 0, SENT: 1, DELIVERED: 2, READ: 3, FAILED: 4 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function encryptBuffer(buf, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([iv, encrypted]);
}

function decryptBuffer(buf, key) {
  const iv = buf.subarray(0, 16);
  const encrypted = buf.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function safeWriteEncrypted(filePath, data, key) {
  const encrypted = encryptBuffer(Buffer.from(JSON.stringify(data)), key);
  fs.writeFileSync(filePath, encrypted);
}

function safeReadEncrypted(filePath, key) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const encrypted = fs.readFileSync(filePath);
    const decrypted = decryptBuffer(encrypted, key);
    return JSON.parse(decrypted.toString('utf-8'));
  } catch (err) {
    logger.warn({ err }, 'Failed to decrypt session file, ignoring');
    return null;
  }
}

function isLidJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@lid');
}

// Sorun (prod geri bildirim): WhatsApp Durum/Hikaye güncellemeleri ve kanal
// (newsletter) mesajlari SOHBET LISTESINDE gorunuyordu. WhatsApp Web'de bu
// JID'ler asla sohbet listesinde gosterilmez — `status@broadcast` Durum
// sekmesine, `@newsletter` Guncellemeler/Kanallar sekmesine aittir. Bu
// uygulamada boyle bir sekme olmadigi icin bu JID'ler sohbet akisindan
// TAMAMEN dislanir: sohbet/contact/mesaj uretilmez, UI'a yayinlanmaz.
function isStatusBroadcastJid(jid) {
  return jid === 'status@broadcast';
}

function isNewsletterJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@newsletter');
}

function isBroadcastOnlyJid(jid) {
  return isStatusBroadcastJid(jid) || isNewsletterJid(jid);
}

// LID/telefon JID normalizasyonu: WhatsApp ham sayı ya da tam JID gönderebilir.
function asLid(v) {
  if (!v || typeof v !== 'string') return null;
  return v.includes('@') ? v : `${v}@lid`;
}

function asPn(v) {
  if (!v || typeof v !== 'string') return null;
  return v.includes('@') ? v : `${v}@s.whatsapp.net`;
}

// LID ↔ telefon çiftini kalıcı olarak öğren; ilk kez görülüyorsa true döner
// (çağıran taraf bekleyen LID kayıtlarını telefona taşır). Eşleşmeler
// OTURUMA ÖZELDİR — bir hesabın LID haritası başka hesabın JID'lerini çözmez.
function rememberLidPair(store, lid, phoneJid) {
  const l = asLid(lid);
  const p = asPn(phoneJid);
  if (!store || !l || !p || !isLidJid(l) || isLidJid(p)) return false;
  if (store.lidToJid.get(l) === p) return false;
  store.lidToJid.set(l, p);
  store.jidToLid.set(p, l);
  return true;
}

function jidToPhone(jid) {
  if (!jid) return null;
  // LID kimliği telefon numarası DEĞİLDİR — asla +rakam türetilmez
  // (AGENTS.md: sahte telefon sentezlenmez).
  if (isLidJid(jid)) return null;
  // Faz 8: grup JID'i de telefon DEĞİLDİR — rakamlardan sahte +numara üretilmez.
  if (jid.includes('@g.us')) return null;
  const match = jid.match(/^(\d+)@/);
  if (!match) return null;
  // Faz 9 (§4/§5): dejenere JID'ler (`0@s.whatsapp.net`, `000@...`) gerçek
  // numara DEĞİLDİR — '+0' gibi uydurma telefonlar üretilmez (AGENTS.md:
  // sahte telefon sentezlenmez). En az 5 haneli ve tümü sıfır olmayan
  // numaralar geçerlidir (E.164 minimum uzunluk + dejenere koruma).
  const digits = match[1];
  if (digits.length < 5 || /^0+$/.test(digits)) return null;
  return `+${digits}`;
}

// Faz 9 (§5, RC-2): dejenere/sistem JID'leri (`0@s.whatsapp.net`, `000@...`)
// gerçek bir kişi ya da sohbet DEĞİLDİR — contact/conversation kaydı
// üretilmez, pipeline'ın her katmanında bu tek kriterle atlanır.
function isDegenerateJid(jid) {
  if (!jid) return false;
  const m = String(jid).match(/^(\d+)@/);
  if (!m) return false;
  const digits = m[1];
  return digits.length < 5 || /^0+$/.test(digits);
}

// Faz 9 (§16/§19, RC-3): sync tamamlanma kararı — WhatsApp'ın GERÇEK
// sinyallerinden türetilir (isLatest bayrağı VEYA messaging-history.set
// progress=100'ü). Prod'da isLatest hiç gelmiyor (Baileys RECENT sync);
// progress 100'e ulaşan senkron fiilen bitmiştir. Sahte timer/banner
// kapatma YOK — tamamlanma yalnızca veri sinyaline bağlıdır. Progress
// monotonik artar; ilk tamamlanmada completed_at set edilir.
function resolveSyncState(prevSync, { progress, isLatest }) {
  const prev = prevSync || { phase: 'syncing', progress: 0, chats_synced: 0, contacts_synced: 0, messages_synced: 0 };
  const realProgress = typeof progress === 'number' && Number.isFinite(progress) ? Math.min(100, Math.round(progress)) : null;
  const done = !!isLatest || realProgress === 100;
  const alreadyDone = prev.phase === 'ready';
  let nextProgress = prev.progress || 0;
  if (realProgress != null) nextProgress = Math.max(nextProgress, realProgress);
  if (done) nextProgress = 100;
  return {
    next: {
      ...prev,
      phase: done || alreadyDone ? 'ready' : 'syncing',
      progress: nextProgress,
      completed_at: (done || alreadyDone)
        ? (prev.completed_at || new Date().toISOString())
        : prev.completed_at || null,
    },
    justCompleted: (done && !alreadyDone),
  };
}

// Faz 8: ham WhatsApp kimliği (jid:/@lid/@g.us/@s.whatsapp.net) görüntülenen
// ad OLAMAZ — identity çözülmeden emit/REST'e ad olarak yayılmaz.
function isRawIdentityName(value) {
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

// ---------------------------------------------------------------------------
// Faz 10 (P2): SON MESAJ OZETI — gateway tarafindaki tek kural (backend
// `build_last_message_summary` ile birebir ayni semantik). Initial history,
// chats.update ve realtime mesaj akisi AYNI yardimciyi kullanir; sohbet
// ozeti hicbir yerde farkli hesaplanmaz.
//  - Metinde govde; medyada tip etiketi (📷/🎥/🎵/📄/Sticker...).
//  - Eski '[IMAGE]' tarzi degerler ayni etiketlere normalize edilir.
//  - Grup + gelen mesajda cozulmus gonderen on eki: "Ahmet: ..."; ham JID
//    veya telefon gorunumlu ad ASLA on ek olmaz.
// ---------------------------------------------------------------------------
const TYPE_PREVIEW_LABELS = {
  IMAGE: '📷 Fotoğraf',
  VIDEO: '🎥 Video',
  AUDIO: '🎵 Sesli mesaj',
  STICKER: 'Sticker',
  DOCUMENT: '📄 Dosya',
  LOCATION: '📍 Konum',
  CONTACT: '👤 Kişi kartı',
  TEMPLATE: 'Şablon mesajı',
  UNKNOWN: 'Mesaj',
  OTHER: 'Mesaj',
};

function isPhoneLikeName(value) {
  if (!value || typeof value !== 'string') return false;
  const v = value.trim();
  return /^\+?[\d\s-()]{6,}$/.test(v) || /@\w+\.(\w+)$/.test(v);
}

function normalizePreviewText(messageType, body) {
  const t = String(messageType || 'TEXT').toUpperCase();
  const text = String(body || '').trim();
  if (text) {
    const m = /^\[([A-Za-z_]+)\]$/.exec(text);
    if (m) {
      const inner = m[1].toUpperCase();
      // UI'a asla kopeli deger sizmaz: taninmayan tip -> mesajin kendi tip
      // etiketi, o da yoksa genel 'Mesaj'.
      return TYPE_PREVIEW_LABELS[inner] || TYPE_PREVIEW_LABELS[t] || 'Mesaj';
    }
    if (text === '[object Object]' || text === '[Medya]') return TYPE_PREVIEW_LABELS[t] || 'Mesaj';
    return text;
  }
  if (t === 'TEXT') return '';
  return TYPE_PREVIEW_LABELS[t] || 'Mesaj';
}

// Gateway mesaj kaydi (record) + sohbetin grup anahtari -> preview string.
function buildChatPreview(record, isGroup) {
  const base = normalizePreviewText(record?.message_type, record?.body);
  if (!base) return '';
  const name = String(record?.participant_name || '').trim();
  if (
    isGroup &&
    String(record?.direction || 'INBOUND').toUpperCase() === 'INBOUND' &&
    name &&
    name.toUpperCase() !== 'ME' &&
    !isRawIdentityName(name) &&
    !isPhoneLikeName(name)
  ) {
    return `${name}: ${base}`;
  }
  return base;
}

// Sorun 3 (tek kaynak): Baileys mesaj govdesinden mesaj TIPINI cozumleyen
// TEK paylasilan fonksiyon. Eski yol ayni zinciri 3 ayri yerde (canli
// messages.upsert, history sync, chats.update) kopyaliyordu — kopyalar
// drift edince alintilanmis/iletilmis/link-onizlemeli metinler (hepsi
// `extendedTextMessage` tasir) medya gibi siniflandiriliyordu.
// Kurallar:
//  - Gercek medya paketleri (image/document/audio/video/sticker) ONCE kontrol
//    edilir; caption'li medya medyadir.
//  - `conversation` VEYA `extendedTextMessage` (contextInfo.quotedMessage,
//    contextInfo.isForwarded, matchedManagedLink/link-onizleme dahil) → TEXT.
//  - Baska tanimli paket yoksa konum/kisi karti, o da yoksa TEXT.
function classifyMessageType(content) {
  const c = content || {};
  if (c.imageMessage) return 'IMAGE';
  if (c.documentMessage) return 'DOCUMENT';
  if (c.audioMessage) return 'AUDIO';
  if (c.videoMessage) return 'VIDEO';
  if (c.stickerMessage) return 'STICKER';
  // Metin paketleri: duz `conversation` veya `extendedTextMessage` — alintili,
  // iletilmis ve link-onizlemeli mesajlarin TAMAMI extendedTextMessage'dir ve
  // TEXT sayilir (medya DEGIL).
  if (c.conversation || c.extendedTextMessage) return 'TEXT';
  if (c.locationMessage) return 'LOCATION';
  if (c.contactMessage) return 'CONTACT';
  return 'TEXT';
}

// History/gecmis kayitlarinda `classifyMessageType` her sey TEXT dondurdugu
// icin, hicbir taninir paket tasimayan stub'lari (reaction, protocol/revoke,
// ephemeral ayar — govdesiz) ayirt etmek icin ayrica kullanilir: eskiden
// tip zinciri bunlara `null` dondurup kaydi atliyordu; ayni davranis korunur.
function hasRecognizedContent(content) {
  const c = content || {};
  return Boolean(
    c.imageMessage || c.documentMessage || c.audioMessage || c.videoMessage ||
    c.stickerMessage || c.conversation || c.extendedTextMessage ||
    c.locationMessage || c.contactMessage
  );
}

// Baileys WAMessage -> { message_type, body } (chats.update.lastMessage icin).
function summarizeWaMessage(waMsg) {
  const content = waMsg?.message || {};
  const text =
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    '';
  return { message_type: classifyMessageType(content), body: text };
}

// Oturumun LID haritasına göre JID'i kanonik anahtara çözer.
// (Eski adı `normalizeJid`; artık store parametresi ZORUNLU — `_connectSocket`
// içinde `normalizeJid` adıyla store'a bağlı yerel bir sarmalayıcı tanımlanır,
// böylece soket işleyicilerinin gövdesi değişmeden çalışır.)
function resolveJidKey(store, jid) {
  if (!jid) return jid;
  if (jid.includes('@g.us')) return jid; // group
  // LID kimliği eşleşmesi biliniyorsa telefon JID'ine çöz — sohbetler,
  // kişiler ve mesajlar her zaman telefon anahtarıyla tutulur (WhatsApp
  // Web paritesi: rehber adı telefon-anahtarlı sohbete işlenir).
  if (isLidJid(jid)) {
    const phone = store?.lidToJid.get(jid);
    return phone || jid;
  }
  if (jid.includes('@s.whatsapp.net')) return jid;
  if (jid.includes('@')) return jid;
  return `${jid}@s.whatsapp.net`;
}

// ---------------------------------------------------------------------------
// Contact name priority (WhatsApp Web parity): kullanıcının telefon
// rehberindeki ad (W:Contact app-state → contacts.upsert) her zaman
// pushName'den (kişinin kendi profil adı) önce gelir.
// ---------------------------------------------------------------------------
const NAME_RANK = { addressbook: 5, group_subject: 4, verified: 4, history: 3, push: 2, phone: 1 };

// Faz 8: emit/REST'e çıkmadan önce sohbet kaydını temizler — ham jid/lid
// asla görüntülenen ad olarak yayılmaz (WhatsApp Web paritesi: kullanıcı
// `120363xxx@g.us` değil `İstanbul İş Grubu` görür).
function sanitizeChatForEmit(chat) {
  if (!chat) return chat;
  const out = { ...chat };
  if (isRawIdentityName(out.name)) {
    out.name = null;
    out.name_source = null;
  }
  return out;
}

// Faz 8: gateway'den backend'e giden TUM olaylarda ham kimlik sizintisini
// kesen tek nokta (sessionManager._emit icinden cagrilir). Ad alanlari
// cozulmemis kimlik iceriyorsa null'a cevrilir — backend/dogrulama katmani
// (Faz 7 _set_contact_name) zaten reddediyor, ama WS broadcast'i DB'den
// bagimsiz oldugu icin burada da temizlenir.
function sanitizeOutboundEvent(event) {
  if (!event || typeof event !== 'object') return event;
  switch (event.event) {
    case 'conversation_updated':
      if (event.conversation) return { ...event, conversation: sanitizeChatForEmit(event.conversation) };
      return event;
    case 'contact_synced': {
      if (!event.contact) return event;
      const contact = { ...event.contact };
      if (isRawIdentityName(contact.name)) {
        contact.name = jidToPhone(contact.id) || null;
        contact.name_source = contact.name ? 'phone' : null;
      }
      return { ...event, contact };
    }
    case 'message_new': {
      if (!event.message) return event;
      const msg = { ...event.message };
      if (isRawIdentityName(msg.sender_name)) {
        msg.sender_name = jidToPhone(msg.conversation_id) || null;
      }
      if (isRawIdentityName(msg.participant_name)) msg.participant_name = null;
      return { ...event, message: msg };
    }
    default:
      return event;
  }
}

// Faz 8: birim testleri icin sanitizasyon yardimcilari disa aktarilir
// (createSessionManager factory'si ayrica export edilir; index.js ikisini de
// kullanabilir).
export { isRawIdentityName, sanitizeChatForEmit, sanitizeOutboundEvent, mergeContactName, NAME_RANK, jidToPhone, isDegenerateJid, resolveSyncState, normalizePreviewText, buildChatPreview, isPhoneLikeName, summarizeWaMessage, classifyMessageType, hasRecognizedContent, resolveDownloadableMedia };

function mergeContactName(existing, name, source) {
  const base = existing || {};
  if (!name) return base;
  const currentRank = NAME_RANK[base.name_source] || (base.name ? NAME_RANK.history : 0);
  const newRank = NAME_RANK[source] || NAME_RANK.history;
  const phoneLike = !base.name || /^\+\d+$/.test(base.name) || base.name === base.phone;
  if (phoneLike || newRank >= currentRank) {
    return { ...base, name, name_source: source };
  }
  return base;
}

function getSessionDir(sessionsDir, sessionId) {
  return path.join(sessionsDir, sessionId);
}

// ---------------------------------------------------------------------------
// Session Manager factory
// ---------------------------------------------------------------------------
export function createSessionManager({
  sessionsDir,
  mediaDir,
  aesKey,
  backendWsUrl,
  authRepository = null,
  leaseRepository = null,
  instanceId = 'local-instance',
}) {
  const sessions = new Map(); // manager-local: no cross-instance/session leakage
  const mediaIndex = new Map(); // every entry is scoped by its owning session
  // Baileys retry counters must outlive an individual socket. Keep one bounded
  // cache per session so two WhatsApp lines can never share message IDs or
  // retry budgets, while reconnects on the same line retain their counters.
  const msgRetryCounterCaches = new Map();
  function retryCounterCacheFor(sessionId) {
    let cache = msgRetryCounterCaches.get(String(sessionId));
    if (!cache) {
      cache = createBoundedCache({ maxEntries: 10_000, ttlMs: 60 * 60 * 1000 });
      msgRetryCounterCaches.set(String(sessionId), cache);
    }
    return cache;
  }
  function resetRetryCounterCache(sessionId) {
    const cache = msgRetryCounterCaches.get(String(sessionId));
    cache?.close();
    msgRetryCounterCaches.delete(String(sessionId));
  }
  function clearLeaseTimers(session) {
    if (session._leaseRenewTimer) clearInterval(session._leaseRenewTimer);
    if (session._leaseRetryTimer) clearTimeout(session._leaseRetryTimer);
    session._leaseRenewTimer = null;
    session._leaseRetryTimer = null;
    session._leaseRenewing = false;
  }

  async function releaseLease(session) {
    clearLeaseTimers(session);
    session._leaseValidUntil = 0;
    if (leaseRepository) await leaseRepository.release(session.id, instanceId);
  }

  function clearSessionMedia(sessionId) {
    for (const [mediaId, entry] of mediaIndex) {
      if (entry?.sessionId !== String(sessionId)) continue;
      try {
        if (entry.filePath && fs.existsSync(entry.filePath)) fs.rmSync(entry.filePath, { force: true });
      } catch (err) {
        logger.warn({ err, mediaId }, 'Session media cleanup failed');
      }
      mediaIndex.delete(mediaId);
    }
  }

  async function deactivatePersistentSession(sessionId) {
    if (!authRepository) return;
    // A remote logout/badSession is authoritative. Remove credentials before
    // the next restore cycle so a dead Signal state can never be retried.
    try {
      await authRepository.clearAuth(sessionId);
      await authRepository.setSessionActive(sessionId, false);
    } catch (err) {
      // The in-memory state is still marked inactive; expose persistence
      // failure without turning a real disconnect into a false success.
      logger.error({ err, session_ref: sessionRef(sessionId) }, 'Persistent auth cleanup failed');
    }
  }
  const persistedSessionDirectories = fs.existsSync(sessionsDir)
    ? fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
    : 0;
  diagnostic('session_registry_initialized', {
    in_memory_sessions: sessions.size,
    persisted_session_directories: persistedSessionDirectories,
    restored_sessions: 0,
  });
  const sessionManager = {
    _listeners: new Set(),
    _emit(event) {
      // Silinen veya tanimsiz oturumlarin gecikmis olaylarini yayma
      const gwSid = event && (event.gateway_session_id || event.session_id);
      if (gwSid && !sessions.has(String(gwSid)) && !String(event.event || '').startsWith('session_deleted')) {
        return;
      }
      // Faz 8: TEK sanitizasyon noktasi — ham WhatsApp kimligi (@lid/@g.us/
      // @s.whatsapp.net/jid:) hicbir olayda goruntulenen ad olarak disariya
      // (backend/UI) yayilmaz. Backend ve frontend isim uretmez; cozulmemis
      // kimlikte ad null kalir, UI guvenli fallback gosterir.
      const sanitized = sanitizeOutboundEvent(event);
      for (const listener of this._listeners) {
        try { listener(sanitized); } catch (err) { logger.warn({ err }, 'Event listener error'); }
      }
    },
    onEvent(listener) {
      this._listeners.add(listener);
      return () => this._listeners.delete(listener);
    },

    async shutdown() {
      const leaseReleases = [];
      for (const session of sessions.values()) {
        session._shuttingDown = true;
        session.lifecycle.invalidate();
        if (session._historyQuietTimer) {
          clearTimeout(session._historyQuietTimer);
          session._historyQuietTimer = null;
        }
        try { session.sock?.ev?.removeAllListeners(); } catch (err) { /* ignore */ }
        try { session.sock?.end(undefined); } catch (err) { /* ignore */ }
        session.sock = null;
        session.is_phone_online = false;
        if (leaseRepository) leaseReleases.push(releaseLease(session));
      }
      await Promise.allSettled(leaseReleases);
      diagnostic('session_registry_shutdown', { sessions: sessions.size });
    },

    // -----------------------------------------------------------------------
    // Session CRUD
    // -----------------------------------------------------------------------
    listSessions() {
      return [...sessions.values()].map((s) => ({
        id: s.id,
        session_name: s.session_name,
        status: s.status,
        phone_number: s.phone_number || null,
        is_active: s.is_active,
        is_phone_online: s.is_phone_online || false,
        battery_level: s.battery_level ?? null,
        error_message: s.error_message || null,
        qr_code: s.status === 'SCAN_QR' ? s.qr_code : null,
        // Faz 7: WhatsApp Web benzeri initial-sync lifecycle durumu.
        // phase: idle | syncing | ready — progress yalnızca GERÇEK
        // messaging-history.set yüzdesidir (sahte progress yok).
        sync: s.sync || { phase: 'idle' },
        created_at: s.created_at,
        updated_at: s.updated_at,
      }));
    },

    getSession(id) {
      return sessions.get(id) || null;
    },

    async restoreSessions({ concurrency = 2 } = {}) {
      if (!authRepository) return { discovered: 0, restored: 0 };
      const records = await authRepository.listRestorableSessions();
      let restored = 0;
      for (let offset = 0; offset < records.length; offset += concurrency) {
        const batch = records.slice(offset, offset + concurrency);
        await Promise.all(batch.map(async (record) => {
          const id = String(record.session_id);
          if (sessions.has(id)) return;
          const session = await this.createSession(record.session_name, {
            id,
            autoStart: false,
            persistRegistry: false,
          });
          session.status = 'RESTORING';
          this._startSocket(id);
          restored += 1;
        }));
      }
      diagnostic('session_registry_restored', {
        discovered: records.length,
        restored,
        concurrency,
      });
      return { discovered: records.length, restored };
    },

    async createSession(name, {
      autoStart = true,
      id: requestedId = null,
      persistRegistry = true,
    } = {}) {
      const id = requestedId ? String(requestedId) : uuidv4();
      if (sessions.has(id)) return this.getSession(id);
      if (authRepository && persistRegistry) {
        await authRepository.registerSession(id, name, { active: true });
      }
      const session = {
        id,
        session_name: name,
        status: 'SCAN_QR',
        qr_code: null,
        phone_number: null,
        is_active: true,
        is_phone_online: false,
        battery_level: null,
        error_message: null,
        error_reason: null,
        _connFailures: 0,
        _qrSeenForAttempt: false,
        _pairingPhone: null,
        _pairingRequestedAt: 0,
        sync: { phase: 'idle', progress: 0, chats_synced: 0, contacts_synced: 0, messages_synced: 0, started_at: null, completed_at: null },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        sock: null,
        lifecycle: new SocketLifecycle(),
        _leaseRenewTimer: null,
        _leaseRetryTimer: null,
        _leaseRenewing: false,
        _leaseValidUntil: 0,
        // Bu hesaba ait kişiler/sohbetler/mesajlar yalnızca burada yaşar.
        store: createSessionStore(),
      };
      sessions.set(id, session);
      // `autoStart: false` yalnızca birim testleri içindir: Baileys soketi
      // açılmadan oturum kaydı + deposu oluşur.
      if (autoStart) this._startSocket(id);
      return this.getSession(id);
    },

    async refreshQr(id) {
      const session = sessions.get(id);
      if (!session) throw new Error('Session not found');
      if (session.status === 'CONNECTED') return this.getSession(id);
      diagnostic('qr_refresh_requested', {
        session_ref: sessionRef(id),
        current_generation: session._diagnosticSocketGeneration || 0,
        socket_present: Boolean(session.sock),
      });
      session.status = 'SCAN_QR';
      session.qr_code = null;
      session.error_message = null;
      session.error_reason = null;
      session._connFailures = 0;
      session._qrSeenForAttempt = false;
      session.updated_at = new Date().toISOString();
      if (authRepository) {
        await authRepository.registerSession(id, session.session_name, { active: true });
      }
      // Force a fresh QR by restarting the socket
      session.lifecycle.invalidate();
      await releaseLease(session);
      if (session.sock) {
        try { session.sock.ev?.removeAllListeners(); } catch (err) { /* ignore */ }
        try { session.sock.end(undefined); } catch (err) { /* ignore */ }
        session.sock = null;
      }
      this._startSocket(id);
      return this.getSession(id);
    },

    // -----------------------------------------------------------------------
    // Pairing code ("Telefon Numarası ile Bağlan") — Baileys
    // sock.requestPairingCode(digits) ile 8 haneli kod üretir; kullanıcı bu
    // kodu WhatsApp > Ayarlar > Bağlı Cihazlar > "Telefon numarasıyla bağla"
    // ekranına girer. Hata durumları fail-closed olarak yukarı fırlatılır
    // (AGENTS.md Truthfulness) — asla sahte başarı döndürülmez.
    // -----------------------------------------------------------------------
    async requestPairingCode(id, phone) {
      const session = sessions.get(id);
      if (!session) throw new Error('Session not found');
      if (session.status === 'CONNECTED') {
        throw new Error('Bu oturum zaten bağlı. Kod istemek için önce oturumu ayırın.');
      }

      // Telefonu normalize et: yalnızca rakam (ülke kodu dahil, "+" yok).
      let digits = String(phone || '').replace(/\D/g, '');
      if (digits.startsWith('00')) digits = digits.slice(2);
      // TR formatı "05XX..." olarak girilirse ülke kodunu otomatik tamamla.
      if (/^0\d{10}$/.test(digits)) digits = `90${digits.slice(1)}`;
      if (digits.length < 10 || digits.length > 15) {
        throw new Error('Geçersiz telefon numarası. Ülke kodu ile birlikte girin (örn. +90 5XX XXX XX XX).');
      }

      // Socket henüz hazırsa pairing çağrısı yapılamaz — kısa bir bekleme ile
      // socket açılışını karşıla (fail-fast değil, fail-closed: süreyi aşarsa hata).
      if (!session.sock) {
        this._startSocket(id);
      }
      const deadline = Date.now() + 15000;
      // requestPairingCode bağlantı AÇIK olmadan gönderilemez; QR üretimi
      // (status=SCAN_QR) bağlantının açıldığının kanıtıdır.
      while ((!session.sock || session.status !== 'SCAN_QR') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300));
      }
      if (!session.sock) {
        throw new Error('WhatsApp soketi hazırlanamadı. "QR\'ı Yenile" ile tekrar deneyin.');
      }
      if (session.status !== 'SCAN_QR') {
        throw new Error(
          session.error_message ||
          'WhatsApp bağlantısı henüz kurulamadı. Birkaç saniye sonra tekrar deneyin.'
        );
      }

      const pairingCode = await session.sock.requestPairingCode(digits);
      // Bağlantı tamamlandığında telefonun görünmesi için oturuma işle.
      session.phone_number = `+${digits}`;
      // Pairing niyetini sakla: QR süresi dolup soket yeniden başlayınca kod
      // geçersiz olur (WhatsApp "Cihaza bağlanamadı" verir) — _connectSocket
      // içindeki yeni QR kolonu bu sayede taze kod üretip UI'a itebilir.
      session._pairingPhone = digits;
      session._pairingRequestedAt = Date.now();
      session.updated_at = new Date().toISOString();
      // logger.warn: prod'da pino seviyesi 'warn' — pairing yaşam döngüsü
      // olayları görünür kalmalı (aksi halde teşhis için log yok).
      logger.warn({ session_ref: sessionRef(id) }, 'Pairing code generated');
      return { pairing_code: pairingCode, phone: session.phone_number };
    },

    async logoutSession(id) {
      const session = sessions.get(id);
      if (!session) throw new Error('Session not found');
      session.lifecycle.invalidate();
      await releaseLease(session);
      try {
        if (session.sock) {
          await session.sock.logout();
          session.sock.end(undefined);
        }
      } catch (err) {
        logger.warn({ err }, 'Logout error');
      }
      session.status = 'DISCONNECTED';
      session.is_active = false;
      session.is_phone_online = false;
      session._pairingPhone = null;
      session._pairingRequestedAt = 0;
      // Bekleyen history-sync sessizlik zamanlayicisini iptal et — yoksa
      // logout sonrasi hayalet `session_sync_completed` yayinlanir.
      if (session._historyQuietTimer) {
        clearTimeout(session._historyQuietTimer);
        session._historyQuietTimer = null;
      }
      session.updated_at = new Date().toISOString();
      // Hattan çıkıldı: bu hesabın sohbet/kişi/mesaj belleği de bırakılır.
      // (Eski global modelde veriler süresiz duruyor ve yeniden eşleşen
      // BAŞKA bir hesabın istekleriyle karışabiliyordu.)
      session.store = createSessionStore();
      clearSessionMedia(id);
      resetRetryCounterCache(id);
      // Remove persisted auth state
      if (authRepository) {
        await authRepository.clearAuth(id);
        await authRepository.setSessionActive(id, false);
      }
      const dir = getSessionDir(sessionsDir, id);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      emitEvent({ event: 'session_disconnected', session_id: id, session_name: session.session_name });
      return this.getSession(id);
    },

    async deleteSession(id) {
      const session = sessions.get(id);
      if (session) {
        session._deleted = true;
        session.lifecycle.invalidate();
        await releaseLease(session);
        if (session.sock?.ev) {
          try { session.sock.ev.removeAllListeners(); } catch (err) { /* ignore */ }
        }
        if (session.sock) {
          try { session.sock.end(undefined); } catch (err) { /* ignore */ }
        }
      }
      // Bekleyen history-sync sessizlik zamanlayicisini iptal et — yoksa
      // silme sonrasi hayalet `session_sync_completed` / `history_sync_completed`
      // yayinlanir ve backend'de sahipsiz olay seli olur (Render log).
      if (session?._historyQuietTimer) {
        try { clearTimeout(session._historyQuietTimer); } catch (err) { /* ignore */ }
        session._historyQuietTimer = null;
      }
      if (authRepository) {
        await authRepository.clearAuth(id);
        await authRepository.setSessionActive(id, false);
      }
      sessions.delete(id);
      resetRetryCounterCache(id);
      // Oturumun bellek deposu ve indirilmiş medyası da bırakılır.
      if (session) session.store = null;
      clearSessionMedia(id);
      const dir = getSessionDir(sessionsDir, id);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    },

    // -----------------------------------------------------------------------
    // Contacts
    // -----------------------------------------------------------------------
    listContacts(sessionId) {
      const session = this._requireSession(sessionId);
      const { contacts } = this._storeOf(session);
      // Telefon kimliği henüz çözülememiş LID-bekletme kayıtlarını dışarı
      // verme — eşleşme öğrenilince _applyLidMapping telefona taşır.
      return [...contacts.values()]
        .filter((c) => !isLidJid(c.id))
        .map((c) => ({ ...c }));
    },

    // -----------------------------------------------------------------------
    // Conversations
    // -----------------------------------------------------------------------
    listConversations(sessionId, { search, limit, offset } = {}) {
      const session = this._requireSession(sessionId);
      const store = this._storeOf(session);
      const { chats, contacts } = store;
      // Eşleşmesi henüz çözülememiş LID-anahtarlı sohbetleri dışarı verme —
      // telefon eşleşmesi öğrenilince _applyLidMapping onları telefona taşır
      // (WhatsApp Web'de ham `xxx@lid` başlığı görünmez).
      let list = [...chats.values()].filter((c) => !isLidJid(c.jid)).sort((a, b) => {
        const tA = new Date(a.last_message_at || a.created_at || 0).getTime();
        const tB = new Date(b.last_message_at || b.created_at || 0).getTime();
        return tB - tA;
      });
      if (search) {
        const q = search.toLowerCase();
        list = list.filter((c) =>
          (c.name || '').toLowerCase().includes(q) ||
          (c.phone || '').toLowerCase().includes(q)
        );
      }
      const total = list.length;
      if (offset) list = list.slice(offset);
      if (limit) list = list.slice(0, limit);
      // Okuma aninda ismi contact Map'ten yeniden coz (rehber adi app-state
      // senkronu sohbet kaydindan sonra gelmis olabilir — sidebar paritesi).
      return {
        items: list.map((c) => {
          const contact = contacts.get(c.jid) || contacts.get(resolveJidKey(store, c.jid));
          if (contact?.name && contact.name !== c.name) {
            const rankNew = NAME_RANK[contact.name_source] || 0;
            const rankCur = NAME_RANK[c.name_source] || (c.name && /^\+\d+$/.test(c.name) ? 0 : NAME_RANK.history);
            if (!c.name || /^\+\d+$/.test(c.name) || rankNew >= rankCur) {
              return sanitizeChatForEmit({ ...c, name: contact.name, name_source: contact.name_source || null });
            }
          }
          // Faz 8: ham jid/lid ad olarak REST'e cikmaz — backend/frontend
          // normalize edilmis telefona duser (identity cozulene kadar).
          return sanitizeChatForEmit(c);
        }),
        total,
      };
    },

    async getMessages(sessionId, jid, { limit = 50, before } = {}) {
      const session = this._requireSession(sessionId);
      const store = this._storeOf(session);
      const key = resolveJidKey(store, jid);
      let list = store.messagesByChat.get(key) || [];
      if (before) {
        list = list.filter((m) => m.id < before);
      }
      list.sort((a, b) => (a.id || 0) - (b.id || 0));
      return list.slice(-limit);
    },

    // Faz 10 (P5): initial-sync bulk kanali — TUM gecmisi tek kaynakta, zaman
    // damgasi sirali ve sayfalidir. Eski yol sohbet basina getMessages cagrisi
    // 113 HTTP turu yaratip backend istegini Render limitlerini asacak kadar
    // uzatiyordu (502 kok nedeni). messagesByChat zaten history-sync'ten
    // gelen her seyi bellekte tutar; burada yalniza flatten + sirali sayfa
    // dondurulur (ek kopya/veri sentezi yok). Offset sayfalamasi, tam
    // siralama anahtariyla (id, wa_message_id) deterministiktir.
    //
    // Faz 6 (P0.13 delta sync): `since` (epoch saniye) verildiginde yalnizca
    // GERCEK mesaj zaman damgasi (created_at — Baileys messageTimestamp'ten
    // turetilir, sentez degil) `since`'tan yeni olanlar dondurulur. Backend
    // suucusu DB'deki en son bilinen mesaj zamanidir; boylece reconnect
    // sonrasinda tekrar-tekrar ayni gecmis cekilmez. Sayim/total bu filtreli
    // kume gorudur.
    //
    // Sorun 1 (initial-sync maliyeti): `perChatLimit` verildiginde her sohbet
    // icin yalnizca EN YENI N mesaj dondurulur. Boylece ilk senkron sohbet
    // basi ~50 mesajla sinirli kalir; daha eskileri backend kaydirma
    // sirasinda lazy hydration ile ceker. `total` bu sinirli kume sayisidir
    // — backend sayfalama dongusu icin tutarli gorunum.
    listAllMessages(sessionId, { limit = 1000, offset = 0, since = null, perChatLimit = null } = {}) {
      const session = this._requireSession(sessionId);
      const { messagesByChat } = this._storeOf(session);
      const sinceMs = Number.isFinite(Number(since)) && since !== null && since !== ''
        ? Number(since) * 1000
        : null;
      const perChat = Number.isFinite(Number(perChatLimit)) && Number(perChatLimit) > 0
        ? Number(perChatLimit)
        : null;
      const all = [];
      for (const list of messagesByChat.values()) {
        let group = list;
        if (sinceMs !== null) {
          group = group.filter((m) => {
            const t = Date.parse(m.created_at || '');
            return Number.isFinite(t) && t >= sinceMs;
          });
        }
        if (perChat !== null && group.length > perChat) {
          // Sohbet ici en yeni N: kayit id'si hem history'de
          // (messageTimestamp*1000) hem canli akista (Date.now() tabanli)
          // ms kronolojisidir — buyuk id = daha yeni mesaj.
          group = [...group].sort((a, b) => (a.id || 0) - (b.id || 0)).slice(-perChat);
        }
        for (const m of group) all.push(m);
      }
      all.sort((a, b) => {
        const d = (a.id || 0) - (b.id || 0);
        if (d !== 0) return d;
        return String(a.wa_message_id || '') < String(b.wa_message_id || '') ? -1 : 1;
      });
      const page = all.slice(offset, offset + limit);
      return { messages: page, total: all.length, offset, limit };
    },

    // -----------------------------------------------------------------------
    // Sending
    // -----------------------------------------------------------------------
    async sendTextMessage(sessionId, jid, body, client_message_id) {
      const session = this._requireConnectedSession(sessionId);
      const key = resolveJidKey(this._storeOf(session), jid);
      const result = await session.sock.sendMessage(key, { text: body });
      const msg = this._recordOutbound(key, {
        body,
        message_type: 'TEXT',
        client_message_id: client_message_id || `cmsg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        wa_message_id: result?.key?.id || null,
        status: 'SENT',
      }, session.id);
      return msg;
    },

    async sendMediaMessage(sessionId, jid, { media_type, media_url, media_base64, mime_type, caption, filename, client_message_id }) {
      const session = this._requireConnectedSession(sessionId);
      const key = resolveJidKey(this._storeOf(session), jid);
      const type = (media_type || 'document').toLowerCase();
      // Base64 payload (frontend upload) wins over URL; Baileys accepts Buffers.
      const buffer = media_base64 ? Buffer.from(media_base64, 'base64') : null;
      const source = buffer
        ? { url: buffer, mimetype: mime_type || undefined }
        : { url: media_url };
      let content;
      if (type === 'image') {
        content = { image: source, caption: caption || '' };
      } else if (type === 'audio') {
        content = { audio: source, mimetype: mime_type || 'audio/mpeg', ptt: false };
      } else if (type === 'video') {
        content = { video: source, caption: caption || '' };
      } else {
        content = { document: source, mimetype: mime_type || 'application/octet-stream', fileName: filename || 'belge.bin', caption: caption || '' };
      }
      const result = await session.sock.sendMessage(key, content);
      const msg = this._recordOutbound(key, {
        body: caption || filename || media_url || `[${type.toUpperCase()}]`,
        message_type: type.toUpperCase(),
        media_url: media_url || null,
        media_filename: filename,
        media_caption: caption,
        client_message_id: client_message_id || `media_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        wa_message_id: result?.key?.id || null,
        status: 'SENT',
      }, session.id);
      return msg;
    },

    // Faz 5: 'yazıyor…' presence güncellemesi (WhatsApp Web paritesi).
    async sendTyping(sessionId, jid, typing = true, durationMs = 4000) {
      const session = this._requireConnectedSession(sessionId);
      const key = resolveJidKey(this._storeOf(session), jid);
      try {
        await session.sock.sendPresenceUpdate(typing ? 'composing' : 'paused', key);
      } catch (err) {
        logger.warn({ err }, 'Send typing presence error');
      }
      return { success: true };
    },

    async markConversationRead(sessionId, jid) {
      const session = this._requireConnectedSession(sessionId);
      const { chats, messagesByChat } = this._storeOf(session);
      const key = resolveJidKey(this._storeOf(session), jid);
      const isGroup = key.includes('@g.us');
      // Faz 13: okundu bilgisi WhatsApp'a ILETILEMEZSE basari DONMEYIZ — aksi
      // halde karsi taraf mesaji "okunmadi" gorurken UI "okundu" gosterir.
      let gatewayOk = true;
      let gatewayError = null;
      try {
        const list = messagesByChat.get(key) || [];
        const inbound = list.filter((m) => m.direction === 'INBOUND' && m.wa_message_id);
        if (isGroup) {
          // Grup okundu çentikleri mesaj anahtarı gerektirir: en yeni okunmuş
          // inbound mesajların anahtarlarını gönder (Baileys participant'a
          // key.participant üzerinden karar verir).
          const keys = inbound.slice(-5).map((m) => ({
            remoteJid: key,
            id: m.wa_message_id,
            fromMe: false,
            participant: m.participant_jid || undefined,
          }));
          if (keys.length) {
            await session.sock.readMessages(keys);
          } else {
            await session.sock.readMessages([{ remoteJid: key, id: undefined, fromMe: false }]);
          }
        } else {
          const newest = inbound[inbound.length - 1];
          await session.sock.readMessages([{ remoteJid: key, id: newest?.wa_message_id, fromMe: false }]);
        }
      } catch (err) {
        gatewayOk = false;
        gatewayError = err?.message || String(err);
        logger.warn({ err }, 'Mark read error');
      }
      const chat = chats.get(key);
      if (chat) chat.unread_count = 0;
      emitEvent({
        event: 'conversation_read',
        conversation_id: key,
        unread_count: 0,
        gateway_session_id: session.id,
      });
      return gatewayOk ? { success: true } : { success: false, error: gatewayError };
    },

    // -----------------------------------------------------------------------
    // Media
    // -----------------------------------------------------------------------
    // Medya yalnızca onu indiren oturuma servis edilir: `media_id` tahmin
    // edilemez bir UUID olsa da, sahiplik kontrolü olmadan bir kiracının
    // medya kimliğini ele geçiren başka bir kiracı dosyayı çekebilirdi.
    getMediaPath(sessionId, mediaId) {
      const entry = mediaIndex.get(mediaId);
      if (!entry) return null;
      if (!sessionId || entry.sessionId !== String(sessionId)) return null;
      return entry.filePath || null;
    },

    async storeIncomingMedia(session, waMessage, sock) {
      try {
        // Sorun (Render log: `Failed to store incoming media | err=No message
        // present`, 5 kez): `downloadMediaMessage` TAM WAMessage bekler —
        // icindeki `message.message` alanini `extractMessageContent` ile
        // kendisi acar (viewOnce / ephemeral / documentWithCaption
        // sarmalayicilari dahil). Once buraya IC medya dugumu
        // (`msg.message.imageMessage`) veriliyordu; o zaman `message.message`
        // undefined kaliyor ve Baileys HER seferinde
        // Boom('No message present') firlatiyordu — medya hic kaydedilmiyordu.
        const resolved = resolveDownloadableMedia(waMessage?.message);
        if (!resolved) {
          // Indirilebilir medya yok: sarmalayici acilamadi ya da mesaj sifresi
          // cozulemedi (pkmsg / senderKeyDistributionMessage). Beklenen durum —
          // sessizce YUTULMAZ, nedeni debug seviyesinde loglanir ve cagirana
          // `null` doner (sahte medya uretilmez, AGENTS.md §1.1).
          logger.debug(
            { waMessageId: waMessage?.key?.id },
            'Medya indirilmedi: indirilebilir icerik bulunamadi'
          );
          return null;
        }
        const { media } = resolved;
        const buffer = await downloadMediaMessage(waMessage, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
        if (!buffer) return null;
        const mediaId = uuidv4();
        const mimeType = media.mimetype || 'application/octet-stream';
        const ext = (mimeType.split('/')[1] || 'bin').split(';')[0];
        const filename = media.fileName || `media_${mediaId}.${ext}`;
        const filePath = path.join(mediaDir, `${mediaId}.${ext}`);
        fs.writeFileSync(filePath, buffer);
        mediaIndex.set(mediaId, {
          sessionId: String(session?.id || ''),
          filePath,
          mimeType,
          filename,
          sizeBytes: buffer.length,
        });
        return { media_id: mediaId, mime_type: mimeType, filename, size_bytes: buffer.length };
      } catch (err) {
        logger.warn({ err }, 'Failed to store incoming media');
        return null;
      }
    },

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------
    // Oturum çözümleme (güvenlik düzeltmesi): her veri/gönderim çağrısı HANGİ
    // oturuma ait olduğunu AÇIKÇA söyler. Önceki `_getConnectedSession()` /
    // `_assertUnambiguousScope()` çifti "tek bağlı oturumu seç" davranışıyla
    // çağıranın kimliğini hiç sormuyordu; bu yüzden bir kiracının isteği
    // bağlı olan TEK hattın (başka bir kiracıya ait olsa bile) verisini okuyup
    // o hattan mesaj gönderebiliyordu. Artık kimlik zorunludur ve store'lar
    // oturuma ait olduğu için karışma fiziksel olarak mümkün değildir.
    _requireSession(sessionId) {
      if (!sessionId) throw new Error('session_id is required');
      const session = sessions.get(String(sessionId));
      if (!session) throw new Error('Session not found');
      return session;
    },

    _requireConnectedSession(sessionId) {
      const session = this._requireSession(sessionId);
      if (session.status !== 'CONNECTED' || !session.sock) {
        throw new Error(
          'Bu WhatsApp oturumu bagli degil. Lutfen once QR ile eslestirin.'
        );
      }
      return session;
    },

    /** Oturum nesnesi ya da id kabul eder — iç çağrılar nesne, testler id verir. */
    _sess(sessionOrId) {
      if (sessionOrId && typeof sessionOrId === 'object') return sessionOrId;
      return this._requireSession(sessionOrId);
    },

    /** Oturumun bellek deposu (yoksa tembel oluşturulur). */
    _storeOf(sessionOrId) {
      const session = this._sess(sessionOrId);
      if (!session.store) session.store = createSessionStore();
      return session.store;
    },

    // Faz 10 (P3): messages.upsert olayini (gelen + telefondan gonderilen)
    // kalici gateway kaydina cevirir, messagesByChat'e ekler, sohbeti tazeler
    // ve `message_new` yayar. Test edilebilirlik icin handler'dan ayrildi.
    // Doner: kaydedilen record; atlanirsa null.
    async _ingestUpsertMessage(msg, sock, sessionId) {
      // Faz 13: bu mesaj belirli bir oturumun soketinden geldi — olaylar
      // `gateway_session_id` tasimali ki backend sahibi TAHMIN ETMESIN.
      // Oturum kimligi artik ZORUNLU: mesaj o hesabin deposuna yazilir.
      const session = this._requireSession(sessionId);
      const store = this._storeOf(session);
      const { contacts, chats, messagesByChat } = store;
      const normalizeJid = (jid) => resolveJidKey(store, jid);
      const emitEvent = (event) => sessionManager._emit({ gateway_session_id: sessionId, ...event });
      // Faz 10 (P3): telefondan (gateway API'si DIŞINDAN) gonderilen mesajlar
      // de messages.upsert ile fromMe=true olarak gelir. Eskiden bunlar
      // `continue` ile atiliyordu → "Sg" gibi kullanıcının kendi gonderdigi
      // son mesajlar DB'ye hic yazilmiyordu (yalnizca chats.update preview'i
      // guncellerdi, mesaj satiri/sayisi olusmazdi). Artik islenir; gateway
      // API'siyle gonderilenler _recordOutbound tarafindan zaten kaydedildigi
      // icin wa_message_id ile dedup edilir → cift kayit olmaz.
      const fromMe = Boolean(msg.key?.fromMe);
      const jid = msg.key?.remoteJid;
      if (!jid) return null;
      // Sorun (prod): `status@broadcast` (Durum/Hikaye) ve `@newsletter`
      // (kanal) mesajlari sohbet listesine sohbet olarak dusuyordu.
      // WhatsApp Web paritesi: bu JID'ler sohbet akisinda YER ALMAZ.
      if (isBroadcastOnlyJid(jid)) return null;
      // Faz 6e: LID döneminde anahtar senderLid/senderPn çifti taşıyabilir
      // — eşleşmeyi kalıcı olarak öğren (remoteJid @lid ise sohbet de
      // normalizeJid ile telefona çözülür).
      if (msg.key?.senderLid && msg.key?.senderPn) {
        this._applyLidMapping(session, msg.key.senderLid, msg.key.senderPn);
      }
      if (msg.key?.participantLid && msg.key?.participantPn) {
        this._applyLidMapping(session, msg.key.participantLid, msg.key.participantPn);
      }
      const key = normalizeJid(jid);
      if (isBroadcastOnlyJid(key)) return null;
      // Gateway API'siyle (sendTextMessage/sendMediaMessage) gonderilen
      // mesaj _recordOutbound ile zaten messagesByChat'e eklendi; Baileys
      // ayni mesaji fromMe upsert ile tekrar yayinladiginda atla.
      if (fromMe && msg.key?.id) {
        const dup = (messagesByChat.get(key) || []).some(
          (m) => m.wa_message_id && m.wa_message_id === msg.key.id
        );
        if (dup) return null;
      }
      // Eşleşmesi bilinmeyen LID: mesajı bellekte beklet, backend'e yayma
      // (hayalet `jid:@lid` sohbeti oluşmasın) — _applyLidMapping öğrendiğinde
      // telefon kimliğiyle yayına verilir.
      const lidHold = isLidJid(key);
      // Sorun (Render log: `No session record` / `Bad MAC`): ham proto govdeyi
      // sinirli depoda tut — Baileys sifre cozumleme basarisizliginda
      // `getMessage` uzerinden buradan okuyup gonderen taraftan yeniden
      // gonderim ister. Boylece mesaj kalici olarak kaybolmaz.
      if (msg.key?.id && msg.message) {
        rememberRawMessage(store, key, msg.key.id, msg.message);
      }
      const contact = contacts.get(key);
      const isGroup = jid.includes('@g.us');
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || msg.message?.documentMessage?.caption || '';
      // Sorun 3: tip cozumlemesi tek paylasilan fonksiyondan (canli akista
      // alintili/iletilmis/link mesajlar extendedTextMessage → TEXT).
      const mediaType = classifyMessageType(msg.message);
      let mediaInfo = null;
      if (!fromMe && mediaType !== 'TEXT' && mediaType !== 'LOCATION' && mediaType !== 'CONTACT' && typeof this.storeIncomingMedia === 'function' && sock) {
        // Sorun: burada IC medya dugumu (`msg.message.imageMessage`) gecilirdi;
        // `downloadMediaMessage` TAM WAMessage bekledigi icin her cagri
        // Boom('No message present') ile dusuyordu. Tam mesaj gecilir —
        // sarmalayici cozumu (viewOnce/ephemeral/documentWithCaption) ve
        // "medya yok" karari artik `storeIncomingMedia` icinde verilir.
        mediaInfo = await this.storeIncomingMedia(session, msg, sock);
      }
      const record = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        conversation_id: key,
        direction: fromMe ? 'OUTBOUND' : 'INBOUND',
        message_type: mediaType,
        status: fromMe ? 'SENT' : 'RECEIVED',
        body: text || '',
        media_id: mediaInfo?.media_id || null,
        media_mime_type: mediaInfo?.mime_type || null,
        media_filename: mediaInfo?.filename || null,
        media_caption: text || null,
        wa_message_id: msg.key?.id || null,
        sender_phone: fromMe ? 'ME' : (jidToPhone(key) || key),
        recipient_phone: fromMe ? (jidToPhone(key) || key) : 'ME',
        // Faz 8 (§13): başlık kimliği de Contact çözücüsünden geçer —
        // rehber adı > pushName > telefon; ham JID ad olarak yayılmaz.
        // Faz 10 (P3): telefondan gonderilen mesajin gondereni 'ME'dir.
        sender_name: fromMe ? 'ME' : sessionManager._resolveDisplayName(session, key, msg.pushName),
        sender_name_source: fromMe ? null : (contact?.name_source || null),
        participant_jid: msg.key?.participant || null,
        // Faz 8 (§13-14): grup göndereni Contact çözücüsünden geçer —
        // rehber/çözümlemedeki ad > pushName > telefon; ham JID asla ad olmaz.
        participant_name: isGroup ? sessionManager._resolveDisplayName(session, msg.key?.participant, msg.pushName) : null,
        created_at: new Date((msg.messageTimestamp || Date.now()) * 1000).toISOString(),
      };
      if (!messagesByChat.has(key)) messagesByChat.set(key, []);
      messagesByChat.get(key).push(record);
      // Faz 10 (P2): paylasilan kural — "[IMAGE]" yerine tip etiketi,
      // gruplarda cozulmus gonderen on eki ("Ahmet: ...").
      this._touchChat(session, key, buildChatPreview(record, isGroup), record.created_at);
      // Update unread count (yalnizca GELEN mesajlar okunmamis sayilir)
      const chat = chats.get(key);
      if (chat && !fromMe) chat.unread_count = (chat.unread_count || 0) + 1;
      if (!lidHold) {
        emitEvent({
          event: 'message_new',
          conversation_id: key,
          message: record,
        });
      }
      return record;
    },

    _recordOutbound(jid, data, sessionId) {
      // Faz 13: gonderim belirli bir oturumun soketinden yapildi — olay
      // `gateway_session_id` tasir, backend sahibi tahmin etmez. Oturum
      // kimligi ZORUNLU: kayit o hesabin deposuna yazilir.
      const session = this._requireSession(sessionId);
      const store = this._storeOf(session);
      const { messagesByChat } = store;
      const emitEvent = (event) => sessionManager._emit({ gateway_session_id: session.id, ...event });
      const key = resolveJidKey(store, jid);
      // Faz 10 (P3): messages.upsert fromMe kolu ayni mesaji (wa_message_id)
      // zaten kaydettiyse ikinci kayit + ikinci emitEvent YAPILMAZ.
      if (data.wa_message_id) {
        const dup = (messagesByChat.get(key) || []).some(
          (m) => m.wa_message_id && m.wa_message_id === data.wa_message_id
        );
        if (dup) return { ...messagesByChat.get(key).find((m) => m.wa_message_id === data.wa_message_id) };
      }
      const msg = {
        id: Date.now(),
        conversation_id: key,
        direction: 'OUTBOUND',
        message_type: data.message_type || 'TEXT',
        status: data.status || 'SENT',
        body: data.body || '',
        media_url: data.media_url,
        media_filename: data.media_filename,
        media_caption: data.media_caption,
        wa_message_id: data.wa_message_id,
        client_message_id: data.client_message_id,
        sender_phone: 'ME',
        recipient_phone: jidToPhone(key) || key,
        created_at: new Date().toISOString(),
      };
      if (!messagesByChat.has(key)) messagesByChat.set(key, []);
      messagesByChat.get(key).push(msg);
      // Faz 10 (P2): govde bos olsa bile (medya) paylasilan kural tip etiketini uretir.
      this._touchChat(session, key, buildChatPreview(msg, key.includes('@g.us')), msg.created_at);
      emitEvent({
        event: 'message_new',
        conversation_id: key,
        message: msg,
      });
      return { ...msg };
    },

    // Faz 6e: yeni bir LID ↔ telefon eşleşmesi öğrenildiğinde, LID anahtarı
    // altında bekletilen kişi/sohbet/mesaj kayıtlarını telefon anahtarına
    // taşır ve sidebar'ı rehber adıyla tazeler. mapping değişmediyse no-op.
    _applyLidMapping(session, lid, phoneJid) {
      session = this._sess(session);
      const store = this._storeOf(session);
      const { contacts, chats, messagesByChat } = store;
      // Bu olaylar da `gateway_session_id` taşır: aksi halde backend sahibi
      // çözemeyip olayı düşürüyordu (grup adları/LID taşımaları kaybolurdu).
      const emitEvent = (event) => sessionManager._emit({ gateway_session_id: session.id, ...event });
      if (!rememberLidPair(store, lid, phoneJid)) return;
      const lidKey = asLid(lid);
      const phoneKey = asPn(phoneJid);
      // 1. Bekleyen LID kişisini telefona taşı (mergeContactName önceliği korur).
      const pending = contacts.get(lidKey);
      if (pending) {
        contacts.delete(lidKey);
        const merged = mergeContactName(contacts.get(phoneKey) || {}, pending.name, pending.name_source || 'addressbook');
        const avatarMerged = {
          ...merged,
          avatar_url: merged.avatar_url || pending.avatar_url || null,
          lid: lidKey,
        };
        contacts.set(phoneKey, {
          ...avatarMerged,
          id: phoneKey,
          jid: phoneKey,
          name: avatarMerged.name || jidToPhone(phoneKey) || phoneKey,
          phone: jidToPhone(phoneKey) || '',
          updated_at: new Date().toISOString(),
        });
        delete contacts.get(phoneKey).lid_pending;
        emitEvent({ event: 'contact_synced', contact: contacts.get(phoneKey) });
      }
      // 2. LID anahtarlı sohbet varsa telefona taşı / başlığı güncelle.
      const lidChat = chats.get(lidKey);
      if (lidChat) {
        chats.delete(lidKey);
        const contact = contacts.get(phoneKey);
        // LID sohbetinin gerçek alanları (app-state arşiv/bastırma, son mesaj)
        // telefon stub'ını ezsın; id/jid/phone telefon kimliğine sabitlenir.
        const existingPhone = chats.get(phoneKey) || {};
        // LID-stub sohbetinin adı ham LID jid'si olabilir ("xxx@lid") — onu
        // asla görüntülenen ad yapma; contact > mevcut telefon adı > telefon.
        const lidChatName = lidChat.name && !isLidJid(lidChat.name) ? lidChat.name : null;
        const phoneChatName = existingPhone.name && !isLidJid(existingPhone.name) ? existingPhone.name : null;
        const mergedChat = {
          ...existingPhone,
          ...lidChat,
          id: phoneKey,
          jid: phoneKey,
          name: contact?.name || phoneChatName || lidChatName || jidToPhone(phoneKey) || phoneKey,
          name_source: contact?.name_source || existingPhone.name_source || lidChat.name_source || null,
          phone: jidToPhone(phoneKey) || '',
          is_group: false,
          updated_at: new Date().toISOString(),
        };
        chats.set(phoneKey, mergedChat);
        emitEvent({ event: 'conversation_updated', conversation: { ...mergedChat } });
      } else if (pending) {
        // Sohbet zaten telefon anahtarında — rehber adını öncelik sırasıyla uygula.
        const chat = chats.get(phoneKey);
        if (chat) {
          const base = { name: isLidJid(chat.name) ? undefined : chat.name, name_source: chat.name_source };
          const picked = mergeContactName(base, pending.name, pending.name_source || 'addressbook');
          if (picked.name && picked.name !== chat.name) {
            chat.name = picked.name;
            chat.name_source = picked.name_source || null;
            chat.updated_at = new Date().toISOString();
            emitEvent({ event: 'conversation_updated', conversation: { ...chat } });
          }
        }
      }
      // 3. LID anahtarlı mesaj geçmişi varsa telefona taşı (sıra korunur).
      // Bekletilen (yayınlanmamış) mesajlar artık telefon kimliğiyle yayına girer.
      const lidMsgs = messagesByChat.get(lidKey);
      if (lidMsgs) {
        messagesByChat.delete(lidKey);
        const phoneMsgs = messagesByChat.get(phoneKey) || [];
        const seen = new Set(phoneMsgs.map((m) => m.wa_message_id).filter(Boolean));
        const phoneStr = jidToPhone(phoneKey) || phoneKey;
        const migratedContact = contacts.get(phoneKey);
        for (const m of lidMsgs) {
          if (m.wa_message_id && seen.has(m.wa_message_id)) continue;
          m.conversation_id = phoneKey;
          // LID kimliğiyle yazılmış alanları telefon kimliğine çevir.
          if (typeof m.sender_phone === 'string' && m.sender_phone.endsWith('@lid')) m.sender_phone = phoneStr;
          if (typeof m.recipient_phone === 'string' && m.recipient_phone.endsWith('@lid')) m.recipient_phone = phoneStr;
          if (typeof m.sender_name === 'string' && m.sender_name.endsWith('@lid')) {
            m.sender_name = migratedContact?.name || phoneStr;
            m.sender_name_source = migratedContact?.name_source || m.sender_name_source || null;
          }
          phoneMsgs.push(m);
          emitEvent({ event: 'message_new', conversation_id: phoneKey, message: m });
        }
        phoneMsgs.sort((a, b) => (a.id || 0) - (b.id || 0));
        if (phoneMsgs.length > 500) phoneMsgs.splice(0, phoneMsgs.length - 500);
        messagesByChat.set(phoneKey, phoneMsgs);
      }
      logger.debug({ lid: lidKey, jid: phoneKey }, 'LID→telefon eşleşmesi uygulandı');
    },

    _touchChat(session, jid, preview, timestamp) {
      session = this._sess(session);
      const store = this._storeOf(session);
      const { chats, contacts } = store;
      const key = resolveJidKey(store, jid);
      const existing = chats.get(key) || {};
      const contact = contacts.get(key);
      const newTs = timestamp || new Date().toISOString();
      // Faz 10 (P2): zaman-damgali kural — daha eski mesajin ozeti daha yeni
      // olanin uzerine yazilmaz (retry/duplicate-safe). Bos preview mevcut
      // ozeti silmez.
      const tsOlder = existing.last_message_at && String(newTs) < String(existing.last_message_at);
      const nextPreview = preview && !tsOlder ? preview : existing.last_message_preview || '';
      const nextTs = tsOlder ? existing.last_message_at : newTs;
      chats.set(key, {
        ...existing,
        id: key,
        jid: key,
        name: contact?.name || existing.name || jidToPhone(key) || key,
        name_source: contact?.name_source || existing.name_source || null,
        phone: jidToPhone(key) || existing.phone || '',
        is_group: key.includes('@g.us'),
        // Sorun 4: arsiv durumu sohbet kaydinda tasinir (touch arsivlemez —
        // mevcut deger korunur; arsiv degisikligi chats.update ile gelir).
        archived: existing.archived ?? false,
        last_message_at: nextTs,
        last_message_preview: nextPreview,
        unread_count: existing.unread_count || 0,
        created_at: existing.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      // Faz 5: sohbetin profil/grup resmi henüz yoksa arka planda çek.
      if (!chats.get(key)?.avatar_url) void this._ensureChatAvatar(session, key);
    },

    // Faz 5: profil (veya grup) resmini Baileys'ten tembel tembel çekip
    // sohbet ve kişi kayıtlarına yazar; conversation_updated olayı yayınlar.
    // Resmi olmayan kişilerde profilePictureUrl hata fırlatır — sessizce geçilir
    // ve 10 dk boyunca yeniden denenmez (retry storm yok).
    async _ensureChatAvatar(session, key) {
      if (!session) return;
      session = this._sess(session);
      const store = this._storeOf(session);
      const { chats, contacts, avatarFetchInFlight, avatarFetchAttemptedAt } = store;
      if (avatarFetchInFlight.has(key)) return;
      const lastAttempt = avatarFetchAttemptedAt.get(key) || 0;
      if (Date.now() - lastAttempt < 10 * 60 * 1000) return;
      // Avatar, sohbetin ait olduğu oturumun soketinden çekilir — "bağlı olan
      // tek oturumu seç" tahmini yok. Oturum bağlı değilse sessizce atlanır
      // (normal durum: QR bekleniyor).
      if (session.status !== 'CONNECTED' || !session.sock) return;
      avatarFetchInFlight.add(key);
      avatarFetchAttemptedAt.set(key, Date.now());
      try {
        const url = await session.sock.profilePictureUrl(key, 'preview');
        if (url) {
          const chat = chats.get(key);
          if (chat && chat.avatar_url !== url) {
            chat.avatar_url = url;
            chat.updated_at = new Date().toISOString();
            emitEvent({ event: 'conversation_updated', conversation: { ...chat }, gateway_session_id: session.id });
          }
          const contact = contacts.get(key);
          if (contact && contact.avatar_url !== url) {
            contact.avatar_url = url;
            contact.updated_at = new Date().toISOString();
            emitEvent({ event: 'contact_synced', contact: { ...contact }, gateway_session_id: session.id });
          }
        }
      } catch {
        // Resim yok/erişilemiyor — normal durum, sessiz geç.
      } finally {
        store.avatarFetchInFlight.delete(key);
      }
    },

    // Faz 8: grup başlıklarını (subject) tek istekte çöz — Baileys
    // `groupFetchAllParticipating()` tüm katılımcı grupların metadata'sını
    // döner (groups.js:22). Sohbet başına groupMetadata() çağırma (N+1 /
    // request storm, AGENTS.md §20) YOK; oturum başına 10 dk TTL'lik tek
    // toplu istek + in-flight koruması. Çözülen subject, chats/contacts
    // kayıtlarına `group_subject` rütbesiyle yazılır ve conversation_updated
    // olarak yayınlanır (gerçek zamanlı yeniden adlandırma ayrıca groups.update
    // olayıyla gelir).
    // Faz 9 (RC-1): toplu çağrı sunucu tarafında dönmeyen gruplar için
    // yalnızca ÇÖZÜLEMEMİŞ @g.us sohbetleri başına hedefli `groupMetadata()`
    // fallback'i eklenir (sınırlı: en fazla 10 grup, 500 ms arayla — request
    // storm değil). Böylece `120363xxx@g.us` gibi isimsiz gruplar da gerçek
    // başlığına kavuşur; çözülemeyenler UI'da terminal "Grup" fallback'i görür.
    async _ensureGroupSubjects({ sessionId, force = false } = {}) {
      // Grup başlıkları SADECE kendi oturumunun sohbetlerine yazılır. (Eski
      // sürüm global haritalara yazdığı için birden fazla hat bağlıyken
      // `ambiguous_scope` ile tamamen reddediliyordu; artık kapsam net.)
      // Fire-and-forget çağrılar (`void ...`) olduğu için fırlatmak yerine
      // sonuç döndürülür — unhandled rejection yaratmaz.
      const session = sessionId ? sessions.get(String(sessionId)) : null;
      if (!session) return { applied: false, reason: 'no_session' };
      if (session.status !== 'CONNECTED' || !session.sock) {
        return { applied: false, reason: 'no_session' };
      }
      const store = this._storeOf(session);
      const { chats, contacts } = store;
      // Faz 13 + düzeltme: bu olaylar `gateway_session_id` TAŞIR. Önceden
      // modül seviyesindeki `emitEvent` kullanılıyordu; olay sahipsiz kaldığı
      // için backend `EventOwnerUnresolved` ile düşürüyordu ve çözülen grup
      // adları hiçbir zaman kalıcılaşmıyordu ("Grup" olarak kalıyordu).
      const emitEvent = (event) => sessionManager._emit({ gateway_session_id: session.id, ...event });
      const last = session._groupSubjectsAt || 0;
      if (!force && Date.now() - last < 10 * 60 * 1000) return { applied: false, reason: 'throttled' };
      if (session._groupSubjectsInFlight) return { applied: false, reason: 'in_flight' };
      session._groupSubjectsInFlight = true;
      session._groupSubjectsAt = Date.now();
      const applySubject = (jid, subject) => {
        const key = resolveJidKey(store, jid);
        const chat = chats.get(key);
        const contact = contacts.get(key);
        const rankCur = NAME_RANK[chat?.name_source] || 0;
        if (chat && (NAME_RANK.group_subject > rankCur || isRawIdentityName(chat.name))) {
          const merged = mergeContactName({ name: chat.name, name_source: chat.name_source }, subject, 'group_subject');
          if (merged.name && merged.name !== chat.name) {
            chat.name = merged.name;
            chat.name_source = merged.name_source;
            chat.updated_at = new Date().toISOString();
            emitEvent({ event: 'conversation_updated', conversation: { ...chat } });
          }
        }
        if (contact) {
          const mergedC = mergeContactName({ name: contact.name, name_source: contact.name_source }, subject, 'group_subject');
          if (mergedC.name && mergedC.name !== contact.name) {
            contact.name = mergedC.name;
            contact.name_source = mergedC.name_source;
            contact.updated_at = new Date().toISOString();
            emitEvent({ event: 'contact_synced', contact: { ...contact } });
          }
        }
      };
      const resolvedKeys = new Set();
      try {
        const all = await session.sock.groupFetchAllParticipating();
        for (const meta of Object.values(all || {})) {
          const jid = meta?.id;
          const subject = typeof meta?.subject === 'string' ? meta.subject.trim() : '';
          if (!jid || !jid.includes('@g.us') || !subject) continue;
          resolvedKeys.add(resolveJidKey(store, jid));
          applySubject(jid, subject);
        }
      } catch (err) {
        // Grup metadata alınamadı (kısıt/timeout) — sonraki tetiklemede tekrar denenir.
        session._groupSubjectsAt = 0;
        logger.warn({ err }, 'groupFetchAllParticipating failed');
      }
      // Faz 9 (RC-1): toplu çağrının döndürmediği çözülmemiş gruplar için
      // hedefli groupMetadata() fallback — sınırlı sayıda, kısa arayla.
      try {
        const unresolved = [...chats.values()].filter(
          (c) => c.jid && c.jid.includes('@g.us') && !resolvedKeys.has(resolveJidKey(store, c.jid)) && (isRawIdentityName(c.name) || !c.name)
        ).slice(0, 10);
        for (const chat of unresolved) {
          if (session._groupSubjectsInFlight === 'cancelled') break;
          try {
            const meta = await session.sock.groupMetadata(chat.jid);
            const subject = typeof meta?.subject === 'string' ? meta.subject.trim() : '';
            if (subject) applySubject(meta.id || chat.jid, subject);
          } catch { /* grup kısıtlı/terk edilmiş — sessiz geç, UI fallback gösterir */ }
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (err) {
        logger.warn({ err }, 'targeted groupMetadata fallback failed');
      } finally {
        session._groupSubjectsInFlight = false;
      }
      return { applied: true, reason: null };
    },

    // Faz 8: bir JID için görüntülenecek adı çözer — contacts Map (rehber >
    // group subject > verified > history > push) → telefon → null. Ham jid/lid
    // ASLA ad olarak dönmez (§3: frontend/ad üretmez, backend çözümlü ad görür).
    _resolveDisplayName(session, jid, fallbackPushName) {
      session = this._sess(session);
      const store = this._storeOf(session);
      const key = resolveJidKey(store, jid);
      const contact = key ? store.contacts.get(key) : null;
      if (contact?.name && !isRawIdentityName(contact.name)) return contact.name;
      if (fallbackPushName && !isRawIdentityName(fallbackPushName)) return fallbackPushName;
      const phone = jidToPhone(key);
      return phone || null;
    },

    // History sync mesajlarini (WAMessage) gateway Message kaydina cevirir.
    // Medya indirmesi yapilmaz (gizemli/sifreli history medyasi): tip + caption
    // kaydedilir, media_id bos kalir.
    _historyMessageToRecord(session, msg, key) {
      session = this._sess(session);
      const content = msg.message || {};
      const text =
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        content.documentMessage?.caption ||
        '';
      const mediaType = classifyMessageType(content); // Sorun 3: tek paylasilan kural
      if (!hasRecognizedContent(content) && !text) return null; // stub/unsupported message — skip
      const ts = Number(msg.messageTimestamp) * 1000;
      return {
        id: Number.isFinite(ts) ? ts : Date.now(),
        timestamp_s: Number(msg.messageTimestamp) || null,
        conversation_id: key,
        direction: msg.key?.fromMe ? 'OUTBOUND' : 'INBOUND',
        message_type: mediaType || 'TEXT',
        status: msg.key?.fromMe ? 'SENT' : 'RECEIVED',
        body: text || '',
        media_id: null,
        media_mime_type: null,
        media_filename: content.documentMessage?.fileName || null,
        media_caption: text || null,
        wa_message_id: msg.key?.id || null,
        sender_phone: msg.key?.fromMe ? 'ME' : (jidToPhone(msg.key?.participant || key) || key),
        recipient_phone: msg.key?.fromMe ? (jidToPhone(key) || key) : 'ME',
        // Faz 8: tarih mesajlarında da ad, Contact çözücüsünden geçer
        // (rehber > pushName > telefon); ham JID/LID ad olarak yazılmaz.
        sender_name: msg.key?.fromMe ? 'ME' : (sessionManager._resolveDisplayName(session, msg.key?.participant || key, msg.pushName) || null),
        participant_jid: msg.key?.participant || null,
        participant_name: msg.key?.participant ? sessionManager._resolveDisplayName(session, msg.key.participant, msg.pushName) : null,
        created_at: new Date(Number.isFinite(ts) ? ts : Date.now()).toISOString(),
      };
    },

    _startSocket(id) {
      const session = sessions.get(id);
      if (!session) return;
      this._connectSocket(id).catch((error) => {
        const current = sessions.get(id);
        if (!current || current._deleted) return;
        current.status = 'UNAVAILABLE';
        current.is_phone_online = false;
        current.error_message = 'WHATSAPP_AUTH_STORE_UNAVAILABLE';
        current.updated_at = new Date().toISOString();
        diagnostic('socket_start_failed', {
          session_ref: sessionRef(id),
          generation: current._diagnosticSocketGeneration || 0,
          error_name: error?.name || 'Error',
          error_code: error?.code || null,
        });
        logger.error({ err: error, session_ref: sessionRef(id) }, 'WhatsApp socket start failed');
      });
    },

    async _connectSocket(id) {
      const session = sessions.get(id);
      if (!session) return;
      const generation = session.lifecycle.beginAttempt();
      session._diagnosticSocketGeneration = generation;
      clearLeaseTimers(session);
      if (leaseRepository) {
        const acquired = await leaseRepository.acquire(id, instanceId, generation);
        if (!acquired) {
          session.status = 'RESTORING';
          session.is_phone_online = false;
          session.error_message = 'WHATSAPP_SESSION_OWNED_BY_ANOTHER_INSTANCE';
          diagnostic('socket_lease_contended', {
            session_ref: sessionRef(id), generation,
          });
          session._leaseRetryTimer = setTimeout(() => {
            session._leaseRetryTimer = null;
            if (!session._deleted && !session._shuttingDown) this._startSocket(id);
          }, 5000 + Math.floor(Math.random() * 1000));
          return;
        }
        diagnostic('socket_lease_acquired', {
          session_ref: sessionRef(id), generation,
        });
        session._leaseValidUntil = Date.now() + leaseRepository.ttlSeconds * 1000;
      }
      const sessionDir = getSessionDir(sessionsDir, id);
      fs.mkdirSync(sessionDir, { recursive: true });

      const authFilesBefore = fs.readdirSync(sessionDir).filter((name) => name.endsWith('.json'));
      diagnostic('socket_connect_started', {
        session_ref: sessionRef(id),
        generation,
        previous_socket_present: Boolean(session.sock),
        auth_json_files: authFilesBefore.length,
      });

      // Production uses the durable PostgreSQL adapter. The file adapter is
      // retained only for explicit local development compatibility.
      const persisted = authRepository
        ? null
        : safeReadEncrypted(path.join(sessionDir, 'auth.json'), aesKey);
      const { state, saveCreds } = authRepository
        ? await authRepository.createAuthState(id)
        : await useMultiFileAuthState(sessionDir);
      diagnostic('auth_state_loaded', {
        session_ref: sessionRef(id),
        generation,
        encrypted_snapshot_present: Boolean(persisted),
        creds_file_present: authFilesBefore.includes('creds.json'),
        signal_key_files: authFilesBefore.filter((name) => !['auth.json', 'creds.json', 'keys.json'].includes(name)).length,
        registered: Boolean(state?.creds?.registered),
        key_store_get: typeof state?.keys?.get === 'function',
        key_store_set: typeof state?.keys?.set === 'function',
      });

      // If we have persisted creds, restore them
      if (!authRepository && persisted?.creds) {
        if (!session._diagnosticLegacyRestoreLogged) {
          session._diagnosticLegacyRestoreLogged = true;
          diagnostic('legacy_auth_restore_after_state_load', {
            session_ref: sessionRef(id),
            generation,
            snapshot_keys_type: typeof persisted.keys,
          });
        }
        try {
          // Rebuild the auth state from the encrypted snapshot
          const restored = {
            creds: persisted.creds,
            keys: persisted.keys || {},
          };
          // useMultiFileAuthState reads from disk; we write the restored state back
          fs.writeFileSync(path.join(sessionDir, 'creds.json'), JSON.stringify(restored.creds));
          fs.writeFileSync(path.join(sessionDir, 'keys.json'), JSON.stringify(restored.keys));
        } catch (err) {
          logger.warn({ err }, 'Failed to restore session state');
        }
      }

      // Oturum bazli bellek baglami. Asagidaki tum `sock.ev.on(...)`
      // isleyicileri bu YEREL adlari kullanir; boylece kisiler/sohbetler/
      // mesajlar yalnizca BU hesabin deposuna yazilir. (Eski surumde ayni
      // adlar modul seviyesinde global'di ve iki hat ayni haritayi
      // paylasiyordu.) Yerel tanimlar, disaridaki yardimcilarin oturum
      // gerektiren imzalarini da golgeleyerek isleyici govdelerini
      // degistirmeden calismalarini saglar.
      const store = sessionManager._storeOf(session);
      const { contacts, chats, messagesByChat } = store;
      const normalizeJid = (jid) => resolveJidKey(store, jid);
      const rememberRaw = (jid, msgId, message) => rememberRawMessage(store, jid, msgId, message);
      const applyLidMapping = (lid, phoneJid) => sessionManager._applyLidMapping(session, lid, phoneJid);
      const resolveDisplayName = (jid, pushName) => sessionManager._resolveDisplayName(session, jid, pushName);
      const historyMessageToRecord = (msg, key) => sessionManager._historyMessageToRecord(session, msg, key);
      const ensureChatAvatar = (key) => sessionManager._ensureChatAvatar(session, key);
      const ensureGroupSubjects = (opts = {}) => sessionManager._ensureGroupSubjects({ ...opts, sessionId: id });

      const { version } = await fetchLatestBaileysVersion();
      const baileysAuth = authRepository
        ? { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) }
        : state;
      const sock = makeWASocket({
        version,
        logger: createBaileysLogger(logger),
        browser: Browsers.macOS('Desktop'),
        auth: baileysAuth,
        markOnlineOnConnect: true,
        // Sorun 1 (senkron hizi): TAM gecmis senkronu KAPALI.
        //  - `syncFullHistory: false`: binlerce mesajlik sohbet gecmisini
        //    bastan indirmeye calismaz. ACIK birakildiginda WhatsApp
        //    registration payload'ini reddedip statusCode=428 ile baglantiyi
        //    kiriyor (QR hic olusmuyor) — bu yuzden hem varsayilan hem burada
        //    ACIKCA false. Gecmis, lazy hydration ile parca parca gelir
        //    (asagidaki `shouldSyncHistoryMessage` + `messaging-history.set`).
        //  - `generateHighQualityLinkPreviews: false`: her link mesaji icin
        //    ekstra medya indirme/onizleme uretimi yapmaz — ilk senkronu ve
        //    bant genisligini sisiren ikinci buyuk maliyet kalemi.
        syncFullHistory: false,
        generateHighQualityLinkPreviews: false,
        // NOT: syncFullHistory: true WhatsApp tarafından statusCode=428 ile
        // bağlantı kırılarak reddediliyor (QR hiç oluşmuyor) — registration
        // payload'ını (requireFullSync) DEĞİŞTİRMEDEN, yalnızca telefonun
        // bağlantı sırasında PASİF olarak gönderdiği RECENT history sync
        // bildirimini işlemek için shouldSyncHistoryMessage kullanılır.
        // Bu, QR eşleşmesi sonrası sohbet listesinin boş kalmasını (Faz 4
        // hatası) çözer: 'messaging-history.set' olayı aşağıda dinlenir.
        // Ek sinir: gateway bellekte sohbet basina en yeni 500 mesaji tutar
        // (§1708), backend ise `_SYNC_PER_CHAT_LIMIT = 50` ile cekiyor.
        shouldSyncHistoryMessage: () => true,
        // Sorun (Render log: `failed to decrypt message | err=No session record`
        // ve `Bad MAC`): Baileys sifre cozumleme basarisiz oldugunda, mesajin
        // yeniden gonderilmesini isteyebilmek icin `getMessage`e ihtiyac duyar.
        // Verilmedigi surece yalnizca log yazip mesaji KAYBEDIYORDU. Ham proto
        // govdeler sinirli `rawMessagesByChat` depounda tutulur (yukarida).
        getMessage: async (key) => lookupRawMessage(store, key),
        msgRetryCounterCache: retryCounterCacheFor(id),
      });

      const replacedSocket = session.lifecycle.attach(generation, sock);
      if (replacedSocket) {
        diagnostic('socket_owner_replaced', {
          session_ref: sessionRef(id),
          generation,
          previous_generation: generation - 1,
        });
        try { replacedSocket.ev?.removeAllListeners(); } catch (err) { /* ignore */ }
        try { replacedSocket.end(undefined); } catch (err) { /* ignore */ }
      }
      session.sock = sock;
      if (leaseRepository) {
        const renewalMs = Math.max(10_000, Math.floor(leaseRepository.ttlSeconds * 1000 / 3));
        const loseLease = () => {
          if (!session.lifecycle.isCurrent(generation, sock)) return;
          session.lifecycle.invalidate();
          clearLeaseTimers(session);
          try { sock.ev?.removeAllListeners(); } catch (err) { /* ignore */ }
          try { sock.end(undefined); } catch (err) { /* ignore */ }
          session.sock = null;
          session.status = 'UNAVAILABLE';
          session.is_phone_online = false;
          session.error_message = 'WHATSAPP_SESSION_LEASE_LOST';
          diagnostic('socket_lease_lost', { session_ref: sessionRef(id), generation });
        };
        session._leaseRenewTimer = setInterval(async () => {
          if (session._leaseRenewing || !session.lifecycle.isCurrent(generation, sock)) return;
          session._leaseRenewing = true;
          try {
            const renewed = await leaseRepository.renew(id, instanceId, generation);
            if (renewed) session._leaseValidUntil = Date.now() + leaseRepository.ttlSeconds * 1000;
            else loseLease();
          } catch (error) {
            diagnostic('socket_lease_renew_failed', {
              session_ref: sessionRef(id), generation,
              error_name: error?.name || 'Error', error_code: error?.code || null,
            });
            if (Date.now() >= session._leaseValidUntil) loseLease();
          } finally {
            session._leaseRenewing = false;
          }
        }, renewalMs);
      }

      // Faz 13 (tenant izolasyonu): bu oturumun soketinden cikan TUM olaylar
      // `gateway_session_id` tasir. Backend, olayi hangi tenant'a yazacagini
      // TAHMIN ETMEK yerine bu kimlikten birebir cozer (whatsapp_sessions.
      // gateway_id). Bu yerel tanim, asagidaki tum `sock.ev.on(...)`
      // isleyicilerinde dis kapsamdaki `emitEvent`i GOLGELER; boylece 20+
      // cagri yerini tek tek degistirmeye gerek kalmaz.
      const emitEvent = (event) => sessionManager._emit({ gateway_session_id: id, ...event });
      // Sorun (prod: "senkron asla tamamlanmıyor"): RECENT sync'te WhatsApp
      // `isLatest` GONDERMEYEBILIR ve `progress` 100'e hic ulasmayabilir —
      // yalnizca bu iki sinyale bagli tamamlanma mantigi sonsuza dek
      // 'syncing' durumunda kalirdi ve `session_sync_completed` hic
      // yayinlanmazdi (boylece backend initial-sync'i de HIC tetiklenmezdi).
      //
      // Cozum (veri-gudumlu, sahte ilerleme YOK): history chunk'lari burst
      // halinde gelir. Son chunk'tan sonra HISTORY_QUIET_PERIOD_MS boyunca
      // yeni chunk gelmemesi, senkronun GERCEKTEN bittiginin sinyalidir.
      // Ilerleme degeri her zaman WhatsApp'in gercek yuzdesidir; bu
      // zamanlayicilar yalnizca "veri akisi durdu" kararini verir.
      const HISTORY_QUIET_PERIOD_MS = 12000;
      // Bos/yeni hesap: hic chunk gelmezse de takili kalmamali.
      const HISTORY_NO_CHUNK_FALLBACK_MS = 45000;

      const finalizeHistorySync = (reason) => {
        // Oturum silindiyse (delete/logout sonrasi ateslenen bayat timer)
        // hayalet `session_sync_completed` yayinlanmaz — backend'de sahipsiz
        // olay seli ve takili senkron banner'i uretiyordu.
        if (!sessions.get(id)) return;
        if (!session.sync || session.sync.phase !== 'syncing') return;
        if (session._historyQuietTimer) {
          clearTimeout(session._historyQuietTimer);
          session._historyQuietTimer = null;
        }
        session.sync = {
          ...session.sync,
          phase: 'ready',
          progress: 100,
          completed_at: session.sync.completed_at || new Date().toISOString(),
        };
        logger.info({ id, reason, chats: session.sync.chats_synced, msgs: session.sync.messages_synced }, 'History sync finalized');
        emitEvent({ event: 'session_sync_completed', session_id: id, session_name: session.session_name, sync: session.sync });
        void ensureGroupSubjects({ force: true });
      };

      // --- QR event ---
      sock.ev.on('creds.update', async () => {
        if (!session.lifecycle.isCurrent(generation, sock)) return;
        session._diagnosticAuthUpdates = (session._diagnosticAuthUpdates || 0) + 1;
        try {
          await saveCreds();
        } catch (err) {
          diagnostic('auth_state_write_failed', {
            session_ref: sessionRef(id),
            generation,
            error_name: err?.name || 'Error',
            error_code: err?.code || null,
          });
          logger.error({ err, session_ref: sessionRef(id), generation }, 'Baileys auth state write failed');
        }
      });

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (!session.lifecycle.isCurrent(generation, sock)) {
          if (connection) {
            diagnostic('stale_socket_transition_ignored', {
              session_ref: sessionRef(id),
              generation,
              current_generation: session.lifecycle.generation,
              connection,
              status_code: statusCode ?? null,
            });
          }
          return;
        }
        if (connection) {
          diagnostic('socket_connection_transition', {
            session_ref: sessionRef(id),
            generation,
            connection,
            status_code: statusCode ?? null,
            is_current_socket: session.sock === sock,
            auth_updates: session._diagnosticAuthUpdates || 0,
          });
        }
        if (qr) {
          session.status = 'SCAN_QR';
          session.error_message = null;
          session.error_reason = null;
          session._connFailures = 0;
          session._qrSeenForAttempt = true;
          session.qr_code = await QRCode.toDataURL(qr);
          session.updated_at = new Date().toISOString();
          emitEvent({ event: 'session_qr_updated', session_id: id, qr_code: session.qr_code });
          // --- Faz 6b fix: pairing kodu sokete bağlıdır ve QR ile birlikte
          // (~60 sn) geçerliliğini yitirir. Soket yeniden başlayıp yeni QR
          // üretildiğinde, ekrandaki eski kod WhatsApp'ta "Cihaza
          // bağlanamadı / kodu tekrar girin" hatası verir. Bekleyen bir
          // pairing isteği varsa taze kodu otomatik üretip UI'a it.
          if (session._pairingPhone) {
            const PAIRING_TTL_MS = 10 * 60 * 1000;
            if (Date.now() - (session._pairingRequestedAt || 0) > PAIRING_TTL_MS) {
              session._pairingPhone = null;
            } else {
              try {
                const freshCode = await sock.requestPairingCode(session._pairingPhone);
                session.updated_at = new Date().toISOString();
                logger.warn({ session_ref: sessionRef(id) }, 'Pairing code re-issued after socket restart');
                emitEvent({
                  event: 'session_pairing_code_updated',
                  session_id: id,
                  pairing_code: freshCode,
                  phone: session.phone_number || null,
                });
              } catch (err) {
                logger.warn({ err, id }, 'Pairing code re-issue failed');
                emitEvent({
                  event: 'session_pairing_code_updated',
                  session_id: id,
                  error: String(err?.message || err),
                });
              }
            }
          }
        }
        if (connection === 'open') {
          session.status = 'CONNECTED';
          session.qr_code = null;
          session.error_message = null;
          session.error_reason = null;
          session._connFailures = 0;
          session._pairingPhone = null;
          session._pairingRequestedAt = 0;
          session.is_phone_online = true;
          session.updated_at = new Date().toISOString();
          // Persist encrypted auth state
          if (!authRepository) {
            safeWriteEncrypted(path.join(sessionDir, 'auth.json'), { creds: state.creds, keys: state.keys }, aesKey);
            diagnostic('legacy_auth_snapshot_written', {
              session_ref: sessionRef(id),
              generation,
              auth_updates: session._diagnosticAuthUpdates || 0,
              keys_value_type: typeof state.keys,
            });
          }
          emitEvent({ event: 'session_connected', session_id: id, session_name: session.session_name, phone: session.phone_number || null });
          // Faz 7: WhatsApp Web paritesi — bağlantı kuruldu, INITIAL SYNC
          // başlıyor. Frontend bu event'le "Sohbetleriniz yükleniyor…"
          // ekranına geçer; progress yalnızca gerçek messaging-history.set
          // yüzdesidir (sahte progress üretilmez).
          // Faz 9 (§19, RC-3): Bu cihazda daha önce TAMAMLANMIŞ bir senkron
          // varsa (Baileys creds.accountSyncCounter > 0 — WhatsApp sunucusu
          // reconnect'te history yeniden göndermez), banner 0%'da takılmasın:
          // senkron zaten 'ready' kabul edilir. Bu da gerçek veri sinyalidir,
          // timer/tahmin değil.
          const priorSyncs = Number(state?.creds?.accountSyncCounter || 0);
          session.sync = priorSyncs > 0
            ? { phase: 'ready', progress: 100, chats_synced: 0, contacts_synced: 0, messages_synced: 0, started_at: new Date().toISOString(), completed_at: new Date().toISOString() }
            : { phase: 'syncing', progress: 0, chats_synced: 0, contacts_synced: 0, messages_synced: 0, started_at: new Date().toISOString(), completed_at: null };
          if (priorSyncs > 0) {
            emitEvent({ event: 'session_sync_completed', session_id: id, session_name: session.session_name, sync: session.sync });
            void ensureGroupSubjects();
          } else {
            emitEvent({ event: 'session_sync_started', session_id: id, session_name: session.session_name, sync: session.sync });
            // Sorun (prod): bos/yeni hesapta HIC history chunk'i gelmeyebilir;
            // bu durumda quiet-period zamanlayicisi hic kurulamaz ve senkron
            // sonsuza dek 'syncing' kalirdi. Guvenlik agi: hic chunk
            // gelmezse de makul bir sure sonra senkron tamamlanmis sayilir
            // (ilerleme yine gercek chunk'lardan beslenir; bu yalnizca
            // "veri gelmeyecek" kararidir).
            if (session._historyQuietTimer) clearTimeout(session._historyQuietTimer);
            session._historyQuietTimer = setTimeout(() => {
              finalizeHistorySync('no_history_chunks_received');
            }, HISTORY_NO_CHUNK_FALLBACK_MS);
          }
        }
        if (connection === 'close') {
          // Faz 7: bağlantı koptu — sync lifecycle sıfırlanır (yeniden
          // bağlanınca tekrar 'syncing' olur), UI 'ready' sanmaya devam etmesin.
          if (session._historyQuietTimer) {
            clearTimeout(session._historyQuietTimer);
            session._historyQuietTimer = null;
          }
          if (session.sync && session.sync.phase !== 'ready') {
            session.sync = { phase: 'idle' };
          }
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;
          const isBanned = statusCode === DisconnectReason.badSession;
          // Sorun (Render log: `stream errored out | tag=stream:error code=515`):
          // 515 = `restartRequired`. Bu bir HATA DEGIL, eslesme sonrasi
          // WhatsApp'in beklenen "soketi yeniden kur" sinyalidir. Eskiden
          // asagidaki gecici-kopma dalina dusuyor, `_connFailures` sayacini
          // artiriyor ve 3 denemede `WA_CONNECTION_TERMINATED` sahte hatasi
          // uretebiliyordu. Artik sayilmaz, gecikmesiz yeniden baglanilir.
          if (statusCode === DisconnectReason.restartRequired) {
            session.status = 'CONNECTING';
            session.is_phone_online = false;
            session.updated_at = new Date().toISOString();
            logger.info({ id }, 'Baileys restartRequired (515) — soket hemen yeniden kuruluyor');
            const scheduled = session.lifecycle.scheduleReconnect(
              generation, sock, 500, () => this._startSocket(id),
            );
            if (scheduled) diagnostic('socket_reconnect_scheduled', {
              session_ref: sessionRef(id), generation,
              reason: 'restart_required', delay_ms: 500,
            });
            return;
          }
          if (isLoggedOut || isBanned) {
            session.status = isBanned ? 'BANNED' : 'DISCONNECTED';
            session.is_active = false;
            session.is_phone_online = false;
            session.error_message = isBanned
              ? 'WhatsApp bu oturumu engelledi (badSession). Oturumu silip yeniden QR ile bağlanın.'
              : null;
            session.error_reason = isBanned ? 'BANNED' : 'LOGGED_OUT';
            session.updated_at = new Date().toISOString();
            await releaseLease(session);
            await deactivatePersistentSession(id);
            session.store = createSessionStore();
            clearSessionMedia(id);
            resetRetryCounterCache(id);
            emitEvent({ event: 'session_disconnected', session_id: id, session_name: session.session_name, reason: isBanned ? 'BANNED' : 'LOGGED_OUT' });
          } else {
            // Transient disconnect — retry with a bounded number of attempts.
            // If WhatsApp keeps terminating the socket BEFORE ever sending a
            // QR (typical when the host IP is blocked by WhatsApp), fail
            // loudly instead of retrying forever (AGENTS.md truthfulness).
            session._connFailures = (session._connFailures || 0) + 1;
            const sawQrThisAttempt = session._qrSeenForAttempt;
            session._qrSeenForAttempt = false;
            const maxAttempts = 3;
            if (!sawQrThisAttempt && session._connFailures >= maxAttempts) {
              session.status = 'DISCONNECTED';
              session.is_active = false;
              session.is_phone_online = false;
              session.qr_code = null;
              session.error_reason = 'WA_CONNECTION_TERMINATED';
              session.error_message =
                `WhatsApp sunucusu QR kodu oluşturulmadan bağlantıyı kapattı ` +
                `(statusCode=${statusCode ?? 'bilinmiyor'}, ${session._connFailures} deneme). ` +
                `Bu geçici bir WhatsApp reddi olabilir; birkaç dakika sonra ` +
                `"QR'ı Yenile" ile tekrar deneyin.`;
              session.updated_at = new Date().toISOString();
              logger.error({ statusCode, failures: session._connFailures }, 'Baileys kept being terminated before QR — surfacing error');
              emitEvent({
                event: 'connection_error',
                session_id: id,
                session_name: session.session_name,
                error: session.error_message,
                error_message: session.error_message,
              });
              return;
            }
            session.status = 'CONNECTING';
            session.is_phone_online = false;
            session.updated_at = new Date().toISOString();
            const delayMs = Math.min(30_000, 1_000 * (2 ** Math.min(session._connFailures - 1, 5)));
            const jitterMs = Math.floor(Math.random() * Math.max(1, Math.floor(delayMs * 0.2)));
            const scheduled = session.lifecycle.scheduleReconnect(
              generation, sock, delayMs + jitterMs, () => this._startSocket(id),
            );
            if (scheduled) diagnostic('socket_reconnect_scheduled', {
              session_ref: sessionRef(id), generation,
              reason: 'transient_disconnect', delay_ms: delayMs + jitterMs,
              status_code: statusCode ?? null, failure_count: session._connFailures,
            });
          }
        }
      });

      // --- Messages (inbound + phone-sent outbound) ---
      sock.ev.on('messages.upsert', async ({ messages: newMessages, type }) => {
        for (const msg of newMessages) {
          await this._ingestUpsertMessage(msg, sock, id);
        }
      });

      // --- Contacts sync ---
      // contacts.update: Baileys bunu msg.pushName ile yayar (kişinin KENDI
      // profil adi) — rehber adini asla ezmemeli; mergeContactName onceligi korur.
      sock.ev.on('contacts.update', (updates) => {
        for (const update of updates) {
          // Sorun (prod): Durum (`status@broadcast`) / kanal (`@newsletter`)
          // kisileri rehbere/sohbet listesine karismaz.
          if (update.id && isBroadcastOnlyJid(update.id)) continue;
          // LID döneminde remoteJid/participant @lid olabilir — eşleşme
          // biliniyorsa telefona çöz, değilse lid anahtarında beklet
          // (_applyLidMapping öğrendiğinde telefona taşır).
          const jid = normalizeJid(update.id);
          if (!jid) continue;
          if (isBroadcastOnlyJid(jid)) continue;
          // Eşleşmesi henüz bilinmeyen LID anahtarını backend'e yayma —
          // kayıt LID altında bekler, _applyLidMapping öğrendiğinde telefona
          // taşır (backend'de jid:@lid hayalet satır oluşmaz).
          const lidHold = isLidJid(jid);
          let merged = contacts.get(jid) || {};
          if (update.name) merged = mergeContactName(merged, update.name, 'addressbook');
          if (update.verifiedName) merged = mergeContactName(merged, update.verifiedName, 'verified');
          if (update.notify) merged = mergeContactName(merged, update.notify, 'push');
          contacts.set(jid, {
            ...merged,
            id: jid,
            jid,
            name: merged.name || jidToPhone(jid) || jid,
            phone: jidToPhone(jid) || merged.phone || '',
            avatar_url: update.imgUrl || merged.avatar_url || null,
            updated_at: new Date().toISOString(),
          });
          if (!lidHold) emitEvent({ event: 'contact_synced', contact: contacts.get(jid) });
        }
      });

      // --- Address book (W:Contact app-state) — WhatsApp Web paritesinin asıl
      // kaynağı: kullanıcının telefonunda rehberde kayıtlı adlar. Baileys,
      // app-state senkronundaki contactAction mutasyonlarını bu olayla yayar.
      // Faz 6e: WhatsApp artık bu yamaları `xxx@lid` kimliğiyle anahtarlıyor;
      // payload {id, name, lid, jid} şeklindedir (jid yalnızca id telefon
      // JID'iyse dolar). LID anahtarlı kayıtlar eşleşme öğrenilinceye kadar
      // bekletilir, öğrenilince _applyLidMapping telefona taşır.
      sock.ev.on('contacts.upsert', (list) => {
        for (const c of list || []) {
          const rawId = c?.id;
          if (!rawId || !c.name) continue;
          // Sorun (prod): Durum (`status@broadcast`) / kanal (`@newsletter`)
          // kisileri rehbere/sohbet listesine karismaz.
          if (isBroadcastOnlyJid(rawId)) continue;
          // Faz 9 (§5, RC-2): dejenere JID'lerden (`0@s.whatsapp.net`)
          // contact ÜRETİLMEZ — '+0' contact'in kaynağı burasıydı.
          if (isDegenerateJid(rawId)) continue;
          // Çift bilgisi varsa eşlemeyi öğren (id telefon + lid alanı dolu).
          if (c.lid && !isLidJid(rawId)) applyLidMapping(c.lid, rawId);
          // Faz 8 (patch): LID-anahtarli rehber yamalari telefonu `pnJid`'de
          // tasir; Baileys bunu dusuruyordu — patch ile artik `c.pn`.
          // Eşleşme burada öğrenilir: bekleyen LID kaydı telefona taşınır ve
          // ad, telefon-anahtarlı kişiye addressbook rütbesiyle yazılır.
          if (c.pn && isLidJid(rawId)) applyLidMapping(rawId, c.pn);
          const jid = normalizeJid(rawId); // lid ise ve eşleşme biliniyorsa telefona çözülür
          if (isBroadcastOnlyJid(jid)) continue;
          const now = new Date().toISOString();
          if (isLidJid(jid)) {
            // Eşleşme henüz bilinmiyor: adres defteri adını LID anahtarında
            // beklet — mesaj/geçmiş/phone-share eşleşmeyi getirince taşınır.
            const merged = mergeContactName(contacts.get(jid) || {}, c.name, 'addressbook');
            contacts.set(jid, {
              ...merged,
              id: jid,
              jid,
              name: merged.name,
              phone: '',
              lid_pending: true,
              updated_at: now,
            });
            continue;
          }
          const merged = mergeContactName(contacts.get(jid) || {}, c.name, 'addressbook');
          contacts.set(jid, {
            ...merged,
            id: jid,
            jid,
            name: merged.name,
            phone: jidToPhone(jid) || merged.phone || '',
            avatar_url: merged.avatar_url || null,
            updated_at: now,
          });
          emitEvent({ event: 'contact_synced', contact: contacts.get(jid) });
          // Rehber adı bilinen sohbetin başlığını da tazele (sidebar parity).
          const chatKey = normalizeJid(jid);
          const chat = chats.get(chatKey);
          if (chat && chat.name !== merged.name && merged.name_source === 'addressbook') {
            chat.name = merged.name;
            chat.name_source = 'addressbook';
            chat.updated_at = now;
            emitEvent({ event: 'conversation_updated', conversation: { ...chat } });
          }
        }
      });

      // --- Faz 6e: LID → telefon eşleşmesi — kişi telefon numarasını
      // paylaştığında WhatsApp bunu lid ile birlikte bildirir; kalıcı eşleme.
      sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
        if (lid && jid) applyLidMapping(lid, jid);
      });

      // --- Chats sync ---
      sock.ev.on('chats.update', (updates) => {
        for (const update of updates) {
          const jid = update.id;
          if (!jid) continue;
          // Sorun (prod): Durum/Hikaye (`status@broadcast`) ve kanal
          // (`@newsletter`) sohbet listesine karisiyordu.
          if (isBroadcastOnlyJid(jid)) continue;
          // Faz 9 (§5, RC-2): dejenere JID'lerden (`0@s.whatsapp.net`)
          // sohbet/contact ÜRETİLMEZ — '+0' chat'in kaynağı burasıydı.
          if (isDegenerateJid(jid)) continue;
          const key = normalizeJid(jid);
          if (isBroadcastOnlyJid(key)) continue;
          // Çözülmemiş LID anahtarı: sohbet LID altında bekler, eşleşme
          // öğrenilince _applyLidMapping telefona taşır — backend'e yaymaz.
          const lidHold = isLidJid(key);
          const existing = chats.get(key) || {};
          const contact = contacts.get(key);
          // Faz 10 (P2): chats.update.lastMessage da paylasilan kuraldan gecer
          // (medyada govde bos → tip etiketi). Zaman damgasi daha yeni ise
          // yazilir; eskisi mevcut ozeti ezmez.
          const updTs = update.lastMessage?.messageTimestamp
            ? new Date(update.lastMessage.messageTimestamp * 1000).toISOString()
            : null;
          const updPreview = update.lastMessage
            ? (() => {
                const s = summarizeWaMessage(update.lastMessage);
                const base = normalizePreviewText(s.message_type, s.body);
                if (!base) return null;
                if (key.includes('@g.us') && !update.lastMessage.key?.fromMe) {
                  const pname = resolveDisplayName(update.lastMessage.key?.participant, update.lastMessage.pushName);
                  if (pname && !isRawIdentityName(pname) && !isPhoneLikeName(pname) && pname.toUpperCase() !== 'ME') {
                    return `${pname}: ${base}`;
                  }
                }
                return base;
              })()
            : null;
          const tsOlder = updTs && existing.last_message_at && String(updTs) < String(existing.last_message_at);
          // Faz 10 (P3): chats.update.lastMessage tam bir WAMessage tasir.
          // Telefondan gonderilen mesajlar messages.upsert ile HIC gelmezse
          // (yaris/cihaz dongusu) sohbet gecmisi eksik kalir — son mesaji
          // buradan sentezleyip messagesByChat'e ekleriz (wa_message_id ile
          // dedup; backend de kendi tarafinda dedup eder).
          if (update.lastMessage?.key?.id && !lidHold) {
            try {
              const list = messagesByChat.get(key) || [];
              const known = list.some((m) => m.wa_message_id && m.wa_message_id === update.lastMessage.key.id);
              if (!known) {
                const synth = historyMessageToRecord(update.lastMessage, key);
                if (synth) {
                  const next = [...list, synth];
                  if (next.length > 500) next.splice(0, next.length - 500);
                  messagesByChat.set(key, next);
                  emitEvent({ event: 'message_new', conversation_id: key, message: synth });
                }
              }
            } catch (err) {
              logger.warn({ err }, 'chats.update lastMessage sentezlenemedi');
            }
          }
          chats.set(key, {
            ...existing,
            id: key,
            jid: key,
            name: contact?.name || existing.name || (lidHold ? '' : jidToPhone(key) || key),
            name_source: contact?.name_source || existing.name_source || null,
            phone: jidToPhone(key) || existing.phone || '',
            is_group: key.includes('@g.us'),
            // Sorun 4: Baileys `chats.update.archived` (WhatsApp'ta
            // sohbetin arsivlenmesi/arsivden cikarilmasi) sohbet kaydina
            // islenir; yoksa mevcut deger korunur.
            archived: update.archived ?? existing.archived ?? false,
            last_message_at: updTs && !tsOlder ? updTs : existing.last_message_at,
            last_message_preview: updPreview && !tsOlder ? updPreview : existing.last_message_preview || '',
            unread_count: update.unreadCount ?? existing.unread_count ?? 0,
            created_at: existing.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          if (!chats.get(key)?.avatar_url) void ensureChatAvatar(key);
          if (!lidHold) emitEvent({ event: 'conversation_updated', conversation: chats.get(key) });
        }
      });

      // --- History sync (Faz 4): telefonun baglantı sirasinda pasif olarak
      // gonderdigi RECENT gecmisi isler. syncFullHistory (428 riski) KULLANILMAZ;
      // yalnizca shouldSyncHistoryMessage ile bildirim kabul edilir.
      // Tamamlanma garantisi (quiet-period + fallback) yukarida tanimli. ---
      sock.ev.on('messaging-history.set', async ({ chats: historyChats, contacts: historyContacts, messages: historyMessages, progress, isLatest, phoneNumberToLidMappings }) => {
        try {
          // Faz 8 (patch): HistorySync.phoneNumberToLidMappings — telefon<->LID
          // ciftleri Baileys tarafindan dusuruluyordu; patch ile gelir.
          // Bunlari IŞLEMEYE BAŞLAMADAN önce uygula ki aynı chunk'taki
          // LID-anahtarlı rehber adları/sohbetleri telefon kimligine çözülerek
          // yazilsin (yoksa kalici olarak lid_pending'de beklerlerdi).
          for (const m of phoneNumberToLidMappings || []) {
            if (m?.pnJid && m?.lidJid) applyLidMapping(m.lidJid, m.pnJid);
          }
          // 1. Kisiler
          for (const c of historyContacts || []) {
            if (!c?.id) continue;
            // Sorun (prod): Durum (`status@broadcast`) / kanal (`@newsletter`)
            // kisileri rehbere/sohbet listesine karismaz.
            if (isBroadcastOnlyJid(c.id)) continue;
            // Faz 9 (§5, RC-2): dejenere JID'lerden (`0@s.whatsapp.net`)
            // contact üretilmez — '+0' kaynağı.
            if (isDegenerateJid(c.id)) continue;
            // Faz 6e: gecmis kisi kaydi {id: telefon, lid} tasir — eşleşmeyi
            // öğren (LID anahtarlı bekleyen rehber adları varsa telefona taşınır).
            if (c.lid && !isLidJid(c.id)) applyLidMapping(c.lid, c.id);
            if (isLidJid(c.id)) continue; // salt-LID kaydı: yalnızca eşleme kaynağı
            let merged = contacts.get(c.id) || {};
            // Conversation.name (senkron anındaki rehber adı) pushName'den önce gelir.
            if (c.name) merged = mergeContactName(merged, c.name, 'history');
            if (c.notify) merged = mergeContactName(merged, c.notify, 'push');
            if (c.verifiedName) merged = mergeContactName(merged, c.verifiedName, 'verified');
            contacts.set(c.id, {
              ...merged,
              id: c.id,
              jid: c.id,
              name: merged.name || jidToPhone(c.id) || c.id,
              phone: jidToPhone(c.id) || merged.phone || '',
              avatar_url: c.imgUrl || merged.avatar_url || null,
              updated_at: new Date().toISOString(),
            });
          }
          // 2. Mesajlar (chat bazinda, wa_message_id ile dedup)
          let storedMessages = 0;
          for (const msg of historyMessages || []) {
            const jid = msg.key?.remoteJid;
            if (!jid || msg.key?.id === '__history__') continue;
            // Sorun (prod): Durum/Hikaye (`status@broadcast`) ve kanal
            // (`@newsletter`) mesajlari sohbet listesini kirletiyordu.
            if (isBroadcastOnlyJid(jid)) continue;
            // Faz 6e: gecmis mesaj anahtarlari da LID↔telefon çifti tasir.
            if (msg.key?.senderLid && msg.key?.senderPn) applyLidMapping(msg.key.senderLid, msg.key.senderPn);
            if (msg.message?.protocolMessage) continue; // revoke/ephemeral vb. — atla
            const key = normalizeJid(jid);
            if (isBroadcastOnlyJid(key)) continue;
            // Ham govdeyi de sakla — karsi taraf retry istediginde `getMessage`
            // buradan beslenir (bkz. rawMessagesByChat).
            if (msg.key.id && msg.message) rememberRaw(key, msg.key.id, msg.message);
            const list = messagesByChat.get(key) || [];
            if (msg.key.id && list.some((m) => m.wa_message_id === msg.key.id)) continue;
            const record = historyMessageToRecord(msg, key);
            if (!record) continue;
            list.push(record);
            // Bellek koruması: sohbet başına en yeni 500 mesaj
            if (list.length > 500) list.splice(0, list.length - 500);
            messagesByChat.set(key, list);
            storedMessages += 1;
          }
          // 3. Sohbetler
          let storedChats = 0;
          for (const chat of historyChats || []) {
            const jid = chat.id || chat.jid;
            if (!jid) continue;
            // Sorun (prod): Durum/Hikaye (`status@broadcast`) ve kanal
            // (`@newsletter`) sohbetleri WhatsApp Web'de sohbet listesinde
            // YER ALMAZ — sohbet olarak uretilmez.
            if (isBroadcastOnlyJid(jid)) continue;
            // Faz 9 (§5, RC-2): dejenere JID'lerden sohbet/contact üretilmez.
            if (isDegenerateJid(jid)) continue;
            // Faz 6e: Conversation.lidJid — sohbet telefon anahtarlıysa eşlemeyi öğren;
            // Conversation.pnJid — sohbet LID anahtarlıysa telefonu buradan çöz.
            if (chat.lidJid && !isLidJid(jid)) applyLidMapping(chat.lidJid, jid);
            if (isLidJid(jid) && chat.pnJid) applyLidMapping(jid, chat.pnJid);
            const key = normalizeJid(jid);
            if (isBroadcastOnlyJid(key)) continue;
            const contact = contacts.get(key);
            const list = messagesByChat.get(key) || [];
            // Faz 10 (P2): en yeni mesaj EKLEME SIRASINA degil ZAMAN DAMGASINA
            // gore secilir (history chunk'lari karisik sirali gelebilir).
            const newest = list.reduce(
              (acc, m) => (acc && Number(acc.id) >= Number(m.id) ? acc : m),
              null,
            );
            const ts = chat.lastMessageRecvTimestamp || newest?.timestamp_s;
            const existing = chats.get(key) || {};
            const merged = {
              ...existing,
              id: key,
              jid: key,
              // contact Map öncelik-çözümlemeli adı taşır (rehber > push); chat.name
              // (Conversation.name) yalnızca yedek olarak kullanılır.
              name: contact?.name || chat.name || existing.name || jidToPhone(key) || key,
              name_source: contact?.name_source || existing.name_source || null,
              phone: jidToPhone(key) || existing.phone || '',
              is_group: key.includes('@g.us'),
              // Sorun 4: HistorySync.Chat.archived — ilk gecmis senkronunda
              // arsivli sohbetler buradan gelir.
              archived: chat.archived ?? existing.archived ?? false,
              avatar_url: chat.avatar_url || contact?.avatar_url || existing.avatar_url || null,
              last_message_at: ts ? new Date(Number(ts) * 1000).toISOString() : (newest?.created_at || existing.last_message_at),
              // Faz 10 (P2): paylasilan kural — tip etiketi + grup gonderen on eki.
              last_message_preview:
                (newest ? buildChatPreview(newest, key.includes('@g.us')) : '') ||
                existing.last_message_preview ||
                '',
              unread_count: chat.unreadCount ?? existing.unread_count ?? 0,
              created_at: existing.created_at || new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            chats.set(key, merged);
            storedChats += 1;
            if (!merged.avatar_url) void ensureChatAvatar(key);
            emitEvent({ event: 'conversation_updated', conversation: merged });
          }
          emitEvent({
            event: 'history_sync_completed',
            progress: progress ?? null,
            is_latest: !!isLatest,
            chats_synced: storedChats,
            messages_synced: storedMessages,
          });
          // Faz 7: gerçek initial-sync ilerlemesi — messaging-history.set
          // yüzdesi + toplanan sayaçlar. Faz 9 (RC-3): tamamlanma artık
          // WhatsApp'ın GERÇEK sinyallerinden çözülür (isLatest VEYA
          // progress=100) — prod'da isLatest hiç gelmediği için banner
          // %100'de takılı kalıyordu. Sahte timer yok; tamamlanma emit'i
          // yalnızca veri sinyaline bağlı.
          if (session.sync) {
            const { next, justCompleted } = resolveSyncState(session.sync, { progress, isLatest });
            next.chats_synced = (session.sync.chats_synced || 0) + storedChats;
            next.messages_synced = (session.sync.messages_synced || 0) + storedMessages;
            next.contacts_synced = contacts.size;
            session.sync = next;
            emitEvent({ event: 'session_sync_progress', session_id: id, session_name: session.session_name, sync: session.sync });
            if (justCompleted) {
              if (session._historyQuietTimer) {
                clearTimeout(session._historyQuietTimer);
                session._historyQuietTimer = null;
              }
              emitEvent({ event: 'session_sync_completed', session_id: id, session_name: session.session_name, sync: session.sync });
              // Faz 8: initial sync tamamlanınca grup başlıklarını çöz (tek
              // toplu groupFetchAllParticipating + hedefli groupMetadata
              // fallback — N+1 request storm yok, §20).
              void ensureGroupSubjects({ force: true });
            } else if (session.sync.phase === 'syncing') {
              // Sorun (prod: "senkron asla tamamlanmıyor"): RECENT sync'te
              // WhatsApp `isLatest` GONDERMEYEBILIR ve `progress` hiç
              // 100'e ulasmayabilir — bu durumda yukaridaki sinyaller
              // sonsuza dek gelmez ve banner takili kalirdi. Chunk'lar
              // burst halinde gelir; son chunk'tan sonra N saniyelik
              // SESSIZLIK = senkronun GERCEKTEN bittigi anlamina gelir.
              // Bu sahte ilerleme DEGILDIR — ilerleme degeri her zaman
              // WhatsApp'in gonderdigi gercek yuzdedir; zamanlayici yalnizca
              // "artik yeni veri gelmiyor" kararini verir.
              if (session._historyQuietTimer) clearTimeout(session._historyQuietTimer);
              session._historyQuietTimer = setTimeout(() => {
                if (session.sync && session.sync.phase === 'syncing') {
                  finalizeHistorySync('quiet_period_after_last_chunk');
                }
              }, HISTORY_QUIET_PERIOD_MS);
            }
          }
          logger.info({ storedChats, storedMessages, progress, isLatest }, 'History sync ingested');
        } catch (err) {
          logger.warn({ err }, 'History sync ingestion failed');
        }
      });

      // --- Groups (Faz 8, §17): gerçek zamanlı grup yeniden adlandırma ---
      // Baileys `groups.update` grup metadata değişince gelir (subject dahil).
      // groups.js self-emit eder; burada chats/contacts Map'lerini group_subject
      // rütbesiyle güncelleyip conversation_updated yayınlarız.
      sock.ev.on('groups.update', (updates) => {
        for (const update of updates || []) {
          const jid = update?.id;
          const subject = typeof update?.subject === 'string' ? update.subject.trim() : '';
          if (!jid || !jid.includes('@g.us') || !subject) continue;
          const key = normalizeJid(jid);
          const chat = chats.get(key);
          if (chat) {
            const merged = mergeContactName({ name: chat.name, name_source: chat.name_source }, subject, 'group_subject');
            if (merged.name && merged.name !== chat.name) {
              chat.name = merged.name;
              chat.name_source = merged.name_source;
              chat.updated_at = new Date().toISOString();
              emitEvent({ event: 'conversation_updated', conversation: { ...chat } });
            }
          }
          const contact = contacts.get(key);
          if (contact) {
            const mergedC = mergeContactName({ name: contact.name, name_source: contact.name_source }, subject, 'group_subject');
            if (mergedC.name && mergedC.name !== contact.name) {
              contact.name = mergedC.name;
              contact.name_source = mergedC.name_source;
              contact.updated_at = new Date().toISOString();
              emitEvent({ event: 'contact_synced', contact: { ...contact } });
            }
          }
        }
      });

      // --- Presence ---
      sock.ev.on('presence.update', ({ id, presences }) => {
        const key = normalizeJid(id);
        const chat = chats.get(key);
        if (chat) {
          chat.presence = presences?.[0]?.presence || null;
          emitEvent({ event: 'presence_updated', conversation_id: key, presence: chat.presence });
        }
      });

      // --- Message acks (✓ / ✓✓ / mavi ✓✓) — WhatsApp Web parity ---
      // Baileys emits messages.update with key.status transitions for our own
      // (fromMe) messages: SERVER_ACK → DELIVERY_ACK → READ. We translate these
      // into message_status_updated events so the backend can persist them.
      sock.ev.on('messages.update', (updates) => {
        for (const { key, update } of updates || []) {
          if (!key?.fromMe || !key?.id) continue;
          const statusNum = update?.status;
          const newStatus = ACK_RANK[statusNum];
          if (!newStatus) continue;
          const remoteJid = key.remoteJid;
          if (!remoteJid) continue;
          const k = normalizeJid(remoteJid);
          const list = messagesByChat.get(k) || [];
          const msg = list.find((m) => m.wa_message_id === key.id);
          if (!msg) continue;
          const currentRank = ACK_ORDER[msg.status] ?? 0;
          const nextRank = ACK_ORDER[newStatus] ?? 0;
          // Acks only move forward; never downgrade READ → DELIVERED.
          if (nextRank <= currentRank) continue;
          msg.status = newStatus;
          emitEvent({
            event: 'message_status_updated',
            conversation_id: k,
            wa_message_id: key.id,
            status: newStatus,
            timestamp: new Date().toISOString(),
          });
        }
      });
    },
  };

  // Helper used throughout the manager to broadcast events to listeners
  // (event bridge -> backend) without leaking the listener set.
  const emitEvent = (event) => sessionManager._emit(event);

  return sessionManager;
}
